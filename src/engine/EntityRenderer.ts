import * as THREE from 'three';
import {
  flyingVehicleBodyMaterial,
  flyingVehicleGlowMaterial,
  pedestrianAccentMaterial,
  pedestrianBodyMaterial,
  vehicleBodyMaterial,
  vehicleGlowMaterial,
} from './Materials';
import type { FlyingVehicle } from '../entities/FlyingVehicle';
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

/** Elongated silhouette (longer and lower than a ground car) so a flying vehicle reads as a distinct hover-car shape, not just a car floating in the sky. */
const FLYING_VEHICLE_BODY_GEOMETRY = new THREE.BoxGeometry(1.4, 0.45, 4.5);
const FLYING_VEHICLE_BODY_HALF_HEIGHT = 0.225;
/**
 * Underglow strip spanning almost the full body length, mounted low. A
 * single strip (rather than separate head/taillight instances) is
 * deliberate — see `EntityRenderer`'s class doc comment for why this stays
 * within the "1-2 InstancedMeshes" budget: at the distances these vehicles
 * are actually seen from (they fly well above the player, per `SkyLane.ts`),
 * a bright strip visible from any angle reads as "a moving light in the
 * sky" just as well as separate head/tail lights would.
 */
const FLYING_VEHICLE_GLOW_GEOMETRY = new THREE.BoxGeometry(1.3, 0.1, 4.3);
const FLYING_VEHICLE_GLOW_OFFSET_Y = -0.24;

/**
 * Three.js presentation layer for pedestrian/vehicle/flying-vehicle NPCs: one
 * `InstancedMesh` per (entity type, body part) pair, six draw calls total
 * regardless of population. Deliberately created once and never torn down
 * per city regeneration — `EntitySystem.rebuild` only resets the pure
 * simulation, so there is no per-regeneration GPU allocation to leak in the
 * first place. `frustumCulled = false` because instances range across the
 * whole city and default per-mesh bounds (built from one instance) would be
 * wrong; the capped population (~200 instances total) makes that cheap.
 */
export class EntityRenderer {
  private readonly pedestrianBodyMesh: THREE.InstancedMesh;
  private readonly pedestrianAccentMesh: THREE.InstancedMesh;
  private readonly vehicleBodyMesh: THREE.InstancedMesh;
  private readonly vehicleGlowMesh: THREE.InstancedMesh;
  private readonly flyingVehicleBodyMesh: THREE.InstancedMesh;
  private readonly flyingVehicleGlowMesh: THREE.InstancedMesh;
  private readonly dummy = new THREE.Object3D();
  /** Scratch vector for the vehicle glow strip's backward offset (see `updateVehicles`) — reused every frame instead of allocated per vehicle, since nothing holds a reference across frames. */
  private readonly vehicleForwardScratch = new THREE.Vector3();

  constructor(scene: THREE.Scene, maxPedestrians: number, maxVehicles: number, maxFlyingVehicles: number = 0) {
    this.pedestrianBodyMesh = new THREE.InstancedMesh(PEDESTRIAN_BODY_GEOMETRY, pedestrianBodyMaterial, maxPedestrians);
    this.pedestrianAccentMesh = new THREE.InstancedMesh(
      PEDESTRIAN_ACCENT_GEOMETRY,
      pedestrianAccentMaterial,
      maxPedestrians,
    );
    this.vehicleBodyMesh = new THREE.InstancedMesh(VEHICLE_BODY_GEOMETRY, vehicleBodyMaterial, maxVehicles);
    this.vehicleGlowMesh = new THREE.InstancedMesh(VEHICLE_GLOW_GEOMETRY, vehicleGlowMaterial, maxVehicles);
    this.flyingVehicleBodyMesh = new THREE.InstancedMesh(
      FLYING_VEHICLE_BODY_GEOMETRY,
      flyingVehicleBodyMaterial,
      maxFlyingVehicles,
    );
    this.flyingVehicleGlowMesh = new THREE.InstancedMesh(
      FLYING_VEHICLE_GLOW_GEOMETRY,
      flyingVehicleGlowMaterial,
      maxFlyingVehicles,
    );

    for (const mesh of this.allMeshes()) {
      mesh.frustumCulled = false;
      mesh.count = 0;
      scene.add(mesh);
    }
  }

  private allMeshes(): THREE.InstancedMesh[] {
    return [
      this.pedestrianBodyMesh,
      this.pedestrianAccentMesh,
      this.vehicleBodyMesh,
      this.vehicleGlowMesh,
      this.flyingVehicleBodyMesh,
      this.flyingVehicleGlowMesh,
    ];
  }

  /** Call once per animation frame (not the fixed sim tick) to sync instance matrices from current simulation state. */
  update(
    pedestrians: readonly Pedestrian[],
    vehicles: readonly Vehicle[],
    flyingVehicles: readonly FlyingVehicle[],
    groundY: number,
    elapsedTime: number,
  ): void {
    this.updatePedestrians(pedestrians, elapsedTime);
    this.updateVehicles(vehicles, groundY);
    this.updateFlyingVehicles(flyingVehicles);
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
      const forward = this.vehicleForwardScratch.set(0, 0, 1).applyEuler(this.dummy.rotation);
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

  /** No hover-bob, no ground offset — a flying vehicle's `y` is its own fixed lane altitude (see `FlyingVehicle.y`'s doc comment). */
  private updateFlyingVehicles(flyingVehicles: readonly FlyingVehicle[]): void {
    const count = Math.min(flyingVehicles.length, this.flyingVehicleBodyMesh.instanceMatrix.count);

    for (let i = 0; i < count; i++) {
      const vehicle = flyingVehicles[i] as FlyingVehicle;
      const yaw = vehicle.dirX !== 0 || vehicle.dirZ !== 0 ? Math.atan2(vehicle.dirX, vehicle.dirZ) : 0;

      this.dummy.position.set(vehicle.x, vehicle.y + FLYING_VEHICLE_BODY_HALF_HEIGHT, vehicle.z);
      this.dummy.rotation.set(0, yaw, 0);
      this.dummy.updateMatrix();
      this.flyingVehicleBodyMesh.setMatrixAt(i, this.dummy.matrix);

      this.dummy.position.y = vehicle.y + FLYING_VEHICLE_GLOW_OFFSET_Y;
      this.dummy.updateMatrix();
      this.flyingVehicleGlowMesh.setMatrixAt(i, this.dummy.matrix);
    }

    this.flyingVehicleBodyMesh.count = count;
    this.flyingVehicleGlowMesh.count = count;
    this.flyingVehicleBodyMesh.instanceMatrix.needsUpdate = true;
    this.flyingVehicleGlowMesh.instanceMatrix.needsUpdate = true;
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
    FLYING_VEHICLE_BODY_GEOMETRY.dispose();
    FLYING_VEHICLE_GLOW_GEOMETRY.dispose();
  }
}
