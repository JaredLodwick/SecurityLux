"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
    buildCoverage, resolveSeek, nextSegment, clampRange, buildTimeline, COVERAGE_JOIN_MS
} = require("../src/timeline");
const { parseSegmentStart, buildArgs } = require("../src/continuous");

const MIN = 60_000;

function segment(id, startMs, durationMs, extra = {}) {
    return {
        id,
        cam_id: "front",
        path: `continuous/front/day/${id}.mp4`,
        started_at_ms: startMs,
        ended_at_ms: startMs + durationMs,
        duration_ms: durationMs,
        bytes: 1000,
        protected: false,
        ...extra
    };
}

/** In-memory stand-in for the recordings half of Store. */
function makeStore(segments, events = []) {
    return {
        queryRecordings({ fromMs, toMs }) {
            return segments
                .filter((s) => {
                    const end = s.ended_at_ms || s.started_at_ms;
                    if (typeof toMs === "number" && s.started_at_ms > toMs) return false;
                    if (typeof fromMs === "number" && end < fromMs) return false;
                    return true;
                })
                .sort((a, b) => a.started_at_ms - b.started_at_ms);
        },
        recordingAt(camId, atMs) {
            return segments.find((s) =>
                s.started_at_ms <= atMs && (s.ended_at_ms || s.started_at_ms) >= atMs) || null;
        },
        getRecording(id) { return segments.find((s) => s.id === id) || null; },
        queryEvents() { return events; }
    };
}

// ---------------------------------------------------------------
//  Coverage
// ---------------------------------------------------------------

test("adjacent segments merge into one continuous run", () => {
    // 288 separate blocks for a day would be unreadable; what matters visually
    // is where the gaps are.
    const store = makeStore([
        segment(1, 0, 5 * MIN),
        segment(2, 5 * MIN, 5 * MIN),
        segment(3, 10 * MIN, 5 * MIN)
    ]);
    const runs = buildCoverage(store.queryRecordings({}));

    assert.equal(runs.length, 1);
    assert.equal(runs[0].from, 0);
    assert.equal(runs[0].to, 15 * MIN);
    assert.equal(runs[0].segments, 3);
});

test("a real gap splits the run", () => {
    const runs = buildCoverage([
        segment(1, 0, 5 * MIN),
        segment(2, 60 * MIN, 5 * MIN)      // an hour of nothing
    ]);
    assert.equal(runs.length, 2, "a camera outage must be visible, not smoothed over");
    assert.equal(runs[0].to, 5 * MIN);
    assert.equal(runs[1].from, 60 * MIN);
});

test("the muxer's few-millisecond seam is not treated as a gap", () => {
    const runs = buildCoverage([
        segment(1, 0, 5 * MIN),
        segment(2, 5 * MIN + 300, 5 * MIN)   // 300 ms later
    ]);
    assert.equal(runs.length, 1, `${COVERAGE_JOIN_MS} ms of slack should absorb this`);
});

test("a run containing saved footage is flagged", () => {
    const runs = buildCoverage([
        segment(1, 0, 5 * MIN),
        segment(2, 5 * MIN, 5 * MIN, { protected: true })
    ]);
    assert.equal(runs[0].protected, true);
});

test("zero-length segments are skipped", () => {
    const runs = buildCoverage([segment(1, 0, 0), segment(2, MIN, 5 * MIN)]);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].from, MIN);
});

// ---------------------------------------------------------------
//  Seeking
// ---------------------------------------------------------------

test("seeking maps an instant to a file and an offset", () => {
    const store = makeStore([segment(1, 1_000_000, 5 * MIN)]);
    const result = resolveSeek(store, { camId: "front", atMs: 1_000_000 + 90_000 });

    assert.equal(result.found, true);
    assert.equal(result.recording_id, 1);
    // Video time equals elapsed wall time within a segment — that equivalence
    // is what the fixed-rate frame pump exists to guarantee.
    assert.equal(result.offset_seconds, 90);
});

test("seeking to the very start of a segment is offset zero", () => {
    const store = makeStore([segment(1, 500_000, 5 * MIN)]);
    assert.equal(resolveSeek(store, { camId: "front", atMs: 500_000 }).offset_seconds, 0);
});

test("seeking into a gap reports the nearest footage instead of nothing", () => {
    // An empty player with no explanation is the worst possible answer here.
    const store = makeStore([
        segment(1, 0, 5 * MIN),
        segment(2, 60 * MIN, 5 * MIN)
    ]);
    const result = resolveSeek(store, { camId: "front", atMs: 30 * MIN });

    assert.equal(result.found, false);
    assert.ok(result.nearest, "should offer somewhere to jump to");
    assert.ok(result.nearest.gap_ms > 0);
});

test("seeking with no footage at all degrades cleanly", () => {
    const result = resolveSeek(makeStore([]), { camId: "front", atMs: Date.now() });
    assert.equal(result.found, false);
    assert.equal(result.nearest, null);
});

// ---------------------------------------------------------------
//  Continuing playback
// ---------------------------------------------------------------

test("playback rolls into the next segment", () => {
    const store = makeStore([segment(1, 0, 5 * MIN), segment(2, 5 * MIN, 5 * MIN)]);
    const next = nextSegment(store, 1);
    assert.ok(next);
    assert.equal(next.recording_id, 2);
});

test("playback stops at a real gap rather than jumping hours", () => {
    // Silently skipping three hours would make it look like continuous
    // footage when it isn't.
    const store = makeStore([segment(1, 0, 5 * MIN), segment(2, 180 * MIN, 5 * MIN)]);
    assert.equal(nextSegment(store, 1), null);
});

test("the last segment has no next", () => {
    assert.equal(nextSegment(makeStore([segment(1, 0, 5 * MIN)]), 1), null);
});

// ---------------------------------------------------------------
//  Windowing
// ---------------------------------------------------------------

test("range requests are bounded and normalised", () => {
    const backwards = clampRange(2000, 1000);
    assert.ok(backwards.fromMs < backwards.toMs, "reversed ranges are swapped");

    const huge = clampRange(0, Date.now());
    assert.ok(huge.toMs - huge.fromMs <= 32 * 86_400_000, "an unbounded range is capped");

    const defaulted = clampRange(undefined, undefined);
    assert.ok(defaulted.toMs - defaulted.fromMs === 86_400_000, "defaults to one day");
});

test("buildTimeline reports how much of the window has footage", () => {
    const dayStart = 1_700_000_000_000;
    const store = makeStore([
        segment(1, dayStart, 60 * MIN),
        segment(2, dayStart + 120 * MIN, 60 * MIN)
    ]);

    const timeline = buildTimeline(store, {
        camId: "front", fromMs: dayStart, toMs: dayStart + 24 * 60 * MIN
    });

    assert.equal(timeline.segments.length, 2);
    assert.equal(timeline.coverage.length, 2);
    assert.equal(timeline.covered_ms, 120 * MIN);
    // Two hours out of twenty-four.
    assert.ok(Math.abs(timeline.coverage_ratio - (2 / 24)) < 0.001);
});

test("buildTimeline survives an event store that throws", () => {
    // Events are decoration on the timeline; footage is the point. A broken
    // event query must not blank the whole view.
    const store = makeStore([segment(1, 0, 5 * MIN)]);
    store.queryEvents = () => { throw new Error("boom"); };

    const timeline = buildTimeline(store, { camId: "front", fromMs: 0, toMs: 10 * MIN });
    assert.equal(timeline.segments.length, 1);
    assert.deepEqual(timeline.events, []);
});

// ---------------------------------------------------------------
//  Segment filenames
// ---------------------------------------------------------------

test("segment filenames parse back to their start time", () => {
    const ms = parseSegmentStart("2026-08-12_14-32-05.mp4");
    assert.ok(ms !== null);

    const d = new Date(ms);
    assert.equal(d.getFullYear(), 2026);
    assert.equal(d.getMonth(), 7);        // August
    assert.equal(d.getDate(), 12);
    assert.equal(d.getHours(), 14);
    assert.equal(d.getMinutes(), 32);
    assert.equal(d.getSeconds(), 5);
});

test("filenames are parsed as local time, matching ffmpeg's -strftime", () => {
    // A UTC/local mix-up here would put every segment hours away from where the
    // scrub bar draws it, which would look like the timeline being broken.
    const ms = parseSegmentStart("2026-08-12_14-32-05.mp4");
    assert.equal(new Date(ms).getHours(), 14, "must be 14:32 local, not shifted");
});

test("unrecognised filenames are rejected rather than guessed at", () => {
    assert.equal(parseSegmentStart("not-a-segment.mp4"), null);
    assert.equal(parseSegmentStart("2026-08-12-rubbish.mp4"), null);
    assert.equal(parseSegmentStart(""), null);
});

test("ffmpeg is invoked with the flags the time mapping depends on", () => {
    const args = buildArgs({ fps: 8, crf: 32, segmentSeconds: 300, outPattern: "/tmp/x/%H.mp4" });
    const joined = args.join(" ");

    assert.match(joined, /-f segment/);
    assert.match(joined, /-segment_time 300/);
    assert.match(joined, /-framerate 8/, "input rate must match the pump rate");
    // Per-segment timestamps starting at zero are what make seeking a
    // subtraction rather than a lookup.
    assert.match(joined, /-reset_timestamps 1/);
    assert.match(joined, /-strftime 1/, "filenames carry the start time");
    assert.match(joined, /-crf 32/);

    // Without these, ffmpeg probes the input for ~5 s before opening the first
    // output file. Since -strftime names a segment for the moment it opens,
    // that would put the first segment's name 5 s after its first frame and
    // every seek into it would land 5 s off.
    assert.match(joined, /-analyzeduration 0/);
    assert.match(joined, /-probesize 32/);
});
