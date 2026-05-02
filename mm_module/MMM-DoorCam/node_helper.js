const http = require("node:http");
const url = require("node:url");
const NodeHelper = require("node_helper");
const Log = require("logger");
const WebSocketServer = require("ws").Server;

const MJPEG_BOUNDARY = "frame";
const STATUS_STALE_MS = 30_000;

module.exports = NodeHelper.create({
	start () {
		this.hubPort = 5000;
		this.cams = new Map();
		this.subscribers = new Set();
		this.server = null;
		this.wss = null;
		this.started = false;
	},

	stop () {
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
				frameSeq: 0
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
		const fresh = cam.connected && (Date.now() - cam.lastSeenAt) < STATUS_STALE_MS;
		const reported = cam.status || {};
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
			last_frame_age_ms: cam.lastJpegAt ? Date.now() - cam.lastJpegAt : null
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
		if (pathname === "/cams" && req.method === "GET") {
			const list = [];
			for (const id of this.cams.keys()) list.push(this.statusFor(id));
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify(list));
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
