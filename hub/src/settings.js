"use strict";

/**
 * Settings resolution and validation.
 *
 * ============================================================================
 *  Layering
 * ============================================================================
 *
 *   built-in defaults  →  config.yml  →  DB (global)  →  DB (per-camera)
 *
 * `config.yml` used to be the whole story, but it's read once at boot and never
 * written, so a web UI had nowhere to save to. The file now supplies the
 * *bootstrap* layer and the DB holds whatever the user changed, which keeps
 * hand-edited config files meaningful (they still move the defaults) without
 * making the UI second-class.
 *
 * ============================================================================
 *  Why the schema is data, not code
 * ============================================================================
 *
 * Every knob is declared once in SCHEMA with its type, bounds, label, and help
 * text. Validation, the `GET /settings` payload, and the UI controls are all
 * derived from that single declaration. A setting cannot exist in the UI that
 * the hub rejects, or vice versa — the usual drift between a settings form and
 * its backend is structurally impossible here.
 *
 * `scope` controls where a key may be set:
 *   global — hub-wide only (storage budgets, detector model)
 *   camera — per-camera only (zones, LED wiring)
 *   both   — hub-wide default that any camera may override (retention, codec)
 */

const GROUPS = {
    image: "Image",
    continuous: "Continuous recording",
    recording: "Recording",
    storage: "Storage",
    detection: "Detection",
    led: "Door light",
    events: "Events",
    system: "System"
};

/**
 * @typedef {object} SettingDef
 * @property {string} group     Key of GROUPS — drives UI sectioning.
 * @property {"boolean"|"int"|"float"|"enum"|"string"} type
 * @property {*} default
 * @property {"global"|"camera"|"both"} scope
 * @property {string} label
 * @property {string} [help]
 * @property {number} [min]
 * @property {number} [max]
 * @property {string[]} [values]   For type: "enum".
 * @property {string} [unit]
 * @property {string} [yamlPath]   Dotted path in config.yml this maps to.
 * @property {boolean} [advanced]  UI hides behind a disclosure.
 */

/** @type {Record<string, SettingDef>} */
const SCHEMA = {
    // ---- Image geometry -----------------------------------------------
    //
    // Applied on the camera before the JPEG encode, so the live feed, the
    // recordings, and the detector all see the same corrected image. Doing it
    // in the browser with CSS would fix only what you're looking at and leave
    // the detector staring at a sideways person.
    "image.rotation": {
        group: "image", type: "enum", values: ["0", "90", "180", "270"], default: "0",
        scope: "camera",
        label: "Rotation",
        help: "Rotate clockwise. Use this when the camera is mounted sideways or " +
              "upside down. 90 and 270 swap the width and height, so any zones " +
              "you have already drawn will need redrawing."
    },
    "image.flipHorizontal": {
        group: "image", type: "boolean", default: false, scope: "camera",
        label: "Mirror horizontally",
        help: "Flips left and right."
    },
    "image.flipVertical": {
        group: "image", type: "boolean", default: false, scope: "camera",
        label: "Mirror vertically",
        help: "Flips top and bottom."
    },
    "image.zoom": {
        group: "image", type: "float", default: 1, min: 1, max: 4, scope: "camera",
        label: "Digital zoom", unit: "x",
        help: "Crops in and scales back up. There is no extra detail to recover, " +
              "but it fills the frame with the part you care about — and the " +
              "detector sees a larger person too."
    },
    "image.panX": {
        group: "image", type: "float", default: 0, min: -1, max: 1, scope: "camera",
        label: "Pan horizontally",
        help: "Which part of the frame to zoom into. No effect at 1x zoom."
    },
    "image.panY": {
        group: "image", type: "float", default: 0, min: -1, max: 1, scope: "camera",
        label: "Pan vertically",
        help: "No effect at 1x zoom."
    },

    // ---- Continuous recording -----------------------------------------
    //
    // The always-on reel you scrub back through. Off by default: it writes
    // around 1.2 GB per camera per day at these settings, and a fresh install
    // shouldn't start consuming someone's disk without being asked.
    "continuous.enabled": {
        group: "continuous", type: "boolean", default: false, scope: "both",
        label: "Record continuously",
        help: "Records around the clock so you can go back and watch any moment, " +
              "not just detected events. Old footage is deleted automatically to " +
              "stay inside the storage budget — events and anything you've saved " +
              "are never deleted to make room."
    },
    "continuous.fps": {
        group: "continuous", type: "int", default: 8, min: 1, max: 30, scope: "both",
        label: "Frame rate", unit: "fps",
        help: "Lower means far less disk for the same number of days. 8 is smooth " +
              "enough to follow what happened; 2-4 is fine if you mainly want a " +
              "visual record and are short on space."
    },
    "continuous.crf": {
        group: "continuous", type: "int", default: 32, min: 18, max: 45, scope: "both",
        label: "Quality (CRF)",
        help: "Lower is better quality and a bigger file. 32 is deliberately softer " +
              "than event clips — this footage exists so you can go back and look, " +
              "while events are the ones you keep."
    },
    "continuous.segmentMinutes": {
        group: "continuous", type: "int", default: 5, min: 1, max: 30, scope: "both",
        advanced: true,
        label: "Segment length", unit: "min",
        help: "Footage is stored in chunks of this length. Chunks are the unit of " +
              "both deletion and seeking, so smaller means finer-grained cleanup " +
              "and slightly more files."
    },

    // ---- Recording ----------------------------------------------------
    "recording.enabled": {
        group: "recording", type: "boolean", default: true, scope: "both",
        label: "Record clips",
        help: "When off, events are still logged but no video is written."
    },
    "recording.codec": {
        group: "recording", type: "enum", values: ["h264", "mkv"], default: "h264",
        scope: "both", yamlPath: "recording.codec",
        label: "Codec",
        help: "h264 (mp4) is ~13x smaller than MJPEG and plays in every browser. " +
              "mkv stream-copies the camera's MJPEG at near-zero CPU — use it only " +
              "if the hub is CPU-starved."
    },
    "recording.crf": {
        group: "recording", type: "int", default: 28, min: 18, max: 40, scope: "both",
        yamlPath: "recording.crf", advanced: true,
        label: "h264 quality (CRF)",
        help: "Lower is better quality and a bigger file. 23 is visually lossless-ish, " +
              "28 is a good default, 32 is noticeably soft. Ignored for mkv."
    },
    "recording.fps": {
        group: "recording", type: "int", default: 15, min: 1, max: 60, scope: "both",
        yamlPath: "recording.fps", advanced: true,
        label: "Clip frame rate", unit: "fps",
        help: "Should match the camera's capture fps."
    },
    "recording.preRollSeconds": {
        group: "recording", type: "int", default: 5, min: 0, max: 30, scope: "both",
        yamlPath: "recording.preRollSeconds",
        label: "Pre-roll", unit: "s",
        help: "Seconds of video kept from *before* the detection fired. This is what " +
              "captures the approach instead of starting with someone already in frame."
    },
    "recording.postRollSeconds": {
        group: "recording", type: "int", default: 5, min: 0, max: 60, scope: "both",
        yamlPath: "recording.postRollSeconds",
        label: "Post-roll", unit: "s",
        help: "Seconds to keep recording after the person is gone."
    },
    "recording.minClipSeconds": {
        group: "recording", type: "float", default: 2, min: 0, max: 60, scope: "both",
        yamlPath: "recording.minClipSeconds",
        label: "Minimum event length", unit: "s",
        help: "Detections shorter than this are discarded as false positives. " +
              "Measured on the detection window, not including pre/post-roll."
    },
    "recording.maxClipSeconds": {
        group: "recording", type: "int", default: 300, min: 10, max: 3600, scope: "both",
        yamlPath: "recording.maxClipSeconds",
        label: "Maximum clip length", unit: "s",
        help: "A continuous event longer than this is split into a new clip."
    },
    "recording.graceMs": {
        group: "recording", type: "int", default: 1500, min: 250, max: 30000, scope: "both",
        yamlPath: "recording.graceMs", advanced: true,
        label: "End-of-event grace", unit: "ms",
        help: "How long the person must be absent before the event is considered over. " +
              "Too low and one person becomes three events as detection flickers."
    },
    "recording.thumbnails": {
        group: "recording", type: "boolean", default: true, scope: "both",
        label: "Save event thumbnails",
        help: "A ~10 KB JPEG per event. Makes the event list scannable."
    },

    // ---- Storage ------------------------------------------------------
    "storage.retentionDays": {
        group: "storage", type: "int", default: 14, min: 0, max: 365, scope: "both",
        yamlPath: "recording.retentionDays",
        label: "Keep events for", unit: "days",
        help: "Events and clips older than this are deleted. 0 disables age-based cleanup."
    },
    "storage.maxTotalGB": {
        group: "storage", type: "float", default: 16, min: 0, max: 4096, scope: "global",
        label: "Clip storage budget", unit: "GB",
        help: "When clips exceed this, the oldest are deleted first. The event log rows " +
              "survive — you keep the history, you lose the video. 0 disables the budget."
    },
    "storage.continuousMaxGB": {
        group: "storage", type: "float", default: 8, min: 0, max: 8192, scope: "global",
        label: "Continuous footage budget", unit: "GB",
        help: "How much disk the always-on reel may use across all cameras. When it's " +
              "full the oldest footage is deleted to make room for new. Saved moments " +
              "and event clips are never taken. 0 disables the budget — only do that " +
              "if something else is bounding the disk."
    },
    "storage.continuousRetentionDays": {
        group: "storage", type: "int", default: 0, min: 0, max: 365, scope: "global",
        advanced: true,
        label: "Continuous age limit", unit: "days",
        help: "Optionally also delete continuous footage older than this, even if the " +
              "budget isn't full. 0 means age doesn't matter and only the budget applies."
    },
    "storage.minFreeGB": {
        group: "storage", type: "float", default: 4, min: 0, max: 1024, scope: "global",
        label: "Reserve free disk", unit: "GB",
        help: "A hard floor for the filesystem. Below it the hub prunes aggressively and, " +
              "if that isn't enough, stops writing new clips while still logging events. " +
              "This is what keeps a full card from taking the whole hub down."
    },
    "storage.sweepIntervalMinutes": {
        group: "storage", type: "int", default: 15, min: 1, max: 1440, scope: "global",
        advanced: true,
        label: "Cleanup interval", unit: "min",
        help: "How often the retention sweep runs. A sweep also runs after every clip."
    },
    "storage.backupEnabled": {
        group: "storage", type: "boolean", default: true, scope: "global",
        label: "Nightly database backup",
        help: "Keeps 7 dated copies of events.db. Clips are re-recordable; your profiles " +
              "and zone definitions are not."
    },

    // ---- Detection ----------------------------------------------------
    "detection.enabled": {
        group: "detection", type: "boolean", default: true, scope: "camera",
        label: "Detect people",
        help: "Per-camera mute. The hub-wide detector switch is separate."
    },
    "detection.fps": {
        group: "detection", type: "float", default: 2, min: 0.25, max: 15, scope: "global",
        yamlPath: "detection.fps",
        label: "Detector rate", unit: "fps",
        help: "How often frames are run through the model. Higher catches fast movement " +
              "but costs CPU on the hub."
    },
    "detection.confidence": {
        group: "detection", type: "float", default: 0.45, min: 0.05, max: 0.95, scope: "both",
        yamlPath: "detection.confidence",
        label: "Confidence threshold",
        help: "Minimum score to count as a person. Raise it if you get false positives " +
              "from shadows or parked cars."
    },
    "detection.motionGate": {
        group: "detection", type: "boolean", default: true, scope: "both",
        label: "Skip still frames",
        help: "Cheap pixel-difference check before running the model. Cuts idle CPU by " +
              "roughly 80% and lets you raise the detector rate for the same total load."
    },
    "detection.motionThreshold": {
        group: "detection", type: "float", default: 0.012, min: 0.001, max: 0.5,
        scope: "both", advanced: true,
        label: "Motion sensitivity",
        help: "Fraction of the frame that must change to wake the detector. Lower is more " +
              "sensitive. Raise it if wind or rain keeps waking the model."
    },

    // ---- Door light ---------------------------------------------------
    "led.enabled": {
        group: "led", type: "boolean", default: false, scope: "camera",
        label: "Enable door light",
        help: "Requires a WS281x strip wired to the camera Pi's SPI pin (GPIO10)."
    },
    "led.count": {
        group: "led", type: "int", default: 8, min: 1, max: 144, scope: "camera",
        label: "LED count"
    },
    "led.brightness": {
        group: "led", type: "float", default: 0.4, min: 0.02, max: 1, scope: "camera",
        label: "Maximum brightness",
        help: "Capped at 40% by default. Eight LEDs at full white draw ~480 mA — do not " +
              "run that off the Pi Zero's 5V rail while the PiSugar is charging."
    },
    "led.idleGlow": {
        group: "led", type: "float", default: 0, min: 0, max: 1, scope: "camera",
        label: "Idle nightlight",
        help: "Dim always-on level when nothing is happening. 0 is off."
    },
    "led.passingSeconds": {
        group: "led", type: "float", default: 3, min: 0.5, max: 30, scope: "camera",
        advanced: true,
        label: "Present after", unit: "s",
        help: "Someone in frame longer than this escalates from a passing sweep to a steady glow."
    },
    "led.dwellSeconds": {
        group: "led", type: "float", default: 10, min: 1, max: 120, scope: "camera",
        label: "Dwelling after", unit: "s",
        help: "Standing still this long escalates the animation."
    },
    "led.loiterSeconds": {
        group: "led", type: "float", default: 30, min: 5, max: 600, scope: "camera",
        label: "Loitering after", unit: "s",
        help: "The top alert level."
    },
    "led.illuminateOnEvent": {
        group: "led", type: "boolean", default: false, scope: "camera",
        label: "Illuminate after dark",
        help: "Drive the strip to bright white during a night-time event. Doubles as a " +
              "cheap substitute for an IR illuminator and measurably improves detection."
    },

    // ---- Events -------------------------------------------------------
    "events.sceneDescription": {
        group: "events", type: "string", default: "", scope: "camera",
        label: "Scene guidance",
        help: "Plain-English notes about what this camera sees, e.g. \"Front door. The " +
              "door on the left is the trash room. The sidewalk at the top of frame is public.\" " +
              "Used to write event descriptions."
    },
    "events.friendlyName": {
        group: "events", type: "string", default: "", scope: "camera",
        label: "Display name",
        help: "Shown instead of the camera id. e.g. \"Front Door\"."
    },
    "events.offlineAlertMinutes": {
        group: "events", type: "int", default: 10, min: 0, max: 1440, scope: "both",
        label: "Offline alert after", unit: "min",
        help: "Log a camera_offline event when a camera stops reporting for this long. " +
              "A camera that's been down for days is worse than no camera — you think " +
              "you're covered. 0 disables."
    },
    "events.webhookUrl": {
        group: "events", type: "string", default: "", scope: "global",
        label: "Event webhook",
        help: "Optional. The hub POSTs a JSON summary of each finalized event here. " +
              "Point it at ntfy, Home Assistant, or anything that accepts a webhook."
    },

    // ---- System -------------------------------------------------------
    "system.latitude": {
        group: "system", type: "float", default: 0, min: -90, max: 90, scope: "global",
        advanced: true,
        label: "Latitude",
        help: "Used only to compute sunrise/sunset for \"after dark\" wording and the " +
              "night illumination trigger. Never leaves the hub."
    },
    "system.longitude": {
        group: "system", type: "float", default: 0, min: -180, max: 180, scope: "global",
        advanced: true,
        label: "Longitude"
    },
    "system.logLevel": {
        group: "system", type: "enum", values: ["debug", "info", "warn", "error"], default: "info",
        scope: "global", yamlPath: "logging.level",
        label: "Log level",
        help: "Applies immediately, no restart needed. \"debug\" is very chatty — turn it on " +
              "while chasing a problem, then back off to \"info\"."
    }
};

const VALID_SCOPES = new Set(["global", "camera", "both"]);

/** Read a dotted path out of a plain object. */
function readPath(obj, dotted) {
    if (!obj || !dotted) return undefined;
    let cur = obj;
    for (const part of dotted.split(".")) {
        if (cur === null || typeof cur !== "object") return undefined;
        cur = cur[part];
    }
    return cur;
}

/**
 * Coerce and bounds-check a value against its schema entry.
 * @returns {{ok: true, value: *} | {ok: false, error: string}}
 */
function validate(key, raw) {
    const def = SCHEMA[key];
    if (!def) return { ok: false, error: `unknown setting "${key}"` };

    switch (def.type) {
        case "boolean": {
            if (typeof raw === "boolean") return { ok: true, value: raw };
            if (raw === "true" || raw === 1) return { ok: true, value: true };
            if (raw === "false" || raw === 0) return { ok: true, value: false };
            return { ok: false, error: `${key} must be a boolean` };
        }
        case "int":
        case "float": {
            const n = typeof raw === "number" ? raw : Number(raw);
            if (!isFinite(n)) return { ok: false, error: `${key} must be a number` };
            const v = def.type === "int" ? Math.round(n) : n;
            if (def.min !== undefined && v < def.min) {
                return { ok: false, error: `${key} must be >= ${def.min}` };
            }
            if (def.max !== undefined && v > def.max) {
                return { ok: false, error: `${key} must be <= ${def.max}` };
            }
            return { ok: true, value: v };
        }
        case "enum": {
            const s = String(raw);
            if (!def.values.includes(s)) {
                return { ok: false, error: `${key} must be one of ${def.values.join(", ")}` };
            }
            return { ok: true, value: s };
        }
        case "string": {
            if (raw === null || raw === undefined) return { ok: true, value: "" };
            const s = String(raw);
            if (s.length > 4000) return { ok: false, error: `${key} is too long (max 4000 chars)` };
            return { ok: true, value: s };
        }
        default:
            return { ok: false, error: `${key} has an unsupported type` };
    }
}

function scopeAllows(def, isCameraScope) {
    if (def.scope === "both") return true;
    return isCameraScope ? def.scope === "camera" : def.scope === "global";
}

class SettingsService {
    /**
     * @param {object} opts
     * @param {object} opts.store    Open Store instance (provides get/set/allSettings).
     * @param {object} [opts.fileCfg]  Parsed config.yml, used for the bootstrap layer.
     * @param {object} [opts.logger]
     */
    constructor({ store, fileCfg, logger } = {}) {
        if (!store) throw new Error("SettingsService: store is required");
        this.store = store;
        this.fileCfg = fileCfg || {};
        this.log = logger || console;
        this._subscribers = new Set();

        // scope -> Map(key -> value). "global" plus one entry per camera.
        this._cache = new Map();
        this.reload();
    }

    /** Re-read every override from the DB. Cheap; the table is tiny. */
    reload() {
        this._cache = new Map();
        let rows = [];
        try {
            rows = this.store.allSettings();
        } catch (err) {
            this.log.warn(`[hub] failed to load settings: ${err && err.message}`);
        }
        for (const row of rows) {
            if (!this._cache.has(row.scope)) this._cache.set(row.scope, new Map());
            this._cache.get(row.scope).set(row.key, row.value);
        }
    }

    /** The schema, for the UI to render controls from. */
    describe() {
        return { groups: GROUPS, settings: SCHEMA };
    }

    /**
     * Resolve one key. Pass `camId` to apply that camera's override layer.
     */
    get(key, camId) {
        const def = SCHEMA[key];
        if (!def) throw new Error(`unknown setting "${key}"`);

        if (camId && (def.scope === "camera" || def.scope === "both")) {
            const camScope = this._cache.get(camId);
            if (camScope && camScope.has(key)) return camScope.get(key);
        }

        if (def.scope !== "camera") {
            const globalScope = this._cache.get("global");
            if (globalScope && globalScope.has(key)) return globalScope.get(key);
        }

        if (def.yamlPath) {
            const fromFile = readPath(this.fileCfg, def.yamlPath);
            if (fromFile !== undefined) {
                const checked = validate(key, fromFile);
                if (checked.ok) return checked.value;
                this.log.warn(`[hub] config.yml ${def.yamlPath}: ${checked.error}; using default`);
            }
        }

        return def.default;
    }

    /**
     * Every setting resolved for a scope, as a flat object.
     * @param {string} [camId]  Omit for the hub-wide view.
     */
    all(camId) {
        const out = {};
        for (const key of Object.keys(SCHEMA)) {
            const def = SCHEMA[key];
            if (camId) {
                if (def.scope === "global") continue;
            } else if (def.scope === "camera") {
                continue;
            }
            out[key] = this.get(key, camId);
        }
        return out;
    }

    /**
     * Which keys are explicitly overridden at this scope (vs inherited).
     * The UI uses this to show a "reset to default" affordance.
     */
    overrides(camId) {
        const scope = this._cache.get(camId || "global");
        if (!scope) return {};
        const out = {};
        for (const [k, v] of scope) out[k] = v;
        return out;
    }

    /**
     * Apply a patch of {key: value}. All-or-nothing: if any key fails
     * validation nothing is written, so a bad form submission can't leave
     * settings half-applied.
     *
     * @param {object} patch
     * @param {string} [camId]  Omit to write the global scope.
     * @returns {{ok: true, changed: string[]} | {ok: false, errors: string[]}}
     */
    set(patch, camId) {
        if (!patch || typeof patch !== "object") {
            return { ok: false, errors: ["body must be an object of setting keys"] };
        }
        const scope = camId || "global";
        const isCameraScope = !!camId;

        const errors = [];
        const accepted = [];
        for (const [key, raw] of Object.entries(patch)) {
            const def = SCHEMA[key];
            if (!def) { errors.push(`unknown setting "${key}"`); continue; }
            if (!scopeAllows(def, isCameraScope)) {
                errors.push(
                    isCameraScope
                        ? `"${key}" is a hub-wide setting and cannot be set per camera`
                        : `"${key}" can only be set on a camera`
                );
                continue;
            }
            // null means "clear the override and go back to inheriting".
            if (raw === null) { accepted.push([key, null]); continue; }
            const checked = validate(key, raw);
            if (!checked.ok) { errors.push(checked.error); continue; }
            accepted.push([key, checked.value]);
        }

        if (errors.length) return { ok: false, errors };

        const changed = [];
        for (const [key, value] of accepted) {
            const before = this.get(key, camId);
            if (value === null) {
                this.store.deleteSetting(scope, key);
                const scopeMap = this._cache.get(scope);
                if (scopeMap) scopeMap.delete(key);
            } else {
                this.store.putSetting(scope, key, value);
                if (!this._cache.has(scope)) this._cache.set(scope, new Map());
                this._cache.get(scope).set(key, value);
            }
            if (this.get(key, camId) !== before) changed.push(key);
        }

        if (changed.length) this._notify(changed, scope);
        return { ok: true, changed };
    }

    /**
     * Subscribe to changes. Handler gets `(changedKeys, scope)`.
     * @returns {function(): void} unsubscribe
     */
    subscribe(fn) {
        this._subscribers.add(fn);
        return () => this._subscribers.delete(fn);
    }

    _notify(changed, scope) {
        for (const fn of this._subscribers) {
            try {
                fn(changed, scope);
            } catch (err) {
                this.log.warn(`[hub] settings subscriber threw: ${err && err.message}`);
            }
        }
    }
}

module.exports = { SettingsService, SCHEMA, GROUPS, validate };
