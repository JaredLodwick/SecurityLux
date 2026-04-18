/* Door Cam viewer — vanilla JS client.
 *
 * Polls GET /status every 3s, renders the MJPEG stream when state is "on",
 * and posts to /toggle when the user clicks the big button.
 *
 * Backend URL resolution order:
 *   1. window.DOORCAM_BACKEND_URL (set on the page before app.js loads)
 *   2. BACKEND_URL constant below (default "" = same origin / relative URLs)
 *
 * To point at a remote Pi during dev, either:
 *   - Set window.DOORCAM_BACKEND_URL = "http://doorcam.local:5000" before this script,
 *   - Or edit BACKEND_URL below to e.g. "http://doorcam.local:5000".
 */

(function () {
  "use strict";

  // ---- Config ------------------------------------------------------------
  const BACKEND_URL = ""; // empty = same origin
  const POLL_INTERVAL_MS = 3000;
  const STALE_THRESHOLD_MS = 5000;
  const FAILURE_THRESHOLD_FOR_ERR = 2;

  const backend =
    typeof window !== "undefined" &&
    typeof window.DOORCAM_BACKEND_URL === "string"
      ? window.DOORCAM_BACKEND_URL
      : BACKEND_URL;

  function url(path) {
    if (!backend) return path;
    return backend.replace(/\/+$/, "") + path;
  }

  // ---- DOM refs ----------------------------------------------------------
  const els = {
    videoFrame: document.getElementById("video-frame"),
    toggleBtn: document.getElementById("toggle-btn"),
    statusState: document.getElementById("status-state"),
    statusFps: document.getElementById("status-fps"),
    statusResolution: document.getElementById("status-resolution"),
    statusUptime: document.getElementById("status-uptime"),
    statusBattery: document.getElementById("status-battery"),
    statusCameraDot: document.getElementById("status-camera-dot"),
    statusCameraText: document.getElementById("status-camera-text"),
    connIndicator: document.getElementById("connection-indicator"),
    toast: document.getElementById("toast"),
  };

  // ---- In-memory state (no localStorage / cookies) -----------------------
  const ui = {
    cameraState: null, // "on" | "off" | null
    consecutiveFailures: 0,
    lastPollOkAt: 0, // performance.now() millis
    pollTimer: null, // recursive setTimeout handle (chosen over setInterval
    // so we never stack overlapping polls if a request runs slow)
    inFlightStatus: null, // AbortController for the active /status call
    inFlightToggle: false,
    toastTimer: null,
    paused: false,
  };

  // ---- Helpers -----------------------------------------------------------
  function formatUptime(seconds) {
    if (typeof seconds !== "number" || !isFinite(seconds) || seconds < 0) {
      return "—";
    }
    const s = Math.floor(seconds);
    const days = Math.floor(s / 86400);
    const hours = Math.floor((s % 86400) / 3600);
    const minutes = Math.floor((s % 3600) / 60);
    const secs = s % 60;
    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${minutes}m`;
    if (minutes > 0) return `${minutes}m ${secs}s`;
    return `${secs}s`;
  }

  function showToast(message, durationMs = 3500) {
    els.toast.textContent = message;
    els.toast.hidden = false;
    if (ui.toastTimer) clearTimeout(ui.toastTimer);
    ui.toastTimer = setTimeout(() => {
      els.toast.hidden = true;
    }, durationMs);
  }

  // ---- Connection indicator ---------------------------------------------
  function updateConnectionIndicator() {
    const node = els.connIndicator;
    node.classList.remove("conn-ok", "conn-stale", "conn-err", "conn-unknown");

    if (ui.consecutiveFailures >= FAILURE_THRESHOLD_FOR_ERR) {
      node.classList.add("conn-err");
      node.querySelector(".conn-label").textContent = "Disconnected";
      node.setAttribute("aria-label", "Connection status: disconnected");
      node.title = `Last ${ui.consecutiveFailures} status polls failed.`;
      return;
    }

    if (ui.lastPollOkAt === 0) {
      node.classList.add("conn-unknown");
      node.querySelector(".conn-label").textContent = "Checking…";
      node.setAttribute("aria-label", "Connection status: checking");
      node.title = "Initial status poll in progress.";
      return;
    }

    const ageMs = performance.now() - ui.lastPollOkAt;
    if (ageMs > STALE_THRESHOLD_MS) {
      node.classList.add("conn-stale");
      node.querySelector(".conn-label").textContent = "Stale";
      node.setAttribute("aria-label", "Connection status: stale");
      node.title = `Last successful status poll was ${Math.round(
        ageMs / 1000
      )}s ago.`;
    } else {
      node.classList.add("conn-ok");
      node.querySelector(".conn-label").textContent = "Connected";
      node.setAttribute("aria-label", "Connection status: connected");
      node.title = `Last status poll succeeded ${Math.round(
        ageMs / 1000
      )}s ago.`;
    }
  }

  // ---- Video area --------------------------------------------------------
  function renderStreamImg() {
    const img = document.createElement("img");
    img.className = "stream";
    img.alt = "Live door camera feed";
    img.src = url(`/stream.mjpg?t=${Date.now()}`); // cache-buster
    img.addEventListener("error", () => {
      // The browser will fire 'error' if the multipart stream is broken or 503.
      // Don't replace the placeholder eagerly — the next /status poll will tell
      // us authoritatively whether the camera is on.
      console.warn("Stream <img> reported an error.");
    });
    return img;
  }

  function renderPlaceholder() {
    const wrap = document.createElement("div");
    wrap.className = "video-placeholder";
    wrap.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
           stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"
           aria-hidden="true" focusable="false">
        <path d="M3 3l18 18" />
        <path d="M21 8.5v7a1 1 0 0 1-1.55.83L15 13.5V8.5l4.45-2.83A1 1 0 0 1 21 6.5z" />
        <path d="M15 7H6a3 3 0 0 0-3 3v6a3 3 0 0 0 .88 2.12" />
        <path d="M7 18h6a3 3 0 0 0 3-3v-2" />
      </svg>
      <div class="placeholder-text">Camera is off</div>
    `;
    return wrap;
  }

  function renderUnreachable() {
    const wrap = document.createElement("div");
    wrap.className = "video-error";
    const msg = document.createElement("div");
    const target = backend || "this server";
    msg.textContent = `Cannot reach camera at ${target}`;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "retry-btn";
    btn.textContent = "Retry";
    btn.addEventListener("click", () => {
      // Clear any pending timer and fire one now.
      stopPolling();
      void fetchStatus(true);
      startPolling();
    });
    wrap.appendChild(msg);
    wrap.appendChild(btn);
    return wrap;
  }

  function clearVideoFrame() {
    while (els.videoFrame.firstChild) {
      els.videoFrame.removeChild(els.videoFrame.firstChild);
    }
  }

  // Mount the right child for the given camera state.
  // Only swaps DOM nodes when needed to avoid re-fetching the MJPEG stream
  // on every /status poll (which would tear down and rebuild the connection).
  function setCameraState(newState) {
    if (newState === ui.cameraState) return;

    if (newState === "on") {
      clearVideoFrame();
      els.videoFrame.appendChild(renderStreamImg());
    } else if (newState === "off") {
      clearVideoFrame();
      els.videoFrame.appendChild(renderPlaceholder());
    } else {
      // unreachable / unknown
      clearVideoFrame();
      els.videoFrame.appendChild(renderUnreachable());
    }
    ui.cameraState = newState;
    renderToggleButton();
  }

  function renderToggleButton() {
    if (ui.cameraState === "on") {
      els.toggleBtn.textContent = "Turn feed OFF";
      els.toggleBtn.disabled = ui.inFlightToggle;
    } else if (ui.cameraState === "off") {
      els.toggleBtn.textContent = "Turn feed ON";
      els.toggleBtn.disabled = ui.inFlightToggle;
    } else {
      els.toggleBtn.textContent = "Unavailable";
      els.toggleBtn.disabled = true;
    }
  }

  // ---- Status rendering --------------------------------------------------
  function renderStatus(data) {
    els.statusState.textContent = data.state ? data.state.toUpperCase() : "—";

    els.statusFps.textContent =
      typeof data.fps === "number" ? `${data.fps} fps` : "—";

    els.statusResolution.textContent = data.resolution
      ? String(data.resolution).replace("x", "\u00d7") // pretty × character
      : "—";

    els.statusUptime.textContent = formatUptime(data.uptime_seconds);

    // Battery: show pct + ⚡ when charging (i.e. NOT on battery), "—" if null.
    if (
      typeof data.battery_pct === "number" &&
      isFinite(data.battery_pct)
    ) {
      const pct = Math.round(data.battery_pct);
      const charging = data.on_battery === false;
      els.statusBattery.textContent = charging ? `${pct}%  \u26a1` : `${pct}%`;
    } else {
      els.statusBattery.textContent = "—";
    }

    // Camera availability
    const dot = els.statusCameraDot;
    dot.classList.remove("cam-ok", "cam-err", "cam-unknown");
    if (data.camera_available === true) {
      dot.classList.add("cam-ok");
      els.statusCameraText.textContent = "Available";
    } else if (data.camera_available === false) {
      dot.classList.add("cam-err");
      els.statusCameraText.textContent = "Unavailable";
    } else {
      dot.classList.add("cam-unknown");
      els.statusCameraText.textContent = "Unknown";
    }

    // Camera state mounting (on/off swap)
    if (data.state === "on" || data.state === "off") {
      setCameraState(data.state);
    }
  }

  // ---- Network -----------------------------------------------------------
  async function fetchStatus(manual = false) {
    if (ui.inFlightStatus) {
      // Cancel a previous slow request so we don't pile up.
      ui.inFlightStatus.abort();
    }
    const ctrl = new AbortController();
    ui.inFlightStatus = ctrl;
    try {
      const res = await fetch(url("/status"), {
        method: "GET",
        signal: ctrl.signal,
        cache: "no-store",
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const data = await res.json();
      ui.consecutiveFailures = 0;
      ui.lastPollOkAt = performance.now();
      renderStatus(data);
      updateConnectionIndicator();
    } catch (err) {
      if (err && err.name === "AbortError") {
        return; // silently ignored, we cancelled it ourselves
      }
      ui.consecutiveFailures += 1;
      console.warn("Status poll failed:", err && err.message ? err.message : err);
      updateConnectionIndicator();
      // If we've never seen a successful poll, show the "cannot reach" panel
      // immediately so the user has a Retry affordance. After we've been
      // connected at least once, require two failures so a transient blip
      // doesn't yank the video out from under the user.
      const requireFailureCount =
        ui.lastPollOkAt === 0 ? 1 : FAILURE_THRESHOLD_FOR_ERR;
      if (ui.consecutiveFailures >= requireFailureCount) {
        setCameraState(null);
      }
      if (manual) {
        showToast("Could not reach the camera.");
      }
    } finally {
      if (ui.inFlightStatus === ctrl) {
        ui.inFlightStatus = null;
      }
    }
  }

  async function onToggleClick() {
    if (ui.inFlightToggle) return;
    ui.inFlightToggle = true;
    renderToggleButton();
    try {
      const res = await fetch(url("/toggle"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // No body = backend flips state.
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const data = await res.json();
      if (data && (data.state === "on" || data.state === "off")) {
        setCameraState(data.state);
        // Update visible state tile right away; the next poll will refresh
        // FPS / battery / etc.
        els.statusState.textContent = data.state.toUpperCase();
      }
    } catch (err) {
      console.error("Toggle failed:", err);
      showToast("Toggle failed — please try again.");
    } finally {
      ui.inFlightToggle = false;
      renderToggleButton();
    }
  }

  // ---- Polling lifecycle -------------------------------------------------
  // Recursive setTimeout (rather than setInterval) so a slow /status response
  // doesn't queue up a backlog of overlapping polls.
  function scheduleNextPoll() {
    if (ui.paused) return;
    if (ui.pollTimer) clearTimeout(ui.pollTimer);
    ui.pollTimer = setTimeout(async () => {
      await fetchStatus();
      // Refresh the indicator even when nothing new happens (so "stale" can
      // appear without needing a full failure).
      updateConnectionIndicator();
      scheduleNextPoll();
    }, POLL_INTERVAL_MS);
  }

  function startPolling() {
    ui.paused = false;
    scheduleNextPoll();
  }

  function stopPolling() {
    ui.paused = true;
    if (ui.pollTimer) {
      clearTimeout(ui.pollTimer);
      ui.pollTimer = null;
    }
    if (ui.inFlightStatus) {
      ui.inFlightStatus.abort();
    }
  }

  function onVisibilityChange() {
    if (document.hidden) {
      stopPolling();
    } else {
      // Immediate refresh when coming back into view, then resume cadence.
      void fetchStatus();
      startPolling();
    }
  }

  // ---- Boot --------------------------------------------------------------
  function init() {
    els.toggleBtn.addEventListener("click", onToggleClick);
    document.addEventListener("visibilitychange", onVisibilityChange);

    // Initial render: indicator + immediate first poll, then start cadence.
    updateConnectionIndicator();
    void fetchStatus().then(() => {
      // After the first response (or failure), kick off the periodic poll.
      startPolling();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
