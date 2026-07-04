import { buildChunkSnapshot, type ChunkMeshBuffers } from './ChunkMesher';
import { runMesherJob, type JobPriority, type MesherJobRequest, type MesherJobResult } from './mesherProtocol';
import type { ChunkCoord } from '../world/coords';
import type { World } from '../world/World';

export type { JobPriority } from './mesherProtocol';

/**
 * Chunks whose latest requested mesh has been applied are dropped from
 * `pendingCount`. Applying a result means building a `THREE.BufferGeometry`
 * and adding/removing it from the scene — capped per `update()` call so a
 * full-city remesh (streaming hundreds of results through the pool) never
 * dumps all of them into a single frame. Matches the old pre-worker
 * `REBUILD_BUDGET_PER_FRAME`.
 */
const APPLY_BUDGET_PER_FRAME = 4;

/** Cap on concurrent mesher workers: enough to saturate typical machines without starving the main thread's own per-frame work. */
const MAX_POOL_SIZE = 4;

export type MesherResultCallback = (key: string, buffers: ChunkMeshBuffers) => void;

/**
 * Abstraction ChunkRenderer talks to instead of calling `meshChunk`
 * directly — lets meshing happen off the main thread (`PooledMesherScheduler`)
 * or in-process (`SyncMesherScheduler`, used in tests and as the fallback
 * when `Worker` isn't available) behind one interface.
 */
export interface MesherScheduler {
  /** Request (or re-request) a mesh for `key`. Safe to call repeatedly — de-dupes in the queue and bumps the chunk's version so any in-flight job for a stale version gets its result discarded on arrival. */
  requestMesh(key: string, chunk: ChunkCoord, priority: JobPriority): void;
  /** Registers the callback invoked with each completed, non-stale mesh result. */
  onResult(callback: MesherResultCallback): void;
  /** Pump once per frame: dispatch queued jobs to free workers (or run them synchronously), and apply up to `APPLY_BUDGET_PER_FRAME` completed results. */
  update(): void;
  /** Number of chunks whose latest requested version hasn't yet been applied. */
  readonly pendingCount: number;
  dispose(): void;
}

/**
 * Ordered, deduplicated job queue shared by both scheduler implementations:
 * two priority lanes (edit jobs always drain before bulk ones — an edited
 * chunk "jumps the queue" ahead of a full-city remesh in flight), with a
 * `Set` guarding against a key being queued twice.
 */
class PriorityKeyQueue {
  private readonly editLane: string[] = [];
  private readonly bulkLane: string[] = [];
  private readonly queued = new Set<string>();

  enqueue(key: string, priority: JobPriority): void {
    if (this.queued.has(key)) return;
    this.queued.add(key);
    (priority === 'edit' ? this.editLane : this.bulkLane).push(key);
  }

  /** Removes and returns the next key not present in `skip` (an in-flight set), leaving skipped keys in place for a later call. */
  takeNext(skip: ReadonlySet<string>): string | undefined {
    for (const lane of [this.editLane, this.bulkLane]) {
      for (let i = 0; i < lane.length; i++) {
        const key = lane[i] as string;
        if (!skip.has(key)) {
          lane.splice(i, 1);
          this.queued.delete(key);
          return key;
        }
      }
    }
    return undefined;
  }

  /** Unconditionally removes and returns the next key, ignoring in-flight status (used by the sync scheduler, which never has in-flight jobs). */
  shift(): string | undefined {
    const key = this.editLane.shift() ?? this.bulkLane.shift();
    if (key !== undefined) this.queued.delete(key);
    return key;
  }
}

/**
 * In-process fallback: meshes synchronously on the calling thread via the
 * same `runMesherJob` a worker would run, just without a worker. Used when
 * `Worker` isn't available (Node/vitest) and as the pool's structural twin
 * for tests. Never produces a stale result (nothing runs concurrently), so
 * every processed job is applied unconditionally.
 */
export class SyncMesherScheduler implements MesherScheduler {
  private readonly queue = new PriorityKeyQueue();
  private readonly chunkByKey = new Map<string, ChunkCoord>();
  private readonly versionByKey = new Map<string, number>();
  private readonly pendingKeys = new Set<string>();
  private resultCallback: MesherResultCallback | null = null;

  constructor(private readonly world: World) {}

  requestMesh(key: string, chunk: ChunkCoord, priority: JobPriority): void {
    this.chunkByKey.set(key, chunk);
    this.versionByKey.set(key, (this.versionByKey.get(key) ?? 0) + 1);
    this.pendingKeys.add(key);
    this.queue.enqueue(key, priority);
  }

  onResult(callback: MesherResultCallback): void {
    this.resultCallback = callback;
  }

  get pendingCount(): number {
    return this.pendingKeys.size;
  }

  update(): void {
    let budget = APPLY_BUDGET_PER_FRAME;
    while (budget > 0) {
      const key = this.queue.shift();
      if (key === undefined) break;
      this.processOne(key);
      budget--;
    }
  }

  dispose(): void {
    // Nothing to tear down: no worker threads, no in-flight jobs.
  }

  private processOne(key: string): void {
    const chunk = this.chunkByKey.get(key);
    if (!chunk) return;
    const version = this.versionByKey.get(key) as number;
    const request = buildRequest(this.world, key, chunk, version);
    const result = runMesherJob(request);
    this.pendingKeys.delete(key);
    this.resultCallback?.(key, result.buffers);
  }
}

/** Minimal Worker surface the pool depends on — lets tests inject a fake in-process "worker" without spinning a real thread. */
export interface WorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  terminate(): void;
}

/**
 * Streams mesh jobs through a fixed pool of `Worker`s. Snapshots are taken
 * (and voxel/opacity `ArrayBuffer`s copied) at *dispatch* time, not at
 * request time, so a job that's still queued when a chunk changes again
 * simply gets meshed fresh once it's actually dispatched — no staleness is
 * even possible there. Staleness is only possible for a job already
 * in-flight in a worker when a newer edit arrives; `requestMesh` bumps the
 * chunk's version in that case, and the result handler discards any
 * response whose version doesn't match the latest.
 */
export class PooledMesherScheduler implements MesherScheduler {
  private readonly workers: WorkerLike[];
  private readonly freeWorkerIndices: number[];
  private readonly busyKeyByWorker = new Map<number, string>();
  private readonly queue = new PriorityKeyQueue();
  private readonly readyResults: MesherJobResult[] = [];
  private readonly chunkByKey = new Map<string, ChunkCoord>();
  private readonly versionByKey = new Map<string, number>();
  private readonly pendingKeys = new Set<string>();
  private resultCallback: MesherResultCallback | null = null;

  constructor(
    private readonly world: World,
    poolSize: number,
    createWorker: () => WorkerLike,
  ) {
    this.workers = Array.from({ length: Math.max(1, poolSize) }, () => createWorker());
    this.freeWorkerIndices = this.workers.map((_worker, index) => index);
    this.workers.forEach((worker, index) => {
      worker.onmessage = (event: MessageEvent): void => {
        this.handleMessage(index, event.data as MesherJobResult);
      };
      worker.onerror = (event: ErrorEvent): void => {
        this.handleWorkerError(index, event);
      };
    });
  }

  requestMesh(key: string, chunk: ChunkCoord, priority: JobPriority): void {
    this.chunkByKey.set(key, chunk);
    this.versionByKey.set(key, (this.versionByKey.get(key) ?? 0) + 1);
    this.pendingKeys.add(key);
    this.queue.enqueue(key, priority);
  }

  onResult(callback: MesherResultCallback): void {
    this.resultCallback = callback;
  }

  get pendingCount(): number {
    return this.pendingKeys.size;
  }

  update(): void {
    this.dispatchAvailable();
    this.applyReady();
  }

  dispose(): void {
    for (const worker of this.workers) worker.terminate();
  }

  private dispatchAvailable(): void {
    const inFlight = new Set(this.busyKeyByWorker.values());
    while (this.freeWorkerIndices.length > 0) {
      const key = this.queue.takeNext(inFlight);
      if (key === undefined) break;
      this.dispatch(key);
      inFlight.add(key);
    }
  }

  private dispatch(key: string): void {
    const workerIndex = this.freeWorkerIndices.pop();
    if (workerIndex === undefined) return;
    const chunk = this.chunkByKey.get(key);
    if (!chunk) {
      this.freeWorkerIndices.push(workerIndex);
      return;
    }
    const version = this.versionByKey.get(key) as number;
    const request = buildRequest(this.world, key, chunk, version);
    this.busyKeyByWorker.set(workerIndex, key);
    this.workers[workerIndex]?.postMessage(request, [request.voxels, request.opaquePadded]);
  }

  private handleMessage(workerIndex: number, result: MesherJobResult): void {
    this.busyKeyByWorker.delete(workerIndex);
    this.freeWorkerIndices.push(workerIndex);
    if (this.versionByKey.get(result.key) === result.version) {
      this.readyResults.push(result);
    }
    // Stale result (a newer edit arrived while this job was in flight):
    // discarded. `requestMesh` already re-queued this key when it bumped
    // the version, so the next `dispatchAvailable` will mesh it fresh.
    this.dispatchAvailable();
  }

  /**
   * A worker throwing (rather than resolving) leaves it permanently busy in
   * `busyKeyByWorker` unless we recover here: free the slot and re-queue
   * the job that was in flight so it gets retried (possibly by a different
   * worker), rather than that one chunk staying unmeshed forever and,
   * eventually, every worker in the pool wedging on its own bad job.
   */
  private handleWorkerError(workerIndex: number, event: ErrorEvent): void {
    const key = this.busyKeyByWorker.get(workerIndex);
    this.busyKeyByWorker.delete(workerIndex);
    this.freeWorkerIndices.push(workerIndex);
    // eslint-disable-next-line no-console
    console.error('[MesherScheduler] mesher worker failed on chunk', key, event.message, event.error);
    if (key !== undefined && this.chunkByKey.has(key)) {
      this.queue.enqueue(key, 'edit');
    }
    this.dispatchAvailable();
  }

  private applyReady(): void {
    let budget = APPLY_BUDGET_PER_FRAME;
    while (budget > 0 && this.readyResults.length > 0) {
      const result = this.readyResults.shift();
      if (!result) break;
      if (this.versionByKey.get(result.key) !== result.version) continue; // superseded between arrival and application
      this.pendingKeys.delete(result.key);
      this.resultCallback?.(result.key, result.buffers);
      budget--;
    }
  }
}

function buildRequest(world: World, key: string, chunk: ChunkCoord, version: number): MesherJobRequest {
  const snapshot = buildChunkSnapshot(world, chunk);
  return {
    key,
    chunk,
    version,
    voxels: snapshot.voxels.buffer as ArrayBuffer,
    opaquePadded: snapshot.opaquePadded.buffer as ArrayBuffer,
  };
}

function defaultPoolSize(): number {
  const hardwareConcurrency = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : undefined;
  return Math.max(1, Math.min(MAX_POOL_SIZE, hardwareConcurrency ?? MAX_POOL_SIZE));
}

function defaultWorkerFactory(): WorkerLike {
  return new Worker(new URL('./mesherWorker.ts', import.meta.url), { type: 'module' }) as unknown as WorkerLike;
}

/**
 * Picks the right scheduler for the current environment: a pooled worker
 * scheduler in the browser, or the synchronous fallback wherever `Worker`
 * isn't available (Node/vitest today; conceivably some other constrained
 * embedder in the future).
 */
export function createDefaultMesherScheduler(world: World): MesherScheduler {
  if (typeof Worker === 'undefined') {
    return new SyncMesherScheduler(world);
  }
  return new PooledMesherScheduler(world, defaultPoolSize(), defaultWorkerFactory);
}
