import { describe, expect, it, vi } from 'vitest';
import {
  FORMAT_VERSION,
  SerializerError,
  applyDecodedWorld,
  decodeWorld,
  importWorld,
  serializeWorld,
  type DecodedWorld,
} from '../src/io/Serializer';
import { AIR, ASPHALT, CONCRETE, NEON_PINK } from '../src/world/BlockRegistry';
import { CHUNK_SIZE, CHUNK_VOXEL_COUNT } from '../src/world/coords';
import { World } from '../src/world/World';

const BOUNDS = { x: 384, y: 160, z: 384 };

function serializeOptions(overrides: Partial<{ seed: string; timeOfDay: number }> = {}) {
  return {
    seed: overrides.seed ?? 'test-seed',
    timeOfDay: overrides.timeOfDay ?? 0.42,
    bounds: BOUNDS,
    chunkSize: CHUNK_SIZE,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

/** Compares every voxel across two adjacent chunks (x: 0-63, y/z: 0-31) between two worlds. */
function expectSameBlocksInRegion(a: World, b: World): void {
  for (let x = 0; x < CHUNK_SIZE * 2; x++) {
    for (let y = 0; y < CHUNK_SIZE; y++) {
      for (let z = 0; z < CHUNK_SIZE; z++) {
        const blockA = a.getBlock(x, y, z);
        const blockB = b.getBlock(x, y, z);
        if (blockA !== blockB) {
          expect.fail(`block mismatch at (${x},${y},${z}): expected ${blockA}, got ${blockB}`);
        }
      }
    }
  }
}

describe('serializeWorld / importWorld round-trip', () => {
  it('reproduces an identical world, including chunk-spanning edits', () => {
    const world = new World();
    world.setBlock(5, 1, 5, CONCRETE);
    world.setBlock(31, 0, 0, ASPHALT); // last local x of chunk (0,0,0)
    world.setBlock(32, 0, 0, NEON_PINK); // first local x of chunk (1,0,0)
    world.setBlock(40, 10, 20, ASPHALT);
    // Simulate an edit: place then remove, should end up AIR either way.
    world.setBlock(10, 10, 10, CONCRETE);
    world.setBlock(10, 10, 10, AIR);

    const buffer = serializeWorld(world, serializeOptions());

    const imported = new World();
    importWorld(imported, buffer);

    expectSameBlocksInRegion(world, imported);
  });

  it('importing into a non-empty world wipes stale content in chunks the import never touches', () => {
    const worldA = new World();
    worldA.setBlock(100, 100, 100, NEON_PINK); // lives in chunk (3,3,3), far from anything B writes

    const worldB = new World();
    worldB.setBlock(5, 1, 5, ASPHALT); // only touches chunk (0,0,0)
    const buffer = serializeWorld(worldB, serializeOptions());

    importWorld(worldA, buffer);

    expect(worldA.getBlock(100, 100, 100)).toBe(AIR);
    expect(worldA.getBlock(5, 1, 5)).toBe(ASPHALT);
  });

  it('preserves seed and timeOfDay', () => {
    const world = new World();
    world.setBlock(1, 1, 1, CONCRETE);

    const buffer = serializeWorld(world, serializeOptions({ seed: 'night-city-42', timeOfDay: 0.73 }));
    const decoded = decodeWorld(buffer);

    expect(decoded.meta.seed).toBe('night-city-42');
    expect(decoded.meta.timeOfDay).toBe(0.73);
    expect(decoded.meta.app).toBe('voxelcity');
  });
});

describe('RLE correctness', () => {
  it('round-trips a worst-case alternating-block chunk', () => {
    const world = new World();
    for (let lx = 0; lx < CHUNK_SIZE; lx++) {
      for (let ly = 0; ly < CHUNK_SIZE; ly++) {
        for (let lz = 0; lz < CHUNK_SIZE; lz++) {
          const id = (lx + ly + lz) % 2 === 0 ? CONCRETE : ASPHALT;
          world.setBlockRaw(lx, ly, lz, id);
        }
      }
    }

    const buffer = serializeWorld(world, serializeOptions());
    const imported = new World();
    importWorld(imported, buffer);

    expectSameBlocksInRegion(world, imported);
  });

  it('skips all-air chunks entirely (allocated-but-cleared chunk is not written)', () => {
    const world = new World();
    world.setBlockRaw(1, 1, 1, CONCRETE);
    world.setBlockRaw(1, 1, 1, AIR); // chunk (0,0,0) stays allocated, now all-air

    const buffer = serializeWorld(world, serializeOptions());
    const decoded = decodeWorld(buffer);

    expect(decoded.chunks).toHaveLength(0);
  });

  it('encodes a uniform full chunk down to a single run (tiny payload)', () => {
    const world = new World();
    for (let i = 0; i < CHUNK_VOXEL_COUNT; i++) {
      const lx = i % CHUNK_SIZE;
      const ly = Math.floor(i / (CHUNK_SIZE * CHUNK_SIZE));
      const lz = Math.floor(i / CHUNK_SIZE) % CHUNK_SIZE;
      world.setBlockRaw(lx, ly, lz, CONCRETE);
    }

    const buffer = serializeWorld(world, serializeOptions());

    // header + metaJSON (palette dump, ~a few hundred bytes) + one chunk
    // header (2+2+2+4) + a single 3-byte run — nowhere near the raw
    // 32768-byte chunk this would otherwise take.
    expect(buffer.byteLength).toBeLessThan(1000);

    const decoded = decodeWorld(buffer);
    expect(decoded.chunks).toHaveLength(1);
    expect(decoded.chunks[0]?.voxels.every((id) => id === CONCRETE)).toBe(true);
  });
});

describe('palette remap', () => {
  it('remaps ids by block name, so a reordered registry still resolves correctly', () => {
    const voxels = new Uint8Array(CHUNK_VOXEL_COUNT);
    voxels[0] = 1; // "swapped": file says id 1 is ASPHALT, not CONCRETE

    const decoded: DecodedWorld = {
      meta: {
        app: 'voxelcity',
        formatVersion: FORMAT_VERSION,
        seed: 'remap-test',
        createdAt: '2026-01-01T00:00:00.000Z',
        bounds: BOUNDS,
        chunkSize: CHUNK_SIZE,
        palette: { 1: 'ASPHALT', 2: 'CONCRETE' }, // swapped vs. current registry (1=CONCRETE, 2=ASPHALT)
        timeOfDay: 0.5,
        entities: [],
      },
      chunks: [{ cx: 0, cy: 0, cz: 0, voxels }],
    };

    const world = new World();
    applyDecodedWorld(world, decoded);

    expect(world.getBlock(0, 0, 0)).toBe(ASPHALT);
  });

  it('falls back to AIR and warns for a block name no longer in the registry', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const voxels = new Uint8Array(CHUNK_VOXEL_COUNT);
    voxels[0] = 200;

    const decoded: DecodedWorld = {
      meta: {
        app: 'voxelcity',
        formatVersion: FORMAT_VERSION,
        seed: 'unknown-block-test',
        createdAt: '2026-01-01T00:00:00.000Z',
        bounds: BOUNDS,
        chunkSize: CHUNK_SIZE,
        palette: { 200: 'RETIRED_BLOCK_TYPE' },
        timeOfDay: 0.5,
        entities: [],
      },
      chunks: [{ cx: 0, cy: 0, cz: 0, voxels }],
    };

    const world = new World();
    applyDecodedWorld(world, decoded);

    expect(world.getBlock(0, 0, 0)).toBe(AIR);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('RETIRED_BLOCK_TYPE'));

    warnSpy.mockRestore();
  });
});

describe('corrupt input rejection', () => {
  it('rejects a bad magic header', () => {
    const buffer = new ArrayBuffer(16);
    new Uint8Array(buffer).set([0x58, 0x58, 0x58, 0x58]); // "XXXX"

    expect(() => decodeWorld(buffer)).toThrow(SerializerError);
  });

  it('rejects an unsupported format version', () => {
    const world = new World();
    const buffer = serializeWorld(world, serializeOptions());
    const view = new DataView(buffer);
    view.setUint16(4, FORMAT_VERSION + 1, true); // magic is bytes 0-3, version at byte 4

    expect(() => decodeWorld(buffer)).toThrow(SerializerError);
  });

  it('rejects a truncated buffer without crashing', () => {
    const world = new World();
    world.setBlock(1, 1, 1, CONCRETE);
    const buffer = serializeWorld(world, serializeOptions());

    const truncated = buffer.slice(0, 10);

    expect(() => decodeWorld(truncated)).toThrow(SerializerError);
  });

  it('rejects an empty buffer without crashing', () => {
    expect(() => decodeWorld(new ArrayBuffer(0))).toThrow(SerializerError);
  });
});
