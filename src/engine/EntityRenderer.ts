import * as THREE from 'three';
import {
  pedestrianAccentMaterial,
  pedestrianBodyMaterial,
  vehicleBodyMaterial,
  vehicleGlowMaterial,
} from './Materials';
import type { Pedestrian } from '../entities/Pedestrian';
import type { Vehicle } from '../entities/Vehicle';

const PEDESTRIAN_BODY_GEOMETRY = new THREE.BoxGeometry(0.5, 1.5, 0.3);
const PEDESTRIAN_BODY_HALF_HEIGHT = 0.75;
/** Visor/collar accent, mounted near the top of the body box. */
const PEDESTRIAN_ACCENT_GEOMETRY = new THREE.BoxGeometry(0.22, 0.1, 0.32);
const PEDESTRIAN_ACCENT_OFFSET_Y = 0.55;

const VEHICLE_BODY_GEOMETRY = new THREE.BoxGeometry(1.6, 0.6, 3.2);
const VEHICLE_BODY_HALF_HEIGHT = 0.3;
/** Rear underglow/taillight strip, mounted low and at the back of the body box. */
const VEHICLE_GLOW_GEOMETRY = new THREE.BoxGeometry(1.5, 0.12, 0.2);
const VEHICLE_GLOW_OFFSET_Y = -0.28;
const VEHICLE_GLOW_OFFSET_FORWARD = -1.4;

/** Hover height above the road surface — sells the "hover-car" read. */
const VEHICLE_HOVER_HEIGHT = 0.55;

const BOB_AMPLITUDE = 0.06;
const BOB_FREQUENCY = 6.5;

/**
 * Three.js presentation layer for pedestrian/vehicle NPCs: one `InstancedMesh`
 * per (entity type, body part) pair, four draw calls total regardless of
 * population. Deliberately created once and never torn down per city
 * regeneration — `EntitySystem.rebuild` only resets the pure simulation, so
 * there is no per-regeneration GPU allocation to leak in the first place.
 * `frustumCulled = false` because instances range across the whole city and
 * default per-mesh bounds (built from one instance) would be wrong; the
 * capped population (~160 instances total) makes that cheap.
 */
export class EntityRenderer {
  private readonly pedestrianBodyMesh: THREE.InstancedMesh;
  private readonly pedestrianAccentMesh: THREE.InstancedMesh;
  private readonly vehicleBodyMesh: THREE.InstancedMesh;
  private readonly vehicleGlowMesh: THREE.InstancedMesh;
  private readonly dummy = new THREE.Object3D();

  constructor(scene: THREE.Scene, maxPedestrians: number, maxVehicles: number) {
    this.pedestrianBodyMesh = new THREE.InstancedMesh(PEDESTRIAN_BODY_GEOMETRY, pedestrianBodyMaterial, maxPedestrians);
    this.pedestrianAccentMesh = new THREE.InstancedMesh(
      PEDESTRIAN_ACCENT_GEOMETRY,
      pedestrianAccentMaterial,
      maxPedestrians,
    );
    this.vehicleBodyMesh = new THREE.InstancedMesh(VEHICLE_BODY_GEOMETRY, vehicleBodyMaterial, maxVehicles);
    this.vehicleGlowMesh = new THREE.InstancedMesh(VEHICLE_GLOW_GEOMETRY, vehicleGlowMaterial, maxVehicles);

    for (const mesh of this.allMeshes()) {
      mesh.frustumCulled = false;
      mesh.count = 0;
      scene.add(mesh);
    }
  }

  private allMeshes(): THREE.InstancedMesh[] {
    return [this.pedestrianBodyMesh, this.pedestrianAccentMesh, this.vehicleBodyMesh, this.vehicleGlowMesh];
  }

  /** Call once per animation frame (not the fixed sim tick) to sync instance matrices from current simulation state. */
  update(
    pedestrians: readonly Pedestrian[],
    vehicles: readonly Vehicle[],
    groundY: number,
    elapsedTime: number,
  ): void {
    this.updatePedestrians(pedestrians, elapsedTime);
    this.updateVehicles(vehicles, groundY);
  }

  private updatePedestrians(pedestrians: readonly Pedestrian[], elapsedTime: number): void {
    const count = Math.min(pedestrians.length, this.pedestrianBodyMesh.instanceMatrix.count);

    for (let i = 0; i < count; i++) {
      const ped = pedestrians[i] as Pedestrian;
      const feetY = ped.y + 1;
      const yaw = ped.dirX !== 0 || ped.dirZ !== 0 ? Math.atan2(ped.dirX, ped.dirZ) : 0;
      const bob = Math.sin(elapsedTime * BOB_FREQUENCY + i) * BOB_AMPLITUDE;

      this.dummy.position.set(ped.x, feetY + PEDESTRIAN_BODY_HALF_HEIGHT + bob, ped.z);
      this.dummy.rotation.set(0, yaw, 0);
      this.dummy.updateMatrix();
      this.pedestrianBodyMesh.setMatrixAt(i, this.dummy.matrix);

      this.dummy.position.y = feetY + PEDESTRIAN_ACCENT_OFFSET_Y + bob;
      this.dummy.updateMatrix();
      this.pedestrianAccentMesh.setMatrixAt(i, this.dummy.matrix);
    }

    this.pedestrianBodyMesh.count = count;
    this.pedestrianAccentMesh.count = count;
    this.pedestrianBodyMesh.instanceMatrix.needsUpdate = true;
    this.pedestrianAccentMesh.instanceMatrix.needsUpdate = true;
  }

  private updateVehicles(vehicles: readonly Vehicle[], groundY: number): void {
    const feetY = groundY + 1;
    const count = Math.min(vehicles.length, this.vehicleBodyMesh.instanceMatrix.count);

    for (let i = 0; i < count; i++) {
      const vehicle = vehicles[i] as Vehicle;
      const yaw = vehicle.dirX !== 0 || vehicle.dirZ !== 0 ? Math.atan2(vehicle.dirX, vehicle.dirZ) : 0;

      this.dummy.position.set(vehicle.x, feetY + VEHICLE_HOVER_HEIGHT + VEHICLE_BODY_HALF_HEIGHT, vehicle.z);
      this.dummy.rotation.set(0, yaw, 0);
      this.dummy.updateMatrix();
      this.vehicleBodyMesh.setMatrixAt(i, this.dummy.matrix);

      // Offset backward along the vehicle's own heading so the glow strip reads as a taillight, not a headlight.
      const forward = new THREE.Vector3(0, 0, 1).applyEuler(this.dummy.rotation);
      this.dummy.position.addScaledVector(forward, VEHICLE_GLOW_OFFSET_FORWARD);
      this.dummy.position.y = feetY + VEHICLE_HOVER_HEIGHT + VEHICLE_GLOW_OFFSET_Y;
      this.dummy.updateMatrix();
      this.vehicleGlowMesh.setMatrixAt(i, this.dummy.matrix);
    }

    this.vehicleBodyMesh.count = count;
    this.vehicleGlowMesh.count = count;
    this.vehicleBodyMesh.instanceMatrix.needsUpdate = true;
    this.vehicleGlowMesh.instanceMatrix.needsUpdate = true;
  }

  /** Full teardown (app shutdown only — see class doc comment for why per-regeneration disposal isn't needed). */
  dispose(): void {
    for (const mesh of this.allMeshes()) {
      mesh.parent?.remove(mesh);
      mesh.dispose();
    }
    PEDESTRIAN_BODY_GEOMETRY.dispose();
    PEDESTRIAN_ACCENT_GEOMETRY.dispose();
    VEHICLE_BODY_GEOMETRY.dispose();
    VEHICLE_GLOW_GEOMETRY.dispose();
  }
}
