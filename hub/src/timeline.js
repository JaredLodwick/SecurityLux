"use strict";

/**
 * Timeline assembly — turning stored segments into something scrubbable.
 *
 * The UI needs three things to draw a DVR timeline and seek in it:
 *
 *   1. Where footage exists (and, just as importantly, where it doesn't).
 *   2. Where events happened, so you can jump to the interesting parts.
 *   3. Given an instant, which file to load and how far into it to seek.
 *
 * ============================================================================
 *  Why seeking is arithmetic rather than a search
 * ============================================================================
 *
 * The recorder emits frames at a fixed rate and starts every segment's
 * timestamps at zero, so video time inside a segment equals elapsed wall-clock
 * time since that segment began. Seeking to an instant is therefore just
 * `(wanted - segment.started_at_ms) / 1000` seconds into the file — no index,
 * no probing, no per-frame timestamp table.
 *
 * That property is the reason `continuous.js` pays to repeat frames when a
 * camera goes quiet. Everything here depends on it holding.
 */

/** Segments closer together than this are drawn as one continuous run. */
const COVERAGE_JOIN_MS = 2000;

/** Guard against a request for a decade of timeline in one go. */
const MAX_RANGE_MS = 32 * 86_400_000;

/**
 * Everything needed to render a timeline for one camera over a window.
 *
 * @param {object} store
 * @param {object} opts
 * @param {string} opts.camId
 * @param {number} opts.fromMs
 * @param {number} opts.toMs
 * @returns {{cam_id, from_ms, to_ms, segments, coverage, events, total_bytes, covered_ms}}
 */
function buildTimeline(store, { camId, fromMs, toMs }) {
    const range = clampRange(fromMs, toMs);

    const segments = store.queryRecordings({
        camId, fromMs: range.fromMs, toMs: range.toMs
    });

    // Events are drawn as markers on the same axis, which is what makes the
    // timeline useful rather than just a long grey bar: you scrub to the marks.
    let events = [];
    try {
        events = store.queryEvents({
            camId, sinceMs: range.fromMs - 1, untilMs: range.toMs + 1, limit: 500
        });
    } catch (_) {
        events = [];
    }

    const coverage = buildCoverage(segments);
    const coveredMs = coverage.reduce((sum, run) => sum + (run.to - run.from), 0);

    return {
        cam_id: camId,
        from_ms: range.fromMs,
        to_ms: range.toMs,
        segments: segments.map(toSegmentSummary),
        coverage,
        events: events.map(toEventMarker),
        total_bytes: segments.reduce((sum, s) => sum + (s.bytes || 0), 0),
        covered_ms: coveredMs,
        // What fraction of the window actually has footage. A number people can
        // sanity-check against "was my camera up yesterday?".
        coverage_ratio: range.toMs > range.fromMs
            ? Math.min(1, coveredMs / (range.toMs - range.fromMs))
            : 0
    };
}

/**
 * Merge adjacent segments into runs of continuous footage.
 *
 * Drawing 288 individual five-minute blocks for a day would be both slow and
 * unreadable; what matters visually is where the gaps are. Segments within
 * COVERAGE_JOIN_MS of each other are treated as one run, because the muxer
 * leaves a few milliseconds between files and those are not real gaps.
 */
function buildCoverage(segments) {
    const runs = [];
    for (const segment of segments) {
        const from = segment.started_at_ms;
        const to = segment.ended_at_ms || segment.started_at_ms;
        if (to <= from) continue;

        const last = runs[runs.length - 1];
        if (last && from - last.to <= COVERAGE_JOIN_MS) {
            last.to = Math.max(last.to, to);
            last.segments += 1;
            if (segment.protected) last.protected = true;
        } else {
            runs.push({ from, to, segments: 1, protected: !!segment.protected });
        }
    }
    return runs;
}

/**
 * Resolve an instant to a file and an offset.
 *
 * Returns `nearest` when nothing covers the instant, so the UI can say "no
 * footage here, the closest is 20 minutes later" and offer to jump — much more
 * useful than an empty player.
 */
function resolveSeek(store, { camId, atMs }) {
    const segment = store.recordingAt(camId, atMs);
    if (segment) {
        const offsetMs = Math.max(0, atMs - segment.started_at_ms);
        return {
            found: true,
            recording_id: segment.id,
            path: segment.path,
            started_at_ms: segment.started_at_ms,
            ended_at_ms: segment.ended_at_ms,
            protected: segment.protected,
            // Video time equals elapsed wall-clock time within a segment; see
            // the header for why that holds.
            offset_seconds: Math.round((offsetMs / 1000) * 100) / 100
        };
    }

    const nearest = findNearest(store, camId, atMs);
    return {
        found: false,
        nearest: nearest
            ? {
                recording_id: nearest.id,
                started_at_ms: nearest.started_at_ms,
                gap_ms: nearest.started_at_ms > atMs
                    ? nearest.started_at_ms - atMs
                    : atMs - (nearest.ended_at_ms || nearest.started_at_ms)
            }
            : null
    };
}

/** Closest segment either side of an instant. */
function findNearest(store, camId, atMs) {
    const window = 12 * 3_600_000;
    const candidates = store.queryRecordings({
        camId, fromMs: atMs - window, toMs: atMs + window, limit: 2000
    });
    if (!candidates.length) return null;

    let best = null;
    let bestDistance = Infinity;
    for (const segment of candidates) {
        const end = segment.ended_at_ms || segment.started_at_ms;
        const distance = atMs < segment.started_at_ms
            ? segment.started_at_ms - atMs
            : (atMs > end ? atMs - end : 0);
        if (distance < bestDistance) { best = segment; bestDistance = distance; }
    }
    return best;
}

/**
 * The segment that follows one, if playback should roll on into it.
 *
 * Only returns a neighbour that starts within COVERAGE_JOIN_MS, so playback
 * stops at a real gap rather than silently jumping across three hours of
 * missing footage as though nothing happened.
 */
function nextSegment(store, recordingId) {
    const current = store.getRecording(recordingId);
    if (!current) return null;

    const end = current.ended_at_ms || current.started_at_ms;
    const following = store.queryRecordings({
        camId: current.cam_id, fromMs: end, toMs: end + COVERAGE_JOIN_MS + 1000, limit: 5
    });

    for (const segment of following) {
        if (segment.id === current.id) continue;
        if (segment.started_at_ms - end <= COVERAGE_JOIN_MS) {
            return { recording_id: segment.id, started_at_ms: segment.started_at_ms };
        }
    }
    return null;
}

function clampRange(fromMs, toMs) {
    let from = Number(fromMs);
    let to = Number(toMs);
    if (!isFinite(to)) to = Date.now();
    if (!isFinite(from)) from = to - 86_400_000;
    if (from > to) [from, to] = [to, from];
    if (to - from > MAX_RANGE_MS) from = to - MAX_RANGE_MS;
    return { fromMs: from, toMs: to };
}

function toSegmentSummary(segment) {
    return {
        id: segment.id,
        started_at_ms: segment.started_at_ms,
        ended_at_ms: segment.ended_at_ms,
        duration_ms: segment.duration_ms,
        bytes: segment.bytes,
        protected: segment.protected,
        label: segment.label
    };
}

function toEventMarker(event) {
    return {
        id: event.id,
        type: event.type,
        behavior: event.behavior,
        started_at_ms: event.started_at_ms,
        duration_ms: event.duration_ms,
        description: event.description,
        has_thumb: !!event.thumb_path
    };
}

module.exports = {
    buildTimeline,
    buildCoverage,
    resolveSeek,
    nextSegment,
    clampRange,
    COVERAGE_JOIN_MS,
    MAX_RANGE_MS
};
