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

// ---------------------------------------------------------------------------
// Tower-internal sky-lobby floors (ground <-> SKY_LEVELS via a tower's own
// spiral stair shaft — see `infrastructure.ts`'s `planStairShafts`/
// `planSkyLobbies`).
//
// This was deferred in an earlier phase because recognizing a sky-lobby
// *floor* citywide, the same way `buildElevatedLevel` recognizes a bridge
// deck (a material + headroom + "floats over open air" shape), doesn't work:
// a lobby floor is CONCRETE, same as a roof slab, a setback terrace deck, and
// every ordinary building floor `writeSetbackDecks` caps a tier with — none
// of that is distinguishable from a genuine lobby by local block shape alone
// (unlike a bridge deck's METAL, which nothing else in the city writes at
// deck height). Scanning every CONCRETE-with-headroom cell at a `SKY_LEVELS`
// row citywide and calling all of it "walkable" would light up every
// setback terrace in the city as a pedestrian deck, most of which were never
// meant to be one.
//
// The way out: never classify a floor in isolation. Only ever treat a patch
// of floor as walkable *because* it's touching a stair tread this module has
// already, independently, proven connects all the way down to real street
// sidewalk (`traceStairDown` — the exact same proof `deriveStairLinks` uses
// for external walkway stairs). A tower's own spiral shaft
// (`infrastructure.ts`'s `STAIR_SPIRAL_RING`) is built from the same
// CONCRETE-tread-plus-headroom voxel shape as a straight walkway stair, so
// `isStairTread`/`traceStairDown` already know how to walk it — they just
// need a starting point, which `buildElevatedLevel`'s METAL-only scan never
// hands them for a tower (a lobby floor is CONCRETE, not METAL).
// `findVerifiedStairTopAnchors` supplies that starting point directly: scan
// each known `SKY_LEVELS` row (bounded, same "known rows only" discipline as
// `ELEVATED_DECK_LEVELS`) for stair-tread-shaped cells, and keep only the
// ones `traceStairDown` can actually walk down to genuine sidewalk. Ordinary
// floor cells (the vast majority of any `isStairTread`-shaped candidate at a
// sky-lobby's own height, since most indoor ceilings clear 2 voxels) fail
// that proof in their very first hop — a flat floor's neighbors never drop
// exactly one riser per step towards the ground the way a real staircase's
// do (`isStairTread`'s own doc comment) — so they're rejected as cheaply as
// `deriveStairLinks` already rejects them for the external-stair case.
//
// Once a real stair top is proven, `deriveTowerLobbyCells` floods outward
// from its immediate neighbors (each anchor's flood bounded by its own
// `MAX_LOBBY_FLOOD_CELLS_PER_TOWER` budget — see that constant's doc comment
// for why this must be per-tower rather than one counter shared across every
// tower at a row, and naturally bounded again by the tower's own walls — a
// lobby floor's perimeter is solid wall material, not CONCRETE, so the flood
// can't escape into another building or out over open air) using the same
// solid-plus-headroom shape a lobby floor actually has. This never
// classifies a floor citywide — it only ever explores outward from a proven
// stair connection, so a setback terrace with no bridge/stair of its own is
// never touched, no matter what shape its floor has.

/**
 * Hard ceiling on how many cells a *single connected flood component* may
 * claim before it's cut short — generously above any real tower footprint
 * (`BRIDGE_MIN_TOWER_FOOTPRINT` and up, i.e. well under 200x200), the same
 * defensive-not-load-bearing role `MAX_STAIR_RISERS` plays for a stair
 * chain. This is a *per-tower* budget, not a citywide one: `deriveTowerLobbyCells`
 * gives every distinct component (one per tower's lobby — see that
 * function's doc comment for why a tower with several bridge levels still
 * only ever floods its shared lobby footprint once) its own fresh counter.
 * A single shared counter across every tower at a `SKY_LEVELS` row was an
 * earlier, real bug here: with several dozen towers flooding in the same
 * pass, one shared budget got exhausted well before every tower's own
 * (small) lobby was fully covered, truncating whichever ring of each lobby
 * happened to be reached last — almost always the outer ring nearest the
 * bridge doorway, since the flood starts at the stair (typically
 * tower-centered) and works outward. That silently walled pedestrians into
 * an enclosed inner lobby with no path to the very bridge this feature
 * exists to feed traffic to (caught on a review sweep: ~11/24-18/24 stair
 * tops per seed couldn't reach their own bridge span with the shared 4000
 * cap, vs. effectively 100% once the budget was made per-tower).
 */
const MAX_LOBBY_FLOOD_CELLS_PER_TOWER = 20_000;

/**
 * True if (x, y, z) has the shape a walkable interior floor needs: solid
 * CONCRETE with 2 clear voxels of standing headroom above (same clearance
 * `isStairTread` requires of a riser, since both are "somewhere a pedestrian
 * stands"). Unlike `buildElevatedLevel`'s bridge/walkway check, there's no
 * "AIR below" requirement — a floating deck needs that to rule out a
 * parapet sitting on a solid roof, but an ordinary interior floor is
 * *supposed* to have solid structure beneath it (another tier's setback
 * deck, most commonly), so requiring open air below would wrongly exclude
 * genuine lobby floor rather than rule out a false positive. This shape
 * alone still isn't unique to a lobby (see this section's doc comment) —
 * callers only ever use it seeded from an already-proven stair connection,
 * never as a standalone citywide classifier.
 */
function isLobbyFloorCell(world: World, x: number, y: number, z: number): boolean {
  return world.getBlock(x, y, z) === CONCRETE && world.getBlock(x, y + 1, z) === AIR && world.getBlock(x, y + 2, z) === AIR;
}

/**
 * Every (x, z) at row `y` that is a real, ground-connected stair's top
 * tread — an `isStairTread` cell whose descending chain (`traceStairDown`,
 * called with the candidate itself as `cameFrom` so all 4 neighbors are
 * eligible for the first hop, since there's no known "arrived from" deck
 * cell the way an external walkway stair has one) actually reaches genuine
 * sidewalk. Most candidates at a real sky-lobby's height are ordinary floor,
 * not a stair top, and are rejected in their very first hop (see this
 * section's doc comment) — cheap enough to scan every cell of a known row,
 * same order of cost as `buildElevatedLevel`'s own per-row scan.
 *
 * A real lobby has a second, more subtle way to produce a *spurious* extra
 * candidate here, not just an outright false one: `planSkyLobbies` leaves a
 * handful of columns just below the true top tread uncovered by the floor
 * slab (`SkyLobby.openColumns`, for the riser headroom just beneath them —
 * see `infrastructure.ts`'s doc comment for exactly which ones and why).
 * The ordinary lobby floor cells *just outside* the shaft, orthogonally
 * touching one of those open columns, still pass `isStairTread` themselves
 * (same solid-plus-headroom shape as any lobby floor) and their descent
 * succeeds immediately by stepping onto that open column's own riser one
 * row down — a real, continuing tread, just not the one this candidate was
 * actually "meant" to be. Rather than trying to tell a genuine top tread
 * apart from this lookalike by local shape (which is exactly the
 * unreliable, deferred approach this whole section avoids), every candidate
 * that merges into the *same* downward chain is deduped here, keyed by the
 * first real riser its descent actually lands on — keeping only one
 * candidate per distinct chain, so a lobby's own floor never loses more
 * than the genuine top tread to the exclusion set in `deriveTowerLobbyCells`.
 */
function findVerifiedStairTopAnchors(
  world: World,
  grid: Pick<NavGrid, 'width' | 'depth' | 'groundY' | 'sidewalk'>,
  y: number,
): Array<{ x: number; z: number }> {
  const seenChains = new Set<string>();
  const anchors: Array<{ x: number; z: number }> = [];
  for (let x = 0; x < grid.width; x++) {
    for (let z = 0; z < grid.depth; z++) {
      if (!isStairTread(world, x, y, z)) continue;
      const chain = traceStairDown(world, grid, x, y, z, x, z);
      if (!chain) continue;

      // `chain[0]` is the candidate itself; `chain[1]` (guaranteed to exist —
      // a successful chain always has at least a ground-landing hop past the
      // starting tread) is the first real riser it actually lands on. Two
      // candidates sharing that cell are the same underlying shaft entry.
      const firstRiser = chain[1] as { x: number; y: number; z: number };
      const chainKey = `${firstRiser.x},${firstRiser.y},${firstRiser.z}`;
      if (seenChains.has(chainKey)) continue;
      seenChains.add(chainKey);

      anchors.push({ x, z });
    }
  }
  return anchors;
}

/**
 * Every walkable sky-lobby floor cell at row `y`, found by flooding outward
 * from the neighbors of every real, proven stair top at that row
 * (`findVerifiedStairTopAnchors`) — never from an un-anchored cell. A
 * verified stair top's own (x, z) is excluded from every flood (`excluded`),
 * the same way `deriveStairLinks`' top tread is deliberately left out of
 * `ElevatedLevel.walkable` for the external-stair case: it stays a *stair*
 * cell, one flat lateral hop short of "on the deck", so `deriveStairLinks`'
 * own neighbor scan (unmodified — see `buildNavGrid`) still finds it as a
 * non-walkable neighbor of the lobby floor this function returns, and
 * builds the connecting `StairLink` for it exactly the way it already does
 * for a walkway.
 *
 * Each anchor gets its *own* bounded flood (`MAX_LOBBY_FLOOD_CELLS_PER_TOWER`)
 * rather than sharing one budget across every anchor at this row — a
 * citywide row can have several dozen towers' worth of anchors, and a
 * shared counter starves whichever tower's lobby happens to be flooded
 * last, truncating it well short of its own real footprint (see that
 * constant's doc comment for the concrete regression this caused: nearly
 * half of stair tops across a real seed sweep couldn't reach their own
 * bridge doorway). `globallyVisited` still spans every anchor at this row,
 * not just the current one — a tower with bridges at multiple levels shares
 * one lobby floor per level, and (rarely) a tower's own dedup in
 * `findVerifiedStairTopAnchors` can still leave two anchors bordering the
 * exact same floor component; the second one's flood is skipped entirely
 * (all its neighbor seeds already visited) rather than needlessly re-walking
 * ground the first anchor's flood already covered.
 */
function deriveTowerLobbyCells(
  world: World,
  grid: Pick<NavGrid, 'width' | 'depth' | 'groundY' | 'sidewalk'>,
  y: number,
): Array<{ x: number; z: number }> {
  const anchors = findVerifiedStairTopAnchors(world, grid, y);
  if (anchors.length === 0) return [];

  const excluded = new Set(anchors.map((a) => `${a.x},${a.z}`));
  const globallyVisited = new Set<string>();
  const allCells: Array<{ x: number; z: number }> = [];

  for (const anchor of anchors) {
    const componentCells: Array<{ x: number; z: number }> = [];
    const queue: Array<{ x: number; z: number }> = [];

    const tryEnqueue = (x: number, z: number): void => {
      if (componentCells.length >= MAX_LOBBY_FLOOD_CELLS_PER_TOWER) return;
      const key = `${x},${z}`;
      if (globallyVisited.has(key) || excluded.has(key)) return;
      if (!inBounds(grid, x, z)) return;
      if (!isLobbyFloorCell(world, x, y, z)) return;
      globallyVisited.add(key);
      const cell = { x, z };
      componentCells.push(cell);
      queue.push(cell);
    };

    for (const [dx, dz] of STAIR_NEIGHBOR_OFFSETS) tryEnqueue(anchor.x + dx, anchor.z + dz);

    let head = 0;
    while (head < queue.length && componentCells.length < MAX_LOBBY_FLOOD_CELLS_PER_TOWER) {
      const cur = queue[head++] as { x: number; z: number };
      for (const [dx, dz] of STAIR_NEIGHBOR_OFFSETS) tryEnqueue(cur.x + dx, cur.z + dz);
    }

    for (const cell of componentCells) allCells.push(cell);
  }

  return allCells;
}

/** Builds a brand-new `ElevatedLevel` from a plain cell list — used when a `SKY_LEVELS` row has a tower lobby but no bridge deck of its own already scanned into `elevatedLevels` (should be rare in practice, since a lobby only exists alongside a bridge at that same level, but a level-agnostic merge shouldn't assume it). */
function buildLevelFromCells(width: number, depth: number, y: number, cells: ReadonlyArray<{ x: number; z: number }>): ElevatedLevel {
  const walkable = new Uint8Array(width * depth);
  for (const c of cells) walkable[cellIndex(width, c.x, c.z)] = 1;
  return { y, walkable, cells: cells.slice() };
}

/** Merges `lobbyCells` into a copy of `level` (deduping against cells already walkable, e.g. a bridge deck cell that happens to also satisfy the lobby shape). */
function mergeLobbyCellsIntoLevel(width: number, level: ElevatedLevel, lobbyCells: ReadonlyArray<{ x: number; z: number }>): ElevatedLevel {
  const walkable = level.walkable.slice();
  const cells = level.cells.slice();
  for (const c of lobbyCells) {
    const i = cellIndex(width, c.x, c.z);
    if (walkable[i] === 1) continue;
    walkable[i] = 1;
    cells.push(c);
  }
  return { y: level.y, walkable, cells };
}

/**
 * Extends `levels` (the METAL-only bridge/walkway scan from `buildElevatedLevel`)
 * with every tower's own sky-lobby floor, per `SKY_LEVELS` row (see this
 * section's doc comment). A level that already exists (the common case — a
 * lobby only exists alongside a bridge at that same level, so its deck is
 * already scanned in) gets its lobby cells merged in; the rare/defensive
 * case of a lobby row with no existing entry gets a fresh one.
 */
function augmentWithTowerLobbies(
  world: World,
  width: number,
  depth: number,
  grid: Pick<NavGrid, 'width' | 'depth' | 'groundY' | 'sidewalk'>,
  levels: readonly ElevatedLevel[],
): ElevatedLevel[] {
  let result = levels.slice();
  for (const y of SKY_LEVELS) {
    const lobbyCells = deriveTowerLobbyCells(world, grid, y);
    if (lobbyCells.length === 0) continue;

    const idx = result.findIndex((level) => level.y === y);
    if (idx === -1) {
      result.push(buildLevelFromCells(width, depth, y, lobbyCells));
    } else {
      result[idx] = mergeLobbyCellsIntoLevel(width, result[idx] as ElevatedLevel, lobbyCells);
    }
  }
  return result;
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
  const baseElevatedLevels = ELEVATED_DECK_LEVELS.map((y) => buildElevatedLevel(world, width, depth, y)).filter(
    (level) => level.walkable.some((cell) => cell === 1),
  );
  const elevatedLevels = augmentWithTowerLobbies(world, width, depth, { width, depth, groundY, sidewalk }, baseElevatedLevels);
  const stairLinks = deriveStairLinks(world, { width, depth, groundY, sidewalk, elevatedLevels });
  return { width, depth, groundY, sidewalk, road, flowX, flowZ, elevatedLevels, stairLinks };
}
