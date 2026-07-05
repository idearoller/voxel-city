/**
 * Tap-vs-drag classification for the touch look/edit finger (right half of
 * the screen — see `TouchInputController`): a short, nearly-stationary touch
 * is a tap (fires a voxel edit, the touch equivalent of a mouse click),
 * anything longer or further is a drag (already applied incrementally as
 * look-rotation while it was moving). Pure and DOM-free.
 */

export interface GestureSample {
  readonly x: number;
  readonly y: number;
  readonly timeMs: number;
}

export const TAP_MAX_DURATION_MS = 250;
export const TAP_MAX_MOVEMENT_PX = 12;

export type Gesture = 'tap' | 'drag';

/**
 * Classifies a finger's touchstart -> touchend as 'tap' or 'drag' using
 * time *and* movement thresholds together, so a slow-but-still drag and a
 * fast-but-far flick both correctly read as 'drag', not 'tap'.
 */
export function classifyGesture(start: GestureSample, end: GestureSample): Gesture {
  const distance = Math.hypot(end.x - start.x, end.y - start.y);
  const duration = end.timeMs - start.timeMs;
  return duration <= TAP_MAX_DURATION_MS && distance <= TAP_MAX_MOVEMENT_PX ? 'tap' : 'drag';
}
