"use strict";

/**
 * Detector worker — runs inside `worker_threads.Worker`.
 *
 * Loads ONNX Runtime + sharp once, holds the model in memory, and answers
 * inference requests from the main thread. The main thread posts:
 *
 *   { kind: "infer", jobId, camId, frameSeq, jpeg: ArrayBuffer, confidence }
 *
 * This worker replies with:
 *
 *   { kind: "result", jobId, camId, frameSeq, detections: [...], latencyMs }
 *   { kind: "error",  jobId, message }
 *
 * Detections are filtered server-side: only `class=0` (person) above the
 * confidence threshold are returned. The main thread doesn't see the raw
 * 8400-candidate output — saves message-passing cost.
 */

const { parentPort, workerData } = require("node:worker_threads");

// Lazy-required so we can return a clean error to the main thread if a dep
// is missing instead of crashing the worker before it can respond.
let ort;
let sharp;

const INPUT_W = 320;
const INPUT_H = 320;
const NUM_CLASSES = 80;
const NUM_CANDIDATES = 8400;       // YOLOv8 at 320×320: 8400 anchors
const PERSON_CLASS_INDEX = 0;

let session;
let inputTensor;
let inputBuffer;          // Float32Array reused per frame to avoid GC churn

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

        // sharp gives HWC uint8; YOLO wants CHW float32 normalized [0, 1].
        // The buffer is preallocated; just overwrite in place.
        const hwSize = INPUT_H * INPUT_W;
        for (let y = 0; y < INPUT_H; y += 1) {
            for (let x = 0; x < INPUT_W; x += 1) {
                const srcOff = (y * INPUT_W + x) * 3;
                const dstOff = y * INPUT_W + x;
                inputBuffer[dstOff] = data[srcOff] / 255;                  // R
                inputBuffer[hwSize + dstOff] = data[srcOff + 1] / 255;     // G
                inputBuffer[2 * hwSize + dstOff] = data[srcOff + 2] / 255; // B
            }
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

/**
 * YOLOv8 head output is laid out as [1, 4 + numClasses, numCandidates] in
 * channel-first order. For each candidate column we read cx, cy, w, h and
 * the class scores.
 *
 * For our use case we only care about the top-scoring person box per frame —
 * no NMS, no multi-detection — so we walk linearly and remember the best.
 */
function decodeYolo(buf, confidenceThreshold) {
    const stride = NUM_CANDIDATES;
    let bestScore = 0;
    let bestIdx = -1;

    // YOLOv8 outputs raw class logits passed through a sigmoid implicitly when
    // exported; values land in [0, 1]. The person column starts at offset
    // (4 + 0) * stride = 4 * stride.
    const personChannelOffset = (4 + PERSON_CLASS_INDEX) * stride;
    for (let i = 0; i < NUM_CANDIDATES; i += 1) {
        const score = buf[personChannelOffset + i];
        if (score > bestScore) {
            bestScore = score;
            bestIdx = i;
        }
    }

    if (bestIdx < 0 || bestScore < confidenceThreshold) return [];

    // YOLO outputs cx/cy/w/h in the input image space (320×320). The pre-
    // process resizes with `fit: "fill"`, so dividing by INPUT_W/H gives
    // normalized 0-1 coords that map directly to whatever size the browser
    // ends up rendering at.
    const cx = buf[0 * stride + bestIdx] / INPUT_W;
    const cy = buf[1 * stride + bestIdx] / INPUT_H;
    const w  = buf[2 * stride + bestIdx] / INPUT_W;
    const h  = buf[3 * stride + bestIdx] / INPUT_H;

    return [{
        cls: "person",
        confidence: bestScore,
        bbox: { cx, cy, w, h }
    }];
}

parentPort.on("message", async (msg) => {
    if (!msg || typeof msg !== "object") return;
    if (msg.kind === "infer") return infer(msg);
    if (msg.kind === "shutdown") {
        try { if (session) await session.release(); } catch (_) { /* ignore */ }
        process.exit(0);
    }
});

init();
