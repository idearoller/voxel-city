/**
 * Spawn/despawn placement logic, shared by pedestrians and vehicles: pick a
 * walkable/drivable cell in an annulus around the player (never inside the
 * min radius, so nothing pops into view right in front of the camera), and
 * decide when an entity has wandered far enough away to despawn. Pure,
 * seeded-RNG-driven — no Three.js.
 */

import type { NavGrid } from './NavGrid';
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
  const perLevelCandidates = grid.elevatedLevels.map((level) =>
    level.cells.filter((cell) =>
      isElevatedSpawnDistanceOk(cell.x, cell.z, playerX, playerZ, minRadius, maxRadius, level.y, playerY),
    ),
  );
  const totalCandidates = perLevelCandidates.reduce((sum, cells) => sum + cells.length, 0);
  if (totalCandidates === 0) return null; // no deck reachable near the player right now

  if (rng.float(0, 1) >= maxElevatedShare) return null;

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
