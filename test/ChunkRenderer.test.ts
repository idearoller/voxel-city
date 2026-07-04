import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { ChunkRenderer } from '../src/engine/ChunkRenderer';
import { CONCRETE } from '../src/world/BlockRegistry';
import { World } from '../src/world/World';

/**
 * Builds a World + ChunkRenderer pair (renderer wired up first, so its
 * dirty-notification listener is attached before any writes) and marks
 * `count` distinct chunks dirty — enough that the per-frame apply budget
 * (4, see MesherScheduler's APPLY_BUDGET_PER_FRAME) can't drain them in a
 * single update(). No global `Worker` exists in this test environment, so
 * ChunkRenderer falls back to the synchronous scheduler automatically.
 */
function rendererWithManyDirtyChunks(count: number): ChunkRenderer {
  const world = new World();
  const renderer = new ChunkRenderer(world, new THREE.Scene());
  for (let i = 0; i < count; i++) {
    // Each chunk is 32 voxels wide; stride by 32 on x to land one solid voxel in a distinct chunk.
    world.setBlock(i * 32, 1, 1, CONCRETE);
  }
  return renderer;
}

describe('ChunkRenderer.flushPending', () => {
  it('drains the entire dirty queue, unlike the budgeted update()', async () => {
    const renderer = rendererWithManyDirtyChunks(10);

    expect(renderer.pendingCount).toBe(10);

    await renderer.flushPending();

    expect(renderer.pendingCount).toBe(0);
  });

  it('contrasts with update(), which only processes one frame\'s apply budget (4) per call', () => {
    const renderer = rendererWithManyDirtyChunks(10);

    renderer.update();

    expect(renderer.pendingCount).toBe(6);
  });

  it('leaves no pending work for a subsequent update() to redundantly process', async () => {
    const renderer = rendererWithManyDirtyChunks(5);

    await renderer.flushPending();
    renderer.update();

    expect(renderer.pendingCount).toBe(0);
  });
});
