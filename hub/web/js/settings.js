/**
 * Settings and storage screens.
 *
 * Every control here is generated from `GET /settings/schema` — the same
 * declaration the hub validates against. Nothing about a setting's type,
 * bounds, label, or help text is duplicated in this file, so it is structurally
 * impossible for the UI to offer a value the hub will reject, or to quietly
 * omit a setting that was added on the server.
 */

(function (global) {
    "use strict";

    const SL = global.SL;
    const { el, clear, api, toast, formatBytes, confirmAction } = SL;

    let schema = null;      // { groups, settings }

    async function loadSchema() {
        if (!schema) schema = await api.get("/settings/schema");
        return schema;
    }

    // ---------------------------------------------------------------
    //  Controls
    // ---------------------------------------------------------------

    function buildControl(key, def, value, onCommit) {
        if (def.type === "boolean") {
            const sw = el("button.switch", {
                type: "button",
                role: "switch",
                "aria-checked": String(!!value),
                "aria-label": def.label
            });
            sw.addEventListener("click", () => {
                const next = sw.getAttribute("aria-checked") !== "true";
                sw.setAttribute("aria-checked", String(next));
                onCommit(key, next);
            });
            return sw;
        }

        if (def.type === "enum") {
            const select = el("select", def.values.map((v) => el("option", {
                value: v, text: v, selected: v === value
            })));
            select.addEventListener("change", () => onCommit(key, select.value));
            return select;
        }

        if (def.type === "string") {
            // Long-form fields (scene guidance) get a textarea; short ones an input.
            const isLong = key === "events.sceneDescription";
            const input = el(isLong ? "textarea" : "input", {
                type: isLong ? undefined : "text",
                value: value == null ? "" : String(value),
                placeholder: def.label
            });
            if (isLong) input.value = value == null ? "" : String(value);
            // Commit on blur, not per keystroke — a PUT per character would
            // hammer the hub and fight the poll loop for the input's value.
            input.addEventListener("blur", () => onCommit(key, input.value));
            return input;
        }

        const input = el("input", {
            type: "number",
            value: value == null ? "" : String(value),
            min: def.min, max: def.max,
            step: def.type === "int" ? 1 : "any"
        });
        input.addEventListener("change", () => {
            const n = Number(input.value);
            if (!isFinite(n)) { toast(`${def.label} must be a number`, "error"); return; }
            onCommit(key, n);
        });
        return input;
    }

    function buildRow(key, def, value, isOverridden, onCommit) {
        const wide = def.type === "string" && key === "events.sceneDescription";
        return el("div.setting-row", { dataset: { wide: String(wide) } }, [
            el("div", [
                el("div.setting-label", [
                    def.label,
                    isOverridden ? el("span.setting-overridden", { text: "  • overridden" }) : null
                ]),
                def.help ? el("div.setting-help", { text: def.help }) : null
            ]),
            el("div.setting-control", [
                buildControl(key, def, value, onCommit),
                def.unit ? el("span.setting-unit", { text: def.unit }) : null
            ])
        ]);
    }

    /**
     * Render one screen's worth of settings.
     *
     * @param {object} opts
     * @param {string[]} opts.groups     Which schema groups to include.
     * @param {object} opts.values       Resolved values.
     * @param {object} opts.overrides    Keys explicitly set at this scope.
     * @param {string} [opts.camId]      Scope; omit for hub-wide.
     * @param {Function} opts.onSaved
     */
    function renderGroups({ groups, values, overrides, camId, onSaved }) {
        const container = el("div.settings-groups");

        const commit = async (key, value) => {
            const path = camId ? `/cam/${encodeURIComponent(camId)}/settings` : "/settings";
            try {
                await api.put(path, { [key]: value });
                toast(`${schema.settings[key].label} saved.`, "ok");
                if (onSaved) onSaved();
            } catch (err) {
                toast(err.message, "error");
                if (onSaved) onSaved();      // re-render to snap the control back
            }
        };

        for (const groupKey of groups) {
            const entries = Object.entries(schema.settings).filter(([key, def]) => {
                if (def.group !== groupKey) return false;
                if (camId) return def.scope === "camera" || def.scope === "both";
                return def.scope === "global" || def.scope === "both";
            });
            if (!entries.length) continue;

            const basic = entries.filter(([, d]) => !d.advanced);
            const advanced = entries.filter(([, d]) => d.advanced);

            const group = el("div.settings-group", [
                el("h3", { text: schema.groups[groupKey] || groupKey })
            ]);

            for (const [key, def] of basic) {
                group.appendChild(buildRow(key, def, values[key], key in (overrides || {}), commit));
            }

            if (advanced.length) {
                const details = el("details.advanced", [
                    el("summary", { text: `Advanced (${advanced.length})` })
                ]);
                for (const [key, def] of advanced) {
                    details.appendChild(buildRow(key, def, values[key], key in (overrides || {}), commit));
                }
                group.appendChild(details);
            }

            container.appendChild(group);
        }

        return container;
    }

    // ---------------------------------------------------------------
    //  Hub-wide settings screen
    // ---------------------------------------------------------------

    async function renderSettingsPage(container, onSaved) {
        await loadSchema();
        const { values, overrides } = await api.get("/settings");

        clear(container);
        container.appendChild(el("div.page-header", [
            el("div.page-header-left", [el("h2", { text: "Settings" })]),
            el("div.page-header-actions", [
                el("span.small.muted", {
                    text: "Changes apply immediately — no restart needed."
                })
            ])
        ]));
        container.appendChild(renderGroups({
            groups: ["recording", "detection", "events", "system"],
            values, overrides, onSaved
        }));
    }

    // ---------------------------------------------------------------
    //  Storage screen
    // ---------------------------------------------------------------

    async function renderStoragePage(container, onSaved) {
        await loadSchema();
        const [stats, { values, overrides }] = await Promise.all([
            api.get("/storage"),
            api.get("/settings")
        ]);

        clear(container);
        container.appendChild(el("div.page-header", [
            el("div.page-header-left", [el("h2", { text: "Storage" })]),
            el("div.page-header-actions", [
                el("button.btn", {
                    text: "Back up database now",
                    title: "Write a dated copy of events.db (settings, zones, profiles, event log)",
                    onclick: async (ev) => {
                        ev.target.disabled = true;
                        try {
                            const res = await api.post("/storage/backup");
                            toast(`Backed up to ${res.path}`, "ok");
                        } catch (err) {
                            toast(err.message, "error");
                        } finally {
                            ev.target.disabled = false;
                        }
                    }
                }),
                el("button.btn", {
                    "data-variant": "primary",
                    text: "Clean up now",
                    onclick: async (ev) => {
                        const ok = await confirmAction(
                            "Run cleanup now?",
                            "Applies the retention and budget limits below immediately. " +
                            "Clips outside those limits are deleted permanently.",
                            "Clean up"
                        );
                        if (!ok) return;
                        ev.target.disabled = true;
                        try {
                            const result = await api.post("/storage/prune");
                            toast(
                                `Removed ${result.clipsDeleted} clip(s) and ${result.rowsDeleted} ` +
                                `event(s), reclaiming ${formatBytes(result.bytesReclaimed)}.`,
                                "ok"
                            );
                            if (onSaved) onSaved();
                        } catch (err) {
                            toast(err.message, "error");
                        } finally {
                            ev.target.disabled = false;
                        }
                    }
                })
            ])
        ]));

        if (stats.recordingPaused) {
            container.appendChild(el("div.banner", [
                el("div.banner-title", { text: "Recording is paused — the disk is nearly full" }),
                el("div", { text: stats.pausedReason || "" }),
                el("div.small.muted", {
                    style: { marginTop: "6px" },
                    text: "Events are still being detected and logged; only new video is being " +
                          "skipped. Lower the clip budget or free space on the hub to resume."
                })
            ]));
        }

        container.appendChild(renderStats(stats));
        container.appendChild(renderUsageBar(stats));
        if (stats.byCam && stats.byCam.length) container.appendChild(renderBreakdown(stats));
        container.appendChild(renderGroups({
            groups: ["storage"], values, overrides, onSaved
        }));
    }

    function renderStats(stats) {
        const runway = stats.projectedDaysRemaining;
        return el("div.stat-grid", [
            stat(formatBytes(stats.clipBytes), `Video stored (${stats.clipFiles} files)`),
            stat(formatBytes(stats.freeBytes), "Free on disk"),
            stat(String(stats.eventCount), "Events logged"),
            stat(
                runway === null ? "—" : `${runway} days`,
                "Runway at the current rate",
            )
        ]);
    }

    function stat(value, label) {
        return el("div.stat", [
            el("div.stat-value", { text: value }),
            el("div.stat-label", { text: label })
        ]);
    }

    /**
     * Usage bar showing clips against the budget or the disk, whichever is the
     * binding constraint — showing the one with more room to spare would be
     * reassuring and wrong.
     */
    function renderUsageBar(stats) {
        const budgetBytes = (stats.limits.maxTotalGB || 0) * 1024 ** 3;
        const usable = budgetBytes > 0 && stats.totalBytes
            ? Math.min(budgetBytes, stats.clipBytes + stats.freeBytes)
            : (stats.totalBytes || stats.clipBytes || 1);

        const clipPct = Math.min(100, (stats.clipBytes / usable) * 100);
        const otherPct = stats.totalBytes
            ? Math.min(100 - clipPct, ((stats.totalBytes - stats.freeBytes - stats.clipBytes) / usable) * 100)
            : 0;

        const label = budgetBytes > 0
            ? `${formatBytes(stats.clipBytes)} of the ${stats.limits.maxTotalGB} GB clip budget`
            : `${formatBytes(stats.clipBytes)} of clips`;

        return el("div", { style: { marginBottom: "20px" } }, [
            el("div.small.muted", { text: label, style: { marginBottom: "6px" } }),
            el("div.storage-bar", [
                el("div", { style: { width: `${clipPct}%`, background: "var(--accent)" } }),
                el("div", { style: { width: `${Math.max(0, otherPct)}%`, background: "var(--text-dim)" } })
            ]),
            el("div.storage-legend", [
                el("span", [el("span.swatch", { style: { background: "var(--accent)" } }), "SecurityLux clips"]),
                stats.totalBytes ? el("span", [
                    el("span.swatch", { style: { background: "var(--text-dim)" } }), "Everything else on the disk"
                ]) : null,
                el("span", { text: `Reserve kept free: ${stats.limits.minFreeGB} GB` }),
                el("span", { text: `Path: ${stats.clipsRoot}` })
            ])
        ]);
    }

    function renderBreakdown(stats) {
        return el("div", { style: { marginBottom: "20px" } }, [
            el("table.breakdown", [
                el("thead", [el("tr", [
                    el("th", { text: "Camera" }),
                    el("th", { text: "Clips", class: "num" }),
                    el("th", { text: "Size", class: "num" })
                ])]),
                el("tbody", stats.byCam.map((row) => el("tr", [
                    el("td", { text: row.cam_id }),
                    el("td.num", { text: String(row.clips) }),
                    el("td.num", { text: formatBytes(row.bytes) })
                ])))
            ])
        ]);
    }

    // ---------------------------------------------------------------
    //  Per-camera settings (used by the camera detail screen)
    // ---------------------------------------------------------------

    async function renderCameraSettings(container, camId, onSaved) {
        await loadSchema();
        const { values, overrides } = await api.get(`/cam/${encodeURIComponent(camId)}/settings`);
        clear(container);
        container.appendChild(renderGroups({
            groups: ["events", "detection", "recording", "led", "storage"],
            values, overrides, camId, onSaved
        }));
    }

    SL.settings = {
        loadSchema, renderSettingsPage, renderStoragePage, renderCameraSettings, renderGroups
    };
})(window);
