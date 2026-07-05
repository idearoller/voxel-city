/**
 * Pure orchestration of the pedestrian/vehicle population: owns the live
 * entity arrays, steps them, and spawns/despawns by distance to the player.
 * No Three.js — `EntitySystem` is the only thing that touches a renderer.
 */

import {
  applyFlyingVehicleFollowSpacing,
  captureRenderPrevState as captureFlyingVehiclePrevState,
  createFlyingVehicleOnLane,
  FLYING_VEHICLE_MIN_SEPARATION,
  snapRenderPrevIfTeleported as snapFlyingVehiclePrevIfTeleported,
  stepFlyingVehicle,
  type FlyingVehicle,
} from './FlyingVehicle';
import {
  captureRenderPrevState as capturePedestrianPrevState,
  createPedestrianAt,
  snapRenderPrevIfTeleported as snapPedestrianPrevIfTeleported,
  stepPedestrian,
  type Pedestrian,
} from './Pedestrian';
import { isRoadCell, isSidewalkCell, type NavGrid } from './NavGrid';
import {
  isBeyondDespawnRadius,
  isSpawnClearOfVehicles,
  pickElevatedSpawnCell,
  pickFlyingVehicleSpawn,
  pickSpawnCell,
} from './Spawner';
import type { SkyLane } from './SkyLane';
import {
  applyVehicleFollowSpacing,
  captureRenderPrevState as captureVehiclePrevState,
  createVehicleAt,
  snapRenderPrevIfTeleported as snapVehiclePrevIfTeleported,
  stepVehicle,
  VEHICLE_MIN_SEPARATION,
  type Vehicle,
} from './Vehicle';
import { createRng, type Rng } from '../gen/rng';

/** How many alternate spawn candidates to try before giving up on a spawn this tick, when the first candidate lands too close to existing traffic (see `isSpawnClearOfVehicles`). */
const SPAWN_CLEARANCE_ATTEMPTS = 8;

export interface EntitySimulationConfig {
  maxPedestrians: number;
  maxVehicles: number;
  /** Population cap for flying (hover-car) traffic — kept low (~20-30) so the sky reads as "a few movers," not a swarm. */
  maxFlyingVehicles: number;
  pedestrianSpeedRange: readonly [number, number];
  vehicleSpeedRange: readonly [number, number];
  /** Faster than ground traffic — sells the "cutting straight across the city" read a lane-bound hover-car should have. */
  flyingVehicleSpeedRange: readonly [number, number];
  /** Entities never spawn closer than this to the player — keeps them from popping into view right in front of the camera. */
  spawnMinRadius: number;
  spawnMaxRadius: number;
  despawnRadius: number;
}

export const DEFAULT_ENTITY_CONFIG: EntitySimulationConfig = {
  maxPedestrians: 120,
  maxVehicles: 40,
  maxFlyingVehicles: 24,
  pedestrianSpeedRange: [1.0, 1.8],
  vehicleSpeedRange: [6, 10],
  flyingVehicleSpeedRange: [12, 20],
  spawnMinRadius: 35,
  spawnMaxRadius: 90,
  despawnRadius: 110,
};

/** Removes and returns entities failing `keep`, compacting the array in place (order is not meaningful — these are anonymous city extras). */
function swapRemoveDead<T extends { alive: boolean }>(entities: T[]): void {
  for (let i = entities.length - 1; i >= 0; i--) {
    if (!(entities[i] as T).alive) {
      const last = entities.length - 1;
      entities[i] = entities[last] as T;
      entities.pop();
    }
  }
}

/**
 * Owns and steps the live pedestrian/vehicle population. `reset()` rebuilds
 * against a fresh `NavGrid` (after city generation or `.vxc` import) and
 * clears every entity — no stale references carry over between cities.
 */
export class EntitySimulation {
  private pedestrians: Pedestrian[] = [];
  private vehicles: Vehicle[] = [];
  private flyingVehicles: FlyingVehicle[] = [];
  private grid: NavGrid | null = null;
  private skyLanes: readonly SkyLane[] = [];
  private rng: Rng;

  constructor(private readonly config: EntitySimulationConfig = DEFAULT_ENTITY_CONFIG) {
    this.rng = createRng('entities');
  }

  get pedestrianList(): readonly Pedestrian[] {
    return this.pedestrians;
  }

  get vehicleList(): readonly Vehicle[] {
    return this.vehicles;
  }

  get flyingVehicleList(): readonly FlyingVehicle[] {
    return this.flyingVehicles;
  }

  /**
   * Rebuilds nav data and clears all entities. Call once per city
   * generation/import, before the first `update()`. `skyLanes` defaults to
   * empty so callers that don't yet have sky lanes on hand (e.g. existing
   * tests built before flying traffic existed) simply spawn none.
   */
  reset(grid: NavGrid, seed: string | number = 'entities', skyLanes: readonly SkyLane[] = []): void {
    this.grid = grid;
    this.skyLanes = skyLanes;
    this.pedestrians = [];
    this.vehicles = [];
    this.flyingVehicles = [];
    this.rng = createRng(seed);
  }

  update(dt: number, playerX: number, playerY: number, playerZ: number): void {
    const grid = this.grid;
    if (!grid) return;

    // Snapshot every entity's pre-step position/heading first -- see
    // `Pedestrian.prevX`'s doc comment. Must run before any stepping so
    // `EntityRenderer` always has "where it was this tick" to lerp from,
    // regardless of which entities move this tick.
    for (const ped of this.pedestrians) capturePedestrianPrevState(ped);
    for (const vehicle of this.vehicles) captureVehiclePrevState(vehicle);
    for (const flyer of this.flyingVehicles) captureFlyingVehiclePrevState(flyer);

    for (const ped of this.pedestrians) stepPedestrian(ped, dt, grid, this.rng);
    for (const vehicle of this.vehicles) stepVehicle(vehicle, dt, grid);
    for (const flyer of this.flyingVehicles) stepFlyingVehicle(flyer, dt, grid.width, grid.depth);

    for (const ped of this.pedestrians) {
      if (isBeyondDespawnRadius(ped.x, ped.z, playerX, playerZ, this.config.despawnRadius)) ped.alive = false;
    }
    for (const vehicle of this.vehicles) {
      if (isBeyondDespawnRadius(vehicle.x, vehicle.z, playerX, playerZ, this.config.despawnRadius)) vehicle.alive = false;
    }
    // 2D distance only, same as ground vehicles -- deliberately not widened
    // for altitude the way `pickElevatedSpawnCell` widens pedestrian spawn
    // distance (see `EntitySimulationConfig`'s doc comment): a flying
    // vehicle's fixed altitude (>= 104) is already far enough above the
    // player's typical ground-level y (<= ~90) that vertical separation
    // alone hides pop-in, so the horizontal radius doesn't need inflating.
    for (const flyer of this.flyingVehicles) {
      if (isBeyondDespawnRadius(flyer.x, flyer.z, playerX, playerZ, this.config.despawnRadius)) flyer.alive = false;
    }
    swapRemoveDead(this.pedestrians);
    swapRemoveDead(this.vehicles);
    swapRemoveDead(this.flyingVehicles);

    // Same-lane follow-distance: run after this tick's own movement/despawn
    // so a vehicle's gap to its leader reflects where everyone actually
    // ended up, not stale pre-step positions (see `applyVehicleFollowSpacing`
    // / `applyFlyingVehicleFollowSpacing` for the full behavior).
    applyVehicleFollowSpacing(this.vehicles, dt);
    applyFlyingVehicleFollowSpacing(this.flyingVehicles, dt);

    // Safety net against smearing a render frame across a same-tick
    // teleport-sized jump (see `snapRenderPrevIfTeleported`'s doc comment on
    // each entity module) -- runs last, after every position-mutating pass
    // this tick (stepping, then follow-spacing), so it sees each entity's
    // true final displacement for the tick.
    for (const ped of this.pedestrians) snapPedestrianPrevIfTeleported(ped, dt);
    for (const vehicle of this.vehicles) snapVehiclePrevIfTeleported(vehicle, dt);
    for (const flyer of this.flyingVehicles) snapFlyingVehiclePrevIfTeleported(flyer, dt);

    this.trySpawnPedestrian(grid, playerX, playerY, playerZ);
    this.trySpawnVehicle(grid, playerX, playerZ);
    this.trySpawnFlyingVehicle(playerX, playerZ);
  }

  /**
   * Tries an elevated deck cell first (see `pickElevatedSpawnCell`'s doc
   * comment — it already accounts for the 30% cap, altitude-aware distance,
   * and "no deck in range" case), falling back to a normal ground sidewalk
   * spawn whenever that misses so an elevated-roll miss never leaves a spawn
   * tick doing nothing.
   */
  private trySpawnPedestrian(grid: NavGrid, playerX: number, playerY: number, playerZ: number): void {
    if (this.pedestrians.length >= this.config.maxPedestrians) return;

    const elevatedCell = pickElevatedSpawnCell(
      grid,
      playerX,
      playerY,
      playerZ,
      this.config.spawnMinRadius,
      this.config.spawnMaxRadius,
      this.rng,
    );
    if (elevatedCell) {
      const speed = this.rng.float(this.config.pedestrianSpeedRange[0], this.config.pedestrianSpeedRange[1]);
      this.pedestrians.push(createPedestrianAt(elevatedCell.x, elevatedCell.z, elevatedCell.y, speed));
      return;
    }

    const cell = pickSpawnCell(
      grid,
      isSidewalkCell,
      playerX,
      playerZ,
      this.config.spawnMinRadius,
      this.config.spawnMaxRadius,
      this.rng,
    );
    if (!cell) return;
    const speed = this.rng.float(this.config.pedestrianSpeedRange[0], this.config.pedestrianSpeedRange[1]);
    this.pedestrians.push(createPedestrianAt(cell.x, cell.z, grid.groundY, speed));
  }

  /**
   * Retries up to `SPAWN_CLEARANCE_ATTEMPTS` fresh candidate cells, each
   * checked against `isSpawnClearOfVehicles`, so a new vehicle never pops
   * into existence already overlapping one that's already there (see that
   * function's doc comment for why the check is citywide rather than
   * lane-scoped). A miss on every attempt just skips this tick's spawn —
   * consistent with `pickSpawnCell` itself already returning `null` on a
   * miss, rather than forcing a spawn somewhere unsafe.
   */
  private trySpawnVehicle(grid: NavGrid, playerX: number, playerZ: number): void {
    if (this.vehicles.length >= this.config.maxVehicles) return;

    for (let attempt = 0; attempt < SPAWN_CLEARANCE_ATTEMPTS; attempt++) {
      const cell = pickSpawnCell(
        grid,
        isRoadCell,
        playerX,
        playerZ,
        this.config.spawnMinRadius,
        this.config.spawnMaxRadius,
        this.rng,
      );
      if (!cell) return;

      const x = cell.x + 0.5;
      const z = cell.z + 0.5;
      if (!isSpawnClearOfVehicles(x, z, this.vehicles, VEHICLE_MIN_SEPARATION)) continue;

      const speed = this.rng.float(this.config.vehicleSpeedRange[0], this.config.vehicleSpeedRange[1]);
      this.vehicles.push(createVehicleAt(cell.x, cell.z, speed));
      return;
    }
  }

  /** Same clearance-retry approach as `trySpawnVehicle` — see that method's doc comment. */
  private trySpawnFlyingVehicle(playerX: number, playerZ: number): void {
    if (this.flyingVehicles.length >= this.config.maxFlyingVehicles) return;

    for (let attempt = 0; attempt < SPAWN_CLEARANCE_ATTEMPTS; attempt++) {
      const spawn = pickFlyingVehicleSpawn(
        this.skyLanes,
        playerX,
        playerZ,
        this.config.spawnMinRadius,
        this.config.spawnMaxRadius,
        this.rng,
      );
      if (!spawn) return;

      const x = spawn.lane.axis === 'x' ? spawn.travelCoord : spawn.lane.fixed;
      const z = spawn.lane.axis === 'z' ? spawn.travelCoord : spawn.lane.fixed;
      if (!isSpawnClearOfVehicles(x, z, this.flyingVehicles, FLYING_VEHICLE_MIN_SEPARATION)) continue;

      const speed = this.rng.float(this.config.flyingVehicleSpeedRange[0], this.config.flyingVehicleSpeedRange[1]);
      this.flyingVehicles.push(createFlyingVehicleOnLane(spawn.lane, spawn.travelCoord, spawn.direction, speed));
      return;
    }
  }
}
