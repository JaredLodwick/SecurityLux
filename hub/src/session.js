"use strict";

/**
 * Per-camera session state machine.
 *
 *   idle   --(person detected)-----> active   { row inserted, recorder spawned }
 *   active --(person detected)----> active    { grace reset, track extended }
 *   active --(no person)----------> active    { grace counting down }
 *   active --(grace expired)------> idle      { row finalized, post-roll runs on }
 *   active --(max length hit)-----> idle      { split into a new clip }
 *   active --(forceEnd)-----------> idle      { finalized or dropped }
 *
 * ============================================================================
 *  What changed from the original
 * ============================================================================
 *
 * 1. Sessions no longer end the recorder. `_endSession` finalizes the event row
 *    immediately and hands the recorder to `beginPostRoll()`, which keeps
 *    writing for a few more seconds. Separating "the event is over" from "stop
 *    writing video" is what lets a clip show someone walking away, and it stops
 *    the DB write from waiting on ffmpeg.
 *
 * 2. Observations are now a list of boxes, not a boolean. They go through a
 *    Tracker so we can tell someone walking past from someone standing still,
 *    and through the camera's zones so we can say *where*.
 *
 * 3. Behaviour is re-classified on every tick, not just at the end, because the
 *    door light has to escalate live while someone is still standing there.
 *
 * Sessions shorter than `minClipSeconds` are dropped so a single-frame false
 * positive doesn't litter the log.
 */

const { Tracker, classifyTrack, ledStageFor } = require("./tracker");
const { isIgnored, primaryZone } = require("./zones");
const { describeEvent } = require("./describe");

class SessionManager {
    /**
     * @param {object} opts
     * @param {object} opts.store
     * @param {object} opts.settings                SettingsService.
     * @param {string} opts.clipsRoot
     * @param {Function} opts.recorderFactory       `(cam, opts) => Recorder` (injected for tests).
     * @param {Function} opts.getCam                `(camId) => cam record`.
     * @param {Function} [opts.getZones]            `(camId) => zone[]`.
     * @param {object} [opts.storage]               StorageManager; gates recording when disk is low.
     * @param {Function} [opts.onBehaviorChange]    `(camId, state)` — drives the door light.
     * @param {Function} [opts.onEventFinalized]    `(event)` — drives the webhook.
     * @param {object} [opts.logger]
     * @param {Function} [opts.now]                 Time source override (tests).
     */
    constructor({
        store, settings, clipsRoot, recorderFactory, getCam, getZones,
        storage, onBehaviorChange, onEventFinalized, logger, now
    }) {
        if (!store) throw new Error("SessionManager: store is required");
        if (!settings) throw new Error("SessionManager: settings is required");
        if (typeof recorderFactory !== "function") throw new Error("SessionManager: recorderFactory is required");
        if (typeof getCam !== "function") throw new Error("SessionManager: getCam is required");

        this.store = store;
        this.settings = settings;
        this.clipsRoot = clipsRoot;
        this.recorderFactory = recorderFactory;
        this.getCam = getCam;
        this.getZones = getZones || (() => []);
        this.storage = storage || null;
        this.onBehaviorChange = onBehaviorChange || (() => {});
        this.onEventFinalized = onEventFinalized || (() => {});
        this.log = logger || console;
        this.now = now || Date.now;

        this.sessions = new Map();     // camId -> session state
        this.trackers = new Map();     // camId -> Tracker
        this.behaviors = new Map();    // camId -> last emitted behavior state

        // Ends triggered by the grace window fire from inside `observe()`,
        // which is synchronous — so their async tail (stopping the recorder,
        // unlinking a discarded clip, finalizing the row) has no caller to
        // await it. Tracking them here means `drain()` can, which matters on
        // shutdown: otherwise the hub can exit part-way through cleanup.
        this._pendingEnds = new Set();
    }

    /**
     * Resolve once every in-flight session teardown has finished.
     * Called by `forceEndAll`, and useful for deterministic tests.
     */
    async drain() {
        while (this._pendingEnds.size) {
            await Promise.allSettled([...this._pendingEnds]);
        }
    }

    /** Run an end and keep hold of it until it settles. */
    _trackEnd(promise) {
        this._pendingEnds.add(promise);
        promise
            .catch(this._logEndError.bind(this))
            .finally(() => this._pendingEnds.delete(promise));
        return promise;
    }

    _tracker(camId) {
        let tracker = this.trackers.get(camId);
        if (!tracker) {
            tracker = new Tracker({ now: this.now });
            this.trackers.set(camId, tracker);
        }
        return tracker;
    }

    /** Behaviour thresholds, resolved per camera. Shared with the door light. */
    _thresholds(camId) {
        return {
            passingSeconds: this.settings.get("led.passingSeconds", camId),
            dwellSeconds: this.settings.get("led.dwellSeconds", camId),
            loiterSeconds: this.settings.get("led.loiterSeconds", camId)
        };
    }

    /**
     * Feed one detector tick.
     *
     * Called on *every* tick, including empty ones — the empty ticks are what
     * drive the grace countdown and let the light de-escalate.
     *
     * @param {string} camId
     * @param {Array<{bbox: object, confidence: number}>} detections
     */
    observe(camId, detections) {
        const t = this.now();
        const zones = this.getZones(camId) || [];

        // Drop anything anchored solely inside an `ignore` zone before it can
        // start a session. This is the release valve for the recurring false
        // positive — a swaying branch, a neighbour's window, passing traffic.
        const kept = (detections || []).filter((d) => d && d.bbox && !isIgnored(zones, d.bbox));

        const tracker = this._tracker(camId);
        const { active } = tracker.update(kept, t);

        // Attribute each track to a zone so the description can say where.
        for (const track of active) {
            tracker.noteZone(track, primaryZone(zones, track.bbox), t);
        }

        const primary = tracker.primary();
        const state = primary
            ? classifyTrack(primary, this._thresholds(camId), t)
            : null;

        // Presence is "did we see someone in *this* frame", not "is a track
        // still open". Tracks deliberately survive a few missed ticks so a
        // momentary detector miss doesn't split one person into two — but
        // treating that as presence would refresh the grace timer on every
        // empty tick, and the session would only ever end by hitting the
        // maximum clip length.
        const hasPerson = kept.length > 0;

        this._emitBehavior(camId, hasPerson ? state : null, kept.length);

        const sess = this.sessions.get(camId);
        if (!sess) {
            if (hasPerson) this._startSession(camId, t, primary, active.length);
            return;
        }

        if (hasPerson) {
            sess.lastPersonAt = t;
            sess.detectionCount += 1;
            sess.peakPersonCount = Math.max(sess.peakPersonCount, active.length);
            if (primary) {
                sess.track = primary;
                sess.classification = state;
                if (state && primary.maxConfidence > sess.maxConfidence) {
                    sess.maxConfidence = primary.maxConfidence;
                }
            }
        }

        const maxClipMs = this.settings.get("recording.maxClipSeconds", camId) * 1000;
        if (t - sess.startedAt >= maxClipMs) {
            this._trackEnd(this._endSession(camId, t, "max-length"));
            return;
        }

        const graceMs = this.settings.get("recording.graceMs", camId);
        if (t - sess.lastPersonAt >= graceMs) {
            this._trackEnd(this._endSession(camId, t, "grace-expired"));
        }
    }

    /**
     * Notify the door light when the escalation stage changes.
     *
     * Stage rather than raw behaviour, and only on change, so a camera watching
     * someone stand still for four minutes sends one message instead of 480.
     */
    _emitBehavior(camId, state, personCount) {
        const stage = state ? ledStageFor(state.behavior) : 0;
        const prev = this.behaviors.get(camId);
        if (prev && prev.stage === stage) return;

        const next = {
            stage,
            behavior: state ? state.behavior : "idle",
            personCount: personCount || 0,
            at: this.now()
        };
        this.behaviors.set(camId, next);
        try {
            this.onBehaviorChange(camId, next);
        } catch (err) {
            this.log.warn(`[hub] onBehaviorChange threw: ${err && err.message}`);
        }
    }

    /** End any active session immediately (camera disconnect, shutdown). */
    async forceEnd(camId, reason) {
        const tracker = this.trackers.get(camId);
        if (tracker) tracker.flush();
        this._emitBehavior(camId, null, 0);
        if (!this.sessions.has(camId)) {
            // Nothing open, but an earlier grace-triggered end may still be
            // finishing its cleanup — wait for it so callers get a settled state.
            await this.drain();
            return null;
        }
        const result = await this._trackEnd(
            this._endSession(camId, this.now(), reason || "force-end")
        );
        await this.drain();
        return result;
    }

    async forceEndAll(reason) {
        const ids = [...this.sessions.keys()];
        await Promise.all(ids.map((id) => this.forceEnd(id, reason)));
        await this.drain();
    }

    isActive(camId) {
        return this.sessions.has(camId);
    }

    /** Live behaviour, for the status endpoint and the dashboard. */
    behaviorFor(camId) {
        return this.behaviors.get(camId) || null;
    }

    _startSession(camId, t, track, personCount) {
        const cam = this.getCam(camId);
        if (!cam) return;

        const recordingOn = this.settings.get("recording.enabled", camId);
        const diskOk = !this.storage || this.storage.canRecord();

        let recorder = null;
        if (recordingOn && diskOk) {
            try {
                recorder = this.recorderFactory(cam, {
                    recordingCfg: this._recordingCfg(camId),
                    clipsRoot: this.clipsRoot,
                    frameBuffer: cam.frameBuffer || null,
                    startedAt: new Date(t),
                    eventType: "person",
                    logger: this.log
                });
                recorder.start();
            } catch (err) {
                this.log.warn(`[hub] recorder failed to start for ${camId}: ${err && err.message}`);
                recorder = null;
            }
        }

        const skipReason = !recordingOn ? "recording-disabled"
            : !diskOk ? "storage-paused"
            : null;

        let rowId = null;
        try {
            rowId = this.store.insertSession({
                camId,
                type: "person",
                startedAtMs: t,
                metadata: skipReason ? { clipSkipped: skipReason } : null
            });
        } catch (err) {
            this.log.warn(`[hub] store.insertSession failed for ${camId}: ${err && err.message}`);
        }

        this.sessions.set(camId, {
            rowId,
            recorder,
            startedAt: t,
            lastPersonAt: t,
            detectionCount: 1,
            peakPersonCount: personCount || 1,
            maxConfidence: track ? track.maxConfidence : 0,
            track: track || null,
            classification: null
        });

        // Thumbnails are written from the pre-roll buffer, so this can happen
        // the moment the session opens rather than waiting for the clip.
        if (recorder && rowId) {
            recorder.writeThumbnail().then((rel) => {
                if (rel) {
                    try { this.store.setThumb(rowId, rel); } catch (_) { /* non-fatal */ }
                }
            }).catch(() => { /* logged inside */ });
        }

        this.log.info(
            `[hub] session started cam=${camId} id=${rowId ?? "?"}` +
            (skipReason ? ` (no clip: ${skipReason})` : "")
        );
    }

    _recordingCfg(camId) {
        return {
            codec: this.settings.get("recording.codec", camId),
            crf: this.settings.get("recording.crf", camId),
            fps: this.settings.get("recording.fps", camId),
            preRollSeconds: this.settings.get("recording.preRollSeconds", camId),
            postRollSeconds: this.settings.get("recording.postRollSeconds", camId),
            thumbnails: this.settings.get("recording.thumbnails", camId)
        };
    }

    async _endSession(camId, t, reason) {
        const sess = this.sessions.get(camId);
        if (!sess) return null;
        // Remove first so a concurrent observe() can't re-trigger the end.
        this.sessions.delete(camId);

        const duration = t - sess.startedAt;
        const minClipMs = this.settings.get("recording.minClipSeconds", camId) * 1000;

        if (duration < minClipMs) {
            this.log.info(`[hub] session dropped cam=${camId} reason=below-min duration=${duration}ms`);
            if (sess.recorder) {
                // Stop hard — no post-roll on something we're about to delete.
                try {
                    const res = await sess.recorder.stop();
                    await this._unlink(res.absPath);
                    await this._unlinkRel(res.thumbRelPath);
                } catch (_) { /* ignore */ }
            }
            if (sess.rowId) {
                try { this.store.deleteSession(sess.rowId); } catch (_) { /* ignore */ }
            }
            return null;
        }

        const classification = sess.classification
            || (sess.track ? classifyTrack(sess.track, this._thresholds(camId), t) : null);
        const description = this._describe(camId, sess, classification, duration);

        // Finalize the row now, with what we know. The clip path is already
        // determined at spawn time, so waiting for ffmpeg would delay the event
        // appearing in the UI for no benefit.
        if (sess.rowId) {
            try {
                this.store.finalizeSession({
                    id: sess.rowId,
                    endedAtMs: t,
                    detectionCount: sess.detectionCount,
                    maxConfidence: sess.maxConfidence,
                    clipPath: sess.recorder ? sess.recorder.relPath : null,
                    thumbPath: sess.recorder ? sess.recorder.thumbRelPath : null,
                    clipBytes: null,
                    description,
                    behavior: classification ? classification.behavior : null,
                    zones: sess.track ? sess.track.zoneVisits : null,
                    track: sess.track ? summarizeTrack(sess.track, classification) : null,
                    metadata: { reason, peakPersonCount: sess.peakPersonCount }
                });
            } catch (err) {
                this.log.warn(`[hub] store.finalizeSession failed for ${camId}: ${err && err.message}`);
            }
        }

        this.log.info(
            `[hub] session ended cam=${camId} id=${sess.rowId ?? "?"} duration=${duration}ms ` +
            `behavior=${classification ? classification.behavior : "?"} reason=${reason}`
        );

        // Post-roll runs unawaited: the event is already visible in the UI, and
        // the clip's true byte size gets patched in when ffmpeg finishes.
        if (sess.recorder) {
            sess.recorder.beginPostRoll()
                .then((res) => this._afterClip(sess.rowId, res))
                .catch((err) => this.log.warn(`[hub] post-roll failed: ${err && err.message}`));
        }

        if (sess.rowId) {
            try {
                const event = this.store.getEvent(sess.rowId);
                if (event) this.onEventFinalized(event);
            } catch (_) { /* non-fatal */ }
        }

        return { rowId: sess.rowId, duration, description, behavior: classification?.behavior };
    }

    _describe(camId, sess, classification, duration) {
        try {
            return describeEvent({
                camId,
                friendlyName: this.settings.get("events.friendlyName", camId) || null,
                behavior: classification ? classification.behavior : "present",
                durationMs: duration,
                startedAtMs: sess.startedAt,
                zoneVisits: sess.track ? sess.track.zoneVisits : [],
                direction: classification ? classification.direction : null,
                personCount: sess.peakPersonCount,
                latitude: this.settings.get("system.latitude"),
                longitude: this.settings.get("system.longitude")
            });
        } catch (err) {
            this.log.warn(`[hub] describe failed for ${camId}: ${err && err.message}`);
            return null;
        }
    }

    /** Patch the real file size in once ffmpeg has finalized the container. */
    async _afterClip(rowId, result) {
        if (!rowId || !result) return;
        try {
            this.store.finalizeClipStats(rowId, {
                clipBytes: result.bytes,
                framesWritten: result.framesWritten,
                preRollFrames: result.preRollFrames
            });
        } catch (err) {
            this.log.warn(`[hub] clip stats update failed: ${err && err.message}`);
        }
        if (this.storage) {
            this.storage.sweep().catch(() => { /* logged inside */ });
        }
    }

    async _unlink(absPath) {
        if (!absPath) return;
        try {
            // eslint-disable-next-line global-require
            await require("node:fs/promises").unlink(absPath);
        } catch (_) { /* already gone */ }
    }

    async _unlinkRel(relPath) {
        if (!relPath || !this.storage) return;
        const abs = this.storage.resolveClipPath(relPath);
        await this._unlink(abs);
    }

    _logEndError(err) {
        this.log.warn(`[hub] session end error: ${err && err.message}`);
    }
}

/** Compact track summary for the event row — enough to redescribe later. */
function summarizeTrack(track, classification) {
    return {
        id: track.id,
        firstSeenAt: track.firstSeenAt,
        lastSeenAt: track.lastSeenAt,
        detectionCount: track.detectionCount,
        pathLength: round3(track.pathLength),
        from: { x: round3(track.firstAnchor.x), y: round3(track.firstAnchor.y) },
        to: { x: round3(track.lastAnchor.x), y: round3(track.lastAnchor.y) },
        direction: classification ? classification.direction : null,
        displacement: classification ? round3(classification.displacement) : null,
        spread: classification ? round3(classification.spread) : null
    };
}

function round3(n) {
    return typeof n === "number" && isFinite(n) ? Math.round(n * 1000) / 1000 : null;
}

module.exports = { SessionManager, summarizeTrack };
