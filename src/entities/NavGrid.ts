/**
 * Pedestrian/vehicle navigation data derived from a `World`'s current voxel
 * state: which (x, z) columns are walkable sidewalk / drivable road, plus a
 * per-road-cell "flow field" direction used for lane-following traffic. Pure
 * data derivation — no Three.js — so it's unit-testable without a renderer
 * and can be rebuilt identically after generation or `.vxc` import (both
 * leave behind only voxel data, never a `CityLayout`; see
 * `gen/layout.ts`'s `findGroundSpawnPoint` for the same layout-free
 * convention).
 *
 * Only the ground-floor surface (`groundY`, i.e. `CityGenerator`'s
 * GROUND_SURFACE_Y) is scanned — elevated walkways/bridges are deliberately
 * out of scope for phase 2's NPCs/vehicles (see EntitySystem doc comment).
 */

import { AIR, ASPHALT, SIDEWALK } from '../world/BlockRegistry';
import type { World } from '../world/World';

export interface NavGrid {
  readonly width: number;
  readonly depth: number;
  readonly groundY: number;
  /** 1 = walkable sidewalk cell, 0 = not. Row-major, index = x + z * width. */
  readonly sidewalk: Uint8Array;
  /** 1 = drivable road cell, 0 = not. Same indexing as `sidewalk`. */
  readonly road: Uint8Array;
  /** Preferred travel heading for a road cell (one of -1/0/1 per axis, at most one axis nonzero). */
  readonly flowX: Int8Array;
  readonly flowZ: Int8Array;
}

function cellIndex(width: number, x: number, z: number): number {
  return x + z * width;
}

export function inBounds(grid: Pick<NavGrid, 'width' | 'depth'>, x: number, z: number): boolean {
  return x >= 0 && x < grid.width && z >= 0 && z < grid.depth;
}

export function isSidewalkCell(grid: NavGrid, x: number, z: number): boolean {
  if (!inBounds(grid, x, z)) return false;
  return grid.sidewalk[cellIndex(grid.width, x, z)] === 1;
}

export function isRoadCell(grid: NavGrid, x: number, z: number): boolean {
  if (!inBounds(grid, x, z)) return false;
  return grid.road[cellIndex(grid.width, x, z)] === 1;
}

/**
 * How far a cell's contiguous-road "run" is scanned along one axis to decide
 * whether it belongs to an x-running or z-running corridor. Larger than the
 * widest road band (7, see `gen/layout.ts` MAJOR_ROAD_WIDTH) so a genuine
 * long corridor always outscores the perpendicular band width; ties (e.g.
 * inside a wide intersection where both directions run this far) resolve to
 * the 'x' axis by convention.
 */
const AXIS_PROBE_RADIUS = 5;
/** Upper bound on how far a road band's cross-section is scanned to find its edges (lane split). */
const BAND_SCAN_LIMIT = 10;

function runLength(road: Uint8Array, width: number, depth: number, x: number, z: number, axis: 'x' | 'z'): number {
  let count = 0;
  for (let d = -AXIS_PROBE_RADIUS; d <= AXIS_PROBE_RADIUS; d++) {
    const xx = axis === 'x' ? x + d : x;
    const zz = axis === 'z' ? z + d : z;
    if (xx < 0 || xx >= width || zz < 0 || zz >= depth) continue;
    if (road[cellIndex(width, xx, zz)] === 1) count++;
  }
  return count;
}

/**
 * Scans outward (bounded) from `coord` along a road band's cross-section to
 * find [start, end) and this cell's offset within it. `coord` varies along
 * `coordAxis` (the corridor's *perpendicular* axis); `fixed` is held
 * constant on the other axis.
 */
function bandPosition(
  road: Uint8Array,
  width: number,
  depth: number,
  fixed: number,
  coord: number,
  coordAxis: 'x' | 'z',
): { size: number; offset: number } {
  const at = (c: number): boolean => {
    const x = coordAxis === 'x' ? c : fixed;
    const z = coordAxis === 'x' ? fixed : c;
    if (x < 0 || x >= width || z < 0 || z >= depth) return false;
    return road[cellIndex(width, x, z)] === 1;
  };

  let start = coord;
  while (start - 1 >= coord - BAND_SCAN_LIMIT && at(start - 1)) start--;
  let end = coord + 1;
  while (end <= coord + BAND_SCAN_LIMIT && at(end)) end++;

  return { size: end - start, offset: coord - start };
}

/**
 * Assigns each road cell a one-way travel direction: the corridor's long
 * axis is picked by `runLength`, then the cell's position within its band's
 * cross-section (near half vs far half) picks +axis vs -axis — two lanes,
 * opposite directions, the same "right-hand-ish" split on every corridor.
 */
function computeFlowField(
  road: Uint8Array,
  width: number,
  depth: number,
): { flowX: Int8Array; flowZ: Int8Array } {
  const flowX = new Int8Array(width * depth);
  const flowZ = new Int8Array(width * depth);

  for (let x = 0; x < width; x++) {
    for (let z = 0; z < depth; z++) {
      const i = cellIndex(width, x, z);
      if (road[i] !== 1) continue;

      const runX = runLength(road, width, depth, x, z, 'x');
      const runZ = runLength(road, width, depth, x, z, 'z');
      const axis: 'x' | 'z' = runX >= runZ ? 'x' : 'z';

      if (axis === 'x') {
        // Corridor runs along x; its cross-section (lane split) varies along z.
        const { size, offset } = bandPosition(road, width, depth, x, z, 'z');
        flowX[i] = offset < size / 2 ? 1 : -1;
        flowZ[i] = 0;
      } else {
        // Corridor runs along z; its cross-section (lane split) varies along x.
        const { size, offset } = bandPosition(road, width, depth, z, x, 'x');
        flowZ[i] = offset < size / 2 ? 1 : -1;
        flowX[i] = 0;
      }
    }
  }

  return { flowX, flowZ };
}

/**
 * Scans `world`'s ground-surface row (`groundY`) over a `width` x `depth`
 * footprint into sidewalk/road boolean grids plus a road flow field. A
 * surface block only counts as walkable/drivable if the voxel directly
 * above it is AIR (headroom clearance) — keeps entities out of columns a
 * building has since grown into.
 */
export function buildNavGrid(world: World, width: number, depth: number, groundY: number): NavGrid {
  const sidewalk = new Uint8Array(width * depth);
  const road = new Uint8Array(width * depth);

  for (let x = 0; x < width; x++) {
    for (let z = 0; z < depth; z++) {
      const surfaceId = world.getBlock(x, groundY, z);
      const hasClearance = world.getBlock(x, groundY + 1, z) === AIR;
      if (!hasClearance) continue;

      const i = cellIndex(width, x, z);
      if (surfaceId === SIDEWALK) sidewalk[i] = 1;
      else if (surfaceId === ASPHALT) road[i] = 1;
    }
  }

  const { flowX, flowZ } = computeFlowField(road, width, depth);
  return { width, depth, groundY, sidewalk, road, flowX, flowZ };
}
