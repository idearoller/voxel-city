import * as THREE from 'three';
import { elevatorPlatformMaterial, elevatorTrimMaterial } from './Materials';
import type { ElevatorShaft } from '../elevators/ElevatorScanner';
import type { ElevatorSimulation } from '../elevators/ElevatorSimulation';

const PLATFORM_GEOMETRY = new THREE.BoxGeometry(0.92, 0.12, 0.92);
/** Platform slab is centered on its own geometry; a rider's feet rest at its top, so the mesh origin sits half a slab-thickness below that. */
const PLATFORM_HALF_HEIGHT = 0.06;

/** Thin cyan trim strip along one edge of the slab — reads as a running indicator light, and gives the platform a facing direction. */
const TRIM_GEOMETRY = new THREE.BoxGeometry(0.92, 0.04, 0.14);
const TRIM_OFFSET_Y = 0.09;
const TRIM_OFFSET_Z = 0.39;

/**
 * Three.js presentation layer for elevator platforms: one `InstancedMesh`
 * pair (slab + trim) for every scanned shaft, two draw calls regardless of
 * count — same convention as `EntityRenderer`. Created once and never torn
 * down per rescan; `ElevatorSystem.render()` just re-syncs however many
 * instances are currently active.
 */
export class ElevatorRenderer {
  private readonly platformMesh: THREE.InstancedMesh;
  private readonly trimMesh: THREE.InstancedMesh;
  private readonly dummy = new THREE.Object3D();

  constructor(scene: THREE.Scene, maxShafts: number) {
    this.platformMesh = new THREE.InstancedMesh(PLATFORM_GEOMETRY, elevatorPlatformMaterial, maxShafts);
    this.trimMesh = new THREE.InstancedMesh(TRIM_GEOMETRY, elevatorTrimMaterial, maxShafts);

    for (const mesh of this.allMeshes()) {
      mesh.frustumCulled = false;
      mesh.count = 0;
      scene.add(mesh);
    }
  }

  private allMeshes(): THREE.InstancedMesh[] {
    return [this.platformMesh, this.trimMesh];
  }

  /** Call once per animation frame to sync instance matrices from the current car positions. */
  update(shafts: readonly ElevatorShaft[], simulation: ElevatorSimulation): void {
    const count = Math.min(shafts.length, this.platformMesh.instanceMatrix.count);

    for (let i = 0; i < count; i++) {
      const shaft = shafts[i] as ElevatorShaft;
      const car = simulation.car(shaft.id);
      const feetY = car?.feetY ?? (shaft.stops[0] as number);
      const centerX = shaft.wellX + 0.5;
      const centerZ = shaft.wellZ + 0.5;

      this.dummy.position.set(centerX, feetY - PLATFORM_HALF_HEIGHT, centerZ);
      this.dummy.rotation.set(0, 0, 0);
      this.dummy.updateMatrix();
      this.platformMesh.setMatrixAt(i, this.dummy.matrix);

      this.dummy.position.set(centerX, feetY + TRIM_OFFSET_Y, centerZ + TRIM_OFFSET_Z);
      this.dummy.updateMatrix();
      this.trimMesh.setMatrixAt(i, this.dummy.matrix);
    }

    this.platformMesh.count = count;
    this.trimMesh.count = count;
    this.platformMesh.instanceMatrix.needsUpdate = true;
    this.trimMesh.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    for (const mesh of this.allMeshes()) {
      mesh.parent?.remove(mesh);
      mesh.dispose();
    }
    PLATFORM_GEOMETRY.dispose();
    TRIM_GEOMETRY.dispose();
  }
}
