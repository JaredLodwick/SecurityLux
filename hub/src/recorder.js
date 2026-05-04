"use strict";

/**
 * Per-event video recorder.
 *
 * Spawns an ffmpeg child process and pipes the camera's buffered JPEG frames
 * into its stdin as a Motion-JPEG stream. By default it stream-copies the
 * MJPEG into an MKV container — zero CPU, tail-readable on crash, plays in
 * browsers via <video>. With `codec: "h264"` it re-encodes via libx264
 * ultrafast for a smaller file at modest CPU cost.
 *
 * One Recorder instance per active session. Lifecycle:
 *   start() → ffmpeg spawned, frame-watch loop kicked off.
 *   stop()  → SIGINT to ffmpeg, await clean exit, resolve with the final path.
 *
 * The watch loop polls `cam.frameSeq` (mirrors the `serveMjpeg` pattern in
 * node_helper.js) so frames are written at the camera's actual fps, even
 * though the detector is only running at ~2 fps to drive session start/stop.
 */

const { spawn } = require("node:child_process");
const { once } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");

const { expandHome } = require("./store");

const FRAME_POLL_MS = 50;          // matches serveMjpeg cadence
const STDIN_DRAIN_TIMEOUT_MS = 2000;
const STOP_GRACE_MS = 5000;         // how long we'll wait for ffmpeg to finalize

class Recorder {
    /**
     * @param {object} opts
     * @param {object} opts.cam            Cam record (we read lastJpeg/frameSeq).
     * @param {object} opts.recordingCfg   Module's `recording` config block.
     * @param {string} opts.clipsRoot      Root dir for clip output (~ supported).
     * @param {Date}   [opts.startedAt]    Defaults to now.
     * @param {string} [opts.eventType]    Used in the filename. Defaults "person".
     * @param {object} [opts.logger]
     */
    constructor({ cam, recordingCfg, clipsRoot, startedAt, eventType, logger }) {
        if (!cam) throw new Error("Recorder: cam is required");
        if (!recordingCfg) throw new Error("Recorder: recordingCfg is required");
        if (!clipsRoot) throw new Error("Recorder: clipsRoot is required");

        this.cam = cam;
        this.cfg = recordingCfg;
        this.clipsRoot = expandHome(clipsRoot);
        this.startedAt = startedAt || new Date();
        this.eventType = eventType || "person";
        this.log = logger || console;

        this.proc = null;
        this.stopped = false;
        this.framesWritten = 0;
        this.lastSeq = -1;
        this._tickTimer = null;
        this._exitPromise = null;
        this._absPath = null;
        this._relPath = null;
    }

    /** Absolute clip path (set after start()). */
    get absPath() { return this._absPath; }
    /** Path relative to clipsRoot — what we store in events.clip_path. */
    get relPath() { return this._relPath; }

    start() {
        if (this.proc) return;

        const codec = this.cfg.codec === "h264" ? "h264" : "mkv";
        const fps = clampNumber(this.cfg.fps, 1, 60, 15);
        const { absPath, relPath } = this._buildPaths();
        fs.mkdirSync(path.dirname(absPath), { recursive: true });
        this._absPath = absPath;
        this._relPath = relPath;

        const args = buildFfmpegArgs({ codec, fps, outPath: absPath });
        this.log.info(`[hub] recording ${this.cam.id} -> ${relPath} (${codec})`);

        try {
            this.proc = spawn("ffmpeg", args, { stdio: ["pipe", "ignore", "pipe"] });
        } catch (err) {
            this.log.error(`[hub] failed to spawn ffmpeg: ${err.message}`);
            this.proc = null;
            return;
        }

        // ffmpeg writes a lot of progress to stderr; only surface lines that
        // look like errors to keep the journal sane.
        this.proc.stderr.setEncoding("utf8");
        this.proc.stderr.on("data", (chunk) => {
            const lines = String(chunk).split(/\r?\n/);
            for (const line of lines) {
                if (/error|invalid|failed|cannot|no such/i.test(line)) {
                    this.log.warn(`[hub] ffmpeg(${this.cam.id}): ${line.trim()}`);
                }
            }
        });

        this.proc.stdin.on("error", (err) => {
            // EPIPE happens if ffmpeg exits before we finish writing — that's
            // not catastrophic, just stop the loop.
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

        // First tick is async; pre-seed lastSeq so we definitely write the
        // current frame if one is already buffered.
        this.lastSeq = -1;
        this._scheduleTick(0);
    }

    /**
     * Stop the recorder. Sends SIGINT (so MKV/MP4 can finalize), waits up to
     * STOP_GRACE_MS for clean exit. Resolves with { absPath, relPath, framesWritten, exitCode }.
     */
    async stop() {
        if (this.stopped && !this.proc) {
            return { absPath: this._absPath, relPath: this._relPath, framesWritten: this.framesWritten, exitCode: 0 };
        }
        this.stopped = true;
        if (this._tickTimer) {
            clearTimeout(this._tickTimer);
            this._tickTimer = null;
        }

        if (!this.proc) {
            return { absPath: this._absPath, relPath: this._relPath, framesWritten: this.framesWritten, exitCode: null };
        }

        // Closing stdin is the polite signal — ffmpeg flushes the muxer and
        // exits 0. Send SIGINT as a backup if it's still alive after the grace.
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

        return {
            absPath: this._absPath,
            relPath: this._relPath,
            framesWritten: this.framesWritten,
            exitCode
        };
    }

    _scheduleTick(delay) {
        if (this.stopped) return;
        this._tickTimer = setTimeout(() => this._tick().catch((err) => {
            this.log.error(`[hub] recorder tick error: ${err && err.message}`);
        }), delay);
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
                    new Promise((_, reject) => setTimeout(() => reject(new Error("stdin drain timeout")), STDIN_DRAIN_TIMEOUT_MS))
                ]);
            } catch (err) {
                this.log.warn(`[hub] ffmpeg backpressure stall: ${err.message}`);
                this.stopped = true;
                return;
            }
        }

        this._scheduleTick(FRAME_POLL_MS);
    }

    _buildPaths() {
        const date = this.startedAt;
        const yyyy = date.getFullYear();
        const mm = String(date.getMonth() + 1).padStart(2, "0");
        const dd = String(date.getDate()).padStart(2, "0");
        const hh = String(date.getHours()).padStart(2, "0");
        const mi = String(date.getMinutes()).padStart(2, "0");
        const ss = String(date.getSeconds()).padStart(2, "0");
        const ext = this.cfg.codec === "h264" ? "mp4" : "mkv";

        // Layout: <clipsRoot>/<YYYY-MM-DD>/<HH-MM-SS>_<camId>_<event>.<ext>
        // The cam id moves into the filename so a single date folder holds
        // every camera's clips for that day, easy to scan in a file manager.
        const dateDir = `${yyyy}-${mm}-${dd}`;
        const fileName = `${hh}-${mi}-${ss}_${this.cam.id}_${this.eventType}.${ext}`;
        const relPath = path.join(dateDir, fileName);
        const absPath = path.join(this.clipsRoot, relPath);
        return { absPath, relPath };
    }
}

function buildFfmpegArgs({ codec, fps, outPath }) {
    const common = [
        "-hide_banner",
        "-loglevel", "warning",
        "-f", "mjpeg",
        "-framerate", String(fps),
        "-i", "pipe:0"
    ];
    if (codec === "h264") {
        return [
            ...common,
            "-c:v", "libx264",
            "-preset", "ultrafast",
            "-tune", "zerolatency",
            "-crf", "28",
            "-pix_fmt", "yuv420p",
            "-movflags", "+faststart",
            "-y", outPath
        ];
    }
    // Default: stream-copy MJPEG into MKV. Zero CPU, tail-readable on crash.
    return [
        ...common,
        "-c:v", "copy",
        "-f", "matroska",
        "-y", outPath
    ];
}

function clampNumber(n, lo, hi, fallback) {
    if (typeof n !== "number" || !isFinite(n)) return fallback;
    return Math.min(Math.max(n, lo), hi);
}

module.exports = { Recorder, buildFfmpegArgs };
