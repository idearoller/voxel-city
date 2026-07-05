import { describe, expect, it } from 'vitest';
import { hasTouchCapability } from '../src/input/touchDetection';

describe('hasTouchCapability', () => {
  it('is true when ontouchstart is present, regardless of maxTouchPoints', () => {
    expect(hasTouchCapability({ hasOntouchstart: true, maxTouchPoints: 0 })).toBe(true);
  });

  it('is true when maxTouchPoints is positive, regardless of ontouchstart', () => {
    expect(hasTouchCapability({ hasOntouchstart: false, maxTouchPoints: 5 })).toBe(true);
  });

  it('is false when neither signal is present (a plain desktop mouse browser)', () => {
    expect(hasTouchCapability({ hasOntouchstart: false, maxTouchPoints: 0 })).toBe(false);
  });

  it('is false when maxTouchPoints is exactly 0', () => {
    expect(hasTouchCapability({ hasOntouchstart: false, maxTouchPoints: 0 })).toBe(false);
  });
});
