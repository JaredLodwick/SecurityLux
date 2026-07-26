"use strict";

/**
 * Operations on the event log: offline alerting, outbound notification,
 * description rewriting, and deletion.
 *
 * Split out of server.js because these share a subject (the event log) and none
 * of them touch the server's lifecycle, sockets, or streaming. Each takes the
 * hub as its first argument rather than being a method, so they can be read and
 * tested without standing up a server.
 */

const fs = require("node:fs");

const { describeEvent, describeOffline } = require("./describe");

/**
 * Log an event when a camera stops reporting.
 *
 * The most valuable alert a security system has, and the one most systems don't
 * bother with: a camera that's been down for three days is worse than no camera
 * at all, because you believe you're covered.
 */
function checkOffline(hub) {
    if (!hub.store || !hub.settings || !hub.clockIsSane()) return;
    const now = Date.now();

    for (const [camId, cam] of hub.cams) {
        const minutes = hub.settings.get("events.offlineAlertMinutes", camId);
        if (!minutes || minutes <= 0) continue;
        if (cam.connected || !cam.offlineSince) continue;

        const downFor = now - cam.offlineSince;
        if (downFor < minutes * 60_000) continue;

        const meta = hub.store.getCameraMeta(camId);
        const lastAlert = meta && meta.last_offline_alert_ms;
        // One alert per outage, not one per check — otherwise a camera that
        // stays down floods the log every minute forever.
        if (lastAlert && lastAlert > cam.offlineSince) continue;

        try {
            const rowId = hub.store.insertSession({
                camId, type: "camera_offline", startedAtMs: cam.offlineSince
            });
            hub.store.finalizeSession({
                id: rowId,
                endedAtMs: now,
                detectionCount: 0,
                maxConfidence: null,
                clipPath: null,
                description: describeOffline({
                    camId,
                    friendlyName: hub.settings.get("events.friendlyName", camId),
                    downForMs: downFor
                }),
                behavior: "offline",
                metadata: { downForMs: downFor }
            });
            hub.store.markOfflineAlert(camId, now);
            hub.log.warn(
                `[hub] camera ${camId} has been offline for ${Math.round(downFor / 60000)} min`
            );
            const event = hub.store.getEvent(rowId);
            if (event) onEventFinalized(hub, event);
        } catch (err) {
            hub.log.warn(`[hub] failed to log offline event: ${err && err.message}`);
        }
    }
}

function onEventFinalized(hub, event) {
    const webhookUrl = hub.settings && hub.settings.get("events.webhookUrl");
    if (!webhookUrl) return;
    postWebhook(hub, webhookUrl, event);
}

/**
 * Fire-and-forget event notification.
 *
 * Deliberately a plain webhook rather than an integration: it's a few dozen
 * lines and lets you drive ntfy, Home Assistant, or a shell script without the
 * hub knowing anything about any of them. Failures are logged and dropped — a
 * notification endpoint being down must never affect recording.
 */
function postWebhook(hub, webhookUrl, event) {
    let target;
    try {
        target = new URL(webhookUrl);
    } catch (_) {
        hub.log.warn(`[hub] events.webhookUrl is not a valid URL: ${webhookUrl}`);
        return;
    }

    // eslint-disable-next-line global-require
    const client = target.protocol === "https:" ? require("node:https") : require("node:http");

    const payload = JSON.stringify({
        id: event.id,
        cam_id: event.cam_id,
        type: event.type,
        description: event.description,
        behavior: event.behavior,
        started_at_ms: event.started_at_ms,
        duration_ms: event.duration_ms,
        has_clip: !!event.clip_path
    });

    const req = client.request(target, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(payload)
        },
        timeout: 5000
    }, (res) => res.resume());

    req.on("timeout", () => req.destroy());
    req.on("error", (err) => hub.log.warn(`[hub] webhook failed: ${err && err.message}`));
    req.end(payload);
}

/** Rewrite one event's description from its stored track and the current zones. */
function redescribeEvent(hub, eventId) {
    if (!hub.store) return { ok: false, error: "event store unavailable" };
    const event = hub.store.getEvent(eventId);
    if (!event) return { ok: false, error: "event not found" };
    // Offline alerts have their own wording and no track to re-read.
    if (event.type === "camera_offline") return { ok: true, event };

    const description = describeEvent({
        camId: event.cam_id,
        friendlyName: hub.settings.get("events.friendlyName", event.cam_id) || null,
        behavior: event.behavior || "present",
        durationMs: event.duration_ms || 0,
        startedAtMs: event.started_at_ms,
        zoneVisits: event.zones || [],
        direction: event.track ? event.track.direction : null,
        personCount: (event.metadata && event.metadata.peakPersonCount) || 1,
        latitude: hub.settings.get("system.latitude"),
        longitude: hub.settings.get("system.longitude")
    });

    hub.store.setDescription(eventId, description);
    return { ok: true, event: hub.store.getEvent(eventId) };
}

/**
 * Re-run descriptions over history.
 *
 * The point: renaming a zone from "Zone 2" to "Trash room door" should fix
 * every past event that mentions it, not just future ones. A log that stays
 * wrong forever after a rename would make the zone editor much less useful.
 */
function redescribeAll(hub, camId) {
    if (!hub.store) return { updated: 0 };
    const events = hub.store.queryEvents({ camId, limit: 500 });
    let updated = 0;
    for (const event of events) {
        if (event.type === "camera_offline") continue;
        if (redescribeEvent(hub, event.id).ok) updated += 1;
    }
    return { updated };
}

function deleteEvent(hub, eventId) {
    if (!hub.store) return { ok: false, error: "event store unavailable" };
    const event = hub.store.getEvent(eventId);
    if (!event) return { ok: false, error: "event not found" };

    for (const rel of [event.clip_path, event.thumb_path]) {
        if (!rel) continue;
        const abs = hub.storage.resolveClipPath(rel);
        if (!abs) continue;
        try { fs.unlinkSync(abs); } catch (_) { /* already gone */ }
    }
    hub.store.deleteSession(eventId);
    return { ok: true };
}

module.exports = {
    checkOffline,
    onEventFinalized,
    postWebhook,
    redescribeEvent,
    redescribeAll,
    deleteEvent
};
