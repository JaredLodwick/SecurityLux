/**
 * Event list, filters, and inline clip playback.
 *
 * The natural-language description is the primary line — not "person detected,
 * 12.4s, 87% confidence". The numbers are still there underneath for when you
 * want them, but a log you can skim is worth far more than a log you have to
 * decode, and skimming is what you're doing when something has actually
 * happened.
 */

(function (global) {
    "use strict";

    const SL = global.SL;
    const { el, clear, api, toast, confirmAction, formatTime, formatDuration, capitalize } = SL;

    const state = {
        filters: { cam: "", behavior: "", type: "", clips: false },
        expandedId: null,
        events: [],
        limit: 100
    };

    /** True while a clip is playing, so the poll loop can avoid tearing it down. */
    function isPlaying() {
        const video = document.querySelector('.event[data-expanded="true"] video');
        return !!(video && !video.paused && !video.ended);
    }

    function setFilter(key, value) {
        state.filters[key] = value;
    }

    function queryString(camScope) {
        const params = new URLSearchParams();
        const cam = camScope || state.filters.cam;
        if (cam) params.set("cam", cam);
        if (state.filters.behavior) params.set("behavior", state.filters.behavior);
        if (state.filters.type) params.set("type", state.filters.type);
        if (state.filters.clips) params.set("clips", "1");
        params.set("limit", String(state.limit));
        return params.toString();
    }

    async function load(camScope) {
        state.events = await api.get(`/events?${queryString(camScope)}`);
        return state.events;
    }

    // ---------------------------------------------------------------
    //  Filters
    // ---------------------------------------------------------------

    function renderFilters(cams, onChange) {
        const camSelect = el("select", {
            title: "Filter by camera",
            onchange: (ev) => { setFilter("cam", ev.target.value); onChange(); }
        }, [
            el("option", { value: "", text: "All cameras" }),
            ...cams.map((c) => el("option", {
                value: c.cam_id,
                text: c.name || c.cam_id,
                selected: state.filters.cam === c.cam_id
            }))
        ]);

        const behaviorSelect = el("select", {
            title: "Filter by what happened",
            onchange: (ev) => { setFilter("behavior", ev.target.value); onChange(); }
        }, [
            el("option", { value: "", text: "Any behaviour" }),
            ...["passing", "approaching", "present", "dwelling", "loitering", "offline"]
                .map((b) => el("option", {
                    value: b, text: capitalize(b), selected: state.filters.behavior === b
                }))
        ]);

        const clipsToggle = el("button.pill", {
            type: "button",
            title: "Only show events that still have video",
            dataset: { on: String(state.filters.clips) },
            onclick: () => { setFilter("clips", !state.filters.clips); onChange(); }
        }, [el("span.toggle-pip"), el("span", { text: "With video" })]);

        return el("div.filters", [
            camSelect,
            behaviorSelect,
            clipsToggle,
            el("span.spacer"),
            el("span.small.muted", { text: `${state.events.length} event${state.events.length === 1 ? "" : "s"}` })
        ]);
    }

    // ---------------------------------------------------------------
    //  List
    // ---------------------------------------------------------------

    function render(container, events, cams) {
        state.events = events || [];
        clear(container);

        if (!state.events.length) {
            container.appendChild(el("div.empty", {
                text: "No events yet. Walk past a camera with detection enabled to trigger one."
            }));
            return;
        }

        const nameByCam = new Map((cams || []).map((c) => [c.cam_id, c.name || c.cam_id]));
        const list = el("ul.events");
        for (const event of state.events) {
            list.appendChild(renderEvent(event, nameByCam));
        }
        container.appendChild(list);

        if (state.events.length >= state.limit) {
            container.appendChild(el("div", { style: { textAlign: "center", marginTop: "14px" } }, [
                el("button.btn", {
                    text: "Load more",
                    onclick: (ev) => {
                        state.limit += 100;
                        ev.target.disabled = true;
                        ev.target.textContent = "Loading…";
                        global.SL.app.refresh();
                    }
                })
            ]));
        }
    }

    function renderEvent(event, nameByCam) {
        const li = el("li.event", {
            dataset: { expanded: String(state.expandedId === event.id), eventId: String(event.id) }
        });

        const thumb = event.thumb_path
            ? el("img.event-thumb", {
                src: `/events/${event.id}/thumb.jpg`,
                loading: "lazy",
                alt: ""
            })
            : el("div.event-thumb-placeholder", { text: event.type === "camera_offline" ? "⚠" : "●" });

        const description = event.description
            || `${capitalize(event.type || "event")} detected`;

        const metaBits = [];
        if (event.duration_ms != null) metaBits.push(formatDuration(event.duration_ms));
        if (typeof event.max_confidence === "number") {
            metaBits.push(`${Math.round(event.max_confidence * 100)}% confidence`);
        }
        if (event.clip_pruned) metaBits.push("video reclaimed for storage");
        else if (!event.clip_path) metaBits.push("no video");

        const body = el("div", [
            el("div.event-desc", [
                event.behavior
                    ? el("span.event-behavior", { dataset: { b: event.behavior }, text: event.behavior })
                    : null,
                description
            ]),
            el("div.event-meta", { text: metaBits.join(" · ") })
        ]);

        const summary = el("div.event-summary", [
            thumb,
            body,
            el("div.event-cam", { text: nameByCam.get(event.cam_id) || event.cam_id }),
            el("div.event-time", { text: formatTime(event.started_at_ms), title: new Date(event.started_at_ms).toLocaleString() }),
            el("button.btn.btn-icon.event-play", {
                type: "button", title: "Play clip", text: "▶",
                onclick: (ev) => { ev.stopPropagation(); toggle(li, event); }
            })
        ]);

        const player = el("div.event-player");
        summary.addEventListener("click", () => toggle(li, event));

        li.appendChild(summary);
        li.appendChild(player);

        if (state.expandedId === event.id) renderPlayer(player, event);
        return li;
    }

    function toggle(li, event) {
        const wasOpen = li.dataset.expanded === "true";

        document.querySelectorAll('.event[data-expanded="true"]').forEach((other) => {
            if (other === li) return;
            other.dataset.expanded = "false";
            clear(other.querySelector(".event-player"));
        });

        if (wasOpen) {
            li.dataset.expanded = "false";
            clear(li.querySelector(".event-player"));
            state.expandedId = null;
            return;
        }
        li.dataset.expanded = "true";
        state.expandedId = event.id;
        renderPlayer(li.querySelector(".event-player"), event);
        li.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }

    function renderPlayer(container, event) {
        clear(container);

        if (!event.clip_path) {
            container.appendChild(el("div.event-player-msg", {
                text: event.clip_pruned
                    ? "The video for this event was deleted to stay within the storage budget. " +
                      "The event record is kept. Raise the budget in Settings > Storage if this " +
                      "is happening sooner than you'd like."
                    : "No video was recorded for this event."
            }));
            appendActions(container, event);
            return;
        }

        const ext = (event.clip_path.match(/\.(mkv|mp4)$/i) || [".mp4"])[0];
        const src = `/events/${event.id}/clip${ext}`;

        const video = el("video", {
            controls: true, preload: "metadata", playsinline: true, src
        });
        video.addEventListener("error", () => {
            container.insertBefore(el("div.event-player-msg", {
                text: "Your browser couldn't decode this clip. Older clips recorded in MKV/MJPEG " +
                      "aren't universally supported — use the download link below. New recordings " +
                      "default to h264/mp4, which plays everywhere."
            }), video.nextSibling);
        });
        container.appendChild(video);
        appendActions(container, event);
        video.play().catch(() => { /* autoplay may be blocked; controls still work */ });
    }

    function appendActions(container, event) {
        const actions = el("div.event-player-actions");

        if (event.clip_path) {
            const ext = (event.clip_path.match(/\.(mkv|mp4)$/i) || [".mp4"])[0];
            actions.appendChild(el("a", {
                href: `/events/${event.id}/clip${ext}`,
                download: event.clip_path.split("/").pop(),
                text: "Download"
            }));
        }

        if (event.thumb_path) {
            actions.appendChild(el("a", {
                href: "#",
                text: "Add face to a profile",
                onclick: async (ev) => { ev.preventDefault(); await enrollFromEvent(event); }
            }));
        }

        actions.appendChild(el("a", {
            href: "#",
            text: "Rewrite description",
            title: "Regenerate this description from the current zones and scene guidance",
            onclick: async (ev) => {
                ev.preventDefault();
                try {
                    await api.post(`/events/${event.id}/redescribe`);
                    toast("Description rewritten.", "ok");
                    global.SL.app.refresh();
                } catch (err) {
                    toast(err.message, "error");
                }
            }
        }));

        actions.appendChild(el("span.spacer"));
        actions.appendChild(el("a", {
            href: "#", text: "Delete", style: { color: "var(--error)" },
            onclick: async (ev) => {
                ev.preventDefault();
                const ok = await confirmAction(
                    "Delete this event?",
                    "The event record and its video will be permanently removed.",
                    "Delete"
                );
                if (!ok) return;
                try {
                    await api.del(`/events/${event.id}`);
                    state.expandedId = null;
                    toast("Event deleted.", "ok");
                    global.SL.app.refresh();
                } catch (err) {
                    toast(err.message, "error");
                }
            }
        }));

        if (event.metadata && event.metadata.preRollFrames) {
            actions.appendChild(el("span.small", {
                text: `${event.metadata.preRollFrames} pre-roll frames`
            }));
        }

        container.appendChild(actions);
    }

    /**
     * "That's Jared" straight from an event thumbnail.
     *
     * This is the enrollment path anyone actually uses — hunting for a good
     * photo of someone is a chore, whereas the system has already captured one
     * at exactly the angle and lighting the camera sees them in.
     */
    async function enrollFromEvent(event) {
        let profiles;
        try {
            profiles = await api.get("/profiles");
        } catch (err) {
            toast(err.message, "error");
            return;
        }

        const chosen = await SL.modal("Add this face to a profile", (close) => {
            const select = el("select", [
                ...profiles.map((p) => el("option", { value: String(p.id), text: p.name })),
                el("option", { value: "__new__", text: "+ Create a new profile…" })
            ]);
            const newName = el("input", { type: "text", placeholder: "New profile name" });
            newName.style.display = profiles.length ? "none" : "";
            if (!profiles.length) select.value = "__new__";
            select.addEventListener("change", () => {
                newName.style.display = select.value === "__new__" ? "" : "none";
            });

            return el("div", [
                el("img", {
                    src: `/events/${event.id}/thumb.jpg`,
                    style: { width: "100%", borderRadius: "6px", marginBottom: "12px" }
                }),
                el("label", [el("span", { text: "Profile" }), select]),
                el("label", [newName]),
                el("div.modal-actions", [
                    el("button.btn", { text: "Cancel", onclick: () => close(null) }),
                    el("button.btn", {
                        "data-variant": "primary", text: "Add face",
                        onclick: () => close({ value: select.value, name: newName.value.trim() })
                    })
                ])
            ]);
        });

        if (!chosen) return;

        try {
            let profileId = chosen.value;
            if (profileId === "__new__") {
                if (!chosen.name) { toast("Give the new profile a name.", "error"); return; }
                const created = await api.post("/profiles", { name: chosen.name, clearance: 0 });
                profileId = created.id;
            }
            await api.post(`/profiles/${profileId}/samples`, { eventId: event.id });
            toast("Face added to the profile.", "ok");
        } catch (err) {
            toast(err.message, "error");
        }
    }

    SL.events = { load, render, renderFilters, isPlaying, state, enrollFromEvent };
})(window);
