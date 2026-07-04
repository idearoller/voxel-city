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
  speed: number;
  /** False once the vehicle has driven off the road network (dead end / map edge) — the simulation removes it next tick. */
  alive: boolean;
}

const ARRIVE_EPS = 0.02;

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
