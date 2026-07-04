/**
 * Flying (hover-car) vehicle simulation: straight-line flight along a fixed
 * `SkyLane` at a fixed altitude. Pure state + step function, no Three.js —
 * mirrors `Vehicle.ts`'s shape, but deliberately simpler: a sky lane is a
 * single straight corridor with no intersections or flow field to consult
 * (see `SkyLane.ts`), so a flying vehicle picks one heading at spawn and
 * never turns, despawning the moment it crosses the world edge. Turning at
 * the edge (the other option requirement #1 allows) was rejected — a lane
 * spans the *entire* world extent already, so "turning" would just be
 * flying back the way it came, which reads as a car doing a U-turn in
 * mid-air rather than a car that flew off into the distance.
 */

import type { SkyLane } from './SkyLane';

export interface FlyingVehicle {
  /** Continuous world position. */
  x: number;
  z: number;
  /** Fixed flight altitude for this vehicle's whole lifetime (its lane's `altitude`). */
  readonly y: number;
  /** Fixed heading: one of -1/0/1 per axis, exactly one axis nonzero, set once at spawn and never changed. */
  readonly dirX: number;
  readonly dirZ: number;
  speed: number;
  /** False once the vehicle has crossed the world edge — the simulation removes it next tick. */
  alive: boolean;
}

/** Spawns a flying vehicle on `lane` at travel-axis coordinate `travelCoord`, heading `direction` (+1 or -1) along the lane's axis. */
export function createFlyingVehicleOnLane(
  lane: SkyLane,
  travelCoord: number,
  direction: 1 | -1,
  speed: number,
): FlyingVehicle {
  const dirX = lane.axis === 'x' ? direction : 0;
  const dirZ = lane.axis === 'z' ? direction : 0;
  const x = lane.axis === 'x' ? travelCoord : lane.fixed;
  const z = lane.axis === 'z' ? travelCoord : lane.fixed;
  return { x, z, y: lane.altitude, dirX, dirZ, speed, alive: true };
}

/** Advances a flying vehicle by `dt` seconds along its fixed heading, despawning it the instant it crosses the world bounds. */
export function stepFlyingVehicle(vehicle: FlyingVehicle, dt: number, worldSizeX: number, worldSizeZ: number): void {
  if (!vehicle.alive) return;

  vehicle.x += vehicle.dirX * vehicle.speed * dt;
  vehicle.z += vehicle.dirZ * vehicle.speed * dt;

  if (vehicle.x < 0 || vehicle.x >= worldSizeX || vehicle.z < 0 || vehicle.z >= worldSizeZ) {
    vehicle.alive = false;
  }
}
