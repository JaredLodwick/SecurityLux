/**
 * StreamKeeper — keeps an MJPEG <img> alive, forever.
 *
 * ============================================================================
 *  Why this exists
 * ============================================================================
 *
 * A `multipart/x-mixed-replace` response rendered in an <img> is wonderfully
 * simple until it silently dies, and it dies in ways that fire no events:
 *
 *   1. The page is suspended (phone locked, tab backgrounded on mobile). The
 *      OS tears down the socket. On resume the <img> shows a broken-image icon
 *      and nothing ever retries. No `error` event on some engines.
 *
 *   2. The decoder wedges. The socket is open, bytes are arriving, and the
 *      element just stops painting new parts. Black frame, no event at all.
 *
 *   3. Connection-slot exhaustion. Browsers allow ~6 concurrent connections per
 *      origin, and a multipart response holds one open indefinitely. Every
 *      "refresh" that fails to actually abort the old request leaks a slot;
 *      after a handful the next stream never connects.
 *
 * The previous implementation tried to paper over (1) and (2) with a blind
 * 5-minute `setInterval` refresh that nulled `img.src` and leaned on a DOM
 * differ to re-apply the new URL. That reconciled the *old* element instead of
 * inserting the new one, so the refresh never re-issued the request — and it
 * hit case (3) on the way out. The safety net was the failure.
 *
 * ============================================================================
 *  How this one works
 * ============================================================================
 *
 * - Owns a wrapper <div>. Callers re-parent the wrapper; they never touch the
 *   <img>. Reconnecting *replaces the <img> element outright*, which is the
 *   only reliable way to free the connection slot across engines.
 *
 * - Reconnects on evidence, never on a timer:
 *     * `error` / `stalled` events           → immediate, with backoff
 *     * `visibilitychange` → visible          → immediate (fixes phone lock)
 *     * `pageshow` (bfcache restore)          → immediate (fixes iOS back-nav)
 *     * frozen pixels while server has frames → immediate (fixes wedged decoder)
 *
 * - The pixel watchdog draws the <img> into a 16x16 offscreen canvas every
 *   `checkIntervalMs` and hashes it. Unchanged for `stallTimeoutMs` *while the
 *   server reports fresh frames* means we're wedged. Cross-origin use needs
 *   `crossOrigin="anonymous"`; the hub sends `Access-Control-Allow-Origin: *`
 *   on every response so this works from a MagicMirror on another host. If
 *   readback still throws (tainted canvas), the watchdog disables itself and
 *   we fall back to event-driven recovery only — degraded, never broken.
 *
 * - `statusProvider` lets us tell "our connection is dead" apart from "the
 *   camera stopped sending". If the hub says `last_frame_age_ms` is large, the
 *   picture is *supposed* to be frozen; reconnecting would just hammer a hub
 *   that is already telling us the truth.
 *
 * Framework-free and dependency-free on purpose: the same file is served by the
 * hub dashboard and loaded by the MagicMirror module.
 */

(function (global) {
    "use strict";

    var DEFAULTS = {
        // How long frozen pixels are tolerated before we call it a stall.
        stallTimeoutMs: 6000,
        // Pixel-watchdog sampling cadence.
        checkIntervalMs: 2000,
        // Reconnect backoff, doubling from first to max.
        reconnectBackoffMs: 1000,
        reconnectBackoffMaxMs: 15000,
        // If the hub reports a frame age above this, a frozen picture is the
        // camera's doing, not ours — suppress the stall reconnect.
        serverStaleMs: 5000,
        // Offscreen probe canvas edge length. 16x16 is enough to catch a
        // changed scene and costs nothing to hash.
        probeSize: 16,
        // Give a fresh <img> this long to paint before the watchdog judges it.
        settleMs: 4000
    };

    var TRANSPARENT_GIF =
        "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

    function now() {
        return Date.now();
    }

    /**
     * FNV-1a over the probe canvas. We only need "did these bytes change",
     * not cryptographic strength, and this runs 30x/minute per camera.
     */
    function hashPixels(data) {
        var h = 0x811c9dc5;
        for (var i = 0; i < data.length; i += 4) {
            h ^= data[i];
            h = (h * 0x01000193) >>> 0;
            h ^= data[i + 1];
            h = (h * 0x01000193) >>> 0;
            h ^= data[i + 2];
            h = (h * 0x01000193) >>> 0;
        }
        return h >>> 0;
    }

    /**
     * @param {object} opts
     * @param {function(): string} opts.streamUrl   Returns the MJPEG URL *without* a cache-buster.
     * @param {function(): (object|null)} [opts.statusProvider]
     *        Returns the most recent `/cam/<id>/status` payload, or null. Used to
     *        distinguish a dead connection from a dead camera.
     * @param {function(string): void} [opts.onStateChange]
     *        Called with "connecting" | "live" | "stalled" | "error" | "idle".
     * @param {boolean} [opts.crossOrigin=true]  Set crossOrigin so the pixel watchdog can read back.
     * @param {string} [opts.alt]
     * @param {string} [opts.className]  Class applied to the <img>.
     * @param {object} [opts.options]    Overrides for DEFAULTS.
     * @param {object} [opts.logger]     Anything with .warn/.info. Defaults to a no-op.
     */
    function StreamKeeper(opts) {
        if (!opts || typeof opts.streamUrl !== "function") {
            throw new Error("StreamKeeper: streamUrl function is required");
        }

        this.cfg = {};
        for (var k in DEFAULTS) {
            if (Object.prototype.hasOwnProperty.call(DEFAULTS, k)) {
                this.cfg[k] = (opts.options && opts.options[k] !== undefined)
                    ? opts.options[k]
                    : DEFAULTS[k];
            }
        }

        this.streamUrl = opts.streamUrl;
        this.statusProvider = opts.statusProvider || function () { return null; };
        this.onStateChange = opts.onStateChange || function () {};
        this.useCrossOrigin = opts.crossOrigin !== false;
        this.alt = opts.alt || "Live camera feed";
        this.imgClassName = opts.className || "sl-stream-img";
        this.log = opts.logger || { warn: function () {}, info: function () {} };

        // Caller-visible node. Stable for the lifetime of the keeper so callers
        // can cache and re-parent it; the <img> inside is disposable.
        this.element = global.document.createElement("div");
        this.element.className = "sl-stream";

        this.img = null;
        this.active = false;
        this.destroyed = false;
        this.state = "idle";

        this._backoff = this.cfg.reconnectBackoffMs;
        this._reconnectTimer = null;
        this._watchdogTimer = null;
        this._lastHash = null;
        this._lastChangeAt = 0;
        this._connectedAt = 0;
        this._probeCanvas = null;
        this._probeCtx = null;
        this._pixelWatchdogUsable = true;
        this._reconnectCount = 0;

        var self = this;
        this._onVisibility = function () {
            if (!global.document.hidden) self._onBecameVisible();
        };
        this._onPageShow = function (ev) {
            // persisted === true means we came out of the bfcache, where the
            // stream socket is definitely gone.
            if (ev && ev.persisted) self._onBecameVisible();
        };
        this._onOnline = function () { self._onBecameVisible(); };

        global.document.addEventListener("visibilitychange", this._onVisibility);
        global.addEventListener("pageshow", this._onPageShow);
        global.addEventListener("online", this._onOnline);
    }

    StreamKeeper.prototype._setState = function (state) {
        if (this.state === state) return;
        this.state = state;
        try {
            this.onStateChange(state);
        } catch (err) {
            this.log.warn("StreamKeeper: onStateChange threw: " + (err && err.message));
        }
    };

    /**
     * Turn the stream on or off. Off tears the <img> down completely so the
     * connection slot is released while a camera sits idle.
     */
    StreamKeeper.prototype.setActive = function (active) {
        if (this.destroyed) return;
        var want = !!active;
        if (want === this.active) return;
        this.active = want;
        if (want) {
            this._backoff = this.cfg.reconnectBackoffMs;
            this._connect();
        } else {
            this._teardown();
            this._setState("idle");
        }
    };

    /** Force an immediate reconnect. Safe to call at any time. */
    StreamKeeper.prototype.reconnect = function (reason) {
        if (this.destroyed || !this.active) return;
        this._reconnectCount += 1;
        this.log.info("StreamKeeper: reconnect (" + (reason || "manual") + ")");
        this._connect();
    };

    StreamKeeper.prototype.destroy = function () {
        if (this.destroyed) return;
        this.destroyed = true;
        this.active = false;
        this._teardown();
        global.document.removeEventListener("visibilitychange", this._onVisibility);
        global.removeEventListener("pageshow", this._onPageShow);
        global.removeEventListener("online", this._onOnline);
    };

    /** Diagnostics for the UI: how flaky has this stream been? */
    StreamKeeper.prototype.stats = function () {
        return {
            state: this.state,
            reconnects: this._reconnectCount,
            connectedAt: this._connectedAt,
            pixelWatchdog: this._pixelWatchdogUsable
        };
    };

    // ------------------------------------------------------------------
    //  Connection lifecycle
    // ------------------------------------------------------------------

    StreamKeeper.prototype._connect = function () {
        if (this.destroyed || !this.active) return;

        this._teardown();
        this._setState("connecting");

        var self = this;
        var img = global.document.createElement("img");
        img.className = this.imgClassName;
        img.alt = this.alt;
        // Chromium honours this on <img> and it keeps a backgrounded tab from
        // being deprioritized into a stall.
        img.decoding = "async";

        // Required for the pixel watchdog to read back across origins (the MM
        // module's case). The hub always answers with a wildcard CORS header.
        if (this.useCrossOrigin) img.crossOrigin = "anonymous";

        img.addEventListener("load", function () {
            // For multipart responses this fires per part on some engines and
            // exactly once on others. Either way, the first one means bytes are
            // flowing — reset the backoff.
            self._backoff = self.cfg.reconnectBackoffMs;
            self._setState("live");
        });

        img.addEventListener("error", function () {
            self._scheduleReconnect("img-error");
        });

        // Fired when the browser gives up waiting for data mid-response.
        img.addEventListener("stalled", function () {
            self._scheduleReconnect("img-stalled");
        });

        this.img = img;
        this.element.replaceChildren(img);

        // Cache-buster is mandatory: without it, a reconnect to a byte-identical
        // URL can be served from a stale connection or the memory cache.
        var base = this.streamUrl();
        var sep = base.indexOf("?") >= 0 ? "&" : "?";
        img.src = base + sep + "_sk=" + now() + "-" + this._reconnectCount;

        this._connectedAt = now();
        this._lastHash = null;
        this._lastChangeAt = now();
        this._startWatchdog();
    };

    /**
     * Fully release the current <img>.
     *
     * Replacing the element is deliberate. Setting `src=""` or removing the
     * attribute is *supposed* to abort the fetch, but engines disagree about
     * multipart responses in particular, and a leaked multipart request holds a
     * connection slot until the tab closes. Dropping the element on the floor
     * and letting it be collected is the one approach that behaves everywhere.
     */
    StreamKeeper.prototype._teardown = function () {
        this._stopWatchdog();
        if (this._reconnectTimer) {
            global.clearTimeout(this._reconnectTimer);
            this._reconnectTimer = null;
        }
        var img = this.img;
        if (img) {
            this.img = null;
            try { img.removeAttribute("src"); } catch (_) { /* ignore */ }
            // Point at an inert data URI so any in-flight decode is abandoned.
            try { img.src = TRANSPARENT_GIF; } catch (_) { /* ignore */ }
            try {
                if (img.parentNode) img.parentNode.removeChild(img);
            } catch (_) { /* ignore */ }
        }
        this.element.replaceChildren();
    };

    StreamKeeper.prototype._scheduleReconnect = function (reason) {
        if (this.destroyed || !this.active) return;
        if (this._reconnectTimer) return;   // one in flight is enough

        this._setState(reason === "stall" ? "stalled" : "error");
        var delay = this._backoff;
        this._backoff = Math.min(this._backoff * 2, this.cfg.reconnectBackoffMaxMs);

        this.log.info(
            "StreamKeeper: " + reason + "; reconnecting in " + delay + "ms"
        );

        var self = this;
        this._reconnectTimer = global.setTimeout(function () {
            self._reconnectTimer = null;
            self._reconnectCount += 1;
            self._connect();
        }, delay);
    };

    StreamKeeper.prototype._onBecameVisible = function () {
        if (this.destroyed || !this.active) return;
        // A suspended page's socket is gone even though nothing told us. Don't
        // wait for the watchdog — the user is looking at the screen right now.
        this._backoff = this.cfg.reconnectBackoffMs;
        this._reconnectCount += 1;
        this.log.info("StreamKeeper: page became visible; reconnecting");
        this._connect();
    };

    // ------------------------------------------------------------------
    //  Pixel watchdog — catches the wedged decoder that fires no events
    // ------------------------------------------------------------------

    StreamKeeper.prototype._startWatchdog = function () {
        this._stopWatchdog();
        if (!this._pixelWatchdogUsable) return;
        var self = this;
        this._watchdogTimer = global.setInterval(function () {
            self._checkForStall();
        }, this.cfg.checkIntervalMs);
    };

    StreamKeeper.prototype._stopWatchdog = function () {
        if (this._watchdogTimer) {
            global.clearInterval(this._watchdogTimer);
            this._watchdogTimer = null;
        }
    };

    StreamKeeper.prototype._checkForStall = function () {
        if (this.destroyed || !this.active || !this.img) return;
        // No point sampling a hidden page — and drawing while hidden is
        // throttled anyway. `visibilitychange` handles the wake-up.
        if (global.document.hidden) return;
        // Give a new connection time to paint its first frame.
        if (now() - this._connectedAt < this.cfg.settleMs) return;

        var hash = this._probe();
        if (hash === null) return;   // not decodable yet, or readback blocked

        if (hash !== this._lastHash) {
            this._lastHash = hash;
            this._lastChangeAt = now();
            this._setState("live");
            return;
        }

        if (now() - this._lastChangeAt < this.cfg.stallTimeoutMs) return;

        // Pixels are frozen. Before blaming our connection, ask whether the hub
        // even has anything new to send: a camera that is off, disconnected, or
        // wedged upstream *should* produce a still picture, and reconnecting
        // would just hammer a hub that is already reporting the problem
        // accurately.
        var status = null;
        try { status = this.statusProvider(); } catch (_) { status = null; }
        if (status) {
            var age = status.last_frame_age_ms;
            var serverAlsoStale = (typeof age !== "number") || !isFinite(age)
                || age > this.cfg.serverStaleMs;
            if (serverAlsoStale || status.connected === false || status.state !== "on") {
                // Server-side problem. Keep the connection; let it recover on
                // its own and reset our timer so we don't fire the instant the
                // camera comes back.
                this._lastChangeAt = now();
                return;
            }
        }

        // Server has fresh frames and we're painting a still image: it's us.
        this._scheduleReconnect("stall");
    };

    /**
     * Draw the current <img> into a tiny offscreen canvas and hash it.
     * Returns null when the frame isn't readable (not yet decoded, or a tainted
     * canvas — in which case the watchdog permanently disables itself).
     */
    StreamKeeper.prototype._probe = function () {
        var img = this.img;
        if (!img || !img.naturalWidth || !img.naturalHeight) return null;

        if (!this._probeCanvas) {
            this._probeCanvas = global.document.createElement("canvas");
            this._probeCanvas.width = this.cfg.probeSize;
            this._probeCanvas.height = this.cfg.probeSize;
            this._probeCtx = this._probeCanvas.getContext("2d", { willReadFrequently: true });
        }
        if (!this._probeCtx) {
            this._pixelWatchdogUsable = false;
            this._stopWatchdog();
            return null;
        }

        try {
            this._probeCtx.drawImage(img, 0, 0, this.cfg.probeSize, this.cfg.probeSize);
            var frame = this._probeCtx.getImageData(0, 0, this.cfg.probeSize, this.cfg.probeSize);
            return hashPixels(frame.data);
        } catch (err) {
            // SecurityError => canvas is tainted, so the hub didn't send usable
            // CORS headers for this image. Degrade to event-driven recovery
            // rather than throwing every two seconds forever.
            this._pixelWatchdogUsable = false;
            this._stopWatchdog();
            this.log.warn(
                "StreamKeeper: pixel watchdog disabled (" + (err && err.name) + "). " +
                "Stall detection now relies on error events only."
            );
            return null;
        }
    };

    // Export for both a plain <script> tag (MagicMirror) and CommonJS (tests).
    global.StreamKeeper = StreamKeeper;
    if (typeof module !== "undefined" && module.exports) {
        module.exports = { StreamKeeper: StreamKeeper, hashPixels: hashPixels };
    }
})(typeof window !== "undefined" ? window : globalThis);
