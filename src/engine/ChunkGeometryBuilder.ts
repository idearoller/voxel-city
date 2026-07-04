import * as THREE from 'three';
import { buildChunkMeshData, meshDataToBuffers, type ChunkMeshBuffers, type MeshBuffers } from './ChunkMesher';
import type { ChunkCoord } from '../world/coords';
import type { World } from '../world/World';

export interface ChunkGeometries {
  solid: THREE.BufferGeometry | null;
  road: THREE.BufferGeometry | null;
  windowLit: THREE.BufferGeometry | null;
  neon: [
    THREE.BufferGeometry | null,
    THREE.BufferGeometry | null,
    THREE.BufferGeometry | null,
    THREE.BufferGeometry | null,
  ];
}

function buffersToGeometry(buffers: MeshBuffers | null): THREE.BufferGeometry | null {
  if (!buffers) return null;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(buffers.positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(buffers.normals, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(buffers.colors, 3));
  return geometry;
}

/** Builds real Three.js BufferGeometries from a `ChunkMeshBuffers` — the only place in this module set that touches Three.js. Used identically whether the buffers came from a mesher worker or the synchronous fallback path. */
export function chunkMeshBuffersToGeometries(buffers: ChunkMeshBuffers): ChunkGeometries {
  return {
    solid: buffersToGeometry(buffers.solid),
    road: buffersToGeometry(buffers.road),
    windowLit: buffersToGeometry(buffers.windowLit),
    neon: [
      buffersToGeometry(buffers.neon[0]),
      buffersToGeometry(buffers.neon[1]),
      buffersToGeometry(buffers.neon[2]),
      buffersToGeometry(buffers.neon[3]),
    ],
  };
}

/**
 * Synchronous, no-worker convenience: mesh one chunk directly from `World`
 * on the calling thread. Used by the sync fallback scheduler and as the
 * reference implementation tests diff worker-path output against (see
 * `test/MesherScheduler.test.ts`'s parity check).
 */
export function meshChunk(world: World, chunk: ChunkCoord): ChunkGeometries {
  return chunkMeshBuffersToGeometries(meshDataToBuffers(buildChunkMeshData(world, chunk)));
}
