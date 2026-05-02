"use strict";

/**
 * SQLite-backed event store for hub-side person detections.
 *
 * One row per detection session. Inserted at session start (so a crash leaves
 * a recoverable trail), updated at session end. Open() runs a startup recovery
 * pass that closes any sessions that didn't get a clean end (e.g. MagicMirror
 * was killed mid-event).
 *
 * Designed for low write rates (a few sessions per hour at most). Reads stay
 * fast via the (cam_id, started_at_ms DESC) index even at hundreds of
 * thousands of rows.
 */

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cam_id TEXT NOT NULL,
    type TEXT NOT NULL,
    started_at_ms INTEGER NOT NULL,
    ended_at_ms INTEGER,
    duration_ms INTEGER,
    detection_count INTEGER NOT NULL DEFAULT 0,
    max_confidence REAL,
    clip_path TEXT,
    metadata_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_cam_started
    ON events (cam_id, started_at_ms DESC);
`;

const QUERY_LIMIT_DEFAULT = 50;
const QUERY_LIMIT_MAX = 200;

function expandHome(p) {
    if (typeof p !== "string") return p;
    if (p === "~") return os.homedir();
    if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
    return p;
}

class Store {
    /**
     * @param {object} opts
     * @param {string} opts.dbPath  Path to events.db (supports leading ~).
     * @param {object} [opts.logger]  { info, warn, error } — defaults to console.
     */
    constructor({ dbPath, logger } = {}) {
        if (!dbPath) throw new Error("Store: dbPath is required");
        this.dbPath = expandHome(dbPath);
        this.log = logger || console;
        this.db = null;
    }

    open() {
        if (this.db) return this;

        // Lazy-require so unit tests can mock the module if needed and so
        // the helper still loads on hosts where better-sqlite3 isn't installed
        // (Detection just won't be available — see ensureServer).
        // eslint-disable-next-line global-require
        const Database = require("better-sqlite3");

        fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
        this.db = new Database(this.dbPath);
        this.db.pragma("journal_mode = WAL");
        this.db.pragma("synchronous = NORMAL");
        this.db.exec(SCHEMA_SQL);

        const recovered = this._recoverOrphanedSessions();
        const total = this.db.prepare("SELECT COUNT(*) AS n FROM events").get().n;
        this.log.info(`[MMM-DoorCam] event store at ${this.dbPath} (${total} events, recovered ${recovered})`);
        return this;
    }

    close() {
        if (this.db) {
            try { this.db.close(); } catch (_) { /* ignore */ }
            this.db = null;
        }
    }

    /**
     * Insert a row for a freshly started session. Returns the new row id.
     */
    insertSession({ camId, type, startedAtMs, metadata }) {
        const stmt = this.db.prepare(`
            INSERT INTO events (cam_id, type, started_at_ms, metadata_json)
            VALUES (?, ?, ?, ?)
        `);
        const meta = metadata ? JSON.stringify(metadata) : null;
        const info = stmt.run(camId, type, startedAtMs, meta);
        return info.lastInsertRowid;
    }

    /**
     * Update a row when a session ends. `clipPath` is relative to clipsRoot.
     */
    finalizeSession({ id, endedAtMs, detectionCount, maxConfidence, clipPath, metadata }) {
        const startRow = this.db.prepare("SELECT started_at_ms FROM events WHERE id = ?").get(id);
        if (!startRow) return false;
        const duration = endedAtMs - startRow.started_at_ms;
        const stmt = this.db.prepare(`
            UPDATE events
               SET ended_at_ms = ?,
                   duration_ms = ?,
                   detection_count = ?,
                   max_confidence = ?,
                   clip_path = ?,
                   metadata_json = COALESCE(?, metadata_json)
             WHERE id = ?
        `);
        const meta = metadata ? JSON.stringify(metadata) : null;
        const info = stmt.run(endedAtMs, duration, detectionCount, maxConfidence, clipPath || null, meta, id);
        return info.changes === 1;
    }

    /**
     * Drop a session row entirely. Used when min-length filter rejects it.
     */
    deleteSession(id) {
        const info = this.db.prepare("DELETE FROM events WHERE id = ?").run(id);
        return info.changes === 1;
    }

    getEvent(id) {
        const row = this.db.prepare("SELECT * FROM events WHERE id = ?").get(id);
        return row ? rowToEvent(row) : null;
    }

    /**
     * Paginated event list, newest-first.
     * @param {object} opts
     * @param {string} [opts.camId]
     * @param {number} [opts.sinceMs]  Only events with started_at_ms > this.
     * @param {number} [opts.limit]
     */
    queryEvents({ camId, sinceMs, limit } = {}) {
        const lim = clampLimit(limit);
        const where = [];
        const args = [];
        if (camId) { where.push("cam_id = ?"); args.push(camId); }
        if (typeof sinceMs === "number") { where.push("started_at_ms > ?"); args.push(sinceMs); }
        const sql = `
            SELECT * FROM events
            ${where.length ? "WHERE " + where.join(" AND ") : ""}
            ORDER BY started_at_ms DESC
            LIMIT ?
        `;
        args.push(lim);
        const rows = this.db.prepare(sql).all(...args);
        return rows.map(rowToEvent);
    }

    /**
     * Delete events older than `retentionDays` along with their clip files.
     * Returns counts for logging. Safe to call frequently.
     */
    retentionSweep({ retentionDays, clipsRoot }) {
        if (!retentionDays || retentionDays <= 0) return { rowsDeleted: 0, clipsDeleted: 0 };
        const cutoff = Date.now() - retentionDays * 86_400_000;
        const rows = this.db.prepare(
            "SELECT id, clip_path FROM events WHERE started_at_ms < ?"
        ).all(cutoff);

        let clipsDeleted = 0;
        const root = clipsRoot ? expandHome(clipsRoot) : null;
        for (const row of rows) {
            if (row.clip_path && root) {
                const abs = path.resolve(root, row.clip_path);
                try {
                    fs.unlinkSync(abs);
                    clipsDeleted += 1;
                } catch (err) {
                    if (err.code !== "ENOENT") {
                        this.log.warn(`[MMM-DoorCam] retention: failed to unlink ${abs}: ${err.message}`);
                    }
                }
            }
        }

        const info = this.db.prepare("DELETE FROM events WHERE started_at_ms < ?").run(cutoff);
        if (root) pruneEmptyClipDirs(root, this.log);

        return { rowsDeleted: info.changes, clipsDeleted };
    }

    _recoverOrphanedSessions() {
        const orphans = this.db.prepare(
            "SELECT id, started_at_ms, metadata_json FROM events WHERE ended_at_ms IS NULL"
        ).all();
        if (orphans.length === 0) return 0;

        const update = this.db.prepare(`
            UPDATE events
               SET ended_at_ms = ?,
                   duration_ms = ?,
                   metadata_json = ?
             WHERE id = ?
        `);
        const tx = this.db.transaction((rows) => {
            for (const r of rows) {
                const ended = r.started_at_ms + 1;
                let meta;
                try { meta = r.metadata_json ? JSON.parse(r.metadata_json) : {}; }
                catch (_) { meta = {}; }
                meta.recovery = true;
                update.run(ended, 1, JSON.stringify(meta), r.id);
            }
        });
        tx(orphans);
        return orphans.length;
    }
}

function clampLimit(limit) {
    if (typeof limit !== "number" || !isFinite(limit) || limit <= 0) return QUERY_LIMIT_DEFAULT;
    return Math.min(Math.floor(limit), QUERY_LIMIT_MAX);
}

function rowToEvent(row) {
    let metadata = null;
    if (row.metadata_json) {
        try { metadata = JSON.parse(row.metadata_json); } catch (_) { metadata = null; }
    }
    return {
        id: row.id,
        cam_id: row.cam_id,
        type: row.type,
        started_at_ms: row.started_at_ms,
        ended_at_ms: row.ended_at_ms,
        duration_ms: row.duration_ms,
        detection_count: row.detection_count,
        max_confidence: row.max_confidence,
        clip_path: row.clip_path,
        metadata
    };
}

function pruneEmptyClipDirs(root, log) {
    // Layout: <root>/<YYYY-MM-DD>/<file>. Walk one level deep and remove any
    // date directory that has no clips left after the row delete.
    let entries;
    try { entries = fs.readdirSync(root, { withFileTypes: true }); }
    catch (_) { return; }
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const abs = path.join(root, entry.name);
        try {
            if (fs.readdirSync(abs).length === 0) fs.rmdirSync(abs);
        } catch (err) {
            if (err.code !== "ENOENT" && err.code !== "ENOTEMPTY") {
                log.warn(`[MMM-DoorCam] retention: failed to rmdir ${abs}: ${err.message}`);
            }
        }
    }
}

module.exports = { Store, expandHome };
