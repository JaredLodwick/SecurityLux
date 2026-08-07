/**
 * Camera image control panel.
 *
 * Two kinds of adjustment, deliberately shown together but labelled apart:
 *
 *   Framing   rotation, mirroring, digital zoom and pan. Applied in software on
 *             the camera, before the JPEG encode.
 *   Image     brightness, contrast, exposure and friends. Applied by the
 *             camera's own driver (V4L2), so they cost no CPU at all.
 *
 * The second group is built entirely from what the camera reports it supports.
 * UVC webcams vary enormously — one might offer eleven controls and another
 * three — so hard-coding a fixed set of sliders would mean showing controls
 * that silently do nothing. Nothing is rendered here that the camera didn't
 * say it has.
 *
 * The live feed sits next to the controls because adjusting brightness without
 * seeing the result is guesswork. Since the transforms happen on the camera,
 * the stream shows the real effect within a frame or two — what you see is
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
        { value: 270, label: "270° (90° anticlockwise)" }
    ];

    async function open(camId) {
        let state;
        try {
            state = await api.get(`/cam/${encodeURIComponent(camId)}/controls`);
        } catch (err) {
            toast(err.message, "error");
            return false;
        }

        let changed = false;
        let rotationChanged = false;

        await SL.modal(`Camera adjustments — ${state.cam_id}`, (close) => {
            const host = el("div.controls-panel");
            const pending = { image: {}, values: {} };
            let commitTimer = null;
            let keeper = null;

            // -- committing ------------------------------------------

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
                    const next = await api.put(
                        `/cam/${encodeURIComponent(camId)}/controls`, payload
                    );
                    changed = true;
                    applyState(next, { keepFocus: true });
                } catch (err) {
                    toast(err.message, "error");
                    await reload();
                }
            }

            async function reload() {
                try {
                    applyState(await api.get(`/cam/${encodeURIComponent(camId)}/controls`));
                } catch (err) {
                    toast(err.message, "error");
                }
            }

            /**
             * Re-render from the server's view.
             *
             * `keepFocus` avoids stealing focus mid-drag: after a commit we want
             * the numbers refreshed but the slider the user is still holding
             * must not be replaced underneath them.
             */
            function applyState(next, { keepFocus } = {}) {
                const active = keepFocus ? document.activeElement : null;
                const activeKey = active && active.dataset ? active.dataset.controlKey : null;
                state = next;
                render();
                if (activeKey) {
                    const restored = host.querySelector(`[data-control-key="${activeKey}"]`);
                    if (restored) restored.focus();
                }
            }

            // -- preview ---------------------------------------------

            /**
             * The preview stream is created once and re-parented on every
             * re-render, never rebuilt.
             *
             * Rebuilding it would create a new StreamKeeper per commit and
             * orphan the previous one, leaking one of the browser's ~6
             * connections per origin on every slider drag — the same failure
             * that caused the original feed blackout.
             */
            function buildPreview() {
                const frame = el("div.controls-preview");

                if (!state.connected) {
                    if (keeper) keeper.setActive(false);
                    frame.appendChild(el("div.placeholder", {
                        text: "Camera is offline. You can still change these settings — " +
                              "they'll be applied when it reconnects."
                    }));
                    return frame;
                }

                if (!keeper) {
                    keeper = new global.StreamKeeper({
                        streamUrl: () => `/cam/${encodeURIComponent(camId)}/stream.mjpg`,
                        alt: `${camId} live preview`,
                        logger: console
                    });
                }
                keeper.setActive(true);
                frame.appendChild(keeper.element);   // appendChild moves, not copies
                return frame;
            }

            // -- framing (geometry) ----------------------------------

            function buildFraming() {
                const image = state.image || {};
                const group = el("div.settings-group", [el("h3", { text: "Framing" })]);

                const rotationSelect = el("select", {
                    "data-control-key": "rotation",
                    onchange: async (ev) => {
                        const value = Number(ev.target.value);
                        // Zones are normalized coordinates on the *rotated*
                        // image, so turning the picture makes existing zones
                        // point at the wrong places. Better to say so than to
                        // let detection quietly misbehave.
                        if (state.zone_count > 0 && value !== Number(image.rotation)) {
                            const ok = await confirmAction(
                                "Rotating will invalidate your zones",
                                `This camera has ${state.zone_count} zone(s) drawn on the ` +
                                "current orientation. Rotating moves the picture underneath " +
                                "them, so they'll point at the wrong places until you redraw " +
                                "them. Event descriptions and any ignore regions will be " +
                                "wrong in the meantime.",
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

                group.appendChild(row({
                    label: "Rotation",
                    help: "Use this when the camera is mounted sideways or upside down.",
                    control: rotationSelect
                }));

                group.appendChild(row({
                    label: "Mirror horizontally",
                    help: "Flips left and right.",
                    control: toggle("flipHorizontal", !!image.flipHorizontal, (value) => {
                        pending.image.flipHorizontal = value;
                        scheduleCommit();
                    })
                }));

                group.appendChild(row({
                    label: "Mirror vertically",
                    control: toggle("flipVertical", !!image.flipVertical, (value) => {
                        pending.image.flipVertical = value;
                        scheduleCommit();
                    })
                }));

                const zoom = Number(image.zoom) || 1;
                group.appendChild(row({
                    label: "Digital zoom",
                    help: "Crops in and scales back up. No extra detail is recovered, but " +
                          "it fills the frame with the part you care about — and the " +
                          "detector sees a larger person too.",
                    control: slider({
                        key: "zoom", value: zoom, min: 1, max: 4, step: 0.1,
                        format: (v) => `${Number(v).toFixed(1)}×`,
                        onInput: (value) => {
                            pending.image.zoom = value;
                            scheduleCommit();
                        }
                    })
                }));

                // Pan does nothing at 1x, so don't offer it — a control with no
                // effect is worse than no control.
                if (zoom > 1.001) {
                    group.appendChild(row({
                        label: "Pan horizontally",
                        control: slider({
                            key: "panX", value: Number(image.panX) || 0,
                            min: -1, max: 1, step: 0.05,
                            format: (v) => Number(v).toFixed(2),
                            onInput: (value) => { pending.image.panX = value; scheduleCommit(); }
                        })
                    }));
                    group.appendChild(row({
                        label: "Pan vertically",
                        control: slider({
                            key: "panY", value: Number(image.panY) || 0,
                            min: -1, max: 1, step: 0.05,
                            format: (v) => Number(v).toFixed(2),
                            onInput: (value) => { pending.image.panY = value; scheduleCommit(); }
                        })
                    }));
                }

                return group;
            }

            // -- image quality (V4L2 hardware controls) ---------------

            function buildHardware() {
                const group = el("div.settings-group", [
                    el("h3", [
                        "Image",
                        el("span.small.muted", {
                            text: "  applied by the camera — no CPU cost",
                            style: { fontWeight: "400" }
                        })
                    ])
                ]);

                if (!state.controls_available) {
                    group.appendChild(el("div.setting-row", [
                        el("div.setting-help", {
                            text: state.connected
                                ? "This camera doesn't expose any adjustable image controls. " +
                                  "That usually means v4l2-ctl isn't installed on the camera Pi " +
                                  "(sudo apt install v4l-utils), or it's running the mock camera " +
                                  "because no real webcam was found."
                                : "Connect the camera to see which controls it supports."
                        })
                    ]));
                    return group;
                }

                if (!state.controls.length) {
                    group.appendChild(el("div.setting-row", [
                        el("div.setting-help", { text: "No supported controls were reported." })
                    ]));
                    return group;
                }

                for (const control of state.controls) {
                    group.appendChild(buildControlRow(control));
                }
                return group;
            }

            function buildControlRow(control) {
                const stored = state.stored_values || {};
                const value = stored[control.id] !== undefined
                    ? stored[control.id]
                    : control.value;

                let input;
                if (control.kind === "bool") {
                    input = toggle(control.id, Number(value) === 1, (on) => {
                        pending.values[control.id] = on ? 1 : 0;
                        scheduleCommit();
                        // Auto flags gate other controls, so re-probe shortly
                        // after to pick up what just became (in)active.
                        if (isAutoFlag(control.id)) setTimeout(reload, 500);
                    });
                } else if (control.kind === "menu" && control.options) {
                    input = el("select", {
                        "data-control-key": control.id,
                        onchange: (ev) => {
                            pending.values[control.id] = Number(ev.target.value);
                            scheduleCommit();
                            if (isAutoFlag(control.id)) setTimeout(reload, 500);
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

                const isDefault = control.default !== null
                    && control.default !== undefined
                    && Number(value) === Number(control.default);

                const help = [];
                if (control.help) help.push(control.help);
                if (control.inactive) {
                    help.push("Currently inactive — the camera is controlling this " +
                              "automatically. Turn the matching auto setting off to use it.");
                }
                if (!isDefault && control.default !== null && control.default !== undefined) {
                    help.push(`Camera default: ${control.default}.`);
                }

                const rowEl = row({
                    label: control.label,
                    help: help.join(" "),
                    control: input
                });
                if (control.inactive) rowEl.dataset.inactive = "true";
                return rowEl;
            }

            function isAutoFlag(id) {
                return id === "auto_exposure" || id === "white_balance_automatic";
            }

            // -- small builders --------------------------------------

            function row({ label, help, control }) {
                return el("div.setting-row", [
                    el("div", [
                        el("div.setting-label", { text: label }),
                        help ? el("div.setting-help", { text: help }) : null
                    ]),
                    el("div.setting-control", [control])
                ]);
            }

            function toggle(key, checked, onChange) {
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

            // -- assembly --------------------------------------------

            function render() {
                clear(host);

                const notices = el("div");
                if (state.errors && Object.keys(state.errors).length) {
                    notices.appendChild(el("div.banner", { dataset: { kind: "warn" } }, [
                        el("div.banner-title", { text: "The camera rejected some controls" }),
                        el("div.small", {
                            text: Object.entries(state.errors)
                                .map(([k, v]) => `${k}: ${v}`).join("  ·  ")
                        })
                    ]));
                }
                if (!state.connected) {
                    notices.appendChild(el("div.banner", { dataset: { kind: "warn" } }, [
                        el("div.banner-title", { text: "Camera offline" }),
                        el("div.small", {
                            text: "Changes are saved and applied when it reconnects."
                        })
                    ]));
                }
                host.appendChild(notices);

                const columns = el("div.controls-layout", [
                    el("div.controls-preview-column", [
                        buildPreview(),
                        el("div.small.muted", {
                            style: { marginTop: "8px" },
                            text: state.resolution
                                ? `Output: ${state.resolution}${
                                    Number((state.image || {}).rotation) % 180 === 90
                                        ? " (rotated)" : ""}`
                                : ""
                        }),
                        el("div.small.muted", {
                            text: "Adjustments are applied on the camera, so what you see " +
                                  "here is exactly what gets recorded and what the detector sees."
                        })
                    ]),
                    el("div.controls-settings-column", [buildFraming(), buildHardware()])
                ]);
                host.appendChild(columns);
            }

            render();

            // Tear the preview stream down on close, or it keeps holding one of
            // the browser's few per-origin connections after the panel is gone.
            const finish = async (value) => {
                if (commitTimer) { clearTimeout(commitTimer); await commit(); }
                if (keeper) { keeper.destroy(); keeper = null; }
                close(value);
            };

            return el("div", [
                host,
                el("div.modal-actions", [
                    el("button.btn", {
                        text: "Reset to defaults",
                        title: "Restore framing and image settings to the camera's own defaults",
                        onclick: async () => {
                            const ok = await confirmAction(
                                "Reset all adjustments?",
                                "Framing returns to unrotated and unzoomed, and every image " +
                                "control goes back to the camera's own default.",
                                "Reset"
                            );
                            if (!ok) return;
                            try {
                                applyState(await api.post(
                                    `/cam/${encodeURIComponent(camId)}/controls/reset`, {}
                                ));
                                changed = true;
                                toast("Adjustments reset.", "ok");
                            } catch (err) {
                                toast(err.message, "error");
                            }
                        }
                    }),
                    el("button.btn", {
                        text: "Re-detect",
                        title: "Ask the camera which controls it supports — use after swapping the webcam",
                        onclick: async () => {
                            try {
                                await api.post(`/cam/${encodeURIComponent(camId)}/controls/refresh`, {});
                                setTimeout(reload, 700);
                                toast("Re-probing the camera…", "ok");
                            } catch (err) {
                                toast(err.message, "error");
                            }
                        }
                    }),
                    el("span.spacer"),
                    el("button.btn", {
                        "data-variant": "primary", text: "Done",
                        onclick: () => finish(true)
                    })
                ])
            ]);
        }, { wide: true });

        if (rotationChanged) {
            const redraw = await confirmAction(
                "Redraw your zones?",
                "You rotated the camera, so the zones you had drawn no longer line up " +
                "with what it sees. Open the zone editor now to redraw them?",
                "Open zone editor"
            );
            if (redraw) await SL.zones.open(camId);
        }

        return changed;
    }

    SL.controls = { open };
})(window);
