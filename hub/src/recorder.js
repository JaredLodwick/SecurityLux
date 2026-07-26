"use strict";

/**
 * Per-event video recorder.
 *
 * Spawns an ffmpeg child process and pipes the camera's JPEG frames into its
 * stdin as a Motion-JPEG stream.
 *
 * ============================================================================
 *  Pre-roll and post-roll
 * ============================================================================
 *
 * The clip does not start when detection fires. On `start()` we first flush the
 * camera's FrameBuffer — the last few seconds the hub already had in memory —
 * into ffmpeg, and only then switch to live frames. That's what puts the walk-up
 * at the front of the clip instead of opening on someone already standing there.
 *
 * At the other end, `beginPostRoll()` is deliberately *not* `stop()`. The
 * session ends the moment the grace window expires so the event row finalizes
 * promptly, but the recorder keeps writing for `postRollSeconds` afterwards.
 * Separating "the event is over" from "stop writing video" is what lets the clip
 * show someone walking away.
 *
 * The mjpeg demuxer assigns timestamps from `-framerate`, not from arrival time,
 * so dumping 75 buffered frames at once and then feeding live frames at 15 fps
 * still produces a correctly-paced clip.
 *
 * ============================================================================
 *  Codec
 * ============================================================================
 *
 * Default is h264/mp4. MJPEG stream-copy is ~3.6 Mbps at 640x480/15fps — about
 * 27 MB per minute — which fills a 64 GB card alarmingly fast and produces files
 * many browsers refuse to play. libx264 `ultrafast` lands near 0.3 Mbps for the
 * same footage at roughly 10% of one Pi 4 core. `codec: "mkv"` keeps the old
 * zero-CPU stream-copy path for CPU-starved hubs.
 */

const { spawn } = require("node:child_process");
const { once } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");

const { expandHome } = require("./store");

const FRAME_POLL_MS = 50;
const STDIN_DRAIN_TIMEOUT_MS = 2000;
const STOP_GRACE_MS = 5000;
const THUMB_WIDTH = 400;

class Recorder {
    /**
     * @param {object} opts
     * @param {object} opts.cam             Cam record (we read lastJpeg/frameSeq).
     * @param {object} opts.recordingCfg    Resolved recording settings for this camera.
     * @param {string} opts.clipsRoot       Root dir for clip output (~ supported).
     * @param {object} [opts.frameBuffer]   FrameBuffer for pre-roll. Omit to disable.
     * @param {Date}   [opts.startedAt]     Defaults to now.
     * @param {string} [opts.eventType]     Used in the filename. Defaults "person".
     * @param {object} [opts.logger]
     */
    constructor({ cam, recordingCfg, clipsRoot, frameBuffer, startedAt, eventType, logger }) {
        if (!cam) throw new Error("Recorder: cam is required");
        if (!recordingCfg) throw new Error("Recorder: recordingCfg is required");
        if (!clipsRoot) throw new Error("Recorder: clipsRoot is required");

        this.cam = cam;
        this.cfg = recordingCfg;
        this.clipsRoot = expandHome(clipsRoot);
        this.frameBuffer = frameBuffer || null;
        this.startedAt = startedAt || new Date();
        this.eventType = eventType || "person";
        this.log = logger || console;

        this.proc = null;
        this.stopped = false;
        this.framesWritten = 0;
        this.preRollFrames = 0;
        this.lastSeq = -1;
        this._tickTimer = null;
        this._exitPromise = null;
        this._absPath = null;
        this._relPath = null;
        this._thumbAbsPath = null;
        this._thumbRelPath = null;
        this._postRollUntil = 0;
        this._stopPromise = null;
    }

    /** Absolute clip path (set after start()). */
    get absPath() { return this._absPath; }
    /** Path relative to clipsRoot — what we store in events.clip_path. */
    get relPath() { return this._relPath; }
    get thumbRelPath() { return this._thumbRelPath; }

    start() {
        if (this.proc) return;

        const codec = this.cfg.codec === "mkv" ? "mkv" : "h264";
        const fps = clampNumber(this.cfg.fps, 1, 60, 15);
        const crf = clampNumber(this.cfg.crf, 18, 40, 28);
        const { absPath, relPath } = this._buildPaths(codec);
        fs.mkdirSync(path.dirname(absPath), { recursive: true });
        this._absPath = absPath;
        this._relPath = relPath;

        const args = buildFfmpegArgs({ codec, fps, crf, outPath: absPath });
        this.log.info(`[hub] recording ${this.cam.id} -> ${relPath} (${codec})`);

        try {
            this.proc = spawn("ffmpeg", args, { stdio: ["pipe", "ignore", "pipe"] });
        } catch (err) {
            this.log.error(`[hub] failed to spawn ffmpeg: ${err.message}`);
            this.proc = null;
            return;
        }

        // A missing ffmpeg binary does NOT throw from spawn() — it emits an
        // asynchronous 'error' event, and an unhandled one takes the whole hub
        // down. Without this the promised behaviour ("no ffmpeg means the event
        // is still logged, only the clip is skipped") turns into a crash on the
        // first detection.
        this.proc.on("error", (err) => {
            if (err.code === "ENOENT") {
                this.log.error(
                    "[hub] ffmpeg is not installed, so no video will be recorded. " +
                    "Events are still detected and logged. Install it with: apt install ffmpeg"
                );
            } else {
                this.log.error(`[hub] ffmpeg failed to start: ${err.message}`);
            }
            this.stopped = true;
            this.proc = null;
            this._absPath = null;      // nothing was written; don't advertise a path
            this._relPath = null;
        });

        // ffmpeg is chatty on stderr; only surface lines that look like problems
        // so the journal stays readable.
        this.proc.stderr.setEncoding("utf8");
        this.proc.stderr.on("data", (chunk) => {
            for (const line of String(chunk).split(/\r?\n/)) {
                if (/error|invalid|failed|cannot|no such/i.test(line)) {
                    this.log.warn(`[hub] ffmpeg(${this.cam.id}): ${line.trim()}`);
                }
            }
        });

        this.proc.stdin.on("error", (err) => {
            // EPIPE means ffmpeg exited first — not catastrophic, just stop.
            if (err.code === "EPIPE") this.stopped = true;
            else this.log.warn(`[hub] ffmpeg stdin error: ${err.message}`);
        });

        this._exitPromise = new Promise((resolve) => {
            this.proc.once("exit", (code, signal) => {
                this.stopped = true;
                if (code !== 0 && signal !== "SIGINT") {
                    this.log.warn(`[hub] ffmpeg(${this.cam.id}) exited code=${code} signal=${signal}`);
                }
                resolve({ code, signal });
            });
        });

        this._flushPreRoll();
        this._scheduleTick(0);
    }

    /**
     * Write the buffered pre-roll frames, then hand off to the live tick loop.
     *
     * Synchronous writes are fine here: this is a couple of megabytes into a
     * pipe at session start, and doing it inline guarantees the pre-roll lands
     * ahead of any live frame. `lastSeq` is advanced past the buffered frames so
     * the tick loop doesn't duplicate the newest one.
     */
    _flushPreRoll() {
        const seconds = clampNumber(this.cfg.preRollSeconds, 0, 30, 5);
        if (!this.frameBuffer || seconds <= 0) return;

        const frames = this.frameBuffer.recent(seconds, this.startedAt.getTime());
        if (!frames.length) return;

        for (const frame of frames) {
            if (this.stopped || !this.proc || !this.proc.stdin.writable) break;
            try {
                this.proc.stdin.write(frame.jpeg);
                this.framesWritten += 1;
                this.preRollFrames += 1;
                if (typeof frame.seq === "number") this.lastSeq = frame.seq;
            } catch (err) {
                this.log.warn(`[hub] pre-roll write failed: ${err.message}`);
                break;
            }
        }
        this.log.info(
            `[hub] pre-roll ${this.cam.id}: ${this.preRollFrames} frames (${seconds}s)`
        );
    }

    /**
     * Write a thumbnail from the middle of the pre-roll window.
     *
     * Mid-pre-roll beats "newest frame" — at the instant detection fires the
     * subject is often half out of frame or motion-blurred, whereas a moment
     * earlier they're usually cleanly visible walking in.
     *
     * Resolves to the relative path, or null if thumbnails are off or sharp
     * isn't available. Never throws: a missing thumbnail must not fail an event.
     */
    async writeThumbnail() {
        if (this.cfg.thumbnails === false) return null;
        if (!this.frameBuffer) return null;

        const preRoll = clampNumber(this.cfg.preRollSeconds, 0, 30, 5);
        const targetTs = this.startedAt.getTime() - (preRoll * 1000) / 2;
        const frame = this.frameBuffer.nearest(targetTs) || this.frameBuffer.latest();
        if (!frame) return null;

        const { absPath, relPath } = this._buildThumbPaths();
        try {
            // eslint-disable-next-line global-require
            const sharp = require("sharp");
            fs.mkdirSync(path.dirname(absPath), { recursive: true });
            await sharp(frame.jpeg)
                .resize(THUMB_WIDTH, null, { withoutEnlargement: true })
                .jpeg({ quality: 72 })
                .toFile(absPath);
            this._thumbAbsPath = absPath;
            this._thumbRelPath = relPath;
            return relPath;
        } catch (err) {
            this.log.warn(`[hub] thumbnail failed for ${this.cam.id}: ${err && err.message}`);
            return null;
        }
    }

    /**
     * Keep recording for `postRollSeconds`, then finalize.
     *
     * Called when the session ends logically. Returns the same promise as
     * `stop()` so a caller that wants to await the finished file still can,
     * while the normal path fires and forgets.
     */
    beginPostRoll() {
        if (this._stopPromise) return this._stopPromise;

        const seconds = clampNumber(this.cfg.postRollSeconds, 0, 60, 5);
        if (seconds <= 0 || !this.proc) return this.stop();

        this._postRollUntil = Date.now() + seconds * 1000;
        this.log.info(`[hub] post-roll ${this.cam.id}: ${seconds}s`);

        this._stopPromise = new Promise((resolve) => {
            const check = () => {
                if (this.stopped || Date.now() >= this._postRollUntil) {
                    this._stopPromise = null;
                    resolve(this.stop());
                    return;
                }
                setTimeout(check, 200).unref?.();
            };
            setTimeout(check, 200).unref?.();
        });
        return this._stopPromise;
    }

    /** True while the recorder is draining its post-roll window. */
    get inPostRoll() {
        return this._postRollUntil > 0 && Date.now() < this._postRollUntil;
    }

    /**
     * Stop immediately. Closes stdin so ffmpeg flushes the muxer, waits up to
     * STOP_GRACE_MS, then SIGINTs. Resolves with the final file details.
     */
    async stop() {
        if (this.stopped && !this.proc) {
            return this._result(0);
        }
        this.stopped = true;
        this._postRollUntil = 0;
        if (this._tickTimer) {
            clearTimeout(this._tickTimer);
            this._tickTimer = null;
        }

        if (!this.proc) return this._result(null);

        // Closing stdin is the polite signal — ffmpeg flushes and exits 0.
        // SIGINT is the backup if it's still alive after the grace window.
        try { this.proc.stdin.end(); } catch (_) { /* ignore */ }

        const timeout = new Promise((resolve) => {
            setTimeout(() => {
                if (this.proc && this.proc.exitCode === null) {
                    try { this.proc.kill("SIGINT"); } catch (_) { /* ignore */ }
                }
                resolve("timeout");
            }, STOP_GRACE_MS);
        });
        const result = await Promise.race([this._exitPromise, timeout]);
        const exitCode = result && typeof result === "object" ? result.code : null;
        return this._result(exitCode);
    }

    _result(exitCode) {
        let bytes = null;
        if (this._absPath) {
            try { bytes = fs.statSync(this._absPath).size; } catch (_) { bytes = null; }
        }
        return {
            absPath: this._absPath,
            relPath: this._relPath,
            thumbRelPath: this._thumbRelPath,
            framesWritten: this.framesWritten,
            preRollFrames: this.preRollFrames,
            bytes,
            exitCode
        };
    }

    _scheduleTick(delay) {
        if (this.stopped) return;
        this._tickTimer = setTimeout(() => this._tick().catch((err) => {
            this.log.error(`[hub] recorder tick error: ${err && err.message}`);
        }), delay);
        if (typeof this._tickTimer.unref === "function") this._tickTimer.unref();
    }

    async _tick() {
        if (this.stopped || !this.proc || !this.proc.stdin.writable) return;

        const cam = this.cam;
        if (!cam.lastJpeg || cam.frameSeq === this.lastSeq) {
            this._scheduleTick(FRAME_POLL_MS);
            return;
        }

        const jpeg = cam.lastJpeg;
        this.lastSeq = cam.frameSeq;

        let drainedSync;
        try {
            drainedSync = this.proc.stdin.write(jpeg);
        } catch (err) {
            this.log.warn(`[hub] ffmpeg write failed: ${err.message}`);
            this.stopped = true;
            return;
        }
        this.framesWritten += 1;

        if (drainedSync === false) {
            try {
                await Promise.race([
                    once(this.proc.stdin, "drain"),
                    new Promise((_, reject) => setTimeout(
                        () => reject(new Error("stdin drain timeout")), STDIN_DRAIN_TIMEOUT_MS
                    ))
                ]);
            } catch (err) {
                this.log.warn(`[hub] ffmpeg backpressure stall: ${err.message}`);
                this.stopped = true;
                return;
            }
        }

        this._scheduleTick(FRAME_POLL_MS);
    }

    _buildPaths(codec) {
        const ext = codec === "mkv" ? "mkv" : "mp4";
        const { dateDir, stamp } = splitTimestamp(this.startedAt);
        const relPath = path.join(dateDir, `${stamp}_${this.cam.id}_${this.eventType}.${ext}`);
        return { absPath: path.join(this.clipsRoot, relPath), relPath };
    }

    _buildThumbPaths() {
        const { dateDir, stamp } = splitTimestamp(this.startedAt);
        const relPath = path.join(dateDir, `${stamp}_${this.cam.id}_${this.eventType}.jpg`);
        return { absPath: path.join(this.clipsRoot, relPath), relPath };
    }
}

/**
 * Layout: <clipsRoot>/<YYYY-MM-DD>/<HH-MM-SS>_<camId>_<event>.<ext>
 * The cam id lives in the filename so one date folder holds every camera's
 * clips for that day — easy to scan in a file manager.
 */
function splitTimestamp(date) {
    const p = (n) => String(n).padStart(2, "0");
    const dateDir = `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
    const stamp = `${p(date.getHours())}-${p(date.getMinutes())}-${p(date.getSeconds())}`;
    return { dateDir, stamp };
}

function buildFfmpegArgs({ codec, fps, crf, outPath }) {
    const common = [
        "-hide_banner",
        "-loglevel", "warning",
        "-f", "mjpeg",
        "-framerate", String(fps),
        "-i", "pipe:0"
    ];
    if (codec === "mkv") {
        // Stream-copy MJPEG into Matroska. Zero CPU, tail-readable on crash,
        // but large and not universally playable in browsers.
        return [...common, "-c:v", "copy", "-f", "matroska", "-y", outPath];
    }
    return [
        ...common,
        "-c:v", "libx264",
        "-preset", "ultrafast",
        "-tune", "zerolatency",
        "-crf", String(crf),
        "-pix_fmt", "yuv420p",
        // faststart moves the moov atom to the front so the clip is seekable
        // in a browser without downloading the whole file first.
        "-movflags", "+faststart",
        "-f", "mp4",
        "-y", outPath
    ];
}

function clampNumber(n, lo, hi, fallback) {
    if (typeof n !== "number" || !isFinite(n)) return fallback;
    return Math.min(Math.max(n, lo), hi);
}

module.exports = { Recorder, buildFfmpegArgs };
