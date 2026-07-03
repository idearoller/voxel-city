import { describe, expect, it } from 'vitest';
import { District, type DistrictContext, valueNoise2D, zoneBlock } from '../src/gen/districts';
import { createRng } from '../src/gen/rng';

const GRID = 384;

function ctxFor(seed: string): DistrictContext {
  return { gridSizeX: GRID, gridSizeZ: GRID, noiseSeed: createRng(seed).hashSeed() };
}

describe('valueNoise2D', () => {
  it('is deterministic for the same seed and coordinates', () => {
    const seed = createRng('noise-determinism').hashSeed();
    expect(valueNoise2D(seed, 123.4, 56.7, 96)).toBe(valueNoise2D(seed, 123.4, 56.7, 96));
  });

  it('stays within [0, 1]', () => {
    const seed = createRng('noise-range').hashSeed();
    for (let x = 0; x < 400; x += 13) {
      for (let z = 0; z < 400; z += 17) {
        const v = valueNoise2D(seed, x, z, 96);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });

  it('is continuous: nearby samples are much closer than far-apart samples on average', () => {
    const seed = createRng('noise-continuity').hashSeed();
    let nearDeltaSum = 0;
    let farDeltaSum = 0;
    const samples = 50;
    for (let i = 0; i < samples; i++) {
      const x = i * 7;
      const z = i * 11;
      const base = valueNoise2D(seed, x, z, 96);
      nearDeltaSum += Math.abs(valueNoise2D(seed, x + 1, z, 96) - base);
      farDeltaSum += Math.abs(valueNoise2D(seed, x + 200, z + 200, 96) - base);
    }
    expect(nearDeltaSum / samples).toBeLessThan(farDeltaSum / samples);
  });
});

describe('zoneBlock distribution sanity', () => {
  it('never zones a block within the downtown core radius as industrial', () => {
    const ctx = ctxFor('core-vs-industrial');
    const centerX = ctx.gridSizeX / 2;
    const centerZ = ctx.gridSizeZ / 2;
    for (let i = 0; i < 40; i++) {
      const rng = createRng('core-vs-industrial').fork(`block-${i}`);
      const district = zoneBlock(centerX + i, centerZ - i, ctx, rng);
      expect(district).not.toBe(District.INDUSTRIAL);
    }
  });

  it('never zones a block near the plan edge as downtown', () => {
    const ctx = ctxFor('rim-vs-downtown');
    for (let i = 0; i < 40; i++) {
      const rng = createRng('rim-vs-downtown').fork(`block-${i}`);
      // Corner of the plan: maximally far from center on both axes.
      const district = zoneBlock(10 + i, 10, ctx, rng);
      expect(district).not.toBe(District.DOWNTOWN);
    }
  });

  it('produces a mix of districts across a full grid of blocks (not degenerate to one district)', () => {
    const ctx = ctxFor('mixed-distribution');
    const seen = new Set<District>();
    const rootRng = createRng('mixed-distribution');
    for (let bx = 0; bx < 12; bx++) {
      for (let bz = 0; bz < 12; bz++) {
        const centerX = (bx + 0.5) * 32;
        const centerZ = (bz + 0.5) * 32;
        const district = zoneBlock(centerX, centerZ, ctx, rootRng.fork(`${bx},${bz}`));
        seen.add(district);
      }
    }
    expect(seen.size).toBeGreaterThanOrEqual(3);
  });

  it('is deterministic for the same seed and block position', () => {
    const ctx = ctxFor('zone-determinism');
    const a = zoneBlock(150, 200, ctx, createRng('zone-determinism').fork('5,7'));
    const b = zoneBlock(150, 200, ctx, createRng('zone-determinism').fork('5,7'));
    expect(a).toBe(b);
  });
});
