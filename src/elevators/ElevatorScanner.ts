/**
 * Derives functional elevator shafts purely from a `World`'s current voxel
 * state — the same "no separate persisted state, just re-read the blocks"
 * convention `entities/NavGrid.ts` uses for pedestrian/vehicle nav data.
 * This is deliberate, not incidental: a `.vxc` import has no
 * `ElevatorShaftMarker[]` (that's a 2D-planning artifact of `gen/`, never
 * serialized — see `io/Serializer.ts`'s bare `blocks` payload), so an
 * imported or hand-edited city's elevators can only ever come from scanning
 * `ELEVATOR_SHAFT` blocks themselves.
 *
 * A shaft is a 3x3-footprint hollow tube: 8 perimeter (wall) columns of
 * `ELEVATOR_SHAFT` blocks around one hollow "well" column the platform rides
 * in. A *stop* is a floor level where the shaft's generator carved a 2-voxel
 * headroom doorway through exactly one of the 4 edge-center wall columns
 * (see `gen/infrastructure.ts`'s `writeElevatorShaft`) — detected here purely
 * by noticing that column's blocks are missing at that row, so sandbox edits
 * that punch new holes (or seal old ones) are picked up the same way a fresh
 * scan after generation is.
 */

import { ELEVATOR_SHAFT } from '../world/BlockRegistry';
import { CHUNK_SIZE, chunkLocalToWorld } from '../world/coords';
import type { World } from '../world/World';

export interface ElevatorShaft {
  /** Stable identity for this shaft, keyed by its wall origin — stable across rescans as long as the tower doesn't move. */
  readonly id: string;
  /** World (x, z) of the single hollow "well" column the platform rides in. */
  readonly wellX: number;
  readonly wellZ: number;
  /** Inclusive vertical extent of the shaft's wall tube. */
  readonly minY: number;
  readonly maxY: number;
  /** Ascending world-Y feet positions (floor level + 1) where a rideable doorway exists. */
  readonly stops: readonly number[];
  /**
   * World (x, z) of the doorway wall-cell itself, one per `stops` entry (same
   * order/index) -- exactly one step from `wellX`/`wellZ`, in whichever of
   * the 4 `EDGE_OFFSETS` directions that stop's doorway was carved through
   * (see `deriveStops`). This is purely geometric, same "not semantic"
   * caveat as `stops` itself: it identifies *where the opening is*, not
   * whether real floor exists on the other side of it -- a caller planning a
   * rider's board/exit point (see `player/TourElevatorRide.ts`) must still
   * independently confirm nearby floor is actually walkable before treating
   * it as a real landing.
   */
  readonly doorCells: ReadonlyArray<{ readonly x: number; readonly z: number }>;
}

/** The 8 (dx, dz) offsets of a 3x3 shaft's perimeter, relative to its (min-x, min-z) wall origin. */
const RING_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [1, 0],
  [2, 0],
  [0, 1],
  [2, 1],
  [0, 2],
  [1, 2],
  [2, 2],
];

/** The 4 non-corner ring cells a doorway can be carved through (see `writeElevatorShaft`). */
const EDGE_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [0, 1],
  [2, 1],
  [1, 2],
];

/**
 * The 4 corner ring cells. Unlike edge cells, `writeElevatorShaft` never
 * carves these to air at a doorway (only recolors them for the neon door
 * frame — still solid), so they're what actually reconstructs the shaft's
 * true vertical extent: an `ELEVATOR_SHAFT`-id-based column scan alone would
 * under-report a corner's range at every stop it flanks (its blocks there are
 * `NEON_CYAN`, not `ELEVATOR_SHAFT`).
 */
const CORNER_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [2, 0],
  [0, 2],
  [2, 2],
];

/** A functional shaft needs at least a ground stop and one more — a single-stop "shaft" can't ride anywhere. */
const MIN_STOPS_FOR_FUNCTIONAL_SHAFT = 2;

interface ColumnExtent {
  minY: number;
  maxY: number;
}

function columnKey(x: number, z: number): string {
  return `${x},${z}`;
}

/** Every (x, z) column that has ever held an ELEVATOR_SHAFT block, with that column's Y extent — scoped to allocated chunks only, so this stays cheap on a mostly-empty world. */
function collectShaftColumns(world: World): Map<string, ColumnExtent> {
  const columns = new Map<string, ColumnExtent>();

  for (const { cx, cy, cz, chunk } of world.allocatedChunkEntries()) {
    for (let ly = 0; ly < CHUNK_SIZE; ly++) {
      for (let lz = 0; lz < CHUNK_SIZE; lz++) {
        for (let lx = 0; lx < CHUNK_SIZE; lx++) {
          if (chunk.getLocal(lx, ly, lz) !== ELEVATOR_SHAFT) continue;

          const { x, y, z } = chunkLocalToWorld({ cx, cy, cz }, { lx, ly, lz });
          const key = columnKey(x, z);
          const existing = columns.get(key);
          if (existing) {
            existing.minY = Math.min(existing.minY, y);
            existing.maxY = Math.max(existing.maxY, y);
          } else {
            columns.set(key, { minY: y, maxY: y });
          }
        }
      }
    }
  }

  return columns;
}

/** True if row `y` still has all 4 solid corners and a hollow well — i.e. it's still part of an intact shaft tube, doorway or not. */
function isIntactRingRow(world: World, ox: number, oz: number, y: number): boolean {
  const cornersSolid = CORNER_OFFSETS.every(([dx, dz]) => world.isSolid(ox + dx, y, oz + dz));
  const wellHollow = !world.isSolid(ox + 1, y, oz + 1);
  return cornersSolid && wellHollow;
}

/**
 * The shaft's true vertical extent, found by walking corner solidity (not
 * `ELEVATOR_SHAFT`-id presence — see `CORNER_OFFSETS`' doc comment) across
 * the union of the 8 wall columns' recorded ranges. Returns null if any row
 * in that union has lost a corner or had its well blocked — i.e. a sandbox
 * edit broke the tube somewhere, not just carved a doorway.
 */
function resolveVerticalExtent(
  world: World,
  ox: number,
  oz: number,
  unionMinY: number,
  unionMaxY: number,
): { minY: number; maxY: number } | null {
  for (let y = unionMinY; y <= unionMaxY; y++) {
    if (!isIntactRingRow(world, ox, oz, y)) return null;
  }
  return { minY: unionMinY, maxY: unionMaxY };
}

/**
 * Ascending feet-Y stops for a shaft at wall origin (ox, oz) spanning
 * [minY, maxY]: a row is a "door row" when exactly one of the 4 edge-center
 * ring cells is non-solid there. Consecutive door rows sharing the same open
 * cell are one doorway (2 voxels tall by construction); a stop's feet-Y is
 * the *bottom* of that span, matching the rest of the codebase's
 * "solid floor at Y, walkable at Y+1" convention (see `Bridge.level` /
 * `SkyLobby.y`).
 *
 * This is purely block-shaped, not semantic, so a sandbox edit that punches
 * a single stray hole through one edge-center cell mid-wall (never touching
 * the other 3 offsets, and not one of `writeElevatorShaft`'s real doorways)
 * reads as a legitimate stop — a "phantom" stop with no floor on the other
 * side. That's an accepted trade-off, not a bug: it's graceful (no crash,
 * `ElevatorSimulation` just parks/travels to it like any other stop, and a
 * rider stepping "off" there simply finds solid shaft wall or open air
 * depending on what's actually behind the hole) rather than an attempt to
 * distinguish "real doorway" from "accidental hole," which would need this
 * scanner to know the generator's own conventions instead of just reading
 * blocks back.
 */
interface StopsAndDoors {
  stops: number[];
  doorCells: Array<{ x: number; z: number }>;
}

/**
 * Alongside each stop's Y (see this function's original doc comment above
 * `ElevatorShaft.doorCells`), also records that stop's doorway wall-cell in
 * world (x, z): `openOffsets[0]` is one of `EDGE_OFFSETS`, i.e. `(ox+dx,
 * oz+dz)` for some `(dx, dz)` -- and since `EDGE_OFFSETS` are exactly the 4
 * ring cells orthogonally adjacent to the well at `(ox+1, oz+1)`, subtracting
 * 1 from each of `dx`/`dz` gives the unit direction from the well through
 * that wall cell, so `wellX/Z + (dx-1, dz-1)` is the wall cell itself -- one
 * step from the well, matching the direction a rider would actually approach
 * or exit from.
 */
function deriveStops(world: World, ox: number, oz: number, minY: number, maxY: number): StopsAndDoors {
  const stops: number[] = [];
  const doorCells: Array<{ x: number; z: number }> = [];
  const wellX = ox + 1;
  const wellZ = oz + 1;
  let previousOpenKey: string | null = null;

  for (let y = minY; y <= maxY; y++) {
    const openOffsets = EDGE_OFFSETS.filter(([dx, dz]) => !world.isSolid(ox + dx, y, oz + dz));
    const currentKey = openOffsets.length === 1 ? `${openOffsets[0]?.[0]},${openOffsets[0]?.[1]}` : null;

    if (currentKey !== null && currentKey !== previousOpenKey) {
      stops.push(y);
      const [edgeDx, edgeDz] = openOffsets[0] as [number, number];
      doorCells.push({ x: wellX + (edgeDx - 1), z: wellZ + (edgeDz - 1) });
    }
    previousOpenKey = currentKey;
  }

  return { stops, doorCells };
}

/**
 * Scans `world` for every intact 3x3 elevator shaft and its stop levels.
 * Purely a function of current voxel state: re-running after a sandbox edit
 * that breaks a shaft's ring (removes a wall column, or removes so much of
 * the ring that the vertical wall extent no longer overlaps) simply omits it
 * from the result — callers (see `ElevatorSystem.rebuild`) treat "not
 * returned" as "deactivated," never a crash.
 */
export function scanElevatorShafts(world: World): ElevatorShaft[] {
  const columns = collectShaftColumns(world);
  const shafts: ElevatorShaft[] = [];
  const consumedOrigins = new Set<string>();

  for (const key of columns.keys()) {
    const [xs, zs] = key.split(',');
    const ox = Number(xs);
    const oz = Number(zs);
    const originKey = columnKey(ox, oz);
    if (consumedOrigins.has(originKey)) continue;

    const ringColumns = RING_OFFSETS.map(([dx, dz]) => columns.get(columnKey(ox + dx, oz + dz)));
    if (ringColumns.some((c) => c === undefined)) continue; // not all 8 wall columns present -> not (currently) a valid shaft origin

    const wellKey = columnKey(ox + 1, oz + 1);
    if (columns.has(wellKey)) continue; // the well must never itself have held a wall block

    consumedOrigins.add(originKey);

    const definiteRingColumns = ringColumns as ColumnExtent[];
    const unionMinY = Math.min(...definiteRingColumns.map((c) => c.minY));
    const unionMaxY = Math.max(...definiteRingColumns.map((c) => c.maxY));
    const extent = resolveVerticalExtent(world, ox, oz, unionMinY, unionMaxY);
    if (!extent) continue; // broken somewhere in its own recorded range -> not a currently-intact shaft

    const { minY, maxY } = extent;
    const { stops, doorCells } = deriveStops(world, ox, oz, minY, maxY);
    if (stops.length < MIN_STOPS_FOR_FUNCTIONAL_SHAFT) continue;

    shafts.push({ id: originKey, wellX: ox + 1, wellZ: oz + 1, minY, maxY, stops, doorCells });
  }

  return shafts;
}
