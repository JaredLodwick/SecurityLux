"use strict";

const test = require("node:test");
const assert = require("node:assert");

const { Tracker, classifyTrack, spreadOf, directionOf, ledStageFor } = require("../src/tracker");

/** A detection whose bottom-centre anchor lands at (x, y). */
function person(x, y, { w = 0.12, h = 0.4, confidence = 0.8 } = {}) {
    return { bbox: { cx: x, cy: y - h / 2, w, h }, confidence };
}

const THRESHOLDS = { passingSeconds: 3, dwellSeconds: 10, loiterSeconds: 30 };

test("keeps one person as a single track across ticks", () => {
    const tracker = new Tracker();
    tracker.update([person(0.2, 0.8)], 1000);
    tracker.update([person(0.25, 0.8)], 1500);
    const { active } = tracker.update([person(0.3, 0.8)], 2000);

    assert.strictEqual(active.length, 1);
    assert.strictEqual(active[0].detectionCount, 3);
});

test("keeps two people apart", () => {
    const tracker = new Tracker();
    tracker.update([person(0.2, 0.8), person(0.8, 0.8)], 1000);
    const { active } = tracker.update([person(0.22, 0.8), person(0.78, 0.8)], 1500);

    assert.strictEqual(active.length, 2);
    for (const track of active) assert.strictEqual(track.detectionCount, 2);
});

test("assigns detections to their nearest track, not to whichever comes first", () => {
    // Greedy-in-map-order would give track A the detection meant for B.
    const tracker = new Tracker();
    tracker.update([person(0.30, 0.8), person(0.60, 0.8)], 1000);
    const { active } = tracker.update([person(0.62, 0.8), person(0.32, 0.8)], 1500);

    assert.strictEqual(active.length, 2, "no track should have been dropped or duplicated");
    for (const track of active) {
        assert.strictEqual(track.detectionCount, 2, "both tracks should have been extended");
    }
});

test("ends a track after it goes unmatched for long enough", () => {
    const tracker = new Tracker({ maxMissedTicks: 2 });
    tracker.update([person(0.5, 0.8)], 1000);

    assert.strictEqual(tracker.update([], 1500).ended.length, 0);
    assert.strictEqual(tracker.update([], 2000).ended.length, 0);
    assert.strictEqual(tracker.update([], 2500).ended.length, 1);
    assert.strictEqual(tracker.activeCount, 0);
});

test("a teleport starts a new track rather than stretching the old one", () => {
    const tracker = new Tracker({ maxMatchDistance: 0.2 });
    tracker.update([person(0.1, 0.8)], 1000);
    const { active } = tracker.update([person(0.9, 0.8)], 1500);

    assert.strictEqual(active.length, 2);
});

test("classifies a quick traverse as passing", () => {
    const tracker = new Tracker();
    tracker.update([person(0.05, 0.8)], 0);
    tracker.update([person(0.45, 0.8)], 800);
    tracker.update([person(0.9, 0.8)], 1600);

    const result = classifyTrack(tracker.primary(), THRESHOLDS);
    assert.strictEqual(result.behavior, "passing");
    assert.ok(result.displacement > 0.35);
});

test("classifies standing still for 15s as dwelling", () => {
    const tracker = new Tracker();
    for (let t = 0; t <= 15_000; t += 500) {
        // A pixel or two of jitter, as a real detector produces.
        tracker.update([person(0.5 + (t % 1000 ? 0.004 : -0.004), 0.8)], t);
    }

    const result = classifyTrack(tracker.primary(), THRESHOLDS);
    assert.strictEqual(result.behavior, "dwelling");
    assert.strictEqual(result.stationary, true);
});

test("classifies 40s as loitering regardless of movement", () => {
    const tracker = new Tracker();
    for (let t = 0; t <= 40_000; t += 500) {
        tracker.update([person(0.3 + 0.3 * Math.sin(t / 3000), 0.8)], t);
    }

    const result = classifyTrack(tracker.primary(), THRESHOLDS);
    assert.strictEqual(result.behavior, "loitering");
});

test("pacing is not mistaken for passing", () => {
    // High path length, near-zero net displacement — the case that motivates
    // tracking spread separately from distance travelled.
    const tracker = new Tracker();
    for (let t = 0; t <= 14_000; t += 500) {
        tracker.update([person(0.5 + 0.1 * Math.sin(t / 800), 0.8)], t);
    }

    const track = tracker.primary();
    const result = classifyTrack(track, THRESHOLDS);
    assert.ok(track.pathLength > 0.5, "should have covered real ground");
    assert.ok(result.displacement < 0.2, "but ended up where it started");
    assert.notStrictEqual(result.behavior, "passing");
});

test("detects approach from a growing bounding box", () => {
    const tracker = new Tracker();
    tracker.update([{ bbox: { cx: 0.5, cy: 0.5, w: 0.08, h: 0.22 }, confidence: 0.7 }], 0);
    tracker.update([{ bbox: { cx: 0.5, cy: 0.55, w: 0.14, h: 0.42 }, confidence: 0.9 }], 1500);

    const result = classifyTrack(tracker.primary(), THRESHOLDS);
    assert.strictEqual(result.approaching, true);
});

test("reports coarse travel direction", () => {
    const rightward = new Tracker();
    rightward.update([person(0.1, 0.8)], 0);
    rightward.update([person(0.8, 0.8)], 1000);
    assert.strictEqual(directionOf(rightward.primary()), "right");

    const nearer = new Tracker();
    nearer.update([person(0.5, 0.3)], 0);
    nearer.update([person(0.5, 0.9)], 1000);
    assert.strictEqual(directionOf(nearer.primary()), "toward");

    const still = new Tracker();
    still.update([person(0.5, 0.8)], 0);
    still.update([person(0.52, 0.8)], 1000);
    assert.strictEqual(directionOf(still.primary()), null, "jitter is not a direction");
});

test("records zone visits without repeating the current zone", () => {
    const tracker = new Tracker();
    tracker.update([person(0.5, 0.8)], 0);
    const track = tracker.primary();

    const door = { name: "front door", kind: "door" };
    tracker.noteZone(track, door, 0);
    tracker.noteZone(track, door, 500);
    tracker.noteZone(track, door, 1000);
    tracker.noteZone(track, { name: "walkway", kind: "path" }, 1500);

    assert.deepStrictEqual(track.zoneVisits.map((v) => v.name), ["front door", "walkway"]);
    assert.strictEqual(track.zoneVisits[0].leftAt, 1500);
});

test("leaving all zones closes the open visit", () => {
    const tracker = new Tracker();
    tracker.update([person(0.5, 0.8)], 0);
    const track = tracker.primary();

    tracker.noteZone(track, { name: "driveway", kind: "path" }, 0);
    tracker.noteZone(track, null, 2000);

    assert.strictEqual(track.zoneVisits.length, 1);
    assert.strictEqual(track.zoneVisits[0].leftAt, 2000);
});

test("spread separates standing still from crossing the frame", () => {
    const still = [{ x: 0.5, y: 0.5 }, { x: 0.51, y: 0.5 }, { x: 0.49, y: 0.51 }];
    const moving = [{ x: 0.1, y: 0.5 }, { x: 0.5, y: 0.5 }, { x: 0.9, y: 0.5 }];
    assert.ok(spreadOf(still) < 0.05);
    assert.ok(spreadOf(moving) > 0.2);
});

test("LED stages escalate monotonically with behaviour", () => {
    assert.strictEqual(ledStageFor("idle"), 0);
    assert.strictEqual(ledStageFor("passing"), 1);
    assert.strictEqual(ledStageFor("present"), 2);
    assert.strictEqual(ledStageFor("dwelling"), 3);
    assert.strictEqual(ledStageFor("loitering"), 4);
    assert.ok(ledStageFor("dwelling") > ledStageFor("present"));
});

test("flush closes every open track", () => {
    const tracker = new Tracker();
    tracker.update([person(0.2, 0.8), person(0.8, 0.8)], 0);
    assert.strictEqual(tracker.flush().length, 2);
    assert.strictEqual(tracker.activeCount, 0);
});
