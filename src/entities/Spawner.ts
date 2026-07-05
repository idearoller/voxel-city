/**
 * Spawn/despawn placement logic, shared by pedestrians and vehicles: pick a
 * walkable/drivable cell in an annulus around the player (never inside the
 * min radius, so nothing pops into view right in front of the camera), and
 * decide when an entity has wandered far enough away to despawn. Pure,
 * seeded-RNG-driven — no Three.js.
 */

import type { NavGrid } from './NavGrid';
import type { SkyLane } from './SkyLane';
import type { Rng } from '../gen/rng';

const TWO_PI = Math.PI * 2;
const DEFAULT_MAX_ATTEMPTS = 24;
/** Elevated decks never claim more than this share of new pedestrian spawns, even when a deck is available right next to the player — keeps the street level from emptying out. */
const DEFAULT_MAX_ELEVATED_SHARE = 0.3;
/**
 * Per unit of altitude difference from the player, how much extra horizontal
 * distance an elevated spawn cell must clear beyond `minRadius` (see
 * `pickElevatedSpawnCell`'s doc comment) — an elevated pedestrian is more
 * visually prominent (silhouetted, overhead) than a ground one at the same
 * horizontal distance, so it needs proportionally more horizontal room to
 * still read as "not popping in right in front of the camera."
 */
const VERTICAL_MIN_RADIUS_WEIGHT = 1;

export type CellPredicate = (grid: NavGrid, x: number, z: number) => boolean;

/**
 * Tries up to `maxAttempts` random points in the [minRadius, maxRadius)
 * annulus around (playerX, playerZ), returning the first one satisfying
 * `isWalkable`, or null if none of the attempts landed on a valid cell.
 */
export function pickSpawnCell(
  grid: NavGrid,
  isWalkable: CellPredicate,
  playerX: number,
  playerZ: number,
  minRadius: number,
  maxRadius: number,
  rng: Rng,
  maxAttempts: number = DEFAULT_MAX_ATTEMPTS,
): { x: number; z: number } | null {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const angle = rng.float(0, TWO_PI);
    const radius = rng.float(minRadius, maxRadius);
    const x = Math.floor(playerX + Math.cos(angle) * radius);
    const z = Math.floor(playerZ + Math.sin(angle) * radius);
    if (x < 0 || x >= grid.width || z < 0 || z >= grid.depth) continue;
    if (isWalkable(grid, x, z)) return { x, z };
  }
  return null;
}

/**
 * True if (x, z) is far enough from the player to spawn on, given a deck at
 * `levelY` while the player is at `playerY`. The horizontal-only floor
 * (`minRadius`) grows by `VERTICAL_MIN_RADIUS_WEIGHT` per unit of altitude
 * difference — see `pickElevatedSpawnCell`'s doc comment for why a bare
 * horizontal check isn't enough on its own for elevated cells. `maxRadius`
 * is still checked against horizontal distance alone: it exists to bound how
 * far away a spawn can be (render/interest range), not how prominent it is,
 * so altitude doesn't need to inflate it too.
 */
function isElevatedSpawnDistanceOk(
  x: number,
  z: number,
  playerX: number,
  playerZ: number,
  minRadius: number,
  maxRadius: number,
  levelY: number,
  playerY: number,
): boolean {
  const dx = x - playerX;
  const dz = z - playerZ;
  const horizontalDistSq = dx * dx + dz * dz;
  if (horizontalDistSq >= maxRadius * maxRadius) return false;

  const effectiveMinRadius = minRadius + VERTICAL_MIN_RADIUS_WEIGHT * Math.abs(levelY - playerY);
  return horizontalDistSq >= effectiveMinRadius * effectiveMinRadius;
}

/**
 * Bucket edge length (world units) for the spatial index built by
 * `getElevatedSpatialIndex`. Chosen so a typical spawn-radius query
 * (`spawnMaxRadius`, ~90) only ever touches a handful of buckets per axis,
 * while a bucket's own cell count stays small even for a citywide
 * tower-lobby flood (`NavGrid.deriveTowerLobbyCells` budgets up to 20,000
 * cells per tower) — neither dimension of the query cost grows with city
 * size.
 */
const ELEVATED_BUCKET_SIZE = 32;

/** One elevated level's cells, spatially bucketed for range queries — see `getElevatedSpatialIndex`. */
interface ElevatedLevelIndex {
  readonly y: number;
  readonly buckets: ReadonlyMap<string, ReadonlyArray<{ readonly x: number; readonly z: number }>>;
}

function bucketKey(bx: number, bz: number): string {
  return `${bx},${bz}`;
}

function buildElevatedLevelIndex(level: { y: number; cells: ReadonlyArray<{ x: number; z: number }> }): ElevatedLevelIndex {
  const buckets = new Map<string, Array<{ x: number; z: number }>>();
  for (const cell of level.cells) {
    const key = bucketKey(Math.floor(cell.x / ELEVATED_BUCKET_SIZE), Math.floor(cell.z / ELEVATED_BUCKET_SIZE));
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = [];
      buckets.set(key, bucket);
    }
    bucket.push(cell);
  }
  return { y: level.y, buckets };
}

/**
 * Lazily built, cached-per-`NavGrid`-instance spatial index over
 * `grid.elevatedLevels`' own cell lists, keyed by object identity — a fresh
 * `NavGrid` (city regen or `.vxc` import) always misses and rebuilds; a
 * `NavGrid` is never mutated in place after `buildNavGrid` returns it, so a
 * cache hit is never stale. Building it costs one pass over every elevated
 * cell citywide, exactly once per city, in exchange for spawn attempts never
 * re-scanning that same full cell list (see `pickElevatedSpawnCell`'s doc
 * comment for the citywide-scan cost this replaces).
 */
const elevatedIndexCache = new WeakMap<NavGrid, readonly ElevatedLevelIndex[]>();

function getElevatedSpatialIndex(grid: NavGrid): readonly ElevatedLevelIndex[] {
  let index = elevatedIndexCache.get(grid);
  if (!index) {
    index = grid.elevatedLevels.map(buildElevatedLevelIndex);
    elevatedIndexCache.set(grid, index);
  }
  return index;
}

function queryBucketedCellsNear(
  index: ElevatedLevelIndex,
  centerX: number,
  centerZ: number,
  radius: number,
): ReadonlyArray<{ readonly x: number; readonly z: number }> {
  const minBx = Math.floor((centerX - radius) / ELEVATED_BUCKET_SIZE);
  const maxBx = Math.floor((centerX + radius) / ELEVATED_BUCKET_SIZE);
  const minBz = Math.floor((centerZ - radius) / ELEVATED_BUCKET_SIZE);
  const maxBz = Math.floor((centerZ + radius) / ELEVATED_BUCKET_SIZE);

  const result: Array<{ x: number; z: number }> = [];
  for (let bx = minBx; bx <= maxBx; bx++) {
    for (let bz = minBz; bz <= maxBz; bz++) {
      const bucket = index.buckets.get(bucketKey(bx, bz));
      if (bucket) result.push(...bucket);
    }
  }
  return result;
}

/**
 * Every elevated cell across all of `grid.elevatedLevels` whose bucket falls
 * within `radius` of (centerX, centerZ), tagged with which level it came
 * from (`levelIndex`, matching `grid.elevatedLevels`' own order) — a
 * superset of the cells actually within `radius` (whole buckets are
 * included, not clipped to the circle), narrowed further by
 * `isElevatedSpawnDistanceOk`. Exported so its boundedness is directly
 * testable: for a `NavGrid` with its elevated cells spread across a wide
 * map, this returns a small, `radius`-bounded subset, not the level's full
 * cell list, no matter how large that list is — the fix for the citywide
 * per-tick scan `pickElevatedSpawnCell` used to run (see its own doc
 * comment).
 */
export function elevatedCellsNear(
  grid: NavGrid,
  centerX: number,
  centerZ: number,
  radius: number,
): ReadonlyArray<{ readonly x: number; readonly z: number; readonly levelIndex: number }> {
  const index = getElevatedSpatialIndex(grid);
  const result: Array<{ x: number; z: number; levelIndex: number }> = [];
  for (let i = 0; i < index.length; i++) {
    const levelIndex = index[i] as ElevatedLevelIndex;
    for (const cell of queryBucketedCellsNear(levelIndex, centerX, centerZ, radius)) {
      result.push({ x: cell.x, z: cell.z, levelIndex: i });
    }
  }
  return result;
}

/**
 * Picks a spawn cell for an elevated pedestrian directly from the walkable
 * decks' own (precomputed) cell lists, filtered to the ones currently within
 * spawn range of the player, or `null` if none qualify (no deck reachable
 * right now, or the elevated roll missed) — callers should fall back to a
 * normal ground `pickSpawnCell` on `null` so a miss here never leaves a
 * spawn tick doing nothing.
 *
 * Two things `pickPedestrianLevel` (this function's predecessor) got wrong,
 * found by walking real generated cities rather than synthetic fixtures:
 *
 * 1. Rejection-sampling a random annulus point against a citywide grid (the
 *    same trick `pickSpawnCell` uses for sidewalk/road, which are a sizeable
 *    fraction of the map) fails almost every attempt against a target that's
 *    routinely under 1% of the map's area — real cities measured 2.5-9.2%
 *    *realized* elevated share against a nominal 30% roll when a deck was
 *    right next to the player, and 0% (every roll wasted, no ground
 *    fallback) once the nearest deck was far outside the annulus. Sampling
 *    directly from each level's own `cells` list (see `NavGrid.ElevatedLevel`)
 *    makes a hit deterministic whenever a deck cell is in range at all, and
 *    an out-of-range deck cleanly reports "no candidates" so the caller can
 *    fall back to ground instead of dropping the spawn tick.
 * 2. A horizontal-only annulus check lets a deck almost directly overhead
 *    (small horizontal offset, large altitude offset) spawn a pedestrian
 *    that pops in "in plain sight" at a steep, prominent viewing angle —
 *    `isElevatedSpawnDistanceOk` grows the effective minimum horizontal
 *    distance with altitude difference to compensate.
 *
 * The elevated-share roll happens *before* any per-level cell data is
 * touched, and the candidates actually scanned come from the spatial index
 * above rather than each level's full `cells` list — a citywide scan (every
 * elevated cell in the city, up to 20,000+ per tower-lobby-flooded tower)
 * used to run on *every* spawn attempt, including the ~70% of attempts
 * (at the default `maxElevatedShare`) where the roll misses and the whole
 * scan is thrown away unused. See `PERF.md`.
 */
export function pickElevatedSpawnCell(
  grid: NavGrid,
  playerX: number,
  playerY: number,
  playerZ: number,
  minRadius: number,
  maxRadius: number,
  rng: Rng,
  maxElevatedShare: number = DEFAULT_MAX_ELEVATED_SHARE,
): { x: number; z: number; y: number } | null {
  if (rng.float(0, 1) >= maxElevatedShare) return null;

  const perLevelCandidates: Array<Array<{ x: number; z: number }>> = grid.elevatedLevels.map(() => []);
  for (const cell of elevatedCellsNear(grid, playerX, playerZ, maxRadius)) {
    (perLevelCandidates[cell.levelIndex] as Array<{ x: number; z: number }>).push(cell);
  }
  for (let i = 0; i < perLevelCandidates.length; i++) {
    const level = grid.elevatedLevels[i] as (typeof grid.elevatedLevels)[number];
    perLevelCandidates[i] = (perLevelCandidates[i] as Array<{ x: number; z: number }>).filter((cell) =>
      isElevatedSpawnDistanceOk(cell.x, cell.z, playerX, playerZ, minRadius, maxRadius, level.y, playerY),
    );
  }
  const totalCandidates = perLevelCandidates.reduce((sum, cells) => sum + cells.length, 0);
  if (totalCandidates === 0) return null; // no deck reachable near the player right now

  const roll = rng.float(0, totalCandidates);
  let cumulative = 0;
  for (let i = 0; i < perLevelCandidates.length; i++) {
    const candidates = perLevelCandidates[i] as Array<{ x: number; z: number }>;
    cumulative += candidates.length;
    if (roll < cumulative) {
      const cell = candidates[Math.floor(rng.float(0, candidates.length))] as { x: number; z: number };
      return { x: cell.x, z: cell.z, y: (grid.elevatedLevels[i] as (typeof grid.elevatedLevels)[number]).y };
    }
  }
  return null;
}

/**
 * Picks a spawn for a flying vehicle: a uniformly random lane, then a
 * uniformly random point along that lane's travel-axis range, retried up to
 * `maxAttempts` times until the resulting world position falls in the
 * [minRadius, maxRadius) annulus around the player (2D, ignoring altitude —
 * see `EntitySimulationConfig`'s doc comment for why flying-vehicle spawn
 * distance deliberately reuses the ground annulus rather than growing with
 * altitude the way `pickElevatedSpawnCell` does). Returns `null` if no
 * attempt lands in range (e.g. no lane currently passes near the player) or
 * if `lanes` is empty.
 */
export function pickFlyingVehicleSpawn(
  lanes: readonly SkyLane[],
  playerX: number,
  playerZ: number,
  minRadius: number,
  maxRadius: number,
  rng: Rng,
  maxAttempts: number = DEFAULT_MAX_ATTEMPTS,
): { lane: SkyLane; travelCoord: number; direction: 1 | -1 } | null {
  if (lanes.length === 0) return null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const lane = rng.pick(lanes);
    const travelCoord = rng.float(lane.start, lane.end);
    const x = lane.axis === 'x' ? travelCoord : lane.fixed;
    const z = lane.axis === 'z' ? travelCoord : lane.fixed;

    const dx = x - playerX;
    const dz = z - playerZ;
    const distSq = dx * dx + dz * dz;
    if (distSq < minRadius * minRadius || distSq >= maxRadius * maxRadius) continue;

    const direction: 1 | -1 = rng.chance(0.5) ? 1 : -1;
    return { lane, travelCoord, direction };
  }
  return null;
}

/**
 * True if (x, z) is at least `minGap` away from every position in
 * `occupied` — used to keep a newly-spawned vehicle from popping into
 * existence overlapping one already there. Deliberately a plain 2D distance
 * check against *every* existing vehicle, not just same-lane ones: at spawn
 * time a ground vehicle doesn't have a heading yet (see `Vehicle.ts`'s
 * `createVehicleAt`) and a flying vehicle's direction is only decided the
 * same instant it's placed, so there's no lane identity yet to filter
 * by — a citywide "nothing else is this close" check is the simplest thing
 * that's still always safe, and at this population size (dozens, not
 * thousands) an O(n) scan per spawn attempt is negligible.
 */
export function isSpawnClearOfVehicles(
  x: number,
  z: number,
  occupied: readonly { x: number; z: number }[],
  minGap: number,
): boolean {
  const minGapSq = minGap * minGap;
  for (const vehicle of occupied) {
    const dx = x - vehicle.x;
    const dz = z - vehicle.z;
    if (dx * dx + dz * dz < minGapSq) return false;
  }
  return true;
}

/** True once (entityX, entityZ) is farther than `despawnRadius` from the player — the entity should be removed. */
export function isBeyondDespawnRadius(
  entityX: number,
  entityZ: number,
  playerX: number,
  playerZ: number,
  despawnRadius: number,
): boolean {
  const dx = entityX - playerX;
  const dz = entityZ - playerZ;
  return dx * dx + dz * dz > despawnRadius * despawnRadius;
}
