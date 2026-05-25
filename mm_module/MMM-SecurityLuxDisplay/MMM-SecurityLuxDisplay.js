/**
 * MMM-SecurityLuxDisplay — MagicMirror² display for SecurityLuxHub.
 *
 * Pure browser-side module. No node_helper, no embedded server. Talks to a
 * remote SecurityLuxHub over HTTP:
 *
 *   - Live MJPEG  →  <img src="${hubUrl}/cam/<camId>/stream.mjpg?t=...">
 *   - Live status →  fetch(${hubUrl}/cam/<camId>/status) every `pollMs`
 *   - Toggle      →  fetch(${hubUrl}/cam/<camId>/toggle, { method: 'POST', body })
 *
 * The hub can run anywhere on the LAN: same Pi as MagicMirror, a spare Pi,
 * a desktop. As long as `hubUrl` is reachable from this browser, the module
 * works.
 */

function detectionEqual (a, b) {
	if (a === b) return true;
	if (!a || !b) return false;
	if (a.class !== b.class) return false;
	if (Math.abs((a.confidence || 0) - (b.confidence || 0)) > 0.01) return false;
	const ab = a.bbox || {}; const bb = b.bbox || {};
	const eps = 0.005; // 0.5% of frame; below that is invisible at 320px width
	return Math.abs((ab.cx || 0) - (bb.cx || 0)) < eps
		&& Math.abs((ab.cy || 0) - (bb.cy || 0)) < eps
		&& Math.abs((ab.w  || 0) - (bb.w  || 0)) < eps
		&& Math.abs((ab.h  || 0) - (bb.h  || 0)) < eps;
}

Module.register("MMM-SecurityLuxDisplay", {
	defaults: {
		hubUrl: "http://meer.local:5000",   // any reachable SecurityLuxHub
		camId: "front",                     // matches the camera_node's `camera.id`

		// Display options.
		hideWhenOff: true,
		showToggleButton: false,
		showStatusBar: true,
		width: "320px",
		title: "Security Lux",

		// Polling + stream-recovery knobs.
		pollMs: 500,                        // matches default detector tick rate
		streamRefreshSeconds: 300,          // belt-and-suspenders against silent MJPEG drops
		staleFrameMs: 10000,                // server-side last_frame_age_ms threshold for refresh
		errorRetryMs: 1500                  // how long to wait after an <img> error before re-fetching
	},

	start () {
		this.status = null;
		this.cameraState = null;
		this.inFlightToggle = false;
		this.streamNonce = Date.now();
		this._pollTimer = null;
		this._refreshTimer = null;
		this._suspended = false;
		this._scheduleNextPoll(0);   // first poll fires asap
	},

	suspend () {
		this._suspended = true;
		this._stopPollTimer();
		this._stopRefreshTimer();
	},

	resume () {
		this._suspended = false;
		this._scheduleNextPoll(0);
	},

	getStyles () {
		return [this.file("MMM-SecurityLuxDisplay.css")];
	},

	notificationReceived (notification) {
		if (notification === "SECURITY_LUX_TOGGLE") {
			this.requestToggle();
		} else if (notification === "SECURITY_LUX_ON") {
			this.requestToggle("on");
		} else if (notification === "SECURITY_LUX_OFF") {
			this.requestToggle("off");
		}
	},

	/* ---- status polling ---- */

	async _pollStatus () {
		if (this._suspended) return;
		const url = `${this._hubBase()}/cam/${encodeURIComponent(this.config.camId)}/status`;
		try {
			const res = await fetch(url, { cache: "no-store" });
			if (!res.ok) throw new Error("HTTP " + res.status);
			const status = await res.json();
			this._applyStatus(status);
		} catch (err) {
			// Hub unreachable. Mark as offline so the placeholder reflects it,
			// but only once (don't thrash updateDom on repeated failures).
			if (this.status && this.status.connected !== false) {
				this.status = Object.assign({}, this.status, { connected: false });
				this.updateDom();
			} else if (!this.status) {
				this.status = { cam_id: this.config.camId, connected: false, state: null };
				this.updateDom();
			}
		}
		this._scheduleNextPoll(this.config.pollMs);
	},

	_scheduleNextPoll (delay) {
		if (this._suspended) return;
		this._stopPollTimer();
		const ms = Math.max(100, Number(delay) || this.config.pollMs);
		this._pollTimer = setTimeout(() => this._pollStatus(), ms);
	},

	_stopPollTimer () {
		if (this._pollTimer) {
			clearTimeout(this._pollTimer);
			this._pollTimer = null;
		}
	},

	_applyStatus (next) {
		if (!next || next.cam_id !== this.config.camId) return;

		const prev = this.status;
		const prevState = this.cameraState;
		this.status = next;
		this.cameraState = next.state || null;

		let nonceChanged = false;
		if (prevState !== this.cameraState && this.cameraState === "on") {
			this._refreshStreamSrc();
			nonceChanged = true;
		}
		if (!nonceChanged && this.cameraState === "on" && next.connected) {
			const ageMs = next.last_frame_age_ms;
			if (typeof ageMs === "number" && isFinite(ageMs) && ageMs > this.config.staleFrameMs) {
				this._refreshStreamSrc();
				nonceChanged = true;
			}
		}

		if (this.cameraState === "on") {
			this._scheduleRefreshTimer();
		} else {
			this._stopRefreshTimer();
		}
		this.inFlightToggle = false;

		// Skip the morphdom diff when nothing visible changed. The hub pushes
		// status implicitly on every detector tick (~2 Hz) so this matters.
		if (nonceChanged || this._statusChangedVisibly(prev, next, prevState)) {
			this.updateDom();
		}
	},

	_statusChangedVisibly (prev, next, prevState) {
		if (!prev) return true;
		if (prevState !== this.cameraState) return true;
		if (prev.connected !== next.connected) return true;
		if (prev.battery_pct !== next.battery_pct) return true;
		if (prev.on_battery !== next.on_battery) return true;
		if (!detectionEqual(prev.current_detection, next.current_detection)) return true;
		return false;
	},

	/* ---- MJPEG stream lifecycle ---- */

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
		this._refreshStreamSrc();
		this.updateDom();
	},

	/**
	 * Bump the stream nonce AND explicitly null out the live <img> src first.
	 *
	 * Browsers don't reliably abort the underlying TCP for a multipart MJPEG
	 * response when src changes via morphdom — the connection sticks around
	 * "loading forever" and counts against the per-origin connection cap (~6).
	 * Setting src="" first forces the browser to abort the previous fetch.
	 */
	_refreshStreamSrc () {
		const wrapper = document.getElementById(this.identifier);
		const oldImg = wrapper && wrapper.querySelector(".securitylux-stream");
		if (oldImg && oldImg.src) {
			try { oldImg.src = ""; } catch (_) { /* ignore */ }
		}
		this.streamNonce = Date.now();
	},

	/* ---- toggle ---- */

	async requestToggle (desired) {
		this.inFlightToggle = true;
		this.updateDom();
		const url = `${this._hubBase()}/cam/${encodeURIComponent(this.config.camId)}/toggle`;
		const body = (desired === "on" || desired === "off")
			? JSON.stringify({ state: desired })
			: undefined;
		try {
			const res = await fetch(url, {
				method: "POST",
				headers: body ? { "Content-Type": "application/json" } : undefined,
				body
			});
			if (!res.ok) throw new Error("HTTP " + res.status);
			// The next poll will reflect the new state. Force one immediately
			// so the UI feels snappy.
			this._scheduleNextPoll(0);
		} catch (err) {
			this.inFlightToggle = false;
			this.updateDom();
		}
	},

	/* ---- DOM render ---- */

	getDom () {
		const wrap = document.createElement("div");
		wrap.className = "mmm-securitylux-display";
		wrap.style.width = this.config.width;

		if (this.config.hideWhenOff && this.cameraState === "off") {
			wrap.classList.add("hidden-when-off");
			return wrap;
		}

		if (this.config.title) {
			const title = document.createElement("div");
			title.className = "securitylux-title";
			title.textContent = this.config.title;
			wrap.appendChild(title);
		}

		const frame = document.createElement("div");
		frame.className = "securitylux-frame";
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
			img.className = "securitylux-stream";
			img.alt = `Live ${this.config.camId} camera feed`;
			img.src = this._streamUrl();
			img.addEventListener("error", () => {
				const retryMs = Math.max(250, Number(this.config.errorRetryMs) || 1500);
				setTimeout(() => this._refreshStreamIfOn(), retryMs);
			});
			return img;
		}
		const placeholder = document.createElement("div");
		placeholder.className = "securitylux-placeholder";
		if (!s) {
			placeholder.textContent = "Connecting to hub…";
		} else if (s.connected === false) {
			placeholder.classList.add("securitylux-placeholder-error");
			placeholder.textContent = `Camera "${this.config.camId}" offline`;
		} else {
			placeholder.textContent = "Camera off";
		}
		return placeholder;
	},

	/**
	 * Translucent bbox overlay drawn on top of the live MJPEG <img>.
	 * `current_detection.bbox` is normalized 0-1 cx/cy/w/h from the hub —
	 * we convert to CSS percentages and let the overlay scale with whatever
	 * size the module ends up rendering at.
	 */
	renderBboxOverlay () {
		if (this.cameraState !== "on") return null;
		const s = this.status;
		if (!s || !s.connected || !s.current_detection || !s.current_detection.bbox) return null;
		const { cx, cy, w, h } = s.current_detection.bbox;
		if (![cx, cy, w, h].every((n) => typeof n === "number" && isFinite(n))) return null;

		const layer = document.createElement("div");
		layer.className = "securitylux-bbox-layer";

		const box = document.createElement("div");
		box.className = "securitylux-bbox";
		const left = Math.max(0, (cx - w / 2)) * 100;
		const top = Math.max(0, (cy - h / 2)) * 100;
		const widthPct = Math.min(100 - left, w * 100);
		const heightPct = Math.min(100 - top, h * 100);
		box.style.left = `${left}%`;
		box.style.top = `${top}%`;
		box.style.width = `${widthPct}%`;
		box.style.height = `${heightPct}%`;

		const label = document.createElement("span");
		label.className = "securitylux-bbox-label";
		const conf = Math.round((s.current_detection.confidence || 0) * 100);
		const cls = s.current_detection.class || "object";
		label.textContent = conf > 0 ? `${cls} ${conf}%` : cls;
		box.appendChild(label);

		layer.appendChild(box);
		return layer;
	},

	renderStatusBar () {
		const bar = document.createElement("div");
		bar.className = "securitylux-status";
		const s = this.status || {};

		const left = document.createElement("div");
		left.className = "securitylux-status-left";
		if (s.current_detection) {
			const chip = document.createElement("span");
			chip.className = "securitylux-event-chip";
			const cls = s.current_detection.class || "object";
			chip.textContent = `${cls.charAt(0).toUpperCase() + cls.slice(1)} detected`;
			left.appendChild(chip);
		}

		const right = document.createElement("div");
		right.className = "securitylux-status-right";
		if (s.state) {
			const state = document.createElement("span");
			state.className = "securitylux-state";
			state.textContent = s.state.toUpperCase();
			right.appendChild(state);
		}
		if (typeof s.battery_pct === "number" && isFinite(s.battery_pct)) {
			const battery = document.createElement("span");
			battery.className = "securitylux-battery";
			const pct = Math.round(s.battery_pct);
			battery.textContent = s.on_battery === false ? `${pct}% ⚡` : `${pct}%`;
			right.appendChild(battery);
		}
		if (s.connected === false) {
			const off = document.createElement("span");
			off.className = "securitylux-state securitylux-state-offline";
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
		btn.className = "securitylux-toggle";
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

	/* ---- helpers ---- */

	_hubBase () {
		return (this.config.hubUrl || "").replace(/\/+$/, "");
	},

	_streamUrl () {
		const id = encodeURIComponent(this.config.camId);
		return `${this._hubBase()}/cam/${id}/stream.mjpg?t=${this.streamNonce}`;
	}
});
