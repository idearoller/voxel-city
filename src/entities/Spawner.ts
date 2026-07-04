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
