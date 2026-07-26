"use strict";

/**
 * Sunrise / sunset, computed locally.
 *
 * Used for two things: the "after dark" wording in event descriptions, and the
 * night-time trigger for LED illumination. Both want a rough answer, and both
 * must work with the internet unplugged — which is the whole point of this
 * system — so this is the NOAA low-precision solar position algorithm rather
 * than an API call. Good to about a minute, which is far better than anything
 * here needs.
 *
 * Coordinates come from settings and never leave the hub.
 */

const DEG = Math.PI / 180;
const MS_PER_DAY = 86_400_000;

/** Days since the J2000.0 epoch. */
function toJulianDays(ts) {
    return ts / MS_PER_DAY - 0.5 + 2440588 - 2451545;
}

/**
 * Sun's altitude above the horizon, in degrees.
 * Negative means below the horizon.
 */
function solarAltitude(ts, latitude, longitude) {
    const d = toJulianDays(ts);

    // Mean anomaly and ecliptic longitude of the sun.
    const meanAnomaly = (357.5291 + 0.98560028 * d) * DEG;
    const center = (1.9148 * Math.sin(meanAnomaly)
        + 0.02 * Math.sin(2 * meanAnomaly)
        + 0.0003 * Math.sin(3 * meanAnomaly)) * DEG;
    const eclipticLong = meanAnomaly + center + 102.9372 * DEG + Math.PI;

    // Convert to equatorial coordinates.
    const obliquity = 23.4397 * DEG;
    const declination = Math.asin(Math.sin(obliquity) * Math.sin(eclipticLong));
    const rightAscension = Math.atan2(
        Math.cos(obliquity) * Math.sin(eclipticLong),
        Math.cos(eclipticLong)
    );

    // Local hour angle.
    const siderealTime = (280.16 + 360.9856235 * d) * DEG + longitude * DEG;
    const hourAngle = siderealTime - rightAscension;

    const lat = latitude * DEG;
    const altitude = Math.asin(
        Math.sin(lat) * Math.sin(declination)
        + Math.cos(lat) * Math.cos(declination) * Math.cos(hourAngle)
    );
    return altitude / DEG;
}

/**
 * Is it dark at this moment?
 *
 * The threshold is -6 degrees (civil twilight), not 0. At the instant the sun
 * clips the horizon there is still plenty of usable light — calling that "after
 * dark" in an event description would read as wrong to anyone who was outside.
 *
 * Returns null when no coordinates are configured, so callers can omit the
 * wording entirely rather than guess.
 */
function isDark(ts, latitude, longitude) {
    if (!isFinite(latitude) || !isFinite(longitude)) return null;
    if (latitude === 0 && longitude === 0) return null;   // unset, not Null Island
    return solarAltitude(ts, latitude, longitude) < -6;
}

module.exports = { solarAltitude, isDark };
