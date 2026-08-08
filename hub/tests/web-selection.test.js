"use strict";

/**
 * Tests for the dashboard's pure helpers.
 *
 * `resolveSelectedCam` gets its own file because getting it wrong made every
 * per-camera control — adjust image, zones, restart, reboot — unreachable for
 * anyone running a single camera. The controls rendered only on the "detail"
 * view, the detail view was only reachable by clicking a card in the grid, and
 * a lone camera has no grid and no click handler. The feature was shipped and
 * invisible.
 *
 * The DOM-heavy parts of the dashboard aren't covered here (they'd need a
 * browser); this pins down the routing rule that actually broke.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
    resolveSelectedCam, formatBytes, formatDuration, formatRelative, capitalize
} = require("../web/js/util.js");

const cams = (...ids) => ids.map((cam_id) => ({ cam_id }));

test("a single camera is always selected", () => {
    // The regression that hid the whole control panel.
    assert.equal(resolveSelectedCam(null, cams("front")), "front");
    assert.equal(resolveSelectedCam(undefined, cams("front")), "front");
    assert.equal(resolveSelectedCam("", cams("front")), "front");
});

test("with several cameras, nothing is selected until one is chosen", () => {
    assert.equal(resolveSelectedCam(null, cams("front", "porch")), null);
});

test("an explicit camera from the URL wins", () => {
    assert.equal(resolveSelectedCam("porch", cams("front", "porch")), "porch");
    assert.equal(resolveSelectedCam("front", cams("front", "porch")), "front");
});

test("a stale camera id in the URL falls back instead of sticking", () => {
    // Bookmarked link to a camera that has since been renamed or removed.
    assert.equal(resolveSelectedCam("ghost", cams("front", "porch")), null);
    // ...and with one camera left, that one is still selected.
    assert.equal(resolveSelectedCam("ghost", cams("front")), "front");
});

test("no cameras selects nothing", () => {
    assert.equal(resolveSelectedCam(null, []), null);
    assert.equal(resolveSelectedCam("front", []), null);
});

test("survives a missing or malformed camera list", () => {
    // The first poll can land before /cams has returned.
    assert.equal(resolveSelectedCam("front", undefined), null);
    assert.equal(resolveSelectedCam("front", null), null);
    assert.equal(resolveSelectedCam(null, "not an array"), null);
});

test("formatters used across the dashboard", () => {
    assert.equal(formatBytes(0), "0 B");
    assert.equal(formatBytes(1536), "1.5 KB");
    assert.equal(formatBytes(null), "—");

    assert.equal(formatDuration(500), "500 ms");
    assert.equal(formatDuration(1500), "1.5s");
    assert.equal(formatDuration(90_000), "1m 30s");

    assert.match(formatRelative(Date.now() - 5_000), /just now/);
    assert.match(formatRelative(Date.now() - 5 * 60_000), /5 min ago/);
    assert.match(formatRelative(Date.now() - 3 * 3_600_000), /3 hours ago/);

    assert.equal(capitalize("dwelling"), "Dwelling");
    assert.equal(capitalize(""), "");
});
