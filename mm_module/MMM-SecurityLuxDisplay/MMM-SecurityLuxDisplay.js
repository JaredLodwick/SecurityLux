/**
 * MMM-SecurityLuxDisplay — MagicMirror² display for SecurityLuxHub.
 *
 * Pure browser-side module. No node_helper, no embedded server, no npm install.
 * Talks to a remote SecurityLuxHub over HTTP:
 *
 *   - Live MJPEG  →  StreamKeeper, pointed at /cam/<id>/stream.mjpg
 *   - Live status →  fetch(/cam/<id>/status) every `pollMs`
 *   - Last event  →  fetch(/events/latest?cam=<id>)
 *   - Toggle      →  fetch(/cam/<id>/toggle, { method: "POST" })
 *
 * ============================================================================
 *  The blackout fix
 * ============================================================================
 *
 * This module used to blank out after a few minutes. The cause was its own
 * recovery code: a `streamRefreshSeconds: 300` timer nulled the <img>'s src and
 * relied on MagicMirror's `updateDom()` (morphdom) to apply a new one. morphdom
 * reconciles the *existing* element rather than swapping in the freshly built
 * one, so the request was never actually re-issued — and the old multipart
 * connection was never released either, which burned one of the browser's ~6
 * connections per origin each time round.
 *
 * The fix is structural: the <img> is owned by StreamKeeper and lives outside
 * MagicMirror's DOM diffing entirely. `getDom()` returns StreamKeeper's stable
 * wrapper element, so morphdom has nothing to reconcile and the video element
 * survives every re-render. Reconnects now happen on evidence — an error, the
 * page becoming visible again, or frozen pixels while the hub reports fresh
 * frames — rather than on a blind timer.
 *
 * See stream-keeper.js for the details. That file is the same source the hub
 * dashboard serves; keep the two copies identical.
 */

Module.register("MMM-SecurityLuxDisplay", {
	defaults: {
		hubUrl: "http://meer.local:5000",   // any reachable SecurityLuxHub
		camId: "front",                     // matches the camera_node's `camera.id`

		// Display options.
		hideWhenOff: true,
		showToggleButton: false,
		showStatusBar: true,
		showLastEvent: true,
		showLastEventThumbnail: false,
		width: "320px",
		title: "Security Lux",

		// Hide the last event once it's stale, so the mirror isn't still
		// advertising yesterday's news at breakfast. 0 disables the cutoff.
		lastEventMaxAgeMinutes: 120,

		// Polling.
		pollMs: 1000,                       // status poll cadence
		eventPollMs: 15000,                 // last-event poll cadence

		// StreamKeeper tuning. The defaults are sensible; these are here so a
		// flaky WiFi link can be given more slack without editing the module.
		stallTimeoutMs: 6000,
		reconnectBackoffMs: 1000
	},

	getStyles () {
		return [this.file("MMM-SecurityLuxDisplay.css")];
	},

	getScripts () {
		return [this.file("stream-keeper.js")];
	},

	start () {
		this.status = null;
		this.cameraState = null;
		this.lastEvent = null;
		this.inFlightToggle = false;
		this.keeper = null;

		this._pollTimer = null;
		this._eventTimer = null;
		this._suspended = false;

		this._pollStatus();
		this._pollLastEvent();
	},

	suspend () {
		// MagicMirror hides this module (page rotation, etc). Drop the stream
		// so it isn't holding a connection slot for a view nobody can see.
		this._suspended = true;
		this._stopTimers();
		if (this.keeper) this.keeper.setActive(false);
	},

	resume () {
		this._suspended = false;
		this._pollStatus();
		this._pollLastEvent();
	},

	notificationReceived (notification) {
		if (notification === "SECURITY_LUX_TOGGLE") this.requestToggle();
		else if (notification === "SECURITY_LUX_ON") this.requestToggle("on");
		else if (notification === "SECURITY_LUX_OFF") this.requestToggle("off");
	},

	/* ---- polling ---- */

	async _pollStatus () {
		if (this._suspended) return;
		try {
			const res = await fetch(this._url(`/cam/${this._camId()}/status`), { cache: "no-store" });
			if (!res.ok) throw new Error("HTTP " + res.status);
			this._applyStatus(await res.json());
		} catch (_) {
			// Hub unreachable. Reflect it once rather than thrashing updateDom
			// on every failed poll.
			if (!this.status || this.status.connected !== false) {
				this.status = Object.assign({}, this.status || {}, {
					cam_id: this.config.camId, connected: false, state: null
				});
				this._syncKeeper();
				this.updateDom();
			}
		}
		this._pollTimer = setTimeout(() => this._pollStatus(), Math.max(250, this.config.pollMs));
	},

	async _pollLastEvent () {
		if (this._suspended) return;
		if (this.config.showLastEvent) {
			try {
				const res = await fetch(
					this._url(`/events/latest?cam=${this._camId()}`), { cache: "no-store" }
				);
				if (res.ok) {
					const event = await res.json();
					const changed = (event && event.id) !== (this.lastEvent && this.lastEvent.id);
					this.lastEvent = event;
					if (changed) this.updateDom();
				}
			} catch (_) { /* leave the previous event in place */ }
		}
		this._eventTimer = setTimeout(
			() => this._pollLastEvent(), Math.max(2000, this.config.eventPollMs)
		);
	},

	_stopTimers () {
		if (this._pollTimer) { clearTimeout(this._pollTimer); this._pollTimer = null; }
		if (this._eventTimer) { clearTimeout(this._eventTimer); this._eventTimer = null; }
	},

	_applyStatus (next) {
		if (!next || next.cam_id !== this.config.camId) return;

		const prev = this.status;
		const prevState = this.cameraState;
		this.status = next;
		this.cameraState = next.state || null;
		this.inFlightToggle = false;

		this._syncKeeper();

		// Skip the DOM diff when nothing visible changed. Status is polled
		// once a second; re-rendering that often for no reason is wasted work
		// on a Pi that is also driving a mirror.
		if (this._changedVisibly(prev, next, prevState)) this.updateDom();
	},

	_changedVisibly (prev, next, prevState) {
		if (!prev) return true;
		if (prevState !== this.cameraState) return true;
		if (prev.connected !== next.connected) return true;
		if (prev.battery_pct !== next.battery_pct) return true;
		if (prev.on_battery !== next.on_battery) return true;
		if (prev.behavior !== next.behavior) return true;
		return !detectionEqual(prev.current_detection, next.current_detection);
	},

	/* ---- stream ---- */

	_ensureKeeper () {
		if (this.keeper) return this.keeper;
		const self = this;
		this.keeper = new StreamKeeper({
			streamUrl: () => self._url(`/cam/${self._camId()}/stream.mjpg`),
			statusProvider: () => self.status,
			alt: `Live ${this.config.camId} camera feed`,
			className: "securitylux-stream",
			// The hub is on a different origin from MagicMirror, so the pixel
			// watchdog needs CORS to read frames back. The hub sends
			// Access-Control-Allow-Origin: * on every response.
			crossOrigin: true,
			options: {
				stallTimeoutMs: this.config.stallTimeoutMs,
				reconnectBackoffMs: this.config.reconnectBackoffMs
			},
			logger: {
				info: (m) => Log.info(`[MMM-SecurityLuxDisplay] ${m}`),
				warn: (m) => Log.warn(`[MMM-SecurityLuxDisplay] ${m}`)
			}
		});
		return this.keeper;
	},

	_syncKeeper () {
		const shouldStream = !!(this.status && this.status.connected && this.cameraState === "on");
		this._ensureKeeper().setActive(shouldStream);
	},

	/* ---- toggle ---- */

	async requestToggle (desired) {
		this.inFlightToggle = true;
		this.updateDom();
		const body = (desired === "on" || desired === "off")
			? JSON.stringify({ state: desired })
			: undefined;
		try {
			const res = await fetch(this._url(`/cam/${this._camId()}/toggle`), {
				method: "POST",
				headers: body ? { "Content-Type": "application/json" } : undefined,
				body
			});
			if (!res.ok) throw new Error("HTTP " + res.status);
			this._stopTimers();
			this._pollStatus();       // reflect the new state immediately
			this._pollLastEvent();
		} catch (_) {
			this.inFlightToggle = false;
			this.updateDom();
		}
	},

	/* ---- render ---- */

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
		if (this.config.showLastEvent) {
			const event = this.renderLastEvent();
			if (event) wrap.appendChild(event);
		}
		if (this.config.showToggleButton) wrap.appendChild(this.renderToggleButton());

		return wrap;
	},

	/**
	 * Return StreamKeeper's wrapper when streaming.
	 *
	 * This node is stable across renders and StreamKeeper owns everything
	 * inside it, which is precisely what keeps morphdom from interfering with
	 * the live connection.
	 */
	renderVideoChild () {
		const status = this.status;
		if (this.cameraState === "on" && status && status.connected) {
			return this._ensureKeeper().element;
		}

		const placeholder = document.createElement("div");
		placeholder.className = "securitylux-placeholder";
		if (!status) {
			placeholder.textContent = "Connecting to hub…";
		} else if (status.connected === false) {
			placeholder.classList.add("securitylux-placeholder-error");
			placeholder.textContent = `Camera "${this.config.camId}" offline`;
		} else {
			placeholder.textContent = "Camera off";
		}
		return placeholder;
	},

	/**
	 * Translucent bbox drawn over the live feed. `current_detection.bbox` is
	 * normalized 0-1 from the hub, converted to CSS percentages so it scales
	 * with whatever size the module renders at.
	 */
	renderBboxOverlay () {
		if (this.cameraState !== "on") return null;
		const status = this.status;
		if (!status || !status.connected) return null;
		const detection = status.current_detection;
		if (!detection || !detection.bbox) return null;

		const { cx, cy, w, h } = detection.bbox;
		if (![cx, cy, w, h].every((n) => typeof n === "number" && isFinite(n))) return null;

		const layer = document.createElement("div");
		layer.className = "securitylux-bbox-layer";

		const box = document.createElement("div");
		box.className = "securitylux-bbox";
		const left = Math.max(0, cx - w / 2) * 100;
		const top = Math.max(0, cy - h / 2) * 100;
		box.style.left = `${left}%`;
		box.style.top = `${top}%`;
		box.style.width = `${Math.min(100 - left, w * 100)}%`;
		box.style.height = `${Math.min(100 - top, h * 100)}%`;

		const label = document.createElement("span");
		label.className = "securitylux-bbox-label";
		const conf = Math.round((detection.confidence || 0) * 100);
		const cls = detection.class || "object";
		label.textContent = conf > 0 ? `${cls} ${conf}%` : cls;
		box.appendChild(label);

		layer.appendChild(box);
		return layer;
	},

	renderStatusBar () {
		const bar = document.createElement("div");
		bar.className = "securitylux-status";
		const status = this.status || {};

		const left = document.createElement("div");
		left.className = "securitylux-status-left";
		if (status.current_detection) {
			const chip = document.createElement("span");
			chip.className = "securitylux-event-chip";
			const behavior = status.behavior && status.behavior !== "idle"
				? status.behavior
				: (status.current_detection.class || "person");
			chip.textContent = behavior.charAt(0).toUpperCase() + behavior.slice(1);
			left.appendChild(chip);
		}

		const right = document.createElement("div");
		right.className = "securitylux-status-right";
		if (status.state) {
			const state = document.createElement("span");
			state.className = "securitylux-state";
			state.textContent = String(status.state).toUpperCase();
			right.appendChild(state);
		}
		if (typeof status.battery_pct === "number" && isFinite(status.battery_pct)) {
			const battery = document.createElement("span");
			battery.className = "securitylux-battery";
			const pct = Math.round(status.battery_pct);
			battery.textContent = status.on_battery === false ? `${pct}% ⚡` : `${pct}%`;
			right.appendChild(battery);
		}
		if (status.connected === false) {
			const offline = document.createElement("span");
			offline.className = "securitylux-state securitylux-state-offline";
			offline.textContent = "OFFLINE";
			right.appendChild(offline);
		}

		bar.appendChild(left);
		bar.appendChild(right);
		return bar;
	},

	/**
	 * The most recent event, in plain English with a relative timestamp.
	 * "Someone approached the trash room door · 4 min ago".
	 */
	renderLastEvent () {
		const event = this.lastEvent;
		if (!event || !event.started_at_ms) return null;

		const maxAge = Number(this.config.lastEventMaxAgeMinutes);
		if (isFinite(maxAge) && maxAge > 0) {
			if (Date.now() - event.started_at_ms > maxAge * 60000) return null;
		}

		const row = document.createElement("div");
		row.className = "securitylux-last-event";
		if (event.behavior === "loitering" || event.behavior === "dwelling") {
			row.classList.add("securitylux-last-event-alert");
		}

		if (this.config.showLastEventThumbnail && event.thumb_path) {
			const thumb = document.createElement("img");
			thumb.className = "securitylux-last-event-thumb";
			thumb.src = this._url(`/events/${event.id}/thumb.jpg`);
			thumb.alt = "";
			row.appendChild(thumb);
		}

		const body = document.createElement("div");
		body.className = "securitylux-last-event-body";

		const text = document.createElement("div");
		text.className = "securitylux-last-event-text";
		text.textContent = event.description
			|| `${(event.type || "event").replace(/_/g, " ")} detected`;
		body.appendChild(text);

		const time = document.createElement("div");
		time.className = "securitylux-last-event-time";
		time.textContent = formatRelative(event.started_at_ms);
		time.title = new Date(event.started_at_ms).toLocaleString();
		body.appendChild(time);

		row.appendChild(body);
		return row;
	},

	renderToggleButton () {
		const btn = document.createElement("button");
		btn.type = "button";
		btn.className = "securitylux-toggle";
		const connected = this.status && this.status.connected;
		if (!connected) {
			btn.textContent = "Unavailable";
			btn.disabled = true;
		} else {
			btn.textContent = this.cameraState === "on" ? "Turn OFF" : "Turn ON";
		}
		if (this.inFlightToggle) btn.disabled = true;
		btn.addEventListener("click", () => this.requestToggle());
		return btn;
	},

	/* ---- helpers ---- */

	_url (path) {
		return `${(this.config.hubUrl || "").replace(/\/+$/, "")}${path}`;
	},

	_camId () {
		return encodeURIComponent(this.config.camId);
	}
});

function detectionEqual (a, b) {
	if (a === b) return true;
	if (!a || !b) return false;
	if (a.class !== b.class) return false;
	if (Math.abs((a.confidence || 0) - (b.confidence || 0)) > 0.01) return false;
	const ab = a.bbox || {};
	const bb = b.bbox || {};
	const eps = 0.005;   // 0.5% of the frame; below that is invisible at 320px
	return Math.abs((ab.cx || 0) - (bb.cx || 0)) < eps
		&& Math.abs((ab.cy || 0) - (bb.cy || 0)) < eps
		&& Math.abs((ab.w || 0) - (bb.w || 0)) < eps
		&& Math.abs((ab.h || 0) - (bb.h || 0)) < eps;
}

function formatRelative (ms) {
	const delta = Date.now() - ms;
	if (delta < 45000) return "just now";
	const minutes = Math.round(delta / 60000);
	if (minutes < 60) return `${minutes} min ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
	const days = Math.round(hours / 24);
	return `${days} day${days === 1 ? "" : "s"} ago`;
}
