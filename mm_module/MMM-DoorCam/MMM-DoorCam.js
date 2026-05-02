Module.register("MMM-DoorCam", {
	defaults: {
		camId: "front",
		hubUrl: "http://meer.local:5000",
		hubPort: 5000,
		hideWhenOff: true,
		showToggleButton: true,
		showStatusBar: true,
		width: "320px",
		title: "Door Cam",
		streamRefreshSeconds: 30,
		staleFrameMs: 10000,
		errorRetryMs: 1500
	},

	start () {
		this.status = null;
		this.cameraState = null;
		this.inFlightToggle = false;
		this.streamNonce = Date.now();
		this._refreshTimer = null;

		this.sendSocketNotification("DOORCAM_INIT", {
			camId: this.config.camId,
			hubPort: this.config.hubPort
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

	renderStatusBar () {
		const bar = document.createElement("div");
		bar.className = "doorcam-status";
		const s = this.status || {};
		const parts = [];
		if (s.state) parts.push(s.state.toUpperCase());
		if (typeof s.fps === "number") parts.push(`${s.fps} fps`);
		if (s.resolution) parts.push(String(s.resolution).replace("x", "×"));
		if (typeof s.battery_pct === "number" && isFinite(s.battery_pct)) {
			const pct = Math.round(s.battery_pct);
			parts.push(s.on_battery === false ? `${pct}% ⚡` : `${pct}%`);
		}
		if (s.connected === false) parts.push("offline");
		bar.textContent = parts.length ? parts.join("  •  ") : "—";
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
