"use strict";

const test = require("node:test");
const assert = require("node:assert");

const { describeEvent, describeOffline, dedupeVisits, the } = require("../src/describe");

/** Build a zone visit with a dwell duration in seconds. */
function visit(name, kind, atMs, seconds) {
    return { name, kind, enteredAt: atMs, leftAt: atMs + seconds * 1000 };
}

const NOON = new Date(2026, 5, 15, 12, 0, 0).getTime();

test("describes someone standing at a named door", () => {
    const text = describeEvent({
        camId: "front",
        friendlyName: "Front Door",
        behavior: "dwelling",
        durationMs: 12_000,
        startedAtMs: NOON,
        zoneVisits: [visit("trash room door", "door", NOON, 12)]
    });
    assert.strictEqual(text, "Someone stood at the trash room door for 12 seconds.");
});

test("describes movement between two named zones", () => {
    const text = describeEvent({
        camId: "front",
        behavior: "passing",
        durationMs: 4000,
        startedAtMs: NOON,
        zoneVisits: [
            visit("driveway", "path", NOON, 2),
            visit("trash room door", "door", NOON + 2000, 2)
        ]
    });
    assert.strictEqual(text, "Someone walked from the driveway to the trash room door.");
});

test("falls back to the camera name when no zones are drawn", () => {
    const text = describeEvent({
        camId: "front",
        friendlyName: "Front Door",
        behavior: "present",
        durationMs: 8000,
        startedAtMs: NOON,
        zoneVisits: []
    });
    assert.strictEqual(text, "Someone was at the Front Door for 8 seconds.");
});

test("uses the raw cam id when there is no friendly name", () => {
    const text = describeEvent({
        camId: "porch",
        behavior: "present",
        durationMs: 5000,
        startedAtMs: NOON
    });
    assert.match(text, /the porch/);
});

test("mentions direction when passing with nothing else to say", () => {
    const text = describeEvent({
        camId: "front",
        friendlyName: "Front Door",
        behavior: "passing",
        durationMs: 2000,
        startedAtMs: NOON,
        direction: "right"
    });
    assert.strictEqual(text, "Someone passed by the Front Door heading right.");
});

test("loitering reports the total time", () => {
    const text = describeEvent({
        camId: "front",
        behavior: "loitering",
        durationMs: 4 * 60_000,
        startedAtMs: NOON,
        zoneVisits: [visit("front step", "door", NOON, 240)]
    });
    assert.strictEqual(text, "Someone stayed at the front step for 4 minutes.");
});

test("names a recognised profile instead of 'someone'", () => {
    const text = describeEvent({
        camId: "front",
        behavior: "approaching",
        durationMs: 3000,
        startedAtMs: NOON,
        profileName: "Jared",
        zoneVisits: [visit("front door", "door", NOON, 3)]
    });
    assert.strictEqual(text, "Jared went up to the front door.");
});

test("counts multiple people", () => {
    const text = describeEvent({
        camId: "front",
        behavior: "present",
        durationMs: 6000,
        startedAtMs: NOON,
        personCount: 2,
        zoneVisits: [visit("driveway", "path", NOON, 6)]
    });
    assert.strictEqual(text, "Two people were on the driveway for 6 seconds.");
});

test("adds an after-dark qualifier using local sun position", () => {
    // 2am in mid-December at a high northern latitude is unambiguously dark,
    // and also hits the early-hours branch.
    const twoAM = new Date(2026, 11, 15, 2, 0, 0).getTime();
    const text = describeEvent({
        camId: "front",
        behavior: "dwelling",
        durationMs: 15_000,
        startedAtMs: twoAM,
        zoneVisits: [visit("front step", "door", twoAM, 15)],
        latitude: 51.5,
        longitude: -0.12
    });
    assert.match(text, /in the early hours\.$/);
});

test("omits the time qualifier at midday", () => {
    const text = describeEvent({
        camId: "front",
        behavior: "present",
        durationMs: 5000,
        startedAtMs: NOON,
        latitude: 51.5,
        longitude: -0.12
    });
    assert.doesNotMatch(text, /after dark|early hours/);
});

test("always produces a single capitalised sentence", () => {
    for (const behavior of ["passing", "approaching", "present", "dwelling", "loitering"]) {
        const text = describeEvent({
            camId: "front", behavior, durationMs: 9000, startedAtMs: NOON
        });
        assert.match(text, /^[A-Z]/, `"${text}" should start capitalised`);
        assert.match(text, /\.$/, `"${text}" should end with a period`);
        assert.doesNotMatch(text, /\s{2,}/, `"${text}" should have no double spaces`);
    }
});

test("does not double up articles the user already wrote", () => {
    assert.strictEqual(the("the trash room"), "the trash room");
    assert.strictEqual(the("trash room"), "the trash room");
    assert.strictEqual(the("Jared's office"), "Jared's office");
    assert.strictEqual(the("My porch"), "My porch");
});

test("collapses boundary flicker into one visit", () => {
    // Someone standing on a zone edge alternates every tick; the description
    // must not become "walkway to door to walkway to door".
    const visits = dedupeVisits([
        visit("walkway", "path", 0, 2),
        visit("walkway", "path", 2000, 2),
        visit("front door", "door", 4000, 3)
    ]);
    assert.strictEqual(visits.length, 2);
    assert.strictEqual(visits[0].name, "walkway");
    assert.strictEqual(visits[0].dwellMs, 4000);
    assert.strictEqual(visits[1].name, "front door");
});

test("drops sub-second visits as noise unless they are all there is", () => {
    const noisy = dedupeVisits([
        visit("edge", "area", 0, 0.2),
        visit("driveway", "path", 200, 5)
    ]);
    assert.deepStrictEqual(noisy.map((v) => v.name), ["driveway"]);

    const onlyNoise = dedupeVisits([visit("edge", "area", 0, 0.2)]);
    assert.strictEqual(onlyNoise.length, 1, "a single brief visit is better than saying nothing");
});

test("offline events get their own distinct wording", () => {
    const text = describeOffline({
        camId: "porch", friendlyName: "Back Porch", downForMs: 25 * 60_000
    });
    assert.strictEqual(text, "Back Porch stopped reporting 25 minutes ago.");
});

test("survives a completely empty input without throwing", () => {
    const text = describeEvent({});
    assert.ok(text.length > 0);
    assert.match(text, /\.$/);
});
