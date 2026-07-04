/**
 * Vehicle simulation: cell-to-cell driving along the road grid's flow
 * field (see `NavGrid.computeFlowField`). Pure state + step function, no
 * Three.js. Vehicles prefer continuing straight in their current heading —
 * which keeps them in-lane through an intersection instead of always
 * bending onto the flow field's tie-broken axis — and only consult the
 * flow field again when going straight is no longer possible (a turn is
 * required, or the road ends).
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
  // cell's own flow field: a turn, or (if it too points off-road) a dead end.
  const { flowX, flowZ } = cellFlow(grid, vehicle.cellX, vehicle.cellZ);
  const nextX = vehicle.cellX + flowX;
  const nextZ = vehicle.cellZ + flowZ;
  if ((flowX === 0 && flowZ === 0) || !isRoadCell(grid, nextX, nextZ)) {
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
