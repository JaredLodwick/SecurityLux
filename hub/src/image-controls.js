"use strict";

/**
 * Camera image adjustments — framing and hardware controls.
 *
 * Two distinct things, deliberately handled together because the control panel
 * edits them as one:
 *
 *   Framing   rotation, mirroring, digital zoom and pan. Schema-backed settings
 *             (`image.*`), applied in software on the camera before the JPEG
 *             encode.
 *   Hardware  brightness, contrast, exposure and so on. V4L2 controls applied
 *             by the camera's own driver, so they cost no CPU at all — but
 *             which ones exist depends entirely on the webcam, so they can't be
 *             declared in a fixed schema and live in their own JSON blob.
 *
 * Everything is applied on the camera rather than the hub or the browser, so
 * the live feed, the recordings, and the person detector all see the same
 * corrected image. A browser-side CSS rotation would fix only what you're
 * looking at and leave the detector staring at a sideways person.
 *
 * Split out of server.js because it's self-contained; each function takes the
 * hub as its first argument rather than being a method.
 */

/** Framing settings for a camera, in the shape the camera expects. */
function imageConfigFor(hub, camId) {
    if (!hub.settings) return null;
    return {
        // Stored as an enum of strings so the UI renders a dropdown rather than
        // a nonsensical slider; the camera wants a number.
        rotation: Number(hub.settings.get("image.rotation", camId)) || 0,
        flipHorizontal: hub.settings.get("image.flipHorizontal", camId),
        flipVertical: hub.settings.get("image.flipVertical", camId),
        zoom: hub.settings.get("image.zoom", camId),
        panX: hub.settings.get("image.panX", camId),
        panY: hub.settings.get("image.panY", camId)
    };
}

function sendImageConfig(hub, camId) {
    const cam = hub.cams.get(camId);
    const config = imageConfigFor(hub, camId);
    if (!cam || !config) return { ok: false, error: "unknown camera" };
    const sent = hub.sendCommand(cam, { type: "image_config", ...config });
    return sent ? { ok: true } : { ok: false, error: `camera "${camId}" is not connected` };
}

/**
 * Re-apply stored V4L2 values, and ask the camera what it supports.
 *
 * Called on every camera connect, and that is not merely a convenience: V4L2
 * control values live in the camera's driver and are lost when the Pi reboots.
 * Without this, a power cut would silently undo carefully tuned brightness and
 * leave a dark doorway dark until somebody noticed.
 */
function sendHardwareControls(hub, camId) {
    const cam = hub.cams.get(camId);
    if (!cam || !hub.store) return;
    const values = hub.store.getHardwareControls(camId);
    if (Object.keys(values).length) {
        hub.sendCommand(cam, { type: "camera_controls", values });
    } else {
        hub.sendCommand(cam, { type: "get_camera_controls" });
    }
}

/**
 * Effective output resolution, derived rather than awaited.
 *
 * `hello` reports the capture resolution before any transform, so rotating by
 * 90/270 simply swaps the axes. Computing it here means the panel shows the new
 * dimensions the instant you rotate, instead of displaying stale numbers until
 * the camera's reply arrives.
 */
function effectiveResolution(hub, camId, cam) {
    const base = cam && cam.baseResolution;
    if (base && hub.settings) {
        const match = /^(\d+)x(\d+)$/.exec(base);
        if (match) {
            const rotation = Number(hub.settings.get("image.rotation", camId)) || 0;
            const [w, h] = [Number(match[1]), Number(match[2])];
            return (rotation === 90 || rotation === 270) ? `${h}x${w}` : `${w}x${h}`;
        }
    }
    // Nothing from hello yet — fall back to whatever the camera last said.
    return (cam && (cam.reportedResolution
        || (cam.status && cam.status.resolution))) || null;
}

/** Everything the control panel renders from. */
function controlsFor(hub, camId) {
    const cam = hub.cams.get(camId);
    const stored = hub.store ? hub.store.getHardwareControls(camId) : {};
    return {
        cam_id: camId,
        connected: !!(cam && cam.connected),
        image: imageConfigFor(hub, camId),
        // What the camera says it is actually running, which can differ from
        // what we asked for if a value was clamped camera-side.
        reported_image: (cam && cam.reportedImage) || null,
        resolution: effectiveResolution(hub, camId, cam),
        controls: (cam && cam.controls) || [],
        controls_available: !!(cam && cam.controlsAvailable),
        controls_probed_at: (cam && cam.controlsAt) || null,
        stored_values: stored,
        errors: (cam && cam.controlErrors) || null,
        // Rotation moves the picture underneath any zones drawn on the old
        // orientation, so the UI needs to know whether there are any to warn about.
        zone_count: hub.store ? hub.zonesFor(camId).length : 0
    };
}

/**
 * Apply hardware control values: persist first, then push.
 *
 * Persist-then-push because the stored value is what survives a camera reboot.
 * If the push fails because the camera is momentarily offline, the setting
 * still lands and is re-applied when it reconnects — being told "camera
 * offline, nothing happened" while the value is silently discarded would be
 * the worst outcome.
 */
function setHardwareControls(hub, camId, values) {
    if (!hub.store) return { ok: false, error: "event store unavailable" };
    if (!values || typeof values !== "object" || !Object.keys(values).length) {
        return { ok: false, error: "body must be { values: { control: number } }" };
    }

    const numeric = {};
    for (const [key, value] of Object.entries(values)) {
        const n = Number(value);
        if (!isFinite(n)) return { ok: false, error: `${key} must be a number` };
        numeric[key] = Math.round(n);
    }

    const merged = hub.store.putHardwareControls(camId, numeric);
    const cam = hub.cams.get(camId);
    if (cam && cam.connected) {
        hub.sendCommand(cam, { type: "camera_controls", values: numeric });
    }
    return { ok: true, stored: merged, queued: !(cam && cam.connected) };
}

function resetHardwareControls(hub, camId) {
    if (!hub.store) return { ok: false, error: "event store unavailable" };
    hub.store.clearHardwareControls(camId);
    const cam = hub.cams.get(camId);
    if (cam && cam.connected) {
        hub.sendCommand(cam, { type: "reset_camera_controls" });
    }
    return { ok: true, queued: !(cam && cam.connected) };
}

/**
 * Cache what a camera reports about itself.
 *
 * The camera is the authority on what it supports and what the driver actually
 * accepted, so its reply is stored verbatim rather than assuming our request
 * took effect.
 */
function onCameraControlsMessage(hub, cam, msg) {
    cam.controls = Array.isArray(msg.controls) ? msg.controls : [];
    cam.controlsAvailable = !!msg.controls_available;
    cam.controlsAt = Date.now();
    if (msg.image) cam.reportedImage = msg.image;
    if (msg.resolution) cam.reportedResolution = msg.resolution;
    if (msg.errors && Object.keys(msg.errors).length) {
        hub.log.warn(
            `[hub] ${cam.id} rejected some image controls: ${JSON.stringify(msg.errors)}`
        );
    }
    cam.controlErrors = msg.errors || null;
}

function onImageStateMessage(cam, msg) {
    cam.reportedImage = msg.image || null;
    cam.reportedResolution = msg.resolution || cam.reportedResolution;
}

module.exports = {
    imageConfigFor,
    sendImageConfig,
    sendHardwareControls,
    effectiveResolution,
    controlsFor,
    setHardwareControls,
    resetHardwareControls,
    onCameraControlsMessage,
    onImageStateMessage
};
