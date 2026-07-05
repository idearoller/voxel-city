import { describe, expect, it } from 'vitest';
import { DEFAULT_ENTITY_CONFIG, EntitySimulation, type EntitySimulationConfig } from '../src/entities/EntitySimulation';
import { buildNavGrid } from '../src/entities/NavGrid';
import { FLYING_VEHICLE_MIN_SEPARATION, type FlyingVehicle } from '../src/entities/FlyingVehicle';
import { deriveSkyLanes } from '../src/entities/SkyLane';
import { VEHICLE_MIN_SEPARATION, type Vehicle } from '../src/entities/Vehicle';
import { GROUND_SURFACE_Y, generateCity } from '../src/gen/CityGenerator';
import { WORLD_SIZE_X, WORLD_SIZE_Z } from '../src/world/coords';
import { World } from '../src/world/World';

/**
 * Soak-sim proof that same-lane, same-direction traffic (both ground
 * `Vehicle`s and flying `FlyingVehicle`s) never overlaps, keeps actually
 * flowing rather than gridlocking, and never teleports — run against real
 * `generateCity` output across a sweep of seeds, per this repo's review
 * convention (see `TowerStairPedestrian.test.ts`'s soak suite for the same
 * pattern applied to pedestrians).
 */

const DT = 1 / 60;
const TICKS = 4000; // ~66s of sim time per seed
const SNAPSHOT_CUTOFF = TICKS / 2; // only judge flow/no-teleport once the population has had time to ramp up

const SEEDS = Array.from({ length: 6 }, (_, i) => `vehicle-follow-soak-${i}`);

const GROUND_SOAK_CONFIG: EntitySimulationConfig = {
  ...DEFAULT_ENTITY_CONFIG,
  maxPedestrians: 0,
  maxVehicles: 40,
  maxFlyingVehicles: 0,
  spawnMinRadius: 5,
  spawnMaxRadius: 250,
  despawnRadius: 350,
};

const FLYING_SOAK_CONFIG: EntitySimulationConfig = {
  ...DEFAULT_ENTITY_CONFIG,
  maxPedestrians: 0,
  maxVehicles: 0,
  maxFlyingVehicles: 24,
  spawnMinRadius: 5,
  spawnMaxRadius: 250,
  despawnRadius: 350,
};

/** Same lane-grouping key `applyVehicleFollowSpacing` uses internally — re-derived here so the test asserts on the *contract*, not on white-box internals. */
function groundLaneKey(vehicle: Vehicle): string | null {
  if (vehicle.dirX === 0 && vehicle.dirZ === 0) return null;
  const cross = vehicle.dirX !== 0 ? vehicle.cellZ : vehicle.cellX;
  return `${vehicle.dirX},${vehicle.dirZ},${cross}`;
}

function groundTravelPos(vehicle: Vehicle): number {
  return vehicle.dirX !== 0 ? vehicle.x * vehicle.dirX : vehicle.z * vehicle.dirZ;
}

function flyingLaneKey(vehicle: FlyingVehicle): string {
  const cross = vehicle.dirX !== 0 ? vehicle.z : vehicle.x;
  return `${vehicle.dirX},${vehicle.dirZ},${cross}`;
}

function flyingTravelPos(vehicle: FlyingVehicle): number {
  return vehicle.dirX !== 0 ? vehicle.x * vehicle.dirX : vehicle.z * vehicle.dirZ;
}

/** Asserts no adjacent same-lane pair (grouped by `laneKeyOf`, ordered by `travelPosOf`) is closer than `minSeparation`. */
function assertNoLaneOverlap<T>(
  entities: readonly T[],
  laneKeyOf: (e: T) => string | null,
  travelPosOf: (e: T) => number,
  minSeparation: number,
): void {
  const lanes = new Map<string, number[]>();
  entities.forEach((e, i) => {
    const key = laneKeyOf(e);
    if (key === null) return;
    let indices = lanes.get(key);
    if (!indices) {
      indices = [];
      lanes.set(key, indices);
    }
    indices.push(i);
  });

  for (const indices of lanes.values()) {
    indices.sort((a, b) => travelPosOf(entities[a] as T) - travelPosOf(entities[b] as T));
    for (let i = 1; i < indices.length; i++) {
      const gap = travelPosOf(entities[indices[i] as number] as T) - travelPosOf(entities[indices[i - 1] as number] as T);
      expect(gap).toBeGreaterThanOrEqual(minSeparation - 1e-6);
    }
  }
}

/** Ticks a same-lane, birth-tagged intrusion is allowed to persist before this soak treats it as a stuck (not just easing) hole in the invariant -- generous relative to the ~63-tick max actually observed in a 6-seed sweep, so it only ever fires on a genuine regression. */
const MAX_INTRUSION_TICKS = 150;

/**
 * Ground-vehicle lane-spacing check, aware of `applyVehicleFollowSpacing`'s
 * birth-intrusion carve-out: a same-lane pair closer than
 * `VEHICLE_MIN_SEPARATION` is only ever tolerated while the trailing vehicle
 * is precisely tagged (`intrusionGap !== undefined`) -- anything else is a
 * genuine invariant break, exactly as strict as the pre-carve-out check.
 *
 * The monotonic no-shrink contract only ever applies to a *specific*
 * (rear, leader) pairing -- per `applyVehicleFollowSpacing`'s doc comment, a
 * leader swap mid-recovery re-tags from scratch rather than reusing the
 * stale gap. So `intrusionTracking` is keyed by rear vehicle but carries the
 * leader it was last checked against: a different leader this tick resets
 * the tracked gap/ticks instead of comparing across the swap (which would
 * either false-fail on a legitimate re-tag's smaller gap, or -- worse --
 * silently accept a real backward teleport by asserting monotonicity against
 * the wrong leader). Every tracked intrusion must still clear the floor
 * again within `MAX_INTRUSION_TICKS`, so the carve-out can never quietly
 * become a permanent, silent hole. Recovered vehicles push their total
 * tagged duration onto `recoveryTicks`, for this suite's reported
 * distribution.
 */
function assertGroundLaneSpacing(
  vehicles: readonly Vehicle[],
  intrusionTracking: Map<Vehicle, { leader: Vehicle; gap: number; ticks: number }>,
  recoveryTicks: number[],
): void {
  const lanes = new Map<string, number[]>();
  vehicles.forEach((v, i) => {
    const key = groundLaneKey(v);
    if (key === null) return;
    let indices = lanes.get(key);
    if (!indices) {
      indices = [];
      lanes.set(key, indices);
    }
    indices.push(i);
  });

  for (const indices of lanes.values()) {
    indices.sort((a, b) => groundTravelPos(vehicles[a] as Vehicle) - groundTravelPos(vehicles[b] as Vehicle));
    for (let i = 1; i < indices.length; i++) {
      const rear = vehicles[indices[i - 1] as number] as Vehicle;
      const lead = vehicles[indices[i] as number] as Vehicle;
      const gap = groundTravelPos(lead) - groundTravelPos(rear);

      if (gap >= VEHICLE_MIN_SEPARATION - 1e-6) continue;

      expect(rear.intrusionGap).toBeDefined();

      const prior = intrusionTracking.get(rear);
      if (prior && prior.leader === lead) {
        expect(gap).toBeGreaterThanOrEqual(prior.gap - 1e-6); // monotonic: never shrinks further against the SAME leader
        prior.gap = gap;
        prior.ticks++;
        expect(prior.ticks).toBeLessThanOrEqual(MAX_INTRUSION_TICKS); // never a permanent intrusion
      } else {
        // Either the first tick this rear is seen intruding, or its leader
        // just changed (a re-tag) -- start fresh tracking against this leader.
        intrusionTracking.set(rear, { leader: lead, gap, ticks: 1 });
      }
    }
  }

  // Anything no longer tagged (per the vehicle's own bookkeeping) has recovered -- record and stop tracking it.
  for (const [vehicle, state] of intrusionTracking) {
    if (vehicle.intrusionGap === undefined) {
      recoveryTicks.push(state.ticks);
      intrusionTracking.delete(vehicle);
    }
  }
}

describe('ground vehicle follow-spacing soak (real generated cities)', () => {
  it('never overlaps a same-lane leader outside a precisely-tagged, monotonically-recovering birth intrusion, never teleports, and keeps traffic flowing, across a sweep of seeds', () => {
    // Worst-case bound is now just ordinary cruising displacement plus a
    // small margin: `applyVehicleFollowSpacing`'s birth-intrusion carve-out
    // (see its doc comment) replaced the old single-tick, up-to-
    // VEHICLE_MIN_SEPARATION-sized hard clamp with a monotonic, kinematics-
    // bounded correction, so a real teleport bug (a vehicle jumping across
    // the map) still blows straight past this.
    const maxPerTickDisplacement = GROUND_SOAK_CONFIG.vehicleSpeedRange[1] * DT * 2;
    let seedsChecked = 0;
    let maxObservedDisplacement = 0;
    const recoveryTicks: number[] = [];

    for (const seed of SEEDS) {
      const world = new World();
      generateCity(world, seed);
      const grid = buildNavGrid(world, WORLD_SIZE_X, WORLD_SIZE_Z, GROUND_SURFACE_Y);
      const centerX = WORLD_SIZE_X / 2;
      const centerZ = WORLD_SIZE_Z / 2;

      const sim = new EntitySimulation(GROUND_SOAK_CONFIG);
      sim.reset(grid, `${seed}-ground-sim`);
      const intrusionTracking = new Map<Vehicle, { leader: Vehicle; gap: number; ticks: number }>();

      let speedSampleSum = 0;
      let speedSampleCount = 0;
      let maxPopulation = 0;

      for (let tick = 0; tick < TICKS; tick++) {
        const before = new Map(sim.vehicleList.map((v) => [v, { x: v.x, z: v.z }]));

        sim.update(DT, centerX, GROUND_SURFACE_Y, centerZ);

        for (const v of sim.vehicleList) {
          const prev = before.get(v);
          if (!prev) continue; // spawned this tick -- nothing to compare against
          const displacement = Math.hypot(v.x - prev.x, v.z - prev.z);
          expect(displacement).toBeLessThanOrEqual(maxPerTickDisplacement);
          if (displacement > maxObservedDisplacement) maxObservedDisplacement = displacement;
        }

        assertGroundLaneSpacing(sim.vehicleList, intrusionTracking, recoveryTicks);

        maxPopulation = Math.max(maxPopulation, sim.vehicleList.length);
        if (tick >= SNAPSHOT_CUTOFF) {
          for (const v of sim.vehicleList) {
            speedSampleSum += v.speed;
            speedSampleCount++;
          }
        }
      }

      if (maxPopulation > 0) seedsChecked++;
      if (speedSampleCount > 0) {
        const avgSpeed = speedSampleSum / speedSampleCount;
        // Traffic keeps flowing: the population-wide average speed in the
        // soak's back half must stay well above zero, i.e. never gridlocks.
        expect(avgSpeed).toBeGreaterThan(1);
      }

      // Every intrusion still open at the end of this seed's run is, by
      // construction, still within MAX_INTRUSION_TICKS (assertGroundLaneSpacing
      // would already have failed otherwise) -- nothing further to assert
      // here, but nothing needs to be force-flushed into recoveryTicks either.
    }

    // Neutralize check: fails if no seed ever produced any ground vehicles at all.
    expect(seedsChecked).toBeGreaterThan(0);
    // Sanity on the carve-out itself: real generated-city traffic actually
    // exercises birth intrusions (turns into an occupied lane happen), and
    // every one of them recovers well within the generous cap.
    expect(recoveryTicks.length).toBeGreaterThan(0);
    for (const ticks of recoveryTicks) {
      expect(ticks).toBeLessThan(MAX_INTRUSION_TICKS);
    }
  });
});

describe('flying vehicle follow-spacing soak (real generated cities)', () => {
  it('never overlaps a same-lane leader, never teleports, and keeps traffic flowing, across a sweep of seeds', () => {
    const maxPerTickDisplacement = FLYING_SOAK_CONFIG.flyingVehicleSpeedRange[1] * DT * 4;
    let seedsWithLanes = 0;

    for (const seed of SEEDS) {
      const world = new World();
      generateCity(world, seed);
      const grid = buildNavGrid(world, WORLD_SIZE_X, WORLD_SIZE_Z, GROUND_SURFACE_Y);
      const lanes = deriveSkyLanes(world, grid.road, WORLD_SIZE_X, WORLD_SIZE_Z);
      if (lanes.length === 0) continue; // this seed's layout produced no clear sky corridor -- nothing to soak

      seedsWithLanes++;
      const centerX = WORLD_SIZE_X / 2;
      const centerZ = WORLD_SIZE_Z / 2;

      const sim = new EntitySimulation(FLYING_SOAK_CONFIG);
      sim.reset(grid, `${seed}-flying-sim`, lanes);

      let speedSampleSum = 0;
      let speedSampleCount = 0;

      for (let tick = 0; tick < TICKS; tick++) {
        const before = new Map(sim.flyingVehicleList.map((v) => [v, { x: v.x, z: v.z }]));

        sim.update(DT, centerX, GROUND_SURFACE_Y, centerZ);

        for (const v of sim.flyingVehicleList) {
          const prev = before.get(v);
          if (!prev) continue;
          const displacement = Math.hypot(v.x - prev.x, v.z - prev.z);
          expect(displacement).toBeLessThanOrEqual(maxPerTickDisplacement);
        }

        assertNoLaneOverlap(sim.flyingVehicleList, flyingLaneKey, flyingTravelPos, FLYING_VEHICLE_MIN_SEPARATION);

        if (tick >= SNAPSHOT_CUTOFF) {
          for (const v of sim.flyingVehicleList) {
            speedSampleSum += v.speed;
            speedSampleCount++;
          }
        }
      }

      if (speedSampleCount > 0) {
        const avgSpeed = speedSampleSum / speedSampleCount;
        expect(avgSpeed).toBeGreaterThan(1);
      }
    }

    // Neutralize check: fails if no seed in the sweep ever produced a usable sky lane.
    expect(seedsWithLanes).toBeGreaterThan(0);
  });
});
