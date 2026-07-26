"use strict";

/**
 * Profile enrollment: attaching face images to a person.
 *
 * Split out of server.js because it's self-contained and file-handling heavy.
 * Recognition itself lives in recognize.js and is not active yet; this is the
 * part that works today — storing labelled images so there is something to
 * match against once it is.
 */

const fs = require("node:fs");
const path = require("node:path");

const MAX_IMAGE_BYTES = 6 * 1024 * 1024;

/**
 * Add a face sample to a profile.
 *
 * Two sources, and the second is the one that matters in practice:
 *
 *   { eventId }      enrol straight from an event thumbnail — "that's Jared".
 *                    The system has already captured the person at the exact
 *                    angle and lighting the camera sees them in, which beats
 *                    hunting through a photo library for a portrait that
 *                    doesn't match the conditions.
 *   { imageBase64 }  a manual upload.
 *
 * Images are accepted as base64 JSON rather than multipart because the hub's
 * HTTP layer is deliberately framework-free, and adding a multipart parser for
 * one endpoint would be more machinery than the feature is worth.
 *
 * The embedding is stored as null until the recognizer is finished. Saving the
 * image now means enrollment isn't blocked on that work, and a later backfill
 * can compute embeddings for everything already collected.
 *
 * @returns {Promise<{ok: true, sample: object} | {ok: false, status: number, error: string}>}
 */
async function addFaceSample(hub, profileId, body) {
    if (!hub.store) return { ok: false, status: 503, error: "event store unavailable" };
    if (!hub.store.getProfile(profileId)) {
        return { ok: false, status: 404, error: "profile not found" };
    }

    const loaded = loadImage(hub, body);
    if (!loaded.ok) return loaded;

    const relPath = path.join("faces", String(profileId), `${Date.now()}.jpg`);
    const absPath = path.join(hub.clipsRoot, relPath);
    try {
        fs.mkdirSync(path.dirname(absPath), { recursive: true });
        fs.writeFileSync(absPath, loaded.jpeg);
    } catch (err) {
        return { ok: false, status: 500, error: `failed to save image: ${err.message}` };
    }

    const sampleId = hub.store.addFaceSample({
        profileId,
        embedding: null,
        imagePath: relPath,
        source: loaded.source,
        eventId: body.eventId !== undefined ? Number(body.eventId) : null
    });
    if (hub.recognizer) hub.recognizer.invalidate();

    return {
        ok: true,
        sample: {
            id: sampleId,
            profile_id: profileId,
            image_path: relPath,
            source: loaded.source,
            has_embedding: 0,
            created_at_ms: Date.now()
        }
    };
}

function loadImage(hub, body) {
    if (body.eventId !== undefined) {
        const event = hub.store.getEvent(Number(body.eventId));
        if (!event || !event.thumb_path) {
            return { ok: false, status: 404, error: "event has no thumbnail to enrol from" };
        }
        const abs = hub.storage.resolveClipPath(event.thumb_path);
        try {
            return { ok: true, jpeg: fs.readFileSync(abs), source: "event" };
        } catch (_) {
            return { ok: false, status: 404, error: "thumbnail file is missing" };
        }
    }

    if (typeof body.imageBase64 === "string") {
        const cleaned = body.imageBase64.replace(/^data:image\/\w+;base64,/, "");
        const jpeg = Buffer.from(cleaned, "base64");
        if (!jpeg.length) return { ok: false, status: 400, error: "imageBase64 is empty" };
        if (jpeg.length > MAX_IMAGE_BYTES) {
            return { ok: false, status: 400, error: "image is too large (max 6 MB)" };
        }
        return { ok: true, jpeg, source: "upload" };
    }

    return { ok: false, status: 400, error: "provide either eventId or imageBase64" };
}

function deleteFaceSample(hub, sampleId) {
    if (!hub.store) return false;
    const imagePath = hub.store.deleteFaceSample(sampleId);
    if (imagePath === false) return false;
    unlinkSampleImage(hub, imagePath);
    if (hub.recognizer) hub.recognizer.invalidate();
    return true;
}

/**
 * Delete a profile and its images.
 *
 * Past events keep their rows and lose only the attribution — deleting someone's
 * profile shouldn't erase the record that anything happened.
 */
function deleteProfile(hub, profileId) {
    if (!hub.store) return false;
    for (const sample of hub.store.listFaceSamples(profileId)) {
        unlinkSampleImage(hub, sample.image_path);
    }
    const ok = hub.store.deleteProfile(profileId);
    if (ok && hub.recognizer) hub.recognizer.invalidate();
    return ok;
}

function unlinkSampleImage(hub, relPath) {
    if (!relPath) return;
    const abs = hub.storage.resolveClipPath(relPath);
    if (!abs) return;
    try { fs.unlinkSync(abs); } catch (_) { /* already gone */ }
}

module.exports = { addFaceSample, deleteFaceSample, deleteProfile, MAX_IMAGE_BYTES };
