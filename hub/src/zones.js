"use strict";

/**
 * Named regions drawn on a camera's view.
 *
 * A zone is a polygon in normalized 0-1 image coordinates, so it stays correct
 * regardless of capture resolution or how large the browser renders the feed.
 *
 * ============================================================================
 *  The anchor point
 * ============================================================================
 *
 * Zone membership is tested against the **bottom-centre of the bounding box**,
 * not its centre. A person's feet are where they physically are; their centre
 * of mass floats a metre up and drifts across zone boundaries as they get
 * nearer the camera. Anchoring at the feet is what makes "standing at the trash
 * room door" mean the thing you'd expect when the subject is tall or close.
 *
 * ============================================================================
 *  Zone kinds
 * ============================================================================
 *
 *   door   — a doorway or entrance. Gets "entered"/"approached" verbs and is
 *            what the LED escalation treats as the thing worth guarding.
 *   path   — a walkway, driveway, sidewalk. Gets "walked along"/"passed".
 *   area   — a generic named region. Gets "in"/"near".
 *   ignore — detections anchored here are dropped entirely. This is the
 *            release valve for the recurring false positive: a swaying branch,
 *            a neighbour's lit window, a road with passing cars.
 */

const ZONE_KINDS = ["door", "path", "area", "ignore"];
const MAX_ZONES_PER_CAM = 24;
const MAX_POINTS_PER_ZONE = 64;

/**
 * Validate a zone as it arrives from the API.
 * @returns {{ok: true, value: object} | {ok: false, error: string}}
 */
function validateZone(raw) {
    if (!raw || typeof raw !== "object") {
        return { ok: false, error: "zone must be an object" };
    }
    const name = String(raw.name || "").trim();
    if (!name) return { ok: false, error: "zone name is required" };
    if (name.length > 60) return { ok: false, error: `zone name "${name}" is too long (max 60)` };

    const kind = raw.kind === undefined ? "area" : String(raw.kind);
    if (!ZONE_KINDS.includes(kind)) {
        return { ok: false, error: `zone kind must be one of ${ZONE_KINDS.join(", ")}` };
    }

    if (!Array.isArray(raw.points) || raw.points.length < 3) {
        return { ok: false, error: `zone "${name}" needs at least 3 points` };
    }
    if (raw.points.length > MAX_POINTS_PER_ZONE) {
        return { ok: false, error: `zone "${name}" has too many points (max ${MAX_POINTS_PER_ZONE})` };
    }

    const points = [];
    for (const p of raw.points) {
        const x = Number(p && p.x);
        const y = Number(p && p.y);
        if (!isFinite(x) || !isFinite(y)) {
            return { ok: false, error: `zone "${name}" has a non-numeric point` };
        }
        // Clamp rather than reject: a drag that ends a pixel outside the video
        // element is a normal thing for a user to do, not an error worth
        // throwing their whole zone away for.
        points.push({ x: clamp01(x), y: clamp01(y) });
    }

    return {
        ok: true,
        value: {
            name,
            kind,
            points,
            sortOrder: Number.isFinite(raw.sortOrder) ? raw.sortOrder : undefined
        }
    };
}

/**
 * Validate a whole set for one camera.
 * @returns {{ok: true, value: object[]} | {ok: false, errors: string[]}}
 */
function validateZones(list) {
    if (!Array.isArray(list)) return { ok: false, errors: ["zones must be an array"] };
    if (list.length > MAX_ZONES_PER_CAM) {
        return { ok: false, errors: [`too many zones (max ${MAX_ZONES_PER_CAM})`] };
    }
    const errors = [];
    const value = [];
    const seen = new Set();
    for (const raw of list) {
        const checked = validateZone(raw);
        if (!checked.ok) { errors.push(checked.error); continue; }
        const key = checked.value.name.toLowerCase();
        if (seen.has(key)) {
            errors.push(`duplicate zone name "${checked.value.name}"`);
            continue;
        }
        seen.add(key);
        value.push(checked.value);
    }
    return errors.length ? { ok: false, errors } : { ok: true, value };
}

/**
 * Standard ray-casting point-in-polygon.
 * Points on an edge count as inside, which avoids a subject flickering between
 * "in" and "out" while standing on a boundary.
 */
function pointInPolygon(points, x, y) {
    let inside = false;
    for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
        const xi = points[i].x;
        const yi = points[i].y;
        const xj = points[j].x;
        const yj = points[j].y;
        const intersects = ((yi > y) !== (yj > y))
            && (x < ((xj - xi) * (y - yi)) / ((yj - yi) || Number.EPSILON) + xi);
        if (intersects) inside = !inside;
    }
    return inside;
}

/** The point a detection is judged by: bottom-centre of the box. See header. */
function anchorOf(bbox) {
    if (!bbox) return null;
    const cx = Number(bbox.cx);
    const cy = Number(bbox.cy);
    const h = Number(bbox.h);
    if (!isFinite(cx) || !isFinite(cy) || !isFinite(h)) return null;
    return { x: clamp01(cx), y: clamp01(cy + h / 2) };
}

/**
 * Zones containing a bounding box's anchor, in the camera's configured order.
 * Overlap is allowed and meaningful — "on the walkway, at the front door".
 */
function zonesForBox(zones, bbox) {
    const anchor = anchorOf(bbox);
    if (!anchor || !Array.isArray(zones)) return [];
    return zones.filter((z) => pointInPolygon(z.points, anchor.x, anchor.y));
}

/**
 * True when a detection should be discarded.
 *
 * An `ignore` zone only suppresses when it is the *only* thing the anchor is
 * inside. If a subject is in both an ignore zone and a real one, the real one
 * wins — otherwise an ignore region drawn over a busy road would also blind the
 * doorstep that overlaps it.
 */
function isIgnored(zones, bbox) {
    const hits = zonesForBox(zones, bbox);
    if (hits.length === 0) return false;
    return hits.every((z) => z.kind === "ignore");
}

/**
 * The zone that best describes where someone is.
 *
 * Doors beat paths beat areas: if a subject is standing on the walkway *and* at
 * the trash room door, the door is the interesting fact. Within a kind, the
 * camera's own ordering wins, so dragging a zone up the list in the UI is a
 * meaningful way to say "mention this one first".
 */
const KIND_PRIORITY = { door: 0, path: 1, area: 2, ignore: 3 };

function primaryZone(zones, bbox) {
    const hits = zonesForBox(zones, bbox).filter((z) => z.kind !== "ignore");
    if (!hits.length) return null;
    return hits.slice().sort((a, b) => {
        const byKind = (KIND_PRIORITY[a.kind] ?? 9) - (KIND_PRIORITY[b.kind] ?? 9);
        if (byKind !== 0) return byKind;
        return (a.sortOrder ?? 0) - (b.sortOrder ?? 0);
    })[0];
}

/** Axis-aligned rectangle helper — what the UI's drag-to-draw produces. */
function rectZone(name, kind, x1, y1, x2, y2) {
    const left = Math.min(x1, x2);
    const right = Math.max(x1, x2);
    const top = Math.min(y1, y2);
    const bottom = Math.max(y1, y2);
    return {
        name,
        kind: kind || "area",
        points: [
            { x: clamp01(left), y: clamp01(top) },
            { x: clamp01(right), y: clamp01(top) },
            { x: clamp01(right), y: clamp01(bottom) },
            { x: clamp01(left), y: clamp01(bottom) }
        ]
    };
}

function clamp01(n) {
    if (!isFinite(n)) return 0;
    return Math.min(1, Math.max(0, n));
}

module.exports = {
    ZONE_KINDS,
    MAX_ZONES_PER_CAM,
    validateZone,
    validateZones,
    pointInPolygon,
    anchorOf,
    zonesForBox,
    isIgnored,
    primaryZone,
    rectZone
};
