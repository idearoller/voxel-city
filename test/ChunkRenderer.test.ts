import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { ChunkRenderer } from '../src/engine/ChunkRenderer';
import { CONCRETE } from '../src/world/BlockRegistry';
import { World } from '../src/world/World';

/**
 * Builds a World + ChunkRenderer pair (renderer wired up first, so its
 * dirty-notification listener is attached before any writes) and marks
 * `count` distinct chunks dirty — enough that the per-frame rebuild budget
 * (4) can't drain them in a single update().
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

describe('ChunkRenderer.rebuildAllDirty', () => {
  it('drains the entire dirty queue in one call, unlike the budgeted update()', () => {
    const renderer = rendererWithManyDirtyChunks(10);

    expect(renderer.pendingCount).toBe(10);

    renderer.rebuildAllDirty();

    expect(renderer.pendingCount).toBe(0);
  });

  it('contrasts with update(), which only processes REBUILD_BUDGET_PER_FRAME (4) per call', () => {
    const renderer = rendererWithManyDirtyChunks(10);

    renderer.update();

    expect(renderer.pendingCount).toBe(6);
  });

  it('leaves no pending work for a subsequent update() to redundantly process', () => {
    const renderer = rendererWithManyDirtyChunks(5);

    renderer.rebuildAllDirty();
    renderer.update();

    expect(renderer.pendingCount).toBe(0);
  });
});
