"use strict";

/**
 * Continuous ("always on") recording — the DVR reel you can scrub back through.
 *
 * One long-lived ffmpeg per camera, writing rolling fixed-length segments via
 * the segment muxer. Old segments are evicted by `storage.js` when the budget
 * fills; segments the user has saved are protected and never taken.
 *
 * ============================================================================
 *  Why segments, and why a fixed frame rate
 * ============================================================================
 *
 * **Segments** because a single enormous file can neither be partially deleted
 * to reclaim space nor played until it's closed. Five-minute chunks are the
 * unit of both eviction and seeking.
 *
 * **A fixed frame rate is the load-bearing decision here.** Scrubbing to
 * "yesterday at 14:32" means computing an offset into a file, and that only
 * works if video time maps linearly onto wall-clock time. So the pump emits
 * exactly `fps` frames per second no matter what the camera is doing: if no new
 * frame has arrived it repeats the last one.
 *
 * Feeding whatever happens to arrive would seem more efficient and would
 * quietly corrupt the whole feature — a camera that dropped to 3 fps for a
 * minute would make everything after that point in the segment sit at the wrong
 * timestamp, and the further in you scrub the more wrong it gets. Repeated
 * frames cost almost nothing (x264 encodes a static image as a handful of
 * bytes) and buy an exact time mapping.
 *
 * ============================================================================
 *  Gaps
 * ============================================================================
 *
 * A camera that goes away is tolerated for `DROPOUT_GRACE_MS` by repeating its
 * last frame — brief WiFi hiccups shouldn't shred the recording into fragments.
 * Past that the recorder stops, and a new segment starts when the camera comes
 * back. The timeline then shows a real gap, which is itself worth knowing:
 * "there is no footage here" is very different from "nothing happened here".
 *
 * ============================================================================
 *  Cost
 * ============================================================================
 *
 * At the defaults (8 fps, crf 32, 640x480) this is roughly 1.2 GB per camera
 * per day and a few percent of one Pi 4 core. It's deliberately cheaper than
 * event recording: continuous footage exists so you can go back and look, while
 * event clips are the ones you'll actually keep and want to look good.
 */

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

const { expandHome } = require("./store");

/** Sub-directory of clipsRoot holding the reel, kept apart from event clips. */
const CONTINUOUS_DIR = "continuous";

/** Silence beyond this ends the segment rather than recording a frozen image. */
const DROPOUT_GRACE_MS = 10_000;

/** How often finished segments are indexed into the database. */
const INDEX_INTERVAL_MS = 30_000;

/**
 * Cap on how much lost time one tick will fill in. A hub that stalled for a
 * minute shouldn't dump a minute of frames into the pipe in one go; it catches
 * up over the next few ticks instead.
 */
const MAX_CATCHUP_SECONDS = 2;

/** Backoff after ffmpeg dies unexpectedly. */
const RESTART_DELAY_MS = 5_000;

const STOP_GRACE_MS = 8_000;

/**
 * `<clipsRoot>/continuous/<camId>/<YYYY-MM-DD_HH-MM-SS>.mp4`
 *
 * Flat, with the date in the filename rather than in a per-day sub-directory.
 * A `%Y-%m-%d/` component would read better in a file manager, but the segment
 * muxer does not create directories for its output path and has no option to
 * (`-strftime_mkdir` belongs to the image2 muxer, not this one), so it simply
 * fails at every midnight rollover. Filenames sort chronologically either way,
 * which is all the indexer relies on.
 */
const SEGMENT_PATTERN = "%Y-%m-%d_%H-%M-%S.mp4";
const SEGMENT_FILE_RE = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})\.mp4$/;

class ContinuousRecorder {
    /**
     * @param {object} opts
     * @param {object} opts.cam        Cam record (we read lastJpeg/frameSeq/connected).
     * @param {object} opts.settings   SettingsService.
     * @param {object} opts.store
     * @param {string} opts.clipsRoot
     * @param {object} [opts.logger]
     */
    constructor({ cam, settings, store, clipsRoot, logger }) {
        if (!cam) throw new Error("ContinuousRecorder: cam is required");
        if (!settings) throw new Error("ContinuousRecorder: settings is required");

        this.cam = cam;
        this.camId = cam.id;
        this.settings = settings;
        this.store = store || null;
        this.log = logger || console;

        this.root = path.join(expandHome(clipsRoot), CONTINUOUS_DIR, cam.id);

        this.proc = null;
        this.running = false;
        this.startedAt = 0;
        this.framesWritten = 0;
        this.lastFrameSeq = -1;
        this.lastRealFrameAt = 0;
        this.lastError = null;

        this._pumpTimer = null;
        this._indexTimer = null;
        this._restartTimer = null;
        this._exitPromise = null;
        this._lastJpeg = null;
        this._pumpStartedAt = 0;
    }

    // ------------------------------------------------------------------
    //  Lifecycle
    // ------------------------------------------------------------------

    get enabled() {
        return !!this.settings.get("continuous.enabled", this.camId);
    }

    /** Bring the recorder up if it should be running. Safe to call repeatedly. */
    start() {
        if (!this.enabled || this.running) return;
        if (!this.cam.connected || this.cam.desiredState !== "on") return;

        const fps = this._fps();
        const crf = clampNumber(this.settings.get("continuous.crf", this.camId), 18, 45, 32);
        const segmentSeconds = Math.round(
            clampNumber(this.settings.get("continuous.segmentMinutes", this.camId), 1, 30, 5) * 60
        );

        try {
            fs.mkdirSync(this.root, { recursive: true });
        } catch (err) {
            this.lastError = `cannot create ${this.root}: ${err.message}`;
            this.log.error(`[hub] continuous: ${this.lastError}`);
            return;
        }

        const args = buildArgs({
            fps, crf, segmentSeconds,
            outPattern: path.join(this.root, SEGMENT_PATTERN)
        });

        try {
            this.proc = spawn("ffmpeg", args, { stdio: ["pipe", "ignore", "pipe"] });
        } catch (err) {
            this.lastError = `failed to spawn ffmpeg: ${err.message}`;
            this.log.error(`[hub] continuous: ${this.lastError}`);
            this.proc = null;
            return;
        }

        this.running = true;
        this.startedAt = Date.now();
        // Frame accounting is relative to this instant — see `_pump`.
        this._pumpStartedAt = Date.now();
        this.framesWritten = 0;
        this.lastRealFrameAt = Date.now();
        this.lastError = null;

        // A missing ffmpeg binary does NOT throw from spawn — it arrives as an
        // async 'error' event, and unhandled it takes the whole hub down.
        this.proc.on("error", (err) => {
            this.lastError = err.code === "ENOENT"
                ? "ffmpeg is not installed, so continuous recording cannot run"
                : `ffmpeg failed to start: ${err.message}`;
            this.log.error(`[hub] continuous(${this.camId}): ${this.lastError}`);
            this.running = false;
            this.proc = null;
        });

        this.proc.stderr.setEncoding("utf8");
        this.proc.stderr.on("data", (chunk) => {
            for (const line of String(chunk).split(/\r?\n/)) {
                if (/error|invalid|failed|cannot|no such/i.test(line)) {
                    this.log.warn(`[hub] continuous(${this.camId}) ffmpeg: ${line.trim()}`);
                }
            }
        });

        this.proc.stdin.on("error", (err) => {
            if (err.code !== "EPIPE") {
                this.log.warn(`[hub] continuous(${this.camId}) stdin: ${err.message}`);
            }
            this.running = false;
        });

        this._exitPromise = new Promise((resolve) => {
            this.proc.once("exit", (code, signal) => {
                const wasRunning = this.running;
                this.running = false;
                this.proc = null;
                resolve({ code, signal });
                // An unexpected death should not silently stop recording
                // forever — that is the failure nobody notices until they need
                // the footage.
                if (wasRunning && code !== 0 && signal !== "SIGINT") {
                    this.log.warn(
                        `[hub] continuous(${this.camId}) ffmpeg exited code=${code}; restarting`
                    );
                    this._scheduleRestart();
                }
            });
        });

        this.log.info(
            `[hub] continuous recording ${this.camId}: ${fps} fps, crf ${crf}, ` +
            `${segmentSeconds / 60} min segments -> ${this.root}`
        );

        this._pump();
        this._startIndexing();
    }

    /** Stop and index whatever was written. */
    async stop(reason) {
        if (this._restartTimer) { clearTimeout(this._restartTimer); this._restartTimer = null; }
        if (this._pumpTimer) { clearTimeout(this._pumpTimer); this._pumpTimer = null; }
        if (this._indexTimer) { clearInterval(this._indexTimer); this._indexTimer = null; }

        const proc = this.proc;
        this.running = false;
        if (!proc) {
            await this.indexSegments({ includeLatest: true });
            return;
        }

        this.log.info(`[hub] continuous(${this.camId}) stopping (${reason || "shutdown"})`);
        try { proc.stdin.end(); } catch (_) { /* ignore */ }

        await Promise.race([
            this._exitPromise,
            new Promise((resolve) => setTimeout(() => {
                if (proc.exitCode === null) { try { proc.kill("SIGINT"); } catch (_) { /* ignore */ } }
                resolve("timeout");
            }, STOP_GRACE_MS))
        ]);

        this.proc = null;
        // The final segment is only complete once ffmpeg has closed it.
        await this.indexSegments({ includeLatest: true });
    }

    /** React to the camera connecting, disconnecting, or being switched off. */
    sync() {
        const shouldRun = this.enabled
            && this.cam.connected
            && this.cam.desiredState === "on";

        if (shouldRun && !this.running && !this._restartTimer) this.start();
        else if (!shouldRun && this.running) {
            this.stop("camera unavailable").catch(() => { /* logged inside */ });
        }
    }

    /** Settings changed — restart so the new fps/quality takes effect. */
    async reconfigure() {
        if (this.running) await this.stop("settings changed");
        this.sync();
    }

    status() {
        return {
            enabled: this.enabled,
            running: this.running,
            since: this.running ? this.startedAt : null,
            framesWritten: this.framesWritten,
            error: this.lastError
        };
    }

    _scheduleRestart() {
        if (this._restartTimer) return;
        this._restartTimer = setTimeout(() => {
            this._restartTimer = null;
            this.sync();
        }, RESTART_DELAY_MS);
        this._restartTimer.unref?.();
    }

    _fps() {
        return Math.round(clampNumber(this.settings.get("continuous.fps", this.camId), 1, 30, 8));
    }

    // ------------------------------------------------------------------
    //  The frame pump
    // ------------------------------------------------------------------

    /**
     * Emit exactly `fps` frames per second of *elapsed wall-clock time*,
     * repeating the last frame when the camera hasn't produced a new one.
     *
     * This is what keeps video time equal to wall-clock time, which is what
     * makes "scrub to 14:32" land on 14:32. See the header.
     *
     * The scheduling is deliberately drift-corrected rather than a plain
     * `setTimeout(125)` loop. A fixed delay always runs slightly slow — the
     * timer fires no earlier than asked and the work takes time on top — which
     * measured about 1.6% here. That sounds negligible and isn't: it
     * accumulates *within* a segment, so by the end of a five-minute chunk the
     * picture is nearly five seconds away from where the timeline says it is.
     *
     * So each tick asks how many frames *should* exist by now given the elapsed
     * time, and writes however many are missing. Duplicates are almost free and
     * the mapping stays exact regardless of timer jitter or a busy event loop.
     */
    _pump() {
        if (!this.running || !this.proc) return;

        const fps = this._fps();
        const intervalMs = 1000 / fps;
        const now = Date.now();
        const cam = this.cam;

        const haveNewFrame = cam.lastJpeg && cam.frameSeq !== this.lastFrameSeq;
        if (haveNewFrame) {
            this._lastJpeg = cam.lastJpeg;
            this.lastFrameSeq = cam.frameSeq;
            this.lastRealFrameAt = now;
        }

        const silentFor = now - this.lastRealFrameAt;
        if (silentFor > DROPOUT_GRACE_MS) {
            // Long dropout. End the segment rather than recording a frozen
            // image for hours; the timeline should show an honest gap.
            this.log.info(
                `[hub] continuous(${this.camId}): no frames for ${Math.round(silentFor / 1000)}s, ` +
                "ending segment"
            );
            this.stop("camera stopped sending").catch(() => { /* logged inside */ });
            return;
        }

        if (this._lastJpeg) {
            // Frames owed since the pump started, not since the last tick.
            const due = Math.floor((now - this._pumpStartedAt) / intervalMs) + 1;
            const owed = Math.min(Math.max(due - this.framesWritten, 0), fps * MAX_CATCHUP_SECONDS);

            for (let i = 0; i < owed; i += 1) {
                try {
                    // Backpressure is deliberately ignored. Dropping a frame
                    // would desynchronise the time mapping, and ffmpeg consumes
                    // small JPEGs far faster than a few per second.
                    this.proc.stdin.write(this._lastJpeg);
                    this.framesWritten += 1;
                } catch (err) {
                    this.log.warn(`[hub] continuous(${this.camId}) write failed: ${err.message}`);
                    this.running = false;
                    return;
                }
            }
        }

        // Aim at the next absolute due instant rather than "now + interval",
        // so error can't accumulate.
        const nextDueAt = this._pumpStartedAt + this.framesWritten * intervalMs;
        this._pumpTimer = setTimeout(
            () => this._pump(), Math.max(1, Math.round(nextDueAt - Date.now()))
        );
        this._pumpTimer.unref?.();
    }

    // ------------------------------------------------------------------
    //  Indexing
    // ------------------------------------------------------------------

    _startIndexing() {
        if (this._indexTimer) return;
        this._indexTimer = setInterval(
            () => this.indexSegments().catch((err) =>
                this.log.warn(`[hub] continuous index failed: ${err && err.message}`)),
            INDEX_INTERVAL_MS
        );
        this._indexTimer.unref?.();
    }

    /**
     * Record finished segments in the database.
     *
     * Filenames are timestamps, so lexicographic order is chronological and the
     * newest file is the one ffmpeg is still writing. That file is skipped
     * unless we're stopping, because indexing a partial segment would put a
     * wrong duration on the timeline.
     *
     * A segment's end is taken from the *next* segment's start where one
     * exists, which is exact, and from the file's mtime otherwise. No ffprobe:
     * the fixed-rate pump already guarantees the time mapping, so duration is
     * only needed for drawing coverage bars.
     */
    async indexSegments({ includeLatest = false } = {}) {
        if (!this.store) return { indexed: 0 };

        let files;
        try {
            files = await listSegments(this.root);
        } catch (_) {
            return { indexed: 0 };
        }
        if (!files.length) return { indexed: 0 };

        const candidates = includeLatest ? files : files.slice(0, -1);
        let indexed = 0;

        for (let i = 0; i < candidates.length; i += 1) {
            const rel = candidates[i];
            if (this.store.hasRecordingPath(this._storedPath(rel))) continue;

            const startedAtMs = parseSegmentStart(rel);
            if (startedAtMs === null) continue;

            const abs = path.join(this.root, rel);
            let stat;
            try { stat = await fsp.stat(abs); } catch (_) { continue; }

            // Zero-length segments happen if ffmpeg is killed the instant after
            // opening a file. Nothing to index, and a 0 ms row would confuse
            // the timeline.
            if (stat.size === 0) continue;

            const next = files[files.indexOf(rel) + 1];
            const nextStart = next ? parseSegmentStart(next) : null;
            const endedAtMs = nextStart !== null ? nextStart : Math.round(stat.mtimeMs);

            try {
                this.store.insertRecording({
                    camId: this.camId,
                    path: this._storedPath(rel),
                    startedAtMs,
                    endedAtMs: Math.max(endedAtMs, startedAtMs),
                    bytes: stat.size
                });
                indexed += 1;
            } catch (err) {
                this.log.warn(`[hub] failed to index ${rel}: ${err && err.message}`);
            }
        }

        if (indexed) {
            this.log.debug?.(`[hub] continuous(${this.camId}): indexed ${indexed} segment(s)`);
        }
        return { indexed };
    }

    /** Path stored in the DB, relative to clipsRoot so it matches event clips. */
    _storedPath(rel) {
        return path.join(CONTINUOUS_DIR, this.camId, rel);
    }
}

/**
 * ffmpeg arguments for the rolling recorder.
 *
 * `-reset_timestamps 1` makes every segment start at t=0, so seeking within one
 * is simply (wantedMs - segmentStartMs). Without it the browser would need to
 * know each segment's global offset.
 */
function buildArgs({ fps, crf, segmentSeconds, outPattern }) {
    return [
        "-hide_banner",
        "-loglevel", "warning",
        "-f", "mjpeg",
        "-framerate", String(fps),
        // Skip input probing. By default ffmpeg spends ~5 seconds analysing the
        // stream before it opens the first output file — and because `-strftime`
        // names each segment for the moment it is *opened*, that delay puts the
        // first segment's filename five seconds after its first frame. Every
        // seek into that segment would then land five seconds off. The input
        // format is entirely ours, so there is nothing to discover.
        "-analyzeduration", "0",
        "-probesize", "32",
        "-i", "pipe:0",
        "-c:v", "libx264",
        "-preset", "ultrafast",
        "-tune", "zerolatency",
        "-crf", String(crf),
        "-pix_fmt", "yuv420p",
        // A keyframe every 2 seconds. Denser than needed for playback, but it
        // bounds how far the browser must decode to satisfy a seek.
        "-g", String(Math.max(1, fps * 2)),
        "-f", "segment",
        "-segment_time", String(segmentSeconds),
        "-segment_format", "mp4",
        "-segment_format_options", "movflags=+faststart",
        "-reset_timestamps", "1",
        "-strftime", "1",
        outPattern
    ];
}

/** Segment filenames, chronological — the names are timestamps, so they sort. */
async function listSegments(root) {
    const entries = await fsp.readdir(root, { withFileTypes: true });
    return entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".mp4"))
        .map((entry) => entry.name)
        .sort();
}

/** `2026-08-12_14-32-00.mp4` -> epoch ms in local time. */
function parseSegmentStart(relPath) {
    const m = SEGMENT_FILE_RE.exec(path.basename(String(relPath)));
    if (!m) return null;
    const [, y, mo, d, h, mi, s] = m.map(Number);
    // ffmpeg's -strftime writes local time, so parse as local.
    const date = new Date(y, mo - 1, d, h, mi, s);
    const ms = date.getTime();
    return isFinite(ms) ? ms : null;
}

function clampNumber(n, lo, hi, fallback) {
    const num = Number(n);
    if (!isFinite(num)) return fallback;
    return Math.min(Math.max(num, lo), hi);
}

/**
 * Start or stop a camera's reel to match its current state.
 *
 * Called whenever anything relevant changes — connect, disconnect, on/off, or a
 * settings edit — so the recorder converges instead of every call site having
 * to reason about it.
 */
function syncFor(hub, cam) {
    if (!cam || !hub.settings || !hub.store) return;

    const recordingLog = (hub.log && typeof hub.log.forCategory === "function")
        ? hub.log.forCategory("recording") : hub.log;

    if (!cam.continuous) {
        cam.continuous = new ContinuousRecorder({
            cam,
            settings: hub.settings,
            store: hub.store,
            clipsRoot: hub.clipsRoot,
            logger: recordingLog
        });
    }
    try {
        cam.continuous.sync();
    } catch (err) {
        recordingLog.warn(`[hub] continuous sync failed for ${cam.id}: ${err && err.message}`);
    }
}

/** Stop every reel, closing and indexing each final segment. */
async function stopAll(hub, reason) {
    await Promise.all([...hub.cams.values()].map((cam) =>
        cam.continuous
            ? cam.continuous.stop(reason).catch(() => { /* logged inside */ })
            : Promise.resolve()
    ));
}

/** Cycle every reel so a changed fps/quality actually takes effect. */
function reconfigureAll(hub) {
    for (const cam of hub.cams.values()) {
        if (cam.continuous) cam.continuous.reconfigure().catch(() => { /* logged inside */ });
        else syncFor(hub, cam);
    }
}

function statusFor(hub, camId) {
    const cam = hub.cams.get(camId);
    if (!cam || !cam.continuous) {
        return {
            enabled: hub.settings ? hub.settings.get("continuous.enabled", camId) : false,
            running: false,
            since: null,
            error: null
        };
    }
    return cam.continuous.status();
}

module.exports = {
    ContinuousRecorder,
    syncFor,
    stopAll,
    reconfigureAll,
    statusFor,
    buildArgs,
    parseSegmentStart,
    listSegments,
    CONTINUOUS_DIR,
    DROPOUT_GRACE_MS
};
