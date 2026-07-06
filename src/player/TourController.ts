import * as THREE from 'three';
import type { NavGrid } from '../entities/NavGrid';
import { headingFromDirection, lerp } from '../entities/interpolation';
import { createRng, type Rng } from '../gen/rng';
import { EYE_HEIGHT } from './PlayController';
import {
  createTourAutoLookState,
  registerLookInput,
  stepTourAutoLook,
  type LookPose,
  type TourAutoLookState,
} from './TourAutoLook';
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
 * Structural port over exactly the slice of `LookControls` tour mode's idle
 * cinematic auto-yaw needs — kept independent of the concrete class (rather
 * than importing `LookControls` directly) for two reasons: `TourController`'s
 * own unit tests can supply a lightweight fake instead of constructing a
 * real `LookControls` (which wants a live `HTMLCanvasElement` and installs
 * document-level listeners), and it documents the dependency direction —
 * `LookControls` stays the sole owner of yaw/pitch state and the sole writer
 * of `camera.quaternion`; `TourController` only ever reads its pose and asks
 * it to ease toward a new one.
 */
export interface TourLookPort {
  readonly yawRadians: number;
  readonly pitchRadians: number;
  consumeLookInput(): boolean;
  applyAutoYaw(yaw: number, pitch: number): void;
}

/**
 * Drives the camera in tour mode: an auto-walking pedestrian-like body on
 * the same `NavGrid` real pedestrians use (see `TourWalker.ts`), rendered
 * with the same previous/current-tick render-interpolation lerp
 * `EntityRenderer` uses for NPCs (see `entities/interpolation.ts`) — a tour
 * camera stepping at raw 60Hz sim positions would reproduce exactly the
 * judder that interpolation was just added to eliminate for pedestrians.
 *
 * Never writes `camera.quaternion` directly: `LookControls` still owns the
 * camera's rotation — mouse look keeps working in tour mode because nothing
 * here touches it — and WASD/jump/sprint/editing are inert simply because
 * `ModeManager.update` never routes to `FlyController`/`PlayController`
 * while in tour mode (see `ModeManager.update`). The one exception is idle
 * cinematic auto-yaw (see `updateAutoYaw`): while the mouse has been still
 * for a few seconds, this reads/writes `LookControls`' pose through the
 * `TourLookPort` passed in below — still funneled through `LookControls`'s
 * own setter rather than poking the quaternion directly, so it remains the
 * sole writer.
 */
export class TourController {
  private walker: TourWalker | null = null;
  private readonly rng: Rng = createRng('tour');
  private autoLookState: TourAutoLookState = createTourAutoLookState();

  constructor(
    private readonly camera: THREE.Camera,
    private readonly getNavGrid: NavGridProvider,
    /**
     * Optional so every existing caller/test that constructs a
     * `TourController` without wiring `LookControls` keeps working exactly
     * as before — idle cinematic auto-yaw simply never engages without one
     * (see `updateAutoYaw`'s early return).
     */
    private readonly lookControls?: TourLookPort,
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
   *
   * Also resets idle-cinematic auto-yaw's timer to fresh (see
   * `TourAutoLook.createTourAutoLookState`) so every tour session — first
   * entry or any later re-entry via `ModeManager.cycleMode` — starts fully
   * idle-timer-zeroed rather than inheriting whatever a previous session
   * left behind.
   */
  start(x: number, z: number): void {
    const grid = this.getNavGrid();
    if (!grid) return;

    const cell = findNearestWalkableGroundCell(grid, x, z) ?? pickRandomWalkableGroundCell(grid, this.rng);
    if (!cell) return;

    this.walker = createTourWalker(cell.x, cell.z, grid.groundY, TOUR_WALK_SPEED);
    this.autoLookState = createTourAutoLookState();
  }

  /**
   * Fixed-tick simulation step. Respawns at a fresh random walkable cell
   * instead of leaving a dead walker in place — see `TourWalker.ts`'s doc
   * comment on why touring must never permanently stall. Also drives idle
   * cinematic auto-yaw (see `updateAutoYaw`) — both run only while
   * `ModeManager` is actually routing ticks here (i.e. only in tour mode),
   * which is also what makes leaving tour mode cancel auto-yaw cleanly: it
   * simply stops being stepped, freezing `LookControls`' pose exactly where
   * it was — no jump on handover to sandbox/play.
   */
  update(dt: number): void {
    const grid = this.getNavGrid();
    if (!grid || !this.walker) return;

    stepTourWalker(this.walker, dt, grid, this.rng);

    if (!this.walker.alive) {
      const cell = pickRandomWalkableGroundCell(grid, this.rng);
      this.walker = cell ? createTourWalker(cell.x, cell.z, grid.groundY, TOUR_WALK_SPEED) : null;
    }

    this.updateAutoYaw(dt);
  }

  /**
   * Idle-cinematic auto-yaw: while `lookControls` reports no real look input
   * this tick, eases its yaw toward the walker's current heading (and pitch
   * back toward level) via the pure `stepTourAutoLook` — see that function's
   * doc comment for the easing math and why a heading flip at a dead-end
   * reversal can't make it spin the long way or oscillate. Any real look
   * input immediately cancels (restarting the idle timer) and this tick
   * contributes no easing at all, so full control hands back the instant the
   * player moves the mouse.
   */
  private updateAutoYaw(dt: number): void {
    if (!this.lookControls || !this.walker) return;

    if (this.lookControls.consumeLookInput()) {
      registerLookInput(this.autoLookState);
      return;
    }

    const targetYaw = headingFromDirection(this.walker.dirX, this.walker.dirZ);
    const pose: LookPose = { yaw: this.lookControls.yawRadians, pitch: this.lookControls.pitchRadians };
    const engaged = stepTourAutoLook(this.autoLookState, pose, targetYaw, dt);
    if (engaged) this.lookControls.applyAutoYaw(pose.yaw, pose.pitch);
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
