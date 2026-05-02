const http = require("node:http");
const url = require("node:url");
const fs = require("node:fs");
const path = require("node:path");
const NodeHelper = require("node_helper");
const Log = require("logger");
const WebSocketServer = require("ws").Server;

const { Store, expandHome } = require("./store");
const { Detector } = require("./detector");
const { Recorder } = require("./recorder");
const { SessionManager } = require("./session");

const MJPEG_BOUNDARY = "frame";
const STATUS_STALE_MS = 30_000;
const RETENTION_INTERVAL_MS = 6 * 60 * 60 * 1000;   // 6h
const DETECTION_FRESH_MS = 1500;                    // overlay disappears after this

module.exports = NodeHelper.create({
	start () {
		this.hubPort = 5000;
		this.cams = new Map();
		this.subscribers = new Set();
		this.server = null;
		this.wss = null;
		this.started = false;

		// --- Detection / recording subsystem (off by default until INIT) ---
		this.detectionCfg = null;
		this.recordingCfg = null;
		this.clipsRoot = null;
		this.dbPath = null;
		this.store = null;
		this.detector = null;
		this.sessionManager = null;
		this.retentionTimer = null;
		this.detectionBootPromise = null;
		this.detectionEnabled = false;     // runtime state (POST /detection)
		this.detectionError = null;        // last boot failure, surfaced via API
	},

	stop () {
		if (this.retentionTimer) {
			clearInterval(this.retentionTimer);
			this.retentionTimer = null;
		}

		// Best-effort graceful shutdown — wait briefly for active sessions to
		// finalize their clips, then force everything down.
		const shutdown = (async () => {
			if (this.sessionManager) {
				try { await this.sessionManager.forceEndAll("helper-stop"); } catch (_) { /* ignore */ }
			}
			if (this.detector) {
				try { await this.detector.stop(); } catch (_) { /* ignore */ }
			}
			if (this.store) {
				try { this.store.close(); } catch (_) { /* ignore */ }
			}
		})();
		// MagicMirror's stop() isn't awaited; we kick off the async chain and
		// move on. The 5s SIGINT grace inside Recorder is enough headroom.
		shutdown.catch(() => { /* ignore */ });

		if (this.wss) {
			for (const ws of this.wss.clients) {
				try { ws.terminate(); } catch (_) { /* ignore */ }
			}
			this.wss.close();
		}
		if (this.server) this.server.close();
	},

	socketNotificationReceived (notification, payload) {
		if (notification === "DOORCAM_INIT") {
			this.applyConfig(payload || {});
			this.ensureServer();
			if (payload && payload.camId) {
				this.subscribers.add(payload.camId);
				this.pushStatus(payload.camId);
			}
			return;
		}
		if (notification === "DOORCAM_TOGGLE_REQUEST") {
			const camId = payload && payload.camId;
			if (!camId) return;
			const desired = payload.state === "on" || payload.state === "off"
				? payload.state
				: this.getCam(camId).desiredState === "on" ? "off" : "on";
			this.setDesiredState(camId, desired);
		}
	},

	applyConfig (cfg) {
		if (typeof cfg.hubPort === "number" && cfg.hubPort > 0) {
			this.hubPort = cfg.hubPort;
		}
		// First INIT wins for detection config — multiple module instances
		// (one per cam) all share one hub, so we can't have conflicting
		// detection configs. The existing helper does the same with hubPort.
		if (this.detectionCfg === null) {
			this.detectionCfg = cfg.detection || { enabled: false };
			this.recordingCfg = cfg.recording || {};
			this.clipsRoot = cfg.clipsRoot || "~/.mm-doorcam/clips";
			this.dbPath = cfg.dbPath || "~/.mm-doorcam/events.db";
		}
		const camId = cfg.camId;
		if (!camId) return;
		this.getCam(camId);
	},

	getCam (camId) {
		let cam = this.cams.get(camId);
		if (!cam) {
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
				lastDetectionAt: 0
			};
			this.cams.set(camId, cam);
		}
		return cam;
	},

	ensureServer () {
		if (this.started) return;
		this.started = true;

		this.server = http.createServer((req, res) => this.handleHttp(req, res));
		this.wss = new WebSocketServer({ noServer: true });

		this.server.on("upgrade", (req, socket, head) => {
			const { pathname } = url.parse(req.url);
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
			Log.error(`[MMM-DoorCam] hub server error: ${err && err.message}`);
		});

		this.server.listen(this.hubPort, () => {
			Log.info(`[MMM-DoorCam] hub listening on :${this.hubPort}`);
		});

		// Detection runs alongside the HTTP/WS server. We boot it lazily and
		// asynchronously so a bad model URL or missing dep can't block the
		// camera pipeline. Runtime state can be flipped via POST /detection
		// regardless of what the config initially asked for.
		if (this.detectionCfg && this.detectionCfg.enabled) {
			this.detectionBootPromise = this._bootDetection().then((r) => {
				if (!r.ok) Log.warn(`[MMM-DoorCam] initial detection boot failed: ${r.error}`);
			}).catch((err) => {
				Log.error(`[MMM-DoorCam] detection boot exception: ${err && err.message}`);
			});
		} else {
			Log.info("[MMM-DoorCam] detection disabled at startup (POST /detection { enabled: true } to start)");
		}
	},

	/**
	 * Idempotent: brings the detection subsystem up (store + detector +
	 * session manager). Returns { ok, error } so callers — config-driven
	 * boot OR runtime POST /detection — can surface failures to the user.
	 * The store stays open across stop/start so historical events remain
	 * queryable when detection is paused.
	 */
	async _bootDetection () {
		if (this.detector && this.sessionManager && this.store) {
			this.detectionEnabled = true;
			this.detectionError = null;
			return { ok: true };
		}

		if (!this.store) {
			try {
				this.store = new Store({ dbPath: this.dbPath, logger: Log }).open();
			} catch (err) {
				const msg = `event store unavailable: ${err && err.message}`;
				Log.error(`[MMM-DoorCam] ${msg}`);
				this.detectionError = msg;
				this.store = null;
				return { ok: false, error: msg };
			}
		}

		if (!this.sessionManager) {
			this.sessionManager = new SessionManager({
				store: this.store,
				recordingCfg: this.recordingCfg || {},
				clipsRoot: this.clipsRoot,
				recorderFactory: (cam, opts) => new Recorder({ cam, ...opts }),
				getCam: (camId) => this.getCam(camId),
				logger: Log
			});
		}

		if (!this.detector) {
			this.detector = new Detector({
				detectionCfg: this.detectionCfg || {},
				onObservation: (obs) => this._onDetection(obs),
				logger: Log
			});
			const result = await this.detector.start();
			if (!result.ok) {
				this.detectionError = result.error;
				this.detector = null;
				return { ok: false, error: result.error };
			}
			for (const cam of this.cams.values()) {
				this.detector.attachCam(cam);
			}
		}

		this._scheduleRetentionSweep();
		this.detectionEnabled = true;
		this.detectionError = null;
		return { ok: true };
	},

	async _stopDetection (reason) {
		if (this.sessionManager) {
			try { await this.sessionManager.forceEndAll(reason || "runtime-disable"); }
			catch (_) { /* logged inside */ }
		}
		if (this.detector) {
			try { await this.detector.stop(); } catch (_) { /* ignore */ }
			this.detector = null;
		}
		this.detectionEnabled = false;
		// Note: store and sessionManager kept around — store stays queryable
		// for historical events; sessionManager will get a fresh detector if
		// detection is re-enabled.
	},

	_detectionStatus () {
		return {
			enabled: !!(this.detector && this.sessionManager && this.store),
			available: !!this.store,             // deps loaded, store is openable
			error: this.detectionError || null
		};
	},

	_onDetection (obs) {
		if (!obs || !obs.camId) return;
		const cam = this.getCam(obs.camId);
		if (obs.hasPerson) {
			cam.lastDetection = {
				class: obs.cls || "person",
				confidence: obs.confidence,
				bbox: obs.bbox || null
			};
			cam.lastDetectionAt = obs.ts || Date.now();
		}
		// hasPerson === false: leave lastDetection in place. statusFor's
		// staleness check (DETECTION_FRESH_MS) will fade it out smoothly so
		// a single missed inference doesn't flicker the overlay.

		if (this.sessionManager) {
			this.sessionManager.observe(obs.camId, obs.hasPerson, obs.confidence);
		}
		this.pushStatus(obs.camId);
	},

	_scheduleRetentionSweep () {
		if (this.retentionTimer) return;
		const sweep = () => {
			if (!this.store) return;
			try {
				const result = this.store.retentionSweep({
					retentionDays: (this.recordingCfg || {}).retentionDays,
					clipsRoot: this.clipsRoot
				});
				if (result.rowsDeleted || result.clipsDeleted) {
					Log.info(`[MMM-DoorCam] retention sweep: removed ${result.rowsDeleted} rows, ${result.clipsDeleted} clips`);
				}
			} catch (err) {
				Log.warn(`[MMM-DoorCam] retention sweep failed: ${err && err.message}`);
			}
		};
		// Run once shortly after boot, then every RETENTION_INTERVAL_MS.
		setTimeout(sweep, 30_000);
		this.retentionTimer = setInterval(sweep, RETENTION_INTERVAL_MS);
		if (typeof this.retentionTimer.unref === "function") this.retentionTimer.unref();
	},

	onCamSocket (camId, ws) {
		const cam = this.getCam(camId);
		if (cam.ws) {
			try { cam.ws.terminate(); } catch (_) { /* ignore */ }
		}
		cam.ws = ws;
		cam.connected = true;
		cam.lastSeenAt = Date.now();
		Log.info(`[MMM-DoorCam] cam connected: ${camId}`);

		this.sendCommand(cam, { type: "set_state", state: cam.desiredState });
		this.pushStatus(camId);

		if (this.detector) this.detector.attachCam(cam);

		ws.on("message", (data, isBinary) => {
			cam.lastSeenAt = Date.now();
			const binary = isBinary === true
				|| (isBinary === undefined && Buffer.isBuffer(data));
			if (binary) {
				cam.lastJpeg = Buffer.isBuffer(data) ? data : Buffer.from(data);
				cam.lastJpegAt = cam.lastSeenAt;
				cam.frameSeq += 1;
				return;
			}
			let msg;
			try { msg = JSON.parse(data.toString("utf8")); } catch (_) { return; }
			if (!msg || typeof msg !== "object") return;
			if (msg.type === "hello") {
				this.sendCommand(cam, { type: "hello_ack", cam_id: camId });
				this.sendCommand(cam, { type: "set_state", state: cam.desiredState });
			} else if (msg.type === "status") {
				cam.status = {
					fps: msg.fps,
					resolution: msg.resolution,
					battery_pct: msg.battery_pct,
					on_battery: msg.on_battery,
					camera_available: msg.camera_available,
					reported_state: msg.state
				};
				this.pushStatus(camId);
			}
		});

		const handleClose = () => {
			if (cam.ws === ws) {
				cam.ws = null;
				cam.connected = false;
				cam.lastJpeg = null;
				Log.info(`[MMM-DoorCam] cam disconnected: ${camId}`);
				this.pushStatus(camId);
				if (this.sessionManager) {
					this.sessionManager.forceEnd(camId, "cam-disconnected").catch(() => { /* logged inside */ });
				}
			}
		};
		ws.on("close", handleClose);
		ws.on("error", (err) => {
			Log.warn(`[MMM-DoorCam] ws error for ${camId}: ${err && err.message}`);
			handleClose();
		});
	},

	sendCommand (cam, msg) {
		if (!cam.ws || cam.ws.readyState !== cam.ws.OPEN) return;
		try { cam.ws.send(JSON.stringify(msg)); } catch (err) {
			Log.warn(`[MMM-DoorCam] send to ${cam.id} failed: ${err && err.message}`);
		}
	},

	setDesiredState (camId, state) {
		const cam = this.getCam(camId);
		if (cam.desiredState === state) {
			this.pushStatus(camId);
			return;
		}
		cam.desiredState = state;
		this.sendCommand(cam, { type: "set_state", state });
		this.pushStatus(camId);
	},

	statusFor (camId) {
		const cam = this.getCam(camId);
		const now = Date.now();
		const fresh = cam.connected && (now - cam.lastSeenAt) < STATUS_STALE_MS;
		const reported = cam.status || {};
		const detectionFresh = cam.lastDetectionAt && (now - cam.lastDetectionAt) < DETECTION_FRESH_MS;
		return {
			cam_id: camId,
			state: cam.desiredState,
			connected: cam.connected,
			fresh,
			fps: reported.fps ?? null,
			resolution: reported.resolution ?? null,
			battery_pct: reported.battery_pct ?? null,
			on_battery: reported.on_battery ?? null,
			camera_available: reported.camera_available ?? null,
			last_frame_age_ms: cam.lastJpegAt ? now - cam.lastJpegAt : null,
			current_detection: detectionFresh ? cam.lastDetection : null
		};
	},

	pushStatus (camId) {
		if (!this.subscribers.has(camId)) return;
		this.sendSocketNotification("DOORCAM_STATUS", this.statusFor(camId));
	},

	handleHttp (req, res) {
		const parsed = url.parse(req.url, true);
		const pathname = parsed.pathname || "/";

		res.setHeader("Access-Control-Allow-Origin", "*");
		res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
		res.setHeader("Access-Control-Allow-Headers", "Content-Type");
		if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

		if (pathname === "/healthz") {
			res.writeHead(200, { "Content-Type": "text/plain" });
			res.end("ok");
			return;
		}
		if ((pathname === "/" || pathname === "/index.html") && req.method === "GET") {
			this.serveWebPage(res);
			return;
		}
		if (pathname === "/detection" && req.method === "GET") {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify(this._detectionStatus()));
			return;
		}
		if (pathname === "/detection" && req.method === "POST") {
			this.handleDetectionToggle(req, res);
			return;
		}
		if (pathname === "/cams" && req.method === "GET") {
			const list = [];
			for (const id of this.cams.keys()) list.push(this.statusFor(id));
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify(list));
			return;
		}

		const camEventsMatch = pathname.match(/^\/cam\/([^/]+)\/events$/);
		if (camEventsMatch && req.method === "GET") {
			this.handleListEvents(decodeURIComponent(camEventsMatch[1]), parsed.query, res);
			return;
		}

		const eventMatch = pathname.match(/^\/events\/(\d+)(?:\/clip(?:\.[a-z0-9]+)?)?$/i);
		if (eventMatch && req.method === "GET") {
			const eventId = Number(eventMatch[1]);
			const wantsClip = pathname.includes("/clip");
			if (wantsClip) {
				this.serveClip(eventId, req, res);
			} else {
				this.handleGetEvent(eventId, res);
			}
			return;
		}

		const camMatch = pathname.match(/^\/cam\/([^/]+)\/(status|toggle|stream\.mjpg)$/);
		if (camMatch) {
			const camId = decodeURIComponent(camMatch[1]);
			const action = camMatch[2];
			if (action === "status" && req.method === "GET") {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify(this.statusFor(camId)));
				return;
			}
			if (action === "toggle" && req.method === "POST") {
				this.readJsonBody(req, (body) => {
					const cam = this.getCam(camId);
					let desired;
					if (body && (body.state === "on" || body.state === "off")) {
						desired = body.state;
					} else if (body && body.state !== undefined) {
						res.writeHead(400, { "Content-Type": "application/json" });
						res.end(JSON.stringify({ error: "state must be 'on' or 'off'" }));
						return;
					} else {
						desired = cam.desiredState === "on" ? "off" : "on";
					}
					this.setDesiredState(camId, desired);
					res.writeHead(200, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ state: desired }));
				});
				return;
			}
			if (action === "stream.mjpg" && req.method === "GET") {
				this.serveMjpeg(camId, req, res);
				return;
			}
		}

		res.writeHead(404, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: "not found" }));
	},

	readJsonBody (req, cb) {
		const chunks = [];
		let total = 0;
		req.on("data", (c) => {
			total += c.length;
			if (total > 16_384) { req.destroy(); return; }
			chunks.push(c);
		});
		req.on("end", () => {
			if (!chunks.length) { cb(null); return; }
			try { cb(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
			catch (_) { cb(null); }
		});
		req.on("error", () => cb(null));
	},

	handleDetectionToggle (req, res) {
		this.readJsonBody(req, async (body) => {
			if (!body || typeof body.enabled !== "boolean") {
				res.writeHead(400, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "body must be { enabled: boolean }" }));
				return;
			}
			let bootResult = { ok: true };
			if (body.enabled) {
				bootResult = await this._bootDetection();
			} else {
				await this._stopDetection("api-disable");
			}
			const status = this._detectionStatus();
			res.writeHead(bootResult.ok ? 200 : 500, { "Content-Type": "application/json" });
			res.end(JSON.stringify(status));
		});
	},

	serveWebPage (res) {
		const filePath = path.join(__dirname, "web", "index.html");
		fs.readFile(filePath, (err, data) => {
			if (err) {
				Log.warn(`[MMM-DoorCam] failed to read web/index.html: ${err.message}`);
				res.writeHead(500, { "Content-Type": "text/plain" });
				res.end("internal error");
				return;
			}
			res.writeHead(200, {
				"Content-Type": "text/html; charset=utf-8",
				"Cache-Control": "no-cache"
			});
			res.end(data);
		});
	},

	handleListEvents (camId, query, res) {
		if (!this.store) {
			res.writeHead(503, { "Content-Type": "application/json" });
			res.end(JSON.stringify({
				error: "events store unavailable",
				detail: this.detectionError || "detection has never been enabled on this hub"
			}));
			return;
		}
		const sinceMs = query.since !== undefined ? Number(query.since) : undefined;
		const limit = query.limit !== undefined ? Number(query.limit) : undefined;
		try {
			const events = this.store.queryEvents({ camId, sinceMs, limit });
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify(events));
		} catch (err) {
			Log.warn(`[MMM-DoorCam] events query failed: ${err && err.message}`);
			res.writeHead(500, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "internal error" }));
		}
	},

	handleGetEvent (eventId, res) {
		if (!this.store) {
			res.writeHead(503, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "detection not enabled" }));
			return;
		}
		const event = this.store.getEvent(eventId);
		if (!event) {
			res.writeHead(404, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "not found" }));
			return;
		}
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify(event));
	},

	serveClip (eventId, req, res) {
		if (!this.store) {
			res.writeHead(503, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "detection not enabled" }));
			return;
		}
		const event = this.store.getEvent(eventId);
		if (!event || !event.clip_path) {
			res.writeHead(404, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "clip not found" }));
			return;
		}
		const root = expandHome(this.clipsRoot);
		const abs = path.resolve(root, event.clip_path);
		// Defense in depth: refuse to serve anything outside clipsRoot.
		if (!abs.startsWith(path.resolve(root) + path.sep)) {
			res.writeHead(400, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "invalid path" }));
			return;
		}

		let stat;
		try { stat = fs.statSync(abs); }
		catch (_) {
			res.writeHead(404, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "clip file missing" }));
			return;
		}

		const contentType = abs.endsWith(".mp4") ? "video/mp4" : "video/x-matroska";
		const range = req.headers.range;
		if (range) {
			const m = /^bytes=(\d*)-(\d*)$/.exec(range);
			if (!m) {
				res.writeHead(416, {
					"Content-Range": `bytes */${stat.size}`,
					"Content-Type": "application/json"
				});
				res.end(JSON.stringify({ error: "invalid range" }));
				return;
			}
			const start = m[1] ? Number(m[1]) : 0;
			const end = m[2] ? Number(m[2]) : stat.size - 1;
			if (start >= stat.size || end >= stat.size || start > end) {
				res.writeHead(416, {
					"Content-Range": `bytes */${stat.size}`,
					"Content-Type": "application/json"
				});
				res.end(JSON.stringify({ error: "range not satisfiable" }));
				return;
			}
			res.writeHead(206, {
				"Content-Type": contentType,
				"Content-Length": end - start + 1,
				"Content-Range": `bytes ${start}-${end}/${stat.size}`,
				"Accept-Ranges": "bytes"
			});
			fs.createReadStream(abs, { start, end }).pipe(res);
			return;
		}

		res.writeHead(200, {
			"Content-Type": contentType,
			"Content-Length": stat.size,
			"Accept-Ranges": "bytes"
		});
		fs.createReadStream(abs).pipe(res);
	},

	serveMjpeg (camId, req, res) {
		const cam = this.getCam(camId);
		res.writeHead(200, {
			"Content-Type": `multipart/x-mixed-replace; boundary=${MJPEG_BOUNDARY}`,
			"Cache-Control": "no-cache, private",
			"Pragma": "no-cache",
			"Connection": "close"
		});

		let lastSeq = -1;
		let closed = false;
		const markClosed = () => { closed = true; };
		req.on("close", markClosed);
		res.on("close", markClosed);
		res.on("error", markClosed);

		const tick = () => {
			if (closed) return;
			if (cam.desiredState !== "on" || !cam.lastJpeg || cam.frameSeq === lastSeq) {
				setTimeout(tick, 50);
				return;
			}
			lastSeq = cam.frameSeq;
			const jpeg = cam.lastJpeg;
			const head = Buffer.from(
				`--${MJPEG_BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`,
				"ascii"
			);
			let drained;
			try {
				res.write(head);
				res.write(jpeg);
				drained = res.write("\r\n");
			} catch (_) {
				closed = true;
				return;
			}
			if (drained === false) {
				res.once("drain", tick);
				return;
			}
			setImmediate(tick);
		};
		tick();
	}
});
