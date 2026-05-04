"use strict";

/**
 * Unit tests for hub/src/session.js.
 *
 *   cd hub && node --test tests/session.test.js
 *
 * No external deps required — uses an in-memory store stub and a recorder
 * stub to exercise the state machine in isolation.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { SessionManager } = require("../src/session");

function makeStubStore() {
    const rows = new Map();
    let nextId = 1;
    return {
        rows,
        insertSession ({ camId, type, startedAtMs, metadata }) {
            const id = nextId; nextId += 1;
            rows.set(id, { id, cam_id: camId, type, started_at_ms: startedAtMs, metadata });
            return id;
        },
        finalizeSession (args) {
            const row = rows.get(args.id);
            if (!row) return false;
            Object.assign(row, {
                ended_at_ms: args.endedAtMs,
                duration_ms: args.endedAtMs - row.started_at_ms,
                detection_count: args.detectionCount,
                max_confidence: args.maxConfidence,
                clip_path: args.clipPath,
                final_metadata: args.metadata
            });
            return true;
        },
        deleteSession (id) {
            return rows.delete(id);
        }
    };
}

class StubRecorder {
    constructor (cam, opts) {
        this.cam = cam;
        this.opts = opts;
        this.started = false;
        this.stopped = false;
        this.absPath = `/tmp/${cam.id}-fake.mkv`;
        this.relPath = `${cam.id}/fake.mkv`;
    }
    start () { this.started = true; }
    async stop () {
        this.stopped = true;
        return { absPath: this.absPath, relPath: this.relPath, framesWritten: 42, exitCode: 0 };
    }
}

function makeManager(overrides = {}) {
    const store = makeStubStore();
    const recorders = [];
    const recorderFactory = (cam, opts) => {
        const r = new StubRecorder(cam, opts);
        recorders.push(r);
        return r;
    };
    let nowMs = 0;
    const now = () => nowMs;
    const cam = { id: "front", lastJpeg: Buffer.alloc(0), frameSeq: 1, lastJpegAt: 0, desiredState: "on" };

    const mgr = new SessionManager({
        store,
        recordingCfg: { graceMs: 1500, minClipSeconds: 2, maxClipSeconds: 60, ...overrides.recordingCfg },
        clipsRoot: "/tmp",
        recorderFactory,
        getCam: () => cam,
        logger: { info: () => {}, warn: () => {}, error: () => {} },
        now
    });
    return { mgr, store, recorders, advance: (ms) => { nowMs += ms; }, setNow: (ms) => { nowMs = ms; }, cam };
}

test("Session: idle stays idle when no person observed", () => {
    const { mgr, store } = makeManager();
    mgr.observe("front", false, 0);
    assert.equal(mgr.isActive("front"), false);
    assert.equal(store.rows.size, 0);
});

test("Session: starts on first detection, ends after grace expires", async () => {
    const { mgr, store, recorders, advance, setNow } = makeManager();
    setNow(1000);

    mgr.observe("front", true, 0.9);
    assert.equal(mgr.isActive("front"), true);
    assert.equal(recorders.length, 1);
    assert.equal(recorders[0].started, true);
    assert.equal(store.rows.size, 1);

    // Person seen again 500ms later — session continues.
    advance(500);
    mgr.observe("front", true, 0.95);
    assert.equal(mgr.isActive("front"), true);

    // Person disappears for less than grace — still active.
    advance(1000);
    mgr.observe("front", false, 0);
    assert.equal(mgr.isActive("front"), true);

    // Grace expires (>= 1500ms since last person) — session ends.
    // We need long enough that the duration is also >= minClipSeconds (2s)
    // so the session is finalized rather than dropped.
    advance(2000);    // total 4500ms total since last person
    mgr.observe("front", false, 0);
    // forceEnd is async; observe schedules it but doesn't await.
    await new Promise((r) => setImmediate(r));
    assert.equal(mgr.isActive("front"), false);
    const row = [...store.rows.values()][0];
    assert.notEqual(row.ended_at_ms, undefined);
    assert.equal(row.detection_count, 2);
    assert.equal(row.max_confidence, 0.95);
    assert.equal(row.clip_path, "front/fake.mkv");
});

test("Session: drops row + clip if shorter than minClipSeconds", async () => {
    const fs = require("node:fs");
    const { mgr, store, recorders, setNow, advance } = makeManager({
        recordingCfg: { graceMs: 200, minClipSeconds: 2, maxClipSeconds: 60 }
    });
    setNow(1000);
    mgr.observe("front", true, 0.8);
    assert.equal(store.rows.size, 1);

    // Make the recorder's absPath actually exist so we can verify deletion.
    const fakePath = recorders[0].absPath;
    fs.writeFileSync(fakePath, "stub");

    // Person disappears immediately; grace is 200ms.
    advance(500);  // total 500ms
    mgr.observe("front", false, 0);
    await new Promise((r) => setImmediate(r));

    // Session was below 2000ms min → row should be deleted.
    assert.equal(mgr.isActive("front"), false);
    assert.equal(store.rows.size, 0);
    assert.equal(fs.existsSync(fakePath), false);
});

test("Session: caps at maxClipSeconds even if person stays in frame", async () => {
    // maxClipSeconds is clamped to a 5s floor in production code. Use 10s
    // here so the test stays robust to that floor.
    const { mgr, store, setNow } = makeManager({
        recordingCfg: { graceMs: 60_000, minClipSeconds: 0, maxClipSeconds: 10 }
    });
    setNow(1_000);
    mgr.observe("front", true, 0.8);

    setNow(12_000);   // 11s elapsed, well past the 10s cap
    mgr.observe("front", true, 0.9);
    await new Promise((r) => setImmediate(r));

    // The original session must have been closed with reason="max-length".
    // A subsequent observation may start a fresh session — that's fine
    // (a person still in frame beyond the cap should keep getting recorded
    // in fresh clips), but we're asserting on the closed one.
    const closed = [...store.rows.values()].filter((r) => r.ended_at_ms !== undefined);
    assert.equal(closed.length, 1);
    assert.equal(closed[0].final_metadata.reason, "max-length");
});

test("Session: forceEnd closes an active session immediately", async () => {
    const { mgr, store, setNow, advance } = makeManager();
    setNow(1000);
    mgr.observe("front", true, 0.7);
    assert.equal(mgr.isActive("front"), true);

    advance(2500);   // satisfy minClip
    await mgr.forceEnd("front", "test-reason");
    assert.equal(mgr.isActive("front"), false);
    const row = [...store.rows.values()][0];
    assert.equal(row.final_metadata.reason, "test-reason");
});

test("Session: forceEnd is a no-op when no session is active", async () => {
    const { mgr } = makeManager();
    const result = await mgr.forceEnd("front");
    assert.equal(result, null);
});

test("Session: forceEndAll cleans up every cam", async () => {
    // Need two cams; rebuild a manager that returns different cams per id.
    const cams = {
        front: { id: "front", lastJpeg: Buffer.alloc(0), frameSeq: 1, lastJpegAt: 0, desiredState: "on" },
        porch: { id: "porch", lastJpeg: Buffer.alloc(0), frameSeq: 1, lastJpegAt: 0, desiredState: "on" }
    };
    const store = makeStubStore();
    const recorderFactory = (cam, opts) => new StubRecorder(cam, opts);
    let nowMs = 0;

    const mgr = new SessionManager({
        store,
        recordingCfg: { graceMs: 1500, minClipSeconds: 0, maxClipSeconds: 60 },
        clipsRoot: "/tmp",
        recorderFactory,
        getCam: (id) => cams[id],
        logger: { info: () => {}, warn: () => {}, error: () => {} },
        now: () => nowMs
    });
    nowMs = 1000;
    mgr.observe("front", true, 0.8);
    mgr.observe("porch", true, 0.9);
    assert.equal(mgr.isActive("front"), true);
    assert.equal(mgr.isActive("porch"), true);

    nowMs = 1500;
    await mgr.forceEndAll("test");
    assert.equal(mgr.isActive("front"), false);
    assert.equal(mgr.isActive("porch"), false);
    assert.equal(store.rows.size, 2);
});
