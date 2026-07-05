import { describe, expect, it, vi } from 'vitest';
import {
  buildChunkMeshData,
  buildChunkSnapshot,
  meshDataToBuffers,
  paddedIndex,
} from '../src/engine/ChunkMesher';
import {
  PooledMesherScheduler,
  SyncMesherScheduler,
  createDefaultMesherScheduler,
  type MesherResultCallback,
  type WorkerLike,
} from '../src/engine/MesherScheduler';
import { runMesherJob, type MesherJobRequest, type MesherJobResult } from '../src/engine/mesherProtocol';
import { CONCRETE } from '../src/world/BlockRegistry';
import type { ChunkCoord } from '../src/world/coords';
import { World } from '../src/world/World';

const ORIGIN_CHUNK: ChunkCoord = { cx: 0, cy: 0, cz: 0 };
const ORIGIN_KEY = '0,0,0';

/**
 * In-process stand-in for a real `Worker`: `postMessage` just records the
 * request instead of handing it to a thread, and `respond` manually fires
 * the `onmessage` handler the scheduler installed. This is what makes
 * `PooledMesherScheduler`'s versioning/priority/dedup logic testable
 * synchronously, without a real Worker (unavailable in this Node/vitest
 * environment) and without timing flakiness.
 */
class FakeWorker implements WorkerLike {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  lastRequest: MesherJobRequest | null = null;
  terminated = false;

  postMessage(message: unknown): void {
    this.lastRequest = message as MesherJobRequest;
  }

  terminate(): void {
    this.terminated = true;
  }

  /** Manually delivers a result, as if the real worker thread had finished the job. */
  respond(result: MesherJobResult): void {
    this.onmessage?.({ data: result } as MessageEvent);
  }

  /** Computes the real mesh result for whatever request was last dispatched and delivers it — the common case where the test doesn't care about crafting a specific (possibly stale) response. */
  respondWithComputedResult(): void {
    if (!this.lastRequest) throw new Error('FakeWorker.respondWithComputedResult: no request dispatched yet');
    this.respond(runMesherJob(this.lastRequest));
  }

  /** Manually fires an `error` event, as if the real worker thread had thrown. */
  fail(message = 'boom'): void {
    this.onerror?.({ message, error: new Error(message) } as ErrorEvent);
  }
}

function poolOf(world: World, poolSize: number): { scheduler: PooledMesherScheduler; workers: FakeWorker[] } {
  const workers: FakeWorker[] = [];
  const scheduler = new PooledMesherScheduler(world, poolSize, () => {
    const worker = new FakeWorker();
    workers.push(worker);
    return worker;
  });
  return { scheduler, workers };
}

describe('PooledMesherScheduler dispatch', () => {
  it('posts a versioned request to a free worker on update()', () => {
    const world = new World();
    world.setBlock(5, 5, 5, CONCRETE);
    const { scheduler, workers } = poolOf(world, 1);

    scheduler.requestMesh(ORIGIN_KEY, ORIGIN_CHUNK, 'edit');
    expect(workers[0]?.lastRequest).toBeNull();

    scheduler.update();

    expect(workers[0]?.lastRequest?.key).toBe(ORIGIN_KEY);
    expect(workers[0]?.lastRequest?.version).toBe(1);
  });

  it('never dispatches the same key twice concurrently, even if requested twice before any dispatch', () => {
    const world = new World();
    const { scheduler, workers } = poolOf(world, 2);

    scheduler.requestMesh(ORIGIN_KEY, ORIGIN_CHUNK, 'edit');
    scheduler.requestMesh(ORIGIN_KEY, ORIGIN_CHUNK, 'edit');
    scheduler.update();

    const dispatchedCount = workers.filter((w) => w.lastRequest?.key === ORIGIN_KEY).length;
    expect(dispatchedCount).toBe(1);
    expect(workers.find((w) => w.lastRequest?.key === ORIGIN_KEY)?.lastRequest?.version).toBe(2);
  });

  it('lets an edit-priority job jump ahead of a queued bulk backlog', () => {
    const world = new World();
    const { scheduler, workers } = poolOf(world, 1);

    scheduler.requestMesh('1,0,0', { cx: 1, cy: 0, cz: 0 }, 'bulk');
    scheduler.requestMesh('2,0,0', { cx: 2, cy: 0, cz: 0 }, 'bulk');
    scheduler.requestMesh(ORIGIN_KEY, ORIGIN_CHUNK, 'edit');

    scheduler.update();

    expect(workers[0]?.lastRequest?.key).toBe(ORIGIN_KEY);
  });
});

describe('PooledMesherScheduler stale-result handling', () => {
  it('discards an in-flight result superseded by a later edit, and converges to the latest version', () => {
    const world = new World();
    world.setBlock(5, 5, 5, CONCRETE);
    const { scheduler, workers } = poolOf(world, 1);
    const worker = workers[0] as FakeWorker;

    const applied: { key: string; version: number }[] = [];
    const onResult: MesherResultCallback = (key) => applied.push({ key, version: worker.lastRequest?.version ?? -1 });
    scheduler.onResult(onResult);

    // Dispatch version 1, then edit again before it resolves.
    scheduler.requestMesh(ORIGIN_KEY, ORIGIN_CHUNK, 'edit');
    scheduler.update();
    const staleRequest = worker.lastRequest as MesherJobRequest;
    expect(staleRequest.version).toBe(1);

    scheduler.requestMesh(ORIGIN_KEY, ORIGIN_CHUNK, 'edit'); // bumps to version 2, re-queues (job still in flight)
    expect(scheduler.pendingCount).toBe(1);

    // The version-1 job finishes late: its result must be discarded, not
    // applied, and the freed worker immediately picks up the re-queued
    // version-2 job (redispatch happens inside the message handler itself,
    // not gated on the next update() tick).
    worker.respond(runMesherJob(staleRequest));
    expect(applied).toHaveLength(0);
    expect(scheduler.pendingCount).toBe(1); // still pending -- version 2 hasn't resolved yet
    expect(worker.lastRequest?.version).toBe(2);

    worker.respondWithComputedResult();
    scheduler.update(); // applies the ready result (apply step runs inside update())

    expect(applied).toHaveLength(1);
    expect(scheduler.pendingCount).toBe(0);
  });

  it('never leaves a superseded chunk permanently stuck pending', () => {
    const world = new World();
    const { scheduler, workers } = poolOf(world, 1);
    const worker = workers[0] as FakeWorker;

    for (let i = 0; i < 5; i++) {
      scheduler.requestMesh(ORIGIN_KEY, ORIGIN_CHUNK, 'edit');
    }
    scheduler.update();
    expect(worker.lastRequest?.version).toBe(5);

    worker.respondWithComputedResult();
    scheduler.update();

    expect(scheduler.pendingCount).toBe(0);
  });
});

describe('PooledMesherScheduler worker failure recovery', () => {
  it('frees the worker and retries the job when a worker throws instead of resolving', () => {
    const world = new World();
    world.setBlock(5, 5, 5, CONCRETE);
    const { scheduler, workers } = poolOf(world, 1);
    const worker = workers[0] as FakeWorker;
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const applied: string[] = [];
    scheduler.onResult((key) => applied.push(key));

    scheduler.requestMesh(ORIGIN_KEY, ORIGIN_CHUNK, 'edit');
    scheduler.update();
    expect(worker.lastRequest?.key).toBe(ORIGIN_KEY);

    worker.fail('synthetic worker crash');
    expect(scheduler.pendingCount).toBe(1); // not lost -- retried, not stuck

    scheduler.update(); // redispatches the retried job to the now-free worker
    expect(worker.lastRequest?.key).toBe(ORIGIN_KEY);

    worker.respondWithComputedResult();
    scheduler.update();

    expect(applied).toEqual([ORIGIN_KEY]);
    expect(scheduler.pendingCount).toBe(0);
    errorSpy.mockRestore();
  });

  it('gives up on a job that keeps failing instead of retrying it forever', () => {
    const world = new World();
    const { scheduler, workers } = poolOf(world, 1);
    const worker = workers[0] as FakeWorker;
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const applied: string[] = [];
    scheduler.onResult((key) => applied.push(key));

    scheduler.requestMesh(ORIGIN_KEY, ORIGIN_CHUNK, 'edit');
    scheduler.update();
    expect(worker.lastRequest?.key).toBe(ORIGIN_KEY);

    // Fail it repeatedly, past MAX_WORKER_RETRIES (3): every failure up to
    // the cap re-dispatches the same key; the one past the cap must drop it
    // instead of queuing yet another retry.
    for (let i = 0; i < 3; i++) {
      worker.fail('synthetic worker crash');
      expect(scheduler.pendingCount).toBe(1); // still retried within budget
      scheduler.update();
      expect(worker.lastRequest?.key).toBe(ORIGIN_KEY);
    }

    worker.fail('synthetic worker crash'); // the 4th consecutive failure -- past the cap
    expect(scheduler.pendingCount).toBe(0); // dropped, not left pending forever
    expect(warnSpy).toHaveBeenCalled();

    scheduler.update();
    expect(applied).toEqual([]); // never resolved -- dropped, not silently applied as empty geometry

    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('gives a chunk a fresh retry budget on a brand-new edit rather than inheriting a prior failure streak', () => {
    const world = new World();
    const { scheduler, workers } = poolOf(world, 1);
    const worker = workers[0] as FakeWorker;
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const applied: string[] = [];
    scheduler.onResult((key) => applied.push(key));

    scheduler.requestMesh(ORIGIN_KEY, ORIGIN_CHUNK, 'edit');
    scheduler.update();
    for (let i = 0; i < 3; i++) {
      worker.fail('synthetic worker crash');
      scheduler.update();
    }
    // 3 failures so far -- right at the cap, not yet past it.

    // A genuinely new edit to the same chunk should get its own clean
    // budget, not immediately be dropped by the old streak.
    scheduler.requestMesh(ORIGIN_KEY, ORIGIN_CHUNK, 'edit');
    scheduler.update();
    for (let i = 0; i < 3; i++) {
      worker.fail('synthetic worker crash');
      expect(scheduler.pendingCount).toBe(1);
      scheduler.update();
    }
    expect(warnSpy).not.toHaveBeenCalled();

    worker.respondWithComputedResult();
    scheduler.update();
    expect(applied).toEqual([ORIGIN_KEY]);

    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });
});

describe('SyncMesherScheduler (fallback path)', () => {
  it('meshes and applies synchronously within update(), respecting the per-frame apply budget', () => {
    const world = new World();
    const scheduler = new SyncMesherScheduler(world);
    const appliedKeys: string[] = [];
    scheduler.onResult((key) => appliedKeys.push(key));

    for (let i = 0; i < 6; i++) {
      world.setBlock(i * 32, 1, 1, CONCRETE);
      scheduler.requestMesh(`${i},0,0`, { cx: i, cy: 0, cz: 0 }, 'edit');
    }

    scheduler.update();
    expect(appliedKeys).toHaveLength(4);
    expect(scheduler.pendingCount).toBe(2);

    scheduler.update();
    expect(appliedKeys).toHaveLength(6);
    expect(scheduler.pendingCount).toBe(0);
  });
});

describe('createDefaultMesherScheduler', () => {
  it('falls back to the synchronous scheduler when Worker is unavailable (this test environment)', () => {
    expect(typeof Worker).toBe('undefined');

    const world = new World();
    world.setBlock(1, 1, 1, CONCRETE);
    const scheduler = createDefaultMesherScheduler(world);

    let received: string | null = null;
    scheduler.onResult((key) => {
      received = key;
    });
    scheduler.requestMesh(ORIGIN_KEY, ORIGIN_CHUNK, 'edit');
    scheduler.update();

    expect(received).toBe(ORIGIN_KEY);
    expect(scheduler.pendingCount).toBe(0);
  });
});

describe('worker-path / sync-path parity', () => {
  it('produces byte-identical geometry data for the same chunk + neighbor input, including across a chunk border', () => {
    const world = new World();
    // World x=31 is local x=31 of chunk (0,0,0); world x=32 is local x=0 of
    // the neighbor chunk (1,0,0) -- exercises cross-chunk face culling + AO.
    world.setBlock(31, 5, 5, CONCRETE);
    world.setBlock(32, 5, 5, CONCRETE);
    world.setBlock(31, 6, 5, CONCRETE); // extra occluder so an AO corner check also crosses the border

    const reference = meshDataToBuffers(buildChunkMeshData(world, ORIGIN_CHUNK));

    const snapshot = buildChunkSnapshot(world, ORIGIN_CHUNK);
    const request: MesherJobRequest = {
      key: ORIGIN_KEY,
      chunk: ORIGIN_CHUNK,
      version: 1,
      voxels: snapshot.voxels.buffer as ArrayBuffer,
      opaquePadded: snapshot.opaquePadded.buffer as ArrayBuffer,
    };
    const workerPathResult = runMesherJob(request);

    expect(workerPathResult.buffers).toEqual(reference);
    // Index parity pinned explicitly rather than implied by the deep-equal
    // above: the typed-array TYPE must match too (a Uint16/Uint32 divergence
    // between the paths would corrupt rendering only on dense chunks).
    const workerIndices = workerPathResult.buffers.solid?.indices;
    const referenceIndices = reference.solid?.indices;
    expect(workerIndices).toBeInstanceOf(Uint16Array);
    expect(workerIndices?.constructor).toBe(referenceIndices?.constructor);
    expect(workerIndices && Array.from(workerIndices)).toEqual(referenceIndices && Array.from(referenceIndices));
  });

  it('buildChunkSnapshot\'s padded opacity shell reflects a neighbor chunk\'s voxel across the border', () => {
    const world = new World();
    world.setBlock(32, 5, 5, CONCRETE); // local (0,5,5) of chunk (1,0,0), one voxel past (0,0,0)'s +x border

    const snapshot = buildChunkSnapshot(world, ORIGIN_CHUNK);

    expect(snapshot.opaquePadded[paddedIndex(32, 5, 5)]).toBe(1);
    expect(snapshot.opaquePadded[paddedIndex(31, 5, 5)]).toBe(0);
  });
});
