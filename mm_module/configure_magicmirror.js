#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const MODULE_NAME = "MMM-SecurityLuxDisplay";
const VALID_POSITIONS = new Set([
    "top_bar",
    "top_left",
    "top_center",
    "top_right",
    "upper_third",
    "middle_center",
    "lower_third",
    "bottom_left",
    "bottom_center",
    "bottom_right",
    "bottom_bar",
    "fullscreen_above",
    "fullscreen_below"
]);

const [configPath, hubUrl, camId, position, title = "Security Lux"] = process.argv.slice(2);

if (!configPath || !hubUrl || !camId || !position) {
    console.error("Usage: configure_magicmirror.js <config.js> <hubUrl> <camId> <position> [title]");
    process.exit(2);
}

if (!VALID_POSITIONS.has(position)) {
    console.error(`Invalid MagicMirror position: ${position}`);
    console.error(`Valid positions: ${[...VALID_POSITIONS].join(", ")}`);
    process.exit(2);
}

const resolvedConfig = path.resolve(configPath);
const source = fs.readFileSync(resolvedConfig, "utf8");
const modulesArray = findModulesArray(source);
const moduleObjects = topLevelObjects(source, modulesArray.start, modulesArray.end);
const arrayIndent = indentationBefore(source, modulesArray.end);
const entryIndent = moduleObjects[0]
    ? indentationBefore(source, moduleObjects[0].start)
    : `${arrayIndent}    `;
const entry = buildModuleEntry(entryIndent, {
    moduleName: MODULE_NAME,
    position,
    hubUrl,
    camId,
    title
});

let nextSource;
const existing = moduleObjects.find(({ start, end }) => (
    new RegExp(`\\bmodule\\s*:\\s*["']${escapeRegExp(MODULE_NAME)}["']`).test(source.slice(start, end + 1))
));

if (existing) {
    nextSource = source.slice(0, existing.start) + entry + source.slice(existing.end + 1);
} else {
    const lastObject = moduleObjects[moduleObjects.length - 1];
    if (lastObject) {
        const afterLastObject = skipWhitespace(source, lastObject.end + 1);
        const hasTrailingComma = source[afterLastObject] === ",";
        const insertPoint = hasTrailingComma ? afterLastObject + 1 : lastObject.end + 1;
        nextSource = source.slice(0, insertPoint)
            + (hasTrailingComma ? "" : ",")
            + "\n"
            + entry
            + source.slice(insertPoint);
    } else {
        const contentEnd = trimEndIndex(source, modulesArray.start + 1, modulesArray.end);
        nextSource = source.slice(0, contentEnd)
            + "\n"
            + entry
            + "\n"
            + arrayIndent
            + source.slice(modulesArray.end);
    }
}

try {
    new vm.Script(nextSource, { filename: resolvedConfig });
} catch (err) {
    console.error(`Refusing to write invalid MagicMirror config: ${err.message}`);
    process.exit(1);
}

const backupPath = `${resolvedConfig}.securitylux.bak.${timestamp()}`;
fs.copyFileSync(resolvedConfig, backupPath);
fs.writeFileSync(resolvedConfig, nextSource, "utf8");

console.log(`updated: ${resolvedConfig}`);
console.log(`backup:  ${backupPath}`);
console.log(`module:  ${MODULE_NAME}`);
console.log(`position: ${position}`);

function buildModuleEntry(indent, opts) {
    const prop = `${indent}    `;
    const cfg = `${prop}    `;
    return [
        `${indent}{`,
        `${prop}module: ${JSON.stringify(opts.moduleName)},`,
        `${prop}position: ${JSON.stringify(opts.position)},`,
        `${prop}config: {`,
        `${cfg}hubUrl: ${JSON.stringify(opts.hubUrl)},`,
        `${cfg}camId: ${JSON.stringify(opts.camId)},`,
        `${cfg}title: ${JSON.stringify(opts.title)}`,
        `${prop}}`,
        `${indent}}`
    ].join("\n");
}

function findModulesArray(text) {
    for (let i = 0; i < text.length; i += 1) {
        const skipped = skipIgnorable(text, i);
        if (skipped !== i) {
            i = skipped - 1;
            continue;
        }

        if (!text.startsWith("modules", i) || isIdentifierChar(text[i - 1]) || isIdentifierChar(text[i + 7])) {
            continue;
        }

        const colon = skipWsAndComments(text, i + 7);
        if (text[colon] !== ":") continue;
        const arrayStart = skipWsAndComments(text, colon + 1);
        if (text[arrayStart] !== "[") continue;
        return { start: arrayStart, end: findMatching(text, arrayStart, "[", "]") };
    }
    throw new Error("Could not find a modules: [...] array in MagicMirror config.js");
}

function topLevelObjects(text, arrayStart, arrayEnd) {
    const objects = [];
    let i = arrayStart + 1;
    while (i < arrayEnd) {
        i = skipWsAndComments(text, i);
        if (text[i] === ",") {
            i += 1;
            continue;
        }
        if (text[i] === "{") {
            const end = findMatching(text, i, "{", "}");
            objects.push({ start: i, end });
            i = end + 1;
            continue;
        }
        i += 1;
    }
    return objects;
}

function findMatching(text, openIndex, openChar, closeChar) {
    let depth = 0;
    for (let i = openIndex; i < text.length; i += 1) {
        const skipped = skipIgnorable(text, i);
        if (skipped !== i) {
            i = skipped - 1;
            continue;
        }
        if (text[i] === openChar) depth += 1;
        if (text[i] === closeChar) {
            depth -= 1;
            if (depth === 0) return i;
        }
    }
    throw new Error(`Could not find matching ${closeChar} for ${openChar} at offset ${openIndex}`);
}

function skipIgnorable(text, i) {
    const ch = text[i];
    if (ch === "\"" || ch === "'" || ch === "`") return skipString(text, i, ch);
    if (ch === "/" && text[i + 1] === "/") return skipLineComment(text, i);
    if (ch === "/" && text[i + 1] === "*") return skipBlockComment(text, i);
    return i;
}

function skipString(text, i, quote) {
    i += 1;
    while (i < text.length) {
        if (text[i] === "\\") {
            i += 2;
            continue;
        }
        if (text[i] === quote) return i + 1;
        i += 1;
    }
    return i;
}

function skipLineComment(text, i) {
    const end = text.indexOf("\n", i + 2);
    return end === -1 ? text.length : end + 1;
}

function skipBlockComment(text, i) {
    const end = text.indexOf("*/", i + 2);
    return end === -1 ? text.length : end + 2;
}

function skipWsAndComments(text, i) {
    while (i < text.length) {
        while (/\s/.test(text[i])) i += 1;
        const skipped = skipIgnorable(text, i);
        if (skipped === i) return i;
        i = skipped;
    }
    return i;
}

function skipWhitespace(text, i) {
    while (i < text.length && /\s/.test(text[i])) i += 1;
    return i;
}

function indentationBefore(text, index) {
    const lineStart = text.lastIndexOf("\n", index - 1) + 1;
    const match = text.slice(lineStart, index).match(/^[ \t]*/);
    return match ? match[0] : "";
}

function trimEndIndex(text, start, end) {
    let i = end;
    while (i > start && /\s/.test(text[i - 1])) i -= 1;
    return i;
}

function isIdentifierChar(ch) {
    return Boolean(ch && /[A-Za-z0-9_$]/.test(ch));
}

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function timestamp() {
    return new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "Z");
}
