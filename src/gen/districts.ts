/**
 * District zoning: assigns each city block a low-frequency-noise-driven
 * district (downtown / commercial / residential / industrial / park) and
 * exposes the per-district height range and signage intensity that
 * `buildings.ts` extrudes from. Pure 2D math — no Three.js, no World — kept
 * separate from `layout.ts` so the value-noise field (keyed by plain block
 * center coordinates) never needs to import block/parcel types.
 */

import { hashString, type Rng } from './rng';

export const District = {
  DOWNTOWN: 'downtown',
  COMMERCIAL: 'commercial',
  RESIDENTIAL: 'residential',
  PARK: 'park',
  INDUSTRIAL: 'industrial',
} as const;
export type District = (typeof District)[keyof typeof District];

export interface DistrictParams {
  minHeight: number;
  maxHeight: number;
  /** Commercial gets the densest street-level neon signage. */
  maxSignage: boolean;
}

export const DISTRICT_PARAMS: Record<District, DistrictParams> = {
  [District.DOWNTOWN]: { minHeight: 40, maxHeight: 120, maxSignage: false },
  [District.COMMERCIAL]: { minHeight: 15, maxHeight: 40, maxSignage: true },
  [District.RESIDENTIAL]: { minHeight: 8, maxHeight: 20, maxSignage: false },
  [District.INDUSTRIAL]: { minHeight: 10, maxHeight: 22, maxSignage: false },
  [District.PARK]: { minHeight: 0, maxHeight: 0, maxSignage: false },
};

/** Chance any given block is zoned as a park, independent of its position. */
const PARK_CHANCE = 0.1;
/** Lattice spacing (in world voxels) for the low-frequency district noise field. */
const NOISE_CELL_SIZE = 96;
/** Blocks within this fraction of the plan radius are always downtown. */
const DOWNTOWN_CORE_RADIUS = 0.2;
/** Blocks beyond this fraction of the plan radius are always industrial. */
const INDUSTRIAL_RIM_RADIUS = 0.8;

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Deterministic pseudo-random value in [0, 1) for an integer lattice point, keyed off a numeric seed. */
function latticeValue(seed: number, lx: number, lz: number): number {
  return hashString(`${seed}:${lx}:${lz}`) / 0x100000000;
}

/**
 * Low-frequency 2D value noise: bilinear interpolation over a integer
 * lattice of hashed corner values, smoothed with a cubic ease. Continuous in
 * (x, z) for a fixed seed, so callers must NOT fork a fresh Rng per sample —
 * that would make neighboring samples uncorrelated and defeat the point of
 * "low frequency".
 */
export function valueNoise2D(seed: number, x: number, z: number, cellSize: number): number {
  const gx = x / cellSize;
  const gz = z / cellSize;
  const x0 = Math.floor(gx);
  const z0 = Math.floor(gz);
  const fx = smoothstep(gx - x0);
  const fz = smoothstep(gz - z0);

  const v00 = latticeValue(seed, x0, z0);
  const v10 = latticeValue(seed, x0 + 1, z0);
  const v01 = latticeValue(seed, x0, z0 + 1);
  const v11 = latticeValue(seed, x0 + 1, z0 + 1);

  const top = lerp(v00, v10, fx);
  const bottom = lerp(v01, v11, fx);
  return lerp(top, bottom, fz);
}

export interface DistrictContext {
  gridSizeX: number;
  gridSizeZ: number;
  /** Numeric seed for the shared noise field — see `valueNoise2D`. */
  noiseSeed: number;
}

/**
 * Zones one block: a flat park roll first, then a center-vs-edge distance
 * band with noise-driven variety inside each band. Downtown is guaranteed
 * within the inner `DOWNTOWN_CORE_RADIUS` of the plan and industrial within
 * the outer rim beyond `INDUSTRIAL_RIM_RADIUS`, which is what gives the
 * skyline its "tall in the middle, low at the edges" read and is what the
 * distribution-sanity tests pin down. `blockRng` must already be a stream
 * forked uniquely per block (e.g. by block coordinates) so the park roll is
 * independent of iteration order; `ctx.noiseSeed` must be shared by every
 * block in the same layout so the noise field stays spatially continuous.
 */
export function zoneBlock(centerX: number, centerZ: number, ctx: DistrictContext, blockRng: Rng): District {
  if (blockRng.chance(PARK_CHANCE)) return District.PARK;

  const cityCenterX = ctx.gridSizeX / 2;
  const cityCenterZ = ctx.gridSizeZ / 2;
  const maxDist = Math.hypot(cityCenterX, cityCenterZ);
  const dist = maxDist === 0 ? 0 : Math.hypot(centerX - cityCenterX, centerZ - cityCenterZ) / maxDist;

  if (dist < DOWNTOWN_CORE_RADIUS) return District.DOWNTOWN;
  if (dist > INDUSTRIAL_RIM_RADIUS) return District.INDUSTRIAL;

  const n = valueNoise2D(ctx.noiseSeed, centerX, centerZ, NOISE_CELL_SIZE);
  if (dist < 0.4) return n > 0.4 ? District.DOWNTOWN : District.COMMERCIAL;
  if (dist < 0.6) return n > 0.5 ? District.COMMERCIAL : District.RESIDENTIAL;
  return n > 0.6 ? District.RESIDENTIAL : District.INDUSTRIAL;
}
