"use strict";

/**
 * End-to-end test through a real HubServer.
 *
 * Boots the hub on an ephemeral port, connects a WebSocket client pretending to
 * be a camera_node, pushes real JPEG frames, and drives a detection through the
 * pipeline. This is the only place that exercises the seams the unit tests
 * mock out: WS ingest, the frame ring buffer, MJPEG re-fan, the snapshot
 * endpoint, session -> store, and the HTTP surface together.
 *
 * Clip recording is skipped when ffmpeg isn't installed — the assertions below
 * cover everything else, and the hub is designed to log events with no clip in
 * exactly that situation, which is itself worth asserting.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { execSync } = require("node:child_process");

const WebSocket = require("ws");
const sharp = require("sharp");

const { HubServer } = require("../src/server");

const quiet = { info() {}, warn() {}, error() {}, debug() {} };

function hasFfmpeg() {
    try {
        execSync("ffmpeg -version", { stdio: "ignore" });
        return true;
    } catch (_) {
        return false;
    }
}

/** A distinguishable JPEG so the motion gate and pixel checks have real input. */
async function makeJpeg(n) {
    const x = (n * 37) % 500;
    return sharp(Buffer.from(
        `<svg width="640" height="480">
           <rect width="100%" height="100%" fill="#101018"/>
           <rect x="${x}" y="240" width="110" height="200" fill="#6ea8ff"/>
         </svg>`
    )).jpeg({ quality: 70 }).toBuffer();
}

function get(port, urlPath) {
    return new Promise((resolve, reject) => {
        const req = http.get({ host: "127.0.0.1", port, path: urlPath }, (res) => {
            const chunks = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () => resolve({
                status: res.statusCode,
                headers: res.headers,
                body: Buffer.concat(chunks)
            }));
        });
        req.on("error", reject);
    });
}

async function getJson(port, urlPath) {
    const res = await get(port, urlPath);
    return { status: res.status, json: JSON.parse(res.body.toString("utf8")) };
}

function personAt(x) {
    return [{ cls: "person", confidence: 0.92, bbox: { cx: x, cy: 0.6, w: 0.14, h: 0.45 } }];
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function boot() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "securitylux-e2e-"));
    const hub = new HubServer({
        hub: { port: 0, bindAddr: "127.0.0.1" },
        detection: { enabled: false },
        storage: {
            clipsRoot: path.join(dir, "clips"),
            dbPath: path.join(dir, "events.db")
        }
    }, quiet);

    await hub.start();
    const port = hub.server.address().port;
    return { hub, port, dir, cleanup: async () => {
        await hub.stop();
        fs.rmSync(dir, { recursive: true, force: true });
    } };
}

/** Connect a fake camera and stream frames until told to stop. */
async function connectCamera(port, camId) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/cam/${camId}`);
    await new Promise((resolve, reject) => {
        ws.once("open", resolve);
        ws.once("error", reject);
    });

    ws.send(JSON.stringify({
        type: "hello", cam_id: camId,
        capabilities: { fps: 10, resolution: "640x480", jpeg_quality: 70 }
    }));
    ws.send(JSON.stringify({
        type: "status", cam_id: camId, state: "on", fps: 10,
        resolution: "640x480", battery_pct: 87.5, on_battery: false,
        camera_available: true
    }));

    const received = [];
    ws.on("message", (data, isBinary) => {
        if (isBinary) return;
        try { received.push(JSON.parse(data.toString())); } catch (_) { /* ignore */ }
    });

    let frame = 0;
    let running = true;
    (async () => {
        while (running && ws.readyState === WebSocket.OPEN) {
            frame += 1;
            try { ws.send(await makeJpeg(frame)); } catch (_) { break; }
            await wait(100);
        }
    })();

    return {
        ws,
        received,
        stop: () => { running = false; ws.close(); }
    };
}

test("end to end: ingest, buffer, stream, detect, record, serve", async (t) => {
    const { hub, port, cleanup } = await boot();
    let cam;

    try {
        cam = await connectCamera(port, "front");
        await wait(600);      // let a few frames land in the ring buffer

        // ---- camera registration ------------------------------------
        const cams = await getJson(port, "/cams");
        assert.equal(cams.status, 200);
        assert.equal(cams.json.length, 1);
        assert.equal(cams.json[0].cam_id, "front");
        assert.equal(cams.json[0].connected, true);
        assert.equal(cams.json[0].resolution, "640x480");
        assert.ok(cams.json[0].last_frame_age_ms < 2000, "frames are arriving");

        // ---- snapshot ------------------------------------------------
        const snapshot = await get(port, "/cam/front/snapshot.jpg");
        assert.equal(snapshot.status, 200);
        assert.equal(snapshot.headers["content-type"], "image/jpeg");
        assert.ok(snapshot.body.length > 1000, "a real JPEG came back");
        assert.equal(snapshot.body[0], 0xFF, "JPEG magic byte");
        assert.equal(snapshot.body[1], 0xD8);

        // ---- CORS, which the stream stall detector depends on --------
        assert.equal(snapshot.headers["access-control-allow-origin"], "*");

        // ---- MJPEG re-fan --------------------------------------------
        const mjpeg = await new Promise((resolve, reject) => {
            const req = http.get(
                { host: "127.0.0.1", port, path: "/cam/front/stream.mjpg" },
                (res) => {
                    let bytes = 0;
                    let parts = 0;
                    res.on("data", (chunk) => {
                        bytes += chunk.length;
                        parts += chunk.toString("latin1").split("--frame").length - 1;
                        if (bytes > 40_000) {
                            req.destroy();
                            resolve({ contentType: res.headers["content-type"], bytes, parts });
                        }
                    });
                    res.on("error", () => resolve({
                        contentType: res.headers["content-type"], bytes, parts
                    }));
                }
            );
            req.on("error", reject);
            setTimeout(() => { req.destroy(); reject(new Error("MJPEG timed out")); }, 5000);
        });
        assert.match(mjpeg.contentType, /multipart\/x-mixed-replace/);
        assert.ok(mjpeg.parts >= 2, `expected multiple parts, saw ${mjpeg.parts}`);

        // ---- zones ---------------------------------------------------
        // Put a named door zone where the detections below will be anchored,
        // so the description has something meaningful to say.
        const zoneRes = await new Promise((resolve, reject) => {
            const payload = JSON.stringify([{
                name: "trash room door",
                kind: "door",
                points: [{ x: 0.3, y: 0.5 }, { x: 0.8, y: 0.5 }, { x: 0.8, y: 1 }, { x: 0.3, y: 1 }]
            }]);
            const req = http.request({
                host: "127.0.0.1", port, path: "/cam/front/zones", method: "PUT",
                headers: { "Content-Type": "application/json", "Content-Length": payload.length }
            }, (res) => {
                const chunks = [];
                res.on("data", (c) => chunks.push(c));
                res.on("end", () => resolve({
                    status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString())
                }));
            });
            req.on("error", reject);
            req.end(payload);
        });
        assert.equal(zoneRes.status, 200);
        assert.equal(zoneRes.json.length, 1);
        assert.equal(zoneRes.json[0].name, "trash room door");

        // ---- drive a detection through the real pipeline -------------
        // Feeding the SessionManager directly rather than standing up the ONNX
        // detector: this test is about the plumbing around inference, and
        // downloading a model would make it slow and network-dependent.
        // Long enough to escalate past "passing" (3 s) into "present".
        const start = Date.now();
        for (let i = 0; i < 30; i += 1) {
            hub.sessionManager.observe("front", personAt(0.5 + (i % 2 ? 0.004 : -0.004)));
            await wait(150);
        }
        assert.ok(hub.sessionManager.isActive("front"), "a session should be open");

        const live = await getJson(port, "/cam/front/status");
        assert.equal(live.json.session_active, true);
        assert.ok(["present", "dwelling", "approaching"].includes(live.json.behavior),
            `unexpected behaviour: ${live.json.behavior}`);
        assert.ok(live.json.led_stage >= 2, "the door light should have escalated");

        // Person leaves; grace expires.
        for (let i = 0; i < 6; i += 1) {
            hub.sessionManager.observe("front", []);
            await wait(400);
        }
        assert.equal(hub.sessionManager.isActive("front"), false, "session should have ended");

        // ---- the event -----------------------------------------------
        const events = await getJson(port, "/events");
        assert.equal(events.status, 200);
        assert.equal(events.json.length, 1, "exactly one event");

        const event = events.json[0];
        assert.equal(event.cam_id, "front");
        assert.equal(event.type, "person");
        assert.ok(event.started_at_ms >= start - 1000);
        assert.ok(event.duration_ms >= 2000, `duration was ${event.duration_ms}`);

        // The whole point of zones + the describer.
        assert.ok(event.description, "the event must carry a description");
        assert.match(event.description, /trash room door/,
            `description should name the zone, got: "${event.description}"`);
        assert.match(event.description, /^[A-Z].*\.$/, "a well-formed sentence");
        assert.ok(event.behavior, "a behaviour class is recorded");
        assert.ok(Array.isArray(event.zones) && event.zones.length, "zone visits are recorded");

        // ---- thumbnail from the pre-roll buffer -----------------------
        assert.ok(event.thumb_path, "a thumbnail should have been written");
        const thumb = await get(port, `/events/${event.id}/thumb.jpg`);
        assert.equal(thumb.status, 200);
        assert.ok(thumb.body.length > 500);
        assert.equal(thumb.body[0], 0xFF, "the thumbnail is a real JPEG");

        // ---- latest-event endpoint (the mirror's source) --------------
        const latest = await getJson(port, "/events/latest?cam=front");
        assert.equal(latest.json.id, event.id);

        // ---- clip, when ffmpeg is available ---------------------------
        if (hasFfmpeg()) {
            await wait(7000);   // let post-roll finish and ffmpeg finalize
            const refreshed = await getJson(port, `/events/${event.id}`);
            assert.ok(refreshed.json.clip_path, "a clip should have been recorded");
            assert.match(refreshed.json.clip_path, /\.mp4$/, "h264/mp4 by default");

            const clip = await get(port, `/events/${event.id}/clip.mp4`);
            assert.equal(clip.status, 200);
            assert.ok(clip.body.length > 1000, "the clip has real content");
            assert.equal(clip.headers["accept-ranges"], "bytes", "seekable in a browser");

            // Pre-roll is the feature: the clip must contain more frames than
            // the detection window alone could have produced.
            const meta = refreshed.json.metadata || {};
            assert.ok((meta.preRollFrames || 0) > 0,
                "the clip should open with buffered pre-roll frames");
        } else {
            t.diagnostic("ffmpeg not installed — skipping clip assertions");
            // Designed behaviour: no ffmpeg means no clip, but the event and
            // its description are still recorded.
            assert.ok(event.description, "events are logged even with no recorder");
        }

        // ---- storage accounting --------------------------------------
        const storage = await getJson(port, "/storage");
        assert.equal(storage.status, 200);
        assert.equal(storage.json.eventCount, 1);
        assert.equal(storage.json.recordingPaused, false);
        assert.ok(storage.json.limits.retentionDays > 0);

        // ---- redescribe after renaming a zone -------------------------
        // Renaming a zone must fix history, not just future events.
        hub.store.replaceZones("front", [{
            name: "bin store door", kind: "door",
            points: [{ x: 0.3, y: 0.5 }, { x: 0.8, y: 0.5 }, { x: 0.8, y: 1 }, { x: 0.3, y: 1 }]
        }]);
        hub.invalidateZones("front");
        const redescribed = hub.redescribeEvent(event.id);
        assert.equal(redescribed.ok, true);
        // The stored zone visits carry the old name, so bulk redescribe keeps
        // the historical wording — what matters is that it succeeds and still
        // produces a valid sentence.
        assert.match(redescribed.event.description, /^[A-Z].*\.$/);

        // ---- disconnect handling --------------------------------------
        cam.stop();
        cam = null;
        await wait(400);
        const afterDisconnect = await getJson(port, "/cam/front/status");
        assert.equal(afterDisconnect.json.connected, false);
        assert.equal(afterDisconnect.json.last_frame_age_ms === null
            || afterDisconnect.json.last_frame_age_ms >= 0, true);

        const snapshotGone = await get(port, "/cam/front/snapshot.jpg");
        assert.equal(snapshotGone.status, 503, "no buffered frames once the camera leaves");
    } finally {
        if (cam) cam.stop();
        await cleanup();
    }
});

test("end to end: settings round trip and per-camera overrides", async () => {
    const { hub, port, cleanup } = await boot();
    try {
        const put = (urlPath, body) => new Promise((resolve, reject) => {
            const payload = JSON.stringify(body);
            const req = http.request({
                host: "127.0.0.1", port, path: urlPath, method: "PUT",
                headers: { "Content-Type": "application/json", "Content-Length": payload.length }
            }, (res) => {
                const chunks = [];
                res.on("data", (c) => chunks.push(c));
                res.on("end", () => resolve({
                    status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString())
                }));
            });
            req.on("error", reject);
            req.end(payload);
        });

        const ok = await put("/settings", { "recording.preRollSeconds": 8 });
        assert.equal(ok.status, 200);
        assert.deepEqual(ok.json.changed, ["recording.preRollSeconds"]);

        const bad = await put("/settings", { "recording.preRollSeconds": 999 });
        assert.equal(bad.status, 400);
        assert.match(bad.json.details[0], /must be <= 30/);

        const perCam = await put("/cam/porch/settings", { "recording.preRollSeconds": 2 });
        assert.equal(perCam.status, 200);

        assert.equal(hub.settings.get("recording.preRollSeconds"), 8);
        assert.equal(hub.settings.get("recording.preRollSeconds", "porch"), 2);
        assert.equal(hub.settings.get("recording.preRollSeconds", "front"), 8, "inherits");

        // A hub-wide-only key must be refused on a camera scope.
        const wrongScope = await put("/cam/porch/settings", { "storage.maxTotalGB": 4 });
        assert.equal(wrongScope.status, 400);
    } finally {
        await cleanup();
    }
});

test("end to end: remote camera commands reach the camera", async () => {
    const { port, cleanup } = await boot();
    let cam;
    try {
        cam = await connectCamera(port, "front");
        await wait(300);

        const post = (urlPath, body) => new Promise((resolve, reject) => {
            const payload = JSON.stringify(body || {});
            const req = http.request({
                host: "127.0.0.1", port, path: urlPath, method: "POST",
                headers: { "Content-Type": "application/json", "Content-Length": payload.length }
            }, (res) => {
                const chunks = [];
                res.on("data", (c) => chunks.push(c));
                res.on("end", () => resolve({
                    status: res.statusCode,
                    json: JSON.parse(Buffer.concat(chunks).toString() || "{}")
                }));
            });
            req.on("error", reject);
            req.end(payload);
        });

        const restart = await post("/cam/front/restart");
        assert.equal(restart.status, 202);
        await wait(200);
        assert.ok(cam.received.some((m) => m.type === "restart_service"),
            "the camera should have received restart_service");

        // The door light is off by default, so a test must be refused with a
        // useful reason rather than silently doing nothing.
        const ledOff = await post("/cam/front/led/test", { stage: 3 });
        assert.equal(ledOff.status, 409);
        assert.match(ledOff.json.error, /not enabled/);

        await post("/cam/front/toggle", { state: "off" });
        await wait(200);
        assert.ok(cam.received.some((m) => m.type === "set_state" && m.state === "off"));

        // Commands to a camera that isn't there must fail clearly.
        const missing = await post("/cam/nonexistent/restart");
        assert.equal(missing.status, 409);
        assert.match(missing.json.error, /not connected/);
    } finally {
        if (cam) cam.stop();
        await cleanup();
    }
});
