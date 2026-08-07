/**
 * Shared helpers: DOM building, formatting, the API client, and toasts.
 *
 * Attached to `window.SL` rather than using modules, so the dashboard works
 * from a `file://` copy and from any browser the hub might be opened in
 * without a build step. The hub has no bundler and shouldn't need one.
 */

(function (global) {
    "use strict";

    const SL = global.SL || (global.SL = {});

    // ---------------------------------------------------------------
    //  DOM
    // ---------------------------------------------------------------

    /**
     * el("div.foo", { onclick }, [children])
     * Accepts a tag with optional .class suffixes, an attrs object, and
     * children (nodes, strings, or nested arrays; null/false are skipped).
     */
    function el(spec, attrs, children) {
        const [tag, ...classes] = String(spec).split(".");
        const node = document.createElement(tag || "div");
        if (classes.length) node.className = classes.join(" ");

        if (attrs && typeof attrs === "object" && !Array.isArray(attrs) && !(attrs instanceof Node)) {
            for (const [key, value] of Object.entries(attrs)) {
                if (value === null || value === undefined || value === false) continue;
                if (key === "class") node.className = [node.className, value].filter(Boolean).join(" ");
                else if (key === "text") node.textContent = String(value);
                else if (key === "html") node.innerHTML = value;
                else if (key === "style" && typeof value === "object") Object.assign(node.style, value);
                else if (key.startsWith("on") && typeof value === "function") {
                    node.addEventListener(key.slice(2).toLowerCase(), value);
                } else if (key === "dataset" && typeof value === "object") {
                    Object.assign(node.dataset, value);
                } else if (value === true) {
                    node.setAttribute(key, "");
                } else {
                    node.setAttribute(key, String(value));
                }
            }
        } else if (attrs !== undefined && attrs !== null) {
            children = attrs;
        }

        appendChildren(node, children);
        return node;
    }

    function appendChildren(node, children) {
        if (children === null || children === undefined || children === false) return;
        if (Array.isArray(children)) {
            for (const child of children) appendChildren(node, child);
            return;
        }
        node.appendChild(children instanceof Node
            ? children
            : document.createTextNode(String(children)));
    }

    function clear(node) {
        node.replaceChildren();
        return node;
    }

    // ---------------------------------------------------------------
    //  Selection
    // ---------------------------------------------------------------

    /**
     * Which camera the Live view is focused on.
     *
     * A single camera is always the selected one. It has no grid to drill into
     * — `renderSingle` deliberately gives its card no click handler — so
     * without this it could never become "selected", and every per-camera
     * control (adjust image, zones, restart, reboot) would be unreachable
     * unless you typed the URL by hand. That is exactly the bug this function
     * exists to prevent recurring.
     *
     * @param {string|null} hashCamId  Camera id from the URL hash, if any.
     * @param {Array<{cam_id: string}>} cams
     * @returns {string|null}
     */
    function resolveSelectedCam(hashCamId, cams) {
        const list = Array.isArray(cams) ? cams : [];
        // A stale hash (camera renamed or removed) falls through rather than
        // leaving the view pointed at something that no longer exists.
        if (hashCamId && list.some((c) => c.cam_id === hashCamId)) return hashCamId;
        if (list.length === 1) return list[0].cam_id;
        return null;
    }

    // ---------------------------------------------------------------
    //  Formatting
    // ---------------------------------------------------------------

    function formatBytes(n) {
        if (n === null || n === undefined || !isFinite(n)) return "—";
        if (n === 0) return "0 B";
        const units = ["B", "KB", "MB", "GB", "TB"];
        let v = n;
        let i = 0;
        while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
        return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
    }

    function formatDuration(ms) {
        if (!isFinite(ms) || ms === null) return "—";
        if (ms < 1000) return `${Math.round(ms)} ms`;
        const s = ms / 1000;
        if (s < 60) return `${s.toFixed(1)}s`;
        const m = Math.floor(s / 60);
        const rem = Math.round(s - m * 60);
        if (m < 60) return `${m}m ${rem}s`;
        return `${Math.floor(m / 60)}h ${m % 60}m`;
    }

    function formatTime(ms) {
        if (!ms) return "—";
        const d = new Date(ms);
        const today = new Date();
        const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
        if (d.toDateString() === today.toDateString()) return time;
        return `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
    }

    /** "4 min ago" — for the last-event line and offline durations. */
    function formatRelative(ms) {
        if (!ms) return "—";
        const delta = Date.now() - ms;
        if (delta < 45_000) return "just now";
        const minutes = Math.round(delta / 60_000);
        if (minutes < 60) return `${minutes} min ago`;
        const hours = Math.round(minutes / 60);
        if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
        const days = Math.round(hours / 24);
        return `${days} day${days === 1 ? "" : "s"} ago`;
    }

    function capitalize(s) {
        if (!s) return "";
        return String(s).charAt(0).toUpperCase() + String(s).slice(1);
    }

    // ---------------------------------------------------------------
    //  API client
    // ---------------------------------------------------------------

    /**
     * Thin fetch wrapper.
     *
     * Errors carry the server's message rather than "HTTP 400", because the
     * hub's validation errors are written to be read by a person and throwing
     * them away would make settings mistakes undebuggable from the UI.
     */
    async function request(method, path, body) {
        const init = { method, cache: "no-store" };
        if (body !== undefined) {
            init.headers = { "Content-Type": "application/json" };
            init.body = JSON.stringify(body);
        }
        const res = await fetch(path, init);
        const text = await res.text();
        let parsed = null;
        try { parsed = text ? JSON.parse(text) : null; } catch (_) { parsed = null; }

        if (!res.ok) {
            const detail = parsed && Array.isArray(parsed.details)
                ? parsed.details.join("; ")
                : null;
            const message = detail
                || (parsed && (parsed.error || parsed.detail))
                || `HTTP ${res.status}`;
            const err = new Error(message);
            err.status = res.status;
            err.body = parsed;
            throw err;
        }
        return parsed;
    }

    const api = {
        get: (path) => request("GET", path),
        post: (path, body) => request("POST", path, body),
        put: (path, body) => request("PUT", path, body),
        patch: (path, body) => request("PATCH", path, body),
        del: (path) => request("DELETE", path)
    };

    // ---------------------------------------------------------------
    //  Toasts
    // ---------------------------------------------------------------

    let toastHost = null;

    function toast(message, kind) {
        if (!toastHost) {
            toastHost = el("div.toasts");
            document.body.appendChild(toastHost);
        }
        const node = el("div.toast", { dataset: { kind: kind || "info" }, text: message });
        toastHost.appendChild(node);
        setTimeout(() => {
            node.style.transition = "opacity .3s";
            node.style.opacity = "0";
            setTimeout(() => node.remove(), 300);
        }, kind === "error" ? 6000 : 3000);
    }

    // ---------------------------------------------------------------
    //  Modal
    // ---------------------------------------------------------------

    /**
     * Render a modal. `render(close)` returns the body; resolves with whatever
     * `close(value)` is called with, or null if dismissed.
     *
     * @param {object} [opts]
     * @param {boolean} [opts.wide]  Widen the dialog — for panels that need a
     *   preview alongside their controls rather than a simple form.
     */
    function modal(title, render, opts) {
        return new Promise((resolve) => {
            const backdrop = el("div.modal-backdrop");
            const close = (value) => {
                document.removeEventListener("keydown", onKey);
                backdrop.remove();
                resolve(value === undefined ? null : value);
            };
            const onKey = (ev) => { if (ev.key === "Escape") close(null); };

            const box = el(opts && opts.wide ? "div.modal.modal-wide" : "div.modal", [
                el("h3", { text: title }),
                render(close)
            ]);
            backdrop.appendChild(box);
            backdrop.addEventListener("click", (ev) => { if (ev.target === backdrop) close(null); });
            document.addEventListener("keydown", onKey);
            document.body.appendChild(backdrop);

            const focusable = box.querySelector("input, select, textarea, button");
            if (focusable) focusable.focus();
        });
    }

    /** Confirmation dialog for irreversible or physical actions. */
    async function confirmAction(title, message, confirmLabel) {
        const result = await modal(title, (close) => el("div", [
            el("p.small.muted", { text: message }),
            el("div.modal-actions", [
                el("button.btn", { text: "Cancel", onclick: () => close(false) }),
                el("button.btn", {
                    "data-variant": "danger",
                    text: confirmLabel || "Confirm",
                    onclick: () => close(true)
                })
            ])
        ]));
        return result === true;
    }

    Object.assign(SL, {
        el, clear, appendChildren, resolveSelectedCam,
        formatBytes, formatDuration, formatTime, formatRelative, capitalize,
        api, toast, modal, confirmAction
    });

    // Export the pure helpers for tests. The DOM-touching ones are left alone;
    // they need a browser and are exercised by hand.
    if (typeof module !== "undefined" && module.exports) {
        module.exports = {
            resolveSelectedCam,
            formatBytes, formatDuration, formatRelative, capitalize
        };
    }
})(typeof window !== "undefined" ? window : globalThis);
