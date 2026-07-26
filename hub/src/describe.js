"use strict";

/**
 * Natural-language event descriptions.
 *
 * Turns "person, 12.4s, 0.87 confidence" into "Someone approached the trash
 * room door and stood there for 12 seconds."
 *
 * ============================================================================
 *  Why templates rather than a model
 * ============================================================================
 *
 * Descriptions are composed from facts the hub already knows for certain: which
 * named zones the subject was in, in what order, for how long, moving which way,
 * at what time of day. That's enough to write the sentence, and doing it this
 * way means descriptions are instant, free, identical every time, and work with
 * the internet unplugged — which is the entire premise of the system. A language
 * model would write nicer prose and occasionally invent a detail that never
 * happened, and in a security log that trade is not worth making.
 *
 * The quality of the output is therefore a function of how well the user has
 * labelled their zones. "Someone approached the trash room door" is only
 * possible because a zone called "trash room door" exists. With no zones drawn
 * the describer degrades gracefully to "Someone was at the front door camera for
 * 12 seconds" rather than producing nonsense.
 *
 * This module is deliberately pure: no I/O, no clock, no config lookups. Every
 * input arrives as an argument, which makes the whole thing trivially testable
 * and lets `POST /events/<id>/redescribe` re-run it over historical events after
 * you rename a zone.
 */

const { isDark } = require("./sun");

/** Verb choices per zone kind, indexed by how the subject interacted with it. */
const ZONE_VERBS = {
    door: { arrive: "went up to", occupy: "at", pass: "past" },
    path: { arrive: "came up", occupy: "on", pass: "along" },
    area: { arrive: "went into", occupy: "in", pass: "through" },
    ignore: { arrive: "entered", occupy: "in", pass: "through" }
};

const DIRECTION_PHRASE = {
    left: "heading left",
    right: "heading right",
    toward: "heading toward the camera",
    away: "heading away from the camera"
};

/**
 * @param {object} input
 * @param {string} input.camId
 * @param {string} [input.friendlyName]      Camera display name.
 * @param {string} [input.behavior]          From classifyTrack.
 * @param {number} [input.durationMs]
 * @param {number} [input.startedAtMs]
 * @param {Array}  [input.zoneVisits]        [{ name, kind, enteredAt, leftAt }]
 * @param {string} [input.direction]         left | right | toward | away
 * @param {number} [input.personCount=1]
 * @param {string} [input.profileName]       Recognised person, when known.
 * @param {number} [input.latitude]
 * @param {number} [input.longitude]
 * @returns {string}
 */
function describeEvent(input) {
    const {
        camId,
        friendlyName,
        behavior = "present",
        durationMs = 0,
        startedAtMs,
        zoneVisits = [],
        direction = null,
        personCount = 1,
        profileName = null,
        latitude,
        longitude
    } = input || {};

    const place = friendlyName || camId || "the camera";
    const subject = subjectPhrase(personCount, profileName);
    const visits = dedupeVisits(zoneVisits);

    // "Two people was on the driveway" — the only verb in these templates that
    // inflects for number is `to be`, so it's the only one that needs threading.
    const plural = !profileName && personCount >= 2;

    const core = corePhrase({ subject, plural, behavior, visits, place, direction, durationMs });
    const time = timeQualifier(startedAtMs, latitude, longitude);

    return finish(time ? `${core} ${time}` : core);
}

/** "Someone" / "Jared" / "Two people". */
function subjectPhrase(count, profileName) {
    if (profileName) return profileName;
    if (count >= 2) return `${numberWord(count)} people`;
    return "Someone";
}

function numberWord(n) {
    const words = ["zero", "one", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight"];
    return n < words.length ? words[n] : String(n);
}

/**
 * Collapse a track's zone history into the interesting bits.
 *
 * A subject standing on a boundary flickers between two zones every tick, which
 * would otherwise produce "walked from the walkway to the door to the walkway to
 * the door". Consecutive repeats are merged and visits under a second are
 * dropped as noise.
 */
function dedupeVisits(visits) {
    if (!Array.isArray(visits)) return [];
    const out = [];
    for (const v of visits) {
        if (!v || !v.name) continue;
        const dwell = (v.leftAt || v.enteredAt) - v.enteredAt;
        const prev = out[out.length - 1];
        if (prev && prev.name === v.name) {
            prev.leftAt = v.leftAt;
            prev.dwellMs += Math.max(0, dwell);
            continue;
        }
        out.push({ ...v, dwellMs: Math.max(0, dwell) });
    }
    // Keep a sub-second visit only if it's all we have — better to say something
    // about where they were than nothing.
    const meaningful = out.filter((v) => v.dwellMs >= 1000);
    return meaningful.length ? meaningful : out.slice(0, 1);
}

function corePhrase({ subject, plural, behavior, visits, place, direction, durationMs }) {
    const first = visits[0] || null;
    const last = visits.length > 1 ? visits[visits.length - 1] : null;
    const dwellZone = longestVisit(visits);
    const duration = formatDuration(durationMs);
    const wasWere = plural ? "were" : "was";

    // Moved between two named places — the most informative shape available,
    // so it wins regardless of behaviour class.
    if (last && first && last.name !== first.name) {
        const verb = behavior === "passing" ? "walked" : "moved";
        return `${subject} ${verb} from ${the(first.name)} to ${the(last.name)}`;
    }

    switch (behavior) {
        case "passing": {
            if (first) {
                const verbs = ZONE_VERBS[first.kind] || ZONE_VERBS.area;
                return `${subject} walked ${verbs.pass} ${the(first.name)}`;
            }
            const dir = direction ? ` ${DIRECTION_PHRASE[direction]}` : "";
            return `${subject} passed by ${the(place)}${dir}`;
        }

        case "approaching": {
            if (first) {
                const verbs = ZONE_VERBS[first.kind] || ZONE_VERBS.area;
                return `${subject} ${verbs.arrive} ${the(first.name)}`;
            }
            return `${subject} approached ${the(place)}`;
        }

        case "dwelling": {
            if (dwellZone) {
                const verbs = ZONE_VERBS[dwellZone.kind] || ZONE_VERBS.area;
                return `${subject} stood ${verbs.occupy} ${the(dwellZone.name)} for ${duration}`;
            }
            return `${subject} stood at ${the(place)} for ${duration}`;
        }

        case "loitering": {
            const where = dwellZone ? the(dwellZone.name) : the(place);
            return `${subject} stayed at ${where} for ${duration}`;
        }

        case "present":
        default: {
            if (dwellZone) {
                const verbs = ZONE_VERBS[dwellZone.kind] || ZONE_VERBS.area;
                return `${subject} ${wasWere} ${verbs.occupy} ${the(dwellZone.name)} for ${duration}`;
            }
            return `${subject} ${wasWere} at ${the(place)} for ${duration}`;
        }
    }
}

function longestVisit(visits) {
    if (!visits.length) return null;
    return visits.reduce((best, v) => (v.dwellMs > best.dwellMs ? v : best), visits[0]);
}

/**
 * Prefix an article unless the name already reads like a proper noun or the
 * user already wrote one. "the the trash room door" is the failure this avoids,
 * and so is "the Jared's office".
 */
function the(name) {
    const s = String(name || "").trim();
    if (!s) return "the camera";
    if (/^(the|a|an|my|your|our|his|her|their)\s/i.test(s)) return s;
    if (/^[A-Z][a-z]+('s|s')\s/.test(s)) return s;      // "Jared's office"
    return `the ${s}`;
}

/**
 * "after dark" / "in the early hours" / null.
 *
 * Deliberately sparse: a qualifier on every single event turns into noise you
 * stop reading. Only genuinely notable times get one.
 */
function timeQualifier(startedAtMs, latitude, longitude) {
    if (!startedAtMs) return null;
    const dark = isDark(startedAtMs, latitude, longitude);
    const hour = new Date(startedAtMs).getHours();

    if (hour >= 1 && hour < 5) return "in the early hours";
    if (dark === true) return "after dark";
    return null;
}

function formatDuration(ms) {
    if (!ms || ms < 1000) return "a moment";
    const seconds = Math.round(ms / 1000);
    if (seconds < 60) return `${seconds} second${seconds === 1 ? "" : "s"}`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
    const hours = Math.floor(minutes / 60);
    const rem = minutes % 60;
    if (rem === 0) return `${hours} hour${hours === 1 ? "" : "s"}`;
    return `${hours}h ${rem}m`;
}

function finish(sentence) {
    const s = String(sentence).trim().replace(/\s+/g, " ");
    if (!s) return "";
    const capped = s.charAt(0).toUpperCase() + s.slice(1);
    return /[.!?]$/.test(capped) ? capped : `${capped}.`;
}

/**
 * A short description for a camera going offline. Worth its own wording — this
 * is the alert that actually matters, and burying it in the same phrasing as a
 * person detection would hide it.
 */
function describeOffline({ camId, friendlyName, downForMs }) {
    const place = friendlyName || camId || "A camera";
    const duration = formatDuration(downForMs);
    return finish(`${place} stopped reporting ${duration} ago`);
}

module.exports = {
    describeEvent,
    describeOffline,
    formatDuration,
    dedupeVisits,
    timeQualifier,
    the
};
