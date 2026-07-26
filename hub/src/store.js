"use strict";

/**
 * SQLite-backed persistence for the hub.
 *
 * Originally this held nothing but detection events, which is why it used to be
 * constructed inside the detection boot path. It now also holds settings,
 * zones, profiles, and face samples — all of which have to work with detection
 * switched off — so `HubServer.start()` opens it unconditionally.
 *
 * Tables:
 *   events        one row per detection session (inserted at start, updated at end)
 *   settings      user overrides, keyed by (scope, key); scope is "global" or a cam_id
 *   zones         named regions drawn on a camera's view
 *   profiles      known people + clearance levels
 *   face_samples  enrolled face embeddings belonging to a profile
 *   cameras       last-known metadata per camera (first/last seen, reconnects)
 *
 * Schema changes go through MIGRATIONS and are tracked with `PRAGMA user_version`,
 * so an existing events.db upgrades in place rather than needing a wipe.
 *
 * Write rate is low (a few sessions an hour). Reads stay fast via the
 * (cam_id, started_at_ms DESC) index even at hundreds of thousands of rows.
 */

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const QUERY_LIMIT_DEFAULT = 50;
const QUERY_LIMIT_MAX = 500;

/**
 * Ordered schema steps. Index + 1 is the resulting `user_version`, so appending
 * a new function is all that's needed to ship a migration. Never edit or
 * reorder an existing entry — someone's DB is already at that version.
 */
const MIGRATIONS = [
    // v1 — the original events table.
    (db) => {
        db.exec(`
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
        `);
    },

    // v2 — descriptions, thumbnails, behavior classification, storage accounting.
    (db) => {
        addColumnIfMissing(db, "events", "description", "TEXT");
        addColumnIfMissing(db, "events", "thumb_path", "TEXT");
        addColumnIfMissing(db, "events", "behavior", "TEXT");
        addColumnIfMissing(db, "events", "zones_json", "TEXT");
        addColumnIfMissing(db, "events", "track_json", "TEXT");
        addColumnIfMissing(db, "events", "clip_bytes", "INTEGER");
        // Set when the retention budget reclaimed the video but kept the row.
        // The history survives even when the footage doesn't.
        addColumnIfMissing(db, "events", "clip_pruned", "INTEGER NOT NULL DEFAULT 0");
        addColumnIfMissing(db, "events", "profile_id", "INTEGER");
        db.exec(`
            CREATE INDEX IF NOT EXISTS idx_events_started ON events (started_at_ms DESC);
            CREATE INDEX IF NOT EXISTS idx_events_clip
                ON events (started_at_ms) WHERE clip_path IS NOT NULL AND clip_pruned = 0;
        `);
    },

    // v3 — settings, zones, profiles, face samples, camera metadata.
    (db) => {
        db.exec(`
            CREATE TABLE IF NOT EXISTS settings (
                scope TEXT NOT NULL,
                key TEXT NOT NULL,
                value_json TEXT NOT NULL,
                updated_at_ms INTEGER NOT NULL,
                PRIMARY KEY (scope, key)
            );

            CREATE TABLE IF NOT EXISTS zones (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                cam_id TEXT NOT NULL,
                name TEXT NOT NULL,
                kind TEXT NOT NULL DEFAULT 'area',
                points_json TEXT NOT NULL,
                sort_order INTEGER NOT NULL DEFAULT 0,
                created_at_ms INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_zones_cam ON zones (cam_id, sort_order);

            CREATE TABLE IF NOT EXISTS profiles (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                clearance INTEGER NOT NULL DEFAULT 0,
                notes TEXT,
                is_anonymous INTEGER NOT NULL DEFAULT 0,
                sighting_count INTEGER NOT NULL DEFAULT 0,
                last_seen_ms INTEGER,
                created_at_ms INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS face_samples (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                profile_id INTEGER NOT NULL,
                embedding BLOB,
                image_path TEXT,
                source TEXT,
                event_id INTEGER,
                created_at_ms INTEGER NOT NULL,
                FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_samples_profile ON face_samples (profile_id);

            CREATE TABLE IF NOT EXISTS cameras (
                cam_id TEXT PRIMARY KEY,
                first_seen_ms INTEGER NOT NULL,
                last_seen_ms INTEGER,
                connect_count INTEGER NOT NULL DEFAULT 0,
                last_offline_alert_ms INTEGER
            );
        `);
    }
];

function expandHome(p) {
    if (typeof p !== "string") return p;
    if (p === "~") return os.homedir();
    if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
    return p;
}

function addColumnIfMissing(db, table, column, ddl) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all();
    if (cols.some((c) => c.name === column)) return;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
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

        // Lazy-require so the hub still boots on a host where better-sqlite3
        // failed to build — the caller surfaces that as a degraded state rather
        // than crashing the process before it can serve the dashboard.
        // eslint-disable-next-line global-require
        const Database = require("better-sqlite3");

        fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
        this.db = new Database(this.dbPath);
        this.db.pragma("journal_mode = WAL");
        this.db.pragma("synchronous = NORMAL");
        this.db.pragma("foreign_keys = ON");

        this._migrate();

        const recovered = this._recoverOrphanedSessions();
        const total = this.db.prepare("SELECT COUNT(*) AS n FROM events").get().n;
        this.log.info(`[hub] event store at ${this.dbPath} (${total} events, recovered ${recovered})`);
        return this;
    }

    close() {
        if (this.db) {
            try { this.db.close(); } catch (_) { /* ignore */ }
            this.db = null;
        }
    }

    _migrate() {
        const current = this.db.pragma("user_version", { simple: true });
        if (current >= MIGRATIONS.length) return;
        for (let v = current; v < MIGRATIONS.length; v += 1) {
            const step = MIGRATIONS[v];
            // Each migration is its own transaction: a failure at v3 leaves a
            // cleanly-at-v2 database rather than a half-applied one.
            const tx = this.db.transaction(() => {
                step(this.db);
                this.db.pragma(`user_version = ${v + 1}`);
            });
            tx();
            this.log.info(`[hub] applied schema migration v${v + 1}`);
        }
    }

    // ==================================================================
    //  Events
    // ==================================================================

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
     * Update a row when a session ends. `clipPath` / `thumbPath` are relative
     * to clipsRoot.
     */
    finalizeSession({
        id, endedAtMs, detectionCount, maxConfidence, clipPath, thumbPath,
        clipBytes, description, behavior, zones, track, metadata
    }) {
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
                   thumb_path = COALESCE(?, thumb_path),
                   clip_bytes = ?,
                   description = ?,
                   behavior = ?,
                   zones_json = ?,
                   track_json = ?,
                   metadata_json = COALESCE(?, metadata_json)
             WHERE id = ?
        `);
        const info = stmt.run(
            endedAtMs,
            duration,
            detectionCount,
            maxConfidence,
            clipPath || null,
            thumbPath || null,
            clipBytes ?? null,
            description || null,
            behavior || null,
            zones ? JSON.stringify(zones) : null,
            track ? JSON.stringify(track) : null,
            metadata ? JSON.stringify(metadata) : null,
            id
        );
        return info.changes === 1;
    }

    /** Attach a thumbnail as soon as it's written, before the session ends. */
    setThumb(id, thumbPath) {
        this.db.prepare("UPDATE events SET thumb_path = ? WHERE id = ?").run(thumbPath, id);
    }

    /**
     * Patch in the clip's real size once ffmpeg has finalized the container.
     * The row is written before post-roll finishes so the event shows up in the
     * UI immediately; this fills in what could only be known afterwards.
     */
    finalizeClipStats(id, { clipBytes, framesWritten, preRollFrames }) {
        const row = this.db.prepare("SELECT metadata_json FROM events WHERE id = ?").get(id);
        if (!row) return false;
        const meta = safeParse(row.metadata_json, {}) || {};
        if (framesWritten !== undefined) meta.framesWritten = framesWritten;
        if (preRollFrames !== undefined) meta.preRollFrames = preRollFrames;
        const info = this.db.prepare(
            "UPDATE events SET clip_bytes = ?, metadata_json = ? WHERE id = ?"
        ).run(clipBytes ?? null, JSON.stringify(meta), id);
        return info.changes === 1;
    }

    /** Rewrite a description after zones or scene guidance changed. */
    setDescription(id, description) {
        const info = this.db.prepare("UPDATE events SET description = ? WHERE id = ?")
            .run(description || null, id);
        return info.changes === 1;
    }

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
     * @param {number} [opts.sinceMs]   started_at_ms > this
     * @param {number} [opts.untilMs]   started_at_ms < this
     * @param {string} [opts.type]
     * @param {string} [opts.behavior]
     * @param {number} [opts.profileId]
     * @param {boolean} [opts.withClipOnly]
     * @param {number} [opts.limit]
     * @param {number} [opts.offset]
     */
    queryEvents({
        camId, sinceMs, untilMs, type, behavior, profileId,
        withClipOnly, limit, offset
    } = {}) {
        const lim = clampLimit(limit);
        const off = Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0;
        const where = [];
        const args = [];
        if (camId) { where.push("cam_id = ?"); args.push(camId); }
        if (typeof sinceMs === "number" && isFinite(sinceMs)) {
            where.push("started_at_ms > ?"); args.push(sinceMs);
        }
        if (typeof untilMs === "number" && isFinite(untilMs)) {
            where.push("started_at_ms < ?"); args.push(untilMs);
        }
        if (type) { where.push("type = ?"); args.push(type); }
        if (behavior) { where.push("behavior = ?"); args.push(behavior); }
        if (typeof profileId === "number") { where.push("profile_id = ?"); args.push(profileId); }
        if (withClipOnly) where.push("clip_path IS NOT NULL AND clip_pruned = 0");

        const sql = `
            SELECT * FROM events
            ${where.length ? "WHERE " + where.join(" AND ") : ""}
            ORDER BY started_at_ms DESC
            LIMIT ? OFFSET ?
        `;
        args.push(lim, off);
        return this.db.prepare(sql).all(...args).map(rowToEvent);
    }

    countEvents({ camId } = {}) {
        if (camId) {
            return this.db.prepare("SELECT COUNT(*) AS n FROM events WHERE cam_id = ?")
                .get(camId).n;
        }
        return this.db.prepare("SELECT COUNT(*) AS n FROM events").get().n;
    }

    /** Most recent event, optionally for one camera. Powers the mirror display. */
    latestEvent(camId) {
        const row = camId
            ? this.db.prepare(
                "SELECT * FROM events WHERE cam_id = ? AND ended_at_ms IS NOT NULL " +
                "ORDER BY started_at_ms DESC LIMIT 1"
            ).get(camId)
            : this.db.prepare(
                "SELECT * FROM events WHERE ended_at_ms IS NOT NULL " +
                "ORDER BY started_at_ms DESC LIMIT 1"
            ).get();
        return row ? rowToEvent(row) : null;
    }

    // ---- Retention support (driven by storage.js) --------------------

    /** Events started before `cutoffMs`, with whatever files they own. */
    eventsOlderThan(cutoffMs) {
        return this.db.prepare(
            "SELECT id, cam_id, clip_path, thumb_path FROM events WHERE started_at_ms < ?"
        ).all(cutoffMs);
    }

    deleteEventsOlderThan(cutoffMs) {
        return this.db.prepare("DELETE FROM events WHERE started_at_ms < ?").run(cutoffMs).changes;
    }

    /**
     * Events that still own a clip file, oldest first — the order the budget
     * sweeper reclaims them in.
     */
    clipsOldestFirst(limit) {
        const sql =
            "SELECT id, cam_id, clip_path, thumb_path, clip_bytes, started_at_ms " +
            "  FROM events WHERE clip_path IS NOT NULL AND clip_pruned = 0 " +
            " ORDER BY started_at_ms ASC" + (limit ? " LIMIT ?" : "");
        return limit ? this.db.prepare(sql).all(limit) : this.db.prepare(sql).all();
    }

    /**
     * Reclaim an event's video while keeping the row. You lose the footage but
     * keep the fact that something happened, which is the right trade when the
     * alternative is losing the history too.
     */
    markClipPruned(id) {
        this.db.prepare(
            "UPDATE events SET clip_pruned = 1, clip_bytes = 0 WHERE id = ?"
        ).run(id);
    }

    /** Sum of recorded clip sizes we believe we're holding, in bytes. */
    sumClipBytes() {
        const row = this.db.prepare(
            "SELECT COALESCE(SUM(clip_bytes), 0) AS n FROM events " +
            " WHERE clip_path IS NOT NULL AND clip_pruned = 0"
        ).get();
        return row ? row.n : 0;
    }

    /** Per-camera clip totals, for the storage breakdown in the UI. */
    clipBytesByCam() {
        return this.db.prepare(
            "SELECT cam_id, COUNT(*) AS clips, COALESCE(SUM(clip_bytes), 0) AS bytes " +
            "  FROM events WHERE clip_path IS NOT NULL AND clip_pruned = 0 " +
            " GROUP BY cam_id ORDER BY bytes DESC"
        ).all();
    }

    oldestEventMs() {
        const row = this.db.prepare("SELECT MIN(started_at_ms) AS n FROM events").get();
        return row && row.n ? row.n : null;
    }

    /**
     * Consistent on-line backup. VACUUM INTO takes its own read transaction, so
     * this is safe while the hub is running — unlike copying the file, which can
     * catch a half-written WAL.
     */
    backupTo(destPath) {
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        this.db.prepare("VACUUM INTO ?").run(destPath);
        return destPath;
    }

    _recoverOrphanedSessions() {
        const orphans = this.db.prepare(
            "SELECT id, started_at_ms, metadata_json FROM events WHERE ended_at_ms IS NULL"
        ).all();
        if (orphans.length === 0) return 0;

        const update = this.db.prepare(`
            UPDATE events SET ended_at_ms = ?, duration_ms = ?, metadata_json = ?
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

    // ==================================================================
    //  Settings
    // ==================================================================

    allSettings() {
        const rows = this.db.prepare("SELECT scope, key, value_json FROM settings").all();
        const out = [];
        for (const row of rows) {
            try {
                out.push({ scope: row.scope, key: row.key, value: JSON.parse(row.value_json) });
            } catch (_) {
                this.log.warn(`[hub] dropping unparseable setting ${row.scope}/${row.key}`);
            }
        }
        return out;
    }

    putSetting(scope, key, value) {
        this.db.prepare(`
            INSERT INTO settings (scope, key, value_json, updated_at_ms)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(scope, key) DO UPDATE
               SET value_json = excluded.value_json,
                   updated_at_ms = excluded.updated_at_ms
        `).run(scope, key, JSON.stringify(value), Date.now());
    }

    deleteSetting(scope, key) {
        this.db.prepare("DELETE FROM settings WHERE scope = ? AND key = ?").run(scope, key);
    }

    // ==================================================================
    //  Zones
    // ==================================================================

    listZones(camId) {
        const rows = camId
            ? this.db.prepare("SELECT * FROM zones WHERE cam_id = ? ORDER BY sort_order, id").all(camId)
            : this.db.prepare("SELECT * FROM zones ORDER BY cam_id, sort_order, id").all();
        return rows.map(rowToZone);
    }

    /**
     * Replace every zone for a camera in one transaction. Zone editing is a
     * whole-canvas operation in the UI, so partial application would leave the
     * user looking at something they didn't draw.
     */
    replaceZones(camId, zones) {
        const insert = this.db.prepare(`
            INSERT INTO zones (cam_id, name, kind, points_json, sort_order, created_at_ms)
            VALUES (?, ?, ?, ?, ?, ?)
        `);
        const tx = this.db.transaction((list) => {
            this.db.prepare("DELETE FROM zones WHERE cam_id = ?").run(camId);
            list.forEach((z, i) => {
                insert.run(
                    camId,
                    z.name,
                    z.kind || "area",
                    JSON.stringify(z.points),
                    typeof z.sortOrder === "number" ? z.sortOrder : i,
                    Date.now()
                );
            });
        });
        tx(zones);
        return this.listZones(camId);
    }

    // ==================================================================
    //  Profiles + face samples
    // ==================================================================

    listProfiles() {
        const rows = this.db.prepare(`
            SELECT p.*, COUNT(f.id) AS sample_count
              FROM profiles p
              LEFT JOIN face_samples f ON f.profile_id = p.id
             GROUP BY p.id
             ORDER BY p.is_anonymous, p.name COLLATE NOCASE
        `).all();
        return rows.map(rowToProfile);
    }

    getProfile(id) {
        const row = this.db.prepare(`
            SELECT p.*, COUNT(f.id) AS sample_count
              FROM profiles p
              LEFT JOIN face_samples f ON f.profile_id = p.id
             WHERE p.id = ?
             GROUP BY p.id
        `).get(id);
        return row ? rowToProfile(row) : null;
    }

    createProfile({ name, clearance, notes, isAnonymous }) {
        const info = this.db.prepare(`
            INSERT INTO profiles (name, clearance, notes, is_anonymous, created_at_ms)
            VALUES (?, ?, ?, ?, ?)
        `).run(
            name,
            Number.isFinite(clearance) ? clearance : 0,
            notes || null,
            isAnonymous ? 1 : 0,
            Date.now()
        );
        return this.getProfile(info.lastInsertRowid);
    }

    updateProfile(id, { name, clearance, notes, isAnonymous }) {
        const existing = this.getProfile(id);
        if (!existing) return null;
        this.db.prepare(`
            UPDATE profiles
               SET name = ?, clearance = ?, notes = ?, is_anonymous = ?
             WHERE id = ?
        `).run(
            name !== undefined ? name : existing.name,
            clearance !== undefined ? clearance : existing.clearance,
            notes !== undefined ? notes : existing.notes,
            isAnonymous !== undefined ? (isAnonymous ? 1 : 0) : (existing.is_anonymous ? 1 : 0),
            id
        );
        return this.getProfile(id);
    }

    deleteProfile(id) {
        // face_samples cascade via the FK; events keep their row but lose the
        // attribution rather than disappearing.
        this.db.prepare("UPDATE events SET profile_id = NULL WHERE profile_id = ?").run(id);
        const info = this.db.prepare("DELETE FROM profiles WHERE id = ?").run(id);
        return info.changes === 1;
    }

    listFaceSamples(profileId) {
        return this.db.prepare(
            "SELECT id, profile_id, image_path, source, event_id, created_at_ms, " +
            "       (embedding IS NOT NULL) AS has_embedding " +
            "  FROM face_samples WHERE profile_id = ? ORDER BY created_at_ms DESC"
        ).all(profileId);
    }

    addFaceSample({ profileId, embedding, imagePath, source, eventId }) {
        const info = this.db.prepare(`
            INSERT INTO face_samples (profile_id, embedding, image_path, source, event_id, created_at_ms)
            VALUES (?, ?, ?, ?, ?, ?)
        `).run(
            profileId,
            embedding ? Buffer.from(embedding) : null,
            imagePath || null,
            source || "upload",
            eventId ?? null,
            Date.now()
        );
        return info.lastInsertRowid;
    }

    deleteFaceSample(id) {
        const row = this.db.prepare("SELECT image_path FROM face_samples WHERE id = ?").get(id);
        const info = this.db.prepare("DELETE FROM face_samples WHERE id = ?").run(id);
        return info.changes === 1 ? (row ? row.image_path : null) : false;
    }

    /** Every embedding, for the recognizer to match against. */
    allEmbeddings() {
        return this.db.prepare(
            "SELECT f.id, f.profile_id, f.embedding, p.name " +
            "  FROM face_samples f JOIN profiles p ON p.id = f.profile_id " +
            " WHERE f.embedding IS NOT NULL"
        ).all();
    }

    recordSighting(profileId, atMs) {
        this.db.prepare(
            "UPDATE profiles SET sighting_count = sighting_count + 1, last_seen_ms = ? WHERE id = ?"
        ).run(atMs, profileId);
    }

    // ==================================================================
    //  Camera metadata
    // ==================================================================

    touchCamera(camId, { connected } = {}) {
        const now = Date.now();
        this.db.prepare(`
            INSERT INTO cameras (cam_id, first_seen_ms, last_seen_ms, connect_count)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(cam_id) DO UPDATE
               SET last_seen_ms = excluded.last_seen_ms,
                   connect_count = cameras.connect_count + excluded.connect_count
        `).run(camId, now, now, connected ? 1 : 0);
    }

    getCameraMeta(camId) {
        return this.db.prepare("SELECT * FROM cameras WHERE cam_id = ?").get(camId) || null;
    }

    listCameraMeta() {
        return this.db.prepare("SELECT * FROM cameras ORDER BY cam_id").all();
    }

    markOfflineAlert(camId, atMs) {
        this.db.prepare("UPDATE cameras SET last_offline_alert_ms = ? WHERE cam_id = ?")
            .run(atMs, camId);
    }
}

function clampLimit(limit) {
    if (typeof limit !== "number" || !isFinite(limit) || limit <= 0) return QUERY_LIMIT_DEFAULT;
    return Math.min(Math.floor(limit), QUERY_LIMIT_MAX);
}

function safeParse(json, fallback) {
    if (!json) return fallback;
    try { return JSON.parse(json); } catch (_) { return fallback; }
}

function rowToEvent(row) {
    return {
        id: row.id,
        cam_id: row.cam_id,
        type: row.type,
        started_at_ms: row.started_at_ms,
        ended_at_ms: row.ended_at_ms,
        duration_ms: row.duration_ms,
        detection_count: row.detection_count,
        max_confidence: row.max_confidence,
        clip_path: row.clip_pruned ? null : row.clip_path,
        clip_pruned: !!row.clip_pruned,
        clip_bytes: row.clip_bytes,
        thumb_path: row.thumb_path,
        description: row.description,
        behavior: row.behavior,
        zones: safeParse(row.zones_json, null),
        track: safeParse(row.track_json, null),
        profile_id: row.profile_id,
        metadata: safeParse(row.metadata_json, null)
    };
}

function rowToZone(row) {
    return {
        id: row.id,
        cam_id: row.cam_id,
        name: row.name,
        kind: row.kind,
        points: safeParse(row.points_json, []),
        sortOrder: row.sort_order
    };
}

function rowToProfile(row) {
    return {
        id: row.id,
        name: row.name,
        clearance: row.clearance,
        notes: row.notes,
        is_anonymous: !!row.is_anonymous,
        sighting_count: row.sighting_count,
        last_seen_ms: row.last_seen_ms,
        sample_count: row.sample_count ?? 0,
        created_at_ms: row.created_at_ms
    };
}

module.exports = { Store, expandHome, MIGRATIONS };
