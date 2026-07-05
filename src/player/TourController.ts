import * as THREE from 'three';
import type { NavGrid } from '../entities/NavGrid';
import { lerp } from '../entities/interpolation';
import { createRng, type Rng } from '../gen/rng';
import { EYE_HEIGHT } from './PlayController';
import {
  createTourWalker,
  findNearestWalkableGroundCell,
  pickRandomWalkableGroundCell,
  stepTourWalker,
  TOUR_WALK_SPEED,
  type TourWalker,
} from './TourWalker';

/** Supplies the current city's navigation grid, or null before any city exists (or after a rebuild is mid-flight) — mirrors `SupportProviderFn`'s "wired in by ModeManager, backed by a live system" shape (see `ModeManager.setSupportProvider`). */
export type NavGridProvider = () => NavGrid | null;

/**
 * Drives the camera in tour mode: an auto-walking pedestrian-like body on
 * the same `NavGrid` real pedestrians use (see `TourWalker.ts`), rendered
 * with the same previous/current-tick render-interpolation lerp
 * `EntityRenderer` uses for NPCs (see `entities/interpolation.ts`) — a tour
 * camera stepping at raw 60Hz sim positions would reproduce exactly the
 * judder that interpolation was just added to eliminate for pedestrians.
 *
 * Deliberately narrow: this only ever writes `camera.position`.
 * `LookControls` still owns the camera's rotation — mouse look keeps
 * working in tour mode because nothing here touches it — and WASD/jump/
 * sprint/editing are inert simply because `ModeManager.update` never routes
 * to `FlyController`/`PlayController` while in tour mode (see
 * `ModeManager.update`).
 */
export class TourController {
  private walker: TourWalker | null = null;
  private readonly rng: Rng = createRng('tour');

  constructor(
    private readonly camera: THREE.Camera,
    private readonly getNavGrid: NavGridProvider,
  ) {}

  /**
   * Starts (or restarts) touring from the nearest walkable ground cell to
   * (x, z) — normally the camera's own position at the moment the player
   * enters tour mode, so touring picks up from "roughly here" instead of
   * teleporting across the map. Falls back to any random walkable cell if
   * nothing is close enough, and leaves any previous walker in place
   * (rather than clearing it to nothing) if the current city has no
   * navigable ground at all — a defensive case that shouldn't arise in
   * practice, since a city is always generated before mode switching is
   * reachable at all.
   */
  start(x: number, z: number): void {
    const grid = this.getNavGrid();
    if (!grid) return;

    const cell = findNearestWalkableGroundCell(grid, x, z) ?? pickRandomWalkableGroundCell(grid, this.rng);
    if (!cell) return;

    this.walker = createTourWalker(cell.x, cell.z, grid.groundY, TOUR_WALK_SPEED);
  }

  /**
   * Fixed-tick simulation step. Respawns at a fresh random walkable cell
   * instead of leaving a dead walker in place — see `TourWalker.ts`'s doc
   * comment on why touring must never permanently stall.
   */
  update(dt: number): void {
    const grid = this.getNavGrid();
    if (!grid || !this.walker) return;

    stepTourWalker(this.walker, dt, grid, this.rng);

    if (!this.walker.alive) {
      const cell = pickRandomWalkableGroundCell(grid, this.rng);
      this.walker = cell ? createTourWalker(cell.x, cell.z, grid.groundY, TOUR_WALK_SPEED) : null;
    }
  }

  /**
   * Per-render-frame camera placement, interpolated between the walker's
   * previous and current fixed-tick position by `alpha` (see `Engine.ts`'s
   * doc comment on it) — a no-op until `start()` has produced a walker.
   */
  render(alpha: number): void {
    if (!this.walker) return;
    const x = lerp(this.walker.prevX, this.walker.x, alpha);
    const y = lerp(this.walker.prevY, this.walker.y, alpha);
    const z = lerp(this.walker.prevZ, this.walker.z, alpha);
    this.camera.position.set(x, y + EYE_HEIGHT, z);
  }

  /**
   * The walker's current (unrounded) feet position, or the origin if
   * touring hasn't produced a walker yet — mirrors `PlayController.getFeet()`'s
   * shape so `ModeManager.playerFeet` can return either uniformly regardless
   * of which mode is active.
   */
  getFeet(): readonly [number, number, number] {
    if (!this.walker) return [0, 0, 0];
    return [this.walker.x, this.walker.y, this.walker.z];
  }
}
