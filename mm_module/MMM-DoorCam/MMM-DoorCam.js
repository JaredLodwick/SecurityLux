Module.register("MMM-DoorCam", {
	defaults: {
		camId: "front",
		hubUrl: "http://meer.local:5000",
		hubPort: 5000,
		hideWhenOff: true,
		showToggleButton: false,
		showStatusBar: true,
		width: "320px",
		title: "Door Cam",
		streamRefreshSeconds: 30,
		staleFrameMs: 10000,
		errorRetryMs: 1500,
		// --- Hub-side person detection + per-event recording. ---
		// Defaults are off so existing installs don't get a CPU spike
		// after pulling. Flip `detection.enabled` to true to opt in.
		detection: {
			enabled: false,
			fps: 2,
			confidence: 0.45,
			classes: ["person"],
			modelUrl: "https://github.com/JaredLodwick/DoorCamera/releases/download/models-v1/yolov8n-int8.onnx",
			modelSha256: ""
		},
		recording: {
			codec: "mkv",            // "mkv" (stream-copy, zero-CPU) | "h264" (libx264 ultrafast)
			fps: 15,
			minClipSeconds: 2,
			maxClipSeconds: 300,
			graceMs: 1500,
			retentionDays: 14
		},
		clipsRoot: "~/Videos/SecurityCamera",
		dbPath: "~/.mm-doorcam/events.db"
	},

	start () {
		this.status = null;
		this.cameraState = null;
		this.inFlightToggle = false;
		this.streamNonce = Date.now();
		this._refreshTimer = null;

		this.sendSocketNotification("DOORCAM_INIT", {
			camId: this.config.camId,
			hubPort: this.config.hubPort,
			detection: this.config.detection,
			recording: this.config.recording,
			clipsRoot: this.config.clipsRoot,
			dbPath: this.config.dbPath
		});
	},

	suspend () {
		this._stopRefreshTimer();
	},

	resume () {
		if (this.cameraState === "on") this._scheduleRefreshTimer();
	},

	getStyles () {
		return [this.file("MMM-DoorCam.css")];
	},

	socketNotificationReceived (notification, payload) {
		if (notification !== "DOORCAM_STATUS") return;
		if (!payload || payload.cam_id !== this.config.camId) return;
		const prevState = this.cameraState;
		this.status = payload;
		this.cameraState = payload.state || null;
		let refreshed = false;
		if (prevState !== this.cameraState && this.cameraState === "on") {
			this.streamNonce = Date.now();
			refreshed = true;
		}
		if (!refreshed && this.cameraState === "on" && payload.connected) {
			const ageMs = payload.last_frame_age_ms;
			if (typeof ageMs === "number" && isFinite(ageMs) && ageMs > this.config.staleFrameMs) {
				this.streamNonce = Date.now();
			}
		}
		if (this.cameraState === "on") {
			this._scheduleRefreshTimer();
		} else {
			this._stopRefreshTimer();
		}
		this.inFlightToggle = false;
		this.updateDom();
	},

	_scheduleRefreshTimer () {
		const seconds = Number(this.config.streamRefreshSeconds);
		if (!isFinite(seconds) || seconds <= 0) return;
		if (this._refreshTimer) return;
		const intervalMs = Math.max(5, seconds) * 1000;
		this._refreshTimer = setInterval(() => this._refreshStreamIfOn(), intervalMs);
	},

	_stopRefreshTimer () {
		if (this._refreshTimer) {
			clearInterval(this._refreshTimer);
			this._refreshTimer = null;
		}
	},

	_refreshStreamIfOn () {
		if (this.cameraState !== "on") return;
		if (!this.status || !this.status.connected) return;
		this.streamNonce = Date.now();
		this.updateDom();
	},

	notificationReceived (notification) {
		if (notification === "DOORCAM_TOGGLE") {
			this.requestToggle();
		} else if (notification === "DOORCAM_ON") {
			this.requestToggle("on");
		} else if (notification === "DOORCAM_OFF") {
			this.requestToggle("off");
		}
	},

	requestToggle (desired) {
		this.inFlightToggle = true;
		this.updateDom();
		this.sendSocketNotification("DOORCAM_TOGGLE_REQUEST", {
			camId: this.config.camId,
			state: desired
		});
	},

	getDom () {
		const wrap = document.createElement("div");
		wrap.className = "mmm-doorcam";
		wrap.style.width = this.config.width;

		if (this.config.hideWhenOff && this.cameraState === "off") {
			wrap.classList.add("hidden-when-off");
			return wrap;
		}

		if (this.config.title) {
			const title = document.createElement("div");
			title.className = "doorcam-title";
			title.textContent = this.config.title;
			wrap.appendChild(title);
		}

		const frame = document.createElement("div");
		frame.className = "doorcam-frame";
		frame.appendChild(this.renderVideoChild());
		const overlay = this.renderBboxOverlay();
		if (overlay) frame.appendChild(overlay);
		wrap.appendChild(frame);

		if (this.config.showStatusBar) wrap.appendChild(this.renderStatusBar());
		if (this.config.showToggleButton) wrap.appendChild(this.renderToggleButton());

		return wrap;
	},

	renderVideoChild () {
		const s = this.status;
		if (this.cameraState === "on" && s && s.connected) {
			const img = document.createElement("img");
			img.className = "doorcam-stream";
			img.alt = "Live door camera feed";
			img.src = this.streamUrl();
			img.addEventListener("error", () => {
				const retryMs = Math.max(250, Number(this.config.errorRetryMs) || 1500);
				setTimeout(() => this._refreshStreamIfOn(), retryMs);
			});
			return img;
		}
		const placeholder = document.createElement("div");
		placeholder.className = "doorcam-placeholder";
		if (!s) {
			placeholder.textContent = "Waiting for hub…";
		} else if (!s.connected) {
			placeholder.classList.add("doorcam-error");
			placeholder.textContent = `Camera "${this.config.camId}" offline`;
		} else {
			placeholder.textContent = "Camera off";
		}
		return placeholder;
	},

	/**
	 * Translucent bbox overlay drawn on top of the live MJPEG <img>.
	 * `current_detection.bbox` is normalized 0-1 cx/cy/w/h from the hub —
	 * we convert to CSS percentages and let the overlay scale naturally
	 * with whatever size the module ends up rendering at.
	 */
	renderBboxOverlay () {
		if (this.cameraState !== "on") return null;
		const s = this.status;
		if (!s || !s.connected || !s.current_detection || !s.current_detection.bbox) return null;
		const { cx, cy, w, h } = s.current_detection.bbox;
		if (![cx, cy, w, h].every((n) => typeof n === "number" && isFinite(n))) return null;

		const layer = document.createElement("div");
		layer.className = "doorcam-bbox-layer";

		const box = document.createElement("div");
		box.className = "doorcam-bbox";
		const left = Math.max(0, (cx - w / 2)) * 100;
		const top = Math.max(0, (cy - h / 2)) * 100;
		const widthPct = Math.min(100 - left, w * 100);
		const heightPct = Math.min(100 - top, h * 100);
		box.style.left = `${left}%`;
		box.style.top = `${top}%`;
		box.style.width = `${widthPct}%`;
		box.style.height = `${heightPct}%`;

		const label = document.createElement("span");
		label.className = "doorcam-bbox-label";
		const conf = Math.round((s.current_detection.confidence || 0) * 100);
		const cls = s.current_detection.class || "object";
		label.textContent = conf > 0 ? `${cls} ${conf}%` : cls;
		box.appendChild(label);

		layer.appendChild(box);
		return layer;
	},

	renderStatusBar () {
		const bar = document.createElement("div");
		bar.className = "doorcam-status";
		const s = this.status || {};

		// Left column: detection chip — only when something is currently
		// detected. Right column: state + battery, always present.
		const left = document.createElement("div");
		left.className = "doorcam-status-left";
		if (s.current_detection) {
			const chip = document.createElement("span");
			chip.className = "doorcam-event-chip";
			const cls = s.current_detection.class || "object";
			chip.textContent = `${cls.charAt(0).toUpperCase() + cls.slice(1)} detected`;
			left.appendChild(chip);
		}

		const right = document.createElement("div");
		right.className = "doorcam-status-right";
		if (s.state) {
			const state = document.createElement("span");
			state.className = "doorcam-state";
			state.textContent = s.state.toUpperCase();
			right.appendChild(state);
		}
		if (typeof s.battery_pct === "number" && isFinite(s.battery_pct)) {
			const battery = document.createElement("span");
			battery.className = "doorcam-battery";
			const pct = Math.round(s.battery_pct);
			battery.textContent = s.on_battery === false ? `${pct}% ⚡` : `${pct}%`;
			right.appendChild(battery);
		}
		if (s.connected === false) {
			const off = document.createElement("span");
			off.className = "doorcam-state doorcam-state-offline";
			off.textContent = "OFFLINE";
			right.appendChild(off);
		}

		bar.appendChild(left);
		bar.appendChild(right);
		return bar;
	},

	renderToggleButton () {
		const btn = document.createElement("button");
		btn.type = "button";
		btn.className = "doorcam-toggle";
		const connected = this.status && this.status.connected;
		if (!connected) {
			btn.textContent = "Unavailable";
			btn.disabled = true;
		} else if (this.cameraState === "on") {
			btn.textContent = "Turn OFF";
		} else {
			btn.textContent = "Turn ON";
		}
		if (this.inFlightToggle) btn.disabled = true;
		btn.addEventListener("click", () => this.requestToggle());
		return btn;
	},

	streamUrl () {
		const base = (this.config.hubUrl || "").replace(/\/+$/, "");
		const id = encodeURIComponent(this.config.camId);
		return `${base}/cam/${id}/stream.mjpg?t=${this.streamNonce}`;
	}
});
