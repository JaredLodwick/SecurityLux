#!/usr/bin/env node
"use strict";

/**
 * SecurityLuxHub entry point.
 *
 * Resolves the config file by checking, in order:
 *   1. CLI arg:    `node src/hub.js /path/to/config.yml`
 *   2. Env var:    $SECURITY_LUX_HUB_CONFIG
 *   3. Default search path (first one that exists):
 *        ~/.config/securityluxhub/config.yml   (user-level; macOS, Linux, …)
 *        /etc/security-lux-hub/config.yml      (system-level; Linux/systemd)
 *
 * Falls through to built-in defaults (see `config.example.yml`) if no file
 * is found — useful for `node src/hub.js` smoke tests on a dev box.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const yaml = require("js-yaml");

const log = require("./log");
const { HubServer } = require("./server");

const DEFAULT_CONFIG_PATHS = [
    path.join(os.homedir(), ".config", "securityluxhub", "config.yml"),
    "/etc/security-lux-hub/config.yml"
];

/**
 * Bootstrap-only defaults.
 *
 * Deliberately narrow: these are the settings that must be known *before* the
 * database exists — where to listen, where the database lives, which model to
 * download. Everything else (recording, retention, detection tuning, LED,
 * zones) is declared once in `settings.js` and resolved through the layering
 * defaults -> config.yml -> DB -> per-camera.
 *
 * Duplicating those defaults here as well would create two sources of truth
 * that drift, and the file copy would silently win over the schema's.
 */
const DEFAULT_CONFIG = {
    hub: { port: 5000, bindAddr: "0.0.0.0" },
    detection: {
        enabled: false,
        classes: ["person"],
        modelUrl: "https://github.com/JaredLodwick/SecurityLux/releases/download/models-v1/yolov8n-int8.onnx",
        modelSha256: "ac165577e12c3fb930b7648b265053fa801011e659c11b7cda52fa8ee027589c"
    },
    storage: {
        clipsRoot: "~/Videos/SecurityLux",
        dbPath: "~/.securityluxhub/events.db"
    },
    logging: { level: "info" }
};

function deepMerge(base, overlay) {
    if (!overlay || typeof overlay !== "object") return base;
    const out = Array.isArray(base) ? [...base] : { ...base };
    for (const [k, v] of Object.entries(overlay)) {
        if (v && typeof v === "object" && !Array.isArray(v)
            && out[k] && typeof out[k] === "object" && !Array.isArray(out[k])) {
            out[k] = deepMerge(out[k], v);
        } else {
            out[k] = v;
        }
    }
    return out;
}

function resolveConfigPath() {
    if (process.argv[2]) return process.argv[2];
    if (process.env.SECURITY_LUX_HUB_CONFIG) return process.env.SECURITY_LUX_HUB_CONFIG;
    for (const candidate of DEFAULT_CONFIG_PATHS) {
        if (fs.existsSync(candidate)) return candidate;
    }
    // None of the defaults exist — return the first so the warn message is
    // specific about where we expected to find one.
    return DEFAULT_CONFIG_PATHS[0];
}

function loadConfig() {
    const cfgPath = resolveConfigPath();
    if (!fs.existsSync(cfgPath)) {
        log.warn(`config file not found at ${cfgPath}; using built-in defaults`);
        return DEFAULT_CONFIG;
    }
    let parsed;
    try {
        parsed = yaml.load(fs.readFileSync(cfgPath, "utf8"));
    } catch (err) {
        log.error(`failed to parse ${cfgPath}: ${err.message}`);
        process.exit(1);
    }
    log.info(`loaded config from ${cfgPath}`);
    return deepMerge(DEFAULT_CONFIG, parsed || {});
}

async function main() {
    const cfg = loadConfig();
    log.setLevel((cfg.logging && cfg.logging.level) || "info");

    const hub = new HubServer(cfg, log);
    await hub.start();

    const shutdown = (signal) => {
        log.info(`received ${signal}; shutting down`);
        hub.stop().then(() => process.exit(0)).catch((err) => {
            log.error(`shutdown error: ${err.message}`);
            process.exit(1);
        });
    };
    process.on("SIGINT",  () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
    log.error(`fatal: ${err && err.stack || err}`);
    process.exit(1);
});
