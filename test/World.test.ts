import { describe, expect, it } from 'vitest';
import { AIR, CONCRETE } from '../src/world/BlockRegistry';
import { chunkKey } from '../src/world/coords';
import { World } from '../src/world/World';

describe('World.getBlock', () => {
  it('returns AIR for unallocated chunks', () => {
    const world = new World();
    expect(world.getBlock(5, 5, 5)).toBe(AIR);
  });

  it('returns AIR for out-of-bounds coordinates', () => {
    const world = new World();
    expect(world.getBlock(-1, 0, 0)).toBe(AIR);
    expect(world.getBlock(0, 0, 384)).toBe(AIR);
    expect(world.getBlock(0, 160, 0)).toBe(AIR);
  });
});

describe('World.setBlock / getBlock', () => {
  it('allocates a chunk and is readable back', () => {
    const world = new World();
    world.setBlock(10, 1, 10, CONCRETE);
    expect(world.getBlock(10, 1, 10)).toBe(CONCRETE);
  });

  it('is a no-op outside world bounds', () => {
    const world = new World();
    world.setBlock(-5, 0, 0, CONCRETE);
    expect(world.getBlock(-5, 0, 0)).toBe(AIR);
  });
});

describe('World.isSolid', () => {
  it('reflects the block registry solidity of the placed block', () => {
    const world = new World();
    expect(world.isSolid(1, 1, 1)).toBe(false);
    world.setBlock(1, 1, 1, CONCRETE);
    expect(world.isSolid(1, 1, 1)).toBe(true);
  });
});

describe('World dirty notification', () => {
  it('notifies listeners with the owning chunk key on setBlock', () => {
    const world = new World();
    const seen: string[] = [];
    world.onChunkDirty((key) => seen.push(key));

    world.setBlock(1, 1, 1, CONCRETE);

    expect(seen).toContain(chunkKey(0, 0, 0));
  });

  it('marks the allocated neighbor chunk dirty when writing on a chunk border', () => {
    const world = new World();
    // Pre-allocate the neighbor chunk (cx=1) by writing into it once.
    world.setBlock(32, 0, 0, CONCRETE);

    const seen: string[] = [];
    world.onChunkDirty((key) => seen.push(key));

    // lx = 31 is the last local x in chunk (0,0,0) -> borders chunk (1,0,0).
    world.setBlock(31, 0, 0, CONCRETE);

    expect(seen).toContain(chunkKey(0, 0, 0));
    expect(seen).toContain(chunkKey(1, 0, 0));
  });

  it('does not mark an unallocated neighbor dirty', () => {
    const world = new World();
    const seen: string[] = [];
    world.onChunkDirty((key) => seen.push(key));

    world.setBlock(31, 0, 0, CONCRETE);

    expect(seen).toContain(chunkKey(0, 0, 0));
    expect(seen).not.toContain(chunkKey(1, 0, 0));
  });

  it('setBlockRaw does not trigger dirty notification', () => {
    const world = new World();
    const seen: string[] = [];
    world.onChunkDirty((key) => seen.push(key));

    world.setBlockRaw(1, 1, 1, CONCRETE);

    expect(seen).toHaveLength(0);
    expect(world.getBlock(1, 1, 1)).toBe(CONCRETE);
  });

  it('remeshAll marks every allocated chunk dirty', () => {
    const world = new World();
    world.setBlockRaw(1, 1, 1, CONCRETE);
    world.setBlockRaw(40, 1, 1, CONCRETE);

    const seen: string[] = [];
    world.onChunkDirty((key) => seen.push(key));

    world.remeshAll();

    expect(seen).toContain(chunkKey(0, 0, 0));
    expect(seen).toContain(chunkKey(1, 0, 0));
  });
});
