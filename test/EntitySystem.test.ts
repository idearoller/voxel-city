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
    system.render();

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
    system.render();

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
    system.render();

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
    system.render();

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
    system.render();

    const flyingVehicleBody = scene.children.find(
      (child) => child instanceof THREE.InstancedMesh && child.count > 0,
    );
    expect(flyingVehicleBody).toBeUndefined();
  });
});
