import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { EntityRenderer } from '../src/engine/EntityRenderer';
import { createFlyingVehicleOnLane, type FlyingVehicle } from '../src/entities/FlyingVehicle';
import { createPedestrianAt, type Pedestrian } from '../src/entities/Pedestrian';
import { createVehicleAt, type Vehicle } from '../src/entities/Vehicle';
import type { SkyLane } from '../src/entities/SkyLane';

const GROUND_Y = 1;

// EntityRenderer always creates and scene.add()s all six InstancedMeshes in
// this fixed order (see its constructor/allMeshes()), regardless of the
// max-count each was given -- so these indices into scene.children are
// stable across every test below.
const PEDESTRIAN_BODY_INDEX = 0;
const VEHICLE_BODY_INDEX = 2;
const FLYING_VEHICLE_BODY_INDEX = 4;

/**
 * Reads instance `index`'s world position and yaw back out of `mesh`.
 *
 * Yaw is recovered via the rotated forward vector (`atan2(vx, vz)`), not
 * `Euler.setFromQuaternion(...).y` -- Three.js's XYZ Euler extraction has a
 * well-known ambiguity for a pure-Y rotation once the angle passes roughly
 * pi/2 (it can equally validly report it as an X/Z-pi, Y=(pi - yaw) triple,
 * a different but equivalent rotation), which would make this test flaky in
 * exactly the wraparound-heavy cases it exists to check. The forward-vector
 * reading matches `EntityRenderer`'s own `atan2(dirX, dirZ)` convention
 * (`dummy.rotation.set(0, yaw, 0)` rotates the default `(0, 0, 1)` forward to
 * `(sin(yaw), 0, cos(yaw))`) and is unambiguous for any yaw.
 */
function readInstance(mesh: THREE.InstancedMesh, index: number): { x: number; y: number; z: number; yaw: number } {
  const matrix = new THREE.Matrix4();
  mesh.getMatrixAt(index, matrix);
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  matrix.decompose(position, quaternion, scale);
  const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(quaternion);
  return { x: position.x, y: position.y, z: position.z, yaw: Math.atan2(forward.x, forward.z) };
}

function meshAt(scene: THREE.Scene, index: number): THREE.InstancedMesh {
  return scene.children[index] as THREE.InstancedMesh;
}

describe('EntityRenderer alpha interpolation', () => {
  it('renders exactly at prev (position and heading) when alpha=0', () => {
    const scene = new THREE.Scene();
    const renderer = new EntityRenderer(scene, 4, 4, 4);
    const ped = createPedestrianAt(5, 5, GROUND_Y, 2) as Pedestrian;
    ped.prevX = 10;
    ped.prevZ = 20;
    ped.prevY = GROUND_Y;
    ped.x = 12;
    ped.z = 22;
    ped.dirX = 1;
    ped.dirZ = 0;
    ped.prevDirX = 0;
    ped.prevDirZ = 1;

    renderer.update([ped], [], [], GROUND_Y, 0, 0);

    const { x, z, yaw } = readInstance(meshAt(scene, PEDESTRIAN_BODY_INDEX), 0);
    expect(x).toBeCloseTo(10, 10);
    expect(z).toBeCloseTo(20, 10);
    expect(yaw).toBeCloseTo(Math.atan2(0, 1), 10); // prevDirX=0, prevDirZ=1
  });

  it('renders exactly at current (position and heading) when alpha=1', () => {
    const scene = new THREE.Scene();
    const renderer = new EntityRenderer(scene, 4, 4, 4);
    const ped = createPedestrianAt(5, 5, GROUND_Y, 2) as Pedestrian;
    ped.prevX = 10;
    ped.prevZ = 20;
    ped.prevY = GROUND_Y;
    ped.x = 12;
    ped.z = 22;
    ped.dirX = 1;
    ped.dirZ = 0;
    ped.prevDirX = 0;
    ped.prevDirZ = 1;

    renderer.update([ped], [], [], GROUND_Y, 0, 1);

    const { x, z, yaw } = readInstance(meshAt(scene, PEDESTRIAN_BODY_INDEX), 0);
    expect(x).toBeCloseTo(12, 10);
    expect(z).toBeCloseTo(22, 10);
    expect(yaw).toBeCloseTo(Math.atan2(1, 0), 10); // dirX=1, dirZ=0
  });

  it('renders the midpoint position at alpha=0.5', () => {
    const scene = new THREE.Scene();
    const renderer = new EntityRenderer(scene, 4, 4, 4);
    const ped = createPedestrianAt(5, 5, GROUND_Y, 2) as Pedestrian;
    ped.prevX = 0;
    ped.prevZ = 0;
    ped.prevY = GROUND_Y;
    ped.x = 10;
    ped.z = 20;

    renderer.update([ped], [], [], GROUND_Y, 0, 0.5);

    const { x, z } = readInstance(meshAt(scene, PEDESTRIAN_BODY_INDEX), 0);
    expect(x).toBeCloseTo(5, 10);
    expect(z).toBeCloseTo(10, 10);
  });

  it('turns a vehicle heading the short way across the +-pi wraparound, not the naive long way', () => {
    const scene = new THREE.Scene();
    const renderer = new EntityRenderer(scene, 4, 4, 4);
    const vehicle = createVehicleAt(5, 5, 6) as Vehicle;
    // Real Vehicle headings are grid-aligned (dirX/dirZ each in {-1,0,1}), but
    // EntityRenderer's yaw math (atan2 + shortestArcLerp) is generic --
    // driving fractional dir components here isolates that math from
    // `stepVehicle`'s own heading logic (already covered by Vehicle.test.ts).
    // atan2(0.01, -1) is just under +pi; atan2(-0.01, -1) is just under -pi --
    // two headings barely a hair apart on either side of due-south.
    vehicle.prevDirX = 0.01;
    vehicle.prevDirZ = -1;
    vehicle.dirX = -0.01;
    vehicle.dirZ = -1;

    renderer.update([], [vehicle], [], GROUND_Y, 0, 0.5);

    const { yaw } = readInstance(meshAt(scene, VEHICLE_BODY_INDEX), 0);
    // The short way stays right next to due-south (+-pi); a naive lerp
    // straight across the two raw atan2 values would instead average to
    // ~0 (due-north) -- exactly the bug this feature exists to fix.
    expect(Math.abs(yaw)).toBeGreaterThan(Math.PI - 0.1);
  });

  it("does not interpolate a flying vehicle's heading (fixed for its whole lifetime) but does interpolate its position", () => {
    const scene = new THREE.Scene();
    const renderer = new EntityRenderer(scene, 4, 4, 4);
    const lane: SkyLane = { axis: 'x', fixed: 150, altitude: 128, start: 0, end: 300 };
    const vehicle = createFlyingVehicleOnLane(lane, 50, 1, 20) as FlyingVehicle;
    vehicle.prevX = 40;
    vehicle.x = 60;

    renderer.update([], [], [vehicle], GROUND_Y, 0, 0.5);

    const { x, yaw } = readInstance(meshAt(scene, FLYING_VEHICLE_BODY_INDEX), 0);
    expect(x).toBeCloseTo(50, 10); // midpoint of 40 and 60
    expect(yaw).toBeCloseTo(Math.atan2(1, 0), 10); // dirX=1, dirZ=0 -- unchanged by alpha
  });
});
