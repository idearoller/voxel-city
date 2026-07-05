import { describe, expect, it } from 'vitest';
import { classifyGesture, TAP_MAX_DURATION_MS, TAP_MAX_MOVEMENT_PX } from '../src/input/tapGesture';

describe('classifyGesture', () => {
  it('classifies a short, stationary touch as a tap', () => {
    const start = { x: 100, y: 100, timeMs: 0 };
    const end = { x: 100, y: 100, timeMs: 50 };
    expect(classifyGesture(start, end)).toBe('tap');
  });

  it('classifies a touch right at the duration/movement boundary as a tap', () => {
    const start = { x: 0, y: 0, timeMs: 0 };
    const end = { x: TAP_MAX_MOVEMENT_PX, y: 0, timeMs: TAP_MAX_DURATION_MS };
    expect(classifyGesture(start, end)).toBe('tap');
  });

  it('classifies a touch just past the duration threshold as a drag, even with no movement', () => {
    const start = { x: 0, y: 0, timeMs: 0 };
    const end = { x: 0, y: 0, timeMs: TAP_MAX_DURATION_MS + 1 };
    expect(classifyGesture(start, end)).toBe('drag');
  });

  it('classifies a touch just past the movement threshold as a drag, even if released instantly', () => {
    const start = { x: 0, y: 0, timeMs: 0 };
    const end = { x: TAP_MAX_MOVEMENT_PX + 1, y: 0, timeMs: 0 };
    expect(classifyGesture(start, end)).toBe('drag');
  });

  it('classifies a slow but small-movement touch as a drag (duration alone can disqualify a tap)', () => {
    const start = { x: 0, y: 0, timeMs: 0 };
    const end = { x: 1, y: 1, timeMs: 5000 };
    expect(classifyGesture(start, end)).toBe('drag');
  });

  it('classifies a fast but far flick as a drag (movement alone can disqualify a tap)', () => {
    const start = { x: 0, y: 0, timeMs: 0 };
    const end = { x: 500, y: 500, timeMs: 10 };
    expect(classifyGesture(start, end)).toBe('drag');
  });
});
