/**
 * Orchestrates pedestrian/vehicle/flying-vehicle NPCs: rebuilds navigation
 * data (and sky lanes) after each city generation/import, steps the pure
 * simulation on the fixed 60Hz tick, and syncs the Three.js instanced-mesh
 * presentation layer once per animation frame — mirroring `ChunkRenderer`'s
 * update()-on-render-frame convention (see `Engine.ts` / `main.ts`).
 *
 * Ephemeral by design: entities are respawned from world state + a seed,
 * never persisted (see `io/Serializer.ts`'s `entities: []` valve). They are
 * also non-solid to the player — no collision against pedestrians/vehicles —
 * which keeps phase 2 scoped to "the city feels alive" rather than full
 * NPC/player physics.
 *
 * Deliberately out of scope (documented, not silently dropped): a walkway
 * pedestrian may cross to/from the street via a real stair (see
 * `NavGrid.StairLink` and `Pedestrian.stair`), but a *skybridge* pedestrian
 * is still deck-bound — the internal spiral stair shaft that would connect a
 * bridge's sky lobby back to the street is real geometry, but voxel-deriving
 * a ground-connected chain through a tower's mostly-enclosed interior (and
 * teaching `NavGrid` to recognize a sky lobby's own floor as walkable,
 * distinct from an ordinary building floor at the same height) is
 * disproportionate complexity for how rarely a player is near one, next to
 * how common — and how visually prominent — the ground-level walkway
 * disconnect was; the 30%-elevated-share spawn split (see `Spawner.ts`'s
 * `pickElevatedSpawnCell`) is unchanged for bridges. Ground vehicles stay
 * ground-only (flying vehicles are a wholly separate population — see
 * `FlyingVehicle.ts` and `SkyLane.ts` — that never interacts with ground
 * traffic or pedestrians); no vehicle yields to pedestrians or other
 * vehicles beyond not spawning on top of one another; despawn and vehicle
 * spawn placement use horizontal (x, z) distance only (`playerY` only feeds
 * elevated-pedestrian spawn distance, see `Spawner.ts`'s
 * `pickElevatedSpawnCell`); no camera-heading bias on spawn angle, so an
 * unlucky roll can in principle spawn just outside the view frustum rather
 * than strictly behind the camera.
 */

import * as THREE from 'three';
import { DEFAULT_ENTITY_CONFIG, EntitySimulation, type EntitySimulationConfig } from './EntitySimulation';
import { buildNavGrid } from './NavGrid';
import { deriveSkyLanes } from './SkyLane';
import { EntityRenderer } from '../engine/EntityRenderer';
import { WORLD_SIZE_X, WORLD_SIZE_Z } from '../world/coords';
import type { World } from '../world/World';
// Type-only: `FlyerRelativeState` is a plain DTO (see `audio/types.ts`'s doc
// comment on it) -- this import carries no runtime WebAudio dependency, and
// keeps the actual `FlyingVehicle` shape from ever leaking into `audio/`.
import type { FlyerRelativeState } from '../audio/types';

export class EntitySystem {
  private readonly simulation: EntitySimulation;
  private readonly renderer: EntityRenderer;
  private groundY = 0;
  private elapsedTime = 0;

  constructor(scene: THREE.Scene, config: EntitySimulationConfig = DEFAULT_ENTITY_CONFIG) {
    this.simulation = new EntitySimulation(config);
    this.renderer = new EntityRenderer(scene, config.maxPedestrians, config.maxVehicles, config.maxFlyingVehicles);
  }

  /**
   * Rebuilds the sidewalk/road navigation grid and sky lanes from `world`'s
   * current voxel state, and clears every existing entity. Call after
   * `generateCity` or `importWorld` — both leave the previous population's
   * nav data stale. Sky lanes are re-derived (not cached) every call, same
   * as the nav grid itself — see `SkyLane.ts`'s doc comment for why a fresh
   * per-lane clearance scan against real voxel data matters here.
   */
  rebuild(world: World, groundY: number, seed: string | number): void {
    this.groundY = groundY;
    const grid = buildNavGrid(world, WORLD_SIZE_X, WORLD_SIZE_Z, groundY);
    const skyLanes = deriveSkyLanes(world, grid.road, WORLD_SIZE_X, WORLD_SIZE_Z);
    this.simulation.reset(grid, seed, skyLanes);
  }

  /**
   * Fixed 60Hz simulation tick: steps and spawns/despawns entities relative
   * to the player. `playerY` only matters for elevated-pedestrian spawn
   * distance (see `Spawner.ts`'s `pickElevatedSpawnCell`); despawn and
   * vehicle spawn stay horizontal-only.
   */
  update(dt: number, playerX: number, playerY: number, playerZ: number): void {
    this.elapsedTime += dt;
    this.simulation.update(dt, playerX, playerY, playerZ);
  }

  /**
   * Fills `out` with every live flying vehicle's position/velocity relative
   * to (`cameraX`, `cameraY`, `cameraZ`), for the positional flyby audio
   * effect (see `audio/flyby.ts`) -- this is the one place `FlyingVehicle`'s
   * shape gets converted to the plain `FlyerRelativeState` DTO `audio/` is
   * allowed to know about. Reuses whatever objects are already sitting in
   * `out` from a previous call (mutating their fields in place) rather than
   * allocating a fresh record per flyer per frame; only grows `out` the
   * first time the live flyer count exceeds its previous length.
   * `vy` is omitted -- flying vehicles hold a fixed altitude for their whole
   * lifetime (see `FlyingVehicle.y`), so vertical closing speed is always 0.
   */
  getFlyerAudioStates(cameraX: number, cameraY: number, cameraZ: number, out: FlyerRelativeState[]): void {
    const flyers = this.simulation.flyingVehicleList;
    for (let i = 0; i < flyers.length; i++) {
      const flyer = flyers[i]!;
      let state = out[i];
      if (!state) {
        state = { dx: 0, dy: 0, dz: 0, vx: 0, vz: 0 };
        out[i] = state;
      }
      state.dx = flyer.x - cameraX;
      state.dy = flyer.y - cameraY;
      state.dz = flyer.z - cameraZ;
      state.vx = flyer.dirX * flyer.speed;
      state.vz = flyer.dirZ * flyer.speed;
    }
    out.length = flyers.length;
  }

  /**
   * Per-animation-frame sync of instanced mesh matrices, interpolated
   * between the previous and current fixed sim tick by `alpha` — see
   * `EntityRenderer.update`'s doc comment for the interpolation semantics.
   */
  render(alpha: number): void {
    this.renderer.update(
      this.simulation.pedestrianList,
      this.simulation.vehicleList,
      this.simulation.flyingVehicleList,
      this.groundY,
      this.elapsedTime,
      alpha,
    );
  }

  dispose(): void {
    this.renderer.dispose();
  }
}
