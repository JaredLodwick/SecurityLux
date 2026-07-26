"use strict";

/**
 * Unit tests for hub/src/session.js.
 *
 *   cd hub && node --test tests/session.test.js
 *
 * No external deps: an in-memory store stub and a recorder stub exercise the
 * state machine in isolation, with an injected clock so nothing sleeps.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { SessionManager } = require("../src/session");
const { SCHEMA } = require("../src/settings");

function makeStubStore() {
    const rows = new Map();
    let nextId = 1;
    return {
        rows,
        insertSession({ camId, type, startedAtMs, metadata }) {
            const id = nextId;
            nextId += 1;
            rows.set(id, { id, cam_id: camId, type, started_at_ms: startedAtMs, metadata });
            return id;
        },
        finalizeSession(args) {
            const row = rows.get(args.id);
            if (!row) return false;
            Object.assign(row, {
                ended_at_ms: args.endedAtMs,
                duration_ms: args.endedAtMs - row.started_at_ms,
                detection_count: args.detectionCount,
                max_confidence: args.maxConfidence,
                clip_path: args.clipPath,
                thumb_path: args.thumbPath,
                description: args.description,
                behavior: args.behavior,
                zones: args.zones,
                track: args.track,
                final_metadata: args.metadata
            });
            return true;
        },
        finalizeClipStats() { return true; },
        setThumb(id, thumbPath) {
            const row = rows.get(id);
            if (row) row.thumb_path = thumbPath;
        },
        deleteSession(id) { return rows.delete(id); },
        getEvent(id) { return rows.get(id) || null; }
    };
}

/**
 * Minimal SettingsService stand-in: schema defaults, plus per-test overrides.
 * Reading defaults out of SCHEMA rather than hardcoding them means these tests
 * keep testing the real behaviour if a default is ever retuned.
 */
function makeSettings(overrides = {}) {
    return {
        get(key) {
            if (key in overrides) return overrides[key];
            if (!(key in SCHEMA)) throw new Error(`test settings stub: unknown key ${key}`);
            return SCHEMA[key].default;
        }
    };
}

class StubRecorder {
    constructor(cam, opts) {
        this.cam = cam;
        this.opts = opts;
        this.started = false;
        this.stopped = false;
        this.postRollBegan = false;
        this.absPath = `/tmp/${cam.id}-fake.mp4`;
        this.relPath = `${cam.id}/fake.mp4`;
        this.thumbRelPath = null;
    }
    start() { this.started = true; }
    async writeThumbnail() {
        this.thumbRelPath = `${this.cam.id}/fake.jpg`;
        return this.thumbRelPath;
    }
    async beginPostRoll() {
        this.postRollBegan = true;
        return this.stop();
    }
    async stop() {
        this.stopped = true;
        return {
            absPath: this.absPath, relPath: this.relPath,
            thumbRelPath: this.thumbRelPath,
            framesWritten: 42, preRollFrames: 12, bytes: 1024, exitCode: 0
        };
    }
}

function person(x = 0.5, y = 0.8, confidence = 0.9) {
    const h = 0.4;
    return { bbox: { cx: x, cy: y - h / 2, w: 0.12, h }, confidence, cls: "person" };
}

function setup({ settings = {}, zones = [] } = {}) {
    const store = makeStubStore();
    const recorders = [];
    let clock = 100_000;

    const manager = new SessionManager({
        store,
        settings: makeSettings(settings),
        clipsRoot: "/tmp/clips",
        recorderFactory: (cam, opts) => {
            const recorder = new StubRecorder(cam, opts);
            recorders.push(recorder);
            return recorder;
        },
        getCam: (camId) => ({ id: camId, frameBuffer: null }),
        getZones: () => zones,
        logger: { info() {}, warn() {}, error() {} },
        now: () => clock
    });

    return {
        store, recorders, manager,
        advance: (ms) => { clock += ms; },
        at: () => clock
    };
}

/**
 * Let pending work finish.
 *
 * A grace-triggered end runs asynchronously from inside `observe()` — it stops
 * the recorder and may unlink a discarded clip, which is real file I/O. One
 * `setImmediate` is not enough, so drain the manager's in-flight teardowns too.
 */
const settle = async (manager) => {
    await new Promise((resolve) => setImmediate(resolve));
    if (manager) await manager.drain();
};

test("stays idle when nothing is detected", () => {
    const { manager, store } = setup();
    manager.observe("front", []);
    manager.observe("front", []);
    assert.equal(manager.isActive("front"), false);
    assert.equal(store.rows.size, 0);
});

test("starts on first detection and ends after the grace window", async () => {
    const { manager, store, recorders, advance } = setup();

    manager.observe("front", [person()]);
    assert.equal(manager.isActive("front"), true);
    assert.equal(recorders.length, 1);
    assert.equal(recorders[0].started, true);

    // Stay present long enough to clear minClipSeconds.
    for (let i = 0; i < 8; i += 1) {
        advance(500);
        manager.observe("front", [person(0.5 + i * 0.002)]);
    }

    advance(2000);              // longer than graceMs (1500)
    manager.observe("front", []);
    await settle(manager);

    assert.equal(manager.isActive("front"), false);
    const row = [...store.rows.values()][0];
    assert.equal(row.clip_path, "front/fake.mp4");
    assert.ok(row.duration_ms >= 4000);
    assert.ok(row.description, "a natural-language description should be written");
    assert.ok(row.behavior, "a behaviour class should be recorded");
});

test("post-roll runs after the row is finalized, not before", async () => {
    const { manager, store, recorders, advance } = setup();

    manager.observe("front", [person()]);
    for (let i = 0; i < 8; i += 1) { advance(500); manager.observe("front", [person()]); }
    advance(2000);
    manager.observe("front", []);
    await settle(manager);

    // The event row must be complete immediately — waiting on ffmpeg would
    // delay the event appearing in the UI for no benefit.
    const row = [...store.rows.values()][0];
    assert.ok(row.ended_at_ms, "row is finalized synchronously with session end");
    assert.equal(recorders[0].postRollBegan, true, "recorder keeps running afterwards");
});

test("writes a thumbnail at session start", async () => {
    const { manager, store, advance } = setup();
    manager.observe("front", [person()]);
    await settle(manager);

    const row = [...store.rows.values()][0];
    assert.equal(row.thumb_path, "front/fake.jpg");
    advance(1);
});

test("drops the row and the clip when shorter than minClipSeconds", async () => {
    const { manager, store, recorders, advance } = setup({
        settings: { "recording.minClipSeconds": 5 }
    });

    manager.observe("front", [person()]);
    advance(2000);              // well under 5s
    manager.observe("front", []);
    await settle(manager);

    assert.equal(manager.isActive("front"), false);
    assert.equal(store.rows.size, 0, "false-positive rows must not litter the log");
    assert.equal(recorders[0].stopped, true);
    assert.equal(recorders[0].postRollBegan, false, "no post-roll on a discarded clip");
});

test("splits into a new clip at maxClipSeconds while a person stays in frame", async () => {
    const { manager, store, advance } = setup({
        settings: { "recording.maxClipSeconds": 5 }
    });

    // Ten seconds of continuous presence against a five-second cap.
    manager.observe("front", [person()]);
    for (let i = 0; i < 20; i += 1) {
        advance(500);
        manager.observe("front", [person()]);
    }
    // The second segment is still open at this point — the person hasn't left.
    await manager.forceEnd("front", "test-end");
    await settle(manager);

    // Two clips, not one truncated one: someone who stands at the door for an
    // hour should produce a series of bounded clips rather than one unbounded
    // file that can't be played until they leave.
    assert.equal(store.rows.size, 2, "a 10s presence with a 5s cap should split");
    for (const row of store.rows.values()) {
        assert.ok(row.ended_at_ms, "every segment should be finalized");
        assert.ok(row.duration_ms <= 6000, "no segment should exceed the cap");
    }
});

test("forceEnd closes an active session immediately", async () => {
    const { manager, store, advance } = setup();
    manager.observe("front", [person()]);
    advance(6000);
    await manager.forceEnd("front", "cam-disconnected");

    assert.equal(manager.isActive("front"), false);
    const row = [...store.rows.values()][0];
    assert.equal(row.final_metadata.reason, "cam-disconnected");
});

test("forceEnd is a no-op with no active session", async () => {
    const { manager } = setup();
    assert.equal(await manager.forceEnd("front", "x"), null);
});

test("forceEndAll cleans up every camera", async () => {
    const { manager, advance } = setup();
    manager.observe("front", [person()]);
    manager.observe("porch", [person()]);
    advance(6000);
    await manager.forceEndAll("hub-stop");

    assert.equal(manager.isActive("front"), false);
    assert.equal(manager.isActive("porch"), false);
});

test("detections inside an ignore zone never start a session", () => {
    // The release valve for the recurring false positive — a swaying branch,
    // a neighbour's window, passing traffic.
    const ignoreTop = {
        name: "road", kind: "ignore",
        points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 0.4 }, { x: 0, y: 0.4 }]
    };
    const { manager, store } = setup({ zones: [ignoreTop] });

    manager.observe("front", [person(0.5, 0.2)]);       // anchored in the ignore zone
    assert.equal(manager.isActive("front"), false);
    assert.equal(store.rows.size, 0);

    manager.observe("front", [person(0.5, 0.9)]);       // below it
    assert.equal(manager.isActive("front"), true);
});

test("escalates the door light as someone lingers, and stands down after", async () => {
    const stages = [];
    const store = makeStubStore();
    let clock = 100_000;

    const manager = new SessionManager({
        store,
        settings: makeSettings({
            "led.passingSeconds": 3, "led.dwellSeconds": 10, "led.loiterSeconds": 30
        }),
        clipsRoot: "/tmp/clips",
        recorderFactory: (cam, opts) => new StubRecorder(cam, opts),
        getCam: (camId) => ({ id: camId, frameBuffer: null }),
        getZones: () => [],
        onBehaviorChange: (camId, s) => stages.push(s.stage),
        logger: { info() {}, warn() {}, error() {} },
        now: () => clock
    });

    for (let t = 0; t <= 35_000; t += 500) {
        clock = 100_000 + t;
        manager.observe("front", [person(0.5 + (t % 1000 ? 0.003 : -0.003))]);
    }

    assert.ok(stages.length > 0, "the light should have been driven");
    assert.equal(stages[stages.length - 1], 4, "should reach the loitering stage");
    // Stages are only emitted on change — a person standing still for 35s must
    // not generate 70 messages.
    assert.ok(stages.length <= 6, `expected few transitions, got ${stages.length}`);

    clock += 5000;
    await manager.forceEnd("front", "test");
    assert.equal(stages[stages.length - 1], 0, "the light must stand down when they leave");
});

test("skips recording but still logs the event when storage is paused", async () => {
    const store = makeStubStore();
    let clock = 100_000;
    const recorders = [];

    const manager = new SessionManager({
        store,
        settings: makeSettings(),
        clipsRoot: "/tmp/clips",
        storage: { canRecord: () => false, resolveClipPath: () => null, sweep: async () => {} },
        recorderFactory: (cam, opts) => {
            const r = new StubRecorder(cam, opts);
            recorders.push(r);
            return r;
        },
        getCam: (camId) => ({ id: camId, frameBuffer: null }),
        getZones: () => [],
        logger: { info() {}, warn() {}, error() {} },
        now: () => clock
    });

    manager.observe("front", [person()]);
    assert.equal(recorders.length, 0, "no clip should be written when the disk is full");

    for (let i = 0; i < 8; i += 1) { clock += 500; manager.observe("front", [person()]); }
    clock += 2000;
    manager.observe("front", []);
    await settle(manager);

    // Losing video is acceptable; losing the record that something happened
    // is not.
    const row = [...store.rows.values()][0];
    assert.ok(row, "the event must still be logged");
    assert.equal(row.clip_path, null);
    assert.equal(row.metadata.clipSkipped, "storage-paused");
});
