"use strict";

/**
 * Unit tests for hub/src/log.js — category routing, level filtering, and
 * file-size rotation.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const log = require("../src/log");

function tmpLogDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), "securityluxhub-logs-"));
}

test("each category writes to its own file", () => {
    const dir = tmpLogDir();
    log.configure({ dir });
    log.setLevel("info");

    log.info("system message");
    log.forCategory("motion").info("motion message");
    log.forCategory("recording").warn("recording message");

    const system = fs.readFileSync(path.join(dir, "system.log"), "utf8");
    const motion = fs.readFileSync(path.join(dir, "motion.log"), "utf8");
    const recording = fs.readFileSync(path.join(dir, "recording.log"), "utf8");

    assert.match(system, /\[system\] system message/);
    assert.match(motion, /\[motion\] motion message/);
    assert.match(recording, /\[recording\] recording message/);

    // Each category's file holds only its own lines.
    assert.doesNotMatch(system, /motion message/);
    assert.doesNotMatch(motion, /system message/);
});

test("forCategory returns an independent logger sharing the level threshold", () => {
    const dir = tmpLogDir();
    log.configure({ dir });
    log.setLevel("warn");

    const motion = log.forCategory("motion");
    motion.debug("should be dropped");
    motion.info("should also be dropped");
    motion.warn("should land");

    const content = fs.readFileSync(path.join(dir, "motion.log"), "utf8");
    assert.doesNotMatch(content, /dropped/);
    assert.match(content, /should land/);

    log.setLevel("info"); // restore default for other tests
});

test("rotates a category's file once it crosses the configured size", () => {
    const dir = tmpLogDir();
    log.configure({ dir, maxFileSizeMb: 0.001, maxBackupFiles: 2 }); // ~1KB
    log.setLevel("info");

    const cat = log.forCategory("recording-rotate-test");
    for (let i = 0; i < 200; i++) {
        cat.info(`padding line ${i} ${"x".repeat(40)}`);
    }

    const filePath = path.join(dir, "recording-rotate-test.log");
    const backupPath = `${filePath}.1`;
    assert.ok(fs.existsSync(filePath), "current log file should exist");
    assert.ok(fs.existsSync(backupPath), "a rotated backup should have been created");

    log.configure({ dir: "~/.securityluxhub/logs", maxFileSizeMb: 10, maxBackupFiles: 3 }); // restore defaults
});

test("configure() with no writable dir falls back to console-only without throwing", () => {
    // A path that can't be created (a file where a directory is expected).
    const parent = tmpLogDir();
    const blocker = path.join(parent, "blocker");
    fs.writeFileSync(blocker, "not a directory");

    assert.doesNotThrow(() => {
        log.configure({ dir: path.join(blocker, "logs") });
        log.info("still works via console");
    });

    log.configure({ dir: tmpLogDir() }); // restore a working dir for any tests after this one
});
