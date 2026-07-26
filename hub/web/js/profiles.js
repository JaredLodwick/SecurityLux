/**
 * Profiles — known people, their clearance levels, and enrolled face samples.
 *
 * Everything here works today. What is deliberately not wired up is automatic
 * *recognition*: the hub stores samples and can match embeddings, but the model
 * that turns a face into an embedding isn't published yet. The UI says so
 * plainly rather than implying the system is silently identifying people, which
 * would be a bad thing to be wrong about.
 *
 * Clearance levels exist now so Phase 5 automation (auto-unlock and friends)
 * has something to key off later.
 */

(function (global) {
    "use strict";

    const SL = global.SL;
    const { el, clear, api, toast, confirmAction, formatRelative } = SL;

    const CLEARANCE_LABELS = {
        0: "None",
        1: "Known",
        2: "Trusted",
        3: "Full"
    };

    const CLEARANCE_HELP =
        "Clearance is recorded for future automation (for example, unlocking a door for " +
        "trusted people). Nothing acts on it yet.";

    async function render(container) {
        const [profiles, recognition] = await Promise.all([
            api.get("/profiles"),
            api.get("/recognition").catch(() => null)
        ]);

        clear(container);

        container.appendChild(el("div.page-header", [
            el("div.page-header-left", [el("h2", { text: "Profiles" })]),
            el("div.page-header-actions", [
                el("button.btn", {
                    "data-variant": "primary",
                    text: "New profile",
                    onclick: () => createProfile(container)
                })
            ])
        ]));

        if (recognition && !recognition.available) {
            container.appendChild(el("div.banner", { dataset: { kind: "warn" } }, [
                el("div.banner-title", { text: "Face recognition is not running" }),
                el("div", {
                    text: "Profiles, clearances, and face samples all work and are saved. " +
                          "Automatic matching is not active yet, so events are logged as " +
                          "generic person detections rather than named people."
                }),
                el("div.small.muted", {
                    style: { marginTop: "6px" },
                    text: recognition.reason || ""
                })
            ]));
        }

        if (!profiles.length) {
            container.appendChild(el("div.empty", {
                html: "No profiles yet.<br>Create one, then add faces to it from any event " +
                      "with a thumbnail — that's easier than hunting for a photo."
            }));
            return;
        }

        const grid = el("div.profile-grid");
        for (const profile of profiles) {
            grid.appendChild(await renderCard(profile, container));
        }
        container.appendChild(grid);
    }

    async function renderCard(profile, pageContainer) {
        let samples = [];
        try {
            samples = await api.get(`/profiles/${profile.id}/samples`);
        } catch (_) { samples = []; }

        const sampleRow = el("div.profile-samples",
            samples.length
                ? samples.slice(0, 8).map((sample) => el("div.sample-wrap", [
                    el("img.sample-thumb", {
                        src: `/profiles/samples/${sample.id}/image.jpg`,
                        alt: "", loading: "lazy"
                    }),
                    el("button", {
                        title: "Remove this face sample", text: "✕",
                        onclick: async () => {
                            try {
                                await api.del(`/profiles/${profile.id}/samples/${sample.id}`);
                                toast("Sample removed.", "ok");
                                render(pageContainer);
                            } catch (err) {
                                toast(err.message, "error");
                            }
                        }
                    })
                ]))
                : el("span.small.muted", { text: "No faces enrolled yet." })
        );

        return el("div.profile-card", [
            el("div", { style: { display: "flex", alignItems: "baseline", gap: "8px" } }, [
                el("h4", { text: profile.name }),
                el("span.spacer"),
                el("span.clearance", {
                    dataset: { level: String(profile.clearance) },
                    text: CLEARANCE_LABELS[profile.clearance] || String(profile.clearance),
                    title: CLEARANCE_HELP
                })
            ]),
            el("div.small.muted", {
                text: [
                    profile.is_anonymous ? "Auto-created" : null,
                    `${profile.sample_count} face${profile.sample_count === 1 ? "" : "s"}`,
                    profile.sighting_count ? `seen ${profile.sighting_count}×` : null,
                    profile.last_seen_ms ? formatRelative(profile.last_seen_ms) : null
                ].filter(Boolean).join(" · ")
            }),
            profile.notes ? el("div.small", { text: profile.notes, style: { marginTop: "6px" } }) : null,
            sampleRow,
            el("div", { style: { display: "flex", gap: "6px", flexWrap: "wrap" } }, [
                el("button.btn.btn-icon", {
                    text: "Add face",
                    title: "Upload a photo of this person",
                    onclick: () => uploadSample(profile, pageContainer)
                }),
                el("button.btn.btn-icon", {
                    text: "Edit",
                    onclick: () => editProfile(profile, pageContainer)
                }),
                el("span.spacer"),
                el("button.btn.btn-icon", {
                    "data-variant": "danger", text: "Delete",
                    onclick: async () => {
                        const ok = await confirmAction(
                            `Delete "${profile.name}"?`,
                            "The profile and its enrolled faces are removed permanently. " +
                            "Past events stay in the log but lose their attribution.",
                            "Delete profile"
                        );
                        if (!ok) return;
                        try {
                            await api.del(`/profiles/${profile.id}`);
                            toast("Profile deleted.", "ok");
                            render(pageContainer);
                        } catch (err) {
                            toast(err.message, "error");
                        }
                    }
                })
            ])
        ]);
    }

    function profileForm(profile, close) {
        const name = el("input", { type: "text", value: profile ? profile.name : "" });
        const clearance = el("select", Object.entries(CLEARANCE_LABELS).map(([value, label]) =>
            el("option", {
                value,
                text: `${value} — ${label}`,
                selected: profile ? String(profile.clearance) === value : value === "0"
            })));
        const notes = el("textarea", { rows: 3 });
        if (profile && profile.notes) notes.value = profile.notes;

        return el("div", [
            el("label", [el("span", { text: "Name" }), name]),
            el("label", [
                el("span", { text: "Clearance" }), clearance,
                el("div.setting-help", { text: CLEARANCE_HELP })
            ]),
            el("label", [el("span", { text: "Notes (optional)" }), notes]),
            el("div.modal-actions", [
                el("button.btn", { text: "Cancel", onclick: () => close(null) }),
                el("button.btn", {
                    "data-variant": "primary",
                    text: profile ? "Save" : "Create",
                    onclick: () => {
                        const trimmed = name.value.trim();
                        if (!trimmed) { toast("A name is required.", "error"); return; }
                        close({
                            name: trimmed,
                            clearance: Number(clearance.value),
                            notes: notes.value.trim()
                        });
                    }
                })
            ])
        ]);
    }

    async function createProfile(pageContainer) {
        const values = await SL.modal("New profile", (close) => profileForm(null, close));
        if (!values) return;
        try {
            await api.post("/profiles", values);
            toast("Profile created.", "ok");
            render(pageContainer);
        } catch (err) {
            toast(err.message, "error");
        }
    }

    async function editProfile(profile, pageContainer) {
        const values = await SL.modal(`Edit ${profile.name}`, (close) => profileForm(profile, close));
        if (!values) return;
        try {
            await api.patch(`/profiles/${profile.id}`, values);
            toast("Profile saved.", "ok");
            render(pageContainer);
        } catch (err) {
            toast(err.message, "error");
        }
    }

    /**
     * Upload a photo as a face sample.
     *
     * Read client-side and posted as base64 JSON rather than multipart. The
     * hub's HTTP layer is deliberately framework-free, and adding a multipart
     * parser to it for one endpoint would be more code than this is worth.
     */
    async function uploadSample(profile, pageContainer) {
        const picked = await SL.modal(`Add a face to ${profile.name}`, (close) => {
            const input = el("input", { type: "file", accept: "image/*" });
            const preview = el("img", {
                style: { maxWidth: "100%", borderRadius: "6px", display: "none", marginTop: "10px" }
            });
            let dataUrl = null;

            input.addEventListener("change", () => {
                const file = input.files && input.files[0];
                if (!file) return;
                if (file.size > 6 * 1024 * 1024) {
                    toast("That image is larger than 6 MB.", "error");
                    input.value = "";
                    return;
                }
                const reader = new FileReader();
                reader.onload = () => {
                    dataUrl = reader.result;
                    preview.src = dataUrl;
                    preview.style.display = "";
                };
                reader.readAsDataURL(file);
            });

            return el("div", [
                el("label", [
                    el("span", { text: "Photo — a clear, front-on face works best" }),
                    input
                ]),
                preview,
                el("div.modal-actions", [
                    el("button.btn", { text: "Cancel", onclick: () => close(null) }),
                    el("button.btn", {
                        "data-variant": "primary", text: "Add face",
                        onclick: () => {
                            if (!dataUrl) { toast("Choose an image first.", "error"); return; }
                            close(dataUrl);
                        }
                    })
                ])
            ]);
        });

        if (!picked) return;
        try {
            await api.post(`/profiles/${profile.id}/samples`, { imageBase64: picked });
            toast("Face added.", "ok");
            render(pageContainer);
        } catch (err) {
            toast(err.message, "error");
        }
    }

    SL.profiles = { render };
})(window);
