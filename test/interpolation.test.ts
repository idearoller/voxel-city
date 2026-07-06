import { describe, expect, it } from 'vitest';
import {
  headingFromDirection,
  isTeleportJump,
  lerp,
  shortestArcLerp,
  TELEPORT_SAFETY_FACTOR,
} from '../src/entities/interpolation';

describe('lerp', () => {
  it('interpolates linearly between two values', () => {
    expect(lerp(0, 10, 0)).toBe(0);
    expect(lerp(0, 10, 1)).toBe(10);
    expect(lerp(0, 10, 0.5)).toBe(5);
    expect(lerp(4, 2, 0.25)).toBeCloseTo(3.5, 10);
  });

  it('extrapolates for t outside [0,1] (callers are trusted to pass in-range alpha)', () => {
    expect(lerp(0, 10, 1.5)).toBe(15);
  });
});

describe('shortestArcLerp', () => {
  it('matches a plain lerp when there is no wraparound', () => {
    expect(shortestArcLerp(0, Math.PI / 2, 0.5)).toBeCloseTo(Math.PI / 4, 10);
    expect(shortestArcLerp(-0.2, 0.2, 0.5)).toBeCloseTo(0, 10);
  });

  it('turns the short way across the +pi/-pi wraparound instead of sweeping the long way', () => {
    // From just past +pi's negative mirror to just past it the other side:
    // -3.0 and 3.0 are only ~0.28 rad apart the short way (through +-pi),
    // ~6.0 rad apart the long way (through 0). A naive lerp would produce 0.
    const result = shortestArcLerp(-3.0, 3.0, 0.5);
    expect(Math.abs(result)).toBeCloseTo(Math.PI, 1);
    expect(result).not.toBeCloseTo(0, 1);
  });

  it('turning from a small negative angle to a small positive one goes the short way through zero, not through +-pi', () => {
    expect(shortestArcLerp(-0.1, 0.1, 0.5)).toBeCloseTo(0, 10);
  });

  it('resolves the exact +-pi tie deterministically (both arcs equally short)', () => {
    // b - a === +pi exactly: delta stays +pi (not renormalized to -pi), so
    // interpolation sweeps through the positive side.
    expect(shortestArcLerp(0, Math.PI, 0.5)).toBeCloseTo(Math.PI / 2, 10);
    // b - a === -pi exactly: same tie, opposite starting point.
    expect(shortestArcLerp(Math.PI, 0, 0.5)).toBeCloseTo(Math.PI / 2, 10);
  });

  it('reaches exactly a at t=0, and b (modulo a full turn) at t=1, even across a wraparound', () => {
    // The result is an unnormalized angle (a plus a wrapped delta), so at
    // t=1 it lands on whichever representation of `b` is nearest `a` --
    // congruent to `b` modulo a full turn, not necessarily bit-identical.
    expect(shortestArcLerp(3.0, -3.0, 0)).toBeCloseTo(3.0, 10);
    const atOne = shortestArcLerp(3.0, -3.0, 1);
    expect(Math.sin(atOne)).toBeCloseTo(Math.sin(-3.0), 10);
    expect(Math.cos(atOne)).toBeCloseTo(Math.cos(-3.0), 10);
  });
});

describe('headingFromDirection', () => {
  it('resolves the zero vector to 0 rad (facing +z), matching atan2\'s spawn-instant convention', () => {
    expect(headingFromDirection(0, 0)).toBe(0);
  });

  it('matches atan2(dirX, dirZ) for a nonzero direction', () => {
    expect(headingFromDirection(1, 0)).toBeCloseTo(Math.PI / 2, 10);
    expect(headingFromDirection(0, 1)).toBeCloseTo(0, 10);
    expect(headingFromDirection(-1, 0)).toBeCloseTo(-Math.PI / 2, 10);
    expect(headingFromDirection(0, -1)).toBeCloseTo(Math.PI, 10);
  });
});

describe('isTeleportJump', () => {
  const dt = 1 / 60;
  const speed = 6;

  it('is false for ordinary bounded per-tick motion', () => {
    const step = speed * dt; // the maximum a legitimate step function could move in one tick
    expect(isTeleportJump(0, 0, 0, step, 0, 0, speed, dt)).toBe(false);
  });

  it('is false right at the safety-factor boundary', () => {
    const distance = speed * dt * TELEPORT_SAFETY_FACTOR;
    // Just under the boundary -- strictly greater-than is what trips it.
    expect(isTeleportJump(0, 0, 0, distance * 0.99, 0, 0, speed, dt)).toBe(false);
  });

  it('is true for a same-tick jump far beyond any plausible step', () => {
    expect(isTeleportJump(0, 0, 0, 500, 0, 0, speed, dt)).toBe(true);
  });

  it('accounts for the vertical axis too (pedestrian stair/deck transitions)', () => {
    expect(isTeleportJump(0, 0, 0, 0, 500, 0, speed, dt)).toBe(true);
  });

  it('is false when prev equals current (freshly spawned entity, or a fully caught-up soak)', () => {
    expect(isTeleportJump(5, 1, 5, 5, 1, 5, speed, dt)).toBe(false);
  });
});
