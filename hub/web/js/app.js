/**
 * Dashboard shell: routing, the poll loop, and view dispatch.
 *
 * Routes are hash-based so deep links and the browser back button work without
 * any server-side routing:
 *
 *   #/live            all cameras
 *   #/live/<camId>    one camera, with its controls, zones, and settings
 *   #/events          the event log
 *   #/profiles        people
 *   #/settings        hub-wide settings
 *   #/storage         disk usage and retention limits
 *
 * The poll loop refreshes status and events. It deliberately does *not* rebuild
 * camera cards — those are cached in cameras.js and only mutated in place, so a
 * refresh never disturbs a live MJPEG connection.
 */

(function (global) {
    "use strict";

    const SL = global.SL;
    const { el, clear, api, toast } = SL;

    const STATUS_POLL_MS = 2000;      // cheap: /cams is a small JSON payload
    const EVENTS_POLL_MS = 15_000;    // events change slowly

    const dom = {};
    const state = {
        cams: [],
        events: [],
        detection: null,
        storage: null,
        lastEventsFetch: 0,
        statusTimer: null,
        booted: false
    };

    // ---------------------------------------------------------------
    //  Routing
    // ---------------------------------------------------------------

    function currentRoute() {
        const hash = (global.location.hash || "").replace(/^#\/?/, "");
        const [section, ...rest] = hash.split("/").filter(Boolean);
        return {
            section: section || "live",
            param: rest.length ? decodeURIComponent(rest.join("/")) : null
        };
    }

    function navigate(path) {
        global.location.hash = `#/${path}`;
    }

    // ---------------------------------------------------------------
    //  Data
    // ---------------------------------------------------------------

    async function fetchStatus() {
        const [cams, detection] = await Promise.all([
            api.get("/cams"),
            api.get("/detection").catch(() => null)
        ]);
        state.cams = cams || [];
        state.detection = detection;
    }

    async function fetchEvents(force) {
        const route = currentRoute();
        const needsEvents = route.section === "live" || route.section === "events";
        if (!needsEvents) return;
        if (!force && Date.now() - state.lastEventsFetch < EVENTS_POLL_MS) return;
        // Never tear down a clip the user is watching.
        if (!force && SL.events.isPlaying()) return;

        const camScope = route.section === "live" && route.param ? route.param : null;
        try {
            state.events = await SL.events.load(camScope);
            state.lastEventsFetch = Date.now();
        } catch (err) {
            if (err.status !== 503) throw err;
            state.events = [];
        }
    }

    // ---------------------------------------------------------------
    //  Poll loop
    // ---------------------------------------------------------------

    async function tick() {
        try {
            await fetchStatus();
            await fetchEvents(false);
            setSystemStatus("ok");
            renderCurrentView();
        } catch (err) {
            setSystemStatus("error");
            if (!state.booted) {
                clear(dom.view).appendChild(el("div.empty", {
                    text: `Can't reach the hub: ${err.message}`
                }));
            }
        } finally {
            state.booted = true;
            schedule();
        }
    }

    function schedule() {
        if (state.statusTimer) clearTimeout(state.statusTimer);
        state.statusTimer = setTimeout(tick, STATUS_POLL_MS);
    }

    /** Force an immediate refresh — used after any mutation. */
    async function refresh() {
        try {
            await fetchStatus();
            await fetchEvents(true);
            renderCurrentView();
        } catch (err) {
            toast(err.message, "error");
        }
    }

    function setSystemStatus(status) {
        dom.systemStatus.dataset.state = status;
    }

    // ---------------------------------------------------------------
    //  Banners
    // ---------------------------------------------------------------

    function renderBanners() {
        clear(dom.banners);
        const detection = state.detection;
        if (!detection) return;

        if (detection.clock_ok === false) {
            dom.banners.appendChild(el("div.banner", [
                el("div.banner-title", { text: "The hub's clock is wrong" }),
                el("div", {
                    text: "The system time is before 2024, which means NTP hasn't synced since " +
                          "boot. Events are not being recorded, because they would be timestamped " +
                          "in the past and effectively unfindable. Check the hub's network and " +
                          "time settings."
                })
            ]));
        }

        if (detection.recording_paused) {
            dom.banners.appendChild(el("div.banner", { dataset: { kind: "warn" } }, [
                el("div.banner-title", { text: "Recording paused — low disk space" }),
                el("div", { text: detection.paused_reason || "" }),
                el("div.small", { style: { marginTop: "6px" } }, [
                    "Events are still being logged. ",
                    el("a", {
                        href: "#/storage", text: "Open storage settings",
                        style: { color: "var(--accent)" }
                    })
                ])
            ]));
        }

        if (detection.error) {
            dom.banners.appendChild(el("div.banner", [
                el("div.banner-title", { text: "Detection isn't running on this hub" }),
                el("div", { text: detection.error }),
                el("div.small.muted", {
                    style: { marginTop: "6px" },
                    html: "Most common cause: a native module (<code>better-sqlite3</code>, " +
                          "<code>onnxruntime-node</code>, <code>sharp</code>) wasn't built against " +
                          "the Node version the hub runs under. Re-run <code>./hub/install.sh</code> " +
                          "with the same Node, then restart the hub."
                })
            ]));
        }
    }

    // ---------------------------------------------------------------
    //  Views
    // ---------------------------------------------------------------

    function renderCurrentView() {
        const route = currentRoute();
        updateNav(route.section);
        renderBanners();

        switch (route.section) {
            case "events": return renderEventsView();
            case "profiles": return renderProfilesView();
            case "settings": return renderSettingsView();
            case "storage": return renderStorageView();
            case "live":
            default: return renderLiveView(route.param);
        }
    }

    function updateNav(section) {
        for (const link of dom.nav.querySelectorAll("a")) {
            const target = link.getAttribute("href").replace(/^#\//, "").split("/")[0];
            if (target === section) link.setAttribute("aria-current", "page");
            else link.removeAttribute("aria-current");
        }
    }

    /** Views other than Live are rebuilt on demand, not on every poll. */
    let mountedSection = null;

    function renderLiveView(camId) {
        if (mountedSection !== "live") {
            mountedSection = "live";
            clear(dom.view);
            dom.liveHeader = el("div#live-header");
            dom.liveCameras = el("div#live-cameras");
            dom.liveEvents = el("div#live-events", { style: { marginTop: "26px" } });
            dom.view.append(dom.liveHeader, dom.liveCameras, dom.liveEvents);
        }

        const selected = SL.resolveSelectedCam(camId, state.cams);
        renderLiveHeader(selected);
        SL.cameras.render(dom.liveCameras, state.cams, selected, (id) => navigate(`live/${encodeURIComponent(id)}`));

        clear(dom.liveEvents);
        if (state.cams.length) {
            dom.liveEvents.appendChild(el("div.page-header", [
                el("div.page-header-left", [
                    el("h2", { text: selected ? "Recent events" : "Recent events across all cameras" })
                ]),
                el("div.page-header-actions", [
                    el("a.btn", { href: "#/events", text: "View all" })
                ])
            ]));
            const list = el("div");
            dom.liveEvents.appendChild(list);
            SL.events.render(list, state.events.slice(0, 15), state.cams);
        }
    }

    function renderLiveHeader(selected) {
        clear(dom.liveHeader);
        if (!state.cams.length) return;

        const cam = selected ? state.cams.find((c) => c.cam_id === selected) : null;
        const left = el("div.page-header-left");

        if (cam) {
            // No back arrow with a single camera — there is no grid behind it,
            // so the button would lead straight back to the same screen.
            if (state.cams.length > 1) {
                left.appendChild(el("button.btn.btn-icon", {
                    title: "Back to all cameras", text: "←",
                    onclick: () => navigate("live")
                }));
            }
            left.appendChild(el("h2", [
                el("span.state-dot", {
                    dataset: { state: !cam.connected ? "offline" : (cam.state === "on" ? "on" : "off") }
                }),
                cam.name || cam.cam_id
            ]));
            const bits = [];
            if (cam.session_active) bits.push("recording");
            if (cam.behavior && cam.behavior !== "idle") bits.push(cam.behavior);
            if (cam.uptime_s) bits.push(`up ${SL.formatDuration(cam.uptime_s * 1000)}`);
            if (cam.reconnects > 1) bits.push(`${cam.reconnects} connections`);
            if (bits.length) left.appendChild(el("span.small.muted", { text: bits.join(" · ") }));
        } else {
            left.appendChild(el("h2", { text: "Cameras" }));
        }

        const actions = el("div.page-header-actions");
        if (cam) {
            // No "Adjust image" button here — those controls live on the feed
            // itself, behind the gear in its corner, so the picture stays
            // visible while you tune it.
            actions.appendChild(el("button.btn", {
                text: "Zones",
                title: "Draw and name the regions this camera can see",
                onclick: async () => {
                    if (await SL.zones.open(cam.cam_id)) refresh();
                }
            }));
            actions.appendChild(el("button.btn", {
                text: "Camera settings",
                onclick: () => openCameraSettings(cam)
            }));
            actions.appendChild(el("button.btn", {
                text: "Test light",
                title: "Flash the door light so you can check the wiring",
                onclick: () => SL.cameras.testLed(cam.cam_id)
            }));
            actions.appendChild(el("button.btn", {
                text: "Restart",
                title: "Restart the camera's publisher service (fast)",
                disabled: !cam.connected,
                onclick: () => SL.cameras.restartCamera(cam.cam_id)
            }));
            actions.appendChild(el("button.btn", {
                "data-variant": "danger",
                text: "Reboot",
                title: "Reboot the whole Raspberry Pi (slow)",
                disabled: !cam.connected,
                onclick: () => SL.cameras.rebootCamera(cam.cam_id)
            }));
        }

        dom.liveHeader.appendChild(el("div.page-header", [left, actions]));
    }

    async function openCameraSettings(cam) {
        await SL.modal(`${cam.name || cam.cam_id} — settings`, (close) => {
            const host = el("div", [el("div.empty.small", { text: "Loading…" })]);
            SL.settings.renderCameraSettings(host, cam.cam_id, () => { /* saved per-field */ })
                .catch((err) => {
                    clear(host).appendChild(el("div.empty", { text: err.message }));
                });
            return el("div", [
                el("p.small.muted", {
                    text: "These override the hub-wide defaults for this camera only. " +
                          "Leave a value alone to keep inheriting it."
                }),
                host,
                el("div.modal-actions", [
                    el("button.btn", { "data-variant": "primary", text: "Done", onclick: () => close(true) })
                ])
            ]);
        });
        refresh();
    }

    function renderEventsView() {
        if (mountedSection !== "events") {
            mountedSection = "events";
            clear(dom.view);
            dom.eventsFilters = el("div#events-filters");
            dom.eventsList = el("div#events-list");
            dom.view.append(
                el("div.page-header", [
                    el("div.page-header-left", [el("h2", { text: "Events" })])
                ]),
                dom.eventsFilters,
                dom.eventsList
            );
        }
        clear(dom.eventsFilters).appendChild(
            SL.events.renderFilters(state.cams, () => refresh())
        );
        SL.events.render(dom.eventsList, state.events, state.cams);
    }

    function renderProfilesView() {
        if (mountedSection === "profiles") return;
        mountedSection = "profiles";
        clear(dom.view);
        SL.profiles.render(dom.view).catch((err) => {
            clear(dom.view).appendChild(el("div.empty", { text: err.message }));
        });
    }

    function renderSettingsView() {
        if (mountedSection === "settings") return;
        mountedSection = "settings";
        clear(dom.view);
        SL.settings.renderSettingsPage(dom.view, () => {
            mountedSection = null;
            renderCurrentView();
        }).catch((err) => {
            clear(dom.view).appendChild(el("div.empty", { text: err.message }));
        });
    }

    function renderStorageView() {
        if (mountedSection === "storage") return;
        mountedSection = "storage";
        clear(dom.view);
        SL.settings.renderStoragePage(dom.view, () => {
            mountedSection = null;
            renderCurrentView();
        }).catch((err) => {
            clear(dom.view).appendChild(el("div.empty", { text: err.message }));
        });
    }

    // ---------------------------------------------------------------
    //  Boot
    // ---------------------------------------------------------------

    function boot() {
        dom.banners = document.getElementById("banners");
        dom.view = document.getElementById("view");
        dom.nav = document.getElementById("tabs");
        dom.systemStatus = document.getElementById("system-status");

        global.addEventListener("hashchange", () => {
            // A card is re-parented on navigation; an open panel would ride
            // along into the side rail where it doesn't fit.
            if (SL.controls) SL.controls.closeAll();
            mountedSection = null;     // force a rebuild when the section changes
            renderCurrentView();
            fetchEvents(true).then(renderCurrentView).catch(() => { /* surfaced by the poll */ });
        });

        // Pause polling while the tab is hidden — no point burning the hub's
        // CPU rendering a dashboard nobody is looking at. StreamKeeper handles
        // reconnecting the video independently.
        document.addEventListener("visibilitychange", () => {
            if (document.hidden) {
                if (state.statusTimer) clearTimeout(state.statusTimer);
                state.statusTimer = null;
            } else {
                tick();
            }
        });

        tick();
    }

    SL.app = { boot, refresh, navigate, state };

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", boot);
    } else {
        boot();
    }
})(window);
