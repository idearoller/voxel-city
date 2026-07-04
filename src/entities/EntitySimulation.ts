/**
 * Pure orchestration of the pedestrian/vehicle population: owns the live
 * entity arrays, steps them, and spawns/despawns by distance to the player.
 * No Three.js — `EntitySystem` is the only thing that touches a renderer.
 */

import { createPedestrianAt, stepPedestrian, type Pedestrian } from './Pedestrian';
import { isRoadCell, isSidewalkCell, type NavGrid } from './NavGrid';
import { isBeyondDespawnRadius, pickElevatedSpawnCell, pickSpawnCell } from './Spawner';
import { createVehicleAt, stepVehicle, type Vehicle } from './Vehicle';
import { createRng, type Rng } from '../gen/rng';

export interface EntitySimulationConfig {
  maxPedestrians: number;
  maxVehicles: number;
  pedestrianSpeedRange: readonly [number, number];
  vehicleSpeedRange: readonly [number, number];
  /** Entities never spawn closer than this to the player — keeps them from popping into view right in front of the camera. */
  spawnMinRadius: number;
  spawnMaxRadius: number;
  despawnRadius: number;
}

export const DEFAULT_ENTITY_CONFIG: EntitySimulationConfig = {
  maxPedestrians: 120,
  maxVehicles: 40,
  pedestrianSpeedRange: [1.0, 1.8],
  vehicleSpeedRange: [6, 10],
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
  private grid: NavGrid | null = null;
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

  /** Rebuilds nav data and clears all entities. Call once per city generation/import, before the first `update()`. */
  reset(grid: NavGrid, seed: string | number = 'entities'): void {
    this.grid = grid;
    this.pedestrians = [];
    this.vehicles = [];
    this.rng = createRng(seed);
  }

  update(dt: number, playerX: number, playerY: number, playerZ: number): void {
    const grid = this.grid;
    if (!grid) return;

    for (const ped of this.pedestrians) stepPedestrian(ped, dt, grid, this.rng);
    for (const vehicle of this.vehicles) stepVehicle(vehicle, dt, grid);

    for (const ped of this.pedestrians) {
      if (isBeyondDespawnRadius(ped.x, ped.z, playerX, playerZ, this.config.despawnRadius)) ped.alive = false;
    }
    for (const vehicle of this.vehicles) {
      if (isBeyondDespawnRadius(vehicle.x, vehicle.z, playerX, playerZ, this.config.despawnRadius)) vehicle.alive = false;
    }
    swapRemoveDead(this.pedestrians);
    swapRemoveDead(this.vehicles);

    this.trySpawnPedestrian(grid, playerX, playerY, playerZ);
    this.trySpawnVehicle(grid, playerX, playerZ);
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

  private trySpawnVehicle(grid: NavGrid, playerX: number, playerZ: number): void {
    if (this.vehicles.length >= this.config.maxVehicles) return;
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
    const speed = this.rng.float(this.config.vehicleSpeedRange[0], this.config.vehicleSpeedRange[1]);
    this.vehicles.push(createVehicleAt(cell.x, cell.z, speed));
  }
}
