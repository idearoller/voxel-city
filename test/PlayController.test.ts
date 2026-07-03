import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { PlayController } from '../src/player/PlayController';
import { CONCRETE } from '../src/world/BlockRegistry';
import { World } from '../src/world/World';

const FIXED_DT = 1 / 60;

/** A camera facing world +X, independent of position (only orientation matters to PlayController). */
function forwardCamera(): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(0, 0, 0);
  camera.lookAt(new THREE.Vector3(1, 0, 0));
  return camera;
}

/**
 * Flat floor (y=0) for x in [0,9], then a 9-step staircase (x=10..19) rising
 * one voxel per column — the same shape as main.ts's temp test terrain,
 * rebuilt here so the test doesn't depend on main.ts's exact layout.
 */
function buildStaircaseWorld(): World {
  const world = new World();
  for (let x = 0; x <= 9; x++) {
    for (let z = 0; z <= 20; z++) {
      world.setBlockRaw(x, 0, z, CONCRETE);
    }
  }
  for (let step = 0; step <= 9; step++) {
    const x = 10 + step;
    for (let y = 0; y <= step; y++) {
      for (let z = 0; z <= 20; z++) {
        world.setBlockRaw(x, y, z, CONCRETE);
      }
    }
  }
  // Plateau at the top of the staircase so the walker doesn't march off a
  // cliff and free-fall once it reaches the top step — the test only cares
  // about the climb.
  for (let x = 20; x <= 60; x++) {
    for (let y = 0; y <= 9; y++) {
      for (let z = 0; z <= 20; z++) {
        world.setBlockRaw(x, y, z, CONCRETE);
      }
    }
  }
  return world;
}

function buildTwoVoxelWallWorld(): World {
  const world = new World();
  for (let x = 0; x <= 20; x++) {
    for (let z = 0; z <= 20; z++) {
      world.setBlockRaw(x, 0, z, CONCRETE);
    }
  }
  for (let y = 1; y <= 2; y++) {
    for (let z = 0; z <= 20; z++) {
      world.setBlockRaw(12, y, z, CONCRETE);
    }
  }
  return world;
}

describe('PlayController staircase climbing (integration)', () => {
  it('climbs a full staircase over many ticks of realistic forward walking input', () => {
    const world = buildStaircaseWorld();
    const controller = new PlayController(forwardCamera(), world);
    controller.setFeet([9.5, 1, 10]);
    controller.setKey('KeyW', true);

    const heightsOverTime: number[] = [];
    for (let tick = 0; tick < 200; tick++) {
      controller.update(FIXED_DT);
      heightsOverTime.push(controller.getFeet()[1]);
    }

    // Climbed essentially to the top of the 9-step staircase (surface height 10).
    const finalY = controller.getFeet()[1];
    expect(finalY).toBeGreaterThan(8);

    // Verify it actually rose over time (not just teleported/settled once) —
    // height at the 1/3 mark should be meaningfully below the final height.
    const earlyY = heightsOverTime[Math.floor(heightsOverTime.length / 3)] as number;
    expect(earlyY).toBeLessThan(finalY - 1);
  });

  it('does not climb a 2-voxel-tall wall — walks up to it and stops', () => {
    const world = buildTwoVoxelWallWorld();
    const controller = new PlayController(forwardCamera(), world);
    controller.setFeet([9.5, 1, 10]);
    controller.setKey('KeyW', true);

    for (let tick = 0; tick < 300; tick++) {
      controller.update(FIXED_DT);
    }

    const [finalX, finalY] = controller.getFeet();
    expect(finalY).toBeCloseTo(1, 1); // never left the ground floor
    expect(finalX).toBeLessThan(12); // stopped at the wall face, no clipping through
    expect(finalX).toBeGreaterThan(11); // actually walked up to it, not stuck at spawn
  });
});
