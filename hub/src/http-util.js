"use strict";

/**
 * Small HTTP helpers shared by the route handlers.
 *
 * The hub deliberately has no web framework. The route surface is a few dozen
 * endpoints on a LAN appliance, and pulling in Express would add a dependency
 * tree larger than the entire rest of the hub to save a hundred lines. These
 * are the hundred lines.
 */

const fs = require("node:fs");
const path = require("node:path");

const MAX_BODY_BYTES = 8 * 1024 * 1024;   // generous enough for a face-sample upload

const MIME_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".ico": "image/x-icon",
    ".mp4": "video/mp4",
    ".mkv": "video/x-matroska",
    ".woff2": "font/woff2"
};

function sendJson(res, status, body) {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
        "Cache-Control": "no-store"
    });
    res.end(payload);
}

function sendError(res, status, message, extra) {
    sendJson(res, status, { error: message, ...(extra || {}) });
}

function sendText(res, status, text, contentType) {
    res.writeHead(status, { "Content-Type": contentType || "text/plain; charset=utf-8" });
    res.end(text);
}

/**
 * Read and parse a JSON request body.
 *
 * Calls back with `(err, body)`. Oversized bodies are rejected rather than
 * silently truncated — a half-parsed settings payload would be worse than a
 * clean failure.
 */
function readJsonBody(req, cb) {
    const chunks = [];
    let total = 0;
    let done = false;

    const finish = (err, body) => {
        if (done) return;
        done = true;
        cb(err, body);
    };

    req.on("data", (chunk) => {
        total += chunk.length;
        if (total > MAX_BODY_BYTES) {
            finish(new Error("request body too large"));
            req.destroy();
            return;
        }
        chunks.push(chunk);
    });
    req.on("end", () => {
        if (!chunks.length) { finish(null, null); return; }
        try {
            finish(null, JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch (_) {
            finish(new Error("body is not valid JSON"));
        }
    });
    req.on("error", (err) => finish(err));
}

function contentTypeFor(filePath) {
    return MIME_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream";
}

/**
 * Serve a file with Range support.
 *
 * Range matters for video: without it a browser can't seek, and Safari refuses
 * to play a <video> source at all unless the server answers 206.
 */
function serveFile(req, res, absPath, { contentType, cacheControl } = {}) {
    let stat;
    try {
        stat = fs.statSync(absPath);
    } catch (_) {
        sendError(res, 404, "file not found");
        return;
    }
    if (!stat.isFile()) {
        sendError(res, 404, "not a file");
        return;
    }

    const type = contentType || contentTypeFor(absPath);
    const range = req.headers.range;

    if (range) {
        const m = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (!m) {
            res.writeHead(416, { "Content-Range": `bytes */${stat.size}` });
            res.end();
            return;
        }
        const start = m[1] ? Number(m[1]) : 0;
        const end = m[2] ? Number(m[2]) : stat.size - 1;
        if (!isFinite(start) || !isFinite(end) || start >= stat.size || end >= stat.size || start > end) {
            res.writeHead(416, { "Content-Range": `bytes */${stat.size}` });
            res.end();
            return;
        }
        res.writeHead(206, {
            "Content-Type": type,
            "Content-Length": end - start + 1,
            "Content-Range": `bytes ${start}-${end}/${stat.size}`,
            "Accept-Ranges": "bytes",
            "Cache-Control": cacheControl || "private, max-age=3600"
        });
        fs.createReadStream(absPath, { start, end }).pipe(res);
        return;
    }

    res.writeHead(200, {
        "Content-Type": type,
        "Content-Length": stat.size,
        "Accept-Ranges": "bytes",
        "Cache-Control": cacheControl || "private, max-age=3600"
    });
    fs.createReadStream(absPath).pipe(res);
}

/**
 * Resolve a request path inside a root directory, refusing traversal.
 * Returns null if the result would escape the root.
 */
function safeResolve(root, relPath) {
    if (typeof relPath !== "string") return null;
    // Reject encoded traversal before it reaches path.resolve.
    let decoded;
    try { decoded = decodeURIComponent(relPath); } catch (_) { return null; }
    if (decoded.includes("\0")) return null;

    const absRoot = path.resolve(root);
    const abs = path.resolve(absRoot, "." + path.sep + decoded.replace(/^[/\\]+/, ""));
    if (abs !== absRoot && !abs.startsWith(absRoot + path.sep)) return null;
    return abs;
}

/** Parse a query param as a finite number, or undefined. */
function numParam(query, name) {
    if (!query || query[name] === undefined) return undefined;
    const n = Number(query[name]);
    return isFinite(n) ? n : undefined;
}

function boolParam(query, name) {
    if (!query || query[name] === undefined) return undefined;
    const v = String(query[name]).toLowerCase();
    return v === "1" || v === "true" || v === "yes";
}

module.exports = {
    sendJson,
    sendError,
    sendText,
    readJsonBody,
    serveFile,
    safeResolve,
    contentTypeFor,
    numParam,
    boolParam,
    MAX_BODY_BYTES
};
