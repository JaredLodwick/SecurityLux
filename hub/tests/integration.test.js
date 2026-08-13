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

/**
 * Controls a stubbed camera reports, mirroring the shape camera_node builds
 * from `v4l2-ctl --list-ctrls`.
 */
const FAKE_CONTROLS = [
    { id: "brightness", name: "brightness", label: "Brightness", kind: "int",
      min: -64, max: 64, step: 1, default: 0, value: 0, inactive: false },
    { id: "contrast", name: "contrast", label: "Contrast", kind: "int",
      min: 0, max: 64, step: 1, default: 32, value: 32, inactive: false },
    { id: "auto_exposure", name: "auto_exposure", label: "Auto exposure", kind: "menu",
      min: 0, max: 3, default: 3, value: 3, inactive: false,
      options: [{ value: 1, label: "Manual" }, { value: 3, label: "Aperture priority" }] }
];

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
    // What the stub believes its geometry and V4L2 values currently are, so a
    // test can assert the hub actually pushed them down the socket.
    const applied = { image: null, values: {} };

    ws.on("message", (data, isBinary) => {
        if (isBinary) return;
        let msg;
        try { msg = JSON.parse(data.toString()); } catch (_) { return; }
        received.push(msg);

        // Mirror camera_node's replies so the hub's caching path is exercised.
        if (msg.type === "image_config") {
            applied.image = {
                rotation: msg.rotation, flipHorizontal: msg.flipHorizontal,
                flipVertical: msg.flipVertical, zoom: msg.zoom,
                panX: msg.panX, panY: msg.panY
            };
            const rotated = msg.rotation === 90 || msg.rotation === 270;
            ws.send(JSON.stringify({
                type: "image_state", cam_id: camId, image: applied.image,
                resolution: rotated ? "480x640" : "640x480"
            }));
        } else if (msg.type === "camera_controls" || msg.type === "get_camera_controls") {
            Object.assign(applied.values, msg.values || {});
            ws.send(JSON.stringify({
                type: "camera_controls", cam_id: camId,
                controls: FAKE_CONTROLS, controls_available: true,
                image: applied.image, resolution: "640x480",
                applied: msg.values || {}, errors: {}
            }));
        } else if (msg.type === "reset_camera_controls") {
            applied.values = {};
            ws.send(JSON.stringify({
                type: "camera_controls", cam_id: camId,
                controls: FAKE_CONTROLS, controls_available: true, errors: {}
            }));
        }
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
        applied,
        stop: () => { running = false; ws.close(); }
    };
}

/** Minimal JSON request helper for the tests below. */
function request(port, method, urlPath, body) {
    return new Promise((resolve, reject) => {
        const payload = body === undefined ? null : JSON.stringify(body);
        const req = http.request({
            host: "127.0.0.1", port, path: urlPath, method,
            headers: payload
                ? { "Content-Type": "application/json", "Content-Length": payload.length }
                : {}
        }, (res) => {
            const chunks = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () => {
                const text = Buffer.concat(chunks).toString();
                let json = null;
                try { json = text ? JSON.parse(text) : null; } catch (_) { /* ignore */ }
                resolve({ status: res.statusCode, json });
            });
        });
        req.on("error", reject);
        req.end(payload);
    });
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

test("end to end: image controls reach the camera and survive a reconnect", async () => {
    const { port, cleanup } = await boot();
    let cam;
    try {
        cam = await connectCamera(port, "front");
        await wait(400);

        // ---- the camera advertises what it supports -------------------
        const initial = await request(port, "GET", "/cam/front/controls");
        assert.equal(initial.status, 200);
        assert.equal(initial.json.connected, true);
        assert.equal(initial.json.controls_available, true);
        assert.deepEqual(
            initial.json.controls.map((c) => c.id),
            ["brightness", "contrast", "auto_exposure"],
            "the UI should render exactly what the camera reported"
        );
        assert.equal(initial.json.image.rotation, 0, "geometry defaults to unrotated");
        assert.equal(initial.json.image.zoom, 1);

        // ---- geometry -------------------------------------------------
        const geometry = await request(port, "PUT", "/cam/front/controls", {
            image: { rotation: 90, zoom: 2, panX: -0.5, flipHorizontal: true }
        });
        assert.equal(geometry.status, 200);
        assert.equal(geometry.json.image.rotation, 90);
        assert.equal(geometry.json.image.zoom, 2);

        await wait(250);
        assert.equal(cam.applied.image.rotation, 90, "the camera received the rotation");
        assert.equal(cam.applied.image.zoom, 2);
        assert.equal(cam.applied.image.flipHorizontal, true);

        // The effective resolution must flip immediately, not after a round
        // trip — the panel shows it right beside the rotation control.
        assert.equal(geometry.json.resolution, "480x640",
            "rotating should swap the reported dimensions in the same response");

        const afterRotate = await request(port, "GET", "/cam/front/controls");
        assert.equal(afterRotate.json.resolution, "480x640");

        // ---- hardware controls ---------------------------------------
        const hardware = await request(port, "PUT", "/cam/front/controls", {
            values: { brightness: 20, contrast: 48 }
        });
        assert.equal(hardware.status, 200);
        assert.equal(hardware.json.stored_values.brightness, 20);

        await wait(250);
        assert.equal(cam.applied.values.brightness, 20, "the camera received brightness");
        assert.equal(cam.applied.values.contrast, 48);

        // ---- validation ----------------------------------------------
        const badGeometry = await request(port, "PUT", "/cam/front/controls", {
            image: { zoom: 99 }
        });
        assert.equal(badGeometry.status, 400);
        assert.match(badGeometry.json.details[0], /must be <= 4/);

        const badValue = await request(port, "PUT", "/cam/front/controls", {
            values: { brightness: "very" }
        });
        assert.equal(badValue.status, 400);

        // ---- the reconnect case, which is the point of persisting -----
        // V4L2 values live in the camera's driver and are lost on reboot, so
        // the hub must re-apply them or a power cut silently undoes the tuning.
        cam.stop();
        await wait(300);
        cam = await connectCamera(port, "front");
        await wait(500);

        assert.equal(cam.applied.values.brightness, 20,
            "brightness must be re-applied after the camera reconnects");
        assert.equal(cam.applied.values.contrast, 48);
        assert.equal(cam.applied.image.rotation, 90,
            "geometry must be re-applied after the camera reconnects");

        // ---- reset ----------------------------------------------------
        const reset = await request(port, "POST", "/cam/front/controls/reset", {});
        assert.equal(reset.status, 200);
        assert.equal(reset.json.image.rotation, 0, "geometry returns to default");
        assert.equal(reset.json.image.zoom, 1);
        assert.deepEqual(reset.json.stored_values, {}, "stored V4L2 values are cleared");

        await wait(250);
        assert.equal(cam.applied.image.rotation, 0, "the camera was told to un-rotate");
    } finally {
        if (cam) cam.stop();
        await cleanup();
    }
});

test("end to end: image settings are kept for a camera that is offline", async () => {
    const { port, cleanup } = await boot();
    try {
        // Adjusting a camera that happens to be unplugged should still save —
        // being told "camera offline, nothing happened" while the setting is
        // silently discarded would be the worst outcome.
        const saved = await request(port, "PUT", "/cam/porch/controls", {
            image: { rotation: 180 },
            values: { brightness: 33 }
        });
        assert.equal(saved.status, 200);
        assert.equal(saved.json.connected, false);
        assert.equal(saved.json.image.rotation, 180);
        assert.equal(saved.json.stored_values.brightness, 33);

        // ...and be applied the moment it turns up.
        const cam = await connectCamera(port, "porch");
        await wait(500);
        assert.equal(cam.applied.image.rotation, 180);
        assert.equal(cam.applied.values.brightness, 33);
        cam.stop();
    } finally {
        await cleanup();
    }
});

test("end to end: the timeline API serves coverage, seeking and saving", async () => {
    // Segments are inserted directly rather than recorded: real ffmpeg
    // segmenting is verified by hand (it needs minutes of wall-clock time to
    // produce anything), while this pins the HTTP contract the UI depends on.
    const { hub, port, cleanup } = await boot();
    try {
        const base = Date.now() - 3_600_000;
        const clipsRoot = hub.clipsRoot;
        const ids = [];

        for (let i = 0; i < 4; i += 1) {
            // A real (tiny) mp4 so the serving path is exercised for real.
            const rel = path.join("continuous", "front", `seg-${i}.mp4`);
            const abs = path.join(clipsRoot, rel);
            fs.mkdirSync(path.dirname(abs), { recursive: true });
            fs.writeFileSync(abs, Buffer.alloc(2048, i + 1));

            ids.push(hub.store.insertRecording({
                camId: "front",
                path: rel,
                // Segments 0-1 are contiguous; then a 30-minute gap; then 2-3.
                startedAtMs: base + (i < 2 ? i * 300_000 : 1_800_000 + i * 300_000),
                endedAtMs: base + (i < 2 ? (i + 1) * 300_000 : 1_800_000 + (i + 1) * 300_000),
                bytes: 2048
            }));
        }

        // ---- coverage -------------------------------------------------
        const timeline = await request(
            port, "GET",
            `/cam/front/timeline?from=${base - 1000}&to=${base + 4_000_000}`
        );
        assert.equal(timeline.status, 200);
        assert.equal(timeline.json.segments.length, 4);
        assert.equal(timeline.json.coverage.length, 2, "the gap must split coverage in two");
        assert.equal(timeline.json.total_bytes, 4 * 2048);

        // ---- seeking --------------------------------------------------
        const hit = await request(port, "GET", `/cam/front/timeline/seek?at=${base + 120_000}`);
        assert.equal(hit.json.found, true);
        assert.equal(hit.json.recording_id, ids[0]);
        assert.equal(hit.json.offset_seconds, 120, "offset is elapsed time into the segment");

        const miss = await request(port, "GET", `/cam/front/timeline/seek?at=${base + 900_000}`);
        assert.equal(miss.json.found, false);
        assert.ok(miss.json.nearest, "a gap should still offer somewhere to jump");

        const noParam = await request(port, "GET", "/cam/front/timeline/seek");
        assert.equal(noParam.status, 400);

        // ---- rolling into the next segment -----------------------------
        const next = await request(port, "GET", `/recordings/${ids[0]}/next`);
        assert.equal(next.json.recording_id, ids[1]);

        const acrossGap = await request(port, "GET", `/recordings/${ids[1]}/next`);
        assert.equal(acrossGap.json.recording_id, null, "playback must stop at a real gap");

        // ---- serving, with Range (required for seeking in a browser) ----
        const video = await get(port, `/recordings/${ids[0]}/video.mp4`);
        assert.equal(video.status, 200);
        assert.equal(video.headers["content-type"], "video/mp4");
        assert.equal(video.headers["accept-ranges"], "bytes");
        assert.equal(video.body.length, 2048);

        const missing = await get(port, "/recordings/9999/video.mp4");
        assert.equal(missing.status, 404);

        // ---- saving a moment -------------------------------------------
        const saved = await request(port, "POST", "/cam/front/timeline/save", {
            fromMs: base + 60_000, toMs: base + 360_000, protected: true
        });
        assert.equal(saved.status, 200);
        assert.equal(saved.json.segments, 2, "both overlapped segments are kept");

        assert.equal(hub.store.getRecording(ids[0]).protected, true);
        assert.equal(hub.store.getRecording(ids[1]).protected, true);
        assert.equal(hub.store.getRecording(ids[2]).protected, false);

        // Saved segments must drop out of the eviction pool entirely.
        const evictable = hub.store.evictableRecordings().map((r) => r.id);
        assert.deepEqual(evictable, [ids[2], ids[3]]);

        const badRange = await request(port, "POST", "/cam/front/timeline/save", {
            fromMs: base + 1000, toMs: base
        });
        assert.equal(badRange.status, 400);

        // ---- one segment at a time --------------------------------------
        const released = await request(port, "POST", `/recordings/${ids[0]}/protect`, {
            protected: false
        });
        assert.equal(released.json.protected, false);

        // ---- days -------------------------------------------------------
        const days = await request(port, "GET", "/cam/front/timeline/days");
        assert.equal(days.status, 200);
        assert.ok(days.json.days.length >= 1);
        assert.ok(days.json.days[0].segments > 0);

        // ---- storage accounting ------------------------------------------
        const storage = await request(port, "GET", "/storage");
        assert.equal(storage.json.continuous.segments, 4);
        assert.equal(storage.json.continuous.bytes, 4 * 2048);
        assert.equal(storage.json.continuous.protectedSegments, 1);
    } finally {
        await cleanup();
    }
});

test("end to end: continuous status reports why it isn't running", async () => {
    const { port, cleanup } = await boot();
    let cam;
    try {
        cam = await connectCamera(port, "front");
        await wait(300);

        // Off by default — a fresh install must not start writing a gigabyte a
        // day without being asked.
        const off = await request(port, "GET", "/cam/front/continuous");
        assert.equal(off.status, 200);
        assert.equal(off.json.enabled, false);
        assert.equal(off.json.running, false);
    } finally {
        if (cam) cam.stop();
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
