import { AIR, getBlock } from './BlockRegistry';
import { Chunk } from './Chunk';
import { CHUNK_SIZE, chunkKey, isInBounds, worldToChunk, worldToLocal } from './coords';

export type ChunkDirtyListener = (key: string) => void;

/**
 * Sparse voxel world: a Map of allocated chunks plus bounds-aware
 * get/set. No Three.js dependency — this module is pure data.
 */
export class World {
  private readonly chunks = new Map<string, Chunk>();
  private readonly listeners: ChunkDirtyListener[] = [];

  onChunkDirty(listener: ChunkDirtyListener): void {
    this.listeners.push(listener);
  }

  private markDirty(key: string): void {
    const chunk = this.chunks.get(key);
    if (chunk) {
      chunk.dirty = true;
    }
    for (const listener of this.listeners) {
      listener(key);
    }
  }

  private getChunk(cx: number, cy: number, cz: number): Chunk | undefined {
    return this.chunks.get(chunkKey(cx, cy, cz));
  }

  private getOrCreateChunk(cx: number, cy: number, cz: number): Chunk {
    const key = chunkKey(cx, cy, cz);
    let chunk = this.chunks.get(key);
    if (!chunk) {
      chunk = new Chunk();
      this.chunks.set(key, chunk);
    }
    return chunk;
  }

  /** Directly access an already-allocated chunk, if any (used by the mesher). */
  peekChunk(cx: number, cy: number, cz: number): Chunk | undefined {
    return this.getChunk(cx, cy, cz);
  }

  getBlock(x: number, y: number, z: number): number {
    if (!isInBounds(x, y, z)) {
      return AIR;
    }
    const { cx, cy, cz } = worldToChunk(x, y, z);
    const chunk = this.getChunk(cx, cy, cz);
    if (!chunk) {
      return AIR;
    }
    const { lx, ly, lz } = worldToLocal(x, y, z);
    return chunk.getLocal(lx, ly, lz);
  }

  isSolid(x: number, y: number, z: number): boolean {
    return getBlock(this.getBlock(x, y, z)).solid;
  }

  isOpaque(x: number, y: number, z: number): boolean {
    return getBlock(this.getBlock(x, y, z)).opaque;
  }

  /** Write a voxel, marking its chunk (and any bordered neighbor chunks) dirty. */
  setBlock(x: number, y: number, z: number, id: number): void {
    if (!isInBounds(x, y, z)) {
      return;
    }
    const { cx, cy, cz } = worldToChunk(x, y, z);
    const { lx, ly, lz } = worldToLocal(x, y, z);
    const chunk = this.getOrCreateChunk(cx, cy, cz);
    chunk.setLocal(lx, ly, lz, id);

    const key = chunkKey(cx, cy, cz);
    this.markDirty(key);
    this.markBorderNeighborsDirty(cx, cy, cz, lx, ly, lz);
  }

  /** Write a voxel without triggering any dirty notification (bulk/generator writes). */
  setBlockRaw(x: number, y: number, z: number, id: number): void {
    if (!isInBounds(x, y, z)) {
      return;
    }
    const { cx, cy, cz } = worldToChunk(x, y, z);
    const { lx, ly, lz } = worldToLocal(x, y, z);
    const chunk = this.getOrCreateChunk(cx, cy, cz);
    chunk.setLocal(lx, ly, lz, id);
  }

  /** Mark every currently-allocated chunk dirty (call once after bulk setBlockRaw writes). */
  remeshAll(): void {
    for (const key of this.chunks.keys()) {
      this.markDirty(key);
    }
  }

  private markBorderNeighborsDirty(
    cx: number,
    cy: number,
    cz: number,
    lx: number,
    ly: number,
    lz: number,
  ): void {
    const last = CHUNK_SIZE - 1;
    if (lx === 0) this.markNeighborIfAllocated(cx - 1, cy, cz);
    if (lx === last) this.markNeighborIfAllocated(cx + 1, cy, cz);
    if (ly === 0) this.markNeighborIfAllocated(cx, cy - 1, cz);
    if (ly === last) this.markNeighborIfAllocated(cx, cy + 1, cz);
    if (lz === 0) this.markNeighborIfAllocated(cx, cy, cz - 1);
    if (lz === last) this.markNeighborIfAllocated(cx, cy, cz + 1);
  }

  private markNeighborIfAllocated(cx: number, cy: number, cz: number): void {
    const key = chunkKey(cx, cy, cz);
    if (this.chunks.has(key)) {
      this.markDirty(key);
    }
  }
}
