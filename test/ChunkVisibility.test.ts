import { describe, expect, it } from 'vitest';
import { CULL_RADIUS, isChunkVisible } from '../src/engine/ChunkVisibility';
import { MIN_FOG_DENSITY } from '../src/engine/dayNight';
import { CHUNK_SIZE } from '../src/world/coords';

describe('CULL_RADIUS', () => {
  it('is derived from MIN_FOG_DENSITY (the thinner/day fog), not hardcoded', () => {
    expect(CULL_RADIUS).toBeCloseTo(Math.sqrt(3) / MIN_FOG_DENSITY, 5);
  });

  it('uses the lower (day) fog density, which gives a larger, safer radius than night\'s would', () => {
    const nightDensity = 0.012;
    const radiusFromNight = Math.sqrt(3) / nightDensity;
    expect(CULL_RADIUS).toBeGreaterThan(radiusFromNight);
  });
});

describe('isChunkVisible', () => {
  const originChunk = { cx: 0, cy: 0, cz: 0 };

  it('is visible when the camera sits inside the chunk', () => {
    expect(isChunkVisible(originChunk, 5, 5, 5)).toBe(true);
  });

  it('is visible when the nearest point is exactly at the radius (boundary inclusive)', () => {
    const radius = 100;
    // Chunk spans x in [0, 32); nearest point to a camera further out on
    // +x is (32, 0, 0). Placing the camera exactly `radius` away from that.
    expect(isChunkVisible(originChunk, 32 + radius, 0, 0, radius)).toBe(true);
  });

  it('is culled just beyond the radius', () => {
    const radius = 100;
    expect(isChunkVisible(originChunk, 32 + radius + 0.01, 0, 0, radius)).toBe(false);
  });

  it('would incorrectly cull if center distance were used instead of nearest-corner distance', () => {
    // Regression guard for the "must use nearest point, not center" requirement:
    // camera 15 units from the near face (x=320) of a chunk spanning [320,352).
    // Nearest-point distance is 15 (visible under radius=20); center distance
    // would be 15 + 16 = 31 (invisible under radius=20).
    const farChunk = { cx: 10, cy: 0, cz: 0 };
    const radius = 20;
    const cameraX = 320 - 15;
    expect(isChunkVisible(farChunk, cameraX, 0, 0, radius)).toBe(true);
  });

  it('accounts for vertical distance (e.g. sandbox fly mode high above the city)', () => {
    // Camera directly above the chunk's footprint, but far above it vertically.
    const radius = 50;
    expect(isChunkVisible(originChunk, 16, 200, 16, radius)).toBe(false);
    expect(isChunkVisible(originChunk, 16, 40, 16, radius)).toBe(true);
  });

  it('combines horizontal and vertical distance via true 3D distance, not either axis alone', () => {
    // Individually each axis offset is within radius, but combined 3D distance is not.
    const radius = 30;
    // Nearest point is chunk corner (32, 32, 32); offsets of (25,25,25) each
    // axis alone is < 30, but sqrt(25^2*3) ~= 43.3 > 30.
    expect(isChunkVisible(originChunk, 32 + 25, 32 + 25, 32 + 25, radius)).toBe(false);
  });

  it('defaults to CULL_RADIUS when no radius is given', () => {
    const justInside = CULL_RADIUS - 1;
    const justOutside = CULL_RADIUS + 1;
    expect(isChunkVisible(originChunk, 32 + justInside, 0, 0)).toBe(true);
    expect(isChunkVisible(originChunk, 32 + justOutside, 0, 0)).toBe(false);
  });

  it('a chunk far away at the default radius (roughly ~192u) is culled', () => {
    // Sanity check against the ~150u ballpark from the audit: our derived
    // radius (~192u, see CULL_RADIUS tests) should still comfortably cull
    // a chunk clearly outside the city's useful fog-visible range.
    const distantChunk = { cx: Math.ceil(CULL_RADIUS / CHUNK_SIZE) + 5, cy: 0, cz: 0 };
    expect(isChunkVisible(distantChunk, 0, 0, 0)).toBe(false);
  });
});
