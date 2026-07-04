/**
 * Pedestrian NPC simulation: cell-to-cell walking along the sidewalk grid.
 * Pure state + step function, no Three.js — `EntitySystem` drives this and
 * hands the result to the presentation layer (`engine/EntityRenderer`).
 */

import { isWalkableSurfaceCell, type NavGrid } from './NavGrid';
import type { Rng } from '../gen/rng';

export interface Pedestrian {
  /** Continuous world position, mid-stride between cell centers. */
  x: number;
  z: number;
  /** The sidewalk/deck cell this pedestrian is currently walking towards. */
  cellX: number;
  cellZ: number;
  /**
   * The surface Y this pedestrian's feet rest on: `grid.groundY` for a
   * sidewalk/park-path walker, or one of `grid.elevatedLevels[].y` for a
   * skybridge/walkway walker. Fixed for the pedestrian's whole lifetime —
   * elevated NPCs are deck-bound by design (see `NavGrid`'s doc comment):
   * they walk their one deck back and forth and never path down to the
   * street, which keeps the nav model a flat per-level grid instead of a
   * full 3D graph with stairs.
   */
  y: number;
  /** Current heading: one of -1/0/1 per axis, at most one axis nonzero. Zero,zero only at the instant of spawn. */
  dirX: number;
  dirZ: number;
  speed: number;
  /** False once the pedestrian has nowhere left to go (isolated cell, or its cell stopped being walkable) — the simulation removes it next tick. */
  alive: boolean;
}

/** Distance below which a pedestrian is considered to have arrived at its target cell's center. */
const ARRIVE_EPS = 0.02;

/** Chance to take an available turn instead of continuing straight when both are on offer — keeps foot traffic from reading as a bunch of NPCs walking in dead-straight lines forever. */
const TURN_CHANCE_AT_INTERSECTION = 0.35;

const NEIGHBOR_DIRS: readonly [number, number][] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/** Spawns a pedestrian already centered on (cellX, cellZ) at surface `y` — its first `step` will immediately pick a real heading. */
export function createPedestrianAt(cellX: number, cellZ: number, y: number, speed: number): Pedestrian {
  return {
    x: cellX + 0.5,
    z: cellZ + 0.5,
    cellX,
    cellZ,
    y,
    dirX: 0,
    dirZ: 0,
    speed,
    alive: true,
  };
}

function chooseNextCell(ped: Pedestrian, grid: NavGrid, rng: Rng): void {
  const candidates = NEIGHBOR_DIRS.filter(([dx, dz]) => isWalkableSurfaceCell(grid, ped.y, ped.cellX + dx, ped.cellZ + dz));
  if (candidates.length === 0) {
    ped.alive = false;
    return;
  }

  const isReverse = ([dx, dz]: readonly [number, number]): boolean => dx === -ped.dirX && dz === -ped.dirZ;
  const nonReverse = candidates.filter((d) => !isReverse(d));

  let choice: readonly [number, number];
  if (nonReverse.length === 0) {
    // Dead end: reversing is the only option.
    choice = candidates[0] as [number, number];
  } else {
    const straight = nonReverse.find(([dx, dz]) => dx === ped.dirX && dz === ped.dirZ);
    if (straight && (nonReverse.length === 1 || !rng.chance(TURN_CHANCE_AT_INTERSECTION))) {
      choice = straight;
    } else {
      const turnOptions = straight ? nonReverse.filter((d) => d !== straight) : nonReverse;
      choice = rng.pick(turnOptions.length > 0 ? turnOptions : nonReverse);
    }
  }

  ped.dirX = choice[0];
  ped.dirZ = choice[1];
  ped.cellX += choice[0];
  ped.cellZ += choice[1];
}

/** Advances a pedestrian by `dt` seconds: walks toward its current target cell center, picking a new one on arrival. */
export function stepPedestrian(ped: Pedestrian, dt: number, grid: NavGrid, rng: Rng): void {
  if (!ped.alive) return;

  // Its own current cell may have stopped being walkable since it was chosen
  // (a rebuilt NavGrid whose deck/sidewalk shrank underneath it — see
  // `Pedestrian.y`'s doc comment). Catching that here, rather than only when
  // `chooseNextCell` next runs out of candidates, is what keeps a pedestrian
  // from lingering mid-air over a since-removed deck cell.
  if (!isWalkableSurfaceCell(grid, ped.y, ped.cellX, ped.cellZ)) {
    ped.alive = false;
    return;
  }

  const targetX = ped.cellX + 0.5;
  const targetZ = ped.cellZ + 0.5;
  const toX = targetX - ped.x;
  const toZ = targetZ - ped.z;
  const dist = Math.hypot(toX, toZ);

  if (dist < ARRIVE_EPS) {
    ped.x = targetX;
    ped.z = targetZ;
    chooseNextCell(ped, grid, rng);
    return;
  }

  const step = Math.min(dist, ped.speed * dt);
  ped.x += (toX / dist) * step;
  ped.z += (toZ / dist) * step;
}
