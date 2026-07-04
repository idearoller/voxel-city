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
 * The ground-floor surface (`groundY`, i.e. `CityGenerator`'s
 * GROUND_SURFACE_Y) is scanned for sidewalk/road/park-path cells. On top of
 * that, `elevatedLevels` holds one additional walkable grid per known
 * elevated deck row — skybridges (`infrastructure.ts`'s `SKY_LEVELS`) and the
 * downtown walkway row (`WALKWAY_Y`) — derived the same layout-free way, by
 * scanning those specific rows for METAL-with-clear-headroom cells rather
 * than depending on `GenerationResult`'s `bridges`/`walkways` plans (which
 * don't exist after a `.vxc` import). Only these known rows are scanned, not
 * every Y in the world — see `buildElevatedLevels`.
 *
 * `stairLinks` connects the ground row to an elevated level through an
 * ordered run of stair-tread cells, derived the same voxel-only way (see
 * `deriveStairLinks`) rather than from `infrastructure.ts`'s `Walkway`/
 * `StairShaft` plans — so it survives a `.vxc` import too.
 */

import { SKY_LEVELS, WALKWAY_Y } from '../gen/infrastructure';
import { AIR, ASPHALT, CONCRETE, GRAVEL, METAL, SIDEWALK } from '../world/BlockRegistry';
import type { World } from '../world/World';

/** Every Y row a known elevated pedestrian deck can sit on, citywide. */
const ELEVATED_DECK_LEVELS: readonly number[] = [WALKWAY_Y, ...SKY_LEVELS];

export interface ElevatedLevel {
  /** Absolute world Y of this level's solid deck surface (e.g. a skybridge's `level` or `WALKWAY_Y`). The walkable clearance row is `y + 1`. */
  readonly y: number;
  /** 1 = walkable deck cell at this level, 0 = not. Same `x + z * width` indexing as `NavGrid.sidewalk`. */
  readonly walkable: Uint8Array;
  /**
   * Every walkable cell's (x, z), precomputed once at scan time — lets spawn
   * logic sample directly from the deck's own cells instead of
   * rejection-sampling a random annulus point against a citywide grid where
   * decks are a tiny fraction of the area (see `Spawner.ts`'s
   * `pickElevatedSpawnCell`).
   */
  readonly cells: ReadonlyArray<{ readonly x: number; readonly z: number }>;
}

/**
 * A single ground<->deck stair connection, every cell along its run from
 * the street landing to the deck landing, inclusive. `steps[0]` is always a
 * real ground-level sidewalk/gravel cell (`y === groundY`); `steps[last]` is
 * always a real elevated-deck cell (`y === levelY`, matching one of
 * `NavGrid.elevatedLevels`). Every entry between is one riser, and `y`
 * increases by exactly 1 from one entry to the next, with a single
 * exception: the very last transition (second-to-last entry, the top tread,
 * into `steps[last]`, the deck) is a flat lateral step, not a riser —
 * `writeSteps`' top tread always lands flush with the deck it leads to, both
 * at `y === levelY` (see `deriveStairLinks`'s doc comment). A pedestrian's
 * stair walk (and this suite's tests) both lean on this "+1 except the very
 * last hop" invariant.
 */
export interface StairLink {
  /** The connected elevated level's own `y` (matches `elevatedLevels[].y`). */
  readonly levelY: number;
  readonly steps: ReadonlyArray<{ readonly x: number; readonly y: number; readonly z: number }>;
}

export interface NavGrid {
  readonly width: number;
  readonly depth: number;
  readonly groundY: number;
  /** 1 = walkable sidewalk or park-path cell, 0 = not. Row-major, index = x + z * width. */
  readonly sidewalk: Uint8Array;
  /** 1 = drivable road cell, 0 = not. Same indexing as `sidewalk`. */
  readonly road: Uint8Array;
  /** Preferred travel heading for a road cell (one of -1/0/1 per axis, at most one axis nonzero). */
  readonly flowX: Int8Array;
  readonly flowZ: Int8Array;
  /** One entry per known elevated deck row that has any walkable cells at all (see `ELEVATED_DECK_LEVELS`). */
  readonly elevatedLevels: readonly ElevatedLevel[];
  /** Every ground<->deck stair connection found in `world` (see `deriveStairLinks`). Few — stairs are rare citywide. */
  readonly stairLinks: readonly StairLink[];
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

/** True if (x, z) is a walkable deck cell on `grid.elevatedLevels[levelIndex]`. */
export function isElevatedWalkableCell(grid: NavGrid, levelIndex: number, x: number, z: number): boolean {
  if (!inBounds(grid, x, z)) return false;
  const level = grid.elevatedLevels[levelIndex];
  if (!level) return false;
  return level.walkable[cellIndex(grid.width, x, z)] === 1;
}

/**
 * True if (x, z) is walkable at the given surface Y — `grid.groundY` (checked
 * against `sidewalk`, i.e. sidewalk or park path) or one of
 * `grid.elevatedLevels`' own `y` values (checked against that level's own
 * `walkable` grid). A `y` matching neither is never walkable. This is the
 * level-agnostic check `Pedestrian` uses every tick, since a pedestrian only
 * remembers the surface Y it's confined to (see `Pedestrian.y`), not which
 * `elevatedLevels` index that corresponds to.
 */
export function isWalkableSurfaceCell(grid: NavGrid, y: number, x: number, z: number): boolean {
  if (y === grid.groundY) return isSidewalkCell(grid, x, z);
  const levelIndex = grid.elevatedLevels.findIndex((level) => level.y === y);
  return levelIndex === -1 ? false : isElevatedWalkableCell(grid, levelIndex, x, z);
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
 * Scans one elevated deck row (`y`) over a `width` x `depth` footprint for
 * walkable cells: a solid METAL deck surface, AIR directly above it for
 * headroom, AND AIR directly below it — the same "surface + clearance" rule
 * `buildNavGrid` applies to the ground row, plus one more check specific to
 * elevated rows.
 *
 * That third check (`y - 1` is AIR) is load-bearing, not defensive
 * boilerplate: a real skybridge/walkway deck floats in the open gap between
 * towers or over the street, with nothing solid underneath it, but a
 * building's rooftop parapet trim (`buildings.ts`'s roof-edge ring) is also
 * often METAL, sits at `roofY + 1`, and that roof Y can coincide with one of
 * these scanned rows (mostly `y=30`, since tiers commonly top out a couple
 * voxels below it). Without the below-check, a parapet ring reads as a tiny
 * isolated walkable "deck" sitting on solid roof — measured on real
 * generated cities, this produced false-positive walkable cells on the
 * majority of seeds (up to ~35% of one city's total elevated cells) and let
 * pedestrians pace forever along a skyscraper's roof edge. A parapet's own
 * `y - 1` is the roof slab (solid); a real deck's `y - 1` is open air. This
 * costs a handful of real deck cells directly at a tower's own wall column
 * (where the tower's solid structure happens to extend to `y - 1` right at
 * the doorway threshold) but keeps ~98%+ of genuine deck area.
 *
 * Bridge decks are 3-wide with 2-high NEON rails along the two edge
 * rows/columns (see `infrastructure.ts`'s `writeBridge`); the headroom check
 * alone already excludes those edge cells (the rail itself occupies the
 * clearance voxel) without needing to know a bridge's axis or lane offset.
 * Walkway decks have no rails, so their whole footprint passes both checks.
 * Scanning by block content rather than by `GenerationResult`'s
 * `bridges`/`walkways` plans is what keeps this rebuildable after a `.vxc`
 * import, which carries no such plan (see this file's own doc comment).
 */
function buildElevatedLevel(world: World, width: number, depth: number, y: number): ElevatedLevel {
  const walkable = new Uint8Array(width * depth);
  const cells: Array<{ x: number; z: number }> = [];

  for (let x = 0; x < width; x++) {
    for (let z = 0; z < depth; z++) {
      if (world.getBlock(x, y, z) !== METAL) continue;
      if (world.getBlock(x, y + 1, z) !== AIR) continue;
      if (world.getBlock(x, y - 1, z) !== AIR) continue;
      walkable[cellIndex(width, x, z)] = 1;
      cells.push({ x, z });
    }
  }

  return { y, walkable, cells };
}

/** The 4 orthogonal (dx, dz) neighbor offsets a stair chain can step through. */
const STAIR_NEIGHBOR_OFFSETS: readonly [number, number][] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/** Upper bound on how many risers a single stair chain may have before it's treated as malformed rather than walked forever — generously above the tallest real riser count (`SKY_LEVELS`' 90 minus `groundY`, well under 100). */
const MAX_STAIR_RISERS = 128;

/**
 * True if (x, y, z) is a single stair tread — the exact voxel shape
 * `infrastructure.ts`'s `writeSteps` lays down for every riser of a walkway
 * or spiral stair shaft: a solid CONCRETE block with 2 clear voxels of
 * headroom directly above it. This alone doesn't distinguish a stair tread
 * from an ordinary CONCRETE floor slab (building tiers, roofs and sky lobbies
 * all use the same block with the same headroom) — what actually
 * disambiguates a stair is `traceStairDown`'s chain requirement: a floor
 * slab's neighboring cells sit at the *same* y, never one row down, so a
 * flat floor never produces the monotonic descending chain a real stair does.
 */
function isStairTread(world: World, x: number, y: number, z: number): boolean {
  return world.getBlock(x, y, z) === CONCRETE && world.getBlock(x, y + 1, z) === AIR && world.getBlock(x, y + 2, z) === AIR;
}

/**
 * Walks a stair chain downward one single-voxel riser at a time, starting
 * from a candidate top tread immediately outside a deck's edge (same y as
 * the deck itself — see `deriveStairLinks`'s doc comment for why the top
 * tread always lands flush with the deck). At each hop, the 3 neighbors other
 * than the one just arrived from are checked for the next tread one row
 * down; the walk only counts as a real, complete stair if it terminates on a
 * genuine ground-level sidewalk/gravel cell (`sidewalk[...] === 1` at
 * `groundY`) — a chain that dead-ends (no neighbor continues it, e.g. a
 * building's interior floor slab, which never keeps dropping one adjacent
 * riser at a time all the way to real sidewalk) or exceeds
 * `MAX_STAIR_RISERS` is discarded (`null`), not treated as a shorter stair.
 *
 * Returns the full chain from the top tread down to (and including) the
 * ground landing cell, in that descending order.
 */
function traceStairDown(
  world: World,
  grid: Pick<NavGrid, 'width' | 'depth' | 'groundY' | 'sidewalk'>,
  topX: number,
  topY: number,
  topZ: number,
  cameFromX: number,
  cameFromZ: number,
): Array<{ x: number; y: number; z: number }> | null {
  const chain: Array<{ x: number; y: number; z: number }> = [{ x: topX, y: topY, z: topZ }];
  let x = topX;
  let y = topY;
  let z = topZ;
  let prevX = cameFromX;
  let prevZ = cameFromZ;

  while (chain.length <= MAX_STAIR_RISERS) {
    let advanced = false;

    for (const [dx, dz] of STAIR_NEIGHBOR_OFFSETS) {
      const nx = x + dx;
      const nz = z + dz;
      if (nx === prevX && nz === prevZ) continue; // never step back the way we just came

      const ny = y - 1;
      if (ny === grid.groundY && inBounds(grid, nx, nz) && grid.sidewalk[cellIndex(grid.width, nx, nz)] === 1) {
        chain.push({ x: nx, y: ny, z: nz });
        return chain; // reached a genuine ground landing -- complete stair
      }
      if (isStairTread(world, nx, ny, nz)) {
        chain.push({ x: nx, y: ny, z: nz });
        prevX = x;
        prevZ = z;
        x = nx;
        y = ny;
        z = nz;
        advanced = true;
        break;
      }
    }

    if (!advanced) return null; // dead end -- not a real ground-connected stair
  }
  return null; // too long to be a real stair -- treat as malformed rather than risk an unbounded walk
}

/**
 * Derives every ground<->deck stair connection in `world`, purely from
 * voxel geometry (same rebuild/import-safe convention as
 * `buildElevatedLevel` — no dependency on `GenerationResult`'s
 * `walkways`/`stairShafts` plans, which don't survive a `.vxc` import).
 *
 * For every elevated deck cell's 4 neighbors that are NOT themselves part of
 * the deck, a neighbor is a stair's top tread if it's a `isStairTread` cell
 * at the *same* y as the deck (both `writeSteps`' walkway run and its spiral
 * shaft run always place their very last riser at `topY === level`, flush
 * with the deck it leads to — one continuous climb, not a separate final
 * hop). From there, `traceStairDown` walks the chain back to a real ground
 * landing; only completed chains become a `StairLink`.
 */
function deriveStairLinks(world: World, grid: Pick<NavGrid, 'width' | 'depth' | 'groundY' | 'sidewalk' | 'elevatedLevels'>): StairLink[] {
  const links: StairLink[] = [];
  const seenTreads = new Set<string>();

  for (const level of grid.elevatedLevels) {
    for (const cell of level.cells) {
      for (const [dx, dz] of STAIR_NEIGHBOR_OFFSETS) {
        const nx = cell.x + dx;
        const nz = cell.z + dz;
        if (inBounds(grid, nx, nz) && level.walkable[cellIndex(grid.width, nx, nz)] === 1) continue; // still on the deck itself
        if (!isStairTread(world, nx, level.y, nz)) continue;

        const key = `${level.y},${nx},${nz}`;
        if (seenTreads.has(key)) continue;
        seenTreads.add(key);

        const descending = traceStairDown(world, grid, nx, level.y, nz, cell.x, cell.z);
        if (!descending) continue;

        const steps = [{ x: cell.x, y: level.y, z: cell.z }, ...descending].reverse();
        links.push({ levelY: level.y, steps });
      }
    }
  }

  return links;
}

/**
 * Scans `world`'s ground-surface row (`groundY`) over a `width` x `depth`
 * footprint into sidewalk/road boolean grids plus a road flow field, then
 * scans every known elevated deck row (`ELEVATED_DECK_LEVELS`) the same way
 * (see `buildElevatedLevel`). A ground surface block only counts as
 * walkable/drivable if the voxel directly above it is AIR (headroom
 * clearance) — keeps entities out of columns a building has since grown
 * into. SIDEWALK and GRAVEL (park paths) both count as walkable ground —
 * pedestrians don't distinguish a park's gravel cross from a street
 * sidewalk, just "not a road, not grass."
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
      if (surfaceId === SIDEWALK || surfaceId === GRAVEL) sidewalk[i] = 1;
      else if (surfaceId === ASPHALT) road[i] = 1;
    }
  }

  const { flowX, flowZ } = computeFlowField(road, width, depth);
  const elevatedLevels = ELEVATED_DECK_LEVELS.map((y) => buildElevatedLevel(world, width, depth, y)).filter(
    (level) => level.walkable.some((cell) => cell === 1),
  );
  const stairLinks = deriveStairLinks(world, { width, depth, groundY, sidewalk, elevatedLevels });
  return { width, depth, groundY, sidewalk, road, flowX, flowZ, elevatedLevels, stairLinks };
}
