"use strict";

/**
 * Queries over `profiles` and `face_samples` — known people and their enrolled
 * faces.
 *
 * Split out of store.js for size; `Store` still owns the connection and exposes
 * these as methods. Each function takes the open `better-sqlite3` handle first.
 *
 * Everything here works today. What is not yet wired up is automatic
 * *recognition* — see recognize.js. Embeddings are stored as BLOBs and are
 * null until the models are published, so enrollment isn't blocked on that
 * work and a later backfill can compute them for everything already collected.
 */

function listProfiles(db) {
    return db.prepare(`
        SELECT p.*, COUNT(f.id) AS sample_count
          FROM profiles p
          LEFT JOIN face_samples f ON f.profile_id = p.id
         GROUP BY p.id
         ORDER BY p.is_anonymous, p.name COLLATE NOCASE
    `).all().map(toProfile);
}

function getProfile(db, id) {
    const row = db.prepare(`
        SELECT p.*, COUNT(f.id) AS sample_count
          FROM profiles p
          LEFT JOIN face_samples f ON f.profile_id = p.id
         WHERE p.id = ?
         GROUP BY p.id
    `).get(id);
    return row ? toProfile(row) : null;
}

function createProfile(db, { name, clearance, notes, isAnonymous }) {
    const info = db.prepare(`
        INSERT INTO profiles (name, clearance, notes, is_anonymous, created_at_ms)
        VALUES (?, ?, ?, ?, ?)
    `).run(
        name,
        Number.isFinite(clearance) ? clearance : 0,
        notes || null,
        isAnonymous ? 1 : 0,
        Date.now()
    );
    return getProfile(db, info.lastInsertRowid);
}

function updateProfile(db, id, { name, clearance, notes, isAnonymous }) {
    const existing = getProfile(db, id);
    if (!existing) return null;
    db.prepare(`
        UPDATE profiles SET name = ?, clearance = ?, notes = ?, is_anonymous = ?
         WHERE id = ?
    `).run(
        name !== undefined ? name : existing.name,
        clearance !== undefined ? clearance : existing.clearance,
        notes !== undefined ? notes : existing.notes,
        isAnonymous !== undefined ? (isAnonymous ? 1 : 0) : (existing.is_anonymous ? 1 : 0),
        id
    );
    return getProfile(db, id);
}

/**
 * Delete a profile and its samples (which cascade via the foreign key).
 *
 * Past events keep their rows and lose only the attribution — deleting someone
 * shouldn't erase the record that anything happened.
 */
function deleteProfile(db, id) {
    db.prepare("UPDATE events SET profile_id = NULL WHERE profile_id = ?").run(id);
    return db.prepare("DELETE FROM profiles WHERE id = ?").run(id).changes === 1;
}

function listFaceSamples(db, profileId) {
    return db.prepare(
        "SELECT id, profile_id, image_path, source, event_id, created_at_ms, " +
        "       (embedding IS NOT NULL) AS has_embedding " +
        "  FROM face_samples WHERE profile_id = ? ORDER BY created_at_ms DESC"
    ).all(profileId);
}

function addFaceSample(db, { profileId, embedding, imagePath, source, eventId }) {
    const info = db.prepare(`
        INSERT INTO face_samples
            (profile_id, embedding, image_path, source, event_id, created_at_ms)
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

/** Returns the removed row's image path, or false when nothing matched. */
function deleteFaceSample(db, id) {
    const row = db.prepare("SELECT image_path FROM face_samples WHERE id = ?").get(id);
    const changed = db.prepare("DELETE FROM face_samples WHERE id = ?").run(id).changes === 1;
    return changed ? (row ? row.image_path : null) : false;
}

/** Every stored embedding, for the recognizer to match against. */
function allEmbeddings(db) {
    return db.prepare(
        "SELECT f.id, f.profile_id, f.embedding, p.name " +
        "  FROM face_samples f JOIN profiles p ON p.id = f.profile_id " +
        " WHERE f.embedding IS NOT NULL"
    ).all();
}

function recordSighting(db, profileId, atMs) {
    db.prepare(
        "UPDATE profiles SET sighting_count = sighting_count + 1, last_seen_ms = ? WHERE id = ?"
    ).run(atMs, profileId);
}

function toProfile(row) {
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

module.exports = {
    listProfiles,
    getProfile,
    createProfile,
    updateProfile,
    deleteProfile,
    listFaceSamples,
    addFaceSample,
    deleteFaceSample,
    allEmbeddings,
    recordSighting,
    toProfile
};
