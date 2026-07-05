/**
 * Pure math for render-time interpolation between fixed sim steps (see
 * `Engine.ts`'s `alpha` and `EntityRenderer.update`). Lives in `entities/`
 * rather than `engine/` because it's domain-agnostic numeric helpers with no
 * Three.js dependency, consumed by both `EntitySimulation` (teleport
 * detection) and `EntityRenderer` (the actual lerp) — keeping it here means
 * the presentation layer depends on the domain layer, not the reverse.
 */

/** Linear interpolation from `a` to `b` at fraction `t` (not clamped -- callers already pass `alpha` in [0,1)). */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

const TAU = Math.PI * 2;

/**
 * Interpolates an angle (radians) from `a` to `b` via the shorter arc, so a
 * heading crossing the +-pi wraparound (e.g. turning from just past +pi to
 * just past -pi) turns the short way instead of the naive `lerp`, which would
 * sweep almost a full revolution the wrong way.
 *
 * At the exact tie (`b - a` is exactly +-pi, both arcs equally short) this
 * resolves deterministically toward the positive-delta arc -- see the unit
 * tests for the exact values that choice produces.
 */
export function shortestArcLerp(a: number, b: number, t: number): number {
  let delta = (b - a) % TAU;
  if (delta > Math.PI) delta -= TAU;
  else if (delta < -Math.PI) delta += TAU;
  return a + delta * t;
}

/**
 * Generous multiplier above the `speed * dt` bound every entity step function
 * already enforces (see `stepPedestrian` / `stepVehicle` /
 * `stepFlyingVehicle`'s own `min(dist, speed * dt)` clamps), used by
 * `isTeleportJump` below. Wide enough that legitimate single-tick motion --
 * plus, for ground vehicles, `applyVehicleFollowSpacing`'s small same-tick
 * position correction -- never false-triggers it, while still catching a
 * genuine multi-cell teleport (spawn, respawn, or any future "snap to X"
 * feature) that must not be smeared across a render frame.
 */
export const TELEPORT_SAFETY_FACTOR = 8;

/**
 * True if moving from (`prevX`,`prevY`,`prevZ`) to (`x`,`y`,`z`) in one fixed
 * tick at `speed` is farther than any legitimate single-tick movement could
 * plausibly cover -- i.e. a teleport/respawn discontinuity, not organic
 * motion, and the caller should snap `prev` to the current state rather than
 * let `EntityRenderer` interpolate (smear) across it. Position-only entities
 * (ground vehicles, flying vehicles) pass `0` for both `y` and `prevY`.
 */
export function isTeleportJump(
  prevX: number,
  prevY: number,
  prevZ: number,
  x: number,
  y: number,
  z: number,
  speed: number,
  dt: number,
): boolean {
  const maxDistance = speed * dt * TELEPORT_SAFETY_FACTOR;
  const dx = x - prevX;
  const dy = y - prevY;
  const dz = z - prevZ;
  return dx * dx + dy * dy + dz * dz > maxDistance * maxDistance;
}
