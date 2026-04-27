Module.register("MMM-DoorCam", {
	defaults: {
		camId: "front",
		hubUrl: "http://meer.local:5000",
		hubPort: 5000,
		startEnabled: false,
		hideWhenOff: true,
		showToggleButton: true,
		showStatusBar: true,
		width: "320px",
		title: "Door Cam"
	},

	start () {
		this.status = null;
		this.cameraState = null;
		this.inFlightToggle = false;
		this.streamNonce = Date.now();

		this.sendSocketNotification("DOORCAM_INIT", {
			camId: this.config.camId,
			hubPort: this.config.hubPort,
			startEnabled: this.config.startEnabled
		});
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
		if (prevState !== this.cameraState && this.cameraState === "on") {
			this.streamNonce = Date.now();
		}
		this.inFlightToggle = false;
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
