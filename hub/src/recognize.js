"use strict";

/**
 * Face recognition — scaffold.
 *
 * ============================================================================
 *  Status: intentionally not implemented
 * ============================================================================
 *
 * Profiles, enrollment, clearances, and face-sample storage are fully built and
 * usable right now. What is deliberately stubbed is the part that turns a
 * cropped face into a 512-dimension vector, because it needs two ONNX models
 * that have to be published to a release before any hub can fetch them.
 *
 * Everything in the system is designed to work with this switched off, and it
 * is switched off by default. With `enabled: false` the recognizer answers
 * "unknown" instantly and events are logged exactly as they are today.
 *
 * ============================================================================
 *  What finishing it involves
 * ============================================================================
 *
 * 1. Publish two models alongside the existing yolov8n-int8.onnx release:
 *      - SCRFD-500m   (~2.5 MB) face detection + 5-point landmarks
 *      - MobileFaceNet (~4 MB)  512-d embedding, ArcFace-trained
 *    The download-and-verify plumbing already exists in detector.js and should
 *    be reused rather than reimplemented.
 *
 * 2. Implement `_embed()` below. The pipeline per face:
 *      crop the person box → detect face → align to a canonical 112x112 using
 *      the landmarks → normalize → run the embedding model → L2-normalize.
 *    Alignment is the step people skip and then wonder why accuracy is poor;
 *    matching un-aligned crops is substantially worse than matching aligned ones.
 *
 * 3. Run it inside the existing detector worker, not a new one. The model is
 *    small and the worker already holds ONNX Runtime and sharp; a second worker
 *    would double the runtime's memory for no benefit.
 *
 * 4. Rate-limit to faces on frames that already produced a person detection,
 *    at no more than ~1 fps. That keeps the added cost near 15% of one Pi 4
 *    core rather than doubling detector load.
 *
 * The matching logic below (`match`) is real and tested — it's pure vector
 * arithmetic with no model dependency — so only the embedding step is missing.
 */

/**
 * Cosine similarity above which two embeddings are considered the same person.
 *
 * 0.36 is the conventional operating point for ArcFace-family embeddings, and
 * it is deliberately conservative: in a security context a false "that's Jared"
 * is far worse than an "unknown face" you have to label yourself, because the
 * first one silently suppresses an alert you wanted.
 */
const DEFAULT_MATCH_THRESHOLD = 0.36;

/** Sightings of the same unrecognised face before it becomes an auto-profile. */
const AUTO_PROFILE_AFTER_SIGHTINGS = 3;

const EMBEDDING_DIMS = 512;

/**
 * Cosine similarity of two equal-length vectors.
 * Assumes both are L2-normalized, which `_embed` guarantees, so this reduces to
 * a dot product.
 */
function cosineSimilarity(a, b) {
    if (!a || !b || a.length !== b.length) return -1;
    let dot = 0;
    for (let i = 0; i < a.length; i += 1) dot += a[i] * b[i];
    return dot;
}

function l2Normalize(vec) {
    let sum = 0;
    for (let i = 0; i < vec.length; i += 1) sum += vec[i] * vec[i];
    const norm = Math.sqrt(sum) || 1;
    const out = new Float32Array(vec.length);
    for (let i = 0; i < vec.length; i += 1) out[i] = vec[i] / norm;
    return out;
}

/** Float32Array <-> BLOB, for the face_samples.embedding column. */
function encodeEmbedding(vec) {
    return Buffer.from(new Float32Array(vec).buffer);
}

function decodeEmbedding(buf) {
    if (!buf || !buf.length) return null;
    return new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
}

class Recognizer {
    /**
     * @param {object} opts
     * @param {object} opts.store
     * @param {boolean} [opts.enabled=false]
     * @param {number} [opts.threshold]
     * @param {object} [opts.logger]
     */
    constructor({ store, enabled = false, threshold, logger } = {}) {
        this.store = store || null;
        this.enabled = !!enabled;
        this.threshold = threshold ?? DEFAULT_MATCH_THRESHOLD;
        this.log = logger || console;

        this.available = false;
        this.unavailableReason = "face recognition models are not published yet";

        // Embeddings are cached in memory: a few hundred float arrays is
        // nothing, and re-reading them from SQLite per frame would not be.
        this._cache = null;
        this._pendingUnknowns = new Map();
    }

    /**
     * Attempt to bring the models up. Always resolves — never throws — so a
     * missing model degrades the feature rather than the hub.
     */
    async start() {
        if (!this.enabled) {
            return { ok: false, error: "disabled" };
        }
        // Deliberately not implemented; see the header.
        this.available = false;
        this.log.warn(`[hub] face recognition unavailable: ${this.unavailableReason}`);
        return { ok: false, error: this.unavailableReason };
    }

    status() {
        return {
            enabled: this.enabled,
            available: this.available,
            reason: this.available ? null : this.unavailableReason,
            threshold: this.threshold,
            enrolledProfiles: this._cache ? this._cache.length : null
        };
    }

    /** Drop the cache after enrollment changes. */
    invalidate() {
        this._cache = null;
    }

    _embeddings() {
        if (this._cache) return this._cache;
        if (!this.store) return [];
        try {
            this._cache = this.store.allEmbeddings()
                .map((row) => ({
                    profileId: row.profile_id,
                    name: row.name,
                    vector: decodeEmbedding(row.embedding)
                }))
                .filter((e) => e.vector && e.vector.length === EMBEDDING_DIMS);
        } catch (err) {
            this.log.warn(`[hub] failed to load embeddings: ${err && err.message}`);
            this._cache = [];
        }
        return this._cache;
    }

    /**
     * Best match for an embedding.
     *
     * Real logic, no model needed — this is what the pipeline will call once
     * `_embed` exists, and it's independently testable today.
     *
     * @returns {{profileId: number, name: string, similarity: number} | null}
     */
    match(embedding) {
        if (!embedding) return null;
        let best = null;
        for (const entry of this._embeddings()) {
            const similarity = cosineSimilarity(embedding, entry.vector);
            if (similarity < this.threshold) continue;
            if (!best || similarity > best.similarity) {
                best = { profileId: entry.profileId, name: entry.name, similarity };
            }
        }
        return best;
    }

    /**
     * Identify whoever is in a frame.
     *
     * With recognition off (the default) this returns `null` immediately and
     * the caller logs a plain person event, which is exactly today's behaviour.
     *
     * @param {Buffer} jpeg
     * @param {object} personBbox   Normalized cx/cy/w/h to crop within.
     * @returns {Promise<{profileId: number, name: string, similarity: number} | null>}
     */
    async identify(jpeg, personBbox) {
        if (!this.enabled || !this.available) return null;
        const embedding = await this._embed(jpeg, personBbox);
        if (!embedding) return null;
        return this.match(embedding);
    }

    /**
     * Crop, align, and embed a face. **Not implemented** — see the header for
     * exactly what goes here.
     *
     * @returns {Promise<Float32Array|null>}
     */
    // eslint-disable-next-line no-unused-vars
    async _embed(jpeg, personBbox) {
        return null;
    }

    /**
     * Track repeat sightings of an unrecognised face so a stranger who keeps
     * turning up becomes a profile you can name, instead of a hundred
     * indistinguishable "unknown" events.
     *
     * Returns the created profile once the threshold is crossed, else null.
     */
    noteUnknown(embedding, atMs) {
        if (!embedding || !this.store) return null;

        for (const [key, pending] of this._pendingUnknowns) {
            if (cosineSimilarity(embedding, pending.vector) < this.threshold) continue;
            pending.count += 1;
            pending.lastSeen = atMs;
            if (pending.count < AUTO_PROFILE_AFTER_SIGHTINGS) return null;

            this._pendingUnknowns.delete(key);
            const profile = this.store.createProfile({
                name: `Unknown #${this.store.listProfiles().filter((p) => p.is_anonymous).length + 1}`,
                clearance: 0,
                isAnonymous: true
            });
            this.store.addFaceSample({
                profileId: profile.id,
                embedding: encodeEmbedding(pending.vector),
                source: "auto"
            });
            this.invalidate();
            this.log.info(`[hub] auto-created anonymous profile ${profile.id} after ${pending.count} sightings`);
            return profile;
        }

        this._pendingUnknowns.set(Symbol("unknown"), {
            vector: embedding, count: 1, lastSeen: atMs
        });
        return null;
    }
}

module.exports = {
    Recognizer,
    cosineSimilarity,
    l2Normalize,
    encodeEmbedding,
    decodeEmbedding,
    DEFAULT_MATCH_THRESHOLD,
    EMBEDDING_DIMS
};
