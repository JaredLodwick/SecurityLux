/**
 * Camera image controls — a gear on the feed, and a panel that overlays it.
 *
 * Deliberately *not* a modal. You are adjusting a picture, so you have to be
 * able to watch the picture change: a dialog with its own little preview and a
 * dimmed backdrop puts a postage stamp of the thing you're tuning in the middle
 * of a greyed-out page. Instead the panel slides in over one edge of the live
 * feed, leaving most of the frame visible and running underneath.
 *
 * Two kinds of adjustment, shown together but labelled apart:
 *
 *   Framing   rotation, mirroring, digital zoom and pan. Applied in software on
 *             the camera, before the JPEG encode.
 *   Image     brightness, contrast, exposure and friends. Applied by the
 *             camera's own driver (V4L2), so they cost no CPU at all.
 *
 * The second group is built entirely from what the camera reports it supports.
 * UVC webcams vary enormously — one might offer eleven controls and another
 * three — so hard-coding a fixed set of sliders would mean showing controls
 * that silently do nothing.
 *
 * Because the transforms happen on the camera, what you see while dragging is
 * exactly what gets recorded and what the detector sees.
 */

(function (global) {
    "use strict";

    const SL = global.SL;
    const { el, clear, api, toast, confirmAction } = SL;

    /**
     * Slider drags fire continuously, and every hardware change shells out to
     * v4l2-ctl on the Pi. Coalesce to one request per burst.
     */
    const COMMIT_DEBOUNCE_MS = 180;

    const ROTATIONS = [
        { value: 0, label: "None" },
        { value: 90, label: "90° clockwise" },
        { value: 180, label: "180° (upside down)" },
        { value: 270, label: "270° (anticlockwise)" }
    ];

    /** camId -> live panel controller. At most one panel per camera. */
    const panels = new Map();

    const GEAR_SVG =
        '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" ' +
        'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
        '<circle cx="12" cy="12" r="3"></circle>' +
        '<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path>' +
        "</svg>";

    // ---------------------------------------------------------------
    //  Public surface
    // ---------------------------------------------------------------

    /**
     * Add the gear button to a camera card's frame. Idempotent — cards are
     * cached and re-rendered, so this must not stack up duplicate buttons.
     *
     * @param {HTMLElement} frame  The `.cam-frame` element.
     * @param {string} camId
     */
    function attachButton(frame, camId) {
        if (!frame || frame.querySelector(".cam-settings-btn")) return;

        const button = el("button.cam-settings-btn", {
            type: "button",
            title: "Adjust image — rotation, zoom, brightness…",
            "aria-label": "Adjust image",
            html: GEAR_SVG
        });
        button.addEventListener("click", (ev) => {
            // The card itself navigates on click in grid view; the gear must not.
            ev.stopPropagation();
            ev.preventDefault();
            toggle(camId, frame);
        });
        frame.appendChild(button);
    }

    function isOpen(camId) {
        return panels.has(camId);
    }

    function toggle(camId, frame) {
        if (panels.has(camId)) close(camId);
        else open(camId, frame);
    }

    function close(camId) {
        const panel = panels.get(camId);
        if (panel) panel.destroy();
    }

    function closeAll() {
        for (const camId of [...panels.keys()]) close(camId);
    }

    /** Find a camera's frame in the DOM when the caller doesn't have it. */
    function frameFor(camId) {
        const card = document.querySelector(
            `.cam-card[data-cam-id="${CSS.escape(camId)}"]`
        );
        return card ? card.querySelector(".cam-frame") : null;
    }

    /**
     * Open the control panel over a camera's feed.
     * @param {string} camId
     * @param {HTMLElement} [frame]  The `.cam-frame` to overlay; looked up if omitted.
     */
    async function open(camId, frame) {
        frame = frame || frameFor(camId);
        if (!frame) return false;
        if (panels.has(camId)) return true;

        // One at a time: two open panels would fight for the same screen and
        // both would be too narrow to use.
        closeAll();

        const root = el("div.cam-controls-panel", { "data-open": "false" });
        root.addEventListener("click", (ev) => ev.stopPropagation());
        root.appendChild(el("div.cam-controls-body", [
            el("div.cam-controls-loading", { text: "Reading camera…" })
        ]));
        frame.appendChild(root);
        // Next frame, so the slide-in transition actually runs.
        requestAnimationFrame(() => { root.dataset.open = "true"; });

        const controller = createController(camId, root, frame);
        panels.set(camId, controller);
        await controller.load();
        return true;
    }

    // ---------------------------------------------------------------
    //  Panel controller
    // ---------------------------------------------------------------

    function createController(camId, root, frame) {
        let state = null;
        let commitTimer = null;
        let destroyed = false;
        let rotationChanged = false;

        const pending = { image: {}, values: {} };

        const onDocumentKey = (ev) => { if (ev.key === "Escape") destroy(); };
        document.addEventListener("keydown", onDocumentKey);

        function destroy() {
            if (destroyed) return;
            destroyed = true;
            document.removeEventListener("keydown", onDocumentKey);
            if (commitTimer) { clearTimeout(commitTimer); commit(); }
            panels.delete(camId);

            root.dataset.open = "false";
            // Let the slide-out finish before removing, but don't leak the node
            // if the card is torn down first.
            setTimeout(() => { if (root.parentNode) root.remove(); }, 180);

            if (rotationChanged) offerZoneRedraw();
        }

        async function offerZoneRedraw() {
            if (!state || !state.zone_count) return;
            const redraw = await confirmAction(
                "Redraw your zones?",
                "You rotated the camera, so the zones you had drawn no longer line up " +
                "with what it sees. Open the zone editor now?",
                "Open zone editor"
            );
            if (redraw && SL.zones) await SL.zones.open(camId);
        }

        // -- server round trips ----------------------------------------

        async function load() {
            try {
                state = await api.get(`/cam/${encodeURIComponent(camId)}/controls`);
                if (!destroyed) render();
            } catch (err) {
                if (destroyed) return;
                clear(root).appendChild(el("div.cam-controls-body", [
                    header(),
                    el("div.cam-controls-error", { text: err.message })
                ]));
            }
        }

        function scheduleCommit() {
            if (commitTimer) clearTimeout(commitTimer);
            commitTimer = setTimeout(commit, COMMIT_DEBOUNCE_MS);
        }

        async function commit() {
            commitTimer = null;
            const payload = {};
            if (Object.keys(pending.image).length) payload.image = { ...pending.image };
            if (Object.keys(pending.values).length) payload.values = { ...pending.values };
            if (!Object.keys(payload).length) return;

            pending.image = {};
            pending.values = {};

            try {
                const next = await api.put(`/cam/${encodeURIComponent(camId)}/controls`, payload);
                if (destroyed) return;
                applyState(next);
            } catch (err) {
                toast(err.message, "error");
                if (!destroyed) await load();
            }
        }

        /**
         * Re-render from the server's view without stealing focus.
         *
         * A commit lands mid-drag, so the slider the user is still holding must
         * not be replaced underneath them.
         */
        function applyState(next) {
            const active = document.activeElement;
            const key = active && active.dataset ? active.dataset.controlKey : null;
            state = next;
            render();
            if (key) {
                const restored = root.querySelector(`[data-control-key="${key}"]`);
                if (restored) restored.focus();
            }
        }

        // -- pieces ----------------------------------------------------

        function header() {
            return el("div.cam-controls-header", [
                el("span", { text: "Adjust image" }),
                el("span.spacer"),
                el("button.cam-controls-close", {
                    type: "button", title: "Close", "aria-label": "Close", text: "✕",
                    onclick: destroy
                })
            ]);
        }

        function row({ label, help, control, inactive }) {
            const node = el("div.cam-control-row", [
                el("div.cam-control-label", [
                    el("span", { text: label }),
                    help ? el("span.cam-control-help", { text: help }) : null
                ]),
                el("div.cam-control-input", [control])
            ]);
            if (inactive) node.dataset.inactive = "true";
            return node;
        }

        function toggleSwitch(key, checked, onChange) {
            const sw = el("button.switch", {
                type: "button", role: "switch",
                "aria-checked": String(checked),
                "data-control-key": key
            });
            sw.addEventListener("click", () => {
                const next = sw.getAttribute("aria-checked") !== "true";
                sw.setAttribute("aria-checked", String(next));
                onChange(next);
            });
            return sw;
        }

        function slider({ key, value, min, max, step, format, onInput }) {
            const readout = el("span.slider-value", { text: format(value) });
            const input = el("input.slider", {
                type: "range",
                min: String(min), max: String(max), step: String(step),
                value: String(value),
                "data-control-key": key
            });
            input.addEventListener("input", () => {
                readout.textContent = format(input.value);
                onInput(Number(input.value));
            });
            return el("div.slider-wrap", [input, readout]);
        }

        // -- framing ---------------------------------------------------

        function framingSection() {
            const image = state.image || {};
            const section = el("div.cam-controls-section", [
                el("h4", { text: "Framing" })
            ]);

            const rotation = el("select", {
                "data-control-key": "rotation",
                onchange: async (ev) => {
                    const value = Number(ev.target.value);
                    // Zones are normalized coordinates on the *rotated* image, so
                    // turning the picture moves it underneath them.
                    if (state.zone_count > 0 && value !== Number(image.rotation)) {
                        const ok = await confirmAction(
                            "Rotating will invalidate your zones",
                            `This camera has ${state.zone_count} zone(s) drawn on the current ` +
                            "orientation. Rotating moves the picture underneath them, so they'll " +
                            "point at the wrong places — and any ignore regions will stop " +
                            "working — until you redraw them.",
                            "Rotate anyway"
                        );
                        if (!ok) { ev.target.value = String(image.rotation || 0); return; }
                        rotationChanged = true;
                    }
                    pending.image.rotation = value;
                    scheduleCommit();
                }
            }, ROTATIONS.map((r) => el("option", {
                value: String(r.value), text: r.label,
                selected: Number(image.rotation) === r.value
            })));

            section.appendChild(row({ label: "Rotation", control: rotation }));

            section.appendChild(row({
                label: "Mirror ↔",
                control: toggleSwitch("flipHorizontal", !!image.flipHorizontal, (v) => {
                    pending.image.flipHorizontal = v;
                    scheduleCommit();
                })
            }));

            section.appendChild(row({
                label: "Mirror ↕",
                control: toggleSwitch("flipVertical", !!image.flipVertical, (v) => {
                    pending.image.flipVertical = v;
                    scheduleCommit();
                })
            }));

            const zoom = Number(image.zoom) || 1;
            section.appendChild(row({
                label: "Zoom",
                control: slider({
                    key: "zoom", value: zoom, min: 1, max: 4, step: 0.1,
                    format: (v) => `${Number(v).toFixed(1)}×`,
                    onInput: (v) => { pending.image.zoom = v; scheduleCommit(); }
                })
            }));

            // Pan does nothing at 1x, so don't offer it — a control with no
            // effect is worse than no control.
            if (zoom > 1.001) {
                section.appendChild(row({
                    label: "Pan ↔",
                    control: slider({
                        key: "panX", value: Number(image.panX) || 0, min: -1, max: 1, step: 0.05,
                        format: (v) => Number(v).toFixed(2),
                        onInput: (v) => { pending.image.panX = v; scheduleCommit(); }
                    })
                }));
                section.appendChild(row({
                    label: "Pan ↕",
                    control: slider({
                        key: "panY", value: Number(image.panY) || 0, min: -1, max: 1, step: 0.05,
                        format: (v) => Number(v).toFixed(2),
                        onInput: (v) => { pending.image.panY = v; scheduleCommit(); }
                    })
                }));
            }

            return section;
        }

        // -- hardware --------------------------------------------------

        function imageSection() {
            const section = el("div.cam-controls-section", [
                el("h4", [
                    "Image",
                    el("span.cam-controls-note", { text: "no CPU cost" })
                ])
            ]);

            if (!state.controls_available) {
                section.appendChild(el("div.cam-controls-note-block", {
                    text: state.connected
                        ? "This camera doesn't expose adjustable image controls. Usually that " +
                          "means v4l2-ctl isn't installed on the camera Pi " +
                          "(sudo apt install v4l-utils), or it's running the mock camera " +
                          "because no webcam was found."
                        : "Connect the camera to see which controls it supports."
                }));
                return section;
            }

            if (!state.controls.length) {
                section.appendChild(el("div.cam-controls-note-block", {
                    text: "No supported controls were reported."
                }));
                return section;
            }

            for (const control of state.controls) section.appendChild(controlRow(control));
            return section;
        }

        function controlRow(control) {
            const stored = state.stored_values || {};
            const value = stored[control.id] !== undefined ? stored[control.id] : control.value;

            let input;
            if (control.kind === "bool") {
                input = toggleSwitch(control.id, Number(value) === 1, (on) => {
                    pending.values[control.id] = on ? 1 : 0;
                    scheduleCommit();
                    if (isAutoFlag(control.id)) setTimeout(load, 500);
                });
            } else if (control.kind === "menu" && control.options) {
                input = el("select", {
                    "data-control-key": control.id,
                    onchange: (ev) => {
                        pending.values[control.id] = Number(ev.target.value);
                        scheduleCommit();
                        // Auto flags gate other controls; re-probe to pick up
                        // what just became (in)active.
                        if (isAutoFlag(control.id)) setTimeout(load, 500);
                    }
                }, control.options.map((option) => el("option", {
                    value: String(option.value), text: option.label,
                    selected: Number(value) === option.value
                })));
            } else {
                input = slider({
                    key: control.id,
                    value: Number(value),
                    min: control.min ?? 0,
                    max: control.max ?? 100,
                    step: control.step || 1,
                    format: (v) => String(Math.round(v)),
                    onInput: (n) => {
                        pending.values[control.id] = Math.round(n);
                        scheduleCommit();
                    }
                });
            }

            return row({
                label: control.label,
                help: control.inactive
                    ? "Controlled automatically — turn the matching auto setting off to use it."
                    : null,
                control: input,
                inactive: control.inactive
            });
        }

        function isAutoFlag(id) {
            return id === "auto_exposure" || id === "white_balance_automatic";
        }

        // -- assembly --------------------------------------------------

        function render() {
            const body = el("div.cam-controls-body");

            if (!state.connected) {
                body.appendChild(el("div.cam-controls-note-block", {
                    text: "Camera offline. Changes are saved and applied when it reconnects."
                }));
            }
            if (state.errors && Object.keys(state.errors).length) {
                body.appendChild(el("div.cam-controls-note-block", { dataset: { kind: "warn" } }, [
                    "The camera rejected: " +
                    Object.keys(state.errors).join(", ")
                ]));
            }

            body.appendChild(framingSection());
            body.appendChild(imageSection());

            body.appendChild(el("div.cam-controls-footer", [
                el("button.btn.btn-icon", {
                    text: "Reset",
                    title: "Restore framing and image settings to the camera's defaults",
                    onclick: async () => {
                        const ok = await confirmAction(
                            "Reset all adjustments?",
                            "Framing returns to unrotated and unzoomed, and every image control " +
                            "goes back to the camera's own default.",
                            "Reset"
                        );
                        if (!ok) return;
                        try {
                            applyState(await api.post(
                                `/cam/${encodeURIComponent(camId)}/controls/reset`, {}
                            ));
                            toast("Adjustments reset.", "ok");
                        } catch (err) {
                            toast(err.message, "error");
                        }
                    }
                }),
                el("button.btn.btn-icon", {
                    text: "Re-detect",
                    title: "Ask the camera which controls it supports — use after swapping webcams",
                    onclick: async () => {
                        try {
                            await api.post(`/cam/${encodeURIComponent(camId)}/controls/refresh`, {});
                            setTimeout(load, 700);
                            toast("Re-probing the camera…", "ok");
                        } catch (err) {
                            toast(err.message, "error");
                        }
                    }
                }),
                el("span.spacer"),
                state.resolution
                    ? el("span.cam-controls-res", { text: state.resolution })
                    : null
            ]));

            clear(root);
            root.appendChild(header());
            root.appendChild(body);
        }

        return { load, destroy, get camId() { return camId; }, frame };
    }

    SL.controls = { attachButton, open, close, closeAll, toggle, isOpen };
})(window);
