"use strict";

/**
 * Clip retention and disk protection.
 *
 * ============================================================================
 *  Three limits, because one isn't enough
 * ============================================================================
 *
 * The hub typically runs on a Pi with a 64 GB card that is also holding the OS.
 * Age-based retention alone does not protect that: a busy week fills the card
 * long before day 14, and a full card doesn't just stop recording — it breaks
 * SQLite writes, journald, and anything else that needs to put a byte down.
 *
 *   retentionDays  delete events (rows + files) older than N days
 *   maxTotalGB     a budget for clips; over it, reclaim oldest-first
 *   minFreeGB      a floor on the filesystem itself
 *
 * The budget reclaims *video* but keeps the *event row*. Losing footage from six
 * weeks ago is acceptable; losing the record that anything happened is not, and
 * rows cost a few hundred bytes each.
 *
 * If pruning everything still can't get above `minFreeGB`, recording pauses
 * while detection and event logging carry on. A hub that keeps telling you what
 * happened is far more useful than one that wedged itself trying to write video
 * onto a full disk.
 *
 * The sweep runs every 15 minutes by default and again after every clip
 * finalizes. The old 6-hour cadence was too coarse to protect a small card —
 * you can write a lot of video in six hours.
 */

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

const { expandHome } = require("./store");

const GB = 1024 * 1024 * 1024;
const BACKUP_KEEP = 7;
const USAGE_CACHE_MS = 30_000;

class StorageManager {
    /**
     * @param {object} opts
     * @param {object} opts.store
     * @param {object} opts.settings   SettingsService.
     * @param {string} opts.clipsRoot
     * @param {string} opts.dbPath
     * @param {object} [opts.logger]
     */
    constructor({ store, settings, clipsRoot, dbPath, logger }) {
        if (!store) throw new Error("StorageManager: store is required");
        if (!settings) throw new Error("StorageManager: settings is required");

        this.store = store;
        this.settings = settings;
        this.clipsRoot = expandHome(clipsRoot || "~/Videos/SecurityLux");
        this.dbPath = expandHome(dbPath || "~/.securityluxhub/events.db");
        this.log = logger || console;

        this.recordingPaused = false;
        this.pausedReason = null;
        this.lastSweepAt = 0;
        this.lastSweepResult = null;

        this._timer = null;
        this._backupTimer = null;
        this._sweeping = false;
        this._usageCache = null;
        this._usageCachedAt = 0;
    }

    start() {
        // Create clipsRoot up front. Without it `statfs` fails on a fresh
        // install and the free-space floor silently never engages — which is
        // exactly the install where a full disk is most likely to surprise you.
        try {
            fs.mkdirSync(this.clipsRoot, { recursive: true });
        } catch (err) {
            this.log.error(`[hub] cannot create clips directory ${this.clipsRoot}: ${err.message}`);
        }
        this._scheduleSweep();
        this._scheduleBackup();
        // First sweep shortly after boot rather than immediately — let the hub
        // finish coming up before touching the disk.
        setTimeout(() => this.sweep().catch(() => { /* logged inside */ }), 20_000).unref?.();
    }

    stop() {
        if (this._timer) { clearInterval(this._timer); this._timer = null; }
        if (this._backupTimer) { clearInterval(this._backupTimer); this._backupTimer = null; }
    }

    /** Re-arm the timer when the interval setting changes. */
    _scheduleSweep() {
        if (this._timer) clearInterval(this._timer);
        const minutes = this.settings.get("storage.sweepIntervalMinutes");
        this._timer = setInterval(
            () => this.sweep().catch(() => { /* logged inside */ }),
            Math.max(1, minutes) * 60_000
        );
        this._timer.unref?.();
    }

    _scheduleBackup() {
        if (this._backupTimer) clearInterval(this._backupTimer);
        this._backupTimer = setInterval(() => this.backup(), 24 * 60 * 60 * 1000);
        this._backupTimer.unref?.();
    }

    onSettingsChanged(changed) {
        if (changed.includes("storage.sweepIntervalMinutes")) this._scheduleSweep();
        if (changed.some((k) => k.startsWith("storage."))) {
            this._usageCache = null;
            this.sweep().catch(() => { /* logged inside */ });
        }
    }

    // ==================================================================
    //  Usage
    // ==================================================================

    /**
     * Filesystem free/total for the clips volume.
     * `fs.statfs` landed in Node 18.15; on anything older we return nulls and
     * the free-space floor is simply not enforced rather than crashing.
     */
    async diskInfo() {
        if (typeof fsp.statfs !== "function") {
            return { totalBytes: null, freeBytes: null, available: false };
        }
        try {
            const st = await fsp.statfs(this.clipsRoot);
            return {
                totalBytes: st.blocks * st.bsize,
                freeBytes: st.bavail * st.bsize,
                available: true
            };
        } catch (err) {
            // The directory may not exist yet on a fresh install.
            return { totalBytes: null, freeBytes: null, available: false };
        }
    }

    /**
     * Actual bytes on disk under clipsRoot. Walks the tree rather than trusting
     * the DB's `clip_bytes`, because orphaned files (a hub killed mid-clip, a
     * manual copy dropped in) are exactly the thing that silently fills a card.
     * Cached briefly so the dashboard polling doesn't re-walk constantly.
     */
    async measureClips({ force } = {}) {
        const now = Date.now();
        if (!force && this._usageCache && now - this._usageCachedAt < USAGE_CACHE_MS) {
            return this._usageCache;
        }
        let bytes = 0;
        let files = 0;
        let oldestMs = null;
        const walk = async (dir) => {
            let entries;
            try { entries = await fsp.readdir(dir, { withFileTypes: true }); }
            catch (_) { return; }
            for (const entry of entries) {
                const abs = path.join(dir, entry.name);
                if (entry.isDirectory()) { await walk(abs); continue; }
                try {
                    const st = await fsp.stat(abs);
                    bytes += st.size;
                    files += 1;
                    if (oldestMs === null || st.mtimeMs < oldestMs) oldestMs = st.mtimeMs;
                } catch (_) { /* vanished mid-walk; fine */ }
            }
        };
        await walk(this.clipsRoot);
        this._usageCache = { bytes, files, oldestMs };
        this._usageCachedAt = now;
        return this._usageCache;
    }

    /** Everything the storage page needs, in one payload. */
    async stats() {
        const [disk, clips] = await Promise.all([this.diskInfo(), this.measureClips()]);
        const byCam = this.store.clipBytesByCam();
        const eventCount = this.store.countEvents();
        const oldestEventMs = this.store.oldestEventMs();
        const reel = this.store.recordingStats();
        const reelByCam = this.store.recordingBytesByCam();

        return {
            clipsRoot: this.clipsRoot,
            totalBytes: disk.totalBytes,
            freeBytes: disk.freeBytes,
            diskStatsAvailable: disk.available,
            continuous: {
                segments: reel.segments || 0,
                bytes: reel.bytes || 0,
                protectedBytes: reel.protected_bytes || 0,
                protectedSegments: reel.protected_segments || 0,
                oldestMs: reel.oldest_ms || null,
                newestMs: reel.newest_ms || null,
                byCam: reelByCam,
                maxGB: this.settings.get("storage.continuousMaxGB"),
                // How far back the reel actually reaches. This is the number
                // people care about — "can I still see last Tuesday?"
                coverageDays: reel.oldest_ms
                    ? Math.round(((reel.newest_ms || Date.now()) - reel.oldest_ms) / 86_400_000 * 10) / 10
                    : 0
            },
            clipBytes: clips.bytes,
            clipFiles: clips.files,
            byCam,
            eventCount,
            oldestEventMs,
            limits: {
                retentionDays: this.settings.get("storage.retentionDays"),
                maxTotalGB: this.settings.get("storage.maxTotalGB"),
                minFreeGB: this.settings.get("storage.minFreeGB")
            },
            recordingPaused: this.recordingPaused,
            pausedReason: this.pausedReason,
            lastSweepAt: this.lastSweepAt,
            lastSweepResult: this.lastSweepResult,
            projectedDaysRemaining: this._projectDays(clips, disk, oldestEventMs)
        };
    }

    /**
     * Rough runway at the current recording rate.
     *
     * Deliberately conservative: it uses whichever headroom is smaller, the
     * clip budget or actual free disk. A number that says "3 days" when the
     * budget still has room but the disk does not is the useful answer.
     */
    _projectDays(clips, disk, oldestEventMs) {
        if (!oldestEventMs || !clips.bytes) return null;
        const days = (Date.now() - oldestEventMs) / 86_400_000;
        if (days < 0.5) return null;             // too little history to extrapolate
        const bytesPerDay = clips.bytes / days;
        if (bytesPerDay <= 0) return null;

        const maxTotalGB = this.settings.get("storage.maxTotalGB");
        const minFreeGB = this.settings.get("storage.minFreeGB");

        const budgetHeadroom = maxTotalGB > 0
            ? Math.max(0, maxTotalGB * GB - clips.bytes)
            : Infinity;
        const diskHeadroom = disk.available
            ? Math.max(0, disk.freeBytes - minFreeGB * GB)
            : Infinity;

        const headroom = Math.min(budgetHeadroom, diskHeadroom);
        if (!isFinite(headroom)) return null;
        return Math.round((headroom / bytesPerDay) * 10) / 10;
    }

    // ==================================================================
    //  Sweep
    // ==================================================================

    /**
     * Enforce all three limits. Safe to call as often as you like; overlapping
     * calls collapse into one.
     */
    async sweep({ manual } = {}) {
        if (this._sweeping) return this.lastSweepResult || { skipped: "already running" };
        this._sweeping = true;

        const result = {
            rowsDeleted: 0,
            clipsDeleted: 0,
            segmentsDeleted: 0,
            bytesReclaimed: 0,
            reason: [],
            recordingPaused: false
        };

        try {
            // Order matters and encodes the policy: continuous footage is the
            // disposable layer, so it is always reclaimed before anything
            // touches event clips. Getting this backwards would mean a busy
            // week silently pushed out the footage you actually wanted.
            await this._sweepContinuousByAge(result);
            await this._sweepContinuousByBudget(result);
            await this._sweepByAge(result);
            await this._sweepByBudget(result);
            await this._sweepByFreeSpace(result);

            this._usageCache = null;
            await this._pruneEmptyDirs();

            this.lastSweepAt = Date.now();
            this.lastSweepResult = result;

            if (result.rowsDeleted || result.clipsDeleted || result.segmentsDeleted || manual) {
                this.log.info(
                    `[hub] storage sweep: ${result.rowsDeleted} rows, ${result.clipsDeleted} clips, ` +
                    `${result.segmentsDeleted} segments, ` +
                    `${formatBytes(result.bytesReclaimed)} reclaimed` +
                    (result.reason.length ? ` (${result.reason.join(", ")})` : "")
                );
            }
            return result;
        } catch (err) {
            this.log.warn(`[hub] storage sweep failed: ${err && err.message}`);
            return { ...result, error: err && err.message };
        } finally {
            this._sweeping = false;
        }
    }

    /**
     * Age out continuous footage, if an age limit is set at all.
     *
     * Off by default — the budget is the primary control, because "how many
     * days do I get" is a consequence of disk size and quality rather than
     * something most people want to pin directly.
     */
    async _sweepContinuousByAge(result) {
        const days = this.settings.get("storage.continuousRetentionDays");
        if (!days || days <= 0) return;

        const cutoff = Date.now() - days * 86_400_000;
        const stale = this.store.recordingsOlderThan(cutoff);
        if (!stale.length) return;

        for (const recording of stale) {
            result.bytesReclaimed += await this._unlinkRecording(recording);
            result.segmentsDeleted = (result.segmentsDeleted || 0) + 1;
        }
        result.reason.push(`continuous older than ${days}d`);
    }

    /**
     * Keep the reel inside its byte budget, oldest first.
     *
     * `evictableRecordings` excludes protected segments by construction, so
     * saved moments can never be taken here — that distinction is the whole
     * point of being able to save something.
     */
    async _sweepContinuousByBudget(result) {
        const maxGB = this.settings.get("storage.continuousMaxGB");
        if (!maxGB || maxGB <= 0) return;
        const budget = maxGB * GB;

        const stats = this.store.recordingStats();
        if (!stats || stats.bytes <= budget) return;

        let over = stats.bytes - budget;
        const candidates = this.store.evictableRecordings();
        let deleted = 0;

        for (const recording of candidates) {
            if (over <= 0) break;
            const freed = await this._unlinkRecording(recording);
            over -= freed || (recording.bytes || 0);
            result.bytesReclaimed += freed;
            deleted += 1;
        }

        result.segmentsDeleted = (result.segmentsDeleted || 0) + deleted;
        result.reason.push(`continuous over ${maxGB} GB`);

        // Everything left is protected and the reel is still over budget. Say
        // so once — silently continuing to write past the budget is the kind
        // of thing that fills a card weeks later.
        if (over > 0) {
            this.log.warn(
                `[hub] continuous footage is ${formatBytes(over)} over its ${maxGB} GB budget ` +
                "and everything remaining is saved. Unsave some footage or raise the budget."
            );
        }
    }

    /** Remove a segment's file and its row. Returns bytes actually freed. */
    async _unlinkRecording(recording) {
        let freed = 0;
        const abs = this.resolveClipPath(recording.path);
        if (abs) {
            try {
                const stat = await fsp.stat(abs);
                await fsp.unlink(abs);
                freed = stat.size;
            } catch (err) {
                if (err.code !== "ENOENT") {
                    this.log.warn(`[hub] failed to unlink ${abs}: ${err.message}`);
                }
            }
        }
        // Drop the row even if the file was already gone, or a missing file
        // would keep being "reclaimed" forever without freeing anything.
        try { this.store.deleteRecording(recording.id); } catch (_) { /* ignore */ }
        return freed;
    }

    async _sweepByAge(result) {
        const days = this.settings.get("storage.retentionDays");
        if (!days || days <= 0) return;
        const cutoff = Date.now() - days * 86_400_000;

        const rows = this.store.eventsOlderThan(cutoff);
        if (!rows.length) return;

        for (const row of rows) {
            result.bytesReclaimed += await this._unlinkEventFiles(row);
            if (row.clip_path) result.clipsDeleted += 1;
        }
        result.rowsDeleted += this.store.deleteEventsOlderThan(cutoff);
        result.reason.push(`older than ${days}d`);
    }

    async _sweepByBudget(result) {
        const maxGB = this.settings.get("storage.maxTotalGB");
        if (!maxGB || maxGB <= 0) return;
        const budget = maxGB * GB;

        const usage = await this.measureClips({ force: true });
        if (usage.bytes <= budget) return;

        let over = usage.bytes - budget;
        const candidates = this.store.clipsOldestFirst();
        for (const row of candidates) {
            if (over <= 0) break;
            const freed = await this._unlinkEventFiles(row);
            this.store.markClipPruned(row.id);
            over -= freed;
            result.bytesReclaimed += freed;
            result.clipsDeleted += 1;
        }
        result.reason.push(`over ${maxGB} GB budget`);
    }

    /**
     * The last line of defence. Prunes oldest-first until the floor is
     * satisfied; if it runs out of clips and is still below, recording pauses.
     */
    async _sweepByFreeSpace(result) {
        const minFreeGB = this.settings.get("storage.minFreeGB");
        if (!minFreeGB || minFreeGB <= 0) {
            this._resume();
            return;
        }
        const floor = minFreeGB * GB;

        let disk = await this.diskInfo();
        if (!disk.available) { this._resume(); return; }
        if (disk.freeBytes >= floor) { this._resume(); return; }

        result.reason.push(`below ${minFreeGB} GB free`);

        // Continuous footage first, for the same reason as the budget sweep:
        // it is the layer you can afford to lose. Only once the reel is gone
        // do we start taking event clips.
        for (const recording of this.store.evictableRecordings()) {
            const freed = await this._unlinkRecording(recording);
            result.bytesReclaimed += freed;
            result.segmentsDeleted += 1;
            if (result.segmentsDeleted % 20 === 0) {
                disk = await this.diskInfo();
                if (disk.available && disk.freeBytes >= floor) break;
            }
        }

        disk = await this.diskInfo();
        if (disk.available && disk.freeBytes >= floor) { this._resume(); return; }

        const candidates = this.store.clipsOldestFirst();
        for (const row of candidates) {
            const freed = await this._unlinkEventFiles(row);
            this.store.markClipPruned(row.id);
            result.bytesReclaimed += freed;
            result.clipsDeleted += 1;

            // Re-stat every 20 deletions rather than every one — statfs is a
            // syscall and this loop can be long on a badly-full disk.
            if (result.clipsDeleted % 20 === 0) {
                disk = await this.diskInfo();
                if (disk.available && disk.freeBytes >= floor) break;
            }
        }

        disk = await this.diskInfo();
        if (disk.available && disk.freeBytes < floor) {
            this._pause(
                `Only ${formatBytes(disk.freeBytes)} free, below the ${minFreeGB} GB reserve. ` +
                "Events are still being logged, but new clips are not being written."
            );
            result.recordingPaused = true;
        } else {
            this._resume();
        }
    }

    _pause(reason) {
        if (!this.recordingPaused) this.log.warn(`[hub] recording paused: ${reason}`);
        this.recordingPaused = true;
        this.pausedReason = reason;
    }

    _resume() {
        if (this.recordingPaused) this.log.info("[hub] recording resumed; free space recovered");
        this.recordingPaused = false;
        this.pausedReason = null;
    }

    /** Remove an event's clip and thumbnail. Returns bytes actually freed. */
    async _unlinkEventFiles(row) {
        let freed = 0;
        for (const rel of [row.clip_path, row.thumb_path]) {
            if (!rel) continue;
            const abs = this.resolveClipPath(rel);
            if (!abs) continue;
            try {
                const st = await fsp.stat(abs);
                await fsp.unlink(abs);
                freed += st.size;
            } catch (err) {
                if (err.code !== "ENOENT") {
                    this.log.warn(`[hub] failed to unlink ${abs}: ${err.message}`);
                }
            }
        }
        return freed;
    }

    /**
     * Resolve a stored relative path, refusing anything that escapes clipsRoot.
     * The DB is ours, but a path-traversal check on every filesystem operation
     * derived from stored data is cheap and means a corrupted row can't reach
     * outside the media directory.
     */
    resolveClipPath(relPath) {
        if (!relPath) return null;
        const root = path.resolve(this.clipsRoot);
        const abs = path.resolve(root, relPath);
        if (abs !== root && !abs.startsWith(root + path.sep)) return null;
        return abs;
    }

    async _pruneEmptyDirs() {
        let entries;
        try { entries = await fsp.readdir(this.clipsRoot, { withFileTypes: true }); }
        catch (_) { return; }
        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const abs = path.join(this.clipsRoot, entry.name);
            try {
                const contents = await fsp.readdir(abs);
                if (contents.length === 0) await fsp.rmdir(abs);
            } catch (err) {
                if (err.code !== "ENOENT" && err.code !== "ENOTEMPTY") {
                    this.log.warn(`[hub] failed to rmdir ${abs}: ${err.message}`);
                }
            }
        }
    }

    /** Should a new recording be allowed to start right now? */
    canRecord() {
        return !this.recordingPaused;
    }

    // ==================================================================
    //  Backup
    // ==================================================================

    /**
     * Nightly snapshot of events.db, keeping the last 7.
     *
     * Clips are replaceable — footage from last Tuesday isn't coming back but
     * nothing depends on it. Your zone definitions, settings, and enrolled
     * profiles are hand-made and irreplaceable, and they all live in this file.
     */
    backup() {
        if (!this.settings.get("storage.backupEnabled")) return null;
        const dir = path.join(path.dirname(this.dbPath), "backups");
        const stamp = new Date().toISOString().slice(0, 10);
        const dest = path.join(dir, `events-${stamp}.db`);

        try {
            if (fs.existsSync(dest)) return dest;    // already ran today
            this.store.backupTo(dest);
            this.log.info(`[hub] database backup written to ${dest}`);
        } catch (err) {
            this.log.warn(`[hub] database backup failed: ${err && err.message}`);
            return null;
        }

        try {
            const files = fs.readdirSync(dir)
                .filter((f) => /^events-\d{4}-\d{2}-\d{2}\.db$/.test(f))
                .sort();
            for (const stale of files.slice(0, Math.max(0, files.length - BACKUP_KEEP))) {
                fs.unlinkSync(path.join(dir, stale));
            }
        } catch (err) {
            this.log.warn(`[hub] backup rotation failed: ${err && err.message}`);
        }
        return dest;
    }
}

function formatBytes(n) {
    if (!n) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    let v = n;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
    return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

module.exports = { StorageManager, formatBytes };
