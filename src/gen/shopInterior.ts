/**
 * Ground-floor shop interiors: a hollow, walkable room behind a commercial
 * building's street-level doorway, dressed with a per-archetype furniture
 * layout and interior neon signage.
 *
 * Walkability is guaranteed by construction, not by post-hoc checking:
 * `writeShopInterior` never places anything solid on the interior rect's own
 * boundary ("ring") cells — the one-voxel-deep lane just inside the
 * building's walls. The doorway always opens directly onto a ring cell (the
 * door is carved through the wall itself, and the ring is every interior
 * cell adjacent to a wall), so the ring forms a closed, fully-connected loop
 * reachable from the doorway no matter what furniture is rolled. Furniture
 * is confined to the "core" — the ring's interior, one more voxel in — so it
 * can never sever that loop; at worst it fills the entire core and the room
 * degrades to a walkable ring with no core floor space, never a dead end.
 *
 * A building with a planned shop interior is excluded from *elevator*-shaft
 * candidacy entirely (see `infrastructure.ts`'s `planElevatorShafts`) rather
 * than trying to route that shaft's fixed footprint around a room laid out
 * independently: the elevator shaft anchors to the tower's own NW interior
 * corner regardless of where the doorway sits, so a shop with a west or south
 * door would otherwise have its walkway ring overwritten by shaft-wall blocks
 * written after this module runs — a real defect this module's own
 * generator-output tests caught.
 *
 * A bridge's internal *stair* shaft is different: it's centered on the
 * tower's footprint (see `infrastructure.ts`'s `stairShaftOrigin`), which —
 * given `BRIDGE_MIN_TOWER_FOOTPRINT` >= 10 — always lands inside this
 * module's "core" (one cell in from the ring), never on the ring itself. So
 * shop buildings are NOT excluded from stair-shaft/bridge candidacy. What a
 * centered shaft *can* do is land on furniture: `writeShopInterior` accepts
 * an optional `excludeColumns` set (the shaft's footprint, computed by
 * `infrastructure.ts`'s `stairShaftFootprintColumns`) so furniture placement
 * skips those cells gracefully instead of writing shelves/counters that the
 * shaft would just overwrite moments later.
 *
 * Kept separate from `buildings.ts` (which already re-exports the pieces
 * `planBuilding`/`writeBuilding` need) so the room-layout logic is
 * independently testable and doesn't bloat that file further.
 */

import { District } from './districts';
import type { Rng } from './rng';
import { CONCRETE, NEON_CYAN, NEON_PINK, NEON_PURPLE, NEON_YELLOW, SHOP_COUNTER, SHOP_SHELF } from '../world/BlockRegistry';
import type { World } from '../world/World';
import type { BuildingTier, DoorSide } from './buildings';

export const SHOP_ARCHETYPES = ['noodle_bar', 'electronics', 'bar', 'convenience'] as const;
export type ShopArchetype = (typeof SHOP_ARCHETYPES)[number];

const ARCHETYPE_NEON: Record<ShopArchetype, number> = {
  noodle_bar: NEON_PINK,
  electronics: NEON_CYAN,
  bar: NEON_PURPLE,
  convenience: NEON_YELLOW,
};

/** Row offset (from baseY) the room's ceiling caps out at — matches DOOR_HEIGHT so the doorway never pokes into it. */
const CEILING_RY = 3;
/** An interior rect narrower than this (either axis) has no room for a 1-voxel ring *and* a core; skip furniture entirely and leave the plain hollow shell. */
const MIN_INTERIOR_SPAN = 3;

export interface Rect {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

export interface ShopInteriorPlan {
  archetype: ShopArchetype;
  neonColor: number;
  doorSide: DoorSide;
  /** World-space interior rect (inside the walls, excludes the wall shell itself). */
  interior: Rect;
  /** World-space core rect (inside the ring); furniture is confined to this. */
  core: Rect;
}

function rectContains(rect: Rect, x: number, z: number): boolean {
  return x >= rect.x0 && x <= rect.x1 && z >= rect.z0 && z <= rect.z1;
}

/** True for cells on the interior rect's own boundary — the walkway ring that must never be built on. */
function isRingCell(interior: Rect, x: number, z: number): boolean {
  return x === interior.x0 || x === interior.x1 || z === interior.z0 || z === interior.z1;
}

/**
 * Plans a shop interior for a commercial building's ground tier, or `null`
 * if the district/doorway/footprint doesn't qualify — callers should leave
 * the plain hollow shell untouched in that case rather than force a room
 * into too little space.
 */
export function planShopInterior(
  rng: Rng,
  district: District,
  doorSide: DoorSide | null,
  tier0: BuildingTier,
): ShopInteriorPlan | null {
  if (district !== District.COMMERCIAL || !doorSide) return null;

  const interior: Rect = {
    x0: tier0.x + 1,
    z0: tier0.z + 1,
    x1: tier0.x + tier0.width - 2,
    z1: tier0.z + tier0.depth - 2,
  };
  const interiorWidth = interior.x1 - interior.x0 + 1;
  const interiorDepth = interior.z1 - interior.z0 + 1;
  if (interiorWidth < MIN_INTERIOR_SPAN || interiorDepth < MIN_INTERIOR_SPAN) return null;

  const core: Rect = { x0: interior.x0 + 1, z0: interior.z0 + 1, x1: interior.x1 - 1, z1: interior.z1 - 1 };
  const archetype = rng.pick(SHOP_ARCHETYPES);

  return { archetype, neonColor: ARCHETYPE_NEON[archetype], doorSide, interior, core };
}

/** Depth axis (into the room, away from the door wall) and tangent axis (along the door wall) for a given door side. */
function roomAxes(doorSide: DoorSide): { tangentAxis: 'x' | 'z'; depthAxis: 'x' | 'z'; depthTowardFar: 1 | -1 } {
  switch (doorSide) {
    case 'south':
      return { tangentAxis: 'x', depthAxis: 'z', depthTowardFar: 1 };
    case 'north':
      return { tangentAxis: 'x', depthAxis: 'z', depthTowardFar: -1 };
    case 'west':
      return { tangentAxis: 'z', depthAxis: 'x', depthTowardFar: 1 };
    case 'east':
      return { tangentAxis: 'z', depthAxis: 'x', depthTowardFar: -1 };
  }
}

/**
 * Writes a solid floor-level furniture block at (x, z, baseY), unless the
 * cell falls outside `core`, on the ring, or in `excludeColumns` — the
 * footprint of a stair shaft this same building will get later (see this
 * file's doc comment). Skipping those cells here avoids planting furniture
 * that a subsequent shaft write would just carve straight through.
 */
function placeFurnitureCell(
  world: World,
  baseY: number,
  core: Rect,
  interior: Rect,
  x: number,
  z: number,
  block: number,
  excludeColumns?: ReadonlySet<string>,
): void {
  if (!rectContains(core, x, z)) return;
  // Defense in depth: `core` is derived from `interior` shrunk by one, so this
  // should be unreachable, but a future archetype miscomputing its own
  // (x, z) must never be able to solidify the ring the doorway depends on.
  if (isRingCell(interior, x, z)) return;
  if (excludeColumns?.has(`${x},${z}`)) return;
  world.setBlockRaw(x, baseY, z, block);
}

/**
 * Shelf/aisle layout (electronics, convenience): full-depth shelf rows every
 * other cell along the tangent axis, alternating with clear aisles. Each
 * shelf row's far-most cell gets a neon accent block standing in for a lit
 * display sign.
 */
function writeShelfAisles(
  world: World,
  baseY: number,
  core: Rect,
  interior: Rect,
  axes: ReturnType<typeof roomAxes>,
  neonColor: number,
  skipNearRow: boolean,
  excludeColumns?: ReadonlySet<string>,
): void {
  const tRange = axes.tangentAxis === 'x' ? [core.x0, core.x1] : [core.z0, core.z1];
  const dRange = axes.depthAxis === 'x' ? [core.x0, core.x1] : [core.z0, core.z1];
  const [t0, t1] = tRange as [number, number];
  const [d0, d1] = dRange as [number, number];
  const dFar = axes.depthTowardFar === 1 ? d1 : d0;
  const dNear = axes.depthTowardFar === 1 ? d0 : d1;

  for (let t = t0, shelfIndex = 0; t <= t1; t++, shelfIndex++) {
    if (shelfIndex % 2 !== 0) continue; // odd columns are the clear aisles

    for (let d = d0; d <= d1; d++) {
      if (skipNearRow && d === dNear) continue;
      const x = axes.tangentAxis === 'x' ? t : d;
      const z = axes.tangentAxis === 'x' ? d : t;
      placeFurnitureCell(world, baseY, core, interior, x, z, SHOP_SHELF, excludeColumns);
    }

    const accentX = axes.tangentAxis === 'x' ? t : dFar;
    const accentZ = axes.tangentAxis === 'x' ? dFar : t;
    if (!skipNearRow || dFar !== dNear) {
      placeFurnitureCell(world, baseY, core, interior, accentX, accentZ, neonColor, excludeColumns);
    }
  }
}

/**
 * Counter layout (noodle_bar, bar): one counter row at a fixed depth,
 * spanning most of the tangent range with a gap so it never reads as a solid
 * divider, plus a couple of neon accent blocks along it.
 */
function writeCounter(
  world: World,
  baseY: number,
  core: Rect,
  interior: Rect,
  axes: ReturnType<typeof roomAxes>,
  neonColor: number,
  depthPosition: 'mid' | 'far',
  excludeColumns?: ReadonlySet<string>,
): void {
  const tRange = axes.tangentAxis === 'x' ? [core.x0, core.x1] : [core.z0, core.z1];
  const dRange = axes.depthAxis === 'x' ? [core.x0, core.x1] : [core.z0, core.z1];
  const [t0, t1] = tRange as [number, number];
  const [d0, d1] = dRange as [number, number];
  const dFar = axes.depthTowardFar === 1 ? d1 : d0;
  const dMid = Math.round((d0 + d1) / 2);
  const d = depthPosition === 'far' ? dFar : dMid;

  const gapT = t0 + Math.floor((t1 - t0) / 2);
  for (let t = t0; t <= t1; t++) {
    if (t === gapT) continue; // server/pass-through gap, keeps the counter from reading as a solid wall
    const x = axes.tangentAxis === 'x' ? t : d;
    const z = axes.tangentAxis === 'x' ? d : t;
    const isAccent = (t - t0) % 3 === 0;
    placeFurnitureCell(world, baseY, core, interior, x, z, isAccent ? neonColor : SHOP_COUNTER, excludeColumns);
  }
}

/** Recolors a small panel of the wall opposite the doorway to the archetype's neon color — the "interior signage" that reads through windows/doorway at night. */
function writeBackWallSignage(world: World, baseY: number, tier0: BuildingTier, doorSide: DoorSide, neonColor: number): void {
  const signRy = 1;
  const y = baseY + signRy;
  const tangentCenter =
    doorSide === 'south' || doorSide === 'north'
      ? tier0.x + Math.floor(tier0.width / 2)
      : tier0.z + Math.floor(tier0.depth / 2);

  const cells: Array<[number, number]> = [];
  if (doorSide === 'south') {
    // Back wall is the far (north/max-z) wall.
    for (const dx of [-1, 0]) cells.push([tangentCenter + dx, tier0.z + tier0.depth - 1]);
  } else if (doorSide === 'north') {
    for (const dx of [-1, 0]) cells.push([tangentCenter + dx, tier0.z]);
  } else if (doorSide === 'west') {
    for (const dz of [-1, 0]) cells.push([tier0.x + tier0.width - 1, tangentCenter + dz]);
  } else {
    for (const dz of [-1, 0]) cells.push([tier0.x, tangentCenter + dz]);
  }

  for (const [x, z] of cells) world.setBlockRaw(x, y, z, neonColor);
}

/**
 * Caps the room with a solid ceiling at `baseY + CEILING_RY`, except over a
 * coexisting stair shaft's own footprint (`excludeColumns`). A real-output
 * climb-BFS (see `CityGenerator.test.ts`) caught this: the ceiling is a
 * blanket slab at a *fixed* row regardless of where the shaft's spiral is in
 * its climb, and that fixed row lands exactly on the "+2 rows above the
 * departure step" `tryAutoStep` needs to climb through the shaft's first few
 * risers — the furniture writers already dodge `excludeColumns`, but nothing
 * previously told the ceiling to. Unlike furniture (which can legitimately
 * just not exist in a cell), the shaft needs to rise cleanly through this
 * floor no matter which of its 8 ring columns happens to line up with this
 * particular row, so the whole 3x3 footprint is excluded here — not just the
 * specific columns this one row's climb-gate math would require — mirroring
 * how the elevator shaft keeps its own well hollow through its *entire*
 * height regardless of what a tier's own walls would otherwise put there.
 */
function writeCeiling(world: World, baseY: number, interior: Rect, excludeColumns?: ReadonlySet<string>): void {
  const y = baseY + CEILING_RY;
  for (let x = interior.x0; x <= interior.x1; x++) {
    for (let z = interior.z0; z <= interior.z1; z++) {
      if (excludeColumns?.has(`${x},${z}`)) continue;
      world.setBlockRaw(x, y, z, CONCRETE);
    }
  }
}

/**
 * Extrudes a planned shop interior into `world`. Ring cells (the interior
 * rect's own boundary) are never written to by the furniture pass above —
 * see this module's doc comment for why that alone guarantees
 * doorway-to-room connectivity regardless of archetype. `setBlockRaw` only,
 * no dirty events, matching every other `gen/` writer.
 *
 * `excludeColumns` — a stair shaft's footprint (see
 * `infrastructure.ts`'s `stairShaftFootprintColumns`), when this building
 * will get one — is threaded through to every furniture writer so none of
 * them plant a shelf/counter/accent block where the shaft is about to rise.
 * It's the caller's job to compute this (a shaft's existence depends on the
 * whole-city bridge plan, which isn't available at per-building write time);
 * omitting it just means furniture is written and then overwritten by the
 * shaft later, which is correct but wasteful.
 */
export function writeShopInterior(
  world: World,
  baseY: number,
  tier0: BuildingTier,
  plan: ShopInteriorPlan,
  excludeColumns?: ReadonlySet<string>,
): void {
  const { archetype, neonColor, doorSide, interior, core } = plan;
  const axes = roomAxes(doorSide);

  switch (archetype) {
    case 'electronics':
      writeShelfAisles(world, baseY, core, interior, axes, neonColor, false, excludeColumns);
      break;
    case 'convenience':
      writeShelfAisles(world, baseY, core, interior, axes, neonColor, true, excludeColumns);
      break;
    case 'bar':
      writeCounter(world, baseY, core, interior, axes, neonColor, 'far', excludeColumns);
      break;
    case 'noodle_bar':
      writeCounter(world, baseY, core, interior, axes, neonColor, 'mid', excludeColumns);
      break;
  }

  writeBackWallSignage(world, baseY, tier0, doorSide, neonColor);
  writeCeiling(world, baseY, interior, excludeColumns);
}
