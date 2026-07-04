import type { ChunkCoord } from '../world/coords';
import {
  buildChunkMeshDataFromSnapshot,
  meshDataToBuffers,
  type ChunkMeshBuffers,
  type ChunkSnapshot,
  type MeshBuffers,
} from './ChunkMesher';

/**
 * Why a mesh job was requested — mirrors `world/World`'s `ChunkDirtyReason`
 * one layer up, so the scheduler (an engine/render concern) doesn't need a
 * runtime dependency on the world layer just to know which queue lane a job
 * belongs in.
 */
export type JobPriority = 'edit' | 'bulk';

/**
 * One chunk-meshing job, in the exact shape posted to a mesher worker: the
 * chunk's own voxels plus its padded border-opacity shell as *transferable*
 * `ArrayBuffer`s (zero-copy across the postMessage boundary), tagged with a
 * version so a stale result (superseded by a later edit before this job
 * finished) can be detected and discarded on arrival.
 */
export interface MesherJobRequest {
  key: string;
  chunk: ChunkCoord;
  version: number;
  voxels: ArrayBuffer;
  opaquePadded: ArrayBuffer;
}

export interface MesherJobResult {
  key: string;
  version: number;
  buffers: ChunkMeshBuffers;
}

function snapshotFromRequest(request: MesherJobRequest): ChunkSnapshot {
  return {
    voxels: new Uint8Array(request.voxels),
    opaquePadded: new Uint8Array(request.opaquePadded),
  };
}

/**
 * Pure request -> result mesh job. This is the *only* meshing logic a
 * mesher worker runs (see `mesherWorker.ts`), and the synchronous fallback
 * scheduler calls this exact same function in-process — so worker-path and
 * sync-path output is byte-identical by construction, not by convention.
 */
export function runMesherJob(request: MesherJobRequest): MesherJobResult {
  const snapshot = snapshotFromRequest(request);
  const meshData = buildChunkMeshDataFromSnapshot(snapshot, request.chunk);
  return { key: request.key, version: request.version, buffers: meshDataToBuffers(meshData) };
}

function collectGroupBuffers(list: ArrayBuffer[], group: MeshBuffers | null): void {
  if (!group) return;
  list.push(group.positions.buffer as ArrayBuffer, group.normals.buffer as ArrayBuffer, group.colors.buffer as ArrayBuffer);
}

/** Every underlying `ArrayBuffer` in a `ChunkMeshBuffers`, for use as a `postMessage` transfer list. */
export function collectTransferables(buffers: ChunkMeshBuffers): ArrayBuffer[] {
  const list: ArrayBuffer[] = [];
  collectGroupBuffers(list, buffers.solid);
  collectGroupBuffers(list, buffers.road);
  collectGroupBuffers(list, buffers.windowLit);
  for (const neonGroup of buffers.neon) {
    collectGroupBuffers(list, neonGroup);
  }
  return list;
}
