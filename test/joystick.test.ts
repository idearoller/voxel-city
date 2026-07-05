import { describe, expect, it } from 'vitest';
import {
  clampKnobOffset,
  computeJoystickVector,
  joystickToDirectionalKeys,
  JOYSTICK_DEADZONE,
  JOYSTICK_RADIUS_PX,
  NEUTRAL_DIRECTIONAL_KEYS,
  SPRINT_MAGNITUDE_THRESHOLD,
} from '../src/input/joystick';

describe('computeJoystickVector', () => {
  it('is neutral when the finger has not moved from the origin', () => {
    const vector = computeJoystickVector({ x: 100, y: 100 }, { x: 100, y: 100 });
    expect(vector).toEqual({ x: 0, y: 0, magnitude: 0 });
  });

  it('is neutral inside the deadzone', () => {
    const insideDeadzone = JOYSTICK_RADIUS_PX * JOYSTICK_DEADZONE * 0.5;
    const vector = computeJoystickVector({ x: 0, y: 0 }, { x: insideDeadzone, y: 0 });
    expect(vector.magnitude).toBe(0);
    expect(vector.x).toBe(0);
  });

  it('ramps magnitude from 0 at the deadzone edge to 1 at the radius, not jumping straight to the deadzone value', () => {
    const halfway = JOYSTICK_RADIUS_PX * (JOYSTICK_DEADZONE + (1 - JOYSTICK_DEADZONE) / 2);
    const vector = computeJoystickVector({ x: 0, y: 0 }, { x: halfway, y: 0 });
    expect(vector.magnitude).toBeCloseTo(0.5, 5);
  });

  it('clamps magnitude to 1 for a finger dragged past the radius', () => {
    const vector = computeJoystickVector({ x: 0, y: 0 }, { x: JOYSTICK_RADIUS_PX * 5, y: 0 });
    expect(vector.magnitude).toBe(1);
    expect(vector.x).toBeCloseTo(1, 5);
    expect(vector.y).toBeCloseTo(0, 5);
  });

  it('preserves direction for a pure vertical push (screen-down positive)', () => {
    const vector = computeJoystickVector({ x: 50, y: 50 }, { x: 50, y: 50 - JOYSTICK_RADIUS_PX });
    expect(vector.x).toBeCloseTo(0, 5);
    expect(vector.y).toBeLessThan(0);
    expect(vector.magnitude).toBeCloseTo(1, 5);
  });

  it('preserves diagonal direction proportionally', () => {
    const vector = computeJoystickVector({ x: 0, y: 0 }, { x: JOYSTICK_RADIUS_PX * 5, y: -JOYSTICK_RADIUS_PX * 5 });
    expect(vector.x).toBeGreaterThan(0);
    expect(vector.y).toBeLessThan(0);
    expect(vector.x).toBeCloseTo(-vector.y, 5);
  });
});

describe('clampKnobOffset', () => {
  it('follows the finger exactly while within the radius', () => {
    const offset = clampKnobOffset({ x: 0, y: 0 }, { x: 10, y: -20 });
    expect(offset).toEqual({ x: 10, y: -20 });
  });

  it('clamps to exactly the radius, preserving direction, once the finger travels past it', () => {
    const offset = clampKnobOffset({ x: 0, y: 0 }, { x: JOYSTICK_RADIUS_PX * 10, y: 0 });
    expect(offset.x).toBeCloseTo(JOYSTICK_RADIUS_PX, 5);
    expect(offset.y).toBeCloseTo(0, 5);
  });

  it('returns zero offset when the finger has not moved', () => {
    expect(clampKnobOffset({ x: 5, y: 5 }, { x: 5, y: 5 })).toEqual({ x: 0, y: 0 });
  });
});

describe('joystickToDirectionalKeys', () => {
  it('is fully neutral at zero magnitude', () => {
    expect(joystickToDirectionalKeys({ x: 0, y: 0, magnitude: 0 })).toBe(NEUTRAL_DIRECTIONAL_KEYS);
  });

  it('activates forward only for a strong enough pure-up push', () => {
    const keys = joystickToDirectionalKeys({ x: 0, y: -1, magnitude: 1 });
    expect(keys).toEqual({ forward: true, back: false, left: false, right: false, sprint: true });
  });

  it('activates back for a pure-down push', () => {
    const keys = joystickToDirectionalKeys({ x: 0, y: 1, magnitude: 1 });
    expect(keys.back).toBe(true);
    expect(keys.forward).toBe(false);
  });

  it('activates two keys at once for a diagonal push (forward-right)', () => {
    const keys = joystickToDirectionalKeys({ x: 0.9, y: -0.9, magnitude: 0.95 });
    expect(keys.forward).toBe(true);
    expect(keys.right).toBe(true);
    expect(keys.back).toBe(false);
    expect(keys.left).toBe(false);
  });

  it('does not activate an axis whose component is below the activation threshold', () => {
    const keys = joystickToDirectionalKeys({ x: 0.1, y: -0.5, magnitude: 0.5 });
    expect(keys.right).toBe(false);
    expect(keys.left).toBe(false);
    expect(keys.forward).toBe(true);
  });

  it('only sprints once magnitude reaches the sprint threshold (near-full deflection)', () => {
    const belowThreshold = joystickToDirectionalKeys({ x: 0, y: -0.9, magnitude: SPRINT_MAGNITUDE_THRESHOLD - 0.05 });
    const atThreshold = joystickToDirectionalKeys({ x: 0, y: -1, magnitude: SPRINT_MAGNITUDE_THRESHOLD });
    expect(belowThreshold.sprint).toBe(false);
    expect(atThreshold.sprint).toBe(true);
  });
});
