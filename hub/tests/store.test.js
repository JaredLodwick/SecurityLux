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
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "securityluxhub-store-"));
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

test("Store: retention helpers select the right rows", () => {
    // The sweep itself moved to storage.js; the store just supplies the
    // candidate rows and the pruning primitives.
    const { path: dbPath, dir } = tmpDb();
    try {
        const store = new Store({ dbPath, logger: silentLog }).open();
        const now = Date.now();

        const oldId = store.insertSession({
            camId: "front", type: "person", startedAtMs: now - 30 * 86400_000
        });
        store.finalizeSession({
            id: oldId, endedAtMs: now - 30 * 86400_000 + 2000,
            detectionCount: 3, maxConfidence: 0.8,
            clipPath: "2020-01-01/01-00-00_front_person.mp4", clipBytes: 5000
        });

        const newId = store.insertSession({
            camId: "front", type: "person", startedAtMs: now - 60_000
        });
        store.finalizeSession({
            id: newId, endedAtMs: now, detectionCount: 5, maxConfidence: 0.7,
            clipPath: "2026-01-01/01-00-00_front_person.mp4", clipBytes: 7000
        });

        const cutoff = now - 14 * 86400_000;
        const stale = store.eventsOlderThan(cutoff);
        assert.equal(stale.length, 1);
        assert.equal(stale[0].id, oldId);

        assert.equal(store.sumClipBytes(), 12000);
        assert.equal(store.clipsOldestFirst()[0].id, oldId, "oldest is reclaimed first");

        assert.equal(store.deleteEventsOlderThan(cutoff), 1);
        assert.equal(store.getEvent(oldId), null);
        assert.ok(store.getEvent(newId));

        store.close();
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("Store: pruning a clip keeps the event row", () => {
    // Losing footage from six weeks ago is acceptable; losing the record that
    // anything happened is not.
    const { path: dbPath, dir } = tmpDb();
    try {
        const store = new Store({ dbPath, logger: silentLog }).open();
        const id = store.insertSession({ camId: "front", type: "person", startedAtMs: Date.now() });
        store.finalizeSession({
            id, endedAtMs: Date.now() + 3000, detectionCount: 2, maxConfidence: 0.8,
            clipPath: "d/clip.mp4", clipBytes: 9000, description: "Someone was at the front door."
        });

        store.markClipPruned(id);
        const event = store.getEvent(id);

        assert.ok(event, "the row survives");
        assert.equal(event.clip_pruned, true);
        assert.equal(event.clip_path, null, "the API stops advertising a file that is gone");
        assert.equal(event.description, "Someone was at the front door.", "history is preserved");
        assert.equal(store.sumClipBytes(), 0);
        assert.equal(store.clipsOldestFirst().length, 0, "not offered for pruning twice");

        store.close();
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("Store: settings, zones and profiles round trip", () => {
    const { path: dbPath, dir } = tmpDb();
    try {
        const store = new Store({ dbPath, logger: silentLog }).open();

        store.putSetting("global", "recording.codec", "h264");
        store.putSetting("front", "led.enabled", true);
        const settings = store.allSettings();
        assert.equal(settings.length, 2);
        assert.ok(settings.some((s) => s.scope === "front" && s.value === true));

        store.putSetting("global", "recording.codec", "mkv");
        assert.equal(store.allSettings().length, 2, "upsert, not duplicate");

        const zones = store.replaceZones("front", [
            { name: "trash room door", kind: "door", points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }] }
        ]);
        assert.equal(zones.length, 1);
        assert.equal(zones[0].points.length, 3);
        store.replaceZones("front", []);
        assert.equal(store.listZones("front").length, 0);

        const profile = store.createProfile({ name: "Jared", clearance: 3 });
        assert.equal(profile.name, "Jared");
        store.addFaceSample({ profileId: profile.id, imagePath: "faces/1/a.jpg", source: "upload" });
        assert.equal(store.getProfile(profile.id).sample_count, 1);

        store.deleteProfile(profile.id);
        assert.equal(store.getProfile(profile.id), null);
        assert.equal(store.listFaceSamples(profile.id).length, 0, "samples cascade");

        store.close();
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("Store: hardware image controls persist per camera", () => {
    // V4L2 values live in the camera's driver and vanish when the Pi reboots,
    // so the hub has to hold them or a power cut silently undoes the tuning.
    const { path: dbPath, dir } = tmpDb();
    try {
        const store = new Store({ dbPath, logger: silentLog }).open();

        assert.deepEqual(store.getHardwareControls("front"), {}, "empty by default");

        store.putHardwareControls("front", { brightness: 20, contrast: 48 });
        assert.deepEqual(store.getHardwareControls("front"), { brightness: 20, contrast: 48 });

        // A partial update must merge, not replace — moving one slider should
        // not clear every other control.
        const merged = store.putHardwareControls("front", { brightness: -10 });
        assert.deepEqual(merged, { brightness: -10, contrast: 48 });

        // Cameras are independent.
        store.putHardwareControls("porch", { gain: 5 });
        assert.deepEqual(store.getHardwareControls("porch"), { gain: 5 });
        assert.deepEqual(store.getHardwareControls("front"), { brightness: -10, contrast: 48 });

        store.clearHardwareControls("front");
        assert.deepEqual(store.getHardwareControls("front"), {});
        assert.deepEqual(store.getHardwareControls("porch"), { gain: 5 }, "unaffected");

        store.close();
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("Store: hardware controls survive a reopen and never collide with settings", () => {
    const { path: dbPath, dir } = tmpDb();
    try {
        const first = new Store({ dbPath, logger: silentLog }).open();
        first.putHardwareControls("front", { brightness: 12 });
        first.putSetting("front", "image.rotation", "90");
        first.close();

        const second = new Store({ dbPath, logger: silentLog }).open();
        assert.deepEqual(second.getHardwareControls("front"), { brightness: 12 });

        // The blob is stored in the settings table but must not surface as a
        // schema setting, or SettingsService would reject it as unknown.
        const schemaKeys = second.allSettings().map((s) => s.key);
        assert.ok(schemaKeys.includes("image.rotation"));
        assert.ok(
            schemaKeys.every((k) => !k.startsWith("_") || k === "_hardwareControls"),
            "reserved keys are prefixed so they cannot collide"
        );
        second.close();
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("Store: continuous segments index, query and evict in order", () => {
    const { path: dbPath, dir } = tmpDb();
    try {
        const store = new Store({ dbPath, logger: silentLog }).open();
        const base = Date.now() - 3_600_000;

        const ids = [0, 1, 2].map((i) => store.insertRecording({
            camId: "front",
            path: `continuous/front/seg-${i}.mp4`,
            startedAtMs: base + i * 300_000,
            endedAtMs: base + (i + 1) * 300_000,
            bytes: 1000 * (i + 1)
        }));

        // Re-indexing is expected — the indexer re-scans the directory
        // periodically and must not create duplicates.
        store.insertRecording({
            camId: "front", path: "continuous/front/seg-0.mp4",
            startedAtMs: base, endedAtMs: base + 300_000, bytes: 1234
        });
        assert.equal(store.recordingStats().segments, 3, "re-indexing must be idempotent");
        assert.equal(store.getRecording(ids[0]).bytes, 1234, "but it does refresh the size");

        // Overlap, not containment: a window starting mid-segment must still
        // find it, or scrubbing to 10:32 would miss the segment from 10:30.
        const mid = store.queryRecordings({
            camId: "front", fromMs: base + 400_000, toMs: base + 450_000
        });
        assert.equal(mid.length, 1);
        assert.equal(mid[0].id, ids[1]);

        assert.equal(store.recordingAt("front", base + 150_000).id, ids[0]);
        assert.equal(store.recordingAt("front", base + 99_000_000), null);

        // Eviction order is oldest-first.
        assert.deepEqual(store.evictableRecordings().map((r) => r.id), ids);

        store.deleteRecording(ids[0]);
        assert.equal(store.getRecording(ids[0]), null);
        assert.equal(store.recordingStats().segments, 2);

        store.close();
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("Store: saved segments are excluded from eviction but still counted", () => {
    // Saved footage has to stay visible in usage totals — otherwise the budget
    // silently under-reports and the disk fills anyway.
    const { path: dbPath, dir } = tmpDb();
    try {
        const store = new Store({ dbPath, logger: silentLog }).open();
        const base = Date.now() - 600_000;

        const keep = store.insertRecording({
            camId: "front", path: "c/keep.mp4",
            startedAtMs: base, endedAtMs: base + 300_000, bytes: 5000
        });
        const roll = store.insertRecording({
            camId: "front", path: "c/roll.mp4",
            startedAtMs: base + 300_000, endedAtMs: base + 600_000, bytes: 7000
        });

        store.setRecordingProtected(keep, true, "someone at the door");

        assert.deepEqual(store.evictableRecordings().map((r) => r.id), [roll]);

        const stats = store.recordingStats();
        assert.equal(stats.segments, 2);
        assert.equal(stats.bytes, 12_000, "saved bytes still count toward usage");
        assert.equal(stats.protected_bytes, 5000);
        assert.equal(stats.protected_segments, 1);
        assert.equal(store.getRecording(keep).label, "someone at the door");

        // Releasing puts it back in the eviction pool.
        store.setRecordingProtected(keep, false);
        assert.equal(store.evictableRecordings().length, 2);

        store.close();
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("Store: saving a range protects every segment it overlaps", () => {
    const { path: dbPath, dir } = tmpDb();
    try {
        const store = new Store({ dbPath, logger: silentLog }).open();
        const base = 1_700_000_000_000;

        for (let i = 0; i < 4; i += 1) {
            store.insertRecording({
                camId: "front", path: `c/${i}.mp4`,
                startedAtMs: base + i * 300_000,
                endedAtMs: base + (i + 1) * 300_000,
                bytes: 1000
            });
        }

        // A range landing inside segments 1 and 2.
        const changed = store.protectRecordingRange(
            "front", base + 400_000, base + 700_000, true, "kept"
        );
        assert.equal(changed, 2);

        const saved = store.evictableRecordings();
        assert.equal(saved.length, 2, "the two overlapped segments came out of the pool");

        store.close();
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("Store: migrates an existing v1 database in place", () => {
    // An installed hub upgrading must not need its events.db wiped.
    const { path: dbPath, dir } = tmpDb();
    try {
        const Database = require("better-sqlite3");
        const db = new Database(dbPath);
        db.exec(`
            CREATE TABLE events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                cam_id TEXT NOT NULL, type TEXT NOT NULL,
                started_at_ms INTEGER NOT NULL, ended_at_ms INTEGER,
                duration_ms INTEGER, detection_count INTEGER NOT NULL DEFAULT 0,
                max_confidence REAL, clip_path TEXT, metadata_json TEXT
            );
        `);
        db.prepare(
            "INSERT INTO events (cam_id, type, started_at_ms, ended_at_ms, duration_ms) VALUES (?,?,?,?,?)"
        ).run("front", "person", 1000, 5000, 4000);
        db.pragma("user_version = 1");
        db.close();

        const store = new Store({ dbPath, logger: silentLog }).open();
        const events = store.queryEvents({});

        assert.equal(events.length, 1, "the pre-existing event survives");
        assert.equal(events[0].cam_id, "front");
        assert.equal(events[0].description, null, "new columns exist and default to null");
        assert.equal(events[0].clip_pruned, false);

        // New tables from later migrations are usable.
        store.putSetting("global", "recording.crf", 24);
        assert.equal(store.allSettings().length, 1);

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
