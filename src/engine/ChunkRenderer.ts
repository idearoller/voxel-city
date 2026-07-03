import * as THREE from 'three';
import { meshChunk } from './ChunkMesher';
import { neonMaterials, solidMaterial, windowLitMaterial } from './Materials';
import { parseChunkKey } from '../world/coords';
import type { World } from '../world/World';

const REBUILD_BUDGET_PER_FRAME = 4;

interface ChunkMeshes {
  solid: THREE.Mesh | null;
  windowLit: THREE.Mesh | null;
  neon: (THREE.Mesh | null)[];
}

/**
 * Owns one Three.js Mesh set per dirty chunk, rebuilding a bounded number of
 * chunks per frame from World data via ChunkMesher. Disposes stale geometry
 * on every rebuild; all-air chunks are skipped (no mesh created).
 */
export class ChunkRenderer {
  private readonly meshes = new Map<string, ChunkMeshes>();
  private readonly dirty = new Set<string>();

  constructor(
    private readonly world: World,
    private readonly scene: THREE.Scene,
  ) {
    this.world.onChunkDirty((key) => {
      this.dirty.add(key);
    });
  }

  /** Call once per frame; rebuilds up to REBUILD_BUDGET_PER_FRAME dirty chunks. */
  update(): void {
    let budget = REBUILD_BUDGET_PER_FRAME;
    for (const key of this.dirty) {
      if (budget <= 0) break;
      this.rebuildChunk(key);
      this.dirty.delete(key);
      budget--;
    }
  }

  /** Number of chunks still awaiting a mesh rebuild. */
  get pendingCount(): number {
    return this.dirty.size;
  }

  /**
   * Rebuilds every currently dirty chunk immediately, bypassing the
   * per-frame budget. Used right after city generation while a loading
   * overlay is still up: `remeshAll()` can mark 300+ chunks dirty at once,
   * and draining that at REBUILD_BUDGET_PER_FRAME would dribble the city in
   * chunk-by-chunk over dozens of frames with nothing to hide it. Doing the
   * full flush in one synchronous burst — still behind the overlay — means
   * the whole city appears at once instead.
   */
  rebuildAllDirty(): void {
    for (const key of this.dirty) {
      this.rebuildChunk(key);
    }
    this.dirty.clear();
  }

  private rebuildChunk(key: string): void {
    this.disposeChunk(key);

    const chunkCoord = parseChunkKey(key);
    const geometries = meshChunk(this.world, chunkCoord);

    const solidMesh = geometries.solid ? new THREE.Mesh(geometries.solid, solidMaterial) : null;
    if (solidMesh) this.scene.add(solidMesh);

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

    if (solidMesh || windowLitMesh || neonMeshes.some((m) => m !== null)) {
      this.meshes.set(key, { solid: solidMesh, windowLit: windowLitMesh, neon: neonMeshes });
    }
  }

  private disposeChunk(key: string): void {
    const existing = this.meshes.get(key);
    if (!existing) return;

    if (existing.solid) {
      this.scene.remove(existing.solid);
      existing.solid.geometry.dispose();
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
