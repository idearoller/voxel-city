/**
 * Per-parcel building generation: a hollow rectangular tower with a
 * lit/dark window pattern, a recessed ground-floor doorway, and a flat
 * parapet roof. `planBuilding` is pure (footprint/height/material/door
 * decisions only); `writeBuilding` performs the actual `setBlockRaw` calls.
 * Kept apart so the planning logic is testable without a World.
 */

import type { Rng } from './rng';
import { CellType, cellAt, type CityLayout, type Parcel } from './layout';
import { AIR, CONCRETE, GLASS_DARK, METAL, WINDOW_LIT } from '../world/BlockRegistry';
import type { World } from '../world/World';

export const MIN_BUILDING_HEIGHT = 8;
export const MAX_BUILDING_HEIGHT = 60;

const MAX_FOOTPRINT_INSET = 2;
const MIN_FOOTPRINT_SIZE = 4;
const WINDOW_LIT_CHANCE = 0.35;
const DOOR_WIDTH = 2;
const DOOR_HEIGHT = 3;
const WALL_MATERIALS = [CONCRETE, METAL] as const;
const WINDOW_STRIDES = [2, 3] as const;
/**
 * How far outward from the building's wall to scan for a ROAD cell when
 * biasing the doorway. Covers the largest possible gap between a footprint
 * edge and its block's road frontage: footprint inset (<=2) + parcel margin
 * from BSP siblings (0 for a perimeter parcel) + the 1-voxel sidewalk ring.
 * Kept small on purpose — an interior parcel with no direct road frontage
 * would otherwise have to cross an entire neighboring parcel before its
 * scan could accidentally reach a road, which is exactly the case that
 * should fall back to "any side" instead of a false road-facing match.
 */
const DOOR_ROAD_SCAN_DISTANCE = 5;

export type DoorSide = 'north' | 'south' | 'east' | 'west';

export interface BuildingPlan {
  x: number;
  z: number;
  width: number;
  depth: number;
  baseY: number;
  height: number;
  wallMaterial: number;
  windowStride: 2 | 3;
  windowPhase: number;
  doorSide: DoorSide | null;
  /** World coordinate along the door side's tangent axis where the 2-wide doorway starts. */
  doorStart: number;
  /**
   * The same forked Rng used to plan this building, reused by `writeBuilding`
   * for the per-window lit/dark draws so the whole building stays derived
   * from a single deterministic stream regardless of write order.
   */
  rng: Rng;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Taller buildings cluster toward the plan center, with random jitter. */
function biasedHeight(rng: Rng, centerX: number, centerZ: number, cityX: number, cityZ: number): number {
  const cityCenterX = cityX / 2;
  const cityCenterZ = cityZ / 2;
  const maxDist = Math.hypot(cityCenterX, cityCenterZ);
  const dist = Math.hypot(centerX - cityCenterX, centerZ - cityCenterZ);
  const proximity = maxDist === 0 ? 1 : 1 - dist / maxDist;
  const base = MIN_BUILDING_HEIGHT + proximity * (MAX_BUILDING_HEIGHT - MIN_BUILDING_HEIGHT);
  const jittered = base + rng.float(-10, 10);
  return Math.round(clamp(jittered, MIN_BUILDING_HEIGHT, MAX_BUILDING_HEIGHT));
}

/** Scans outward from (startX, startZ) in the (dx, dz) direction for a ROAD cell. */
function scanForRoad(layout: CityLayout, startX: number, startZ: number, dx: number, dz: number): boolean {
  let x = startX;
  let z = startZ;
  for (let i = 0; i < DOOR_ROAD_SCAN_DISTANCE; i++) {
    if (cellAt(layout, x, z) === CellType.ROAD) return true;
    x += dx;
    z += dz;
  }
  return false;
}

/** True if stepping straight out from the building's `side` wall reaches a road within DOOR_ROAD_SCAN_DISTANCE. */
function sideFacesRoad(
  layout: CityLayout,
  side: DoorSide,
  x: number,
  z: number,
  width: number,
  depth: number,
): boolean {
  const centerX = x + Math.floor(width / 2);
  const centerZ = z + Math.floor(depth / 2);
  switch (side) {
    case 'south':
      return scanForRoad(layout, centerX, z - 1, 0, -1);
    case 'north':
      return scanForRoad(layout, centerX, z + depth, 0, 1);
    case 'west':
      return scanForRoad(layout, x - 1, centerZ, -1, 0);
    case 'east':
      return scanForRoad(layout, x + width, centerZ, 1, 0);
  }
}

/**
 * Picks a doorway side. Prefers a side that faces a road within a short
 * scan distance (so perimeter-parcel buildings open onto the street they
 * front); falls back to a uniform pick among all fitting sides when none do
 * (interior parcels with no direct road frontage — a later milestone can
 * route these through an internal walkway instead).
 */
function planDoor(
  rng: Rng,
  layout: CityLayout,
  x: number,
  z: number,
  width: number,
  depth: number,
): { doorSide: DoorSide | null; doorStart: number } {
  const sides: DoorSide[] = [];
  if (width >= DOOR_WIDTH + 2) sides.push('south', 'north');
  if (depth >= DOOR_WIDTH + 2) sides.push('east', 'west');
  if (sides.length === 0) return { doorSide: null, doorStart: 0 };

  const roadFacingSides = sides.filter((side) => sideFacesRoad(layout, side, x, z, width, depth));
  const doorSide = rng.pick(roadFacingSides.length > 0 ? roadFacingSides : sides);
  const doorStart =
    doorSide === 'south' || doorSide === 'north'
      ? x + Math.floor((width - DOOR_WIDTH) / 2)
      : z + Math.floor((depth - DOOR_WIDTH) / 2);
  return { doorSide, doorStart };
}

/**
 * Plans one building for a parcel, or returns null if the parcel is too
 * small (after inset) to host anything. `rng` should be a stream forked
 * specifically for this parcel so results are stable regardless of
 * generation/iteration order elsewhere. `layout` provides the city's road
 * grid, used both for the center-bias on height and for pointing the
 * doorway at a nearby road when there is one.
 */
export function planBuilding(
  parcel: Parcel,
  rng: Rng,
  layout: CityLayout,
  baseY: number,
): BuildingPlan | null {
  const maxInsetForParcel = Math.floor((Math.min(parcel.width, parcel.depth) - MIN_FOOTPRINT_SIZE) / 2);
  const inset = clamp(rng.intRange(0, MAX_FOOTPRINT_INSET), 0, Math.max(0, maxInsetForParcel));

  const width = parcel.width - inset * 2;
  const depth = parcel.depth - inset * 2;
  if (width < MIN_FOOTPRINT_SIZE || depth < MIN_FOOTPRINT_SIZE) return null;

  const x = parcel.x + inset;
  const z = parcel.z + inset;

  const height = biasedHeight(rng, x + width / 2, z + depth / 2, layout.gridSizeX, layout.gridSizeZ);
  const wallMaterial = rng.pick(WALL_MATERIALS);
  const windowStride = rng.pick(WINDOW_STRIDES);
  const windowPhase = rng.intRange(0, windowStride - 1);
  const { doorSide, doorStart } = planDoor(rng, layout, x, z, width, depth);

  return { x, z, width, depth, baseY, height, wallMaterial, windowStride, windowPhase, doorSide, doorStart, rng };
}

function writeShellAndWindows(world: World, plan: BuildingPlan): void {
  const { x, z, width, depth, baseY, height, wallMaterial, windowStride, windowPhase, rng } = plan;

  for (let ry = 0; ry < height; ry++) {
    const y = baseY + ry;
    // Ground floor (ry === 0) always stays solid wall so the doorway carve reads cleanly.
    const isWindowRow = ry !== 0 && ry % windowStride === windowPhase;

    for (let dx = 0; dx < width; dx++) {
      for (let dz = 0; dz < depth; dz++) {
        const isShell = dx === 0 || dx === width - 1 || dz === 0 || dz === depth - 1;
        if (!isShell) continue;

        const block = isWindowRow
          ? rng.chance(WINDOW_LIT_CHANCE)
            ? WINDOW_LIT
            : GLASS_DARK
          : wallMaterial;
        world.setBlockRaw(x + dx, y, z + dz, block);
      }
    }
  }
}

function writeDoorway(world: World, plan: BuildingPlan): void {
  const { doorSide, doorStart, x, z, width, depth, baseY } = plan;
  if (!doorSide) return;

  for (let h = 0; h < DOOR_HEIGHT; h++) {
    const y = baseY + h;
    for (let w = 0; w < DOOR_WIDTH; w++) {
      if (doorSide === 'south') world.setBlockRaw(doorStart + w, y, z, AIR);
      else if (doorSide === 'north') world.setBlockRaw(doorStart + w, y, z + depth - 1, AIR);
      else if (doorSide === 'west') world.setBlockRaw(x, y, doorStart + w, AIR);
      else world.setBlockRaw(x + width - 1, y, doorStart + w, AIR);
    }
  }
}

function writeRoof(world: World, plan: BuildingPlan): void {
  const { x, z, width, depth, baseY, height, wallMaterial } = plan;
  const roofY = baseY + height;

  for (let dx = 0; dx < width; dx++) {
    for (let dz = 0; dz < depth; dz++) {
      world.setBlockRaw(x + dx, roofY, z + dz, CONCRETE);
    }
  }

  const parapetY = roofY + 1;
  for (let dx = 0; dx < width; dx++) {
    for (let dz = 0; dz < depth; dz++) {
      const isShell = dx === 0 || dx === width - 1 || dz === 0 || dz === depth - 1;
      if (!isShell) continue;
      world.setBlockRaw(x + dx, parapetY, z + dz, wallMaterial);
    }
  }
}

/** Extrudes a planned building into the world via setBlockRaw only (no dirty events). */
export function writeBuilding(world: World, plan: BuildingPlan): void {
  writeShellAndWindows(world, plan);
  writeDoorway(world, plan);
  writeRoof(world, plan);
}
