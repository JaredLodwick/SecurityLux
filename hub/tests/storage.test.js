"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { Store } = require("../src/store");
const { SettingsService } = require("../src/settings");
const { StorageManager, formatBytes } = require("../src/storage");

const quiet = { info() {}, warn() {}, error() {} };
const MB = 1024 * 1024;
const GB = 1024 * MB;

function makeHarness(settingOverrides = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "securitylux-storage-"));
    const clipsRoot = path.join(dir, "clips");
    const dbPath = path.join(dir, "events.db");

    const store = new Store({ dbPath, logger: quiet }).open();
    const settings = new SettingsService({ store, fileCfg: {}, logger: quiet });
    settings.set(settingOverrides);

    const storage = new StorageManager({ store, settings, clipsRoot, dbPath, logger: quiet });
    fs.mkdirSync(clipsRoot, { recursive: true });

    /** Write a clip file and its event row. */
    function addClip({ camId = "front", ageDays = 0, bytes = MB, thumb = true }) {
        const startedAt = Date.now() - ageDays * 86_400_000;
        const dateDir = new Date(startedAt).toISOString().slice(0, 10);
        const base = `${String(startedAt).slice(-9)}_${camId}_person`;
        const clipRel = path.join(dateDir, `${base}.mp4`);
        const thumbRel = path.join(dateDir, `${base}.jpg`);

        fs.mkdirSync(path.join(clipsRoot, dateDir), { recursive: true });
        fs.writeFileSync(path.join(clipsRoot, clipRel), Buffer.alloc(bytes, 7));
        if (thumb) fs.writeFileSync(path.join(clipsRoot, thumbRel), Buffer.alloc(1024, 7));

        const id = store.insertSession({ camId, type: "person", startedAtMs: startedAt });
        store.finalizeSession({
            id, endedAtMs: startedAt + 5000, detectionCount: 4, maxConfidence: 0.9,
            clipPath: clipRel, thumbPath: thumb ? thumbRel : null, clipBytes: bytes,
            description: "Someone was at the front door."
        });
        return { id, clipRel, thumbRel };
    }

    return {
        store, settings, storage, clipsRoot, addClip,
        exists: (rel) => fs.existsSync(path.join(clipsRoot, rel)),
        cleanup: () => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
    };
}

test("age-based retention deletes old events and their files", async () => {
    const h = makeHarness({ "storage.retentionDays": 14, "storage.maxTotalGB": 0, "storage.minFreeGB": 0 });
    try {
        const old = h.addClip({ ageDays: 30 });
        const fresh = h.addClip({ ageDays: 1 });

        const result = await h.storage.sweep();

        assert.equal(result.rowsDeleted, 1);
        assert.equal(h.store.getEvent(old.id), null);
        assert.ok(h.store.getEvent(fresh.id));
        assert.equal(h.exists(old.clipRel), false);
        assert.equal(h.exists(old.thumbRel), false, "thumbnails are reclaimed too");
        assert.equal(h.exists(fresh.clipRel), true);
    } finally { h.cleanup(); }
});

test("retentionDays of 0 disables age-based cleanup", async () => {
    const h = makeHarness({ "storage.retentionDays": 0, "storage.maxTotalGB": 0, "storage.minFreeGB": 0 });
    try {
        const ancient = h.addClip({ ageDays: 900 });
        await h.storage.sweep();
        assert.ok(h.store.getEvent(ancient.id), "nothing should be deleted by age");
    } finally { h.cleanup(); }
});

test("the budget reclaims oldest clips first but keeps the event rows", async () => {
    // 6 MB of clips against a 4 MB budget.
    const h = makeHarness({
        "storage.retentionDays": 0,
        "storage.maxTotalGB": 4 / 1024,
        "storage.minFreeGB": 0
    });
    try {
        const oldest = h.addClip({ ageDays: 5, bytes: 2 * MB });
        const middle = h.addClip({ ageDays: 3, bytes: 2 * MB });
        const newest = h.addClip({ ageDays: 1, bytes: 2 * MB });

        const result = await h.storage.sweep();

        assert.ok(result.clipsDeleted >= 1, "something should have been reclaimed");
        assert.equal(h.exists(oldest.clipRel), false, "oldest video goes first");
        assert.equal(h.exists(newest.clipRel), true, "newest video is kept");

        // The whole point of the budget: you lose footage, not history.
        for (const entry of [oldest, middle, newest]) {
            assert.ok(h.store.getEvent(entry.id), "every event row survives");
        }
        assert.equal(h.store.getEvent(oldest.id).clip_pruned, true);
        assert.equal(h.store.getEvent(oldest.id).description, "Someone was at the front door.");
    } finally { h.cleanup(); }
});

test("maxTotalGB of 0 disables the budget", async () => {
    const h = makeHarness({
        "storage.retentionDays": 0, "storage.maxTotalGB": 0, "storage.minFreeGB": 0
    });
    try {
        const clip = h.addClip({ bytes: 4 * MB });
        await h.storage.sweep();
        assert.equal(h.exists(clip.clipRel), true);
    } finally { h.cleanup(); }
});

test("pauses recording when the free-space floor cannot be met", async () => {
    const h = makeHarness({
        "storage.retentionDays": 0, "storage.maxTotalGB": 0, "storage.minFreeGB": 100
    });
    try {
        h.addClip({ bytes: MB });
        // Pretend the disk is nearly full regardless of the real filesystem.
        h.storage.diskInfo = async () => ({
            totalBytes: 64 * GB, freeBytes: 1 * GB, available: true
        });

        assert.equal(h.storage.canRecord(), true);
        const result = await h.storage.sweep();

        assert.equal(result.recordingPaused, true);
        assert.equal(h.storage.canRecord(), false, "new clips must stop");
        assert.match(h.storage.pausedReason, /reserve/i);
    } finally { h.cleanup(); }
});

test("resumes recording once space is recovered", async () => {
    const h = makeHarness({
        "storage.retentionDays": 0, "storage.maxTotalGB": 0, "storage.minFreeGB": 100
    });
    try {
        h.storage.diskInfo = async () => ({ totalBytes: 64 * GB, freeBytes: 1 * GB, available: true });
        await h.storage.sweep();
        assert.equal(h.storage.canRecord(), false);

        // Comfortably above the 100 GB floor.
        h.storage.diskInfo = async () => ({ totalBytes: 512 * GB, freeBytes: 300 * GB, available: true });
        await h.storage.sweep();

        assert.equal(h.storage.canRecord(), true);
        assert.equal(h.storage.pausedReason, null);
    } finally { h.cleanup(); }
});

test("never pauses when disk stats are unavailable", async () => {
    // Node < 18.15 has no fs.statfs. Degrade to "don't enforce the floor",
    // not to "refuse to record".
    const h = makeHarness({ "storage.minFreeGB": 100 });
    try {
        h.storage.diskInfo = async () => ({ totalBytes: null, freeBytes: null, available: false });
        await h.storage.sweep();
        assert.equal(h.storage.canRecord(), true);
    } finally { h.cleanup(); }
});

test("measures actual bytes on disk, including orphaned files", async () => {
    // A hub killed mid-clip leaves a file with no row. That still fills the
    // card, so usage must come from the filesystem, not from the database.
    const h = makeHarness();
    try {
        h.addClip({ bytes: MB });
        fs.writeFileSync(path.join(h.clipsRoot, "orphan.mp4"), Buffer.alloc(2 * MB, 3));

        const usage = await h.storage.measureClips({ force: true });
        assert.ok(usage.bytes >= 3 * MB, `expected >=3MB, got ${usage.bytes}`);
        assert.ok(usage.files >= 3);
    } finally { h.cleanup(); }
});

test("refuses to resolve a path outside clipsRoot", () => {
    const h = makeHarness();
    try {
        assert.equal(h.storage.resolveClipPath("../../etc/passwd"), null);
        assert.equal(h.storage.resolveClipPath("/etc/passwd"), null);
        assert.ok(h.storage.resolveClipPath("2026-01-01/clip.mp4"));
    } finally { h.cleanup(); }
});

test("stats reports the limits and a usage breakdown per camera", async () => {
    const h = makeHarness({ "storage.retentionDays": 30, "storage.maxTotalGB": 8 });
    try {
        h.addClip({ camId: "front", bytes: 2 * MB });
        h.addClip({ camId: "porch", bytes: MB });

        const stats = await h.storage.stats();

        assert.equal(stats.limits.retentionDays, 30);
        assert.equal(stats.limits.maxTotalGB, 8);
        assert.equal(stats.eventCount, 2);
        assert.equal(stats.byCam.length, 2);
        assert.equal(stats.byCam[0].cam_id, "front", "biggest consumer first");
    } finally { h.cleanup(); }
});

test("backup writes a dated copy and is idempotent within a day", () => {
    const h = makeHarness({ "storage.backupEnabled": true });
    try {
        const first = h.storage.backup();
        assert.ok(first && fs.existsSync(first));

        const second = h.storage.backup();
        assert.equal(second, first, "one backup per day, not one per call");

        // The copy must be a usable database, not a truncated file.
        const copy = new Store({ dbPath: first, logger: quiet }).open();
        assert.equal(typeof copy.countEvents(), "number");
        copy.close();
    } finally { h.cleanup(); }
});

test("backup respects the disable switch", () => {
    const h = makeHarness({ "storage.backupEnabled": false });
    try {
        assert.equal(h.storage.backup(), null);
    } finally { h.cleanup(); }
});

test("overlapping sweeps collapse into one", async () => {
    const h = makeHarness();
    try {
        const results = await Promise.all([h.storage.sweep(), h.storage.sweep(), h.storage.sweep()]);
        assert.ok(results.some((r) => r.skipped), "concurrent calls should not both run");
    } finally { h.cleanup(); }
});

test("formatBytes is readable at every scale", () => {
    assert.equal(formatBytes(0), "0 B");
    assert.equal(formatBytes(512), "512 B");
    assert.equal(formatBytes(1536), "1.5 KB");
    assert.equal(formatBytes(5 * GB), "5.0 GB");
});
