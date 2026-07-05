import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { EntitySystem } from '../src/entities/EntitySystem';
import { ASPHALT, CONCRETE, SIDEWALK } from '../src/world/BlockRegistry';
import { WORLD_SIZE_X, WORLD_SIZE_Z } from '../src/world/coords';
import { World } from '../src/world/World';

const GROUND_Y = 1;

/** Paints a small SIDEWALK plaza around the origin, big enough to host a walkable population. */
function paintSidewalkPlaza(world: World, size: number): void {
  for (let x = 0; x < size; x++) {
    for (let z = 0; z < size; z++) {
      world.setBlock(x, 0, z, CONCRETE);
      world.setBlock(x, GROUND_Y, z, SIDEWALK);
    }
  }
}

/** Paints one full-width (7-voxel) major avenue spanning the entire z extent, at otherwise-empty (guaranteed clear) airspace -- enough for `deriveSkyLanes` to derive exactly one usable lane. */
function paintMajorAvenue(world: World, startX: number): void {
  for (let x = startX; x < startX + 7; x++) {
    for (let z = 0; z < WORLD_SIZE_Z; z++) {
      world.setBlock(x, 0, z, CONCRETE);
      world.setBlock(x, GROUND_Y, z, ASPHALT);
    }
  }
}

describe('EntitySystem', () => {
  it('spawns no entities before rebuild() has been called', () => {
    const scene = new THREE.Scene();
    const system = new EntitySystem(scene, {
      maxPedestrians: 5,
      maxVehicles: 0,
      maxFlyingVehicles: 0,
      pedestrianSpeedRange: [1, 1],
      vehicleSpeedRange: [1, 1],
      flyingVehicleSpeedRange: [1, 1],
      spawnMinRadius: 1,
      spawnMaxRadius: 10,
      despawnRadius: 50,
    });

    for (let i = 0; i < 30; i++) {
      system.update(1 / 60, 15, GROUND_Y, 15);
    }
    system.render(1); // alpha=1: render fully at current state -- these tests assert instance counts, not interpolated positions.

    expect(scene.children.every((child) => !(child instanceof THREE.InstancedMesh) || child.count === 0)).toBe(true);
  });

  it('populates pedestrians after rebuild() against a sidewalk-covered world', () => {
    const world = new World();
    paintSidewalkPlaza(world, 40);
    const scene = new THREE.Scene();
    const system = new EntitySystem(scene, {
      maxPedestrians: 5,
      maxVehicles: 0,
      maxFlyingVehicles: 0,
      pedestrianSpeedRange: [1, 1],
      vehicleSpeedRange: [1, 1],
      flyingVehicleSpeedRange: [1, 1],
      spawnMinRadius: 1,
      spawnMaxRadius: 10,
      despawnRadius: 50,
    });

    system.rebuild(world, GROUND_Y, 'system-test');
    for (let i = 0; i < 60; i++) {
      system.update(1 / 60, 20, GROUND_Y, 20);
    }
    system.render(1); // alpha=1: render fully at current state -- these tests assert instance counts, not interpolated positions.

    const pedestrianBody = scene.children.find(
      (child) => child instanceof THREE.InstancedMesh && child.count > 0,
    );
    expect(pedestrianBody).toBeDefined();
  });

  it('resetting via a second rebuild() clears the previously spawned population', () => {
    const world = new World();
    paintSidewalkPlaza(world, 40);
    const scene = new THREE.Scene();
    const system = new EntitySystem(scene, {
      maxPedestrians: 5,
      maxVehicles: 0,
      maxFlyingVehicles: 0,
      pedestrianSpeedRange: [1, 1],
      vehicleSpeedRange: [1, 1],
      flyingVehicleSpeedRange: [1, 1],
      spawnMinRadius: 1,
      spawnMaxRadius: 10,
      despawnRadius: 50,
    });

    system.rebuild(world, GROUND_Y, 'system-reset-a');
    for (let i = 0; i < 60; i++) system.update(1 / 60, 20, GROUND_Y, 20);

    // Regenerate into an empty (all-air) world -- no sidewalk anywhere.
    const emptyWorld = new World();
    system.rebuild(emptyWorld, GROUND_Y, 'system-reset-b');
    system.update(1 / 60, 20, GROUND_Y, 20);
    system.render(1); // alpha=1: render fully at current state -- these tests assert instance counts, not interpolated positions.

    const anyVisibleInstances = scene.children.some(
      (child) => child instanceof THREE.InstancedMesh && child.count > 0,
    );
    expect(anyVisibleInstances).toBe(false);
  });

  it('populates flying vehicles after rebuild() against a world with a real, clear major avenue', () => {
    const world = new World();
    paintMajorAvenue(world, Math.floor(WORLD_SIZE_X / 2));
    const scene = new THREE.Scene();
    const system = new EntitySystem(scene, {
      maxPedestrians: 0,
      maxVehicles: 0,
      maxFlyingVehicles: 6,
      pedestrianSpeedRange: [1, 1],
      vehicleSpeedRange: [1, 1],
      flyingVehicleSpeedRange: [15, 15],
      spawnMinRadius: 1,
      spawnMaxRadius: 100,
      despawnRadius: 300,
    });

    const playerX = Math.floor(WORLD_SIZE_X / 2);
    const playerZ = Math.floor(WORLD_SIZE_Z / 2);
    system.rebuild(world, GROUND_Y, 'system-flying-test');
    for (let i = 0; i < 600; i++) {
      system.update(1 / 60, playerX, GROUND_Y, playerZ);
    }
    system.render(1); // alpha=1: render fully at current state -- these tests assert instance counts, not interpolated positions.

    const flyingVehicleBody = scene.children.find(
      (child) => child instanceof THREE.InstancedMesh && child.count > 0,
    );
    expect(flyingVehicleBody).toBeDefined();
  });

  it('a second rebuild() into a world with no clear avenue stops spawning flying vehicles', () => {
    const world = new World();
    paintMajorAvenue(world, Math.floor(WORLD_SIZE_X / 2));
    const scene = new THREE.Scene();
    const system = new EntitySystem(scene, {
      maxPedestrians: 0,
      maxVehicles: 0,
      maxFlyingVehicles: 6,
      pedestrianSpeedRange: [1, 1],
      vehicleSpeedRange: [1, 1],
      flyingVehicleSpeedRange: [15, 15],
      spawnMinRadius: 1,
      spawnMaxRadius: 100,
      despawnRadius: 300,
    });

    const playerX = Math.floor(WORLD_SIZE_X / 2);
    const playerZ = Math.floor(WORLD_SIZE_Z / 2);
    system.rebuild(world, GROUND_Y, 'system-flying-before');
    for (let i = 0; i < 300; i++) system.update(1 / 60, playerX, GROUND_Y, playerZ);

    const emptyWorld = new World();
    system.rebuild(emptyWorld, GROUND_Y, 'system-flying-after');
    for (let i = 0; i < 60; i++) system.update(1 / 60, playerX, GROUND_Y, playerZ);
    system.render(1); // alpha=1: render fully at current state -- these tests assert instance counts, not interpolated positions.

    const flyingVehicleBody = scene.children.find(
      (child) => child instanceof THREE.InstancedMesh && child.count > 0,
    );
    expect(flyingVehicleBody).toBeUndefined();
  });

  describe('getFlyerAudioStates', () => {
    function buildFlyingVehicleSystem(scene: THREE.Scene): EntitySystem {
      return new EntitySystem(scene, {
        maxPedestrians: 0,
        maxVehicles: 0,
        maxFlyingVehicles: 6,
        pedestrianSpeedRange: [1, 1],
        vehicleSpeedRange: [1, 1],
        flyingVehicleSpeedRange: [15, 15],
        spawnMinRadius: 1,
        spawnMaxRadius: 100,
        despawnRadius: 300,
      });
    }

    it('fills one relative-state record per live flying vehicle, positioned relative to the given camera', () => {
      const world = new World();
      paintMajorAvenue(world, Math.floor(WORLD_SIZE_X / 2));
      const scene = new THREE.Scene();
      const system = buildFlyingVehicleSystem(scene);

      const playerX = Math.floor(WORLD_SIZE_X / 2);
      const playerZ = Math.floor(WORLD_SIZE_Z / 2);
      system.rebuild(world, GROUND_Y, 'audio-states-test');
      for (let i = 0; i < 600; i++) system.update(1 / 60, playerX, GROUND_Y, playerZ);

      const out: { dx: number; dy: number; dz: number; vx: number; vz: number }[] = [];
      const cameraX = playerX + 1;
      const cameraY = 50;
      const cameraZ = playerZ + 2;
      system.getFlyerAudioStates(cameraX, cameraY, cameraZ, out);

      expect(out.length).toBeGreaterThan(0);
      for (const state of out) {
        // Sky lanes sit well above GROUND_Y -- the relative dy should
        // reflect real altitude, not a stray zero.
        expect(state.dy).toBeGreaterThan(0);
        // Every spawned flyer here cruises at exactly 15 -- exactly one of
        // vx/vz should carry that magnitude (fixed axis-aligned heading).
        expect(Math.hypot(state.vx, state.vz)).toBeCloseTo(15);
      }
    });

    it('reuses previously-filled records across calls instead of allocating new ones', () => {
      const world = new World();
      paintMajorAvenue(world, Math.floor(WORLD_SIZE_X / 2));
      const scene = new THREE.Scene();
      const system = buildFlyingVehicleSystem(scene);

      const playerX = Math.floor(WORLD_SIZE_X / 2);
      const playerZ = Math.floor(WORLD_SIZE_Z / 2);
      system.rebuild(world, GROUND_Y, 'audio-states-reuse-test');
      for (let i = 0; i < 600; i++) system.update(1 / 60, playerX, GROUND_Y, playerZ);

      const out: { dx: number; dy: number; dz: number; vx: number; vz: number }[] = [];
      system.getFlyerAudioStates(playerX, GROUND_Y, playerZ, out);
      expect(out.length).toBeGreaterThan(0);
      const firstRecord = out[0];

      system.update(1 / 60, playerX, GROUND_Y, playerZ);
      system.getFlyerAudioStates(playerX, GROUND_Y, playerZ, out);
      expect(out[0]).toBe(firstRecord); // same object, fields mutated in place
    });

    it('truncates to the live flyer count when the population shrinks', () => {
      const world = new World();
      paintMajorAvenue(world, Math.floor(WORLD_SIZE_X / 2));
      const scene = new THREE.Scene();
      const system = buildFlyingVehicleSystem(scene);

      const playerX = Math.floor(WORLD_SIZE_X / 2);
      const playerZ = Math.floor(WORLD_SIZE_Z / 2);
      system.rebuild(world, GROUND_Y, 'audio-states-shrink-test');
      for (let i = 0; i < 600; i++) system.update(1 / 60, playerX, GROUND_Y, playerZ);

      const out: { dx: number; dy: number; dz: number; vx: number; vz: number }[] = [];
      system.getFlyerAudioStates(playerX, GROUND_Y, playerZ, out);
      expect(out.length).toBeGreaterThan(0);

      // Rebuilding into an empty world clears every flying vehicle.
      system.rebuild(new World(), GROUND_Y, 'audio-states-shrink-after');
      system.getFlyerAudioStates(playerX, GROUND_Y, playerZ, out);
      expect(out.length).toBe(0);
    });

    it('reports no flyers before rebuild() has ever been called', () => {
      const scene = new THREE.Scene();
      const system = buildFlyingVehicleSystem(scene);
      const out: { dx: number; dy: number; dz: number; vx: number; vz: number }[] = [];
      system.getFlyerAudioStates(0, 0, 0, out);
      expect(out.length).toBe(0);
    });
  });
});
