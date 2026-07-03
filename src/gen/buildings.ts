/**
 * Per-parcel building generation: a hollow rectangular tower with a
 * lit/dark window pattern, a recessed ground-floor doorway, and
 * district-flavored massing/signage on top:
 *  - tall towers (> SETBACK_MIN_HEIGHT) step inward through 1-2 setback
 *    tiers, each capped with a terrace deck;
 *  - commercial buildings get a neon shop band across their doorway wall;
 *  - any building can roll a vertical neon sign strip on a random facade,
 *    with commercial/downtown weighted heavier ("max signage");
 *  - downtown towers get a neon rooftop trim and sometimes an antenna mast.
 *
 * `planBuilding` is pure (footprint/height/material/door/massing/signage
 * decisions only); `writeBuilding` performs the actual `setBlockRaw` calls.
 * Kept apart so the planning logic is testable without a World.
 */

import { District, DISTRICT_PARAMS } from './districts';
import type { Rng } from './rng';
import { CellType, cellAt, type CityLayout, type Parcel } from './layout';
import {
  AIR,
  CONCRETE,
  GLASS_DARK,
  METAL,
  NEON_CYAN,
  NEON_PINK,
  NEON_PURPLE,
  NEON_YELLOW,
  WINDOW_LIT,
} from '../world/BlockRegistry';
import type { World } from '../world/World';

export const MIN_BUILDING_HEIGHT = 8;
export const MAX_BUILDING_HEIGHT = 120;

const MAX_FOOTPRINT_INSET = 2;
const MIN_FOOTPRINT_SIZE = 4;
const DOOR_WIDTH = 2;
const DOOR_HEIGHT = 3;
const WINDOW_STRIDES = [2, 3] as const;

/** Towers taller than this get 1-2 inward setback tiers instead of a single flat-sided shaft. */
const SETBACK_MIN_HEIGHT = 40;
const SETBACK_INSET_MIN = 1;
const SETBACK_INSET_MAX = 3;

const SHOP_BAND_COLORS = [NEON_PINK, NEON_CYAN, NEON_YELLOW, NEON_PURPLE] as const;
const SIGN_COLORS = [NEON_PINK, NEON_CYAN, NEON_YELLOW, NEON_PURPLE] as const;
const SIGN_MIN_HEIGHT = 8;
const SIGN_MAX_HEIGHT = 16;
const SIGN_WIDTH = 2;
/** Per-district chance a building rolls a vertical neon sign strip; commercial is "max signage". */
const SIGN_CHANCE: Record<District, number> = {
  [District.COMMERCIAL]: 0.7,
  [District.DOWNTOWN]: 0.4,
  [District.RESIDENTIAL]: 0.1,
  [District.INDUSTRIAL]: 0.1,
  [District.PARK]: 0,
};
/** Chance a tall-enough downtown tower gets an antenna mast with a neon tip. */
const ANTENNA_CHANCE = 0.3;
const ANTENNA_MIN_TOWER_HEIGHT = 70;
const ANTENNA_MIN_MAST = 4;
const ANTENNA_MAX_MAST = 8;

const DISTRICT_WALL_MATERIALS: Record<District, readonly number[]> = {
  [District.DOWNTOWN]: [METAL, GLASS_DARK],
  [District.COMMERCIAL]: [CONCRETE, METAL],
  [District.RESIDENTIAL]: [CONCRETE],
  [District.INDUSTRIAL]: [METAL, CONCRETE],
  [District.PARK]: [CONCRETE],
};

const DISTRICT_WINDOW_LIT_CHANCE: Record<District, number> = {
  [District.DOWNTOWN]: 0.45,
  [District.COMMERCIAL]: 0.4,
  [District.RESIDENTIAL]: 0.3,
  [District.INDUSTRIAL]: 0.15,
  [District.PARK]: 0.35,
};

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

/** One massing tier of a (possibly stepped-back) tower footprint. */
export interface BuildingTier {
  /** Voxel row offset from the building's baseY where this tier starts (inclusive). */
  yStart: number;
  /** Voxel row offset from the building's baseY where this tier ends (exclusive). */
  yEnd: number;
  x: number;
  z: number;
  width: number;
  depth: number;
}

export interface SignStrip {
  side: DoorSide;
  /** World coordinate along the side's tangent axis where the 2-wide strip starts. */
  offset: number;
  /** Voxel row offset from baseY where the strip starts. */
  yStart: number;
  height: number;
  color: number;
}

export interface AntennaMast {
  height: number;
}

export interface BuildingPlan {
  x: number;
  z: number;
  width: number;
  depth: number;
  baseY: number;
  height: number;
  district: District;
  wallMaterial: number;
  windowStride: 2 | 3;
  windowPhase: number;
  windowLitChance: number;
  doorSide: DoorSide | null;
  /** World coordinate along the door side's tangent axis where the 2-wide doorway starts. */
  doorStart: number;
  /** Full massing, ground tier first. `tiers[0]` always equals {x, z, width, depth} above. */
  tiers: BuildingTier[];
  shopBandColor: number | null;
  signStrip: SignStrip | null;
  roofTrimColor: number | null;
  antenna: AntennaMast | null;
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
 * Plans the tower's massing as 1-3 tiers. Buildings at or under
 * SETBACK_MIN_HEIGHT extrude as a single flat-sided tier (unchanged from
 * v1). Taller towers roll 1-2 inward setbacks; each setback insets the
 * footprint on all sides and must still clear MIN_FOOTPRINT_SIZE, otherwise
 * the tier plan stops early and the last tier simply runs to the roof.
 */
function planTiers(x: number, z: number, width: number, depth: number, height: number, rng: Rng): BuildingTier[] {
  if (height <= SETBACK_MIN_HEIGHT) {
    return [{ yStart: 0, yEnd: height, x, z, width, depth }];
  }

  const setbackCount = rng.intRange(1, 2);
  const boundaries: number[] =
    setbackCount === 1
      ? [rng.intRange(Math.floor(height * 0.5), Math.floor(height * 0.7))]
      : [
          rng.intRange(Math.floor(height * 0.4), Math.floor(height * 0.55)),
          rng.intRange(Math.floor(height * 0.75), Math.floor(height * 0.9)),
        ];

  const tiers: BuildingTier[] = [];
  let curX = x;
  let curZ = z;
  let curWidth = width;
  let curDepth = depth;
  let curStart = 0;

  for (const boundary of boundaries) {
    tiers.push({ yStart: curStart, yEnd: boundary, x: curX, z: curZ, width: curWidth, depth: curDepth });

    const inset = rng.intRange(SETBACK_INSET_MIN, SETBACK_INSET_MAX);
    const nextWidth = curWidth - inset * 2;
    const nextDepth = curDepth - inset * 2;
    if (nextWidth < MIN_FOOTPRINT_SIZE || nextDepth < MIN_FOOTPRINT_SIZE) {
      // Can't shrink further: extend the tier just pushed to the roof instead
      // of leaving a degenerate sliver tier above it.
      const last = tiers[tiers.length - 1] as BuildingTier;
      tiers[tiers.length - 1] = { ...last, yEnd: height };
      return tiers;
    }

    curX += inset;
    curZ += inset;
    curWidth = nextWidth;
    curDepth = nextDepth;
    curStart = boundary;
  }

  tiers.push({ yStart: curStart, yEnd: height, x: curX, z: curZ, width: curWidth, depth: curDepth });
  return tiers;
}

/** Rolls a vertical neon sign strip on a random facade of the ground tier, or null. */
function planSignStrip(rng: Rng, district: District, tier0: BuildingTier, height: number): SignStrip | null {
  if (!rng.chance(SIGN_CHANCE[district])) return null;

  const side = rng.pick<DoorSide>(['north', 'south', 'east', 'west']);
  const tangentLength = side === 'north' || side === 'south' ? tier0.width : tier0.depth;
  if (tangentLength < SIGN_WIDTH + 2) return null;

  const stripHeight = rng.intRange(SIGN_MIN_HEIGHT, Math.min(SIGN_MAX_HEIGHT, height - 2));
  if (stripHeight < SIGN_MIN_HEIGHT) return null;

  const tangentOrigin = side === 'north' || side === 'south' ? tier0.x : tier0.z;
  const offset = tangentOrigin + rng.intRange(1, tangentLength - SIGN_WIDTH - 1);
  const yStart = rng.intRange(1, height - stripHeight - 1);
  const color = rng.pick(SIGN_COLORS);

  return { side, offset, yStart, height: stripHeight, color };
}

/** Rolls an antenna mast (METAL shaft + NEON tip) for a tall enough downtown tower. */
function planAntenna(rng: Rng, district: District, height: number): AntennaMast | null {
  if (district !== District.DOWNTOWN) return null;
  if (height < ANTENNA_MIN_TOWER_HEIGHT) return null;
  if (!rng.chance(ANTENNA_CHANCE)) return null;
  return { height: rng.intRange(ANTENNA_MIN_MAST, ANTENNA_MAX_MAST) };
}

/**
 * Plans one building for a parcel, or returns null if the parcel is too
 * small (after inset) to host anything, or if the district hosts no
 * buildings at all (parks). `rng` should be a stream forked specifically
 * for this parcel so results are stable regardless of generation/iteration
 * order elsewhere. `layout` provides the city's road grid, used both for
 * the doorway's road bias and (indirectly, via district) for height range.
 */
export function planBuilding(
  parcel: Parcel,
  rng: Rng,
  layout: CityLayout,
  baseY: number,
  district: District,
): BuildingPlan | null {
  const params = DISTRICT_PARAMS[district];
  if (params.maxHeight <= 0) return null;

  const maxInsetForParcel = Math.floor((Math.min(parcel.width, parcel.depth) - MIN_FOOTPRINT_SIZE) / 2);
  const inset = clamp(rng.intRange(0, MAX_FOOTPRINT_INSET), 0, Math.max(0, maxInsetForParcel));

  const width = parcel.width - inset * 2;
  const depth = parcel.depth - inset * 2;
  if (width < MIN_FOOTPRINT_SIZE || depth < MIN_FOOTPRINT_SIZE) return null;

  const x = parcel.x + inset;
  const z = parcel.z + inset;

  const height = rng.intRange(params.minHeight, params.maxHeight);
  const wallMaterial = rng.pick(DISTRICT_WALL_MATERIALS[district]);
  const windowStride = rng.pick(WINDOW_STRIDES);
  const windowPhase = rng.intRange(0, windowStride - 1);
  const windowLitChance = DISTRICT_WINDOW_LIT_CHANCE[district];
  const { doorSide, doorStart } = planDoor(rng, layout, x, z, width, depth);

  const tiers = planTiers(x, z, width, depth, height, rng);
  const tier0 = tiers[0] as BuildingTier;

  const shopBandColor = district === District.COMMERCIAL && doorSide ? rng.pick(SHOP_BAND_COLORS) : null;
  const signStrip = planSignStrip(rng, district, tier0, height);
  const roofTrimColor = district === District.DOWNTOWN ? rng.pick(SIGN_COLORS) : null;
  const antenna = planAntenna(rng, district, height);

  return {
    x,
    z,
    width,
    depth,
    baseY,
    height,
    district,
    wallMaterial,
    windowStride,
    windowPhase,
    windowLitChance,
    doorSide,
    doorStart,
    tiers,
    shopBandColor,
    signStrip,
    roofTrimColor,
    antenna,
    rng,
  };
}

function writeShellAndWindows(world: World, plan: BuildingPlan): void {
  const { baseY, wallMaterial, windowStride, windowPhase, windowLitChance, rng, tiers } = plan;

  for (const tier of tiers) {
    for (let ry = tier.yStart; ry < tier.yEnd; ry++) {
      const y = baseY + ry;
      // Ground floor (ry === 0) always stays solid wall so the doorway carve reads cleanly.
      const isWindowRow = ry !== 0 && ry % windowStride === windowPhase;

      for (let dx = 0; dx < tier.width; dx++) {
        for (let dz = 0; dz < tier.depth; dz++) {
          const isShell = dx === 0 || dx === tier.width - 1 || dz === 0 || dz === tier.depth - 1;
          if (!isShell) continue;

          const block = isWindowRow ? (rng.chance(windowLitChance) ? WINDOW_LIT : GLASS_DARK) : wallMaterial;
          world.setBlockRaw(tier.x + dx, y, tier.z + dz, block);
        }
      }
    }
  }
}

/** Caps every tier but the last with a solid terrace deck, so setbacks read as stepped ledges. */
function writeSetbackDecks(world: World, plan: BuildingPlan): void {
  const { baseY, tiers } = plan;
  for (let i = 0; i < tiers.length - 1; i++) {
    const tier = tiers[i] as BuildingTier;
    const y = baseY + tier.yEnd;
    for (let dx = 0; dx < tier.width; dx++) {
      for (let dz = 0; dz < tier.depth; dz++) {
        world.setBlockRaw(tier.x + dx, y, tier.z + dz, CONCRETE);
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

/** Commercial-only street-level neon shop band across the doorway wall, at y = baseY+1..baseY+2. */
function writeShopBand(world: World, plan: BuildingPlan): void {
  const { doorSide, shopBandColor, x, z, width, depth, baseY } = plan;
  if (!doorSide || shopBandColor === null) return;

  for (const ry of [1, 2]) {
    const y = baseY + ry;
    if (doorSide === 'south') for (let dx = 0; dx < width; dx++) world.setBlockRaw(x + dx, y, z, shopBandColor);
    else if (doorSide === 'north')
      for (let dx = 0; dx < width; dx++) world.setBlockRaw(x + dx, y, z + depth - 1, shopBandColor);
    else if (doorSide === 'west') for (let dz = 0; dz < depth; dz++) world.setBlockRaw(x, y, z + dz, shopBandColor);
    else for (let dz = 0; dz < depth; dz++) world.setBlockRaw(x + width - 1, y, z + dz, shopBandColor);
  }
}

function writeSignStrip(world: World, plan: BuildingPlan): void {
  const { signStrip, baseY, tiers } = plan;
  if (!signStrip) return;
  const tier0 = tiers[0] as BuildingTier;
  const { side, offset, yStart, height, color } = signStrip;

  for (let h = 0; h < height; h++) {
    const y = baseY + yStart + h;
    for (let w = 0; w < SIGN_WIDTH; w++) {
      if (side === 'south') world.setBlockRaw(offset + w, y, tier0.z, color);
      else if (side === 'north') world.setBlockRaw(offset + w, y, tier0.z + tier0.depth - 1, color);
      else if (side === 'west') world.setBlockRaw(tier0.x, y, offset + w, color);
      else world.setBlockRaw(tier0.x + tier0.width - 1, y, offset + w, color);
    }
  }
}

function writeRoof(world: World, plan: BuildingPlan): void {
  const { baseY, wallMaterial, roofTrimColor, tiers } = plan;
  const lastTier = tiers[tiers.length - 1] as BuildingTier;
  const { x, z, width, depth } = lastTier;
  const roofY = baseY + lastTier.yEnd;

  for (let dx = 0; dx < width; dx++) {
    for (let dz = 0; dz < depth; dz++) {
      world.setBlockRaw(x + dx, roofY, z + dz, CONCRETE);
    }
  }

  const parapetY = roofY + 1;
  const parapetMaterial = roofTrimColor ?? wallMaterial;
  for (let dx = 0; dx < width; dx++) {
    for (let dz = 0; dz < depth; dz++) {
      const isShell = dx === 0 || dx === width - 1 || dz === 0 || dz === depth - 1;
      if (!isShell) continue;
      world.setBlockRaw(x + dx, parapetY, z + dz, parapetMaterial);
    }
  }
}

function writeAntenna(world: World, plan: BuildingPlan): void {
  const { antenna, baseY, tiers } = plan;
  if (!antenna) return;
  const lastTier = tiers[tiers.length - 1] as BuildingTier;
  const centerX = lastTier.x + Math.floor(lastTier.width / 2);
  const centerZ = lastTier.z + Math.floor(lastTier.depth / 2);
  const roofY = baseY + lastTier.yEnd + 1; // parapet sits at +1, mast starts above it

  for (let h = 0; h < antenna.height; h++) {
    world.setBlockRaw(centerX, roofY + h, centerZ, METAL);
  }
  world.setBlockRaw(centerX, roofY + antenna.height, centerZ, NEON_PINK);
}

/** Extrudes a planned building into the world via setBlockRaw only (no dirty events). */
export function writeBuilding(world: World, plan: BuildingPlan): void {
  writeShellAndWindows(world, plan);
  writeSetbackDecks(world, plan);
  writeShopBand(world, plan);
  writeSignStrip(world, plan);
  // Doorway carve runs last among wall writers so it always wins over any
  // shop band / sign strip that happens to land on the same wall cells —
  // the door must stay walkable.
  writeDoorway(world, plan);
  writeRoof(world, plan);
  writeAntenna(world, plan);
}
