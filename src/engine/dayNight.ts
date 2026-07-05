/**
 * Pure day/night interpolation logic — no Three.js, no DOM. `timeOfDay` is a
 * cyclic fraction in [0, 1): 0 = midnight, 0.5 = noon. `Atmosphere.ts` (which
 * owns the actual scene objects: sky dome, stars, lights) reads
 * `interpolateAtmosphere()` every tick and pushes the resulting values onto
 * its Three.js objects; keeping the math here means the interpolation curve
 * itself is unit-testable without a WebGL context.
 *
 * Default `timeOfDay` is 0.85 (deep night) per the M5 atmosphere spec — this
 * is a cyberpunk night scene first, with day as an occasional overcast
 * variant, not a sunny default.
 */

export const DEFAULT_TIME_OF_DAY = 0.85;

/** Hex color as 0xRRGGBB. */
export type HexColor = number;

export interface AtmosphereParams {
  fogDensity: number;
  /**
   * Fog color is deliberately not an independent preset: the spec calls for
   * fog synced to the sky horizon color, so `interpolateAtmosphere` reuses
   * `skyHorizonColor` for it rather than lerping a second, possibly
   * diverging, color pair.
   */
  skyHorizonColor: HexColor;
  skyZenithColor: HexColor;
  hemiSkyColor: HexColor;
  hemiGroundColor: HexColor;
  hemiIntensity: number;
  moonColor: HexColor;
  moonIntensity: number;
  bloomStrength: number;
  /** [0, 1] — stars fade out entirely by full day. */
  starOpacity: number;
}

const NIGHT: AtmosphereParams = {
  fogDensity: 0.012,
  skyHorizonColor: 0x2a1440,
  skyZenithColor: 0x05030c,
  hemiSkyColor: 0x8a7fd6,
  hemiGroundColor: 0x120a1a,
  hemiIntensity: 0.25,
  moonColor: 0x9fb0ff,
  moonIntensity: 0.15,
  bloomStrength: 0.95,
  starOpacity: 1,
};

/** Overcast teal-grey blade-runner haze — day is dim and moody, never sunny. */
const DAY: AtmosphereParams = {
  fogDensity: 0.009,
  skyHorizonColor: 0x5c6f78,
  skyZenithColor: 0x29343a,
  hemiSkyColor: 0x9fb3ba,
  hemiGroundColor: 0x2a2f33,
  hemiIntensity: 0.55,
  moonColor: 0xcfd8dc,
  moonIntensity: 0.4,
  bloomStrength: 0.35,
  starOpacity: 0,
};

/**
 * The lower of the two fog densities the cycle ever uses (`DAY`'s, at 0.009
 * -- thinner than `NIGHT`'s 0.012). Thinner fog lets a chunk stay visible
 * farther out, so anything deriving a "how far can fog still be hiding
 * something" distance (e.g. `ChunkVisibility`'s cull radius) must use this
 * value, not the night one, or it will cull chunks that are still plainly
 * visible during the day.
 */
export const MIN_FOG_DENSITY = Math.min(NIGHT.fogDensity, DAY.fogDensity);

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpColor(a: HexColor, b: HexColor, t: number): HexColor {
  const ar = (a >> 16) & 0xff;
  const ag = (a >> 8) & 0xff;
  const ab = a & 0xff;
  const br = (b >> 16) & 0xff;
  const bg = (b >> 8) & 0xff;
  const bb = b & 0xff;
  const r = Math.round(lerp(ar, br, t));
  const g = Math.round(lerp(ag, bg, t));
  const bl = Math.round(lerp(ab, bb, t));
  return (r << 16) | (g << 8) | bl;
}

/**
 * Fraction of "day" in [0, 1] for a given `timeOfDay`: 0 at midnight (t=0),
 * 1 at noon (t=0.5), back to 0 at t=1. A raised cosine gives a smooth
 * sunrise/sunset ease rather than a linear snap.
 */
export function dayFactor(timeOfDay: number): number {
  return (1 - Math.cos(2 * Math.PI * timeOfDay)) / 2;
}

/** Interpolates every atmosphere-driven parameter for the given time of day. */
export function interpolateAtmosphere(timeOfDay: number): AtmosphereParams {
  const t = dayFactor(timeOfDay);
  const skyHorizonColor = lerpColor(NIGHT.skyHorizonColor, DAY.skyHorizonColor, t);
  return {
    fogDensity: lerp(NIGHT.fogDensity, DAY.fogDensity, t),
    skyHorizonColor,
    skyZenithColor: lerpColor(NIGHT.skyZenithColor, DAY.skyZenithColor, t),
    hemiSkyColor: lerpColor(NIGHT.hemiSkyColor, DAY.hemiSkyColor, t),
    hemiGroundColor: lerpColor(NIGHT.hemiGroundColor, DAY.hemiGroundColor, t),
    hemiIntensity: lerp(NIGHT.hemiIntensity, DAY.hemiIntensity, t),
    moonColor: lerpColor(NIGHT.moonColor, DAY.moonColor, t),
    moonIntensity: lerp(NIGHT.moonIntensity, DAY.moonIntensity, t),
    bloomStrength: lerp(NIGHT.bloomStrength, DAY.bloomStrength, t),
    starOpacity: lerp(NIGHT.starOpacity, DAY.starOpacity, t),
  };
}
