#!/usr/bin/env node
"use strict";

/**
 * LuxSecurityHub entry point.
 *
 * Loads YAML config in this order:
 *   1. CLI arg:   `node src/hub.js /path/to/config.yml`
 *   2. Env var:   $LUXHUB_CONFIG
 *   3. Default:   /etc/lux-security-hub/config.yml
 *
 * Falls through to built-in defaults (see `config.example.yml`) if the file
 * is missing — useful for `node src/hub.js` smoke tests on a dev box.
 */

const fs = require("node:fs");
const path = require("node:path");
const yaml = require("js-yaml");

const log = require("./log");
const { HubServer } = require("./server");

const DEFAULT_CONFIG_PATH = "/etc/lux-security-hub/config.yml";

const DEFAULT_CONFIG = {
    hub: { port: 5000, bindAddr: "0.0.0.0" },
    detection: {
        enabled: false,
        fps: 2,
        confidence: 0.45,
        classes: ["person"],
        modelUrl: "https://github.com/JaredLodwick/DoorCamera/releases/download/models-v1/yolov8n-int8.onnx",
        modelSha256: ""
    },
    recording: {
        codec: "mkv",
        fps: 15,
        minClipSeconds: 2,
        maxClipSeconds: 300,
        graceMs: 1500,
        retentionDays: 14
    },
    storage: {
        clipsRoot: "~/Videos/SecurityCamera",
        dbPath: "~/.luxsecurityhub/events.db"
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
    if (process.env.LUXHUB_CONFIG) return process.env.LUXHUB_CONFIG;
    return DEFAULT_CONFIG_PATH;
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
