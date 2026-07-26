"use strict";

/**
 * Lightweight multi-object tracking and behaviour classification.
 *
 * The detector answers "is there a person in this frame". That is enough to
 * start and stop a recording, but not enough to say anything interesting: it
 * can't tell someone walking past the house from someone standing at your door
 * for four minutes, and those are very different events.
 *
 * So we thread detections together across ticks into *tracks*, and read
 * behaviour off the track's shape.
 *
 * ============================================================================
 *  Association
 * ============================================================================
 *
 * Greedy nearest-anchor matching, no Kalman filter, no Hungarian algorithm.
 * At a 2 Hz detector rate a walking person moves maybe 5% of the frame between
 * ticks while any two people are usually much further apart than that, so the
 * cheap approach is not meaningfully worse than the sophisticated one here — and
 * it costs microseconds on a hub that is also running a neural net.
 *
 * Anchors are bottom-centre (see zones.js): feet, not centre of mass.
 *
 * ============================================================================
 *  Behaviour
 * ============================================================================
 *
 *   passing     brief, and covered real ground        → walked past
 *   approaching box growing, heading at a door        → coming to the door
 *   present     been around a few seconds             → someone's there
 *   dwelling    a while, and not moving much          → standing there
 *   loitering   a long while                          → worth caring about
 *
 * The distinction that matters most is dwelling-vs-passing, because "moved a
 * lot" and "was here a while" are independent: someone pacing on the porch has
 * high path length but near-zero net displacement, and treating them as
 * "passing" would be wrong. That's why displacement (start-to-end distance) and
 * spread (positional variance) are tracked separately from path length.
 */

const DEFAULT_THRESHOLDS = {
    passingSeconds: 3,      // shorter than this and it might be a fly-by
    dwellSeconds: 10,
    loiterSeconds: 30,
    // Net start-to-end distance, as a fraction of frame width, that counts as
    // "went somewhere" rather than "milled around".
    passingDisplacement: 0.35,
    // Positional spread below this reads as standing still.
    stationarySpread: 0.06,
    // Bounding-box area growth ratio that reads as walking toward the camera.
    approachGrowth: 1.35
};

const MAX_TRACK_POINTS = 240;      // 2 min at 2 Hz; plenty for any description
const DEFAULT_MAX_MISSED_TICKS = 4;

/**
 * How far a person is allowed to have moved, in frame-widths per second.
 *
 * This has to be time-scaled rather than a flat per-tick distance. A doorway
 * camera might cover three metres of ground; someone walking briskly at 2 m/s
 * crosses two-thirds of that in a single 500 ms detector interval, and an
 * association radius that doesn't account for the gap would split them into a
 * string of one-tick tracks. That in turn destroys dwell time, so a person
 * walking past and a person standing still become indistinguishable — which is
 * the entire thing the tracker exists to tell apart.
 *
 * Scaling by elapsed time also means the radius widens correctly after missed
 * ticks, and stays correct if the detector rate is changed in settings.
 */
const DEFAULT_MAX_SPEED = 1.2;

/**
 * Absolute ceiling regardless of elapsed time. Past this, "the same person"
 * stops being a more plausible explanation than "a different person".
 */
const DEFAULT_MAX_MATCH_DISTANCE = 0.75;

let nextTrackId = 1;

function anchorOf(bbox) {
    return {
        x: clamp01(bbox.cx),
        y: clamp01(bbox.cy + (bbox.h || 0) / 2)
    };
}

function distance(a, b) {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy);
}

function clamp01(n) {
    if (!isFinite(n)) return 0;
    return Math.min(1, Math.max(0, n));
}

class Tracker {
    /**
     * @param {object} [opts]
     * @param {number} [opts.maxMatchDistance]  Normalized distance for association.
     * @param {number} [opts.maxMissedTicks]    Ticks a track survives unmatched.
     * @param {Function} [opts.now]             Time source override (tests).
     */
    constructor({ maxMatchDistance, maxSpeed, maxMissedTicks, now } = {}) {
        this.maxMatchDistance = maxMatchDistance ?? DEFAULT_MAX_MATCH_DISTANCE;
        this.maxSpeed = maxSpeed ?? DEFAULT_MAX_SPEED;
        this.maxMissedTicks = maxMissedTicks ?? DEFAULT_MAX_MISSED_TICKS;
        this.now = now || Date.now;
        this.tracks = new Map();     // trackId -> track
    }

    /**
     * Association radius for a track at time `t` — how far this person could
     * plausibly have moved since we last saw them. See DEFAULT_MAX_SPEED.
     */
    _matchRadius(track, t) {
        const elapsedSec = Math.max(0.05, (t - track.lastSeenAt) / 1000);
        return Math.min(this.maxSpeed * elapsedSec, this.maxMatchDistance);
    }

    /**
     * Feed one detector tick.
     *
     * @param {Array<{bbox: object, confidence: number}>} detections
     * @param {number} [ts]
     * @returns {{active: object[], ended: object[]}}
     */
    update(detections, ts) {
        // `??` not `||`: a timestamp of 0 is a legitimate value and must not
        // silently fall through to the wall clock.
        const t = (typeof ts === "number" && isFinite(ts)) ? ts : this.now();
        const dets = (detections || []).filter((d) => d && d.bbox);

        const unmatchedTracks = new Set(this.tracks.keys());
        const unmatchedDets = new Set(dets.map((_, i) => i));

        // Score every (track, detection) pair, then take them cheapest-first.
        // Sorting the whole candidate list before assigning avoids the classic
        // greedy failure where the first track in map order steals a detection
        // that was a much better fit for a later one.
        const pairs = [];
        for (const trackId of unmatchedTracks) {
            const track = this.tracks.get(trackId);
            const radius = this._matchRadius(track, t);
            for (const idx of unmatchedDets) {
                const d = distance(track.lastAnchor, anchorOf(dets[idx].bbox));
                if (d <= radius) pairs.push({ trackId, idx, d });
            }
        }
        pairs.sort((a, b) => a.d - b.d);

        for (const pair of pairs) {
            if (!unmatchedTracks.has(pair.trackId) || !unmatchedDets.has(pair.idx)) continue;
            unmatchedTracks.delete(pair.trackId);
            unmatchedDets.delete(pair.idx);
            this._extend(this.tracks.get(pair.trackId), dets[pair.idx], t);
        }

        for (const idx of unmatchedDets) this._begin(dets[idx], t);

        const ended = [];
        for (const trackId of unmatchedTracks) {
            const track = this.tracks.get(trackId);
            track.missedTicks += 1;
            if (track.missedTicks > this.maxMissedTicks) {
                this.tracks.delete(trackId);
                ended.push(track);
            }
        }

        return { active: [...this.tracks.values()], ended };
    }

    /** Close every open track — camera disconnected, session forced to end. */
    flush() {
        const all = [...this.tracks.values()];
        this.tracks.clear();
        return all;
    }

    /** The track that best represents what's happening: longest-lived. */
    primary() {
        let best = null;
        for (const track of this.tracks.values()) {
            if (!best || track.firstSeenAt < best.firstSeenAt) best = track;
        }
        return best;
    }

    get activeCount() {
        return this.tracks.size;
    }

    _begin(det, t) {
        const anchor = anchorOf(det.bbox);
        const track = {
            id: nextTrackId++,
            firstSeenAt: t,
            lastSeenAt: t,
            missedTicks: 0,
            points: [{ x: anchor.x, y: anchor.y, t }],
            lastAnchor: anchor,
            firstAnchor: anchor,
            firstArea: (det.bbox.w || 0) * (det.bbox.h || 0),
            lastArea: (det.bbox.w || 0) * (det.bbox.h || 0),
            maxArea: (det.bbox.w || 0) * (det.bbox.h || 0),
            maxConfidence: det.confidence || 0,
            detectionCount: 1,
            pathLength: 0,
            bbox: det.bbox,
            zoneVisits: []          // [{ name, kind, enteredAt, leftAt }]
        };
        this.tracks.set(track.id, track);
        return track;
    }

    _extend(track, det, t) {
        const anchor = anchorOf(det.bbox);
        track.pathLength += distance(track.lastAnchor, anchor);
        track.lastAnchor = anchor;
        track.lastSeenAt = t;
        track.missedTicks = 0;
        track.detectionCount += 1;
        track.bbox = det.bbox;
        const area = (det.bbox.w || 0) * (det.bbox.h || 0);
        track.lastArea = area;
        if (area > track.maxArea) track.maxArea = area;
        if ((det.confidence || 0) > track.maxConfidence) track.maxConfidence = det.confidence;

        track.points.push({ x: anchor.x, y: anchor.y, t });
        if (track.points.length > MAX_TRACK_POINTS) {
            // Drop from the middle rather than the front: the start of the track
            // is what tells us where someone came from, and that's the part a
            // description needs most.
            track.points.splice(Math.floor(track.points.length / 2), 1);
        }
    }

    /**
     * Record which zone a track is in at this moment, collapsing consecutive
     * ticks in the same zone into a single visit.
     */
    noteZone(track, zone, t) {
        if (!track) return;
        const last = track.zoneVisits[track.zoneVisits.length - 1];
        if (!zone) {
            if (last && !last.leftAt) last.leftAt = t;
            return;
        }
        if (last && !last.leftAt && last.name === zone.name) return;
        if (last && !last.leftAt) last.leftAt = t;
        track.zoneVisits.push({
            name: zone.name,
            kind: zone.kind,
            enteredAt: t,
            leftAt: null
        });
    }
}

/**
 * Positional spread — root-mean-square distance from the mean anchor.
 * Distinguishes "standing on the porch" from "walked the length of the drive"
 * in a way that total path length cannot, because pacing inflates path length
 * while leaving spread small.
 */
function spreadOf(points) {
    if (!points || points.length < 2) return 0;
    let sx = 0;
    let sy = 0;
    for (const p of points) { sx += p.x; sy += p.y; }
    const mx = sx / points.length;
    const my = sy / points.length;
    let acc = 0;
    for (const p of points) {
        const dx = p.x - mx;
        const dy = p.y - my;
        acc += dx * dx + dy * dy;
    }
    return Math.sqrt(acc / points.length);
}

/**
 * Classify a track's behaviour.
 *
 * @param {object} track
 * @param {object} [thresholds]  Overrides for DEFAULT_THRESHOLDS.
 * @param {number} [asOf]        Evaluate as of this time (defaults to last seen).
 * @returns {{behavior: string, durationMs: number, displacement: number,
 *            spread: number, pathLength: number, stationary: boolean,
 *            approaching: boolean, direction: string|null}}
 */
function classifyTrack(track, thresholds, asOf) {
    const cfg = { ...DEFAULT_THRESHOLDS, ...(thresholds || {}) };
    const end = (typeof asOf === "number" && isFinite(asOf)) ? asOf : track.lastSeenAt;
    const durationMs = Math.max(0, end - track.firstSeenAt);
    const seconds = durationMs / 1000;

    const displacement = distance(track.firstAnchor, track.lastAnchor);
    const spread = spreadOf(track.points);
    const stationary = spread < cfg.stationarySpread;
    const growth = track.firstArea > 0 ? track.lastArea / track.firstArea : 1;
    const approaching = growth >= cfg.approachGrowth;

    let behavior;
    if (seconds >= cfg.loiterSeconds) {
        behavior = "loitering";
    } else if (seconds >= cfg.dwellSeconds && stationary) {
        behavior = "dwelling";
    } else if (seconds >= cfg.dwellSeconds) {
        behavior = "present";
    } else if (seconds < cfg.passingSeconds && displacement >= cfg.passingDisplacement) {
        behavior = "passing";
    } else if (approaching) {
        behavior = "approaching";
    } else if (seconds >= cfg.passingSeconds) {
        behavior = "present";
    } else {
        behavior = "passing";
    }

    return {
        behavior,
        durationMs,
        displacement,
        spread,
        pathLength: track.pathLength,
        stationary,
        approaching,
        direction: directionOf(track)
    };
}

/**
 * Coarse travel direction, or null when the subject didn't really go anywhere.
 * Only horizontal/vertical dominance — enough for "walked left to right", and
 * anything finer would over-promise given a 2 Hz sample rate.
 */
function directionOf(track) {
    const dx = track.lastAnchor.x - track.firstAnchor.x;
    const dy = track.lastAnchor.y - track.firstAnchor.y;
    if (Math.abs(dx) < 0.12 && Math.abs(dy) < 0.12) return null;
    if (Math.abs(dx) >= Math.abs(dy)) return dx > 0 ? "right" : "left";
    // Larger y is lower in the frame, which is nearer the camera.
    return dy > 0 ? "toward" : "away";
}

/**
 * LED escalation stage, 0-4, derived from the same thresholds.
 *
 * Kept alongside the behaviour classifier rather than in the LED code so the
 * light and the event description can never disagree about what is happening.
 */
function ledStageFor(behavior) {
    switch (behavior) {
        case "loitering": return 4;
        case "dwelling": return 3;
        case "present": return 2;
        case "approaching": return 2;
        case "passing": return 1;
        default: return 0;
    }
}

module.exports = {
    Tracker,
    classifyTrack,
    spreadOf,
    directionOf,
    ledStageFor,
    DEFAULT_THRESHOLDS,
    DEFAULT_MAX_SPEED,
    DEFAULT_MAX_MATCH_DISTANCE
};
