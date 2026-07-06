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
import { maybeBeginElevatorRide, stepTourElevatorRide, type TourElevatorPort, type TourElevatorRideState } from './TourElevatorRide';
import {
  createTourExcursionIdleState,
  maybeBeginExcursion,
  pickTourSpawnCell,
  stepExcursion,
  stepExcursionIdleTimer,
  type TourExcursionIdleState,
  type TourExcursionState,
} from './TourElevatorExcursion';
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
  /** Non-null exactly while the walker is mid elevator-ride (see `TourElevatorRide.ts`) -- mutually exclusive with ordinary `stepTourWalker` stepping, same "one detour commitment at a time" shape `Pedestrian.stair` already has for stairs. */
  private elevatorRide: TourElevatorRideState | null = null;
  /** Non-null exactly while the walker is mid elevator-*seeking* excursion (see `TourElevatorExcursion.ts`) -- mutually exclusive with both ordinary wandering and an active ride. */
  private excursion: TourExcursionState | null = null;
  /** Idle-timing state for `maybeBeginExcursion` -- see `TourElevatorExcursion.ts`'s own doc comment. Only ticked while ordinarily wandering (see `update`). */
  private excursionIdleState: TourExcursionIdleState = createTourExcursionIdleState();
  /** How many elevator rides have completed (arrived and stepped off) across this controller's lifetime -- see `update`'s doc comment on why only 'exiting' completions count, not 'retreating' bailouts. Diagnostic/test-only surface. */
  private completedElevatorRides = 0;

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
    /**
     * Optional so every existing caller/test that constructs a
     * `TourController` without wiring `ElevatorSystem` keeps working exactly
     * as before -- the walker simply never detours onto an elevator without
     * one (see `update`'s guard before `maybeBeginElevatorRide`).
     */
    private readonly elevatorPort?: TourElevatorPort,
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
   * left behind. Likewise clears any in-progress elevator ride: re-entering
   * tour mid-ride (having left tour, ridden nothing since, then tabbed back)
   * would otherwise resume a stale commitment to a shaft the walker is no
   * longer anywhere near, having just been re-spawned at a fresh cell — see
   * `TourElevatorRide.ts`'s doc comment on why this state deliberately lives
   * here rather than on the walker itself, which is what makes discarding it
   * this cleanly possible.
   *
   * Task #37 promises "starts from/near your current position," and that's
   * exactly what happens here -- with one deliberate, bounded exception (see
   * `pickTourSpawnCell`): if the nearest walkable cell to (x, z) turns out to
   * be on a NavGrid "island" (city blocks' sidewalk rings are rarely
   * connected to their neighbors') with no functional elevator shaft
   * reachable at all, a `SPAWN_NEAR_SHAFT_CHANCE` roll may redirect the spawn
   * to a random shaft's own ground door instead -- the only way that
   * session's excursions could ever have a shot at a ride. An island that
   * already has a reachable shaft always honors #37 in full; a shaft-less
   * one still usually does too (see that constant's own doc comment).
   */
  start(x: number, z: number): void {
    const grid = this.getNavGrid();
    if (!grid) return;

    const nearCell = findNearestWalkableGroundCell(grid, x, z) ?? pickRandomWalkableGroundCell(grid, this.rng);
    if (!nearCell) return;

    const cell = this.elevatorPort
      ? pickTourSpawnCell(nearCell, grid, this.elevatorPort.shafts(), grid.groundY, this.rng)
      : nearCell;

    this.walker = createTourWalker(cell.x, cell.z, grid.groundY, TOUR_WALK_SPEED);
    this.autoLookState = createTourAutoLookState();
    this.elevatorRide = null;
    this.excursion = null;
    this.excursionIdleState = createTourExcursionIdleState();
  }

  /**
   * Fixed-tick simulation step. Respawns at a fresh random walkable cell
   * instead of leaving a dead walker in place — see `TourWalker.ts`'s doc
   * comment on why touring must never permanently stall. Also drives idle
   * cinematic auto-yaw (see `updateAutoYaw`) — both run only while
   * `ModeManager` is actually routing ticks here (i.e. only in tour mode),
   * which is also what makes leaving tour mode cancel auto-yaw cleanly: it
   * simply stops being stepped, freezing `LookControls`' pose exactly where
   * it was — no jump on handover to sandbox/play. Mid-ride mode exits are
   * just as clean and need no special-casing here: an in-progress
   * `elevatorRide` simply stops being stepped the moment `ModeManager` routes
   * ticks elsewhere, exactly like the walker itself, and `start()` discards
   * it outright on the next tour entry (see its own doc comment) — nothing
   * about the elevator's own moving-car simulation depends on this
   * controller ticking at all (`ElevatorSystem.update` runs unconditionally
   * every frame regardless of mode), so a car mid-ride keeps arriving at its
   * target on its own and is simply ready for whichever mode's rider finds
   * it next. Handing the camera back "at the car" if play mode is entered
   * mid-ride is `ModeManager.findSpawn`'s concern, not this controller's —
   * see that method's doc comment.
   *
   * Ordinary wandering, an elevator ride, and an elevator-seeking excursion
   * (see `TourElevatorExcursion.ts`) are all mutually exclusive per tick
   * (mirroring `Pedestrian.stair`'s "one commitment at a time" shape): while
   * `elevatorRide` is set, only `stepTourElevatorRide` advances the walker;
   * else while `excursion` is set, only `stepExcursion` does; otherwise
   * `stepTourWalker` runs as before, and — only on a tick where it just
   * completed an ordinary cell-to-cell hop (`cellX`/`cellZ` changed, detected
   * by comparing against the pre-step cell), not mid-stair, and only when an
   * elevator port was actually wired in — `maybeBeginElevatorRide` first gets
   * the chance to redirect that hop into a ride, and only if it doesn't does
   * `maybeBeginExcursion` get a (much rarer) chance to redirect it into a
   * seek instead. Reverting `cellX`/`cellZ` back to the pre-step cell when
   * either is accepted undoes `chooseNextCell`'s already-applied move:
   * `walker.x`/`z` are still exactly centered on that pre-step cell
   * (stepPedestrian snaps them there before ever calling `chooseNextCell`),
   * so no position correction is needed, just the bookkeeping fields.
   */
  update(dt: number): void {
    const grid = this.getNavGrid();
    if (!grid || !this.walker) return;

    if (this.elevatorRide && this.elevatorPort) {
      const phaseBeforeStep = this.elevatorRide.phase;
      this.elevatorRide = stepTourElevatorRide(this.walker, this.elevatorRide, dt, this.elevatorPort);
      // Only a ride that reached 'exiting' (arrived and stepped off) counts
      // as completed -- one that reached null via 'retreating' (bounded-wait
      // bailout, see TourElevatorRide.ts) gave up instead, and isn't a ride
      // in any meaningful sense. This counter exists purely for real-stack
      // soak diagnostics/tests (see TourElevatorRideIntegration.test.ts) --
      // gameplay never reads it.
      if (!this.elevatorRide && phaseBeforeStep === 'exiting') this.completedElevatorRides++;
      this.updateAutoYaw(dt);
      return;
    }

    if (this.excursion) {
      this.excursion = stepExcursion(this.walker, this.excursion, dt, grid);
      this.updateAutoYaw(dt);
      return;
    }

    const arrivedCellX = this.walker.cellX;
    const arrivedCellZ = this.walker.cellZ;
    stepTourWalker(this.walker, dt, grid, this.rng);
    stepExcursionIdleTimer(this.excursionIdleState, dt);

    if (!this.walker.alive) {
      const cell = pickRandomWalkableGroundCell(grid, this.rng);
      this.walker = cell ? createTourWalker(cell.x, cell.z, grid.groundY, TOUR_WALK_SPEED) : null;
    } else if (
      this.elevatorPort &&
      !this.walker.stair &&
      (this.walker.cellX !== arrivedCellX || this.walker.cellZ !== arrivedCellZ)
    ) {
      const ride = maybeBeginElevatorRide(this.walker, arrivedCellX, arrivedCellZ, grid, this.elevatorPort, this.rng);
      if (ride) {
        this.walker.cellX = arrivedCellX;
        this.walker.cellZ = arrivedCellZ;
        this.elevatorRide = ride;
      } else {
        // No organic ride this arrival -- offer the (much rarer) chance of a
        // deliberate excursion toward the nearest functional shaft instead.
        // See TourElevatorExcursion.ts's doc comment for why this exists:
        // riding purely opportunistically measured as decorative on real
        // cities (a real-stack soak found zero organic arrivals across 5
        // seeds), so this is what actually makes rides happen at a tasteful
        // frequency in an ordinary tour session.
        const excursion = maybeBeginExcursion(
          this.walker,
          arrivedCellX,
          arrivedCellZ,
          grid,
          this.elevatorPort.shafts(),
          this.excursionIdleState,
          this.rng,
        );
        if (excursion) {
          this.walker.cellX = arrivedCellX;
          this.walker.cellZ = arrivedCellZ;
          this.excursion = excursion;
        }
      }
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

  /** How many elevator rides this controller has completed (arrived and stepped off) since construction. Diagnostic/test-only -- see the private counter's own doc comment. */
  getCompletedElevatorRideCount(): number {
    return this.completedElevatorRides;
  }
}
