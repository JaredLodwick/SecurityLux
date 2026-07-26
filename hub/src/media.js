"use strict";

/**
 * Media serving: the MJPEG re-fan, single-frame snapshots, and stored files.
 *
 * Split out of server.js because it's the one part of the hub with genuinely
 * fiddly streaming semantics, and it reads better without the lifecycle and
 * WebSocket plumbing wrapped around it.
 *
 * Each function takes the hub as its first argument rather than being a method,
 * so the streaming logic can be reasoned about (and exercised) without
 * constructing a whole server.
 */

const { sendError, serveFile } = require("./http-util");

const MJPEG_BOUNDARY = "frame";

/**
 * How long the MJPEG loop will sit silent before re-sending the last frame.
 *
 * A multipart response that sends nothing for minutes is indistinguishable
 * from a hung connection to intermediaries and to some browser engines, which
 * then quietly drop it. Re-sending the newest frame proves the connection is
 * alive and costs one frame every ten seconds on an idle camera.
 */
const MJPEG_KEEPALIVE_MS = 10_000;

/** Poll interval while waiting for a new frame to arrive. */
const FRAME_POLL_MS = 50;

/**
 * Re-fan the buffered frames to one HTTP viewer as `multipart/x-mixed-replace`.
 *
 * Last-writer-wins with no per-client queue: a slow viewer drops frames rather
 * than accumulating latency, and one stalled browser can't back up the camera's
 * ingest path or anyone else's stream.
 */
function serveMjpeg(hub, camId, req, res) {
    const cam = hub.getCam(camId);

    res.writeHead(200, {
        "Content-Type": `multipart/x-mixed-replace; boundary=${MJPEG_BOUNDARY}`,
        "Cache-Control": "no-cache, private",
        "Pragma": "no-cache",
        "Connection": "close",
        // Some proxies buffer multipart responses into uselessness. This is the
        // conventional opt-out and is harmless when nothing is proxying.
        "X-Accel-Buffering": "no"
    });

    let lastSeq = -1;
    let lastSentAt = Date.now();
    let closed = false;

    const markClosed = () => { closed = true; };
    req.on("close", markClosed);
    res.on("close", markClosed);
    res.on("error", markClosed);

    const writeFrame = (jpeg) => {
        const head = Buffer.from(
            `--${MJPEG_BOUNDARY}\r\nContent-Type: image/jpeg\r\n` +
            `Content-Length: ${jpeg.length}\r\n\r\n`,
            "ascii"
        );
        res.write(head);
        res.write(jpeg);
        return res.write("\r\n");
    };

    const tick = () => {
        if (closed) return;

        const frame = cam.frameBuffer.latest();
        const hasNew = cam.desiredState === "on" && frame && frame.seq !== lastSeq;
        const needsKeepalive = !hasNew && frame
            && Date.now() - lastSentAt > MJPEG_KEEPALIVE_MS;

        if (!hasNew && !needsKeepalive) {
            setTimeout(tick, FRAME_POLL_MS).unref?.();
            return;
        }

        let drained;
        try {
            drained = writeFrame(frame.jpeg);
        } catch (_) {
            closed = true;
            return;
        }
        if (hasNew) lastSeq = frame.seq;
        lastSentAt = Date.now();

        if (drained === false) {
            // Wait for the socket instead of queueing. Resuming on 'drain' is
            // what keeps a laggy viewer from growing an unbounded backlog.
            res.once("drain", tick);
            return;
        }
        setImmediate(tick);
    };

    tick();
}

/**
 * The newest buffered frame as a single JPEG.
 *
 * Three uses: the zone editor needs a still to draw on, the dashboard can fall
 * back to polled snapshots once there are more cameras than the browser's ~6
 * connections-per-origin budget allows, and it's the graceful degradation path
 * whenever a live stream can't be established.
 */
function serveSnapshot(hub, camId, res) {
    const cam = hub.getCam(camId);
    const frame = cam.frameBuffer.latest();

    if (!frame) {
        return sendError(res, 503, cam.connected
            ? "no frame buffered yet"
            : `camera "${camId}" is not connected`);
    }

    res.writeHead(200, {
        "Content-Type": "image/jpeg",
        "Content-Length": frame.jpeg.length,
        "Cache-Control": "no-store"
    });
    return res.end(frame.jpeg);
}

/**
 * Serve an event's clip or thumbnail.
 *
 * A pruned clip gets its own message rather than a bare 404: "this was removed
 * to reclaim storage, the record remains" is a very different thing from "that
 * event doesn't exist", and conflating them makes the storage policy look like
 * data loss.
 */
function serveEventFile(hub, eventId, kind, req, res) {
    if (!hub.store) return sendError(res, 503, "event store unavailable");

    const event = hub.store.getEvent(eventId);
    if (!event) return sendError(res, 404, "event not found");

    const rel = kind === "thumb" ? event.thumb_path : event.clip_path;
    if (!rel) {
        return sendError(res, 404, event.clip_pruned
            ? "this clip was removed to reclaim storage; the event record remains"
            : `no ${kind} for this event`);
    }

    const abs = hub.storage.resolveClipPath(rel);
    if (!abs) return sendError(res, 400, "invalid path");
    return serveFile(req, res, abs);
}

/** Serve an enrolled face image. */
function serveSampleImage(hub, sampleId, req, res) {
    if (!hub.store) return sendError(res, 503, "event store unavailable");

    const row = hub.store.db
        .prepare("SELECT image_path FROM face_samples WHERE id = ?")
        .get(sampleId);
    if (!row || !row.image_path) return sendError(res, 404, "sample image not found");

    const abs = hub.storage.resolveClipPath(row.image_path);
    if (!abs) return sendError(res, 400, "invalid path");
    return serveFile(req, res, abs);
}

module.exports = {
    serveMjpeg,
    serveSnapshot,
    serveEventFile,
    serveSampleImage,
    MJPEG_BOUNDARY,
    MJPEG_KEEPALIVE_MS
};
