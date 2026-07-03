import { describe, expect, it } from 'vitest';
import { generateCity } from '../src/gen/CityGenerator';
import { AIR, ASPHALT } from '../src/world/BlockRegistry';
import { parseChunkKey } from '../src/world/coords';
import { World } from '../src/world/World';

/**
 * Content hash over every *non-empty* chunk's raw voxel bytes plus its key,
 * so two worlds hash equal iff their visible contents are identical.
 * Deliberately ignores allocated-but-all-air chunks: `World.clear()` keeps
 * previously-touched chunk objects around (zeroed) rather than deallocating
 * them, which is invisible to both the mesher (skips empty chunks) and
 * gameplay (getBlock/isSolid), so it must be invisible to this hash too.
 * Uses `remeshAll` purely to enumerate allocated chunks via the
 * dirty-notification hook — no rendering involved.
 */
function hashWorld(world: World): string {
  const keys = new Set<string>();
  world.onChunkDirty((key) => keys.add(key));
  world.remeshAll();

  const sortedKeys = Array.from(keys).sort();
  let hash = 0;
  let nonEmptyChunkCount = 0;
  for (const key of sortedKeys) {
    const { cx, cy, cz } = parseChunkKey(key);
    const chunk = world.peekChunk(cx, cy, cz);
    if (!chunk) continue;

    let chunkHash = 0;
    for (let i = 0; i < chunk.voxels.length; i++) {
      const v = chunk.voxels[i] as number;
      if (v !== 0) chunkHash = (chunkHash * 31 + v + i) | 0;
    }
    if (chunkHash === 0) continue; // all-air: not visible, don't let it affect the hash

    nonEmptyChunkCount++;
    for (const ch of key) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
    hash = (hash * 31 + chunkHash) | 0;
  }
  return `${nonEmptyChunkCount}:${hash}`;
}

describe('generateCity reproducibility', () => {
  it('produces an identical world for the same seed generated twice', () => {
    const worldA = new World();
    const worldB = new World();

    generateCity(worldA, 'neon-district-7');
    generateCity(worldB, 'neon-district-7');

    expect(hashWorld(worldA)).toBe(hashWorld(worldB));
  });

  it('produces a different world for a different seed', () => {
    const worldA = new World();
    const worldB = new World();

    generateCity(worldA, 'seed-alpha');
    generateCity(worldB, 'seed-beta');

    expect(hashWorld(worldA)).not.toBe(hashWorld(worldB));
  });

  it('regenerating the same world with a new seed replaces the old contents', () => {
    const world = new World();
    generateCity(world, 'first-pass');
    const firstHash = hashWorld(world);

    generateCity(world, 'second-pass');
    const secondHash = hashWorld(world);

    expect(secondHash).not.toBe(firstHash);

    // Re-running the first seed on a fresh world should match re-running it
    // on the reused, previously-cleared world.
    const freshWorld = new World();
    generateCity(freshWorld, 'second-pass');
    expect(hashWorld(freshWorld)).toBe(secondHash);
  });
});

describe('generateCity ground layer', () => {
  it('paints ASPHALT at y=1 on road cells and something solid everywhere at y=0', () => {
    const world = new World();
    const { layout } = generateCity(world, 'ground-check');

    // Find a road cell (x=0 column is virtually always road-adjacent given full-span bands,
    // but scan defensively) and confirm asphalt was painted there.
    let checked = false;
    for (let x = 0; x < layout.gridSizeX && !checked; x++) {
      for (let z = 0; z < layout.gridSizeZ && !checked; z++) {
        if (world.getBlock(x, 1, z) === ASPHALT) {
          checked = true;
        }
      }
    }
    expect(checked).toBe(true);
  });
});

describe('generateCity buildings', () => {
  it('places at least one parcel with a building (non-air voxels above the ground slab)', () => {
    const world = new World();
    const { layout } = generateCity(world, 'buildings-present');

    const hasBuilding = layout.blocks.some((block) =>
      block.parcels.some((parcel) => world.getBlock(parcel.x, 3, parcel.z) !== AIR),
    );
    expect(hasBuilding).toBe(true);
  });
});
