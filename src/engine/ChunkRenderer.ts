import * as THREE from 'three';
import { chunkMeshBuffersToGeometries } from './ChunkGeometryBuilder';
import type { ChunkMeshBuffers } from './ChunkMesher';
import { createDefaultMesherScheduler, type MesherScheduler } from './MesherScheduler';
import { neonMaterials, roadMaterial, solidMaterial, windowLitMaterial } from './Materials';
import { parseChunkKey } from '../world/coords';
import type { World } from '../world/World';

interface ChunkMeshes {
  solid: THREE.Mesh | null;
  road: THREE.Mesh | null;
  windowLit: THREE.Mesh | null;
  neon: (THREE.Mesh | null)[];
}

/** Resolves once no scheduler tick is scheduled to run sooner than the next animation frame (browser), or a macrotask tick (Node/vitest, which has no `requestAnimationFrame`). */
function scheduleTick(fn: () => void): void {
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(fn);
  } else {
    setTimeout(fn, 0);
  }
}

/**
 * Owns one Three.js Mesh set per dirty chunk, meshing through a
 * `MesherScheduler` (a worker pool in the browser, or an in-process
 * synchronous fallback) and applying a bounded number of completed results
 * per frame. Disposes stale geometry on every rebuild; all-air chunks are
 * skipped (no mesh created).
 */
export class ChunkRenderer {
  private readonly meshes = new Map<string, ChunkMeshes>();
  private readonly scheduler: MesherScheduler;

  constructor(
    world: World,
    private readonly scene: THREE.Scene,
    scheduler?: MesherScheduler,
  ) {
    this.scheduler = scheduler ?? createDefaultMesherScheduler(world);
    this.scheduler.onResult((key, buffers) => this.applyResult(key, buffers));
    world.onChunkDirty((key, reason) => {
      this.scheduler.requestMesh(key, parseChunkKey(key), reason);
    });
  }

  /** Call once per frame; pumps the scheduler (dispatch + apply up to its per-frame budget). */
  update(): void {
    this.scheduler.update();
  }

  /** Number of chunks whose latest requested mesh hasn't yet been applied. */
  get pendingCount(): number {
    return this.scheduler.pendingCount;
  }

  /**
   * Waits until every currently-pending chunk has been meshed and its
   * geometry applied — pumping the scheduler every animation frame rather
   * than blocking the main thread. Used right after city generation/import,
   * while a loading overlay is still up: `World.remeshAll()` can mark 300+
   * chunks dirty at once, and streaming that through the worker pool takes
   * many frames, but every one of them happens off the main thread and
   * behind the (still-visible) overlay, so nothing dribbles into view.
   */
  flushPending(): Promise<void> {
    return new Promise((resolve) => {
      const step = (): void => {
        this.scheduler.update();
        if (this.scheduler.pendingCount === 0) {
          resolve();
          return;
        }
        scheduleTick(step);
      };
      step();
    });
  }

  private applyResult(key: string, buffers: ChunkMeshBuffers): void {
    this.disposeChunk(key);

    const geometries = chunkMeshBuffersToGeometries(buffers);

    const solidMesh = geometries.solid ? new THREE.Mesh(geometries.solid, solidMaterial) : null;
    if (solidMesh) this.scene.add(solidMesh);

    const roadMesh = geometries.road ? new THREE.Mesh(geometries.road, roadMaterial) : null;
    if (roadMesh) this.scene.add(roadMesh);

    const windowLitMesh = geometries.windowLit
      ? new THREE.Mesh(geometries.windowLit, windowLitMaterial)
      : null;
    if (windowLitMesh) this.scene.add(windowLitMesh);

    const neonMeshes = geometries.neon.map((geometry, channel) => {
      if (!geometry) return null;
      const material = neonMaterials[channel] as THREE.MeshBasicMaterial;
      const mesh = new THREE.Mesh(geometry, material);
      this.scene.add(mesh);
      return mesh;
    });

    if (solidMesh || roadMesh || windowLitMesh || neonMeshes.some((m) => m !== null)) {
      this.meshes.set(key, { solid: solidMesh, road: roadMesh, windowLit: windowLitMesh, neon: neonMeshes });
    }
  }

  private disposeChunk(key: string): void {
    const existing = this.meshes.get(key);
    if (!existing) return;

    if (existing.solid) {
      this.scene.remove(existing.solid);
      existing.solid.geometry.dispose();
    }
    if (existing.road) {
      this.scene.remove(existing.road);
      existing.road.geometry.dispose();
    }
    if (existing.windowLit) {
      this.scene.remove(existing.windowLit);
      existing.windowLit.geometry.dispose();
    }
    for (const neonMesh of existing.neon) {
      if (!neonMesh) continue;
      this.scene.remove(neonMesh);
      neonMesh.geometry.dispose();
    }

    this.meshes.delete(key);
  }
}
