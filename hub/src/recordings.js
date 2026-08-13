"use strict";

/**
 * Queries over the `recordings` table — the continuous ("always on") reel.
 *
 * Split out of store.js purely for size; `Store` still owns the connection and
 * exposes these as methods. Each function takes the open `better-sqlite3`
 * handle as its first argument.
 *
 * These are kept apart from events on purpose. An event is something that
 * happened and is worth keeping; a segment is a slice of wall-clock time that
 * exists until the disk needs the space. Different lifetimes, different
 * eviction rules, and mixing them would make every event query filter out
 * thousands of segment rows.
 */

const MAX_SEGMENT_ROWS = 20_000;
const DEFAULT_SEGMENT_ROWS = 5_000;

/**
 * Index a finished segment. Idempotent on `path` — the indexer re-scans the
 * directory periodically and must not double-count what it has already seen.
 */
function insertRecording(db, { camId, path: relPath, startedAtMs, endedAtMs, bytes }) {
    const duration = (endedAtMs && startedAtMs) ? endedAtMs - startedAtMs : null;
    const info = db.prepare(`
        INSERT INTO recordings
            (cam_id, path, started_at_ms, ended_at_ms, duration_ms, bytes, created_at_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(path) DO UPDATE
           SET ended_at_ms = excluded.ended_at_ms,
               duration_ms = excluded.duration_ms,
               bytes = excluded.bytes
    `).run(camId, relPath, startedAtMs, endedAtMs ?? null, duration, bytes ?? null, Date.now());
    return info.lastInsertRowid;
}

function getRecording(db, id) {
    const row = db.prepare("SELECT * FROM recordings WHERE id = ?").get(id);
    return row ? toRecording(row) : null;
}

function hasRecordingPath(db, relPath) {
    return !!db.prepare("SELECT 1 FROM recordings WHERE path = ?").get(relPath);
}

/**
 * Segments overlapping a wall-clock window, oldest first.
 *
 * Overlap rather than containment: a window starting mid-segment must still
 * return that segment, or scrubbing to 10:32 would find nothing when the
 * covering segment began at 10:30.
 */
function queryRecordings(db, { camId, fromMs, toMs, limit } = {}) {
    const where = ["1=1"];
    const args = [];
    if (camId) { where.push("cam_id = ?"); args.push(camId); }
    if (typeof toMs === "number") { where.push("started_at_ms <= ?"); args.push(toMs); }
    if (typeof fromMs === "number") {
        where.push("COALESCE(ended_at_ms, started_at_ms) >= ?");
        args.push(fromMs);
    }

    const lim = (typeof limit === "number" && isFinite(limit) && limit > 0)
        ? Math.min(Math.floor(limit), MAX_SEGMENT_ROWS)
        : DEFAULT_SEGMENT_ROWS;
    args.push(lim);

    return db.prepare(`
        SELECT * FROM recordings
         WHERE ${where.join(" AND ")}
         ORDER BY started_at_ms ASC
         LIMIT ?
    `).all(...args).map(toRecording);
}

/** The segment covering an instant, if any. */
function recordingAt(db, camId, atMs) {
    const row = db.prepare(`
        SELECT * FROM recordings
         WHERE cam_id = ? AND started_at_ms <= ?
           AND COALESCE(ended_at_ms, started_at_ms) >= ?
         ORDER BY started_at_ms DESC LIMIT 1
    `).get(camId, atMs, atMs);
    return row ? toRecording(row) : null;
}

/** Local calendar days with footage, newest first — drives the day picker. */
function recordingDays(db, camId, limit = 60) {
    const select =
        "SELECT date(started_at_ms / 1000, 'unixepoch', 'localtime') AS day, " +
        "       COUNT(*) AS segments, SUM(bytes) AS bytes FROM recordings ";
    return camId
        ? db.prepare(`${select} WHERE cam_id = ? GROUP BY day ORDER BY day DESC LIMIT ?`)
            .all(camId, limit)
        : db.prepare(`${select} GROUP BY day ORDER BY day DESC LIMIT ?`).all(limit);
}

function setRecordingProtected(db, id, isProtected, label) {
    return db.prepare(
        "UPDATE recordings SET protected = ?, label = COALESCE(?, label) WHERE id = ?"
    ).run(isProtected ? 1 : 0, label ?? null, id).changes === 1;
}

/** Protect (or release) every segment overlapping a window. */
function protectRecordingRange(db, camId, fromMs, toMs, isProtected, label) {
    return db.prepare(`
        UPDATE recordings SET protected = ?, label = COALESCE(?, label)
         WHERE cam_id = ? AND started_at_ms <= ?
           AND COALESCE(ended_at_ms, started_at_ms) >= ?
    `).run(isProtected ? 1 : 0, label ?? null, camId, toMs, fromMs).changes;
}

/**
 * Unprotected segments, oldest first — the eviction order.
 *
 * Protected segments are excluded by construction rather than filtered by the
 * caller, so there is no path by which the budget can take saved footage.
 */
function evictableRecordings(db, limit) {
    const sql =
        "SELECT * FROM recordings WHERE protected = 0 " +
        "ORDER BY started_at_ms ASC" + (limit ? " LIMIT ?" : "");
    const rows = limit ? db.prepare(sql).all(limit) : db.prepare(sql).all();
    return rows.map(toRecording);
}

function recordingsOlderThan(db, cutoffMs, { includeProtected = false } = {}) {
    const sql = includeProtected
        ? "SELECT * FROM recordings WHERE started_at_ms < ?"
        : "SELECT * FROM recordings WHERE started_at_ms < ? AND protected = 0";
    return db.prepare(sql).all(cutoffMs).map(toRecording);
}

function deleteRecording(db, id) {
    return db.prepare("DELETE FROM recordings WHERE id = ?").run(id).changes === 1;
}

/** Totals for the storage page. Protected bytes are broken out separately. */
function recordingStats(db, camId) {
    const scope = camId ? "WHERE cam_id = ?" : "";
    const args = camId ? [camId] : [];
    return db.prepare(`
        SELECT COUNT(*) AS segments,
               COALESCE(SUM(bytes), 0) AS bytes,
               COALESCE(SUM(CASE WHEN protected = 1 THEN bytes ELSE 0 END), 0) AS protected_bytes,
               COALESCE(SUM(CASE WHEN protected = 1 THEN 1 ELSE 0 END), 0) AS protected_segments,
               MIN(started_at_ms) AS oldest_ms,
               MAX(COALESCE(ended_at_ms, started_at_ms)) AS newest_ms
          FROM recordings ${scope}
    `).get(...args) || {
        segments: 0, bytes: 0, protected_bytes: 0,
        protected_segments: 0, oldest_ms: null, newest_ms: null
    };
}

function recordingBytesByCam(db) {
    return db.prepare(
        "SELECT cam_id, COUNT(*) AS segments, COALESCE(SUM(bytes), 0) AS bytes " +
        "  FROM recordings GROUP BY cam_id ORDER BY bytes DESC"
    ).all();
}

function toRecording(row) {
    return {
        id: row.id,
        cam_id: row.cam_id,
        path: row.path,
        started_at_ms: row.started_at_ms,
        ended_at_ms: row.ended_at_ms,
        duration_ms: row.duration_ms,
        bytes: row.bytes,
        protected: !!row.protected,
        label: row.label,
        created_at_ms: row.created_at_ms
    };
}

module.exports = {
    insertRecording,
    getRecording,
    hasRecordingPath,
    queryRecordings,
    recordingAt,
    recordingDays,
    setRecordingProtected,
    protectRecordingRange,
    evictableRecordings,
    recordingsOlderThan,
    deleteRecording,
    recordingStats,
    recordingBytesByCam,
    toRecording
};
