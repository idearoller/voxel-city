/**
 * Orchestrates pedestrian/vehicle NPCs: rebuilds navigation data after each
 * city generation/import, steps the pure simulation on the fixed 60Hz tick,
 * and syncs the Three.js instanced-mesh presentation layer once per
 * animation frame — mirroring `ChunkRenderer`'s update()-on-render-frame
 * convention (see `Engine.ts` / `main.ts`).
 *
 * Ephemeral by design: entities are respawned from world state + a seed,
 * never persisted (see `io/Serializer.ts`'s `entities: []` valve). They are
 * also non-solid to the player — no collision against pedestrians/vehicles —
 * which keeps phase 2 scoped to "the city feels alive" rather than full
 * NPC/player physics.
 *
 * Deliberately out of scope for phase 2 (documented, not silently dropped):
 * elevated walkways/bridges have no NPC traffic (`NavGrid` only scans the
 * ground-floor surface); vehicles don't yield to pedestrians or each other
 * beyond not spawning on top of one another; spawn placement is a random
 * annulus around the player with no camera-heading bias, so an unlucky roll
 * can in principle spawn just outside the view frustum rather than strictly
 * behind the camera.
 */

import * as THREE from 'three';
import { DEFAULT_ENTITY_CONFIG, EntitySimulation, type EntitySimulationConfig } from './EntitySimulation';
import { buildNavGrid } from './NavGrid';
import { EntityRenderer } from '../engine/EntityRenderer';
import { WORLD_SIZE_X, WORLD_SIZE_Z } from '../world/coords';
import type { World } from '../world/World';

export class EntitySystem {
  private readonly simulation: EntitySimulation;
  private readonly renderer: EntityRenderer;
  private groundY = 0;
  private elapsedTime = 0;

  constructor(scene: THREE.Scene, config: EntitySimulationConfig = DEFAULT_ENTITY_CONFIG) {
    this.simulation = new EntitySimulation(config);
    this.renderer = new EntityRenderer(scene, config.maxPedestrians, config.maxVehicles);
  }

  /**
   * Rebuilds the sidewalk/road navigation grid from `world`'s current voxel
   * state and clears every existing entity. Call after `generateCity` or
   * `importWorld` — both leave the previous population's nav data stale.
   */
  rebuild(world: World, groundY: number, seed: string | number): void {
    this.groundY = groundY;
    const grid = buildNavGrid(world, WORLD_SIZE_X, WORLD_SIZE_Z, groundY);
    this.simulation.reset(grid, seed);
  }

  /** Fixed 60Hz simulation tick: steps and spawns/despawns entities relative to the player. */
  update(dt: number, playerX: number, playerZ: number): void {
    this.elapsedTime += dt;
    this.simulation.update(dt, playerX, playerZ);
  }

  /** Per-animation-frame sync of instanced mesh matrices from current simulation state. */
  render(): void {
    this.renderer.update(this.simulation.pedestrianList, this.simulation.vehicleList, this.groundY, this.elapsedTime);
  }

  dispose(): void {
    this.renderer.dispose();
  }
}
