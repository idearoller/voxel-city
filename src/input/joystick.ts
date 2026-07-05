/**
 * Floating-joystick math for touch movement: a touch-down point anywhere in
 * the left half of the screen (see `TouchInputController`) becomes the
 * stick's origin, and the finger's live position relative to that origin
 * drives direction + deflection. Pure and Three-free, like `world/` and
 * `player/PlayerCollision` — no DOM, so it's directly unit-testable.
 */

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface JoystickVector {
  /** Normalized horizontal component, roughly [-1, 1] after deadzone rescaling. */
  readonly x: number;
  /** Normalized vertical component, roughly [-1, 1] after deadzone rescaling (screen-down positive). */
  readonly y: number;
  /** Overall deflection in [0, 1] — 0 inside the deadzone, 1 at/beyond the max radius. */
  readonly magnitude: number;
}

export const JOYSTICK_RADIUS_PX = 56;
/** Fraction of the radius that must be crossed before any input registers, so a resting thumb doesn't drift the character. */
export const JOYSTICK_DEADZONE = 0.15;

const NEUTRAL_VECTOR: JoystickVector = { x: 0, y: 0, magnitude: 0 };

/**
 * Given the finger's touch-down point (`origin`) and its current position
 * (`current`), returns a normalized direction + magnitude. Distance beyond
 * `radius` clamps to full deflection; magnitude ramps from 0 at `deadzone`
 * to 1 at the radius (rather than jumping straight from 0 to `deadzone`'s
 * value), so a nudge just past the deadzone still reads as gentle input.
 */
export function computeJoystickVector(
  origin: Point,
  current: Point,
  radius: number = JOYSTICK_RADIUS_PX,
  deadzone: number = JOYSTICK_DEADZONE,
): JoystickVector {
  const dx = current.x - origin.x;
  const dy = current.y - origin.y;
  const distance = Math.hypot(dx, dy);
  if (distance === 0) return NEUTRAL_VECTOR;

  const rawMagnitude = Math.min(distance, radius) / radius;
  if (rawMagnitude < deadzone) return NEUTRAL_VECTOR;

  const magnitude = (rawMagnitude - deadzone) / (1 - deadzone);
  const ux = dx / distance;
  const uy = dy / distance;
  return { x: ux * magnitude, y: uy * magnitude, magnitude };
}

/**
 * Clamps the finger's raw offset from `origin` to `radius` — used only to
 * position the *visual* knob, which must never render further from the base
 * than the radius even while the finger itself has traveled further.
 */
export function clampKnobOffset(origin: Point, current: Point, radius: number = JOYSTICK_RADIUS_PX): Point {
  const dx = current.x - origin.x;
  const dy = current.y - origin.y;
  const distance = Math.hypot(dx, dy);
  if (distance <= radius || distance === 0) return { x: dx, y: dy };
  const scale = radius / distance;
  return { x: dx * scale, y: dy * scale };
}

export interface DirectionalKeys {
  readonly forward: boolean;
  readonly back: boolean;
  readonly left: boolean;
  readonly right: boolean;
  readonly sprint: boolean;
}

export const NEUTRAL_DIRECTIONAL_KEYS: DirectionalKeys = {
  forward: false,
  back: false,
  left: false,
  right: false,
  sprint: false,
};

/** Below this fraction of full deflection on an axis, that axis reads as not-pressed — keeps a barely-nudged stick from registering full WASD input. */
export const AXIS_ACTIVATION_THRESHOLD = 0.35;
/** At/above this magnitude, sprint engages — "sprint at full deflection" per the touch-controls spec. */
export const SPRINT_MAGNITUDE_THRESHOLD = 0.92;

/**
 * Maps an analog joystick vector onto the same digital WASD(+sprint) intent
 * the keyboard path produces. `PlayController`/`FlyController` only
 * understand discrete key presses (`setKey`), so touch drives them exactly
 * the way a keyboard would rather than needing a separate analog-speed API —
 * see `ModeManager.setVirtualKey`. Screen-down is +y, so "forward" (stick
 * pushed up) is negative y; a diagonal push activates two keys at once, same
 * as holding e.g. W+D on a keyboard.
 */
export function joystickToDirectionalKeys(vector: JoystickVector): DirectionalKeys {
  if (vector.magnitude === 0) return NEUTRAL_DIRECTIONAL_KEYS;
  return {
    forward: vector.y < -AXIS_ACTIVATION_THRESHOLD,
    back: vector.y > AXIS_ACTIVATION_THRESHOLD,
    left: vector.x < -AXIS_ACTIVATION_THRESHOLD,
    right: vector.x > AXIS_ACTIVATION_THRESHOLD,
    sprint: vector.magnitude >= SPRINT_MAGNITUDE_THRESHOLD,
  };
}
