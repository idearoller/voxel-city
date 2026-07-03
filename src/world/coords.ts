/**
 * World <-> chunk <-> local coordinate math. Pure functions, no Three.js.
 *
 * World bounds: 384 x 384 x 160 (x, z horizontal; y vertical).
 * Chunk size: 32^3.
 * Local voxel index within a chunk: x + z*32 + y*32*32 (i.e. x + z*32 + y*1024).
 */

export const CHUNK_SIZE = 32;
export const CHUNK_VOXEL_COUNT = CHUNK_SIZE * CHUNK_SIZE * CHUNK_SIZE;

export const WORLD_SIZE_X = 384;
export const WORLD_SIZE_Z = 384;
export const WORLD_SIZE_Y = 160;

/** Floor division that behaves correctly for negative inputs (unlike Math.trunc / `| 0`). */
export function floorDiv(a: number, b: number): number {
  return Math.floor(a / b);
}

/** Euclidean-style modulo that always returns a value in [0, b). */
export function floorMod(a: number, b: number): number {
  const m = a % b;
  if (m === 0) return 0; // normalizes -0 to 0
  return m < 0 ? m + b : m;
}

export interface ChunkCoord {
  cx: number;
  cy: number;
  cz: number;
}

export interface LocalCoord {
  lx: number;
  ly: number;
  lz: number;
}

/** World voxel coordinate -> the chunk coordinate that contains it. */
export function worldToChunk(x: number, y: number, z: number): ChunkCoord {
  return {
    cx: floorDiv(x, CHUNK_SIZE),
    cy: floorDiv(y, CHUNK_SIZE),
    cz: floorDiv(z, CHUNK_SIZE),
  };
}

/** World voxel coordinate -> local coordinate within its owning chunk. */
export function worldToLocal(x: number, y: number, z: number): LocalCoord {
  return {
    lx: floorMod(x, CHUNK_SIZE),
    ly: floorMod(y, CHUNK_SIZE),
    lz: floorMod(z, CHUNK_SIZE),
  };
}

/** Chunk coordinate + local coordinate -> world voxel coordinate. */
export function chunkLocalToWorld(chunk: ChunkCoord, local: LocalCoord): {
  x: number;
  y: number;
  z: number;
} {
  return {
    x: chunk.cx * CHUNK_SIZE + local.lx,
    y: chunk.cy * CHUNK_SIZE + local.ly,
    z: chunk.cz * CHUNK_SIZE + local.lz,
  };
}

/** Local (within-chunk) coordinate -> flat index into a chunk's Uint8Array(32768). */
export function localIndex(lx: number, ly: number, lz: number): number {
  return lx + lz * CHUNK_SIZE + ly * CHUNK_SIZE * CHUNK_SIZE;
}

/** Stable string key for a chunk coordinate, used as the World's chunk map key. */
export function chunkKey(cx: number, cy: number, cz: number): string {
  return `${cx},${cy},${cz}`;
}

/** Inverse of chunkKey. */
export function parseChunkKey(key: string): ChunkCoord {
  const parts = key.split(',');
  const cx = Number(parts[0]);
  const cy = Number(parts[1]);
  const cz = Number(parts[2]);
  return { cx, cy, cz };
}

/** True if the world voxel coordinate lies within the finite world bounds. */
export function isInBounds(x: number, y: number, z: number): boolean {
  return (
    x >= 0 && x < WORLD_SIZE_X && y >= 0 && y < WORLD_SIZE_Y && z >= 0 && z < WORLD_SIZE_Z
  );
}
