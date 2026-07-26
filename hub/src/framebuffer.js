"use strict";

/**
 * Per-camera ring buffer of recent JPEG frames.
 *
 * The hub used to keep exactly one frame per camera (`cam.lastJpeg`), which is
 * all the MJPEG re-fan needs. But a clip that starts at the moment detection
 * fires opens with someone already standing in frame — the walk-up, which is
 * the part you actually want, has already been thrown away.
 *
 * So we hold the last N seconds. When a session starts, those buffered frames
 * are flushed into ffmpeg ahead of the live ones and the clip begins before the
 * event did.
 *
 * Memory: at 640x480 / quality 70 a JPEG runs ~30 KB. Five seconds at 15 fps is
 * ~2.3 MB per camera. `maxBytes` is a hard ceiling regardless of the frame-count
 * target, so an unexpectedly high-bitrate camera degrades to fewer seconds of
 * pre-roll instead of eating the hub's RAM.
 *
 * Buffers are stored by reference, never copied. Camera nodes send each frame as
 * a fresh Buffer off the socket and the hub never mutates them, so retaining a
 * reference is safe and keeps the hot path allocation-free.
 */

const DEFAULT_MAX_BYTES = 24 * 1024 * 1024;   // 24 MB ceiling per camera

class FrameBuffer {
    /**
     * @param {object} [opts]
     * @param {number} [opts.seconds=5]    Target pre-roll depth.
     * @param {number} [opts.fps=15]       Expected camera frame rate.
     * @param {number} [opts.maxBytes]     Hard memory ceiling.
     */
    constructor({ seconds = 5, fps = 15, maxBytes = DEFAULT_MAX_BYTES } = {}) {
        this.maxBytes = maxBytes;
        this.frames = [];        // [{ jpeg, ts, seq }], oldest first
        this.bytes = 0;
        this.setCapacity({ seconds, fps });
    }

    /**
     * Resize the target depth. Called when pre-roll settings change or the
     * camera reports a different fps, so an edit in the UI takes effect on the
     * next event without a hub restart.
     */
    setCapacity({ seconds, fps }) {
        if (typeof seconds === "number" && isFinite(seconds)) {
            this.seconds = Math.max(0, Math.min(seconds, 60));
        }
        if (typeof fps === "number" && isFinite(fps) && fps > 0) {
            this.fps = Math.max(1, Math.min(fps, 60));
        }
        this.capacity = Math.max(1, Math.ceil(this.seconds * this.fps));
        this._trim();
    }

    /**
     * @param {Buffer} jpeg
     * @param {number} seq   Monotonic frame counter from the cam record.
     * @param {number} [ts]  Defaults to now.
     */
    push(jpeg, seq, ts) {
        if (!jpeg || !jpeg.length) return;
        const at = (typeof ts === "number" && isFinite(ts)) ? ts : Date.now();
        this.frames.push({ jpeg, seq, ts: at });
        this.bytes += jpeg.length;
        this._trim();
    }

    /**
     * Frames from the last `seconds`, oldest first. Returns the internal
     * objects; callers must not mutate them.
     *
     * @param {number} [seconds]  Defaults to the configured depth.
     * @param {number} [beforeTs] Only frames at or before this timestamp.
     */
    recent(seconds, beforeTs) {
        const window = (typeof seconds === "number" && isFinite(seconds))
            ? Math.max(0, seconds)
            : this.seconds;
        if (window <= 0) return [];
        const end = beforeTs || Date.now();
        const start = end - window * 1000;
        return this.frames.filter((f) => f.ts >= start && f.ts <= end);
    }

    /** Newest frame, or null. This is what the MJPEG re-fan serves. */
    latest() {
        return this.frames.length ? this.frames[this.frames.length - 1] : null;
    }

    /**
     * Frame nearest a timestamp — used to pick a representative thumbnail
     * from the middle of the pre-roll rather than whatever happened to be
     * newest.
     */
    nearest(ts) {
        if (!this.frames.length) return null;
        let best = this.frames[0];
        let bestDelta = Math.abs(best.ts - ts);
        for (let i = 1; i < this.frames.length; i += 1) {
            const delta = Math.abs(this.frames[i].ts - ts);
            if (delta < bestDelta) {
                best = this.frames[i];
                bestDelta = delta;
            }
        }
        return best;
    }

    clear() {
        this.frames = [];
        this.bytes = 0;
    }

    stats() {
        return {
            count: this.frames.length,
            bytes: this.bytes,
            capacity: this.capacity,
            seconds: this.seconds,
            oldestTs: this.frames.length ? this.frames[0].ts : null
        };
    }

    _trim() {
        while (this.frames.length > this.capacity) {
            this.bytes -= this.frames.shift().jpeg.length;
        }
        // Byte ceiling wins over the frame-count target.
        while (this.frames.length > 1 && this.bytes > this.maxBytes) {
            this.bytes -= this.frames.shift().jpeg.length;
        }
    }
}

module.exports = { FrameBuffer };
