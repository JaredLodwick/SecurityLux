"use strict";

/**
 * Categorized, console-backed logger with the `info`, `warn`, `error`, and
 * `debug` methods used throughout the hub.
 *
 * Every category still goes to stdout/stderr (so `journalctl -fu
 * security-lux-hub` keeps showing the whole picture), but each category
 * *also* gets its own file under `logging.dir` so a subsystem's noise can be
 * followed — or ignored — on its own:
 *
 *   ~/.securityluxhub/logs/system.log     service lifecycle, connections,
 *                                         storage, settings, anything that
 *                                         isn't one of the below
 *   ~/.securityluxhub/logs/motion.log     detection ticks, sessions,
 *                                         tracked behaviour, door light
 *   ~/.securityluxhub/logs/recording.log  event-clip + continuous ffmpeg
 *                                         processes
 *
 * `require("./log")` is the default "system" logger; call `.forCategory(x)`
 * on it (or on any category logger) to get another one. All categories share
 * one level threshold and one file-size cap, set once via `setLevel` /
 * `configure`.
 */

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const DEFAULT_LOG_DIR = "~/.securityluxhub/logs";
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024; // rotate a category's file past 10 MB
const DEFAULT_MAX_BACKUPS = 3;

let threshold = LEVELS.info;
let logDir = null;          // null until configure() runs; file output is skipped until then
let maxBytes = DEFAULT_MAX_BYTES;
let maxBackups = DEFAULT_MAX_BACKUPS;

function expandHome(p) {
    if (typeof p !== "string") return p;
    if (p === "~") return os.homedir();
    if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
    return p;
}

function setLevel(name) {
    const next = LEVELS[String(name || "info").toLowerCase()];
    if (typeof next === "number") threshold = next;
}

/**
 * Point category loggers at a directory on disk and size-cap what lands
 * there. Called once from hub.js after config is parsed; before this runs
 * (or if it fails), category loggers still work — they just print to the
 * console/journal like the hub always has, with no per-category file.
 */
function configure({ dir, maxFileSizeMb, maxBackupFiles } = {}) {
    logDir = expandHome(dir || DEFAULT_LOG_DIR);
    if (typeof maxFileSizeMb === "number" && maxFileSizeMb > 0) {
        maxBytes = maxFileSizeMb * 1024 * 1024;
    }
    if (typeof maxBackupFiles === "number" && maxBackupFiles >= 0) {
        maxBackups = maxBackupFiles;
    }
    try {
        fs.mkdirSync(logDir, { recursive: true });
    } catch (err) {
        console.error(`log: failed to create log dir ${logDir}: ${err.message}`);
        logDir = null;
    }
}

function rotateIfNeeded(filePath) {
    let size = 0;
    try { size = fs.statSync(filePath).size; } catch (_) { return; }
    if (size < maxBytes) return;
    for (let i = maxBackups; i >= 1; i--) {
        const src = i === 1 ? filePath : `${filePath}.${i - 1}`;
        const dest = `${filePath}.${i}`;
        try {
            if (i === maxBackups) fs.rmSync(dest, { force: true });
            fs.renameSync(src, dest);
        } catch (_) { /* best effort; a failed rotation just means one big file */ }
    }
}

/**
 * Append one line to a category's file, rotating first if it's grown past
 * the size cap. Synchronous on purpose: log volume here is nowhere near
 * what would make that a bottleneck, and it means a line is either on disk
 * or the write threw — no buffered-but-lost-on-crash window to reason about.
 */
function writeToFile(category, line) {
    if (!logDir) return;
    const filePath = path.join(logDir, `${category}.log`);
    try {
        rotateIfNeeded(filePath);
        fs.appendFileSync(filePath, `${line}\n`);
    } catch (err) {
        console.error(`log: write to ${filePath} failed: ${err.message}`);
    }
}

function formatArg(a) {
    if (typeof a === "string") return a;
    try { return JSON.stringify(a); } catch (_) { return String(a); }
}

function emit(category, level, args) {
    if (LEVELS[level] < threshold) return;
    const ts = new Date().toISOString();
    const line = `${ts} ${level.toUpperCase().padEnd(5)} [${category}] ${args.map(formatArg).join(" ")}`;

    // Use the matching console method so log aggregators (journald) bucket
    // stderr vs stdout correctly. Every category still lands here, combined.
    const fn = level === "error" ? console.error
             : level === "warn"  ? console.warn
             : console.log;
    fn(line);
    writeToFile(category, line);
}

function makeLogger(category) {
    return {
        debug: (...a) => emit(category, "debug", a),
        info:  (...a) => emit(category, "info",  a),
        warn:  (...a) => emit(category, "warn",  a),
        error: (...a) => emit(category, "error", a),
        forCategory: (name) => makeLogger(name)
    };
}

module.exports = Object.assign(makeLogger("system"), { setLevel, configure, forCategory: makeLogger });
