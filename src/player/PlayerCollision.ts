/**
 * Axis-separated AABB-vs-voxel-grid collision, pure world-data-in/result-out
 * (mirrors ChunkMesher's buildChunkMeshData pattern) so it is unit-testable
 * without Three.js or a real World. Consumed by PlayController.
 */

export const PLAYER_WIDTH = 0.6;
export const PLAYER_HEIGHT = 1.8;
const PLAYER_HALF_WIDTH = PLAYER_WIDTH / 2;

export const AUTO_STEP_LIFT = 1.05;

export type IsSolidFn = (x: number, y: number, z: number) => boolean;

export interface Aabb {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}

/** Builds the player's AABB from its feet (bottom-center) position. */
export function aabbFromFeet(feet: readonly [number, number, number]): Aabb {
  const [x, y, z] = feet;
  return {
    minX: x - PLAYER_HALF_WIDTH,
    maxX: x + PLAYER_HALF_WIDTH,
    minY: y,
    maxY: y + PLAYER_HEIGHT,
    minZ: z - PLAYER_HALF_WIDTH,
    maxZ: z + PLAYER_HALF_WIDTH,
  };
}

function translateAabb(box: Aabb, dx: number, dy: number, dz: number): Aabb {
  return {
    minX: box.minX + dx,
    maxX: box.maxX + dx,
    minY: box.minY + dy,
    maxY: box.maxY + dy,
    minZ: box.minZ + dz,
    maxZ: box.maxZ + dz,
  };
}

const EPS = 1e-6;

/** Inclusive [lo, hi] voxel index range covered by a [min, max) span. */
function voxelSpan(min: number, max: number): { lo: number; hi: number } {
  return { lo: Math.floor(min), hi: Math.floor(max - EPS) };
}

/** True if any solid voxel overlaps the given AABB. */
export function aabbIntersectsSolid(isSolid: IsSolidFn, box: Aabb): boolean {
  const xs = voxelSpan(box.minX, box.maxX);
  const ys = voxelSpan(box.minY, box.maxY);
  const zs = voxelSpan(box.minZ, box.maxZ);
  for (let x = xs.lo; x <= xs.hi; x++) {
    for (let y = ys.lo; y <= ys.hi; y++) {
      for (let z = zs.lo; z <= zs.hi; z++) {
        if (isSolid(x, y, z)) return true;
      }
    }
  }
  return false;
}

/** True if the unit voxel cube at `voxel` overlaps the given AABB. */
export function voxelIntersectsAabb(voxel: readonly [number, number, number], box: Aabb): boolean {
  const [x, y, z] = voxel;
  return (
    x < box.maxX &&
    x + 1 > box.minX &&
    y < box.maxY &&
    y + 1 > box.minY &&
    z < box.maxZ &&
    z + 1 > box.minZ
  );
}

type AxisIndex = 0 | 1 | 2;

function otherAxes(axis: AxisIndex): [AxisIndex, AxisIndex] {
  if (axis === 0) return [1, 2];
  if (axis === 1) return [0, 2];
  return [0, 1];
}

function minOf(box: Aabb, axis: AxisIndex): number {
  return axis === 0 ? box.minX : axis === 1 ? box.minY : box.minZ;
}

function maxOf(box: Aabb, axis: AxisIndex): number {
  return axis === 0 ? box.maxX : axis === 1 ? box.maxY : box.maxZ;
}

/** Maps a value on `axis` plus fixed values on the other two axes to an (x, y, z) triple. */
function coordFor(axis: AxisIndex, value: number, others: [AxisIndex, AxisIndex], a: number, b: number): [number, number, number] {
  const coord: [number, number, number] = [0, 0, 0];
  coord[axis] = value;
  coord[others[0]] = a;
  coord[others[1]] = b;
  return coord;
}

interface AxisMoveResult {
  delta: number;
  collided: boolean;
}

/**
 * Resolves movement of `box` along a single axis by `delta`, clamping to the
 * nearest solid voxel plane encountered. The other two axes are held fixed
 * (per the plan's axis-separated X, then Z, then Y resolve order).
 */
function resolveAxisMove(isSolid: IsSolidFn, box: Aabb, axis: AxisIndex, delta: number): AxisMoveResult {
  if (delta === 0) return { delta: 0, collided: false };

  const others = otherAxes(axis);
  const rangeA = voxelSpan(minOf(box, others[0]), maxOf(box, others[0]));
  const rangeB = voxelSpan(minOf(box, others[1]), maxOf(box, others[1]));

  const dir = delta > 0 ? 1 : -1;
  const leading = dir > 0 ? maxOf(box, axis) : minOf(box, axis);
  const target = leading + delta;

  let v = dir > 0 ? Math.floor(leading) : Math.ceil(leading) - 1;
  const limit = dir > 0 ? Math.floor(target - EPS) : Math.ceil(target + EPS) - 1;

  while (dir > 0 ? v <= limit : v >= limit) {
    let blocked = false;
    for (let a = rangeA.lo; a <= rangeA.hi && !blocked; a++) {
      for (let b = rangeB.lo; b <= rangeB.hi && !blocked; b++) {
        const coord = coordFor(axis, v, others, a, b);
        if (isSolid(coord[0], coord[1], coord[2])) blocked = true;
      }
    }
    if (blocked) {
      const blockPlane = dir > 0 ? v : v + 1;
      return { delta: blockPlane - leading, collided: true };
    }
    v += dir;
  }
  return { delta, collided: false };
}

interface HorizontalResolveResult {
  box: Aabb;
  dx: number;
  dz: number;
  collidedX: boolean;
  collidedZ: boolean;
}

/** Resolves X then Z movement of `box` by (dx, dz) against solid voxels, Y held fixed. */
function resolveHorizontal(isSolid: IsSolidFn, box: Aabb, dx: number, dz: number): HorizontalResolveResult {
  const xMove = resolveAxisMove(isSolid, box, 0, dx);
  const afterX = translateAabb(box, xMove.delta, 0, 0);

  const zMove = resolveAxisMove(isSolid, afterX, 2, dz);
  const afterZ = translateAabb(afterX, 0, 0, zMove.delta);

  return {
    box: afterZ,
    dx: xMove.delta,
    dz: zMove.delta,
    collidedX: xMove.collided,
    collidedZ: zMove.collided,
  };
}

export interface MoveResult {
  position: readonly [number, number, number];
  velocity: readonly [number, number, number];
  grounded: boolean;
}

/**
 * Integrates one tick of movement for a feet-anchored AABB, resolving X then
 * Z then Y against solid voxels. Collided axes have their velocity zeroed;
 * `grounded` is true when a downward Y move was blocked (landed on a floor).
 */
export function moveAndCollide(
  isSolid: IsSolidFn,
  feet: readonly [number, number, number],
  velocity: readonly [number, number, number],
  dt: number,
): MoveResult {
  const startBox = aabbFromFeet(feet);
  let vx = velocity[0];
  let vy = velocity[1];
  let vz = velocity[2];
  let grounded = false;

  const horizontal = resolveHorizontal(isSolid, startBox, vx * dt, vz * dt);
  if (horizontal.collidedX) vx = 0;
  if (horizontal.collidedZ) vz = 0;

  const yMove = resolveAxisMove(isSolid, horizontal.box, 1, vy * dt);
  const box = translateAabb(horizontal.box, 0, yMove.delta, 0);
  if (yMove.collided) {
    if (vy < 0) grounded = true;
    vy = 0;
  }

  const position: readonly [number, number, number] = [
    box.minX + PLAYER_HALF_WIDTH,
    box.minY,
    box.minZ + PLAYER_HALF_WIDTH,
  ];

  return { position, velocity: [vx, vy, vz], grounded };
}

export interface AutoStepResult {
  position: readonly [number, number, number];
  stepped: boolean;
}

/** Minimum extra horizontal progress the lifted resolve must gain over the grounded resolve to count as a step. */
const STEP_PROGRESS_EPS = 1e-9;

/**
 * Minecraft-style single-voxel auto-step. Lifts the AABB by AUTO_STEP_LIFT
 * and re-runs the *full* horizontal collision resolve (not a binary
 * clear/blocked check) from the lifted box; if that reaches further than the
 * grounded resolve would, the raised feet Y is committed and gravity/Y-resolve
 * settle the player onto the step over subsequent ticks. This works with
 * realistic sub-voxel per-tick displacements (e.g. ~0.075m at 4.5 m/s @
 * 60Hz) because it compares *progress*, not whether a full voxel was
 * crossed — the old floor-probe design demanded the advanced footprint
 * reach the next voxel column, which a single tick's movement never does.
 * Refuses taller (2+ voxel) obstacles, since lifting doesn't help there, and
 * refuses outright when not grounded.
 */
export function tryAutoStep(
  isSolid: IsSolidFn,
  feet: readonly [number, number, number],
  moveX: number,
  moveZ: number,
  grounded: boolean,
): AutoStepResult {
  const fallback: AutoStepResult = { position: feet, stepped: false };
  if (!grounded) return fallback;
  if (moveX === 0 && moveZ === 0) return fallback;

  const groundBox = aabbFromFeet(feet);
  const groundResolved = resolveHorizontal(isSolid, groundBox, moveX, moveZ);
  const groundProgress = Math.hypot(groundResolved.dx, groundResolved.dz);

  const liftedFeet: readonly [number, number, number] = [feet[0], feet[1] + AUTO_STEP_LIFT, feet[2]];
  const liftedBox = aabbFromFeet(liftedFeet);
  if (aabbIntersectsSolid(isSolid, liftedBox)) return fallback; // no headroom to even lift here

  const liftedResolved = resolveHorizontal(isSolid, liftedBox, moveX, moveZ);
  const liftedProgress = Math.hypot(liftedResolved.dx, liftedResolved.dz);

  if (liftedProgress <= groundProgress + STEP_PROGRESS_EPS) return fallback;

  return {
    position: [feet[0] + liftedResolved.dx, feet[1] + AUTO_STEP_LIFT, feet[2] + liftedResolved.dz],
    stepped: true,
  };
}

/**
 * A kinematic moving/parked floor a player can stand and ride on — e.g. an
 * elevator platform (see `elevators/ElevatorSystem.ts`). This is the whole of
 * PlayerCollision's "moving support surface" extension: everything else
 * (gravity, jump, grounded detection) composes with it unmodified because
 * `PlayController` folds the support into its per-tick `isSolid` query (a
 * synthetic solid voxel slab at the platform's current Y) rather than
 * teaching this module a second kind of collider.
 */
export interface SupportSurface {
  /** World-space horizontal footprint the platform currently occupies. */
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  /** World Y of the platform's current walkable top surface (feet rest here). */
  surfaceY: number;
  /** How far the surface moved vertically since last tick — added to a riding player's feet.y to carry them along. */
  deltaY: number;
}

/** Horizontal/vertical tolerance for "close enough to the surface to count as riding it," not just passing through its column. */
const SUPPORT_RIDE_EPS = 0.01;

/**
 * True if `feet` is horizontally over `support`'s footprint and vertically
 * resting on its surface — checked against the surface's *previous* Y
 * (`surfaceY - deltaY`), not its just-updated one. `feet` was last placed
 * flush with wherever the surface was *before* this tick's move (either at
 * rest, or carried there by the previous tick's carry step), so comparing
 * against the surface's already-moved position would spuriously fail by
 * exactly `deltaY` every tick the platform is in motion.
 */
export function isStandingOnSupport(feet: readonly [number, number, number], support: SupportSurface): boolean {
  const [x, y, z] = feet;
  const onFootprint =
    x + PLAYER_HALF_WIDTH > support.minX &&
    x - PLAYER_HALF_WIDTH < support.maxX &&
    z + PLAYER_HALF_WIDTH > support.minZ &&
    z - PLAYER_HALF_WIDTH < support.maxZ;
  const previousSurfaceY = support.surfaceY - support.deltaY;
  return onFootprint && Math.abs(y - previousSurfaceY) <= SUPPORT_RIDE_EPS;
}

/**
 * True if voxel (x, y, z) should be treated as solid because it falls inside
 * `support`'s current one-voxel-thick backstop slab: the row directly under
 * `floor(surfaceY)` (mirroring how a normal floor's solid voxel sits at
 * `feetY - 1`), so this slots into an `IsSolidFn` alongside `world.isSolid`.
 * This is deliberately a *backstop*, not the mechanism that holds a rider
 * exactly on a fractional (mid-transit) surfaceY — voxel collision can only
 * resolve against integer row boundaries, so `PlayController` holds riders in
 * place by directly snapping to `surfaceY` (see its `update()`); this slab
 * just keeps a fall from ever tunnelling more than one voxel past it.
 */
export function isVoxelInsideSupport(x: number, y: number, z: number, support: SupportSurface): boolean {
  const slabY = Math.floor(support.surfaceY) - 1;
  if (y !== slabY) return false;
  return x >= Math.floor(support.minX) && x < Math.ceil(support.maxX) && z >= Math.floor(support.minZ) && z < Math.ceil(support.maxZ);
}

/**
 * Scans straight down from `topY` at the given xz column for the first solid
 * voxel and returns feet coordinates resting on top of it, or null if the
 * column is solid-free all the way to y=0 (caller should fall back to a
 * known-safe spawn point).
 */
export function findSpawnFeet(
  isSolid: IsSolidFn,
  x: number,
  z: number,
  topY: number,
): readonly [number, number, number] | null {
  for (let y = topY; y >= 0; y--) {
    if (isSolid(x, y, z)) {
      return [x, y + 1, z];
    }
  }
  return null;
}
