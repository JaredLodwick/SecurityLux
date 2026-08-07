/**
 * Live camera view.
 *
 * Camera cards and their StreamKeepers are cached by cam_id and re-parented
 * between layouts rather than rebuilt. That matters more than it looks: each
 * MJPEG stream holds one of the browser's ~6 connections-per-origin, so
 * recreating an <img> on every poll would leak connection slots until no
 * stream could start at all. Building once and moving the node keeps exactly
 * one connection per visible camera.
 */

(function (global) {
    "use strict";

    const SL = global.SL;
    const { el, clear, api, toast, confirmAction, formatRelative } = SL;

    const cards = new Map();      // camId -> { root, keeper, refs }

    /** Latest /cams payload, so StreamKeeper can distinguish dead link vs dead camera. */
    let statusByCam = new Map();

    function statusProviderFor(camId) {
        return () => statusByCam.get(camId) || null;
    }

    // ---------------------------------------------------------------
    //  Card construction
    // ---------------------------------------------------------------

    function buildCard(cam) {
        const refs = {};

        const keeper = new global.StreamKeeper({
            streamUrl: () => `/cam/${encodeURIComponent(cam.cam_id)}/stream.mjpg`,
            statusProvider: statusProviderFor(cam.cam_id),
            alt: `${cam.name || cam.cam_id} live feed`,
            onStateChange: (state) => {
                if (refs.liveBadge) {
                    refs.liveBadge.textContent = state === "live" ? "LIVE" : state.toUpperCase();
                    refs.liveBadge.dataset.kind = state === "live" ? "live" : "alert";
                }
            },
            logger: console
        });

        refs.liveBadge = el("span.badge", { dataset: { kind: "live" }, text: "LIVE" });
        refs.detectBadge = el("span.badge", { dataset: { kind: "alert" }, text: "" });
        refs.detectBadge.style.display = "none";

        refs.badges = el("div.cam-badges", [refs.liveBadge, refs.detectBadge]);
        refs.bboxLayer = el("div.bbox-layer");
        refs.placeholder = el("div.placeholder", { text: "Connecting…" });

        refs.frame = el("div.cam-frame", [keeper.element, refs.badges, refs.bboxLayer]);

        // Gear in the corner of the feed. Lives on the frame rather than in a
        // page header so the controls open *over the live picture* — you have
        // to be able to watch what you're adjusting.
        if (SL.controls) SL.controls.attachButton(refs.frame, cam.cam_id);

        refs.dot = el("span.state-dot");
        refs.nameText = el("span", { text: cam.name || cam.cam_id });
        refs.detectionToggle = buildDetectionToggle(cam);
        refs.header = el("div.cam-card-header", [
            el("span.cam-name", [refs.dot, refs.nameText]),
            refs.detectionToggle
        ]);

        refs.footer = el("div.cam-footer");

        const root = el("div.cam-card", { dataset: { camId: cam.cam_id } },
            [refs.header, refs.frame, refs.footer]);

        return { root, keeper, refs };
    }

    function buildDetectionToggle(cam) {
        const pip = el("span.toggle-pip");
        const btn = el("button.pill", {
            type: "button",
            title: "Run person detection on this camera",
            dataset: { on: String(cam.detection_enabled !== false) }
        }, [pip, el("span", { text: "Detect" })]);

        btn.addEventListener("click", async (ev) => {
            ev.stopPropagation();     // don't also navigate into the detail view
            const want = btn.dataset.on !== "true";
            btn.dataset.on = String(want);      // optimistic
            btn.disabled = true;
            try {
                await api.post(`/cam/${encodeURIComponent(cam.cam_id)}/detection`, { enabled: want });
            } catch (err) {
                btn.dataset.on = String(!want);
                toast(`Could not change detection: ${err.message}`, "error");
            } finally {
                btn.disabled = false;
            }
        });
        return btn;
    }

    function ensureCard(cam) {
        let entry = cards.get(cam.cam_id);
        if (!entry) {
            entry = buildCard(cam);
            cards.set(cam.cam_id, entry);
        }
        updateCard(entry, cam);
        return entry;
    }

    // ---------------------------------------------------------------
    //  Per-poll updates
    // ---------------------------------------------------------------

    function updateCard(entry, cam) {
        const { refs, keeper } = entry;

        refs.dot.dataset.state = !cam.connected ? "offline" : (cam.state === "on" ? "on" : "off");
        refs.nameText.textContent = cam.name || cam.cam_id;
        refs.detectionToggle.dataset.on = String(cam.detection_enabled !== false);

        const shouldStream = !!(cam.connected && cam.state === "on");
        keeper.setActive(shouldStream);

        if (!shouldStream) {
            refs.placeholder.textContent = !cam.connected ? "camera offline" : "camera off";
            if (!refs.placeholder.isConnected) refs.frame.appendChild(refs.placeholder);
            refs.liveBadge.style.display = "none";
        } else {
            if (refs.placeholder.isConnected) refs.placeholder.remove();
            refs.liveBadge.style.display = "";
        }

        renderDetection(refs, cam);
        renderFooter(refs, cam);
    }

    function renderDetection(refs, cam) {
        const detection = cam.current_detection;
        clear(refs.bboxLayer);

        if (!detection) {
            refs.detectBadge.style.display = "none";
            return;
        }

        const label = detection.count > 1
            ? `${detection.count} people`
            : SL.capitalize(cam.behavior && cam.behavior !== "idle" ? cam.behavior : "person");
        refs.detectBadge.textContent = label;
        refs.detectBadge.style.display = "";

        const box = detection.bbox;
        if (!box) return;
        const left = Math.max(0, box.cx - box.w / 2) * 100;
        const top = Math.max(0, box.cy - box.h / 2) * 100;
        const conf = Math.round((detection.confidence || 0) * 100);

        refs.bboxLayer.appendChild(el("div.bbox", {
            style: {
                left: `${left}%`,
                top: `${top}%`,
                width: `${Math.min(100 - left, box.w * 100)}%`,
                height: `${Math.min(100 - top, box.h * 100)}%`
            }
        }, [el("span.bbox-label", { text: conf ? `person ${conf}%` : "person" })]));
    }

    function renderFooter(refs, cam) {
        clear(refs.footer);
        const bits = [];

        if (typeof cam.battery_pct === "number") {
            bits.push(`${Math.round(cam.battery_pct)}%${cam.on_battery === false ? " ⚡" : ""}`);
        }
        if (cam.resolution) bits.push(cam.resolution);
        if (cam.fps) bits.push(`${cam.fps} fps`);
        if (cam.led_available) bits.push("light ✓");
        if (cam.recording_paused) bits.push("recording paused");

        refs.footer.appendChild(el("span", { text: bits.join(" · ") || "—" }));
        refs.footer.appendChild(el("span.spacer"));

        if (cam.connected) {
            refs.footer.appendChild(el("button.btn.btn-icon", {
                title: cam.state === "on" ? "Turn the camera off" : "Turn the camera on",
                text: cam.state === "on" ? "Turn off" : "Turn on",
                onclick: async (ev) => {
                    ev.stopPropagation();
                    try {
                        await api.post(`/cam/${encodeURIComponent(cam.cam_id)}/toggle`);
                    } catch (err) {
                        toast(`Toggle failed: ${err.message}`, "error");
                    }
                }
            }));
        }
    }

    // ---------------------------------------------------------------
    //  Layouts
    // ---------------------------------------------------------------

    function render(container, cams, selectedCamId, onSelect) {
        statusByCam = new Map(cams.map((c) => [c.cam_id, c]));

        // Cameras that vanished from /cams have their streams torn down, or
        // they'd keep holding a connection slot invisibly.
        for (const [camId, entry] of cards) {
            if (!statusByCam.has(camId)) {
                if (SL.controls) SL.controls.close(camId);
                entry.keeper.destroy();
                cards.delete(camId);
            }
        }

        if (!cams.length) {
            clear(container).appendChild(el("div.empty", {
                html: "No cameras have ever connected to this hub.<br>" +
                      "Set one up — see <code>camera_node/README.md</code>."
            }));
            return;
        }

        if (cams.length === 1) return renderSingle(container, cams[0]);
        if (selectedCamId && statusByCam.has(selectedCamId)) {
            return renderDetail(container, cams, selectedCamId, onSelect);
        }
        return renderGrid(container, cams, onSelect);
    }

    function renderSingle(container, cam) {
        const entry = ensureCard(cam);
        entry.root.onclick = null;
        clear(container).appendChild(entry.root);
    }

    function renderGrid(container, cams, onSelect) {
        const grid = el("div.grid-layout");
        for (const cam of cams) {
            const entry = ensureCard(cam);
            entry.root.onclick = () => onSelect(cam.cam_id);
            entry.root.style.cursor = "pointer";
            grid.appendChild(entry.root);
        }
        clear(container).appendChild(grid);
    }

    function renderDetail(container, cams, selectedCamId, onSelect) {
        const layout = el("div.detail-layout");
        const rail = el("div.detail-rail");

        for (const cam of cams) {
            if (cam.cam_id === selectedCamId) continue;
            const entry = ensureCard(cam);
            entry.root.onclick = () => onSelect(cam.cam_id);
            entry.root.style.cursor = "pointer";
            rail.appendChild(entry.root);
        }
        if (rail.children.length) layout.appendChild(rail);

        const selected = cams.find((c) => c.cam_id === selectedCamId);
        const main = ensureCard(selected);
        main.root.onclick = null;
        main.root.style.cursor = "";
        layout.appendChild(el("div.detail-main", [main.root]));

        clear(container).appendChild(layout);
    }

    // ---------------------------------------------------------------
    //  Camera actions (used by the per-camera page header)
    // ---------------------------------------------------------------

    async function restartCamera(camId) {
        const ok = await confirmAction(
            "Restart camera service?",
            `The publisher on "${camId}" will exit and systemd will bring it straight back. ` +
            "The feed drops for a couple of seconds. This fixes most camera problems " +
            "without waiting for a full boot.",
            "Restart service"
        );
        if (!ok) return;
        try {
            await api.post(`/cam/${encodeURIComponent(camId)}/restart`);
            toast(`Restarting ${camId}…`, "ok");
        } catch (err) {
            toast(`Restart failed: ${err.message}`, "error");
        }
    }

    async function rebootCamera(camId) {
        const ok = await confirmAction(
            "Reboot the Pi?",
            `This reboots the whole Raspberry Pi running "${camId}". It will be offline ` +
            "for around a minute. Try 'Restart service' first — it fixes most problems " +
            "in two seconds instead.",
            "Reboot Pi"
        );
        if (!ok) return;
        try {
            await api.post(`/cam/${encodeURIComponent(camId)}/reboot`);
            toast(`Rebooting ${camId}…`, "ok");
        } catch (err) {
            toast(`Reboot failed: ${err.message}`, "error");
        }
    }

    async function testLed(camId) {
        try {
            await api.post(`/cam/${encodeURIComponent(camId)}/led/test`, { stage: 3 });
            toast("Door light test sent — watch the strip for ~6 seconds.", "ok");
        } catch (err) {
            toast(err.message, "error");
        }
    }

    /** Diagnostics for the detail header: how flaky has this stream been? */
    function streamStats(camId) {
        const entry = cards.get(camId);
        return entry ? entry.keeper.stats() : null;
    }

    function destroyAll() {
        if (SL.controls) SL.controls.closeAll();
        for (const entry of cards.values()) entry.keeper.destroy();
        cards.clear();
    }

    SL.cameras = {
        render, restartCamera, rebootCamera, testLed, streamStats, destroyAll, formatRelative
    };
})(window);
