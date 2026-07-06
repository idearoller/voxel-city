/**
 * Pure idle-timing and easing math for tour mode's cinematic auto-yaw: once
 * the user hasn't looked around for a while, the camera slowly turns to face
 * the walker's current heading instead of sitting wherever mouse look last
 * left it. No Three.js, no DOM, no wall-clock reads -- every input (dt,
 * current pose, target yaw) is passed in, so this is unit-testable with
 * fabricated frame deltas and needs no fakes/mocks at all.
 *
 * `player/TourController.ts` is the thin wiring layer: it owns the walker,
 * reads/writes `LookControls`' pose through the `TourLookPort` it defines,
 * and calls into this module once per fixed tick -- the same
 * pure-core/thin-wiring split `TourWalker.ts`/`TourController.ts` already
 * establish for the walking side of tour mode.
 */

import { shortestArcLerp } from '../entities/interpolation';

export interface TourAutoLookConfig {
  /** Seconds of no look-input before auto-yaw starts engaging. Picked in the ~3-5s "tasteful" range the spec calls for: long enough that a player glancing around mid-thought never gets fought, short enough that an actually-idle tour reorients before the moment gets boring. */
  readonly idleDelaySeconds: number;
  /** Exponential-approach rate (1/seconds) for yaw -- see `stepTourAutoLook`'s doc comment for why this, not a fixed per-frame lerp fraction, is what makes the ease frame-rate independent. 0.5 gives a ~2s time constant: a slow, cinematic turn, never a snap, that still visibly resolves within a few seconds rather than crawling indefinitely. */
  readonly yawEaseRate: number;
  /** Same shape as `yawEaseRate` but for pitch's ease back toward level (0 rad). Deliberately slower/gentler (a longer ~2.5s time constant) than yaw: yaw is the primary "face where you're walking" cue, pitch-leveling is a secondary cinematic touch that should read as a soft settle, not compete with the yaw turn for attention. */
  readonly pitchEaseRate: number;
}

/**
 * Tuned defaults -- see each field's doc comment above for the reasoning.
 * `TourController` uses these unless a caller (e.g. a test) overrides them.
 */
export const DEFAULT_TOUR_AUTO_LOOK_CONFIG: TourAutoLookConfig = {
  idleDelaySeconds: 4,
  yawEaseRate: 0.5,
  pitchEaseRate: 0.4,
};

/** Mutable idle-timing state, owned and persisted by `TourController` across ticks (one instance per tour session -- see `TourController.start`, which replaces it with a fresh one on every (re)entry into tour mode). */
export interface TourAutoLookState {
  idleSeconds: number;
}

export function createTourAutoLookState(): TourAutoLookState {
  return { idleSeconds: 0 };
}

/**
 * Call whenever look input (mouse move or touch drag) has occurred --
 * immediately cancels any in-progress auto-yaw (the next `stepTourAutoLook`
 * call will see `idleSeconds` reset below the threshold and no-op) and
 * restarts the idle timer, matching the spec's "any mouse movement
 * immediately cancels auto-yaw and returns full control; the idle timer
 * restarts."
 */
export function registerLookInput(state: TourAutoLookState): void {
  state.idleSeconds = 0;
}

/** The subset of `LookControls`' pose this module reads and eases -- a plain data bag, not `LookControls` itself, so this stays framework-free. */
export interface LookPose {
  yaw: number;
  pitch: number;
}

/**
 * Advances the idle timer by `dt`, and -- once past `config.idleDelaySeconds`
 * -- eases `pose.yaw` toward `targetYaw` (shortest arc) and `pose.pitch`
 * toward level (0 rad) in place. Returns whether auto-yaw is engaged this
 * step (i.e. whether `pose` was actually touched), purely so callers/tests
 * can assert on it -- the gating is already fully self-contained.
 *
 * The blend factor per step is `1 - e^(-rate * dt)`, i.e. true exponential
 * decay toward the target rather than a fixed-fraction-per-frame lerp. That
 * choice is what makes the ease frame-rate independent in the strict sense
 * the spec asks for: decay composes exactly across sub-steps -- easing once
 * with `dt = a + b` lands on exactly the same pose as easing first with `a`
 * then with `b` (mirroring true `e^-rate*t` continuous decay) -- whereas a
 * naive `pose += (target - pose) * rate * dt` Euler update only
 * approximates that and visibly diverges once `dt` is large relative to
 * `1/rate` (e.g. a stalled/backgrounded tab's first catch-up frame). See
 * this module's tests for the two-dt-pattern convergence check.
 *
 * Reusing `shortestArcLerp` for pitch too (rather than a plain `lerp`) is
 * harmless, not incorrect: pitch is clamped to `[-MAX_PITCH, MAX_PITCH]` (see
 * `LookControls`), so `|pitch - 0|` is always well under `Math.PI` and the
 * shortest-arc branch never actually triggers -- it degenerates to an
 * ordinary lerp. Sharing one helper avoids a second, functionally-identical
 * interpolation function existing solely for the axis that happens not to
 * wrap.
 *
 * Re-deriving the target fresh from the *current* `pose` every call (rather
 * than integrating a fixed angular velocity toward a remembered target) is
 * also what keeps a walker's dead-end heading flip safe: this is a
 * first-order filter chasing a possibly-moving target, so a flip just
 * changes `targetYaw` for the next step -- `shortestArcLerp` immediately
 * picks the new shortest arc from wherever `pose.yaw` currently sits. There
 * is no stored "previous target" or velocity to fight the flip, so it can
 * never overshoot into a spin or oscillate.
 */
export function stepTourAutoLook(
  state: TourAutoLookState,
  pose: LookPose,
  targetYaw: number,
  dt: number,
  config: TourAutoLookConfig = DEFAULT_TOUR_AUTO_LOOK_CONFIG,
): boolean {
  state.idleSeconds += dt;
  if (state.idleSeconds < config.idleDelaySeconds) return false;

  pose.yaw = shortestArcLerp(pose.yaw, targetYaw, easeFactor(config.yawEaseRate, dt));
  pose.pitch = shortestArcLerp(pose.pitch, 0, easeFactor(config.pitchEaseRate, dt));
  return true;
}

/** The exact per-step blend fraction for exponential decay at `rate` over `dt` seconds -- see `stepTourAutoLook`'s doc comment for why this (not `rate * dt`) is what gives exact composition across sub-steps. */
function easeFactor(rate: number, dt: number): number {
  return 1 - Math.exp(-rate * dt);
}
