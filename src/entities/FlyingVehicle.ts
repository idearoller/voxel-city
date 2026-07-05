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
import { approachSpeed, computeFollowOrder, followTargetSpeed, type LaneMember } from './traffic';

export interface FlyingVehicle {
  /** Continuous world position. */
  x: number;
  z: number;
  /** Fixed flight altitude for this vehicle's whole lifetime (its lane's `altitude`). */
  readonly y: number;
  /** Fixed heading: one of -1/0/1 per axis, exactly one axis nonzero, set once at spawn and never changed. */
  readonly dirX: number;
  readonly dirZ: number;
  /** Current actual speed — smoothly approaches `cruiseSpeed` when the lane ahead is clear, and eases down when following a slower vehicle ahead (see `applyFlyingVehicleFollowSpacing`). */
  speed: number;
  /** Preferred free-flow speed, fixed for this vehicle's whole lifetime — what `speed` returns to once the vehicle ahead pulls away. */
  readonly cruiseSpeed: number;
  /** False once the vehicle has crossed the world edge — the simulation removes it next tick. */
  alive: boolean;
}

/**
 * Hard floor on center-to-center distance between two same-lane,
 * same-direction flying vehicles — chosen against
 * `FLYING_VEHICLE_BODY_GEOMETRY` in `EntityRenderer.ts` (1.4 wide x 4.5
 * long): comfortably longer than one hover-car body plus a visible gap.
 */
export const FLYING_VEHICLE_MIN_SEPARATION = 6;
/** Gap at which a following flying vehicle starts easing off cruise speed to match the one ahead. */
export const FLYING_VEHICLE_FOLLOW_DISTANCE = 16;
/** Per-second speed change cap — flying traffic is faster than ground traffic (see `EntitySimulationConfig`), so it gets proportionally more accel/decel headroom while still easing rather than jumping. */
export const FLYING_VEHICLE_MAX_ACCEL = 12;

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
  return { x, z, y: lane.altitude, dirX, dirZ, speed, cruiseSpeed: speed, alive: true };
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

/**
 * Lane identity for follow-spacing purposes: `dirX`/`dirZ` (fixed for a
 * flying vehicle's whole lifetime) already encode both the travel axis and
 * the direction along it, so folding them straight into the key keeps this
 * deliberately direction-sensitive — a sky lane is bidirectional (see this
 * module's doc comment), and an opposite-direction flyer sharing the same
 * physical corridor is explicitly out of scope for this follow-distance
 * feature (oncoming avoidance is a separate concern this lane model doesn't
 * yet handle at all), so it must never contribute a leader/follower
 * relationship here.
 */
function laneKey(vehicle: FlyingVehicle): string {
  const crossCoord = vehicle.dirX !== 0 ? vehicle.z : vehicle.x;
  return `${vehicle.dirX},${vehicle.dirZ},${crossCoord}`;
}

/** Signed position along the vehicle's own direction of travel — increases as it moves forward, whichever world axis/sign that is. */
function travelPos(vehicle: FlyingVehicle): number {
  return vehicle.dirX !== 0 ? vehicle.x * vehicle.dirX : vehicle.z * vehicle.dirZ;
}

/** Writes `pos` back onto whichever of `x`/`z` is this vehicle's travel axis, leaving the fixed cross-axis coordinate untouched. */
function setTravelPos(vehicle: FlyingVehicle, pos: number): void {
  if (vehicle.dirX !== 0) vehicle.x = pos * vehicle.dirX;
  else vehicle.z = pos * vehicle.dirZ;
}

/**
 * Same-lane follow-the-leader spacing for flying traffic — see
 * `applyVehicleFollowSpacing` in `Vehicle.ts` for the full behavioral
 * rationale (this mirrors its *hard*-clamp behavior exactly, just with the
 * flying-vehicle-specific lane key, constants, and `x`/`z`/`speed` fields).
 * Call once per tick, after every flying vehicle has already been stepped
 * by `stepFlyingVehicle`.
 *
 * Deliberately NOT ported: `Vehicle.ts`'s birth-intrusion carve-out (see its
 * doc comment). That exists because a *ground* vehicle can join a lane
 * mid-flight, at a turn, right next to a leader it never had a relationship
 * with a moment ago. A flying vehicle never turns (this module's doc
 * comment) — the only way it ever joins a lane is at spawn, via
 * `createFlyingVehicleOnLane`, and every spawn site already runs
 * `isSpawnClearOfVehicles` against `FLYING_VEHICLE_MIN_SEPARATION` first
 * (see `EntitySimulation.trySpawnFlyingVehicle`). Two vehicles sharing a
 * lane key share the same cross-axis coordinate by construction, so that
 * spawn-time straight-line check *is* the along-lane gap check for same-lane
 * pairs — the birth-intrusion precondition this carve-out exists for can't
 * arise here. Keeping the simpler hard clamp is correct, not an oversight.
 */
export function applyFlyingVehicleFollowSpacing(vehicles: readonly FlyingVehicle[], dt: number): void {
  const members: LaneMember[] = vehicles.map((vehicle) => ({
    laneKey: laneKey(vehicle),
    travelPos: travelPos(vehicle),
  }));
  const { leaderIndex, order } = computeFollowOrder(members);
  const maxDelta = FLYING_VEHICLE_MAX_ACCEL * dt;

  for (const idx of order) {
    const vehicle = vehicles[idx] as FlyingVehicle;
    const leader = leaderIndex[idx] as number;

    if (leader === -1) {
      vehicle.speed = approachSpeed(vehicle.speed, vehicle.cruiseSpeed, maxDelta);
      continue;
    }

    const leaderVehicle = vehicles[leader] as FlyingVehicle;
    let gap = travelPos(leaderVehicle) - travelPos(vehicle);
    if (gap < FLYING_VEHICLE_MIN_SEPARATION) {
      setTravelPos(vehicle, travelPos(leaderVehicle) - FLYING_VEHICLE_MIN_SEPARATION);
      gap = FLYING_VEHICLE_MIN_SEPARATION;
    }

    const target = followTargetSpeed(
      gap,
      vehicle.cruiseSpeed,
      leaderVehicle.speed,
      FLYING_VEHICLE_MIN_SEPARATION,
      FLYING_VEHICLE_FOLLOW_DISTANCE,
    );
    vehicle.speed = approachSpeed(vehicle.speed, target, maxDelta);
  }
}
