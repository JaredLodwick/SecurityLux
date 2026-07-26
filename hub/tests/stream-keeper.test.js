"use strict";

/**
 * Guards on the shared StreamKeeper.
 *
 * The file is deliberately duplicated: the hub serves its copy to the dashboard
 * and the MagicMirror module ships its own so it keeps working when the hub is
 * unreachable. Duplication is the right call there, but it only stays safe if
 * something fails loudly when the copies drift — otherwise the blackout bug
 * gets fixed in one place and quietly persists in the other, which is exactly
 * how it survived this long.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const HUB_COPY = path.join(__dirname, "..", "web", "js", "stream-keeper.js");
const MM_COPY = path.join(
    __dirname, "..", "..", "mm_module", "MMM-SecurityLuxDisplay", "stream-keeper.js"
);

test("the hub and MagicMirror copies of stream-keeper.js are identical", () => {
    const hub = fs.readFileSync(HUB_COPY, "utf8");
    const mirror = fs.readFileSync(MM_COPY, "utf8");
    assert.equal(
        hub, mirror,
        "stream-keeper.js has drifted. Copy hub/web/js/stream-keeper.js over " +
        "mm_module/MMM-SecurityLuxDisplay/stream-keeper.js (mm_module/install.sh does this for you)."
    );
});

test("the pixel hash changes when pixels change", () => {
    const { hashPixels } = require(HUB_COPY);

    const black = new Uint8ClampedArray(16 * 16 * 4);
    const alsoBlack = new Uint8ClampedArray(16 * 16 * 4);
    const oneChanged = new Uint8ClampedArray(16 * 16 * 4);
    oneChanged[40] = 255;

    assert.equal(hashPixels(black), hashPixels(alsoBlack), "identical frames hash the same");
    assert.notEqual(
        hashPixels(black), hashPixels(oneChanged),
        "a changed pixel must change the hash, or a wedged decoder looks alive"
    );
});

test("the alpha channel is excluded from the hash", () => {
    // MJPEG has no alpha; canvas always reports 255. Including it would just
    // be wasted work per sample.
    const { hashPixels } = require(HUB_COPY);
    const a = new Uint8ClampedArray(16 * 16 * 4);
    const b = new Uint8ClampedArray(16 * 16 * 4);
    for (let i = 3; i < b.length; i += 4) b[i] = 128;
    assert.equal(hashPixels(a), hashPixels(b));
});

test("the MagicMirror module no longer drives a blind refresh timer", () => {
    // The original bug: a periodic setInterval nulled the <img> src and relied
    // on morphdom to reapply it, which never re-issued the request and leaked a
    // connection slot each time. Recovery must be evidence-driven now.
    //
    // Matching on `this.config.streamRefreshSeconds` rather than the bare name
    // so the explanatory comments describing the old bug don't trip this.
    const source = fs.readFileSync(
        path.join(__dirname, "..", "..", "mm_module", "MMM-SecurityLuxDisplay",
                  "MMM-SecurityLuxDisplay.js"),
        "utf8"
    );
    assert.doesNotMatch(
        source, /this\.config\.streamRefreshSeconds/,
        "the module still reads the blind refresh interval"
    );
    assert.doesNotMatch(
        source, /_refreshStreamSrc|_scheduleRefreshTimer/,
        "the old timer-driven refresh machinery is still present"
    );
    assert.match(source, /new StreamKeeper\(/, "the module should use StreamKeeper instead");
});
