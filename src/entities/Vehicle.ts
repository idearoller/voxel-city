/**
 * Vehicle simulation: cell-to-cell driving along the road grid's flow
 * field (see `NavGrid.computeFlowField`). Pure state + step function, no
 * Three.js. Vehicles prefer continuing straight in their current heading —
 * which keeps them in-lane through an intersection instead of always
 * bending onto the flow field's tie-broken axis — and only consult the flow
 * field again when going straight is no longer possible (a turn is required,
 * or the road ends).
 *
 * That turn-time flow read is deliberately NOT re-checked on every
 * subsequent tick: `computeFlowField` resolves each cell's axis/lane purely
 * from a local, radius-bounded probe (see `NavGrid.runLength`/`bandPosition`),
 * which is only ever a heuristic at the tie-broken cells sitting right on a
 * perpendicular corridor's edge — two adjacent cells there can genuinely
 * disagree on which way the same axis flows. Re-validating heading against
 * the current cell every tick (tried during this fix's development) makes a
 * vehicle oscillate forever the moment it straddles one of those cells,
 * which is worse than the bug it was meant to fix. Instead, the turn itself
 * is the only place a bad read can do lasting damage — see
 * `pickStableLane`, which snaps sideways to a nearby lane whose flow is
 * self-consistent (i.e. still agrees with itself one more step out) before
 * committing to a new heading, so a turn can never lock a vehicle onto a
 * lane that immediately contradicts itself.
 */

import { isRoadCell, type NavGrid } from './NavGrid';
import { approachSpeed, computeFollowOrder, followTargetSpeed, type LaneMember } from './traffic';

export interface Vehicle {
  /** Continuous world position, mid-drive between cell centers. */
  x: number;
  z: number;
  /** The road cell this vehicle is currently driving towards. */
  cellX: number;
  cellZ: number;
  /** Current heading: one of -1/0/1 per axis, at most one axis nonzero. Zero,zero only at the instant of spawn. */
  dirX: number;
  dirZ: number;
  /** Current actual speed — smoothly approaches `cruiseSpeed` when the lane ahead is clear, and eases down when following a slower vehicle (see `applyVehicleFollowSpacing`). */
  speed: number;
  /** Preferred free-flow speed, fixed for this vehicle's whole lifetime — what `speed` returns to once the vehicle ahead pulls away. */
  readonly cruiseSpeed: number;
  /** False once the vehicle has driven off the road network (dead end / map edge) — the simulation removes it next tick. */
  alive: boolean;
}

const ARRIVE_EPS = 0.02;

/**
 * Hard floor on center-to-center distance between two same-lane,
 * same-direction vehicles — chosen against `VEHICLE_BODY_GEOMETRY` in
 * `EntityRenderer.ts` (1.6 wide x 3.2 long): comfortably longer than one car
 * body plus a visible gap, so a stopped leader never reads as overlapping
 * (or clipping into) the vehicle behind it.
 */
export const VEHICLE_MIN_SEPARATION = 4;
/** Gap at which a following vehicle starts easing off cruise speed to match the vehicle ahead — comfortably past `VEHICLE_MIN_SEPARATION` so the slowdown reads as smooth traffic, not a last-second brake check. */
export const VEHICLE_FOLLOW_DISTANCE = 10;
/** Per-second speed change cap — smooths accel/decel so speed changes read as easing, never a teleporting speed jump. */
export const VEHICLE_MAX_ACCEL = 8;

/** Spawns a vehicle already centered on (cellX, cellZ) — its first `step` will immediately pick a real heading from the flow field. */
export function createVehicleAt(cellX: number, cellZ: number, speed: number): Vehicle {
  return {
    x: cellX + 0.5,
    z: cellZ + 0.5,
    cellX,
    cellZ,
    dirX: 0,
    dirZ: 0,
    speed,
    cruiseSpeed: speed,
    alive: true,
  };
}

function cellFlow(grid: NavGrid, x: number, z: number): { flowX: number; flowZ: number } {
  const i = x + z * grid.width;
  return { flowX: grid.flowX[i] as number, flowZ: grid.flowZ[i] as number };
}

/**
 * True if driving one more step in (dirX, dirZ) from (x, z) wouldn't
 * immediately contradict itself: either the next cell isn't part of the
 * lane's own axis at all (nothing to contradict), or its flow on that axis
 * agrees. A cell whose own next-step read disagrees with the direction it
 * was just chosen for is exactly the tie-broken-corner case described in
 * this module's doc comment — a lane that isn't safe to commit a turn to.
 */
function laneIsStable(grid: NavGrid, x: number, z: number, dirX: number, dirZ: number): boolean {
  const aheadX = x + dirX;
  const aheadZ = z + dirZ;
  if (!isRoadCell(grid, aheadX, aheadZ)) return true; // dead end ahead is handled separately by the caller, not a stability problem
  const { flowX, flowZ } = cellFlow(grid, aheadX, aheadZ);
  if (dirX !== 0 && flowX !== 0) return flowX === dirX;
  if (dirZ !== 0 && flowZ !== 0) return flowZ === dirZ;
  return true;
}

/**
 * Snaps sideways (perpendicular to (dirX, dirZ)) from (x, z) to the nearest
 * lane whose own flow both matches (dirX, dirZ) and is itself stable, if
 * (x, z) isn't already stable. Search radius is small — this only ever
 * fires right at a turn, correcting a single tie-broken cell, not routing
 * around real geometry — and falls back to (x, z) unchanged if nothing
 * better turns up nearby (naive behavior beats refusing to move at all).
 */
function pickStableLane(
  grid: NavGrid,
  x: number,
  z: number,
  dirX: number,
  dirZ: number,
): { x: number; z: number } {
  if (laneIsStable(grid, x, z, dirX, dirZ)) return { x, z };

  const perpX = dirX === 0 ? 1 : 0;
  const perpZ = dirZ === 0 ? 1 : 0;
  for (const offset of [1, -1, 2, -2]) {
    const cx = x + perpX * offset;
    const cz = z + perpZ * offset;
    if (!isRoadCell(grid, cx, cz)) continue;
    const { flowX, flowZ } = cellFlow(grid, cx, cz);
    const matches = (dirX === 0 || flowX === dirX) && (dirZ === 0 || flowZ === dirZ);
    if (matches && laneIsStable(grid, cx, cz, dirX, dirZ)) return { x: cx, z: cz };
  }
  return { x, z };
}

function advanceCell(vehicle: Vehicle, grid: NavGrid): void {
  if (!isRoadCell(grid, vehicle.cellX, vehicle.cellZ)) {
    vehicle.alive = false;
    return;
  }

  const hasHeading = vehicle.dirX !== 0 || vehicle.dirZ !== 0;
  const straightX = vehicle.cellX + vehicle.dirX;
  const straightZ = vehicle.cellZ + vehicle.dirZ;
  if (hasHeading && isRoadCell(grid, straightX, straightZ)) {
    vehicle.cellX = straightX;
    vehicle.cellZ = straightZ;
    return;
  }

  // Straight ahead is blocked (or this is the first cell) — defer to this
  // cell's own flow field: a turn, or (if it too points off-road) a dead
  // end. Before committing, snap onto a nearby lane that's actually stable
  // in this direction (see `pickStableLane`) so the turn can't lock the
  // vehicle onto a self-contradicting cell.
  const { flowX, flowZ } = cellFlow(grid, vehicle.cellX, vehicle.cellZ);
  if (flowX === 0 && flowZ === 0) {
    vehicle.alive = false;
    return;
  }

  const lane = pickStableLane(grid, vehicle.cellX, vehicle.cellZ, flowX, flowZ);
  const nextX = lane.x + flowX;
  const nextZ = lane.z + flowZ;
  if (!isRoadCell(grid, nextX, nextZ)) {
    vehicle.alive = false;
    return;
  }

  vehicle.dirX = flowX;
  vehicle.dirZ = flowZ;
  vehicle.cellX = nextX;
  vehicle.cellZ = nextZ;
}

/** Advances a vehicle by `dt` seconds: drives toward its current target cell center, re-steering on arrival. */
export function stepVehicle(vehicle: Vehicle, dt: number, grid: NavGrid): void {
  if (!vehicle.alive) return;

  const targetX = vehicle.cellX + 0.5;
  const targetZ = vehicle.cellZ + 0.5;
  const toX = targetX - vehicle.x;
  const toZ = targetZ - vehicle.z;
  const dist = Math.hypot(toX, toZ);

  if (dist < ARRIVE_EPS) {
    vehicle.x = targetX;
    vehicle.z = targetZ;
    advanceCell(vehicle, grid);
    return;
  }

  const step = Math.min(dist, vehicle.speed * dt);
  vehicle.x += (toX / dist) * step;
  vehicle.z += (toZ / dist) * step;
}

/**
 * Lane identity for follow-spacing purposes: same heading (direction) plus
 * same cross-axis cell (the column a north/south-bound vehicle is in, or
 * the row an east/west-bound one is in) — exactly the granularity
 * `pickStableLane` snaps a turn onto, so two vehicles sharing this key are
 * genuinely driving the same physical corridor, never a merely-adjacent
 * lane. A vehicle with no heading yet (dirX === dirZ === 0, the single
 * instant right after spawn, before its first `stepVehicle` call resolves
 * one) gets a key nothing else can share, so it's simply excluded from any
 * lane's leader/follower relationship until it has a real heading.
 */
function laneKey(vehicle: Vehicle, index: number): string {
  if (vehicle.dirX === 0 && vehicle.dirZ === 0) return `solo-${index}`;
  const crossCoord = vehicle.dirX !== 0 ? vehicle.cellZ : vehicle.cellX;
  return `${vehicle.dirX},${vehicle.dirZ},${crossCoord}`;
}

/** Signed position along the vehicle's own direction of travel — increases as it moves forward, whichever world axis/sign that is. */
function travelPos(vehicle: Vehicle): number {
  return vehicle.dirX !== 0 ? vehicle.x * vehicle.dirX : vehicle.z * vehicle.dirZ;
}

/** Writes `pos` back onto whichever of `x`/`z` is this vehicle's travel axis, leaving the fixed cross-axis coordinate untouched. */
function setTravelPos(vehicle: Vehicle, pos: number): void {
  if (vehicle.dirX !== 0) vehicle.x = pos * vehicle.dirX;
  else vehicle.z = pos * vehicle.dirZ;
}

/**
 * Same-lane follow-the-leader spacing: call once per tick, after every
 * vehicle has already been stepped by `stepVehicle`. For each vehicle with
 * one directly ahead of it in the same lane (see `laneKey`), this:
 *
 * 1. Hard-clamps its position so it's never closer than
 *    `VEHICLE_MIN_SEPARATION` from the leader — an absolute floor, not just
 *    a speed suggestion, so two vehicles can never overlap regardless of
 *    how they got close (a sudden lane join at a turn, a leader braking
 *    harder than this tick's `VEHICLE_MAX_ACCEL` can react to, etc).
 * 2. Eases `speed` toward the leader's speed (capped at this vehicle's own
 *    `cruiseSpeed`) once the gap closes inside `VEHICLE_FOLLOW_DISTANCE`,
 *    and back toward `cruiseSpeed` once the gap opens back up — smoothed by
 *    `VEHICLE_MAX_ACCEL` so the speed change reads as easing, not a jump.
 *
 * Processes each lane leader-first (see `computeFollowOrder`), so a
 * follower's clamp always measures against its leader's *final* corrected
 * position for this tick — correctness cascades down a stopped queue
 * instead of each vehicle only reacting to last tick's stale gap.
 */
export function applyVehicleFollowSpacing(vehicles: readonly Vehicle[], dt: number): void {
  const members: LaneMember[] = vehicles.map((vehicle, index) => ({
    laneKey: laneKey(vehicle, index),
    travelPos: travelPos(vehicle),
  }));
  const { leaderIndex, order } = computeFollowOrder(members);
  const maxDelta = VEHICLE_MAX_ACCEL * dt;

  for (const idx of order) {
    const vehicle = vehicles[idx] as Vehicle;
    const leader = leaderIndex[idx] as number;

    if (leader === -1) {
      vehicle.speed = approachSpeed(vehicle.speed, vehicle.cruiseSpeed, maxDelta);
      continue;
    }

    const leaderVehicle = vehicles[leader] as Vehicle;
    let gap = travelPos(leaderVehicle) - travelPos(vehicle);
    if (gap < VEHICLE_MIN_SEPARATION) {
      setTravelPos(vehicle, travelPos(leaderVehicle) - VEHICLE_MIN_SEPARATION);
      gap = VEHICLE_MIN_SEPARATION;
    }

    const target = followTargetSpeed(gap, vehicle.cruiseSpeed, leaderVehicle.speed, VEHICLE_MIN_SEPARATION, VEHICLE_FOLLOW_DISTANCE);
    vehicle.speed = approachSpeed(vehicle.speed, target, maxDelta);
  }
}
