"use strict";

/**
 * Tiny console-backed logger with the `info`, `warn`, `error`, and `debug`
 * methods used by the hub. Centralizing it here keeps swap potential (pino,
 * winston) easy without touching call sites.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
let threshold = LEVELS.info;

function setLevel(name) {
    const next = LEVELS[String(name || "info").toLowerCase()];
    if (typeof next === "number") threshold = next;
}

function emit(level, args) {
    if (LEVELS[level] < threshold) return;
    const ts = new Date().toISOString();
    // Use the matching console method so log aggregators (journald) bucket
    // stderr vs stdout correctly.
    const fn = level === "error" ? console.error
             : level === "warn"  ? console.warn
             : console.log;
    fn(`${ts} ${level.toUpperCase().padEnd(5)} ${args.map(formatArg).join(" ")}`);
}

function formatArg(a) {
    if (typeof a === "string") return a;
    try { return JSON.stringify(a); } catch (_) { return String(a); }
}

module.exports = {
    setLevel,
    debug: (...a) => emit("debug", a),
    info:  (...a) => emit("info",  a),
    warn:  (...a) => emit("warn",  a),
    error: (...a) => emit("error", a)
};
