/**
 * Timeline — scrub back through continuously recorded footage.
 *
 * Lives inline on the Live page now, below the feed(s) it belongs to, rather
 * than as its own route. Two mounting modes share the module:
 *
 *   - `renderDashboard`  All cameras at once, below the live grid. It merges
 *     every camera's coverage and events onto one axis so you can see "when
 *     did anything happen" at a glance. It never plays video itself — click a
 *     moment or an event and it hands you off into that camera's own detail
 *     view, seeked to the right instant. Read-only: no drag-select, no save.
 *
 *   - `renderDetail`      One camera, below its own feed, once you've clicked
 *     into it. This is the full scrubber: click-to-seek, drag-to-select a
 *     range, a player, and the save/protect controls. It's what the old
 *     dedicated `#/timeline` page used to be, minus the camera picker — the
 *     camera is already fixed by which card you clicked.
 *
 * ============================================================================
 *  Gaps are drawn, not hidden
 * ============================================================================
 *
 * The bar shows coverage as filled runs against an empty track, so a camera
 * that was down for three hours leaves a visible hole. That distinction matters
 * more than it might seem: "there is no footage here" and "nothing happened
 * here" look identical if you only draw the footage, and only one of them means
 * your security camera was working.
 *
 * Seeking is arithmetic, not search — the recorder writes at a fixed frame rate
 * and resets timestamps per segment, so an instant maps to (file, offset)
 * directly. See hub/src/timeline.js.
 *
 * ============================================================================
 *  The playback clock is a real clock, not a ticking one
 * ============================================================================
 *
 * Both modes show a clock tied to what's actually on screen: the live grid's
 * cards read theirs from the hub's last-received-frame time (cameras.js), and
 * here the recorded-clip clock is driven by the <video>'s own `timeupdate`,
 * which only fires while the video is actually advancing. Pause, buffer, or
 * hit a decode error and the clock holds exactly where it was — it never
 * free-runs off `Date.now()`, which is what would make a stalled player look
 * like a live one.
 */

(function (global) {
    "use strict";

    const SL = global.SL;
    const {
        el, clear, api, toast, confirmAction, formatBytes, formatDuration, formatClock
    } = SL;

    const HOUR_MS = 3_600_000;
    const DAY_MS = 86_400_000;

    /** Mirrors hub/src/timeline.js — keeps the client's merge visually consistent with the server's. */
    const COVERAGE_JOIN_MS = 2000;

    /** How often the bar re-reads coverage while sitting on today. */
    const LIVE_REFRESH_MS = 30_000;

    /**
     * Per-camera marker colors for the dashboard's merged view. Deliberately
     * outside the app's semantic palette (accent/warn/error/saved-blue all
     * mean something else already) — these exist only to answer "whose event
     * is this", cycling if there are more cameras than colors.
     */
    const CAM_COLORS = ["#a78bfa", "#f472b6", "#2dd4bf", "#fb923c"];

    let activeInstance = null;

    /** Set by the dashboard when a click hands off to a specific camera + instant. */
    let pendingSeek = null;

    function startOfDay(ms) {
        const d = new Date(ms);
        d.setHours(0, 0, 0, 0);
        return d.getTime();
    }

    function dayStringOf(ms) {
        const d = new Date(ms);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    }

    function enterCamera(camId, atMs) {
        pendingSeek = { camId, atMs };
        SL.app.navigate(`live/${encodeURIComponent(camId)}`);
    }

    function stopActive() {
        if (activeInstance) activeInstance.destroy();
        activeInstance = null;
    }

    // =====================================================================
    //  Detail mode — one camera, full scrubber + player
    // =====================================================================

    async function renderDetail(container, cams, camId) {
        stopActive();
        clear(container);

        const state = {
            camId,
            dayStartMs: null,
            current: null,          // { recordingId, startedAtMs, protected }
            playingAtMs: null,      // wall-clock position being played
            timeline: null,
            days: [],
            refreshTimer: null,
            selection: null         // { fromMs, toMs } for saving a moment
        };
        const dom = {
            header: el("div.page-header"),
            player: el("div#timeline-player"),
            scrub: el("div#timeline-scrub")
        };
        container.append(dom.header, dom.player, dom.scrub);

        // A dashboard click hands off a specific instant to land on; consume
        // it once so a later re-mount of this same camera doesn't reuse it.
        const initialSeekMs = (pendingSeek && pendingSeek.camId === camId) ? pendingSeek.atMs : null;
        if (pendingSeek && pendingSeek.camId === camId) pendingSeek = null;

        // -----------------------------------------------------------------
        //  Data
        // -----------------------------------------------------------------

        async function loadDays() {
            const res = await api.get(`/cam/${encodeURIComponent(state.camId)}/timeline/days`);
            state.days = res.days || [];
            return state.days;
        }

        async function loadTimeline() {
            const from = state.dayStartMs;
            const to = from + DAY_MS;
            state.timeline = await api.get(
                `/cam/${encodeURIComponent(state.camId)}/timeline?from=${from}&to=${to}`
            );
            return state.timeline;
        }

        // -----------------------------------------------------------------
        //  Scrub bar
        // -----------------------------------------------------------------

        function positionToTime(ratio) {
            return state.dayStartMs + Math.max(0, Math.min(1, ratio)) * DAY_MS;
        }

        function timeToRatio(ms) {
            return Math.max(0, Math.min(1, (ms - state.dayStartMs) / DAY_MS));
        }

        function renderBar() {
            const bar = el("div.timeline-bar", {
                title: "Click to jump to a moment; drag to select a range to save"
            });

            const ticks = el("div.timeline-ticks");
            for (let hour = 0; hour <= 24; hour += 2) {
                ticks.appendChild(el("span.timeline-tick", {
                    style: { left: `${(hour / 24) * 100}%` },
                    text: hour === 24 ? "" : `${String(hour).padStart(2, "0")}`
                }));
            }

            const track = el("div.timeline-track");

            const timeline = state.timeline;
            if (timeline) {
                for (const run of timeline.coverage) {
                    const left = timeToRatio(run.from) * 100;
                    const width = Math.max(0.15, (timeToRatio(run.to) - timeToRatio(run.from)) * 100);
                    track.appendChild(el("div.timeline-coverage", {
                        dataset: { saved: String(!!run.protected) },
                        style: { left: `${left}%`, width: `${width}%` },
                        title: `${new Date(run.from).toLocaleTimeString()} – ` +
                               `${new Date(run.to).toLocaleTimeString()}` +
                               (run.protected ? " (contains saved footage)" : "")
                    }));
                }

                for (const event of timeline.events) {
                    const left = timeToRatio(event.started_at_ms) * 100;
                    track.appendChild(el("div.timeline-event", {
                        dataset: { behavior: event.behavior || "" },
                        style: { left: `${left}%` },
                        title: `${new Date(event.started_at_ms).toLocaleTimeString()} — ` +
                               (event.description || event.type),
                        onclick: (ev) => {
                            ev.stopPropagation();
                            seekTo(event.started_at_ms - 3000);   // a moment before it starts
                        }
                    }));
                }
            }

            if (state.selection) {
                const left = timeToRatio(state.selection.fromMs) * 100;
                const width = (timeToRatio(state.selection.toMs) - timeToRatio(state.selection.fromMs)) * 100;
                track.appendChild(el("div.timeline-selection", {
                    style: { left: `${left}%`, width: `${Math.max(0.3, width)}%` }
                }));
            }

            if (state.playingAtMs !== null) {
                track.appendChild(el("div.timeline-playhead", {
                    style: { left: `${timeToRatio(state.playingAtMs) * 100}%` }
                }));
            }

            attachScrubHandlers(track, bar);
            bar.appendChild(ticks);
            bar.appendChild(track);
            return bar;
        }

        /**
         * Click to seek, drag to select.
         *
         * A drag under a few pixels is treated as a click — otherwise a slightly
         * shaky click would select a two-second range instead of seeking, which
         * feels broken.
         */
        function attachScrubHandlers(track, bar) {
            let dragStartRatio = null;
            let dragged = false;

            const ratioFrom = (ev) => {
                const rect = track.getBoundingClientRect();
                const x = (ev.touches ? ev.touches[0].clientX : ev.clientX) - rect.left;
                return Math.max(0, Math.min(1, x / rect.width));
            };

            track.addEventListener("pointerdown", (ev) => {
                ev.preventDefault();
                track.setPointerCapture(ev.pointerId);
                dragStartRatio = ratioFrom(ev);
                dragged = false;
            });

            track.addEventListener("pointermove", (ev) => {
                if (dragStartRatio === null) return;
                const now = ratioFrom(ev);
                if (Math.abs(now - dragStartRatio) > 0.004) {
                    dragged = true;
                    state.selection = {
                        fromMs: positionToTime(Math.min(dragStartRatio, now)),
                        toMs: positionToTime(Math.max(dragStartRatio, now))
                    };
                    renderScrubArea();
                }
            });

            track.addEventListener("pointerup", (ev) => {
                if (dragStartRatio === null) return;
                const endRatio = ratioFrom(ev);
                const wasDragged = dragged;
                dragStartRatio = null;
                dragged = false;

                if (!wasDragged) {
                    state.selection = null;
                    seekTo(positionToTime(endRatio));
                } else {
                    renderScrubArea();
                }
            });

            bar.addEventListener("dblclick", () => {
                state.selection = null;
                renderScrubArea();
            });
        }

        // -----------------------------------------------------------------
        //  Playback
        // -----------------------------------------------------------------

        async function seekTo(atMs) {
            state.playingAtMs = atMs;
            try {
                const seek = await api.get(
                    `/cam/${encodeURIComponent(state.camId)}/timeline/seek?at=${Math.round(atMs)}`
                );

                if (!seek.found) {
                    renderPlayer(null, seek);
                    renderScrubArea();
                    return;
                }

                state.current = {
                    recordingId: seek.recording_id,
                    startedAtMs: seek.started_at_ms,
                    protected: seek.protected
                };
                renderPlayer(seek);
                renderScrubArea();
            } catch (err) {
                toast(err.message, "error");
            }
        }

        function renderPlayer(seek, miss) {
            clear(dom.player);
            dom.videoEl = null;
            dom.playToggle = null;
            dom.playClock = null;

            if (!seek) {
                const gap = miss && miss.nearest
                    ? `Nearest footage is ${formatDuration(miss.nearest.gap_ms)} away.`
                    : "There's no footage recorded for this camera around that time.";
                dom.player.appendChild(el("div.timeline-empty", [
                    el("div", { text: "No footage at that moment." }),
                    el("div.small.muted", { text: gap, style: { marginTop: "4px" } }),
                    miss && miss.nearest
                        ? el("button.btn", {
                            text: "Jump to nearest",
                            style: { marginTop: "10px" },
                            onclick: () => seekTo(miss.nearest.started_at_ms + 500)
                        })
                        : null
                ]));
                return;
            }

            // No native `controls`: the scrub bar above is the seek surface and
            // the playbar below owns play/pause, so browser chrome would just
            // duplicate (and fight with) controls this component already has.
            const video = el("video.timeline-video", {
                autoplay: true, playsinline: true,
                preload: "auto",
                src: `/recordings/${seek.recording_id}/video.mp4`
            });

            video.addEventListener("loadedmetadata", () => {
                // Video time equals elapsed wall-clock time within a segment, so
                // the offset the server computed lands exactly.
                if (seek.offset_seconds > 0) video.currentTime = seek.offset_seconds;
            });

            // Keep the playhead — and the playbar clock — tracking real time as
            // it plays. `timeupdate` only fires while the video is actually
            // advancing, so both freeze the instant playback does.
            video.addEventListener("timeupdate", () => {
                state.playingAtMs = seek.started_at_ms + video.currentTime * 1000;
                movePlayhead();
                updatePlayClock();
            });

            video.addEventListener("play", () => setPlayToggle(true));
            video.addEventListener("pause", () => setPlayToggle(false));

            // Roll into the next segment so review isn't chopped every 5 minutes.
            video.addEventListener("ended", async () => {
                setPlayToggle(false);
                try {
                    const next = await api.get(`/recordings/${seek.recording_id}/next`);
                    if (next && next.recording_id) seekTo(next.started_at_ms + 100);
                    else toast("End of recorded footage.", "info");
                } catch (_) { /* stop quietly at the end */ }
            });

            video.addEventListener("error", () => {
                dom.player.appendChild(el("div.timeline-empty", {
                    text: "That segment couldn't be played — it may have just been deleted " +
                          "to make room for new footage."
                }));
            });

            dom.videoEl = video;
            state.playingAtMs = seek.started_at_ms + (seek.offset_seconds || 0) * 1000;
            dom.player.appendChild(video);
            dom.player.appendChild(renderPlayerBar(seek));
            updatePlayClock();
        }

        function setPlayToggle(playing) {
            if (dom.playToggle) dom.playToggle.textContent = playing ? "⏸" : "▶";
        }

        function updatePlayClock() {
            if (!dom.playClock) return;
            const reading = formatClock(state.playingAtMs);
            dom.playClock.textContent = reading ? reading.time : "—";
        }

        function renderPlayerBar(seek) {
            const isSaved = !!(state.current && state.current.protected);

            dom.playToggle = el("button.btn.btn-icon", {
                type: "button", title: "Play or pause", text: "⏸",
                onclick: () => {
                    if (!dom.videoEl) return;
                    if (dom.videoEl.paused) dom.videoEl.play().catch(() => {});
                    else dom.videoEl.pause();
                }
            });
            dom.playClock = el("span.timeline-clock", { title: "Time within the recording" });

            return el("div.timeline-playbar", [
                dom.playToggle,
                dom.playClock,
                el("span.spacer"),
                state.selection
                    ? el("button.btn.btn-icon", {
                        "data-variant": "primary",
                        text: `Save ${formatDuration(state.selection.toMs - state.selection.fromMs)}`,
                        title: "Keep this range permanently — it won't be deleted to make room",
                        onclick: saveSelection
                    })
                    : null,
                el("button.btn.btn-icon", {
                    text: isSaved ? "Saved ✓" : "Save this segment",
                    title: isSaved
                        ? "This segment is kept permanently. Click to release it."
                        : "Keep this segment permanently — it won't be deleted to make room",
                    "data-variant": isSaved ? "primary" : undefined,
                    onclick: () => toggleProtect(!isSaved)
                })
            ]);
        }

        async function toggleProtect(wanted) {
            if (!state.current) return;
            try {
                const updated = await api.post(
                    `/recordings/${state.current.recordingId}/protect`, { protected: wanted }
                );
                state.current.protected = updated.protected;
                toast(wanted ? "Segment saved — it won't be deleted." : "Segment released.", "ok");
                await refresh();
            } catch (err) {
                toast(err.message, "error");
            }
        }

        async function saveSelection() {
            if (!state.selection) return;
            const { fromMs, toMs } = state.selection;
            const ok = await confirmAction(
                "Save this moment?",
                `Keep ${formatDuration(toMs - fromMs)} of footage from ` +
                `${new Date(fromMs).toLocaleTimeString()} permanently. It won't be deleted ` +
                "to make room for new recordings.",
                "Save it"
            );
            if (!ok) return;

            try {
                const result = await api.post(
                    `/cam/${encodeURIComponent(state.camId)}/timeline/save`,
                    { fromMs: Math.round(fromMs), toMs: Math.round(toMs), protected: true }
                );
                toast(
                    result.segments
                        ? `Saved ${result.segments} segment(s). ${result.note}`
                        : result.note,
                    result.segments ? "ok" : "error"
                );
                state.selection = null;
                await refresh();
            } catch (err) {
                toast(err.message, "error");
            }
        }

        /** Cheap playhead update — avoids re-rendering the whole bar on every tick. */
        function movePlayhead() {
            const head = dom.scrub && dom.scrub.querySelector(".timeline-playhead");
            if (head && state.playingAtMs !== null) {
                head.style.left = `${timeToRatio(state.playingAtMs) * 100}%`;
            }
        }

        // -----------------------------------------------------------------
        //  Render
        // -----------------------------------------------------------------

        function renderScrubArea() {
            clear(dom.scrub);
            dom.scrub.appendChild(renderBar());
            dom.scrub.appendChild(renderLegend());
        }

        function renderLegend() {
            const timeline = state.timeline;
            const covered = timeline ? Math.round(timeline.coverage_ratio * 100) : 0;

            return el("div.timeline-legend", [
                el("span", [el("span.swatch.swatch-coverage"), "Recorded"]),
                el("span", [el("span.swatch.swatch-saved"), "Saved"]),
                el("span", [el("span.swatch.swatch-event"), "Event"]),
                el("span.spacer"),
                timeline
                    ? el("span", {
                        text: `${covered}% of the day recorded · ${formatBytes(timeline.total_bytes)}`
                    })
                    : null
            ]);
        }

        function renderDayPicker() {
            const select = el("select", {
                onchange: async (ev) => {
                    state.dayStartMs = Number(ev.target.value);
                    state.selection = null;
                    state.playingAtMs = null;
                    await refresh();
                    const first = state.timeline && state.timeline.coverage[0];
                    if (first) seekTo(first.from + 500);
                    else clear(dom.player);
                }
            }, state.days.map((day) => {
                const ms = startOfDay(new Date(`${day.day}T12:00:00`).getTime());
                return el("option", {
                    value: String(ms),
                    selected: ms === state.dayStartMs,
                    text: `${day.day}  ·  ${formatBytes(day.bytes || 0)}`
                });
            }));

            if (!state.days.length) {
                return el("span.small.muted", { text: "No footage recorded yet." });
            }
            return select;
        }

        async function refresh() {
            try {
                await loadTimeline();
                renderScrubArea();
            } catch (err) {
                toast(err.message, "error");
            }
        }

        // -----------------------------------------------------------------
        //  Mount
        // -----------------------------------------------------------------

        try {
            await loadDays();
        } catch (err) {
            toast(err.message, "error");
            state.days = [];
        }

        const continuousOn = await api
            .get(`/cam/${encodeURIComponent(state.camId)}/continuous`)
            .catch(() => null);

        clear(dom.header);

        // Nothing recorded yet is by far the most likely first experience,
        // since continuous recording ships off. Say what to do about it rather
        // than showing an empty bar.
        if (!state.days.length) {
            dom.header.appendChild(el("div.page-header-actions", [
                continuousOn && continuousOn.running
                    ? el("span.badge", { dataset: { kind: "live" }, text: "RECORDING" })
                    : null
            ]));
            clear(dom.player);
            clear(dom.scrub);
            dom.player.appendChild(el("div.empty", {
                html: continuousOn && continuousOn.enabled
                    ? "Continuous recording is on, but nothing has been written yet.<br>" +
                      "Footage appears here within a few minutes of the first segment closing."
                    : "Continuous recording is off for this camera.<br>" +
                      'Turn on <b>Record continuously</b> in <a href="#/settings" ' +
                      'style="color:var(--accent)">Settings → Continuous recording</a> ' +
                      "to start building a timeline you can scrub back through."
            }));
            activeInstance = { destroy() {} };
            return;
        }

        if (initialSeekMs != null) {
            // Arriving from a dashboard click on a camera that may not have
            // footage on its usual "newest day" — make sure the picker has an
            // entry for the day we're actually about to show.
            const dayStr = dayStringOf(initialSeekMs);
            if (!state.days.some((d) => d.day === dayStr)) {
                state.days = [...state.days, { day: dayStr, bytes: 0 }]
                    .sort((a, b) => b.day.localeCompare(a.day));
            }
            state.dayStartMs = startOfDay(initialSeekMs);
        } else {
            const newestDay = state.days[0];
            state.dayStartMs = startOfDay(new Date(`${newestDay.day}T12:00:00`).getTime());
        }

        dom.header.append(
            el("div.page-header-left", [renderDayPicker()]),
            el("div.page-header-actions", [
                continuousOn && continuousOn.running
                    ? el("span.badge", { dataset: { kind: "live" }, text: "RECORDING" })
                    : null
            ])
        );

        await refresh();

        if (initialSeekMs != null) {
            seekTo(initialSeekMs);
        } else {
            const runs = state.timeline ? state.timeline.coverage : [];
            if (runs.length) {
                // Start at the most recent footage — that's what you usually want.
                const last = runs[runs.length - 1];
                seekTo(Math.max(last.from, last.to - 30_000));
            }
        }

        state.refreshTimer = setInterval(() => {
            // Only auto-refresh while looking at today, where new footage is
            // still arriving.
            if (state.dayStartMs === startOfDay(Date.now())) refresh();
        }, LIVE_REFRESH_MS);

        activeInstance = {
            destroy() {
                if (state.refreshTimer) { clearInterval(state.refreshTimer); state.refreshTimer = null; }
            }
        };
    }

    // =====================================================================
    //  Dashboard mode — every camera, merged, navigation-only
    // =====================================================================

    async function renderDashboard(container, cams) {
        stopActive();
        clear(container);

        if (!cams || !cams.length) {
            container.appendChild(el("div.empty", { text: "No cameras are connected." }));
            activeInstance = { destroy() {} };
            return;
        }

        const state = {
            dayStartMs: null,
            days: [],            // union across cameras: [{ day, bytes }]
            perCam: new Map(),   // camId -> { name, color, timeline }
            refreshTimer: null
        };
        cams.forEach((cam, i) => state.perCam.set(cam.cam_id, {
            name: cam.name || cam.cam_id,
            color: CAM_COLORS[i % CAM_COLORS.length],
            timeline: null
        }));

        const dom = {
            header: el("div.page-header"),
            scrub: el("div#timeline-scrub")
        };
        container.append(dom.header, dom.scrub);

        async function loadDaysUnion() {
            const results = await Promise.all(cams.map((cam) =>
                api.get(`/cam/${encodeURIComponent(cam.cam_id)}/timeline/days`).catch(() => ({ days: [] }))
            ));
            const byDay = new Map();
            for (const res of results) {
                for (const day of (res.days || [])) {
                    const prev = byDay.get(day.day) || { day: day.day, bytes: 0 };
                    prev.bytes += day.bytes || 0;
                    byDay.set(day.day, prev);
                }
            }
            state.days = [...byDay.values()].sort((a, b) => b.day.localeCompare(a.day));
            return state.days;
        }

        async function loadDay() {
            const from = state.dayStartMs;
            const to = from + DAY_MS;
            await Promise.all(cams.map(async (cam) => {
                const meta = state.perCam.get(cam.cam_id);
                try {
                    meta.timeline = await api.get(
                        `/cam/${encodeURIComponent(cam.cam_id)}/timeline?from=${from}&to=${to}`
                    );
                } catch (_) {
                    meta.timeline = null;
                }
            }));
        }

        /** Union of every camera's coverage — "was anything recording", not per-camera detail. */
        function mergedCoverage() {
            const runs = [];
            for (const meta of state.perCam.values()) {
                if (meta.timeline) runs.push(...meta.timeline.coverage);
            }
            runs.sort((a, b) => a.from - b.from);

            const merged = [];
            for (const run of runs) {
                const last = merged[merged.length - 1];
                if (last && run.from - last.to <= COVERAGE_JOIN_MS) {
                    last.to = Math.max(last.to, run.to);
                } else {
                    merged.push({ from: run.from, to: run.to });
                }
            }
            return merged;
        }

        function allEvents() {
            const out = [];
            for (const [camId, meta] of state.perCam) {
                if (!meta.timeline) continue;
                for (const event of meta.timeline.events) {
                    out.push({ ...event, cam_id: camId, camName: meta.name, camColor: meta.color });
                }
            }
            return out.sort((a, b) => a.started_at_ms - b.started_at_ms);
        }

        /** Which camera (if any) has footage at this instant — for a bare-track click. */
        function coverageAt(atMs) {
            for (const [camId, meta] of state.perCam) {
                if (!meta.timeline) continue;
                for (const run of meta.timeline.coverage) {
                    if (atMs >= run.from && atMs <= run.to) return camId;
                }
            }
            return null;
        }

        function timeToRatio(ms) {
            return Math.max(0, Math.min(1, (ms - state.dayStartMs) / DAY_MS));
        }

        function positionToTime(ratio) {
            return state.dayStartMs + Math.max(0, Math.min(1, ratio)) * DAY_MS;
        }

        function renderBar() {
            const bar = el("div.timeline-bar", {
                title: "Click a moment, or an event, to open that camera there"
            });

            const ticks = el("div.timeline-ticks");
            for (let hour = 0; hour <= 24; hour += 2) {
                ticks.appendChild(el("span.timeline-tick", {
                    style: { left: `${(hour / 24) * 100}%` },
                    text: hour === 24 ? "" : `${String(hour).padStart(2, "0")}`
                }));
            }

            const track = el("div.timeline-track", { dataset: { mode: "dashboard" } });

            for (const run of mergedCoverage()) {
                const left = timeToRatio(run.from) * 100;
                const width = Math.max(0.15, (timeToRatio(run.to) - timeToRatio(run.from)) * 100);
                track.appendChild(el("div.timeline-coverage", {
                    style: { left: `${left}%`, width: `${width}%` },
                    title: `${new Date(run.from).toLocaleTimeString()} – ${new Date(run.to).toLocaleTimeString()}`
                }));
            }

            for (const event of allEvents()) {
                const left = timeToRatio(event.started_at_ms) * 100;
                track.appendChild(el("div.timeline-event", {
                    style: { left: `${left}%`, background: event.camColor, boxShadow: `0 0 5px ${event.camColor}` },
                    title: `${event.camName} — ${new Date(event.started_at_ms).toLocaleTimeString()} — ` +
                           (event.description || event.type),
                    onclick: (ev) => {
                        ev.stopPropagation();
                        enterCamera(event.cam_id, event.started_at_ms - 3000);
                    }
                }));
            }

            track.addEventListener("click", (ev) => {
                const rect = track.getBoundingClientRect();
                const ratio = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
                const atMs = positionToTime(ratio);
                const camId = coverageAt(atMs);
                if (camId) enterCamera(camId, atMs);
                else toast("No footage recorded around that time, for any camera.", "info");
            });

            bar.appendChild(ticks);
            bar.appendChild(track);
            return bar;
        }

        function renderLegend() {
            const chips = [...state.perCam.values()].map((meta) => el("span", [
                el("span.swatch", { style: { background: meta.color } }),
                meta.name
            ]));
            const totalBytes = [...state.perCam.values()]
                .reduce((sum, meta) => sum + (meta.timeline ? meta.timeline.total_bytes : 0), 0);

            return el("div.timeline-legend", [
                el("span", [el("span.swatch.swatch-coverage"), "Recorded"]),
                ...chips,
                el("span.spacer"),
                el("span", { text: formatBytes(totalBytes) })
            ]);
        }

        function renderScrubArea() {
            clear(dom.scrub);
            dom.scrub.appendChild(renderBar());
            dom.scrub.appendChild(renderLegend());
        }

        function renderDayPicker() {
            if (!state.days.length) return el("span.small.muted", { text: "No footage recorded yet." });
            return el("select", {
                onchange: async (ev) => {
                    state.dayStartMs = Number(ev.target.value);
                    await loadDay();
                    renderScrubArea();
                }
            }, state.days.map((day) => {
                const ms = startOfDay(new Date(`${day.day}T12:00:00`).getTime());
                return el("option", {
                    value: String(ms),
                    selected: ms === state.dayStartMs,
                    text: `${day.day}  ·  ${formatBytes(day.bytes || 0)}`
                });
            }));
        }

        try {
            await loadDaysUnion();
        } catch (err) {
            toast(err.message, "error");
            state.days = [];
        }

        clear(dom.header);

        if (!state.days.length) {
            dom.header.appendChild(el("div.page-header-left", [
                el("span.small.muted", { text: "No camera has recorded any footage yet." })
            ]));
            clear(dom.scrub);
            activeInstance = { destroy() {} };
            return;
        }

        const newest = state.days[0];
        state.dayStartMs = startOfDay(new Date(`${newest.day}T12:00:00`).getTime());
        await loadDay();

        dom.header.appendChild(el("div.page-header-left", [renderDayPicker()]));
        renderScrubArea();

        state.refreshTimer = setInterval(async () => {
            if (state.dayStartMs === startOfDay(Date.now())) {
                await loadDay();
                renderScrubArea();
            }
        }, LIVE_REFRESH_MS);

        activeInstance = {
            destroy() {
                if (state.refreshTimer) { clearInterval(state.refreshTimer); state.refreshTimer = null; }
            }
        };
    }

    function destroy() {
        stopActive();
    }

    SL.timeline = { renderDetail, renderDashboard, destroy };
})(window);
