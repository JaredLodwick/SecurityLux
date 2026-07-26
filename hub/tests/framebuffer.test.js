"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { FrameBuffer } = require("../src/framebuffer");

const frame = (bytes = 1000) => Buffer.alloc(bytes, 1);

test("keeps only the configured number of frames", () => {
    const buffer = new FrameBuffer({ seconds: 2, fps: 10 });   // capacity 20
    for (let i = 0; i < 50; i += 1) buffer.push(frame(), i, 1000 + i * 100);

    assert.equal(buffer.stats().count, 20);
    assert.equal(buffer.latest().seq, 49);
});

test("returns frames within a time window, oldest first", () => {
    const buffer = new FrameBuffer({ seconds: 10, fps: 10 });
    for (let i = 0; i < 100; i += 1) buffer.push(frame(), i, 10_000 + i * 100);

    // Last 3 seconds ending at the newest frame's timestamp.
    const recent = buffer.recent(3, 19_900);
    assert.ok(recent.length >= 29 && recent.length <= 31, `got ${recent.length}`);
    assert.ok(recent[0].ts < recent[recent.length - 1].ts, "oldest first");
    assert.ok(recent[0].ts >= 16_900);
});

test("enforces a byte ceiling regardless of the frame-count target", () => {
    // A camera sending unexpectedly large frames must degrade to less pre-roll
    // rather than consuming the hub's memory.
    const buffer = new FrameBuffer({ seconds: 30, fps: 30, maxBytes: 50_000 });
    for (let i = 0; i < 200; i += 1) buffer.push(frame(10_000), i, 1000 + i * 33);

    assert.ok(buffer.stats().bytes <= 50_000, `bytes = ${buffer.stats().bytes}`);
    assert.ok(buffer.stats().count <= 6);
    assert.ok(buffer.latest(), "the newest frame is always retained");
});

test("nearest picks the frame closest to a timestamp", () => {
    const buffer = new FrameBuffer({ seconds: 10, fps: 10 });
    for (let i = 0; i < 50; i += 1) buffer.push(frame(), i, 1000 + i * 100);

    assert.equal(buffer.nearest(3040).ts, 3000);
    assert.equal(buffer.nearest(0).ts, 1000, "clamps to the oldest");
    assert.equal(buffer.nearest(999_999).ts, 5900, "clamps to the newest");
});

test("resizing capacity takes effect immediately", () => {
    const buffer = new FrameBuffer({ seconds: 5, fps: 10 });
    for (let i = 0; i < 50; i += 1) buffer.push(frame(), i, 1000 + i * 100);
    assert.equal(buffer.stats().count, 50);

    buffer.setCapacity({ seconds: 1, fps: 10 });
    assert.equal(buffer.stats().count, 10, "shrinking drops the oldest frames");
});

test("clear empties the buffer and its byte count", () => {
    const buffer = new FrameBuffer({ seconds: 5, fps: 10 });
    for (let i = 0; i < 20; i += 1) buffer.push(frame(), i);
    buffer.clear();

    assert.equal(buffer.stats().count, 0);
    assert.equal(buffer.stats().bytes, 0);
    assert.equal(buffer.latest(), null);
});

test("ignores empty frames and survives an empty buffer", () => {
    const buffer = new FrameBuffer({ seconds: 5, fps: 10 });
    buffer.push(null, 1);
    buffer.push(Buffer.alloc(0), 2);

    assert.equal(buffer.stats().count, 0);
    assert.equal(buffer.latest(), null);
    assert.equal(buffer.nearest(123), null);
    assert.deepEqual(buffer.recent(5), []);
});

test("zero pre-roll returns nothing without erroring", () => {
    const buffer = new FrameBuffer({ seconds: 0, fps: 10 });
    for (let i = 0; i < 5; i += 1) buffer.push(frame(), i);
    assert.deepEqual(buffer.recent(0), []);
});

test("a timestamp of 0 is honoured rather than replaced by the clock", () => {
    const buffer = new FrameBuffer({ seconds: 5, fps: 10 });
    buffer.push(frame(), 1, 0);
    assert.equal(buffer.latest().ts, 0);
});
