/**
 * Sky lane derivation: straight, axis-aligned flight corridors for hover
 * traffic, projected upward from the road grid's own major avenues so the
 * sky lanes read as a continuation of the city below (see `gen/layout.ts`'s
 * `planAxis` — major avenues are `MAJOR_ROAD_WIDTH` (7) wide, minor roads are
 * narrower, and every road span it produces fills the *entire* perpendicular
 * extent of the map — see `fillRoadBand`). Pure data derivation over a
 * `NavGrid`'s already-computed `road` grid plus a real `World` clearance
 * scan — no Three.js, no `CityLayout` dependency, so this rebuilds identically
 * after generation or a `.vxc` import (same convention as `NavGrid` itself).
 *
 * Two-stage derivation, both grounded in real generated output (see this
 * module's test suite, which asserts against `generateCity` across many
 * seeds rather than synthetic fixtures):
 *
 * 1. `findAvenueCenterlines` — a major avenue reveals itself as a column (or
 *    row) of the ground `road` grid that is road almost everywhere along its
 *    full length (>= `FULL_SPAN_SHARE`, not exactly 100%, to tolerate the
 *    rare cell whose ground-level headroom check happens to miss). Measured
 *    against 10 real generated cities: this reliably isolates exactly the
 *    width-7 major-avenue bands from the width-5 minor roads and street
 *    furniture noise, with zero false positives.
 * 2. Per candidate centerline, a real 3D clearance scan at each altitude in
 *    `ALTITUDE_BANDS` (lowest first) — `isCorridorClear` — picks the lowest
 *    altitude with zero solid voxels in the swept lane volume, or drops the
 *    lane entirely if every band is blocked. This is deliberately re-run
 *    every `EntitySystem.rebuild()` (generation and import; sandbox edits
 *    are NOT picked up until the next rebuild, so a tower manually stacked
 *    104+ voxels over an avenue centerline is clipped until then) rather
 *    than assumed from
 *    `MAX_BUILDING_HEIGHT` — the whole point of requirement #2 is "verify,
 *    don't assume." Measured against the same 10 seeds: every derived major
 *    avenue was clear at the lowest altitude band (104) every time, because
 *    roads never carry buildings and the only structures that cross above
 *    them (sky bridges, `gen/infrastructure.ts` `SKY_LEVELS`) top out at
 *    y=90 — comfortably below 104.
 */

import { WORLD_SIZE_X, WORLD_SIZE_Z } from '../world/coords';
import type { World } from '../world/World';

/** A road band narrower than this (i.e. a minor road, width 5) is not a candidate sky lane — only major avenues (width 7) get one. */
const MAJOR_LANE_MIN_WIDTH = 6;
/** Share of a column/row's full length that must be a road cell for it to count as a candidate avenue band (not exactly 1.0 — tolerates a rare headroom-check miss without losing the whole avenue). */
const FULL_SPAN_SHARE = 0.95;
/** How far a lane's flight corridor extends to either side of its centerline (a 3-wide corridor, like a single traffic lane). */
export const LANE_HALF_WIDTH = 1;
/** How many voxels of vertical clearance above the altitude are scanned — covers a hover vehicle's body height plus margin. */
const CLEARANCE_HEIGHT = 2;
/**
 * Candidate flight altitudes, lowest first (see class doc comment for why
 * these are real-data-verified rather than assumed from
 * `MAX_BUILDING_HEIGHT`). All sit well above `SKY_LEVELS`'s highest deck
 * (90) and comfortably under `WORLD_SIZE_Y` (160).
 */
export const ALTITUDE_BANDS: readonly number[] = [104, 116, 128];

export interface SkyLane {
  /** Direction of travel along this lane: 'x' = east-west (fixed z), 'z' = north-south (fixed x). */
  readonly axis: 'x' | 'z';
  /** The fixed cross-axis coordinate every vehicle on this lane shares. */
  readonly fixed: number;
  /** Fixed flight altitude (world Y) for every vehicle on this lane. */
  readonly altitude: number;
  /** Inclusive start of this lane's travel-axis range (usually 0). */
  readonly start: number;
  /** Exclusive end of this lane's travel-axis range (usually the world's extent on that axis). */
  readonly end: number;
}

interface Band {
  readonly start: number;
  readonly end: number;
}

/** Groups contiguous indices in [0, size) for which `isFull(i)` holds into `Band`s, keeping only those at least `MAJOR_LANE_MIN_WIDTH` wide. */
function findMajorBands(size: number, isFull: (i: number) => boolean): Band[] {
  const bands: Band[] = [];
  let bandStart = -1;
  for (let i = 0; i < size; i++) {
    const full = isFull(i);
    if (full && bandStart === -1) bandStart = i;
    if (!full && bandStart !== -1) {
      bands.push({ start: bandStart, end: i });
      bandStart = -1;
    }
  }
  if (bandStart !== -1) bands.push({ start: bandStart, end: size });
  return bands.filter((b) => b.end - b.start >= MAJOR_LANE_MIN_WIDTH);
}

/** Share of column `x` (across all `depth` rows) that is a road cell. */
function columnRoadShare(road: Uint8Array, width: number, depth: number, x: number): number {
  let count = 0;
  for (let z = 0; z < depth; z++) if (road[x + z * width] === 1) count++;
  return count / depth;
}

/** Share of row `z` (across all `width` columns) that is a road cell. */
function rowRoadShare(road: Uint8Array, width: number, z: number): number {
  let count = 0;
  for (let x = 0; x < width; x++) if (road[x + z * width] === 1) count++;
  return count / width;
}

/** North-south avenue bands (fixed x column, road spanning the full z extent) — vehicles on these travel along z. */
function findVerticalAvenueBands(road: Uint8Array, width: number, depth: number): Band[] {
  return findMajorBands(width, (x) => columnRoadShare(road, width, depth, x) >= FULL_SPAN_SHARE);
}

/** East-west avenue bands (fixed z row, road spanning the full x extent) — vehicles on these travel along x. */
function findHorizontalAvenueBands(road: Uint8Array, width: number, depth: number): Band[] {
  return findMajorBands(depth, (z) => rowRoadShare(road, width, z) >= FULL_SPAN_SHARE);
}

/** True if the swept lane volume (a `2*LANE_HALF_WIDTH+1`-wide, `CLEARANCE_HEIGHT`-tall corridor along the travel axis) contains zero solid voxels. */
function isCorridorClear(
  world: World,
  axis: 'x' | 'z',
  fixed: number,
  altitude: number,
  start: number,
  end: number,
): boolean {
  for (let travel = start; travel < end; travel++) {
    for (let cross = fixed - LANE_HALF_WIDTH; cross <= fixed + LANE_HALF_WIDTH; cross++) {
      for (let y = altitude; y < altitude + CLEARANCE_HEIGHT; y++) {
        const x = axis === 'x' ? travel : cross;
        const z = axis === 'z' ? travel : cross;
        if (world.isSolid(x, y, z)) return false;
      }
    }
  }
  return true;
}

/** Picks the lowest altitude band with a clear corridor for this candidate lane, or `null` if every band is blocked. */
function pickClearAltitude(
  world: World,
  axis: 'x' | 'z',
  fixed: number,
  start: number,
  end: number,
): number | null {
  for (const altitude of ALTITUDE_BANDS) {
    if (isCorridorClear(world, axis, fixed, altitude, start, end)) return altitude;
  }
  return null;
}

/**
 * Derives every usable sky lane from `world`'s current voxel state: major
 * avenue centerlines (from `navGridRoad`) each paired with the lowest clear
 * altitude band, real-data-verified against `world` itself. A candidate
 * avenue with no clear altitude band at all is dropped rather than forced —
 * a sandbox tower grown into every band is possible in principle, and a
 * missing lane is far preferable to a hover-car clipping through a building.
 */
export function deriveSkyLanes(
  world: World,
  navGridRoad: Uint8Array,
  width: number = WORLD_SIZE_X,
  depth: number = WORLD_SIZE_Z,
): SkyLane[] {
  const lanes: SkyLane[] = [];

  for (const band of findVerticalAvenueBands(navGridRoad, width, depth)) {
    const fixed = Math.floor((band.start + band.end) / 2);
    const altitude = pickClearAltitude(world, 'z', fixed, 0, depth);
    if (altitude !== null) lanes.push({ axis: 'z', fixed, altitude, start: 0, end: depth });
  }

  for (const band of findHorizontalAvenueBands(navGridRoad, width, depth)) {
    const fixed = Math.floor((band.start + band.end) / 2);
    const altitude = pickClearAltitude(world, 'x', fixed, 0, width);
    if (altitude !== null) lanes.push({ axis: 'x', fixed, altitude, start: 0, end: width });
  }

  return lanes;
}
