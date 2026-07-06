import { describe, expect, it } from 'vitest';
import {
  createTourAutoLookState,
  DEFAULT_TOUR_AUTO_LOOK_CONFIG,
  registerLookInput,
  stepTourAutoLook,
  type LookPose,
  type TourAutoLookConfig,
} from '../src/player/TourAutoLook';

/** A fast-converging config so tests don't need hundreds of ticks to see the ease resolve -- the production tuning (`DEFAULT_TOUR_AUTO_LOOK_CONFIG`) is exercised separately below. */
const FAST_CONFIG: TourAutoLookConfig = {
  idleDelaySeconds: 1,
  yawEaseRate: 2,
  pitchEaseRate: 2,
};

describe('stepTourAutoLook', () => {
  it('does nothing before the idle delay has elapsed', () => {
    const state = createTourAutoLookState();
    const pose: LookPose = { yaw: 0, pitch: 0.3 };

    const engaged = stepTourAutoLook(state, pose, Math.PI / 2, 0.5, FAST_CONFIG);

    expect(engaged).toBe(false);
    expect(pose).toEqual({ yaw: 0, pitch: 0.3 });
  });

  it('engages once the idle delay is reached, easing yaw toward the target and pitch toward level', () => {
    const state = createTourAutoLookState();
    const pose: LookPose = { yaw: 0, pitch: 0.3 };

    // First step lands exactly on the threshold; still nothing moves at t < idleDelaySeconds.
    stepTourAutoLook(state, pose, Math.PI / 2, 0.9, FAST_CONFIG);
    expect(pose).toEqual({ yaw: 0, pitch: 0.3 });

    const engaged = stepTourAutoLook(state, pose, Math.PI / 2, 0.2, FAST_CONFIG);

    expect(engaged).toBe(true);
    expect(pose.yaw).toBeGreaterThan(0);
    expect(pose.yaw).toBeLessThan(Math.PI / 2);
    expect(pose.pitch).toBeGreaterThan(0);
    expect(pose.pitch).toBeLessThan(0.3);
  });

  it('registerLookInput cancels engagement by resetting the idle timer, restoring full manual control', () => {
    const state = createTourAutoLookState();
    const pose: LookPose = { yaw: 0.1, pitch: 0.1 };

    stepTourAutoLook(state, pose, Math.PI / 2, FAST_CONFIG.idleDelaySeconds, FAST_CONFIG);
    expect(state.idleSeconds).toBeGreaterThanOrEqual(FAST_CONFIG.idleDelaySeconds);

    registerLookInput(state);

    expect(state.idleSeconds).toBe(0);
    const poseBefore = { ...pose };
    const engaged = stepTourAutoLook(state, pose, Math.PI / 2, 0.01, FAST_CONFIG);
    expect(engaged).toBe(false);
    expect(pose).toEqual(poseBefore);
  });

  it('converges to the target yaw (modulo a full turn -- shortestArcLerp own convention, see interpolation.test.ts) and level pitch given enough idle time', () => {
    const state = createTourAutoLookState();
    const pose: LookPose = { yaw: -1.2, pitch: 0.5 };
    const targetYaw = 2.0;

    for (let i = 0; i < 2000; i++) {
      stepTourAutoLook(state, pose, targetYaw, 1 / 60, FAST_CONFIG);
    }

    expect(Math.sin(pose.yaw)).toBeCloseTo(Math.sin(targetYaw), 3);
    expect(Math.cos(pose.yaw)).toBeCloseTo(Math.cos(targetYaw), 3);
    expect(pose.pitch).toBeCloseTo(0, 3);
  });

  it('takes the shortest arc even when the target is exactly across the +-pi wraparound', () => {
    const state = createTourAutoLookState();
    // Start just past +pi's negative mirror; target just past it the other side --
    // short way is ~0.28 rad through +-pi, long way is ~6.0 rad through 0.
    const pose: LookPose = { yaw: -3.0, pitch: 0 };
    const targetYaw = 3.0;

    state.idleSeconds = FAST_CONFIG.idleDelaySeconds;
    stepTourAutoLook(state, pose, targetYaw, 1 / 60, FAST_CONFIG);

    // A long-way spin would have immediately swung yaw *upward* toward 0;
    // the short way instead continues in the negative direction, wrapping
    // past -pi.
    expect(pose.yaw).toBeLessThan(-3.0);
  });

  it('does not spin the long way or oscillate when the target heading flips mid-ease (dead-end reversal)', () => {
    const state = createTourAutoLookState();
    const pose: LookPose = { yaw: 0, pitch: 0 };
    state.idleSeconds = FAST_CONFIG.idleDelaySeconds;

    // Ease partway toward a heading of +pi/2 (walking +x)...
    for (let i = 0; i < 5; i++) {
      stepTourAutoLook(state, pose, Math.PI / 2, 1 / 60, FAST_CONFIG);
    }
    const yawBeforeFlip = pose.yaw;
    expect(yawBeforeFlip).toBeGreaterThan(0);
    expect(yawBeforeFlip).toBeLessThan(Math.PI / 2);

    // ...then the walker hits a dead end and reverses to -pi/2 (walking -x).
    // Track every intermediate step to prove it turns straight back the way
    // it came instead of continuing forward and wrapping the long way round.
    let previous = yawBeforeFlip;
    for (let i = 0; i < 200; i++) {
      stepTourAutoLook(state, pose, -Math.PI / 2, 1 / 60, FAST_CONFIG);
      // Monotonically decreasing toward -pi/2 -- never overshoots past it,
      // never reverses direction again (which an oscillation would do).
      expect(pose.yaw).toBeLessThanOrEqual(previous);
      expect(pose.yaw).toBeGreaterThanOrEqual(-Math.PI / 2 - 1e-9);
      previous = pose.yaw;
    }

    expect(pose.yaw).toBeCloseTo(-Math.PI / 2, 2);
  });

  it('is frame-rate independent: one large dt lands ~the same as many small dts covering the same total time', () => {
    const targetYaw = Math.PI / 3;

    const bigStepState = createTourAutoLookState();
    const bigStepPose: LookPose = { yaw: -0.4, pitch: 0.2 };
    bigStepState.idleSeconds = FAST_CONFIG.idleDelaySeconds;
    stepTourAutoLook(bigStepState, bigStepPose, targetYaw, 1.0, FAST_CONFIG);

    const smallStepState = createTourAutoLookState();
    const smallStepPose: LookPose = { yaw: -0.4, pitch: 0.2 };
    smallStepState.idleSeconds = FAST_CONFIG.idleDelaySeconds;
    for (let i = 0; i < 10; i++) {
      stepTourAutoLook(smallStepState, smallStepPose, targetYaw, 0.1, FAST_CONFIG);
    }

    expect(bigStepPose.yaw).toBeCloseTo(smallStepPose.yaw, 6);
    expect(bigStepPose.pitch).toBeCloseTo(smallStepPose.pitch, 6);
  });

  it('the tuned production defaults are cinematically slow: barely any turn within the first second of engagement', () => {
    const state = createTourAutoLookState();
    const pose: LookPose = { yaw: 0, pitch: 0 };
    state.idleSeconds = DEFAULT_TOUR_AUTO_LOOK_CONFIG.idleDelaySeconds;

    stepTourAutoLook(state, pose, Math.PI / 2, 1.0, DEFAULT_TOUR_AUTO_LOOK_CONFIG);

    // yawEaseRate=0.5 -> a 1s step covers 1-e^-0.5 (~39%) of the remaining
    // arc, not a snap to the target.
    expect(pose.yaw).toBeGreaterThan(0.1);
    expect(pose.yaw).toBeLessThan(Math.PI / 2 - 0.1);
  });
});
