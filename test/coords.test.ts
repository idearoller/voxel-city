import { describe, expect, it } from 'vitest';
import {
  CHUNK_SIZE,
  chunkKey,
  chunkLocalToWorld,
  floorDiv,
  floorMod,
  isInBounds,
  localIndex,
  parseChunkKey,
  worldToChunk,
  worldToLocal,
} from '../src/world/coords';

describe('floorDiv / floorMod', () => {
  it('matches Math.floor semantics for positive numbers', () => {
    expect(floorDiv(35, 32)).toBe(1);
    expect(floorMod(35, 32)).toBe(3);
  });

  it('handles negative numbers correctly (floor, not truncation)', () => {
    expect(floorDiv(-1, 32)).toBe(-1);
    expect(floorMod(-1, 32)).toBe(31);
    expect(floorDiv(-32, 32)).toBe(-1);
    expect(floorMod(-32, 32)).toBe(0);
    expect(floorDiv(-33, 32)).toBe(-2);
    expect(floorMod(-33, 32)).toBe(31);
  });
});

describe('worldToChunk / worldToLocal roundtrip', () => {
  const cases: Array<[number, number, number]> = [
    [0, 0, 0],
    [31, 31, 31],
    [32, 32, 32],
    [383, 159, 383],
    [100, 50, 200],
    [-1, -1, -1],
    [-33, 5, -65],
  ];

  it.each(cases)('roundtrips world coord (%i, %i, %i)', (x, y, z) => {
    const chunk = worldToChunk(x, y, z);
    const local = worldToLocal(x, y, z);
    expect(local.lx).toBeGreaterThanOrEqual(0);
    expect(local.lx).toBeLessThan(CHUNK_SIZE);
    expect(local.ly).toBeGreaterThanOrEqual(0);
    expect(local.ly).toBeLessThan(CHUNK_SIZE);
    expect(local.lz).toBeGreaterThanOrEqual(0);
    expect(local.lz).toBeLessThan(CHUNK_SIZE);

    const rebuilt = chunkLocalToWorld(chunk, local);
    expect(rebuilt).toEqual({ x, y, z });
  });

  it('places chunk-boundary voxels in distinct chunks', () => {
    expect(worldToChunk(31, 0, 0)).toEqual({ cx: 0, cy: 0, cz: 0 });
    expect(worldToChunk(32, 0, 0)).toEqual({ cx: 1, cy: 0, cz: 0 });
  });
});

describe('localIndex', () => {
  it('is 0 at the local origin', () => {
    expect(localIndex(0, 0, 0)).toBe(0);
  });

  it('matches x + z*32 + y*1024', () => {
    expect(localIndex(1, 0, 0)).toBe(1);
    expect(localIndex(0, 0, 1)).toBe(32);
    expect(localIndex(0, 1, 0)).toBe(1024);
    expect(localIndex(5, 2, 3)).toBe(5 + 3 * 32 + 2 * 1024);
  });

  it('produces unique indices across the full chunk volume bounds', () => {
    expect(localIndex(31, 31, 31)).toBe(32768 - 1);
  });
});

describe('chunkKey', () => {
  it('formats as "cx,cy,cz"', () => {
    expect(chunkKey(1, -2, 3)).toBe('1,-2,3');
  });

  it('parseChunkKey inverts chunkKey', () => {
    expect(parseChunkKey(chunkKey(1, -2, 3))).toEqual({ cx: 1, cy: -2, cz: 3 });
  });
});

describe('isInBounds', () => {
  it('accepts coordinates within the finite world', () => {
    expect(isInBounds(0, 0, 0)).toBe(true);
    expect(isInBounds(383, 159, 383)).toBe(true);
  });

  it('rejects coordinates outside the finite world', () => {
    expect(isInBounds(-1, 0, 0)).toBe(false);
    expect(isInBounds(384, 0, 0)).toBe(false);
    expect(isInBounds(0, 160, 0)).toBe(false);
    expect(isInBounds(0, 0, 384)).toBe(false);
  });
});
