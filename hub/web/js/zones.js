/**
 * Zone editor — draw and name regions on a camera's view.
 *
 * This is what makes "Someone approached the trash room door" possible. The
 * hub knows a person's feet were at (0.31, 0.78); only you can say that spot is
 * the trash room door.
 *
 * Drawn on a still snapshot rather than the live MJPEG stream. Two reasons:
 * dragging a rectangle over moving video is unpleasant to aim, and the live
 * stream would hold a connection slot for as long as the editor is open.
 *
 * Coordinates are normalized 0-1, so zones stay correct if the camera's
 * resolution changes or the browser renders the feed at a different size.
 */

(function (global) {
    "use strict";

    const SL = global.SL;
    const { el, clear, api, toast, confirmAction } = SL;

    const SVG_NS = "http://www.w3.org/2000/svg";

    const KIND_HELP = {
        door: "A doorway or entrance. Described as “went up to / at”, and it's what the " +
              "door light treats as worth guarding.",
        path: "A walkway, driveway, or sidewalk. Described as “came up / along”.",
        area: "Any other named region. Described as “went into / in”.",
        ignore: "Detections here are discarded entirely. Use this for a swaying branch, " +
                "a neighbour's window, or a road with passing cars."
    };

    function svgEl(tag, attrs) {
        const node = document.createElementNS(SVG_NS, tag);
        for (const [k, v] of Object.entries(attrs || {})) {
            if (v === null || v === undefined) continue;
            node.setAttribute(k, String(v));
        }
        return node;
    }

    /**
     * Open the editor for one camera.
     * @returns {Promise<boolean>} whether zones were saved
     */
    async function open(camId) {
        let zones;
        try {
            zones = await api.get(`/cam/${encodeURIComponent(camId)}/zones`);
        } catch (err) {
            toast(err.message, "error");
            return false;
        }

        // Work on a copy; nothing is written until Save.
        const draft = zones.map((z) => ({
            name: z.name, kind: z.kind, points: z.points.map((p) => ({ ...p }))
        }));
        let selected = draft.length ? 0 : -1;

        const saved = await SL.modal(`Zones — ${camId}`, (close) => {
            const svg = svgEl("svg", { viewBox: "0 0 1 1", preserveAspectRatio: "none" });
            const listHost = el("div.zone-list");

            const snapshot = el("img", {
                src: `/cam/${encodeURIComponent(camId)}/snapshot.jpg?t=${Date.now()}`,
                alt: `${camId} snapshot`
            });
            snapshot.addEventListener("error", () => {
                canvasWrap.replaceChildren(el("div.empty", {
                    text: "Couldn't get a snapshot — is the camera connected and switched on? " +
                          "You can still edit zone names, but not redraw them."
                }), svg);
            });

            const canvasWrap = el("div.zone-canvas-wrap", [snapshot, svg]);

            function redraw() {
                clear(svg);
                draft.forEach((zone, index) => {
                    svg.appendChild(svgEl("polygon", {
                        points: zone.points.map((p) => `${p.x},${p.y}`).join(" "),
                        class: "zone-shape",
                        "data-kind": zone.kind,
                        "data-selected": String(index === selected)
                    }));
                });
                // Labels are HTML overlays rather than <text>: the SVG uses a
                // 0-1 viewBox so any font-size inside it renders microscopically.
                renderOverlayLabels();
                renderList();
            }

            const labelHost = el("div", {
                style: { position: "absolute", inset: "0", pointerEvents: "none" }
            });
            canvasWrap.appendChild(labelHost);

            function renderOverlayLabels() {
                clear(labelHost);
                draft.forEach((zone, index) => {
                    const minX = Math.min(...zone.points.map((p) => p.x));
                    const minY = Math.min(...zone.points.map((p) => p.y));
                    labelHost.appendChild(el("div", {
                        text: zone.name,
                        style: {
                            position: "absolute",
                            left: `${minX * 100}%`,
                            top: `${minY * 100}%`,
                            transform: "translateY(-100%)",
                            font: "600 11px system-ui",
                            color: index === selected ? "var(--accent)" : "#fff",
                            textShadow: "0 0 3px #000, 0 0 3px #000",
                            padding: "1px 3px",
                            whiteSpace: "nowrap"
                        }
                    }));
                });
            }

            function renderList() {
                clear(listHost);
                if (!draft.length) {
                    listHost.appendChild(el("div.empty.small", {
                        text: "No zones yet. Drag a box on the snapshot to draw one."
                    }));
                }
                draft.forEach((zone, index) => {
                    const nameInput = el("input", {
                        type: "text", value: zone.name, placeholder: "Zone name",
                        oninput: (ev) => { zone.name = ev.target.value; renderOverlayLabels(); }
                    });
                    const kindSelect = el("select", ["door", "path", "area", "ignore"].map((k) =>
                        el("option", { value: k, text: k, selected: k === zone.kind })));
                    kindSelect.addEventListener("change", () => {
                        zone.kind = kindSelect.value;
                        redraw();
                    });

                    listHost.appendChild(el("div.zone-item", {
                        dataset: { selected: String(index === selected) },
                        onclick: () => { selected = index; redraw(); }
                    }, [
                        nameInput,
                        el("div.zone-item-row", [
                            kindSelect,
                            el("button.btn.btn-icon", {
                                title: "Delete this zone", text: "✕",
                                onclick: (ev) => {
                                    ev.stopPropagation();
                                    draft.splice(index, 1);
                                    selected = Math.min(selected, draft.length - 1);
                                    redraw();
                                }
                            })
                        ]),
                        el("div.setting-help", { text: KIND_HELP[zone.kind] || "" })
                    ]));
                });
            }

            // --- drag to draw ---------------------------------------
            let dragStart = null;
            let preview = null;

            function pointFromEvent(ev) {
                const rect = svg.getBoundingClientRect();
                const clientX = ev.touches ? ev.touches[0].clientX : ev.clientX;
                const clientY = ev.touches ? ev.touches[0].clientY : ev.clientY;
                return {
                    x: Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)),
                    y: Math.min(1, Math.max(0, (clientY - rect.top) / rect.height))
                };
            }

            svg.addEventListener("pointerdown", (ev) => {
                ev.preventDefault();
                svg.setPointerCapture(ev.pointerId);
                dragStart = pointFromEvent(ev);
                preview = svgEl("rect", { class: "zone-shape", "data-kind": "area" });
                svg.appendChild(preview);
            });

            svg.addEventListener("pointermove", (ev) => {
                if (!dragStart || !preview) return;
                const now = pointFromEvent(ev);
                preview.setAttribute("x", String(Math.min(dragStart.x, now.x)));
                preview.setAttribute("y", String(Math.min(dragStart.y, now.y)));
                preview.setAttribute("width", String(Math.abs(now.x - dragStart.x)));
                preview.setAttribute("height", String(Math.abs(now.y - dragStart.y)));
            });

            svg.addEventListener("pointerup", (ev) => {
                if (!dragStart) return;
                const end = pointFromEvent(ev);
                const start = dragStart;
                dragStart = null;
                if (preview) { preview.remove(); preview = null; }

                // Ignore stray clicks — a zone needs real area to be meaningful.
                if (Math.abs(end.x - start.x) < 0.03 || Math.abs(end.y - start.y) < 0.03) {
                    redraw();
                    return;
                }

                const left = Math.min(start.x, end.x);
                const right = Math.max(start.x, end.x);
                const top = Math.min(start.y, end.y);
                const bottom = Math.max(start.y, end.y);

                draft.push({
                    name: `Zone ${draft.length + 1}`,
                    kind: "area",
                    points: [
                        { x: left, y: top }, { x: right, y: top },
                        { x: right, y: bottom }, { x: left, y: bottom }
                    ]
                });
                selected = draft.length - 1;
                redraw();
                const input = listHost.querySelector('.zone-item[data-selected="true"] input');
                if (input) { input.focus(); input.select(); }
            });

            redraw();

            const box = el("div", [
                el("p.small.muted", {
                    text: "Drag on the snapshot to draw a zone, then name it. Names are used " +
                          "verbatim in event descriptions, so “trash room door” reads better " +
                          "than “Zone 2”. A person is judged to be in a zone by where their " +
                          "feet are, not their middle."
                }),
                el("div.zone-editor", [canvasWrap, listHost]),
                el("div.modal-actions", [
                    el("button.btn", { text: "Cancel", onclick: () => close(false) }),
                    el("button.btn", {
                        "data-variant": "primary", text: "Save zones",
                        onclick: async () => {
                            const named = draft.filter((z) => z.name && z.name.trim());
                            if (named.length !== draft.length) {
                                toast("Every zone needs a name.", "error");
                                return;
                            }
                            try {
                                await api.put(`/cam/${encodeURIComponent(camId)}/zones`, named);
                                close(true);
                            } catch (err) {
                                toast(err.message, "error");
                            }
                        }
                    })
                ])
            ]);
            return box;
        });

        if (saved !== true) return false;

        toast("Zones saved.", "ok");

        // Offer to re-run descriptions over history. Renaming "Zone 2" to
        // "Trash room door" should fix what past events say, not just future
        // ones — otherwise the log stays wrong forever.
        const rewrite = await confirmAction(
            "Update past events?",
            "Rewrite the descriptions of existing events for this camera using the zones " +
            "you just saved. Without this, older events keep their original wording.",
            "Rewrite descriptions"
        );
        if (rewrite) {
            try {
                const result = await api.post("/events/redescribe", { cam: camId });
                toast(`Rewrote ${result.updated} event description(s).`, "ok");
            } catch (err) {
                toast(err.message, "error");
            }
        }
        return true;
    }

    SL.zones = { open };
})(window);
