import { describe, expect, it } from 'vitest';
import { buildChunkMeshDataFromSnapshot, buildChunkSnapshot, type ChunkMeshData } from '../src/engine/ChunkMesher';
import { generateCity } from '../src/gen/CityGenerator';
import { World } from '../src/world/World';

/**
 * Perf harness backing the Phase 2 Task 6 "is greedy meshing warranted?"
 * decision (see `PERF.md`). Meshes every chunk a real generated city
 * actually allocates — not a synthetic stress case — with the same
 * `buildChunkSnapshot` + `buildChunkMeshDataFromSnapshot` pair the worker
 * pool runs per chunk (`MesherScheduler.buildRequest` / `mesherWorker.ts`),
 * and reports triangle counts + wall-clock mesh time.
 *
 * This is a measurement + regression guard, not a strict perf gate: the
 * assertions use generous upper bounds (documented inline) so the test
 * fails loudly if meshing gets *dramatically* slower or triangle counts
 * balloon far past what a naive culled mesher on this city size should
 * produce, without being flaky on ordinary machine-to-machine variance.
 */

/** Vertex positions are 3 floats each, 3 vertices per triangle. */
function triangleCount(data: ChunkMeshData): number {
  const groups = [data.solid, data.road, data.windowLit, ...data.neon];
  return groups.reduce((sum, group) => sum + group.positions.length / 9, 0);
}

describe('mesher performance (real generated-city chunks)', () => {
  it('meshes every allocated chunk of a representative generated city within a sane time/triangle budget', () => {
    const world = new World();
    generateCity(world, 'perf-harness-01');

    const chunks = world.allocatedChunkEntries();
    expect(chunks.length).toBeGreaterThan(0);

    let totalTriangles = 0;
    const start = performance.now();
    for (const { cx, cy, cz } of chunks) {
      const chunk = { cx, cy, cz };
      const snapshot = buildChunkSnapshot(world, chunk);
      const meshData = buildChunkMeshDataFromSnapshot(snapshot, chunk);
      totalTriangles += triangleCount(meshData);
    }
    const elapsedMs = performance.now() - start;

    const chunkCount = chunks.length;
    const avgMsPerChunk = elapsedMs / chunkCount;
    const avgTrianglesPerChunk = totalTriangles / chunkCount;

    // eslint-disable-next-line no-console
    console.log(
      `[MesherPerf] chunks=${chunkCount} totalTriangles=${totalTriangles} totalMs=${elapsedMs.toFixed(1)} ` +
        `avgMs/chunk=${avgMsPerChunk.toFixed(3)} avgTriangles/chunk=${avgTrianglesPerChunk.toFixed(0)}`,
    );

    // Generous ceilings, not tuned targets: this whole city's worth of
    // meshing (hundreds of chunks) happening off the main thread (see
    // MesherScheduler's worker pool) in well under a second on ordinary dev
    // hardware is the actual PERF.md finding; these bounds are ~10x that,
    // wide enough to absorb slow CI runners without masking a genuine
    // regression (e.g. an accidental O(n^2) or a meshing bug that stops
    // culling faces).
    expect(elapsedMs).toBeLessThan(10_000);
    expect(avgTrianglesPerChunk).toBeLessThan(200_000);
  });
});
