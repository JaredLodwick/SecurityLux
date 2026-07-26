"use strict";

const test = require("node:test");
const assert = require("node:assert");

const {
    validateZones, pointInPolygon, anchorOf, zonesForBox,
    isIgnored, primaryZone, rectZone
} = require("../src/zones");

/** A box whose bottom-centre anchor lands exactly at (x, y). */
function boxAt(x, y, { w = 0.1, h = 0.3 } = {}) {
    return { cx: x, cy: y - h / 2, w, h };
}

const LEFT_HALF = rectZone("trash room door", "door", 0, 0, 0.5, 1);
const RIGHT_HALF = rectZone("driveway", "path", 0.5, 0, 1, 1);

test("anchors on the bottom of the box, not its centre", () => {
    // A person's feet are where they are; their centre floats a metre up and
    // would drift across zone boundaries as they approach the camera.
    const anchor = anchorOf({ cx: 0.5, cy: 0.5, w: 0.1, h: 0.4 });
    assert.strictEqual(anchor.x, 0.5);
    assert.strictEqual(anchor.y, 0.7);
});

test("point-in-polygon handles a simple rectangle", () => {
    const square = rectZone("box", "area", 0.2, 0.2, 0.8, 0.8).points;
    assert.ok(pointInPolygon(square, 0.5, 0.5));
    assert.ok(!pointInPolygon(square, 0.1, 0.5));
    assert.ok(!pointInPolygon(square, 0.5, 0.9));
});

test("point-in-polygon handles a concave shape", () => {
    // An L, with the notch in the top-right quadrant.
    const ell = [
        { x: 0, y: 0 }, { x: 0.5, y: 0 }, { x: 0.5, y: 0.5 },
        { x: 1, y: 0.5 }, { x: 1, y: 1 }, { x: 0, y: 1 }
    ];
    assert.ok(pointInPolygon(ell, 0.25, 0.25), "inside the upper arm");
    assert.ok(pointInPolygon(ell, 0.75, 0.75), "inside the lower arm");
    assert.ok(!pointInPolygon(ell, 0.75, 0.25), "the notch is outside");
});

test("finds every zone containing the anchor", () => {
    const overlapping = rectZone("porch", "area", 0, 0, 1, 1);
    const hits = zonesForBox([LEFT_HALF, RIGHT_HALF, overlapping], boxAt(0.25, 0.5));
    assert.deepStrictEqual(hits.map((z) => z.name).sort(), ["porch", "trash room door"]);
});

test("doors outrank paths when both contain the anchor", () => {
    const walkway = rectZone("walkway", "path", 0, 0, 1, 1);
    const step = rectZone("front step", "door", 0.4, 0.4, 0.6, 0.6);
    const zone = primaryZone([walkway, step], boxAt(0.5, 0.5));
    assert.strictEqual(zone.name, "front step");
});

test("ignore zones suppress a detection", () => {
    const road = { ...rectZone("road", "ignore", 0, 0, 1, 0.3) };
    assert.strictEqual(isIgnored([road], boxAt(0.5, 0.15)), true);
    assert.strictEqual(isIgnored([road], boxAt(0.5, 0.8)), false);
});

test("a real zone overlapping an ignore zone still counts", () => {
    // Otherwise an ignore region drawn over a busy road would also blind the
    // doorstep that happens to overlap it.
    const road = rectZone("road", "ignore", 0, 0, 1, 1);
    const step = rectZone("front step", "door", 0.4, 0.4, 0.6, 0.6);
    assert.strictEqual(isIgnored([road, step], boxAt(0.5, 0.5)), false);
    assert.strictEqual(primaryZone([road, step], boxAt(0.5, 0.5)).name, "front step");
});

test("no zones drawn means nothing is ignored", () => {
    assert.strictEqual(isIgnored([], boxAt(0.5, 0.5)), false);
    assert.strictEqual(primaryZone([], boxAt(0.5, 0.5)), null);
});

test("accepts a well-formed zone set", () => {
    const result = validateZones([LEFT_HALF, RIGHT_HALF]);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.value.length, 2);
    assert.strictEqual(result.value[0].kind, "door");
});

test("rejects zones missing a name, points, or a valid kind", () => {
    assert.strictEqual(validateZones([{ points: LEFT_HALF.points }]).ok, false);
    assert.strictEqual(validateZones([{ name: "x", points: [{ x: 0, y: 0 }] }]).ok, false);
    assert.strictEqual(
        validateZones([{ name: "x", kind: "nonsense", points: LEFT_HALF.points }]).ok,
        false
    );
});

test("rejects duplicate zone names case-insensitively", () => {
    const result = validateZones([
        { ...LEFT_HALF, name: "Front Door" },
        { ...RIGHT_HALF, name: "front door" }
    ]);
    assert.strictEqual(result.ok, false);
    assert.match(result.errors[0], /duplicate/i);
});

test("clamps out-of-frame points instead of rejecting the zone", () => {
    // Dragging a box a few pixels past the edge of the video element is normal
    // user behaviour, not a reason to throw their work away.
    const result = validateZones([{
        name: "edge", kind: "area",
        points: [{ x: -0.4, y: -0.2 }, { x: 1.6, y: 0 }, { x: 1.2, y: 1.9 }]
    }]);
    assert.strictEqual(result.ok, true);
    for (const p of result.value[0].points) {
        assert.ok(p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1);
    }
});

test("rejects a non-array payload", () => {
    assert.strictEqual(validateZones("not an array").ok, false);
    assert.strictEqual(validateZones(null).ok, false);
});

test("rectZone normalises a backwards drag", () => {
    const dragged = rectZone("box", "area", 0.8, 0.9, 0.2, 0.1);
    const xs = dragged.points.map((p) => p.x);
    const ys = dragged.points.map((p) => p.y);
    assert.strictEqual(Math.min(...xs), 0.2);
    assert.strictEqual(Math.max(...xs), 0.8);
    assert.strictEqual(Math.min(...ys), 0.1);
    assert.strictEqual(Math.max(...ys), 0.9);
});
