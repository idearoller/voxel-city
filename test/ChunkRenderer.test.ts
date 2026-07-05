import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { ChunkRenderer } from '../src/engine/ChunkRenderer';
import { CULL_RADIUS } from '../src/engine/ChunkVisibility';
import { CONCRETE } from '../src/world/BlockRegistry';
import { CHUNK_SIZE, WORLD_SIZE_X } from '../src/world/coords';
import { World } from '../src/world/World';

/** Origin is a reasonable stand-in "camera is right here" position for tests that don't care about culling. */
const ORIGIN = new THREE.Vector3(0, 0, 0);

/**
 * A chunk index on the x-axis that's comfortably beyond CULL_RADIUS from the
 * origin, but still inside the finite world bounds -- clamped so this stays
 * true even if CULL_RADIUS or WORLD_SIZE_X change later.
 */
const FAR_CHUNK_CX = Math.min(
  Math.ceil(CULL_RADIUS / CHUNK_SIZE) + 5,
  Math.floor((WORLD_SIZE_X - 1) / CHUNK_SIZE),
);
const FAR_CHUNK_X = FAR_CHUNK_CX * CHUNK_SIZE;

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

    renderer.update(ORIGIN);

    expect(renderer.pendingCount).toBe(6);
  });

  it('leaves no pending work for a subsequent update() to redundantly process', async () => {
    const renderer = rendererWithManyDirtyChunks(5);

    await renderer.flushPending();
    renderer.update(ORIGIN);

    expect(renderer.pendingCount).toBe(0);
  });
});

describe('ChunkRenderer distance culling', () => {
  /** Every solid/road/windowLit/neon mesh currently tracked for `key`, flattened. */
  function meshesForKey(renderer: ChunkRenderer, key: string): THREE.Mesh[] {
    // Accesses the private map directly -- this is a whitebox test of the
    // culling wiring, not of ChunkVisibility's math (covered separately).
    const chunk = (renderer as unknown as { meshes: Map<string, { solid: THREE.Mesh | null; road: THREE.Mesh | null; windowLit: THREE.Mesh | null; neon: (THREE.Mesh | null)[] }> }).meshes.get(key);
    if (!chunk) return [];
    return [chunk.solid, chunk.road, chunk.windowLit, ...chunk.neon].filter(
      (m): m is THREE.Mesh => m !== null,
    );
  }

  it('hides a chunk whose nearest point is well beyond CULL_RADIUS from the camera', async () => {
    const world = new World();
    const renderer = new ChunkRenderer(world, new THREE.Scene());
    world.setBlock(FAR_CHUNK_X, 1, 1, CONCRETE);
    await renderer.flushPending();

    renderer.update(ORIGIN);

    const meshes = meshesForKey(renderer, `${FAR_CHUNK_CX},0,0`);
    expect(meshes.length).toBeGreaterThan(0);
    expect(meshes.every((m) => m.visible === false)).toBe(true);
  });

  it('keeps a chunk visible when the camera is right next to it', async () => {
    const world = new World();
    const renderer = new ChunkRenderer(world, new THREE.Scene());
    world.setBlock(0, 1, 1, CONCRETE);
    await renderer.flushPending();

    renderer.update(ORIGIN);

    const meshes = meshesForKey(renderer, '0,0,0');
    expect(meshes.length).toBeGreaterThan(0);
    expect(meshes.every((m) => m.visible === true)).toBe(true);
  });

  it('re-evaluates visibility as the camera moves', async () => {
    const world = new World();
    const renderer = new ChunkRenderer(world, new THREE.Scene());
    world.setBlock(FAR_CHUNK_X, 1, 1, CONCRETE);
    await renderer.flushPending();

    renderer.update(ORIGIN);
    expect(meshesForKey(renderer, `${FAR_CHUNK_CX},0,0`).every((m) => m.visible)).toBe(false);

    renderer.update(new THREE.Vector3(FAR_CHUNK_X, 0, 0));
    expect(meshesForKey(renderer, `${FAR_CHUNK_CX},0,0`).every((m) => m.visible)).toBe(true);
  });

  it('newly meshed chunks get correct initial visibility, not a frame of default-visible', async () => {
    const world = new World();
    const renderer = new ChunkRenderer(world, new THREE.Scene());
    world.setBlock(FAR_CHUNK_X, 1, 1, CONCRETE);

    // flushPending's own loop calls the scheduler directly, not update(); a
    // single update(cameraAtOrigin) right after must still apply correct
    // culling to the chunk it just meshed.
    await renderer.flushPending();
    renderer.update(ORIGIN);

    const meshes = meshesForKey(renderer, `${FAR_CHUNK_CX},0,0`);
    expect(meshes.every((m) => m.visible === false)).toBe(true);
  });

  it('setAllChunksVisible() forces a distant chunk visible (for EnvironmentProbe captures)', async () => {
    const world = new World();
    const renderer = new ChunkRenderer(world, new THREE.Scene());
    world.setBlock(FAR_CHUNK_X, 1, 1, CONCRETE);
    await renderer.flushPending();
    renderer.update(ORIGIN);
    expect(meshesForKey(renderer, `${FAR_CHUNK_CX},0,0`).every((m) => m.visible)).toBe(false);

    renderer.setAllChunksVisible();

    expect(meshesForKey(renderer, `${FAR_CHUNK_CX},0,0`).every((m) => m.visible)).toBe(true);
  });

  it('setCullRadius() shrinks the effective radius so a chunk within the default CULL_RADIUS, but beyond the shrunk one, is culled', async () => {
    const world = new World();
    const renderer = new ChunkRenderer(world, new THREE.Scene());
    // A chunk just inside the default CULL_RADIUS -- visible before any override.
    const nearCx = Math.floor((CULL_RADIUS - 10) / CHUNK_SIZE);
    const nearX = nearCx * CHUNK_SIZE;
    world.setBlock(nearX, 1, 1, CONCRETE);
    await renderer.flushPending();

    renderer.update(ORIGIN);
    expect(meshesForKey(renderer, `${nearCx},0,0`).every((m) => m.visible)).toBe(true);

    // Quality tiers scale CULL_RADIUS down (see QualityParams.ts); a scale
    // small enough to fall below this chunk's distance should cull it.
    renderer.setCullRadius(CULL_RADIUS * 0.1);
    renderer.update(ORIGIN);

    expect(meshesForKey(renderer, `${nearCx},0,0`).every((m) => m.visible)).toBe(false);
  });

  it('setCullRadius() takes effect immediately on the next update(), no reload needed', async () => {
    const world = new World();
    const renderer = new ChunkRenderer(world, new THREE.Scene());
    world.setBlock(FAR_CHUNK_X, 1, 1, CONCRETE);
    await renderer.flushPending();
    renderer.update(ORIGIN);
    expect(meshesForKey(renderer, `${FAR_CHUNK_CX},0,0`).every((m) => m.visible)).toBe(false);

    // Widening the radius past the far chunk's distance should reveal it on
    // the very next update() -- no re-flush, no reconstruction.
    renderer.setCullRadius(FAR_CHUNK_X + CHUNK_SIZE);
    renderer.update(ORIGIN);

    expect(meshesForKey(renderer, `${FAR_CHUNK_CX},0,0`).every((m) => m.visible)).toBe(true);
  });
});
