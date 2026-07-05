/**
 * Pure destination-picking and step-forwarding for tour ("auto-walk NPC")
 * mode. Deliberately reuses `entities/Pedestrian`'s cell-to-cell wander +
 * stair-crossing step function rather than inventing a parallel path
 * planner: touring the city "like a pedestrian NPC" (the product spec's own
 * words) means exactly the same intersection-turn/dead-end-reversal/
 * stair-crossing behavior real pedestrians already have, already unit-tested
 * in Pedestrian.test.ts / StairPedestrian.test.ts / TowerStairPedestrian.test.ts.
 * This module only adds the two things a spawned-by-the-simulation pedestrian
 * never needs: picking a *starting* cell near an arbitrary world position
 * (mode entry, from wherever the player currently stands) and recovering
 * with a fresh random cell whenever the walker dies (an isolated cell with
 * no neighbors at all -- see `stepPedestrian`'s own doc comment), so touring
 * never permanently stalls.
 *
 * No Three.js dependency -- consumed by `player/TourController`, which owns
 * the camera and render-time interpolation.
 */

import {
  captureRenderPrevState,
  createPedestrianAt,
  snapRenderPrevIfTeleported,
  stepPedestrian,
  type Pedestrian,
} from '../entities/Pedestrian';
import { isSidewalkCell, type NavGrid } from '../entities/NavGrid';
import type { Rng } from '../gen/rng';

/** Walking pace for the tour NPC: the midpoint of `EntitySimulationConfig.pedestrianSpeedRange` ([1.0, 1.8]), so touring reads exactly like an ordinary pedestrian's gait, not a sprint or a crawl. */
export const TOUR_WALK_SPEED = 1.4;

/** How many outward rings `findNearestWalkableGroundCell` scans before giving up. */
const NEAREST_CELL_MAX_RADIUS = 64;

/** A tour walker is exactly a pedestrian's runtime state — see this module's doc comment for why. */
export type TourWalker = Pedestrian;

/** Spawns a tour walker centered on (cellX, cellZ) at ground level — thin, named re-export of `createPedestrianAt` so callers in `player/` never need to import an entity-shaped constructor directly. */
export function createTourWalker(cellX: number, cellZ: number, groundY: number, speed: number): TourWalker {
  return createPedestrianAt(cellX, cellZ, groundY, speed);
}

/**
 * Expanding-ring search (same technique as `gen/layout.ts`'s
 * `findGroundSpawnPoint`) for the closest ground-level sidewalk cell to
 * (x, z) — used to start touring from wherever the player currently stands,
 * rather than teleporting the walker across the map. Returns null if nothing
 * walkable is within `NEAREST_CELL_MAX_RADIUS` cells.
 */
export function findNearestWalkableGroundCell(grid: NavGrid, x: number, z: number): { x: number; z: number } | null {
  const centerX = Math.floor(x);
  const centerZ = Math.floor(z);

  for (let radius = 0; radius <= NEAREST_CELL_MAX_RADIUS; radius++) {
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dz = -radius; dz <= radius; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== radius) continue;
        const cx = centerX + dx;
        const cz = centerZ + dz;
        if (isSidewalkCell(grid, cx, cz)) return { x: cx, z: cz };
      }
    }
  }
  return null;
}

/**
 * Uniformly-random ground sidewalk cell anywhere on the map, or null if the
 * city has no walkable ground at all. Used both as `findNearestWalkableGroundCell`'s
 * fallback (nothing close enough) and to respawn the tour walker somewhere
 * fresh whenever it dies (see `stepTourWalker`) — either way, "somewhere
 * walkable" is all that's needed, since the walker itself picks its own
 * heading and destinations once it's standing on real sidewalk.
 *
 * Collects every walkable cell first rather than rejection-sampling random
 * (x, z) pairs against a bounded attempt count: sidewalk is a comparatively
 * thin fraction of a citywide grid (most of the footprint is buildings,
 * roads, or parks), so a fixed-attempt random guess can plausibly miss
 * every time on a sparse or oddly-shaped city -- exactly the "gets stuck"
 * failure mode this whole module exists to prevent. The scan costs one pass
 * over the grid (cheap relative to `buildNavGrid` itself, which already
 * scans every cell at every known deck row on every city
 * generation/import) and only runs on the rare events this is called for:
 * entering tour mode, and the walker dying on an isolated cell.
 */
export function pickRandomWalkableGroundCell(grid: NavGrid, rng: Rng): { x: number; z: number } | null {
  const candidates: Array<{ x: number; z: number }> = [];
  for (let x = 0; x < grid.width; x++) {
    for (let z = 0; z < grid.depth; z++) {
      if (isSidewalkCell(grid, x, z)) candidates.push({ x, z });
    }
  }
  return candidates.length === 0 ? null : rng.pick(candidates);
}

/**
 * Advances `walker` one fixed tick: captures its render-interpolation
 * snapshot, steps it (wander + stair-crossing, or dies if stranded), then
 * safety-nets against smearing a teleport-sized jump across a render frame —
 * the exact three-call sequence `EntitySimulation.update` already runs per
 * pedestrian, just for one independently-owned walker instead of the live
 * NPC population.
 */
export function stepTourWalker(walker: TourWalker, dt: number, grid: NavGrid, rng: Rng): void {
  captureRenderPrevState(walker);
  stepPedestrian(walker, dt, grid, rng);
  snapRenderPrevIfTeleported(walker, dt);
}
