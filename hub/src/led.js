"use strict";

/**
 * Door-light patterns.
 *
 * The hub decides *what should be conveyed*; the camera node decides how to
 * render it frame by frame. That split matters: the strip is on the camera Pi,
 * so animating from the hub would mean streaming pixel data across WiFi and
 * every dropped packet would show up as a visible stutter on someone's porch.
 * Instead the hub sends a stage and the camera runs the animation locally.
 *
 * ============================================================================
 *  Escalation
 * ============================================================================
 *
 *   0  idle        off, or a dim nightlight if configured
 *   1  passing     one cool sweep along the strip, then fade — "seen you"
 *   2  present     slow warm breathe — "someone is here"
 *   3  dwelling    faster amber pulse — "someone is still here"
 *   4  loitering   amber/red chase — "someone has been here a while"
 *
 * The stages map 1:1 onto the behaviour classifier in tracker.js, so the light
 * and the event description can never disagree about what is happening.
 *
 * ============================================================================
 *  Why every command carries a TTL
 * ============================================================================
 *
 * If the hub dies mid-event, or the WiFi drops while someone is standing at the
 * door, the last thing anyone wants is a porch light stuck at full brightness
 * until someone notices. The camera decays to idle when it hasn't heard from
 * the hub within `ttlMs`, so the failure mode is "light goes out" rather than
 * "light stays on all night".
 */

const STAGES = {
    0: {
        name: "idle",
        pattern: "off",
        color: [0, 0, 0],
        intensity: 0,
        periodMs: 0
    },
    1: {
        name: "passing",
        pattern: "sweep",
        color: [90, 190, 255],      // cool blue-white: noticed, not alarmed
        intensity: 0.5,
        periodMs: 1400
    },
    2: {
        name: "present",
        pattern: "breathe",
        color: [255, 200, 140],     // warm white: welcoming
        intensity: 0.65,
        periodMs: 2600
    },
    3: {
        name: "dwelling",
        pattern: "pulse",
        color: [255, 160, 40],      // amber: attention
        intensity: 0.85,
        periodMs: 1100
    },
    4: {
        name: "loitering",
        pattern: "chase",
        color: [255, 70, 20],       // deep amber-red: alert
        intensity: 1,
        periodMs: 650
    }
};

/** Bright white for the night-illumination override. */
const ILLUMINATE = {
    name: "illuminate",
    pattern: "solid",
    color: [255, 244, 224],
    intensity: 1,
    periodMs: 0
};

const DEFAULT_TTL_MS = 8000;

/**
 * Build the WebSocket payload for a stage.
 *
 * @param {number} stage 0-4.
 * @param {object} opts
 * @param {number} opts.brightness   Camera's configured maximum, 0-1.
 * @param {number} [opts.idleGlow]   Idle nightlight level, 0-1.
 * @param {boolean} [opts.illuminate] Override to bright white (night events).
 * @param {number} [opts.ttlMs]
 * @param {boolean} [opts.test]      Marks a manual wiring test.
 * @returns {object} the `{type:"led", ...}` message
 */
function buildLedCommand(stage, opts = {}) {
    const clamped = Math.max(0, Math.min(4, Math.round(stage) || 0));
    const brightnessCap = clamp01(opts.brightness ?? 0.4);
    const base = opts.illuminate && clamped > 0 ? ILLUMINATE : STAGES[clamped];

    // Idle is special: a configured nightlight means "off" is actually a dim
    // solid rather than nothing at all.
    if (clamped === 0) {
        const glow = clamp01(opts.idleGlow ?? 0);
        return {
            type: "led",
            stage: 0,
            pattern: glow > 0 ? "solid" : "off",
            name: "idle",
            color: glow > 0 ? [255, 190, 120] : [0, 0, 0],
            brightness: round3(glow * brightnessCap),
            periodMs: 0,
            ttlMs: 0            // idle never expires; there's nothing to decay to
        };
    }

    return {
        type: "led",
        stage: clamped,
        pattern: base.pattern,
        name: base.name,
        color: base.color,
        brightness: round3(base.intensity * brightnessCap),
        periodMs: base.periodMs,
        ttlMs: opts.ttlMs ?? DEFAULT_TTL_MS,
        test: !!opts.test
    };
}

/**
 * How often to re-send while a stage is held.
 *
 * Half the TTL, so a single dropped message never causes a visible drop to
 * idle — it takes two consecutive losses, by which point something is properly
 * wrong and going dark is the right answer anyway.
 */
function refreshIntervalFor(ttlMs) {
    return Math.max(1000, Math.floor((ttlMs || DEFAULT_TTL_MS) / 2));
}

function clamp01(n) {
    if (!isFinite(n)) return 0;
    return Math.min(1, Math.max(0, n));
}

function round3(n) {
    return Math.round(n * 1000) / 1000;
}

// ======================================================================
//  Hub-facing helpers
//
//  These take the hub rather than being methods on it, keeping every
//  door-light concern in one file.
// ======================================================================

/**
 * Send a stage to a camera's strip, remembering it so the refresh loop can keep
 * the TTL alive while the stage is held.
 */
function sendStage(hub, camId, stage, opts) {
    const cam = hub.cams.get(camId);
    if (!cam) return { ok: false, error: `unknown camera "${camId}"` };
    if (!hub.settings || !hub.settings.get("led.enabled", camId)) {
        return { ok: false, error: `the door light is not enabled for "${camId}"` };
    }
    if (!cam.connected) return { ok: false, error: `camera "${camId}" is not connected` };

    const msg = buildLedCommand(stage, {
        brightness: hub.settings.get("led.brightness", camId),
        idleGlow: hub.settings.get("led.idleGlow", camId),
        illuminate: shouldIlluminate(hub, camId, stage),
        ttlMs: opts && opts.ttlMs !== undefined ? opts.ttlMs : DEFAULT_TTL_MS,
        test: opts && opts.test
    });

    const sent = hub.sendCommand(cam, msg);
    if (sent) hub._ledState.set(camId, { stage, sentAt: Date.now(), ttlMs: msg.ttlMs });
    return sent ? { ok: true } : { ok: false, error: "failed to send LED command" };
}

/** Push a camera its LED wiring config so it can initialise the strip. */
function sendConfig(hub, camId) {
    if (!hub.settings) return;
    const cam = hub.cams.get(camId);
    if (!cam) return;
    hub.sendCommand(cam, {
        type: "led_config",
        enabled: hub.settings.get("led.enabled", camId),
        count: hub.settings.get("led.count", camId),
        maxBrightness: hub.settings.get("led.brightness", camId)
    });
}

/** Night-time illumination override, when the camera has it switched on. */
function shouldIlluminate(hub, camId, stage) {
    if (stage <= 0) return false;
    if (!hub.settings.get("led.illuminateOnEvent", camId)) return false;
    // eslint-disable-next-line global-require
    const { isDark } = require("./sun");
    return isDark(
        Date.now(),
        hub.settings.get("system.latitude"),
        hub.settings.get("system.longitude")
    ) === true;
}

/**
 * Re-send held stages before their TTL expires.
 *
 * Without this the camera would decay to idle every few seconds while someone
 * is still at the door — the TTL is a dead-man's switch, so something has to
 * keep feeding it.
 */
function startRefresh(hub, tickMs) {
    const timer = setInterval(() => {
        const now = Date.now();
        for (const [camId, state] of hub._ledState) {
            if (!state.stage || !state.ttlMs) continue;
            if (now - state.sentAt < refreshIntervalFor(state.ttlMs)) continue;
            sendStage(hub, camId, state.stage, {});
        }
    }, tickMs);
    timer.unref?.();
    return timer;
}

module.exports = {
    STAGES, ILLUMINATE, DEFAULT_TTL_MS,
    buildLedCommand, refreshIntervalFor,
    sendStage, sendConfig, shouldIlluminate, startRefresh
};
