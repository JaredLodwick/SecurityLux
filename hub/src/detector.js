"use strict";

/**
 * Main-thread façade for the detector worker.
 *
 * Responsibilities:
 *  - Lazy-download the ONNX model on first start (SHA-256 verified).
 *  - Spawn one worker_threads.Worker that loads the model once.
 *  - Run a per-cam tick loop that posts the latest JPEG to the worker and
 *    hands detections back to the SessionManager.
 *  - Decide when the motion gate may skip inference — see `_shouldForce`.
 *  - Auto-restart the worker on unexpected exit (with backoff).
 *
 * The worker is shared across cameras so the model is loaded once no matter how
 * many cameras exist, which is what keeps hub memory flat as cameras are added.
 */

const { Worker } = require("node:worker_threads");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const https = require("node:https");
const { URL } = require("node:url");

const { expandHome } = require("./store");

const DEFAULT_MODEL_DIR = "~/.securityluxhub/models";
const WORKER_RESTART_MAX = 3;
const WORKER_RESTART_WINDOW_MS = 60_000;
const STALE_FRAME_MS = 5_000;
const LATENCY_LOG_INTERVAL_MS = 60_000;

/**
 * How often a frame runs through the model regardless of the motion gate.
 *
 * This is a correctness guard, not a tuning knob. Someone who walks up and then
 * stands perfectly still stops generating motion; without a periodic forced
 * inference the gate would conclude the scene is empty and the recording would
 * end with them still standing at the door.
 */
const FORCE_INFERENCE_EVERY_MS = 4_000;

class Detector {
    /**
     * @param {object} opts
     * @param {object} opts.settings       SettingsService.
     * @param {object} opts.detectionCfg   Static bits from config.yml (model URL/hash).
     * @param {Function} opts.onObservation
     *   `(observation) => void` where observation is
     *   `{ camId, detections: [{cls, confidence, bbox}], hasPerson, frameSeq, ts, skipped }`
     *   and each bbox is normalized 0-1 cx/cy/w/h.
     * @param {Function} [opts.isSessionActive]  `(camId) => boolean`; disables the motion gate.
     * @param {object} [opts.logger]
     * @param {string} [opts.modelDir]     Override for tests.
     */
    constructor({ settings, detectionCfg, onObservation, isSessionActive, logger, modelDir }) {
        if (!settings) throw new Error("Detector: settings is required");
        if (typeof onObservation !== "function") throw new Error("Detector: onObservation is required");

        this.settings = settings;
        this.cfg = detectionCfg || {};
        this.onObservation = onObservation;
        this.isSessionActive = isSessionActive || (() => false);
        this.log = logger || console;
        this.modelDir = expandHome(modelDir || DEFAULT_MODEL_DIR);

        this.cams = new Map();          // camId -> { cam, timer, lastInferSeq, pending, lastForcedAt }
        this.worker = null;
        this.workerReady = false;
        this.modelPath = null;
        this.nextJobId = 1;
        this.pendingJobs = new Map();
        this._restartHistory = [];
        this._latencySamples = [];
        this._skipCount = 0;
        this._runCount = 0;
        this._latencyTimer = null;
    }

    /**
     * Bring the detector up: ensure model present, spawn worker. Idempotent.
     * Returns `{ ok: true }` or `{ ok: false, error }` so the caller can decide
     * whether to surface the failure or just log it.
     */
    async start() {
        if (this.worker) return { ok: true };

        try {
            this.modelPath = await this._ensureModel();
        } catch (err) {
            this.log.error(`[hub] detector model unavailable: ${err.message}`);
            return { ok: false, error: `model: ${err.message}` };
        }

        if (!this._spawnWorker()) {
            return { ok: false, error: "failed to spawn detector worker (see logs)" };
        }
        return { ok: true };
    }

    attachCam(cam) {
        if (!cam || !cam.id) return;
        if (this.cams.has(cam.id)) return;
        this.cams.set(cam.id, {
            cam, timer: null, lastInferSeq: -1, pending: false, lastForcedAt: 0
        });
        this._scheduleNextTick(cam.id);
    }

    detachCam(camId) {
        const entry = this.cams.get(camId);
        if (!entry) return;
        if (entry.timer) clearTimeout(entry.timer);
        this.cams.delete(camId);
        // Drop the worker's motion reference so a reconnecting camera doesn't
        // get compared against a frame from before it went away.
        if (this.worker) {
            try { this.worker.postMessage({ kind: "forget", camId }); } catch (_) { /* ignore */ }
        }
    }

    async stop() {
        for (const entry of this.cams.values()) {
            if (entry.timer) clearTimeout(entry.timer);
        }
        this.cams.clear();
        if (this._latencyTimer) {
            clearInterval(this._latencyTimer);
            this._latencyTimer = null;
        }
        if (this.worker) {
            const worker = this.worker;
            this.worker = null;         // marks the exit as intentional
            try { worker.postMessage({ kind: "shutdown" }); } catch (_) { /* ignore */ }
            try { await worker.terminate(); } catch (_) { /* ignore */ }
            this.workerReady = false;
        }
        for (const job of this.pendingJobs.values()) job.reject(new Error("detector stopped"));
        this.pendingJobs.clear();
    }

    stats() {
        const total = this._skipCount + this._runCount;
        return {
            framesInferred: this._runCount,
            framesSkipped: this._skipCount,
            skipRatio: total ? this._skipCount / total : 0
        };
    }

    // ---- internals ----

    _spawnWorker() {
        const workerPath = path.join(__dirname, "detector.worker.js");
        try {
            this.worker = new Worker(workerPath, { workerData: { modelPath: this.modelPath } });
        } catch (err) {
            this.log.error(`[hub] failed to spawn detector worker: ${err.message}`);
            this.worker = null;
            return false;
        }

        this.worker.on("message", (msg) => this._onWorkerMessage(msg));
        this.worker.on("error", (err) => {
            this.log.error(`[hub] detector worker error: ${err && err.message}`);
        });
        this.worker.on("exit", (code) => this._onWorkerExit(code));

        this._latencyTimer = setInterval(() => this._flushLatencyStats(), LATENCY_LOG_INTERVAL_MS);
        if (typeof this._latencyTimer.unref === "function") this._latencyTimer.unref();
        return true;
    }

    _onWorkerMessage(msg) {
        if (!msg || typeof msg !== "object") return;
        if (msg.kind === "ready") {
            this.workerReady = true;
            this.log.info(`[hub] detector worker ready (model: ${path.basename(this.modelPath)})`);
            return;
        }
        if (msg.kind === "result") {
            const job = this.pendingJobs.get(msg.jobId);
            if (job) {
                this.pendingJobs.delete(msg.jobId);
                if (msg.skipped) this._skipCount += 1;
                else {
                    this._runCount += 1;
                    this._latencySamples.push(msg.latencyMs);
                }
                job.resolve(msg);
            }
            return;
        }
        if (msg.kind === "error") {
            if (msg.fatal) {
                this.log.error(`[hub] detector worker fatal: ${msg.message}`);
                this.workerReady = false;
            }
            if (msg.jobId) {
                const job = this.pendingJobs.get(msg.jobId);
                if (job) {
                    this.pendingJobs.delete(msg.jobId);
                    job.reject(new Error(msg.message));
                }
            }
        }
    }

    _onWorkerExit(code) {
        this.workerReady = false;
        const wasIntentional = !this.worker;
        this.worker = null;
        for (const job of this.pendingJobs.values()) job.reject(new Error("worker exited"));
        this.pendingJobs.clear();
        if (wasIntentional) return;

        const now = Date.now();
        this._restartHistory = this._restartHistory.filter((t) => now - t < WORKER_RESTART_WINDOW_MS);
        if (this._restartHistory.length >= WORKER_RESTART_MAX) {
            this.log.error(
                `[hub] detector worker died ${WORKER_RESTART_MAX} times in ` +
                `${WORKER_RESTART_WINDOW_MS / 1000}s; giving up`
            );
            return;
        }
        this._restartHistory.push(now);
        this.log.warn(`[hub] detector worker exited code=${code}; restarting`);
        setTimeout(() => this._spawnWorker(), 1000).unref?.();
    }

    _scheduleNextTick(camId) {
        const entry = this.cams.get(camId);
        if (!entry) return;
        const fps = this.settings.get("detection.fps");
        const intervalMs = Math.max(66, Math.floor(1000 / Math.max(fps || 2, 0.25)));
        if (entry.timer) clearTimeout(entry.timer);
        entry.timer = setTimeout(() => this._tick(camId).catch((err) => {
            this.log.warn(`[hub] detector tick error: ${err && err.message}`);
        }), intervalMs);
        if (typeof entry.timer.unref === "function") entry.timer.unref();
    }

    /**
     * Should this frame bypass the motion gate?
     *
     * Yes while a session is active — a stationary person must keep being seen
     * or the recording ends underneath them. Yes periodically otherwise, so a
     * subject who arrives during a skipped frame and then holds still is still
     * picked up within a few seconds.
     */
    _shouldForce(camId, entry, now) {
        if (this.isSessionActive(camId)) return true;
        if (now - entry.lastForcedAt >= FORCE_INFERENCE_EVERY_MS) {
            entry.lastForcedAt = now;
            return true;
        }
        return false;
    }

    async _tick(camId) {
        const entry = this.cams.get(camId);
        if (!entry) return;
        if (!this.workerReady || !this.worker) {
            this._scheduleNextTick(camId);
            return;
        }

        const { cam } = entry;
        const now = Date.now();
        const stale = now - (cam.lastJpegAt || 0) > STALE_FRAME_MS;
        const off = cam.desiredState !== "on";
        const muted = !this.settings.get("detection.enabled", camId);
        const sameFrame = cam.frameSeq === entry.lastInferSeq;

        if (off || muted || stale || !cam.lastJpeg || sameFrame || entry.pending) {
            this._scheduleNextTick(camId);
            return;
        }

        entry.lastInferSeq = cam.frameSeq;
        entry.pending = true;
        try {
            const result = await this._postInfer(camId, entry, cam, now);
            const detections = result.detections || [];
            try {
                this.onObservation({
                    camId,
                    detections,
                    hasPerson: detections.length > 0,
                    confidence: detections.length ? detections[0].confidence : 0,
                    bbox: detections.length ? detections[0].bbox : null,
                    frameSeq: result.frameSeq,
                    skipped: !!result.skipped,
                    ts: Date.now()
                });
            } catch (err) {
                this.log.warn(`[hub] onObservation handler threw: ${err && err.message}`);
            }
        } catch (_) {
            // The worker exit path already logs; don't double-report per tick.
        } finally {
            entry.pending = false;
            this._scheduleNextTick(camId);
        }
    }

    _postInfer(camId, entry, cam, now) {
        if (!this.worker) return Promise.reject(new Error("worker not running"));
        const jobId = this.nextJobId;
        this.nextJobId += 1;

        // Copy into a fresh ArrayBuffer so ownership can be transferred to the
        // worker without the source Buffer being replaced under us when the next
        // frame lands mid-flight.
        const jpegBuffer = cam.lastJpeg;
        const ab = new ArrayBuffer(jpegBuffer.byteLength);
        new Uint8Array(ab).set(jpegBuffer);

        return new Promise((resolve, reject) => {
            this.pendingJobs.set(jobId, { resolve, reject });
            try {
                this.worker.postMessage({
                    kind: "infer",
                    jobId,
                    camId,
                    frameSeq: cam.frameSeq,
                    confidence: this.settings.get("detection.confidence", camId),
                    motionGate: this.settings.get("detection.motionGate", camId),
                    motionThreshold: this.settings.get("detection.motionThreshold", camId),
                    force: this._shouldForce(camId, entry, now),
                    jpeg: ab
                }, [ab]);
            } catch (err) {
                this.pendingJobs.delete(jobId);
                reject(err);
            }
        });
    }

    _flushLatencyStats() {
        if (this._latencySamples.length === 0) return;
        const sorted = [...this._latencySamples].sort((a, b) => a - b);
        const p50 = sorted[Math.floor(sorted.length * 0.5)];
        const p95 = sorted[Math.floor(sorted.length * 0.95)];
        const total = this._skipCount + this._runCount;
        const skipPct = total ? Math.round((this._skipCount / total) * 100) : 0;
        this.log.info(
            `[hub] detector latency p50=${p50}ms p95=${p95}ms n=${sorted.length} ` +
            `(motion gate skipped ${skipPct}% of frames)`
        );
        this._latencySamples = [];
    }

    async _ensureModel() {
        const url = this.cfg.modelUrl;
        if (!url) throw new Error("detection.modelUrl not configured");
        const expectedSha = (this.cfg.modelSha256 || "").trim().toLowerCase();
        const fileName = path.basename(new URL(url).pathname) || "model.onnx";
        const targetPath = path.join(this.modelDir, fileName);
        fs.mkdirSync(this.modelDir, { recursive: true });

        if (fs.existsSync(targetPath)) {
            if (!expectedSha || (await sha256File(targetPath)) === expectedSha) {
                return targetPath;
            }
            this.log.warn(`[hub] cached model ${fileName} sha256 mismatch; re-downloading`);
            try { fs.unlinkSync(targetPath); } catch (_) { /* ignore */ }
        }

        this.log.info(`[hub] downloading detection model: ${url}`);
        const tmpPath = `${targetPath}.part`;
        await downloadToFile(url, tmpPath);
        if (expectedSha) {
            const actual = await sha256File(tmpPath);
            if (actual !== expectedSha) {
                try { fs.unlinkSync(tmpPath); } catch (_) { /* ignore */ }
                throw new Error(`model sha256 mismatch: expected ${expectedSha}, got ${actual}`);
            }
        } else {
            this.log.warn("[hub] detection.modelSha256 not set; skipping integrity check");
        }
        fs.renameSync(tmpPath, targetPath);
        return targetPath;
    }
}

function downloadToFile(url, destPath, redirectCount = 0) {
    if (redirectCount > 5) return Promise.reject(new Error("too many redirects"));
    return new Promise((resolve, reject) => {
        const req = https.get(url, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                res.resume();
                resolve(downloadToFile(res.headers.location, destPath, redirectCount + 1));
                return;
            }
            if (res.statusCode !== 200) {
                reject(new Error(`HTTP ${res.statusCode} downloading ${url}`));
                res.resume();
                return;
            }
            const out = fs.createWriteStream(destPath);
            res.pipe(out);
            out.on("finish", () => out.close((err) => (err ? reject(err) : resolve())));
            out.on("error", reject);
        });
        req.on("error", reject);
    });
}

function sha256File(filePath) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash("sha256");
        const stream = fs.createReadStream(filePath);
        stream.on("data", (chunk) => hash.update(chunk));
        stream.on("end", () => resolve(hash.digest("hex")));
        stream.on("error", reject);
    });
}

module.exports = { Detector };
