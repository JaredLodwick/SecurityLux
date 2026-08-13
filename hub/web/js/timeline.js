/**
 * Timeline — scrub back through continuously recorded footage.
 *
 * Three parts:
 *
 *   1. A day picker, listing only days that actually have footage.
 *   2. A 24-hour scrub bar showing where footage exists, where it doesn't, and
 *      where events happened.
 *   3. A player that loads the segment covering the instant you clicked and
 *      seeks straight to it.
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
 */

(function (global) {
    "use strict";

    const SL = global.SL;
    const { el, clear, api, toast, confirmAction, formatBytes, formatDuration } = SL;

    const HOUR_MS = 3_600_000;
    const DAY_MS = 86_400_000;

    /** How often the bar re-reads coverage while sitting on today. */
    const LIVE_REFRESH_MS = 30_000;

    const state = {
        camId: null,
        dayStartMs: null,
        current: null,        // { recordingId, startedAtMs, protected }
        playingAtMs: null,    // wall-clock position being played
        timeline: null,
        days: [],
        refreshTimer: null,
        selection: null       // { fromMs, toMs } for saving a moment
    };

    let dom = {};

    // ---------------------------------------------------------------
    //  Data
    // ---------------------------------------------------------------

    function startOfDay(ms) {
        const d = new Date(ms);
        d.setHours(0, 0, 0, 0);
        return d.getTime();
    }

    async function loadDays(camId) {
        const res = await api.get(`/cam/${encodeURIComponent(camId)}/timeline/days`);
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

    // ---------------------------------------------------------------
    //  Scrub bar
    // ---------------------------------------------------------------

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

        // Hour ticks give the bar a readable scale — without them a coverage
        // run is just a grey smear with no sense of when.
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

        // Selection overlay for saving a range.
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

    // ---------------------------------------------------------------
    //  Playback
    // ---------------------------------------------------------------

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

        const video = el("video.timeline-video", {
            controls: true, autoplay: true, playsinline: true,
            preload: "auto",
            src: `/recordings/${seek.recording_id}/video.mp4`
        });

        video.addEventListener("loadedmetadata", () => {
            // Video time equals elapsed wall-clock time within a segment, so
            // the offset the server computed lands exactly.
            if (seek.offset_seconds > 0) video.currentTime = seek.offset_seconds;
        });

        // Keep the playhead tracking real time as it plays.
        video.addEventListener("timeupdate", () => {
            state.playingAtMs = seek.started_at_ms + video.currentTime * 1000;
            movePlayhead();
        });

        // Roll into the next segment so review isn't chopped every 5 minutes.
        video.addEventListener("ended", async () => {
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

        dom.player.appendChild(video);
        dom.player.appendChild(renderPlayerBar(seek));
    }

    function renderPlayerBar(seek) {
        const isSaved = !!(state.current && state.current.protected);

        return el("div.timeline-playbar", [
            el("span.timeline-clock", {
                text: new Date(seek.started_at_ms).toLocaleString()
            }),
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

    // ---------------------------------------------------------------
    //  Render
    // ---------------------------------------------------------------

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
                // Land on the first footage of that day rather than an empty player.
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

    // ---------------------------------------------------------------
    //  Mount
    // ---------------------------------------------------------------

    /**
     * @param {HTMLElement} container
     * @param {Array} cams  From /cams, for the camera picker.
     */
    async function render(container, cams) {
        clear(container);

        if (!cams || !cams.length) {
            container.appendChild(el("div.empty", { text: "No cameras are connected." }));
            return;
        }

        if (!state.camId || !cams.some((c) => c.cam_id === state.camId)) {
            state.camId = cams[0].cam_id;
        }

        const camSelect = el("select", {
            onchange: async (ev) => {
                state.camId = ev.target.value;
                state.current = null;
                state.playingAtMs = null;
                state.selection = null;
                await mountForCamera();
            }
        }, cams.map((c) => el("option", {
            value: c.cam_id, text: c.name || c.cam_id,
            selected: c.cam_id === state.camId
        })));

        dom = {
            header: el("div.page-header"),
            scrub: el("div#timeline-scrub"),
            player: el("div#timeline-player"),
            camSelect
        };

        container.append(dom.header, dom.player, dom.scrub);
        await mountForCamera();
    }

    async function mountForCamera() {
        try {
            await loadDays(state.camId);
        } catch (err) {
            toast(err.message, "error");
            state.days = [];
        }

        const continuousOn = await api
            .get(`/cam/${encodeURIComponent(state.camId)}/continuous`)
            .catch(() => null);

        clear(dom.header);
        dom.header.append(
            el("div.page-header-left", [
                el("h2", { text: "Timeline" }),
                dom.camSelect,
                renderDayPicker()
            ]),
            el("div.page-header-actions", [
                continuousOn && continuousOn.running
                    ? el("span.badge", { dataset: { kind: "live" }, text: "RECORDING" })
                    : null,
                el("a.btn", { href: "#/storage", text: "Storage" })
            ])
        );

        // Nothing recorded yet is by far the most likely first experience,
        // since continuous recording ships off. Say what to do about it rather
        // than showing an empty bar.
        if (!state.days.length) {
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
            return;
        }

        const newestDay = state.days[0];
        state.dayStartMs = startOfDay(new Date(`${newestDay.day}T12:00:00`).getTime());

        await refresh();

        const runs = state.timeline ? state.timeline.coverage : [];
        if (runs.length) {
            // Start at the most recent footage — that's what you usually want.
            const last = runs[runs.length - 1];
            seekTo(Math.max(last.from, last.to - 30_000));
        }

        if (state.refreshTimer) clearInterval(state.refreshTimer);
        state.refreshTimer = setInterval(() => {
            // Only auto-refresh while looking at today, where new footage is
            // still arriving.
            if (state.dayStartMs === startOfDay(Date.now())) refresh();
        }, LIVE_REFRESH_MS);
    }

    function destroy() {
        if (state.refreshTimer) { clearInterval(state.refreshTimer); state.refreshTimer = null; }
    }

    SL.timeline = { render, destroy, state };
})(window);
