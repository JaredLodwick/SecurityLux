"use strict";

/**
 * Per-camera session state machine.
 *
 *   idle   --(person detected)-----> active   { row inserted, recorder spawned }
 *   active --(person detected)----> active    { grace counter reset, stats updated }
 *   active --(no person)----------> active    { grace counter incremented }
 *   active --(grace exceeded)-----> idle      { recorder stopped, row finalized }
 *   active --(max length hit)-----> idle      { recorder stopped, row finalized }
 *   active --(forceEnd)-----------> idle      { recorder stopped, row finalized or dropped }
 *
 * Sessions shorter than `minClipSeconds` are dropped (row deleted, clip
 * unlinked) so a single-frame false positive doesn't litter the event log.
 *
 * The manager doesn't directly read frames — that's the Recorder's job. It
 * just decides when sessions begin and end based on Detector observations.
 */

const fs = require("node:fs");

const STATE_IDLE = "idle";
const STATE_ACTIVE = "active";

class SessionManager {
    /**
     * @param {object} opts
     * @param {object} opts.store        Store instance (already opened).
     * @param {object} opts.recordingCfg Module's `recording` config block.
     * @param {string} opts.clipsRoot
     * @param {Function} opts.recorderFactory  `(cam, opts) => Recorder` (injected for tests).
     * @param {Function} opts.getCam     `(camId) => cam record` from node_helper.
     * @param {object} [opts.logger]
     * @param {Function} [opts.now]      Override time source (for tests).
     */
    constructor({ store, recordingCfg, clipsRoot, recorderFactory, getCam, logger, now }) {
        if (!store) throw new Error("SessionManager: store is required");
        if (!recordingCfg) throw new Error("SessionManager: recordingCfg is required");
        if (typeof recorderFactory !== "function") throw new Error("SessionManager: recorderFactory is required");
        if (typeof getCam !== "function") throw new Error("SessionManager: getCam is required");

        this.store = store;
        this.cfg = recordingCfg;
        this.clipsRoot = clipsRoot;
        this.recorderFactory = recorderFactory;
        this.getCam = getCam;
        this.log = logger || console;
        this.now = now || Date.now;

        this.sessions = new Map();   // camId -> session state
    }

    /**
     * Number of seconds we run a person-detection signal forward without
     * fresh evidence before declaring the session over.
     */
    get graceMs() {
        return clampNumber(this.cfg.graceMs, 250, 30_000, 1500);
    }

    get minClipMs() {
        return clampNumber(this.cfg.minClipSeconds, 0, 600, 2) * 1000;
    }

    get maxClipMs() {
        return clampNumber(this.cfg.maxClipSeconds, 5, 3600, 300) * 1000;
    }

    /**
     * Feed in a detector observation.
     */
    observe(camId, hasPerson, confidence) {
        const t = this.now();
        const sess = this.sessions.get(camId);

        if (!sess) {
            if (hasPerson) this._startSession(camId, t, confidence);
            return;
        }

        if (hasPerson) {
            sess.lastPersonAt = t;
            sess.detectionCount += 1;
            if (confidence > sess.maxConfidence) sess.maxConfidence = confidence;
        }
        // Cap session length even if a person stays in frame indefinitely.
        if (t - sess.startedAt >= this.maxClipMs) {
            this._endSession(camId, t, "max-length").catch(this._logEndError.bind(this));
            return;
        }
        // End if we've gone graceMs without seeing a person.
        if (t - sess.lastPersonAt >= this.graceMs) {
            this._endSession(camId, t, "grace-expired").catch(this._logEndError.bind(this));
        }
    }

    /**
     * End any active session immediately. Use when the camera disconnects or
     * the helper is shutting down. Returns a promise that resolves when the
     * recorder has finalized.
     */
    async forceEnd(camId, reason) {
        if (!this.sessions.has(camId)) return null;
        return this._endSession(camId, this.now(), reason || "force-end");
    }

    /**
     * End every active session. Returns once all recorders have finalized.
     * Used by node_helper.stop().
     */
    async forceEndAll(reason) {
        const ids = [...this.sessions.keys()];
        await Promise.all(ids.map((id) => this.forceEnd(id, reason)));
    }

    isActive(camId) {
        return this.sessions.has(camId);
    }

    _startSession(camId, t, confidence) {
        const cam = this.getCam(camId);
        if (!cam) return;

        const startedAt = new Date(t);
        let recorder = null;
        try {
            recorder = this.recorderFactory(cam, {
                recordingCfg: this.cfg,
                clipsRoot: this.clipsRoot,
                startedAt,
                eventType: "person",
                logger: this.log
            });
            recorder.start();
        } catch (err) {
            this.log.warn(`[hub] recorder failed to start for ${camId}: ${err && err.message}`);
            recorder = null;
        }

        let rowId = null;
        try {
            rowId = this.store.insertSession({
                camId,
                type: "person",
                startedAtMs: t,
                metadata: recorder ? null : { recorderUnavailable: true }
            });
        } catch (err) {
            this.log.warn(`[hub] store.insertSession failed for ${camId}: ${err && err.message}`);
        }

        this.sessions.set(camId, {
            state: STATE_ACTIVE,
            rowId,
            recorder,
            startedAt: t,
            lastPersonAt: t,
            detectionCount: 1,
            maxConfidence: confidence
        });

        this.log.info(`[hub] session started cam=${camId} id=${rowId ?? "?"} conf=${confidence.toFixed(2)}`);
    }

    async _endSession(camId, t, reason) {
        const sess = this.sessions.get(camId);
        if (!sess) return null;
        // Mark removed first so concurrent observe() calls don't re-trigger end.
        this.sessions.delete(camId);
        sess.state = STATE_IDLE;

        let clipPath = null;
        let framesWritten = 0;
        if (sess.recorder) {
            try {
                const result = await sess.recorder.stop();
                clipPath = result.relPath;
                framesWritten = result.framesWritten;
            } catch (err) {
                this.log.warn(`[hub] recorder stop failed for ${camId}: ${err && err.message}`);
            }
        }

        const duration = t - sess.startedAt;
        const drop = duration < this.minClipMs;

        if (drop) {
            this.log.info(`[hub] session dropped cam=${camId} reason=below-min duration=${duration}ms`);
            if (sess.rowId) {
                try { this.store.deleteSession(sess.rowId); } catch (_) { /* ignore */ }
            }
            if (sess.recorder && sess.recorder.absPath) {
                try { fs.unlinkSync(sess.recorder.absPath); } catch (_) { /* ignore */ }
            }
            return null;
        }

        if (sess.rowId) {
            try {
                this.store.finalizeSession({
                    id: sess.rowId,
                    endedAtMs: t,
                    detectionCount: sess.detectionCount,
                    maxConfidence: sess.maxConfidence,
                    clipPath,
                    metadata: { reason, framesWritten }
                });
            } catch (err) {
                this.log.warn(`[hub] store.finalizeSession failed for ${camId}: ${err && err.message}`);
            }
        }

        this.log.info(
            `[hub] session ended cam=${camId} id=${sess.rowId ?? "?"} ` +
            `duration=${duration}ms detections=${sess.detectionCount} reason=${reason} ` +
            `clip=${clipPath ?? "none"}`
        );
        return { rowId: sess.rowId, duration, clipPath, framesWritten };
    }

    _logEndError(err) {
        this.log.warn(`[hub] session end error: ${err && err.message}`);
    }
}

function clampNumber(n, lo, hi, fallback) {
    if (typeof n !== "number" || !isFinite(n)) return fallback;
    return Math.min(Math.max(n, lo), hi);
}

module.exports = { SessionManager };
