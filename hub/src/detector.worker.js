"use strict";

/**
 * Detector worker — runs inside `worker_threads.Worker`.
 *
 * Loads ONNX Runtime + sharp once, holds the model in memory, and answers
 * inference requests from the main thread:
 *
 *   in   { kind: "infer", jobId, camId, frameSeq, jpeg: ArrayBuffer,
 *          confidence, motionGate, motionThreshold, force }
 *   out  { kind: "result", jobId, camId, frameSeq, detections, latencyMs, skipped }
 *   out  { kind: "error",  jobId, message }
 *
 * ============================================================================
 *  The motion gate
 * ============================================================================
 *
 * Most frames from a doorway camera are of an empty doorway. Running a neural
 * net over them is the single largest source of idle CPU on the hub.
 *
 * The gate lives here rather than on the main thread because of how the costs
 * split: decoding the JPEG runs ~15 ms, the model runs ~150 ms. We have to
 * decode either way to compare pixels, so doing the check here skips the part
 * that actually hurts, and the main thread never has to touch image data.
 *
 * The signature is a 32x32 grayscale reduction of the frame we already resized
 * for the model — no second decode.
 *
 * `force` is essential and not an optimisation switch: a person standing
 * perfectly still produces no motion, so a naive gate would lose them and end
 * the recording while they were still at the door. The main thread sets `force`
 * whenever a session is active, and periodically regardless.
 */

const { parentPort, workerData } = require("node:worker_threads");

// Lazy-required so a missing dep produces a clean message to the main thread
// instead of killing the worker before it can report anything.
let ort;
let sharp;

const INPUT_W = 320;
const INPUT_H = 320;
const NUM_CANDIDATES = 8400;       // YOLOv8 at 320x320
const PERSON_CLASS_INDEX = 0;
const MAX_DETECTIONS = 8;
const NMS_IOU_THRESHOLD = 0.45;

// Motion signature grid. 32x32 is coarse enough to ignore sensor noise and
// fine enough that a person at the far end of a driveway still registers.
const SIG_SIZE = 32;
const SIG_CELLS = SIG_SIZE * SIG_SIZE;
const SIG_NOISE_FLOOR = 12;        // per-cell gray delta below this is sensor noise

let session;
let inputTensor;
let inputBuffer;
const signatures = new Map();      // camId -> Uint8Array(SIG_CELLS)

async function init() {
    try {
        // eslint-disable-next-line global-require
        ort = require("onnxruntime-node");
        // eslint-disable-next-line global-require
        sharp = require("sharp");
    } catch (err) {
        parentPort.postMessage({
            kind: "error",
            fatal: true,
            message: `Missing dep (${err.message}). Install: npm install onnxruntime-node sharp.`
        });
        return;
    }

    try {
        session = await ort.InferenceSession.create(workerData.modelPath, {
            executionProviders: ["xnnpack", "cpu"],
            graphOptimizationLevel: "all"
        });
    } catch (err) {
        parentPort.postMessage({
            kind: "error",
            fatal: true,
            message: `Failed to load model at ${workerData.modelPath}: ${err.message}`
        });
        return;
    }

    inputBuffer = new Float32Array(1 * 3 * INPUT_H * INPUT_W);
    inputTensor = new ort.Tensor("float32", inputBuffer, [1, 3, INPUT_H, INPUT_W]);

    parentPort.postMessage({
        kind: "ready",
        inputName: session.inputNames[0],
        outputName: session.outputNames[0]
    });
}

async function infer(msg) {
    const t0 = Date.now();
    try {
        const jpeg = Buffer.from(msg.jpeg);
        const { data } = await sharp(jpeg)
            .resize(INPUT_W, INPUT_H, { fit: "fill" })
            .removeAlpha()
            .raw()
            .toBuffer({ resolveWithObject: true });

        if (msg.motionGate && !msg.force) {
            const moved = checkMotion(msg.camId, data, msg.motionThreshold);
            if (!moved) {
                parentPort.postMessage({
                    kind: "result",
                    jobId: msg.jobId,
                    camId: msg.camId,
                    frameSeq: msg.frameSeq,
                    detections: [],
                    skipped: true,
                    latencyMs: Date.now() - t0
                });
                return;
            }
        } else if (msg.motionGate) {
            // Keep the reference current even on forced frames, so the gate
            // doesn't fire spuriously on the first unforced frame afterwards.
            updateSignature(msg.camId, data);
        }

        // sharp gives HWC uint8; YOLO wants CHW float32 normalized to [0, 1].
        const hwSize = INPUT_H * INPUT_W;
        for (let i = 0; i < hwSize; i += 1) {
            const src = i * 3;
            inputBuffer[i] = data[src] / 255;
            inputBuffer[hwSize + i] = data[src + 1] / 255;
            inputBuffer[2 * hwSize + i] = data[src + 2] / 255;
        }

        const feeds = { [session.inputNames[0]]: inputTensor };
        const out = await session.run(feeds);
        const outTensor = out[session.outputNames[0]];
        const detections = decodeYolo(outTensor.data, msg.confidence);

        parentPort.postMessage({
            kind: "result",
            jobId: msg.jobId,
            camId: msg.camId,
            frameSeq: msg.frameSeq,
            detections,
            skipped: false,
            latencyMs: Date.now() - t0
        });
    } catch (err) {
        parentPort.postMessage({
            kind: "error",
            jobId: msg.jobId,
            message: err && err.message
        });
    }
}

/** Average an RGB block down to one gray value per signature cell. */
function buildSignature(rgb) {
    const sig = new Uint8Array(SIG_CELLS);
    const block = INPUT_W / SIG_SIZE;      // 320 / 32 = 10
    for (let cy = 0; cy < SIG_SIZE; cy += 1) {
        for (let cx = 0; cx < SIG_SIZE; cx += 1) {
            let acc = 0;
            for (let y = 0; y < block; y += 1) {
                const row = (cy * block + y) * INPUT_W;
                for (let x = 0; x < block; x += 1) {
                    const src = (row + cx * block + x) * 3;
                    // Rec. 601 luma, integer-weighted.
                    acc += (rgb[src] * 77 + rgb[src + 1] * 150 + rgb[src + 2] * 29) >> 8;
                }
            }
            sig[cy * SIG_SIZE + cx] = acc / (block * block);
        }
    }
    return sig;
}

function updateSignature(camId, rgb) {
    signatures.set(camId, buildSignature(rgb));
}

/**
 * True when enough of the frame changed to be worth running the model.
 *
 * The reference is replaced on every call, so a slow lighting change (dusk,
 * a cloud) never accumulates into a false trigger — only frame-to-frame
 * movement counts.
 */
function checkMotion(camId, rgb, threshold) {
    const sig = buildSignature(rgb);
    const prev = signatures.get(camId);
    signatures.set(camId, sig);

    // First frame from this camera: nothing to compare against, so let it
    // through rather than blinding ourselves for one tick.
    if (!prev) return true;

    let changed = 0;
    for (let i = 0; i < SIG_CELLS; i += 1) {
        if (Math.abs(sig[i] - prev[i]) > SIG_NOISE_FLOOR) changed += 1;
    }
    const fraction = changed / SIG_CELLS;
    return fraction >= (threshold ?? 0.012);
}

/**
 * YOLOv8 head output is [1, 4 + numClasses, numCandidates] in channel-first
 * order: for candidate i, cx is at buf[0*stride+i], cy at buf[1*stride+i], and
 * the person score at buf[4*stride+i].
 *
 * Multiple people matter now — the tracker needs every box to tell one person
 * standing still apart from two people walking past — so this collects all
 * candidates over threshold and runs non-maximum suppression rather than
 * keeping only the best.
 */
function decodeYolo(buf, confidenceThreshold) {
    const stride = NUM_CANDIDATES;
    const personOffset = (4 + PERSON_CLASS_INDEX) * stride;
    const threshold = confidenceThreshold ?? 0.45;

    const candidates = [];
    for (let i = 0; i < NUM_CANDIDATES; i += 1) {
        const score = buf[personOffset + i];
        if (score < threshold) continue;
        candidates.push({
            confidence: score,
            // The preprocess resizes with `fit: "fill"`, so dividing by the
            // input dims gives normalized 0-1 coords that map directly onto
            // whatever size a browser renders the feed at.
            cx: buf[i] / INPUT_W,
            cy: buf[stride + i] / INPUT_H,
            w: buf[2 * stride + i] / INPUT_W,
            h: buf[3 * stride + i] / INPUT_H
        });
    }
    if (!candidates.length) return [];

    candidates.sort((a, b) => b.confidence - a.confidence);

    const kept = [];
    for (const cand of candidates) {
        if (kept.length >= MAX_DETECTIONS) break;
        let overlaps = false;
        for (const k of kept) {
            if (iou(cand, k) > NMS_IOU_THRESHOLD) { overlaps = true; break; }
        }
        if (!overlaps) kept.push(cand);
    }

    return kept.map((d) => ({
        cls: "person",
        confidence: d.confidence,
        bbox: { cx: d.cx, cy: d.cy, w: d.w, h: d.h }
    }));
}

/** Intersection over union for two centre-form boxes. */
function iou(a, b) {
    const ax1 = a.cx - a.w / 2;
    const ay1 = a.cy - a.h / 2;
    const ax2 = a.cx + a.w / 2;
    const ay2 = a.cy + a.h / 2;
    const bx1 = b.cx - b.w / 2;
    const by1 = b.cy - b.h / 2;
    const bx2 = b.cx + b.w / 2;
    const by2 = b.cy + b.h / 2;

    const ix = Math.max(0, Math.min(ax2, bx2) - Math.max(ax1, bx1));
    const iy = Math.max(0, Math.min(ay2, by2) - Math.max(ay1, by1));
    const inter = ix * iy;
    if (inter <= 0) return 0;

    const union = (ax2 - ax1) * (ay2 - ay1) + (bx2 - bx1) * (by2 - by1) - inter;
    return union > 0 ? inter / union : 0;
}

// Guarded so the pure decode helpers below can be required directly by unit
// tests without a worker host — `parentPort` is null outside a Worker.
if (parentPort) {
    parentPort.on("message", async (msg) => {
        if (!msg || typeof msg !== "object") return;
        if (msg.kind === "infer") return infer(msg);
        if (msg.kind === "forget") { signatures.delete(msg.camId); return; }
        if (msg.kind === "shutdown") {
            try { if (session) await session.release(); } catch (_) { /* ignore */ }
            process.exit(0);
        }
    });

    init();
}

module.exports = { decodeYolo, iou, buildSignature, checkMotion };
