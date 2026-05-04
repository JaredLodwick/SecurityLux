"use strict";

/**
 * Unit tests for hub/src/store.js.
 *
 *   cd hub && npm install && npm test
 *   # or directly: cd hub && node --test tests/store.test.js
 *
 * Requires `better-sqlite3`, which `npm install` inside hub/ pulls in.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { Store } = require("../src/store");

function tmpDb() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "luxhub-store-"));
    return { path: path.join(dir, "events.db"), dir };
}

const silentLog = { info: () => {}, warn: () => {}, error: () => {} };

test("Store: insert + finalize round trip", () => {
    const { path: dbPath, dir } = tmpDb();
    try {
        const store = new Store({ dbPath, logger: silentLog }).open();

        const startedAt = Date.now();
        const id = store.insertSession({
            camId: "front",
            type: "person",
            startedAtMs: startedAt
        });
        assert.equal(typeof id, "number");

        const ok = store.finalizeSession({
            id,
            endedAtMs: startedAt + 4321,
            detectionCount: 7,
            maxConfidence: 0.91,
            clipPath: "front/2026-05-01/12-00-00_person.mkv",
            metadata: { reason: "grace-expired" }
        });
        assert.equal(ok, true);

        const row = store.getEvent(id);
        assert.equal(row.cam_id, "front");
        assert.equal(row.duration_ms, 4321);
        assert.equal(row.detection_count, 7);
        assert.equal(row.max_confidence, 0.91);
        assert.equal(row.clip_path, "front/2026-05-01/12-00-00_person.mkv");
        assert.deepEqual(row.metadata, { reason: "grace-expired" });

        store.close();
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("Store: queryEvents pagination + cam filter", () => {
    const { path: dbPath, dir } = tmpDb();
    try {
        const store = new Store({ dbPath, logger: silentLog }).open();
        const base = 1_000_000;
        for (let i = 0; i < 10; i += 1) {
            store.insertSession({
                camId: i % 2 === 0 ? "front" : "porch",
                type: "person",
                startedAtMs: base + i
            });
        }

        const all = store.queryEvents({});
        assert.equal(all.length, 10);
        // Newest first.
        assert.equal(all[0].started_at_ms, base + 9);

        const front = store.queryEvents({ camId: "front" });
        assert.equal(front.length, 5);
        for (const e of front) assert.equal(e.cam_id, "front");

        const limited = store.queryEvents({ limit: 3 });
        assert.equal(limited.length, 3);

        const since = store.queryEvents({ sinceMs: base + 7 });
        assert.equal(since.length, 2);    // base+8, base+9

        // Hard cap at 200 even if a caller asks for more.
        const cap = store.queryEvents({ limit: 1000 });
        assert.equal(cap.length, 10);

        store.close();
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("Store: deleteSession drops the row", () => {
    const { path: dbPath, dir } = tmpDb();
    try {
        const store = new Store({ dbPath, logger: silentLog }).open();
        const id = store.insertSession({ camId: "front", type: "person", startedAtMs: 100 });
        assert.ok(store.getEvent(id));
        assert.equal(store.deleteSession(id), true);
        assert.equal(store.getEvent(id), null);
        // Idempotent — second delete returns false but doesn't throw.
        assert.equal(store.deleteSession(id), false);
        store.close();
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("Store: retentionSweep removes old rows + clip files", () => {
    const { path: dbPath, dir } = tmpDb();
    const clipsRoot = path.join(dir, "clips");
    try {
        const store = new Store({ dbPath, logger: silentLog }).open();
        const now = Date.now();
        const oldRel = "2020-01-01/01-00-00_front_person.mkv";
        const newRel = new Date().toISOString().slice(0, 10) + "/01-00-00_front_person.mkv";
        fs.mkdirSync(path.join(clipsRoot, path.dirname(oldRel)), { recursive: true });
        fs.mkdirSync(path.join(clipsRoot, path.dirname(newRel)), { recursive: true });
        fs.writeFileSync(path.join(clipsRoot, oldRel), "old");
        fs.writeFileSync(path.join(clipsRoot, newRel), "new");

        const oldId = store.insertSession({ camId: "front", type: "person", startedAtMs: now - 30 * 86400_000 });
        store.finalizeSession({ id: oldId, endedAtMs: now - 30 * 86400_000 + 2000, detectionCount: 3, maxConfidence: 0.8, clipPath: oldRel });

        const newId = store.insertSession({ camId: "front", type: "person", startedAtMs: now - 60_000 });
        store.finalizeSession({ id: newId, endedAtMs: now, detectionCount: 5, maxConfidence: 0.7, clipPath: newRel });

        const result = store.retentionSweep({ retentionDays: 14, clipsRoot });
        assert.equal(result.rowsDeleted, 1);
        assert.equal(result.clipsDeleted, 1);

        // Old row + clip gone, new ones survive.
        assert.equal(store.getEvent(oldId), null);
        assert.ok(store.getEvent(newId));
        assert.ok(!fs.existsSync(path.join(clipsRoot, oldRel)));
        assert.ok(fs.existsSync(path.join(clipsRoot, newRel)));

        store.close();
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("Store: startup recovery closes orphaned sessions", () => {
    const { path: dbPath, dir } = tmpDb();
    try {
        // Open once, insert without finalize, close → simulates a crash.
        const store1 = new Store({ dbPath, logger: silentLog }).open();
        store1.insertSession({ camId: "front", type: "person", startedAtMs: 100 });
        store1.insertSession({ camId: "front", type: "person", startedAtMs: 200 });
        // Finalize one to make sure the recovery only touches orphans.
        const finalId = store1.insertSession({ camId: "front", type: "person", startedAtMs: 300 });
        store1.finalizeSession({ id: finalId, endedAtMs: 350, detectionCount: 1, maxConfidence: 0.9, clipPath: null });
        store1.close();

        // Re-open: recovery should close the two orphans.
        const store2 = new Store({ dbPath, logger: silentLog }).open();
        const events = store2.queryEvents({});
        assert.equal(events.length, 3);
        for (const e of events) {
            assert.notEqual(e.ended_at_ms, null, `event ${e.id} should be closed after recovery`);
            if (e.id !== finalId) {
                assert.equal(e.metadata && e.metadata.recovery, true);
            }
        }
        store2.close();
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
