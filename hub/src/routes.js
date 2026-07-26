"use strict";

/**
 * HTTP route table.
 *
 * Kept separate from `server.js` so the server owns lifecycle, WebSocket
 * ingest, and camera state, while this file owns the request surface. Handlers
 * receive a context object rather than reaching into the server, which keeps
 * the coupling one-directional and each handler independently readable.
 *
 * Routes are matched in order: first regex that matches the method and path
 * wins. Anything unmatched falls through to a 404 in `server.js`.
 */

const path = require("node:path");

const {
    sendJson, sendError, sendText, readJsonBody, serveFile, safeResolve, numParam, boolParam
} = require("./http-util");
const { validateZones } = require("./zones");
const { describeEvent } = require("./describe");

const WEB_ROOT = path.join(__dirname, "..", "web");

/**
 * @typedef {object} Ctx
 * @property {import("./server").HubServer} hub
 * @property {import("node:http").IncomingMessage} req
 * @property {import("node:http").ServerResponse} res
 * @property {object} query
 * @property {string[]} params   Captured regex groups, URI-decoded.
 */

const ROUTES = [
    // ---- Health + static ---------------------------------------------
    {
        method: "GET", pattern: /^\/healthz$/,
        handler: ({ res }) => sendText(res, 200, "ok")
    },
    {
        method: "GET", pattern: /^\/(?:index\.html)?$/,
        handler: ({ req, res }) => serveFile(req, res, path.join(WEB_ROOT, "index.html"), {
            cacheControl: "no-cache"
        })
    },
    {
        // Everything under web/ except index.html, which has its own route.
        method: "GET", pattern: /^\/(?:js|css|assets)\/(.+)$/,
        handler: ({ req, res }) => {
            const rel = req.url.split("?")[0].replace(/^\/+/, "");
            const abs = safeResolve(WEB_ROOT, rel);
            if (!abs) return sendError(res, 400, "invalid path");
            // no-cache rather than a long max-age: the dashboard is served off
            // the same box it controls, so a stale cached bundle after an
            // upgrade is a real support problem and bandwidth is free here.
            return serveFile(req, res, abs, { cacheControl: "no-cache" });
        }
    },

    // ---- Cameras ------------------------------------------------------
    {
        method: "GET", pattern: /^\/cams$/,
        handler: ({ hub, res }) => sendJson(res, 200, hub.allStatuses())
    },
    {
        method: "GET", pattern: /^\/cam\/([^/]+)\/status$/,
        handler: ({ hub, res, params }) => sendJson(res, 200, hub.statusFor(params[0]))
    },
    {
        method: "GET", pattern: /^\/cam\/([^/]+)\/stream\.mjpg$/,
        handler: ({ hub, req, res, params }) => hub.serveMjpeg(params[0], req, res)
    },
    {
        method: "GET", pattern: /^\/cam\/([^/]+)\/snapshot\.jpg$/,
        handler: ({ hub, res, params }) => hub.serveSnapshot(params[0], res)
    },
    {
        method: "POST", pattern: /^\/cam\/([^/]+)\/toggle$/,
        handler: ({ hub, req, res, params }) => {
            const camId = params[0];
            readJsonBody(req, (err, body) => {
                if (err) return sendError(res, 400, err.message);
                const cam = hub.getCam(camId);
                let desired;
                if (body && (body.state === "on" || body.state === "off")) {
                    desired = body.state;
                } else if (body && body.state !== undefined) {
                    return sendError(res, 400, "state must be 'on' or 'off'");
                } else {
                    desired = cam.desiredState === "on" ? "off" : "on";
                }
                hub.setDesiredState(camId, desired);
                return sendJson(res, 200, { state: desired });
            });
        }
    },
    {
        method: "POST", pattern: /^\/cam\/([^/]+)\/detection$/,
        handler: ({ hub, req, res, params }) => {
            const camId = params[0];
            readJsonBody(req, (err, body) => {
                if (err) return sendError(res, 400, err.message);
                if (!body || typeof body.enabled !== "boolean") {
                    return sendError(res, 400, "body must be { enabled: boolean }");
                }
                const result = hub.settings.set({ "detection.enabled": body.enabled }, camId);
                if (!result.ok) return sendError(res, 400, result.errors.join("; "));
                return sendJson(res, 200, hub.statusFor(camId));
            });
        }
    },
    {
        method: "POST", pattern: /^\/cam\/([^/]+)\/restart$/,
        handler: ({ hub, res, params }) => {
            const result = hub.sendCameraCommand(params[0], { type: "restart_service" });
            return result.ok
                ? sendJson(res, 202, { ok: true, action: "restart_service" })
                : sendError(res, 409, result.error);
        }
    },
    {
        method: "POST", pattern: /^\/cam\/([^/]+)\/reboot$/,
        handler: ({ hub, res, params }) => {
            const result = hub.sendCameraCommand(params[0], { type: "reboot" });
            return result.ok
                ? sendJson(res, 202, { ok: true, action: "reboot" })
                : sendError(res, 409, result.error);
        }
    },
    {
        method: "POST", pattern: /^\/cam\/([^/]+)\/led\/test$/,
        handler: ({ hub, req, res, params }) => {
            const camId = params[0];
            readJsonBody(req, (err, body) => {
                if (err) return sendError(res, 400, err.message);
                const stage = Number.isFinite(body && body.stage)
                    ? Math.max(0, Math.min(4, Math.round(body.stage)))
                    : 3;
                const result = hub.sendLedCommand(camId, stage, { test: true, ttlMs: 6000 });
                return result.ok
                    ? sendJson(res, 202, { ok: true, stage })
                    : sendError(res, 409, result.error);
            });
        }
    },

    // ---- Per-camera settings + zones ----------------------------------
    {
        method: "GET", pattern: /^\/cam\/([^/]+)\/settings$/,
        handler: ({ hub, res, params }) => sendJson(res, 200, {
            cam_id: params[0],
            values: hub.settings.all(params[0]),
            overrides: hub.settings.overrides(params[0])
        })
    },
    {
        method: "PUT", pattern: /^\/cam\/([^/]+)\/settings$/,
        handler: ({ hub, req, res, params }) => {
            const camId = params[0];
            readJsonBody(req, (err, body) => {
                if (err) return sendError(res, 400, err.message);
                const result = hub.settings.set(body, camId);
                if (!result.ok) return sendError(res, 400, "invalid settings", { details: result.errors });
                return sendJson(res, 200, {
                    changed: result.changed,
                    values: hub.settings.all(camId),
                    overrides: hub.settings.overrides(camId)
                });
            });
        }
    },
    {
        method: "GET", pattern: /^\/cam\/([^/]+)\/zones$/,
        handler: ({ hub, res, params }) => sendJson(res, 200, hub.store.listZones(params[0]))
    },
    {
        method: "PUT", pattern: /^\/cam\/([^/]+)\/zones$/,
        handler: ({ hub, req, res, params }) => {
            const camId = params[0];
            readJsonBody(req, (err, body) => {
                if (err) return sendError(res, 400, err.message);
                const list = Array.isArray(body) ? body : (body && body.zones);
                const checked = validateZones(list || []);
                if (!checked.ok) return sendError(res, 400, "invalid zones", { details: checked.errors });
                const saved = hub.store.replaceZones(camId, checked.value);
                hub.invalidateZones(camId);
                return sendJson(res, 200, saved);
            });
        }
    },

    // ---- Events -------------------------------------------------------
    {
        method: "GET", pattern: /^\/cam\/([^/]+)\/events$/,
        handler: ({ hub, res, params, query }) =>
            sendJson(res, 200, hub.store.queryEvents(eventQuery(query, params[0])))
    },
    {
        method: "GET", pattern: /^\/events$/,
        handler: ({ hub, res, query }) =>
            sendJson(res, 200, hub.store.queryEvents(eventQuery(query, query.cam)))
    },
    {
        method: "GET", pattern: /^\/events\/latest$/,
        handler: ({ hub, res, query }) => {
            const event = hub.store.latestEvent(query.cam || undefined);
            return event ? sendJson(res, 200, event) : sendJson(res, 200, null);
        }
    },
    {
        method: "GET", pattern: /^\/events\/(\d+)$/,
        handler: ({ hub, res, params }) => {
            const event = hub.store.getEvent(Number(params[0]));
            return event ? sendJson(res, 200, event) : sendError(res, 404, "event not found");
        }
    },
    {
        method: "GET", pattern: /^\/events\/(\d+)\/clip(?:\.[a-z0-9]+)?$/i,
        handler: ({ hub, req, res, params }) => hub.serveEventFile(Number(params[0]), "clip", req, res)
    },
    {
        method: "GET", pattern: /^\/events\/(\d+)\/thumb(?:\.jpg)?$/i,
        handler: ({ hub, req, res, params }) => hub.serveEventFile(Number(params[0]), "thumb", req, res)
    },
    {
        method: "POST", pattern: /^\/events\/(\d+)\/redescribe$/,
        handler: ({ hub, res, params }) => {
            const result = hub.redescribeEvent(Number(params[0]));
            return result.ok ? sendJson(res, 200, result.event) : sendError(res, 404, result.error);
        }
    },
    {
        method: "POST", pattern: /^\/events\/redescribe$/,
        handler: ({ hub, req, res }) => {
            readJsonBody(req, (err, body) => {
                if (err) return sendError(res, 400, err.message);
                const camId = body && body.cam ? String(body.cam) : undefined;
                return sendJson(res, 200, hub.redescribeAll(camId));
            });
        }
    },
    {
        method: "DELETE", pattern: /^\/events\/(\d+)$/,
        handler: ({ hub, res, params }) => {
            const result = hub.deleteEvent(Number(params[0]));
            return result.ok ? sendJson(res, 200, { ok: true }) : sendError(res, 404, result.error);
        }
    },

    // ---- Detection (hub-wide) -----------------------------------------
    {
        method: "GET", pattern: /^\/detection$/,
        handler: ({ hub, res }) => sendJson(res, 200, hub.detectionStatus())
    },
    {
        method: "POST", pattern: /^\/detection$/,
        handler: ({ hub, req, res }) => {
            readJsonBody(req, async (err, body) => {
                if (err) return sendError(res, 400, err.message);
                if (!body || typeof body.enabled !== "boolean") {
                    return sendError(res, 400, "body must be { enabled: boolean }");
                }
                let boot = { ok: true };
                if (body.enabled) boot = await hub.bootDetection();
                else await hub.stopDetection("api-disable");
                return sendJson(res, boot.ok ? 200 : 500, hub.detectionStatus());
            });
        }
    },

    // ---- Settings (hub-wide) ------------------------------------------
    {
        method: "GET", pattern: /^\/settings\/schema$/,
        handler: ({ hub, res }) => sendJson(res, 200, hub.settings.describe())
    },
    {
        method: "GET", pattern: /^\/settings$/,
        handler: ({ hub, res }) => sendJson(res, 200, {
            values: hub.settings.all(),
            overrides: hub.settings.overrides()
        })
    },
    {
        method: "PUT", pattern: /^\/settings$/,
        handler: ({ hub, req, res }) => {
            readJsonBody(req, (err, body) => {
                if (err) return sendError(res, 400, err.message);
                const result = hub.settings.set(body);
                if (!result.ok) return sendError(res, 400, "invalid settings", { details: result.errors });
                return sendJson(res, 200, {
                    changed: result.changed,
                    values: hub.settings.all(),
                    overrides: hub.settings.overrides()
                });
            });
        }
    },

    // ---- Storage ------------------------------------------------------
    {
        method: "GET", pattern: /^\/storage$/,
        handler: async ({ hub, res }) => sendJson(res, 200, await hub.storage.stats())
    },
    {
        method: "POST", pattern: /^\/storage\/prune$/,
        handler: async ({ hub, res }) => {
            const result = await hub.storage.sweep({ manual: true });
            return sendJson(res, 200, result);
        }
    },
    {
        method: "POST", pattern: /^\/storage\/backup$/,
        handler: ({ hub, res }) => {
            const dest = hub.storage.backup();
            return dest
                ? sendJson(res, 200, { ok: true, path: dest })
                : sendError(res, 500, "backup failed or is disabled");
        }
    },

    // ---- Profiles -----------------------------------------------------
    {
        method: "GET", pattern: /^\/profiles$/,
        handler: ({ hub, res }) => sendJson(res, 200, hub.store.listProfiles())
    },
    {
        method: "POST", pattern: /^\/profiles$/,
        handler: ({ hub, req, res }) => {
            readJsonBody(req, (err, body) => {
                if (err) return sendError(res, 400, err.message);
                const checked = validateProfile(body, { requireName: true });
                if (!checked.ok) return sendError(res, 400, checked.error);
                return sendJson(res, 201, hub.store.createProfile(checked.value));
            });
        }
    },
    {
        method: "GET", pattern: /^\/profiles\/(\d+)$/,
        handler: ({ hub, res, params }) => {
            const profile = hub.store.getProfile(Number(params[0]));
            return profile ? sendJson(res, 200, profile) : sendError(res, 404, "profile not found");
        }
    },
    {
        method: "PATCH", pattern: /^\/profiles\/(\d+)$/,
        handler: ({ hub, req, res, params }) => {
            readJsonBody(req, (err, body) => {
                if (err) return sendError(res, 400, err.message);
                const checked = validateProfile(body, { requireName: false });
                if (!checked.ok) return sendError(res, 400, checked.error);
                const updated = hub.store.updateProfile(Number(params[0]), checked.value);
                return updated ? sendJson(res, 200, updated) : sendError(res, 404, "profile not found");
            });
        }
    },
    {
        method: "DELETE", pattern: /^\/profiles\/(\d+)$/,
        handler: ({ hub, res, params }) => {
            const ok = hub.deleteProfile(Number(params[0]));
            return ok ? sendJson(res, 200, { ok: true }) : sendError(res, 404, "profile not found");
        }
    },
    {
        method: "GET", pattern: /^\/profiles\/(\d+)\/samples$/,
        handler: ({ hub, res, params }) => sendJson(res, 200, hub.store.listFaceSamples(Number(params[0])))
    },
    {
        method: "POST", pattern: /^\/profiles\/(\d+)\/samples$/,
        handler: ({ hub, req, res, params }) => {
            const profileId = Number(params[0]);
            readJsonBody(req, async (err, body) => {
                if (err) return sendError(res, 400, err.message);
                const result = await hub.addFaceSample(profileId, body || {});
                return result.ok
                    ? sendJson(res, 201, result.sample)
                    : sendError(res, result.status || 400, result.error);
            });
        }
    },
    {
        method: "DELETE", pattern: /^\/profiles\/(\d+)\/samples\/(\d+)$/,
        handler: ({ hub, res, params }) => {
            const ok = hub.deleteFaceSample(Number(params[1]));
            return ok ? sendJson(res, 200, { ok: true }) : sendError(res, 404, "sample not found");
        }
    },
    {
        method: "GET", pattern: /^\/profiles\/samples\/(\d+)\/image(?:\.jpg)?$/i,
        handler: ({ hub, req, res, params }) => hub.serveSampleImage(Number(params[0]), req, res)
    },
    {
        method: "GET", pattern: /^\/recognition$/,
        handler: ({ hub, res }) => sendJson(res, 200, hub.recognizer.status())
    }
];

/** Shared parsing for the event-list endpoints. */
function eventQuery(query, camId) {
    return {
        camId: camId || undefined,
        sinceMs: numParam(query, "since"),
        untilMs: numParam(query, "until"),
        type: query.type || undefined,
        behavior: query.behavior || undefined,
        profileId: numParam(query, "profile"),
        withClipOnly: boolParam(query, "clips"),
        limit: numParam(query, "limit"),
        offset: numParam(query, "offset")
    };
}

function validateProfile(body, { requireName }) {
    if (!body || typeof body !== "object") return { ok: false, error: "body must be an object" };

    const value = {};
    if (body.name !== undefined) {
        const name = String(body.name).trim();
        if (!name) return { ok: false, error: "name cannot be empty" };
        if (name.length > 80) return { ok: false, error: "name is too long (max 80)" };
        value.name = name;
    } else if (requireName) {
        return { ok: false, error: "name is required" };
    }

    if (body.clearance !== undefined) {
        const n = Number(body.clearance);
        if (!Number.isInteger(n) || n < 0 || n > 3) {
            return { ok: false, error: "clearance must be an integer 0-3" };
        }
        value.clearance = n;
    }

    if (body.notes !== undefined) {
        const notes = String(body.notes);
        if (notes.length > 2000) return { ok: false, error: "notes are too long (max 2000)" };
        value.notes = notes;
    }

    if (body.isAnonymous !== undefined) value.isAnonymous = !!body.isAnonymous;

    return { ok: true, value };
}

/**
 * Find the handler for a request.
 * @returns {{handler: Function, params: string[]} | null}
 */
function matchRoute(method, pathname) {
    for (const route of ROUTES) {
        if (route.method !== method) continue;
        const m = route.pattern.exec(pathname);
        if (!m) continue;
        const params = m.slice(1).map((p) => {
            if (p === undefined) return p;
            try { return decodeURIComponent(p); } catch (_) { return p; }
        });
        return { handler: route.handler, params };
    }
    return null;
}

module.exports = { ROUTES, matchRoute, describeEvent, eventQuery, validateProfile };
