import { describe, expect, it } from 'vitest';
import {
  computeFixedSteps,
  FIXED_TIMESTEP,
  MAX_STEPS_PER_FRAME,
} from '../src/engine/FixedTimestep';

describe('computeFixedSteps', () => {
  it('runs zero steps and carries the full delta when dt is smaller than one step', () => {
    const dt = FIXED_TIMESTEP / 2;
    const result = computeFixedSteps(0, dt);
    expect(result.steps).toBe(0);
    expect(result.accumulator).toBeCloseTo(dt, 10);
  });

  it('runs exactly N steps and zeroes the accumulator when dt is an exact multiple', () => {
    const result = computeFixedSteps(0, 3 * FIXED_TIMESTEP);
    expect(result.steps).toBe(3);
    expect(result.accumulator).toBeCloseTo(0, 10);
  });

  it('carries a sub-step remainder alongside a whole number of steps', () => {
    const remainder = FIXED_TIMESTEP / 3;
    const result = computeFixedSteps(0, 2 * FIXED_TIMESTEP + remainder);
    expect(result.steps).toBe(2);
    expect(result.accumulator).toBeCloseTo(remainder, 10);
  });

  it('accumulates leftover from a previous frame with this frame\'s delta', () => {
    const leftover = FIXED_TIMESTEP * 0.4;
    const dt = FIXED_TIMESTEP * 0.7;
    // 0.4 + 0.7 = 1.1 steps worth -> 1 step, 0.1 step remainder.
    const result = computeFixedSteps(leftover, dt);
    expect(result.steps).toBe(1);
    expect(result.accumulator).toBeCloseTo(FIXED_TIMESTEP * 0.1, 10);
  });

  it('caps steps at MAX_STEPS_PER_FRAME and drops the excess backlog when dt is huge', () => {
    const hugeDt = FIXED_TIMESTEP * (MAX_STEPS_PER_FRAME + 50);
    const result = computeFixedSteps(0, hugeDt);
    expect(result.steps).toBe(MAX_STEPS_PER_FRAME);
    expect(result.accumulator).toBe(0);
  });

  it('does not carry the dropped backlog into the next frame\'s computation', () => {
    const hugeDt = FIXED_TIMESTEP * (MAX_STEPS_PER_FRAME + 50);
    const first = computeFixedSteps(0, hugeDt);

    // A tiny follow-up frame should not suddenly run a huge batch of steps
    // just because the previous frame was starved; the backlog is gone.
    const second = computeFixedSteps(first.accumulator, FIXED_TIMESTEP / 2);
    expect(second.steps).toBe(0);
    expect(second.accumulator).toBeLessThan(FIXED_TIMESTEP);
  });

  it('runs exactly MAX_STEPS_PER_FRAME steps at the cap boundary without dropping', () => {
    const result = computeFixedSteps(0, MAX_STEPS_PER_FRAME * FIXED_TIMESTEP);
    expect(result.steps).toBe(MAX_STEPS_PER_FRAME);
    expect(result.accumulator).toBeCloseTo(0, 10);
  });

  it('always returns an accumulator strictly less than FIXED_TIMESTEP', () => {
    const deltas = [0, FIXED_TIMESTEP * 0.99, FIXED_TIMESTEP * 1.5, FIXED_TIMESTEP * 1000];
    for (const dt of deltas) {
      const result = computeFixedSteps(0, dt);
      expect(result.accumulator).toBeLessThan(FIXED_TIMESTEP);
    }
  });
});
