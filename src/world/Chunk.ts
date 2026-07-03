import { CHUNK_VOXEL_COUNT, localIndex } from './coords';

/**
 * Dumb fixed-size voxel storage for one 32^3 chunk. Dirty tracking is owned
 * by World, not by Chunk itself.
 */
export class Chunk {
  readonly voxels: Uint8Array;
  dirty = true;

  constructor() {
    this.voxels = new Uint8Array(CHUNK_VOXEL_COUNT);
  }

  getLocal(lx: number, ly: number, lz: number): number {
    return this.voxels[localIndex(lx, ly, lz)] as number;
  }

  setLocal(lx: number, ly: number, lz: number, id: number): void {
    this.voxels[localIndex(lx, ly, lz)] = id;
  }
}
