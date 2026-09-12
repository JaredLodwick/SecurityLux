"use strict";

/**
 * SecurityLuxHub — HTTP + WebSocket server.
 *
 * Camera nodes connect over WS at `ws://<host>:<port>/cam/<cam_id>` and push
 * binary JPEG frames. The hub buffers the last few seconds per camera, re-fans
 * the newest frame as MJPEG to any number of HTTP viewers, drives optional
 * on-host person detection, records per-event clips through ffmpeg, and exposes
 * the rest over HTTP.
 *
 * ============================================================================
 *  Boot order matters
 * ============================================================================
 *
 * The store, settings, and storage manager come up *before* the listener and
 * regardless of whether detection is enabled. They used to be constructed
 * inside the detection boot path, which meant a hub with detection off had no
 * settings table and no way to save anything from the UI.
 *
 * Detection is the only optional subsystem, and its failure is contained: a
 * missing model or a broken native module leaves frames, streaming, storage,
 * and the dashboard fully working.
 */

const http = require("node:http");
const WebSocketServer = require("ws").Server;

const { Store, expandHome } = require("./store");
const { SettingsService } = require("./settings");
const { StorageManager } = require("./storage");
const { Detector } = require("./detector");
const { Recorder } = require("./recorder");
const { SessionManager } = require("./session");
const { FrameBuffer } = require("./framebuffer");
const { Recognizer } = require("./recognize");
const continuous = require("./continuous");
const led = require("./led");
const { matchRoute } = require("./routes");
const media = require("./media");
const imageControls = require("./image-controls");
const eventLog = require("./event-log");
const enrollment = require("./enrollment");
const { sendError } = require("./http-util");

const HUB_VERSION = require("../package.json").version;

const STATUS_STALE_MS = 30_000;
const DETECTION_FRESH_MS = 1500;
const OFFLINE_CHECK_MS = 60_000;
const LED_TICK_MS = 2000;

/**
 * Below this the clock is obviously wrong (it's before this code was written),
 * which means NTP hasn't synced since boot. A Pi with no RTC comes up in 1970,
 * and events written then sort to the beginning of time forever and are
 * effectively unfindable. Refusing to write is better than corrupting the log.
 */
const MIN_SANE_CLOCK_MS = Date.UTC(2024, 0, 1);

/**
 * `this.log.forCategory(name)` when the logger supports it (log.js does);
 * otherwise fall back to the logger as-is. Keeps tests and any other caller
 * that hands in a plain `console` (or a stub without categories) working
 * exactly as before, just without the file-per-category split.
 */
function categoryLogger (base, name) {
    return (base && typeof base.forCategory === "function") ? base.forCategory(name) : base;
}

class HubServer {
    constructor (cfg, log) {
        this.cfg = cfg || {};
        this.log = log || console;

        // `??` not `||`: port 0 is a legitimate request for an ephemeral port,
        // and `0 || 5000` would silently bind 5000 instead.
        this.hubPort = (cfg.hub && cfg.hub.port) ?? 5000;
        this.bindAddr = (cfg.hub && cfg.hub.bindAddr) || "0.0.0.0";

        this.detectionCfg = cfg.detection || {};
        this.clipsRoot = expandHome((cfg.storage && cfg.storage.clipsRoot) || "~/Videos/SecurityLux");
        this.dbPath = (cfg.storage && cfg.storage.dbPath) || "~/.securityluxhub/events.db";

        this.cams = new Map();
        this.server = null;
        this.wss = null;

        this.store = null;
        this.settings = null;
        this.storage = null;
        this.detector = null;
        this.sessionManager = null;
        this.recognizer = null;

        this.detectionEnabled = false;
        this.detectionError = null;
        this.storeError = null;

        this._zoneCache = new Map();
        this._ledState = new Map();       // camId -> { stage, sentAt, ttlMs }
        this._offlineTimer = null;
        this._ledTimer = null;
        this._clockWarned = false;
    }

    // ==================================================================
    //  Lifecycle
    // ==================================================================

    async start () {
        this._openStore();

        this.server = http.createServer((req, res) => this.handleHttp(req, res));
        this.wss = new WebSocketServer({ noServer: true });

        this.server.on("upgrade", (req, socket, head) => {
            let pathname;
            try {
                pathname = new URL(req.url, "http://localhost").pathname;
            } catch (_) {
                socket.destroy();
                return;
            }
            const m = pathname && pathname.match(/^\/cam\/([^/]+)$/);
            if (!m) {
                socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
                socket.destroy();
                return;
            }
            const camId = decodeURIComponent(m[1]);
            this.wss.handleUpgrade(req, socket, head, (ws) => this.onCamSocket(camId, ws));
        });

        this.server.on("error", (err) => {
            this.log.error(`hub server error: ${err && err.message}`);
        });

        await new Promise((resolve) => {
            this.server.listen(this.hubPort, this.bindAddr, () => {
                this.log.info(`hub listening on ${this.bindAddr}:${this.hubPort}`);
                resolve();
            });
        });

        this._startOfflineMonitor();
        this._startLedRefresh();

        if (this.detectionCfg.enabled) {
            this.bootDetection().then((r) => {
                if (!r.ok) this.log.warn(`initial detection boot failed: ${r.error}`);
            }).catch((err) => {
                this.log.error(`detection boot exception: ${err && err.message}`);
            });
        } else {
            this.log.info("detection disabled at startup (POST /detection { enabled: true } to start)");
        }
    }

    /**
     * Store, settings, storage, recognizer — the always-on core.
     * A failure here is recorded and surfaced through the API rather than
     * thrown, so the hub still serves live video with a broken database.
     */
    _openStore () {
        try {
            this.store = new Store({ dbPath: this.dbPath, logger: this.log }).open();
        } catch (err) {
            this.storeError = `event store unavailable: ${err && err.message}`;
            this.log.error(this.storeError);
            this.store = null;
            return;
        }

        this.settings = new SettingsService({
            store: this.store,
            fileCfg: this.cfg,
            logger: this.log
        });

        this.storage = new StorageManager({
            store: this.store,
            settings: this.settings,
            clipsRoot: this.clipsRoot,
            dbPath: this.dbPath,
            logger: this.log
        });
        this.storage.start();

        this.recognizer = new Recognizer({ store: this.store, enabled: false, logger: this.log });

        // Sessions/behaviour are "motion" (they exist only because a person was
        // seen); the recorder they spawn is ffmpeg process noise, which is its
        // own category so it doesn't drown out the motion story either.
        const motionLog = categoryLogger(this.log, "motion");
        const recordingLog = categoryLogger(this.log, "recording");

        this.sessionManager = new SessionManager({
            store: this.store,
            settings: this.settings,
            clipsRoot: this.clipsRoot,
            storage: this.storage,
            recorderFactory: (cam, opts) => new Recorder({ cam, ...opts, logger: recordingLog }),
            getCam: (camId) => this.getCam(camId),
            getZones: (camId) => this.zonesFor(camId),
            onBehaviorChange: (camId, state) => this._onBehaviorChange(camId, state),
            onEventFinalized: (event) => this._onEventFinalized(event),
            logger: motionLog
        });

        this.settings.subscribe((changed, scope) => this._onSettingsChanged(changed, scope));
    }

    async stop () {
        for (const timer of [this._offlineTimer, this._ledTimer]) {
            if (timer) clearInterval(timer);
        }
        this._offlineTimer = null;
        this._ledTimer = null;

        // Turn every door light off on the way out rather than leaving whatever
        // stage was last set burning on someone's porch.
        for (const camId of this.cams.keys()) {
            this.sendLedCommand(camId, 0, { ttlMs: 0 });
        }

        // Before the store closes: stopping flushes and indexes each final
        // segment, and indexing needs the database.
        try { await this._stopAllContinuous("hub-stop"); } catch (_) { /* logged inside */ }

        if (this.sessionManager) {
            try { await this.sessionManager.forceEndAll("hub-stop"); } catch (_) { /* ignore */ }
        }
        if (this.detector) {
            try { await this.detector.stop(); } catch (_) { /* ignore */ }
            this.detector = null;
        }
        if (this.storage) { this.storage.stop(); this.storage = null; }
        if (this.store) {
            try { this.store.close(); } catch (_) { /* ignore */ }
            this.store = null;
        }
        if (this.wss) {
            for (const ws of this.wss.clients) {
                try { ws.terminate(); } catch (_) { /* ignore */ }
            }
            this.wss.close();
            this.wss = null;
        }
        if (this.server) {
            await new Promise((resolve) => this.server.close(() => resolve()));
            this.server = null;
        }
    }

    // ==================================================================
    //  Hub-level info + control
    // ==================================================================

    info () {
        return {
            version: HUB_VERSION,
            pid: process.pid,
            node_version: process.version,
            platform: process.platform,
            uptime_s: Math.round(process.uptime()),
            port: this.hubPort,
            cams: this.cams.size,
            detection_enabled: this.detectionEnabled,
            log_level: this.settings ? this.settings.get("system.logLevel") : null,
            store_ok: !this.storeError
        };
    }

    /**
     * Voluntary restart, e.g. from the dashboard's "Restart hub" button.
     *
     * There's no in-process way to restart a Node service — the trick is to
     * shut down cleanly and exit with a non-zero code, which is exactly what
     * `Restart=on-failure` (systemd) and `KeepAlive.SuccessfulExit: false`
     * (macOS launchd) already watch for, so the process manager brings it
     * straight back. Logging *why* first matters: without it, this restart
     * would show up in system.log looking exactly like an unexplained crash.
     */
    async restart (reason) {
        this.log.warn(`[hub] restart requested (${reason || "unknown"}); exiting so the service manager restarts it`);
        try {
            await this.stop();
        } catch (err) {
            this.log.error(`[hub] restart: shutdown error: ${err && err.message}`);
        }
        process.exit(1);
    }

    // ==================================================================
    //  Camera records
    // ==================================================================

    getCam (camId) {
        let cam = this.cams.get(camId);
        if (!cam) {
            const fps = this.settings ? this.settings.get("recording.fps", camId) : 15;
            const preRoll = this.settings ? this.settings.get("recording.preRollSeconds", camId) : 5;
            cam = {
                id: camId,
                desiredState: "on",
                lastJpeg: null,
                lastJpegAt: 0,
                status: null,
                connected: false,
                ws: null,
                lastSeenAt: 0,
                frameSeq: 0,
                lastDetection: null,
                lastDetectionAt: 0,
                connectedAt: 0,
                reconnects: 0,
                offlineSince: 0,
                // Image adjustment state, as last reported by the camera.
                controls: [],
                controlsAvailable: false,
                controlsAt: 0,
                controlErrors: null,
                reportedImage: null,
                reportedResolution: null,
                baseResolution: null,     // capture size before rotation
                continuous: null,         // ContinuousRecorder, attached on first use
                frameBuffer: new FrameBuffer({ seconds: preRoll, fps })
            };
            this.cams.set(camId, cam);
        }
        return cam;
    }

    onCamSocket (camId, ws) {
        const cam = this.getCam(camId);
        if (cam.ws) {
            try { cam.ws.terminate(); } catch (_) { /* ignore */ }
        }
        cam.ws = ws;
        cam.connected = true;
        cam.lastSeenAt = Date.now();
        cam.connectedAt = cam.lastSeenAt;
        cam.offlineSince = 0;
        cam.reconnects += 1;
        this.log.info(`cam connected: ${camId}`);

        if (this.store) {
            try { this.store.touchCamera(camId, { connected: true }); } catch (_) { /* non-fatal */ }
        }

        this.sendCommand(cam, { type: "set_state", state: cam.desiredState });
        this._sendLedConfig(camId);
        // Re-assert the light so a camera that rebooted mid-event isn't left
        // dark while someone is still standing there.
        const led = this._ledState.get(camId);
        this.sendLedCommand(camId, led ? led.stage : 0, {});

        // Re-apply image adjustments. This is not just a convenience: V4L2
        // control values live in the camera's driver and are lost when the Pi
        // reboots, so without this a power cut would silently undo the
        // brightness you tuned and leave a dark doorway dark.
        this._sendImageConfig(camId);
        this._sendHardwareControls(camId);

        this._syncContinuous(cam);

        if (this.detector) this.detector.attachCam(cam);

        ws.on("message", (data, isBinary) => {
            cam.lastSeenAt = Date.now();
            const binary = isBinary === true
                || (isBinary === undefined && Buffer.isBuffer(data));
            if (binary) {
                const jpeg = Buffer.isBuffer(data) ? data : Buffer.from(data);
                cam.lastJpeg = jpeg;
                cam.lastJpegAt = cam.lastSeenAt;
                cam.frameSeq += 1;
                cam.frameBuffer.push(jpeg, cam.frameSeq, cam.lastJpegAt);
                return;
            }
            let msg;
            try { msg = JSON.parse(data.toString("utf8")); } catch (_) { return; }
            if (!msg || typeof msg !== "object") return;

            if (msg.type === "hello") {
                this.sendCommand(cam, { type: "hello_ack", cam_id: camId });
                this.sendCommand(cam, { type: "set_state", state: cam.desiredState });
                this._sendLedConfig(camId);
                this._sendImageConfig(camId);
                this._sendHardwareControls(camId);
                if (msg.capabilities && msg.capabilities.fps) {
                    cam.frameBuffer.setCapacity({ fps: Number(msg.capabilities.fps) });
                }
                // The capture resolution *before* any rotation is applied.
                // Knowing the base lets the hub compute the effective size
                // itself, so the UI updates the instant you rotate rather than
                // waiting a round trip for the camera to report back.
                if (msg.capabilities && msg.capabilities.resolution) {
                    cam.baseResolution = String(msg.capabilities.resolution);
                }
            } else if (msg.type === "status") {
                cam.status = {
                    fps: msg.fps,
                    resolution: msg.resolution,
                    battery_pct: msg.battery_pct,
                    on_battery: msg.on_battery,
                    camera_available: msg.camera_available,
                    led_available: msg.led_available,
                    uptime_s: msg.uptime_s,
                    reported_state: msg.state
                };
            } else if (msg.type === "camera_controls") {
                imageControls.onCameraControlsMessage(this, cam, msg);
            } else if (msg.type === "image_state") {
                imageControls.onImageStateMessage(cam, msg);
            }
        });

        const handleClose = () => {
            if (cam.ws !== ws) return;
            cam.ws = null;
            cam.connected = false;
            cam.lastJpeg = null;
            cam.offlineSince = Date.now();
            cam.frameBuffer.clear();
            this.log.info(`cam disconnected: ${camId}`);
            if (cam.continuous) {
                cam.continuous.stop("cam-disconnected").catch(() => { /* logged inside */ });
            }
            if (this.sessionManager) {
                this.sessionManager.forceEnd(camId, "cam-disconnected")
                    .catch(() => { /* logged inside */ });
            }
        };
        ws.on("close", handleClose);
        ws.on("error", (err) => {
            this.log.warn(`ws error for ${camId}: ${err && err.message}`);
            handleClose();
        });
    }

    sendCommand (cam, msg) {
        if (!cam || !cam.ws || cam.ws.readyState !== cam.ws.OPEN) return false;
        try {
            cam.ws.send(JSON.stringify(msg));
            return true;
        } catch (err) {
            this.log.warn(`send to ${cam.id} failed: ${err && err.message}`);
            return false;
        }
    }

    /** Route-facing wrapper with a useful error when the camera isn't there. */
    sendCameraCommand (camId, msg) {
        const cam = this.cams.get(camId);
        if (!cam || !cam.connected) {
            return { ok: false, error: `camera "${camId}" is not connected` };
        }
        const sent = this.sendCommand(cam, msg);
        if (sent) this.log.info(`[hub] sent ${msg.type} to ${camId}`);
        return sent ? { ok: true } : { ok: false, error: "failed to send command" };
    }

    setDesiredState (camId, state) {
        const cam = this.getCam(camId);
        if (cam.desiredState === state) return;
        cam.desiredState = state;
        this.sendCommand(cam, { type: "set_state", state });
        if (state === "off") {
            cam.frameBuffer.clear();
            this.sendLedCommand(camId, 0, { ttlMs: 0 });
        }
        this._syncContinuous(cam);
    }

    // ==================================================================
    //  Status
    // ==================================================================

    statusFor (camId) {
        const cam = this.getCam(camId);
        const now = Date.now();
        const fresh = cam.connected && (now - cam.lastSeenAt) < STATUS_STALE_MS;
        const reported = cam.status || {};
        const detectionFresh = cam.lastDetectionAt
            && (now - cam.lastDetectionAt) < DETECTION_FRESH_MS;
        const behavior = this.sessionManager ? this.sessionManager.behaviorFor(camId) : null;

        return {
            cam_id: camId,
            name: this.settings ? (this.settings.get("events.friendlyName", camId) || camId) : camId,
            state: cam.desiredState,
            connected: cam.connected,
            fresh,
            fps: reported.fps ?? null,
            resolution: reported.resolution ?? null,
            battery_pct: reported.battery_pct ?? null,
            on_battery: reported.on_battery ?? null,
            camera_available: reported.camera_available ?? null,
            led_available: reported.led_available ?? null,
            uptime_s: reported.uptime_s ?? null,
            last_frame_age_ms: cam.lastJpegAt ? now - cam.lastJpegAt : null,
            // Wall-clock time the hub actually received the last JPEG, straight
            // from the ingest path (server.js:onCamSocket) rather than derived
            // client-side. The dashboard displays this as the on-feed
            // timestamp so it freezes the instant frames stop arriving, instead
            // of a client clock that keeps ticking through a hung stream.
            last_frame_at: cam.lastJpegAt || null,
            current_detection: detectionFresh ? cam.lastDetection : null,
            detection_enabled: this.settings ? this.settings.get("detection.enabled", camId) : true,
            recording_enabled: this.settings ? this.settings.get("recording.enabled", camId) : true,
            recording_paused: this.storage ? this.storage.recordingPaused : false,
            behavior: behavior ? behavior.behavior : "idle",
            led_stage: behavior ? behavior.stage : 0,
            person_count: behavior ? behavior.personCount : 0,
            session_active: this.sessionManager ? this.sessionManager.isActive(camId) : false,
            continuous: this.continuousStatusFor(camId),
            connected_at: cam.connectedAt || null,
            reconnects: cam.reconnects
        };
    }

    allStatuses () {
        return [...this.cams.keys()].map((id) => this.statusFor(id));
    }

    // ==================================================================
    //  Detection
    // ==================================================================

    async bootDetection () {
        if (!this.store) {
            return { ok: false, error: this.storeError || "event store unavailable" };
        }
        if (this.detector) {
            this.detectionEnabled = true;
            this.detectionError = null;
            return { ok: true };
        }

        this.detector = new Detector({
            settings: this.settings,
            detectionCfg: this.detectionCfg,
            onObservation: (obs) => this._onDetection(obs),
            isSessionActive: (camId) => this.sessionManager.isActive(camId),
            logger: categoryLogger(this.log, "motion")
        });

        const result = await this.detector.start();
        if (!result.ok) {
            this.detectionError = result.error;
            this.detector = null;
            return { ok: false, error: result.error };
        }
        for (const cam of this.cams.values()) this.detector.attachCam(cam);

        this.detectionEnabled = true;
        this.detectionError = null;
        return { ok: true };
    }

    async stopDetection (reason) {
        if (this.sessionManager) {
            try { await this.sessionManager.forceEndAll(reason || "runtime-disable"); }
            catch (_) { /* logged inside */ }
        }
        if (this.detector) {
            try { await this.detector.stop(); } catch (_) { /* ignore */ }
            this.detector = null;
        }
        this.detectionEnabled = false;
    }

    detectionStatus () {
        return {
            enabled: !!this.detector,
            available: !!this.store,
            error: this.detectionError || this.storeError || null,
            stats: this.detector ? this.detector.stats() : null,
            recording_paused: this.storage ? this.storage.recordingPaused : false,
            paused_reason: this.storage ? this.storage.pausedReason : null,
            clock_ok: Date.now() >= MIN_SANE_CLOCK_MS
        };
    }

    _onDetection (obs) {
        if (!obs || !obs.camId) return;
        if (!this.clockIsSane()) return;

        const cam = this.getCam(obs.camId);
        const detections = obs.detections || [];
        if (detections.length) {
            cam.lastDetection = {
                class: detections[0].cls || "person",
                confidence: detections[0].confidence,
                bbox: detections[0].bbox || null,
                count: detections.length
            };
            cam.lastDetectionAt = obs.ts || Date.now();
        }
        if (this.sessionManager) this.sessionManager.observe(obs.camId, detections);
    }

    /**
     * Guard against writing events with a nonsense timestamp.
     *
     * A Pi with no RTC boots at the epoch and stays there until NTP lands. Rows
     * written in that window sort before everything else forever and are
     * effectively lost, so we drop detections until the clock looks real and say
     * so loudly, once.
     */
    clockIsSane () {
        if (Date.now() >= MIN_SANE_CLOCK_MS) return true;
        if (!this._clockWarned) {
            this._clockWarned = true;
            this.log.error(
                "[hub] system clock is before 2024 — NTP has not synced. " +
                "Refusing to write events until the clock is correct, otherwise " +
                "they would be timestamped in the past and unfindable."
            );
        }
        return false;
    }

    // ==================================================================
    //  Zones
    // ==================================================================

    zonesFor (camId) {
        if (!this.store) return [];
        if (this._zoneCache.has(camId)) return this._zoneCache.get(camId);
        let zones = [];
        try { zones = this.store.listZones(camId); }
        catch (err) { this.log.warn(`[hub] failed to load zones for ${camId}: ${err.message}`); }
        this._zoneCache.set(camId, zones);
        return zones;
    }

    invalidateZones (camId) {
        this._zoneCache.delete(camId);
    }

    // ==================================================================
    //  Door light — thin delegates over led.js
    // ==================================================================

    _onBehaviorChange (camId, state) { this.sendLedCommand(camId, state.stage, {}); }
    sendLedCommand (camId, stage, opts) { return led.sendStage(this, camId, stage, opts); }
    _sendLedConfig (camId) { return led.sendConfig(this, camId); }
    _startLedRefresh () { this._ledTimer = led.startRefresh(this, LED_TICK_MS); }

    // ==================================================================
    //  Continuous recording — thin delegates over continuous.js
    // ==================================================================

    _syncContinuous (cam) { return continuous.syncFor(this, cam); }
    _stopAllContinuous (reason) { return continuous.stopAll(this, reason); }
    continuousStatusFor (camId) { return continuous.statusFor(this, camId); }

    // ==================================================================
    //  Image adjustments — thin delegates over image-controls.js
    // ==================================================================

    imageConfigFor (camId) { return imageControls.imageConfigFor(this, camId); }
    controlsFor (camId) { return imageControls.controlsFor(this, camId); }
    setHardwareControls (camId, values) {
        return imageControls.setHardwareControls(this, camId, values);
    }
    resetHardwareControls (camId) { return imageControls.resetHardwareControls(this, camId); }

    _sendImageConfig (camId) { return imageControls.sendImageConfig(this, camId); }
    _sendHardwareControls (camId) { return imageControls.sendHardwareControls(this, camId); }


    // ==================================================================
    //  Event log — thin delegates over event-log.js
    // ==================================================================

    /**
     * A camera that stops reporting gets logged as an event. See event-log.js
     * for why this is worth having at all.
     */
    _startOfflineMonitor () {
        this._offlineTimer = setInterval(() => eventLog.checkOffline(this), OFFLINE_CHECK_MS);
        this._offlineTimer.unref?.();
    }

    _onEventFinalized (event) { return eventLog.onEventFinalized(this, event); }
    redescribeEvent (eventId) { return eventLog.redescribeEvent(this, eventId); }
    redescribeAll (camId) { return eventLog.redescribeAll(this, camId); }
    deleteEvent (eventId) { return eventLog.deleteEvent(this, eventId); }

    // Media serving lives in media.js; these keep the route table unchanged.
    serveEventFile (eventId, kind, req, res) {
        return media.serveEventFile(this, eventId, kind, req, res);
    }

    serveSampleImage (sampleId, req, res) {
        return media.serveSampleImage(this, sampleId, req, res);
    }

    serveRecording (recordingId, req, res) {
        return media.serveRecording(this, recordingId, req, res);
    }

    serveSnapshot (camId, res) {
        return media.serveSnapshot(this, camId, res);
    }

    serveMjpeg (camId, req, res) {
        return media.serveMjpeg(this, camId, req, res);
    }

    // ==================================================================
    //  Profiles — thin delegates over enrollment.js
    // ==================================================================

    deleteProfile (profileId) { return enrollment.deleteProfile(this, profileId); }
    addFaceSample (profileId, body) { return enrollment.addFaceSample(this, profileId, body); }
    deleteFaceSample (sampleId) { return enrollment.deleteFaceSample(this, sampleId); }

    // ==================================================================
    //  Settings reactions
    // ==================================================================

    _onSettingsChanged (changed, scope) {
        if (this.storage) this.storage.onSettingsChanged(changed);

        if (changed.includes("system.logLevel") && typeof this.log.setLevel === "function") {
            this.log.setLevel(this.settings.get("system.logLevel"));
        }

        // Pre-roll depth and frame rate change the ring buffer's shape, so a
        // saved setting has to reach the buffers that are already allocated.
        if (changed.some((k) => k === "recording.preRollSeconds" || k === "recording.fps")) {
            for (const [camId, cam] of this.cams) {
                cam.frameBuffer.setCapacity({
                    seconds: this.settings.get("recording.preRollSeconds", camId),
                    fps: this.settings.get("recording.fps", camId)
                });
            }
        }

        if (changed.some((k) => k.startsWith("led."))) {
            for (const camId of this.cams.keys()) this._sendLedConfig(camId);
        }

        // fps and quality are baked into the running ffmpeg, so the recorder
        // has to be cycled for a change to take effect at all.
        if (changed.some((k) => k.startsWith("continuous."))) {
            continuous.reconfigureAll(this);
        }

        // Geometry changes apply on the camera's very next frame, which is what
        // makes dragging a zoom slider feel live rather than needing a save.
        // image.* is camera-scoped, so the scope names exactly one camera.
        if (changed.some((k) => k.startsWith("image."))) {
            const targets = (scope && scope !== "global") ? [scope] : [...this.cams.keys()];
            for (const camId of targets) this._sendImageConfig(camId);
        }
    }

    // ==================================================================
    //  HTTP
    // ==================================================================

    handleHttp (req, res) {
        // Wide-open CORS: the hub is a LAN appliance and the MagicMirror module
        // runs from a different origin. The wildcard is also what lets the
        // browser read MJPEG pixels back for the stream stall detector.
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type");
        if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

        // WHATWG URL rather than the legacy `url.parse`, which Node flags as
        // non-standard and security-relevant. The base is a placeholder — only
        // the path and query are ever used.
        let parsedUrl;
        try {
            parsedUrl = new URL(req.url, "http://localhost");
        } catch (_) {
            return sendError(res, 400, "malformed request URL");
        }
        const pathname = parsedUrl.pathname || "/";
        const parsed = { query: Object.fromEntries(parsedUrl.searchParams) };

        const route = matchRoute(req.method, pathname);
        if (!route) return sendError(res, 404, "not found");

        // The store backs almost everything; fail clearly rather than throwing
        // a TypeError deep inside a handler.
        if (!this.store && needsStore(pathname)) {
            return sendError(res, 503, "event store unavailable", {
                detail: this.storeError || "database failed to open"
            });
        }

        try {
            const result = route.handler({
                hub: this, req, res, query: parsed.query || {}, params: route.params
            });
            if (result && typeof result.catch === "function") {
                result.catch((err) => this._handlerError(res, err));
            }
        } catch (err) {
            this._handlerError(res, err);
        }
    }

    _handlerError (res, err) {
        this.log.error(`[hub] request handler failed: ${err && err.stack || err}`);
        if (res.headersSent) { try { res.end(); } catch (_) { /* ignore */ } return; }
        sendError(res, 500, "internal error");
    }

}

/** Routes that can't do anything useful without the database. */
function needsStore (pathname) {
    return /^\/(events|settings|storage|profiles|recognition|recordings)/.test(pathname)
        // Image controls read settings and the stored V4L2 values, so they need
        // the database just as much as the routes above.
        || /^\/cam\/[^/]+\/(events|zones|settings|controls|timeline|continuous)(\/|$)/.test(pathname);
}

module.exports = { HubServer };
