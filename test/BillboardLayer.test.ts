import { describe, expect, it } from 'vitest';
import { planBillboardInstances } from '../src/engine/BillboardLayer';
import { ATLAS_DESIGN_COUNT } from '../src/engine/BillboardAtlas';
import type { BillboardFace } from '../src/engine/BillboardScanner';
import { NEON_CYAN, NEON_PINK } from '../src/world/BlockRegistry';

function face(x: number, y: number, z: number, blockId = NEON_PINK): BillboardFace {
  return { position: [x, y, z], normal: [0, 0, -1], axis: 'x', blockId };
}

describe('planBillboardInstances', () => {
  it('is deterministic: the same faces + seed always produce the same params', () => {
    const faces = [face(1, 2, 3), face(10, 2, 3), face(1, 8, 20)];
    const a = planBillboardInstances(faces, 'night-city-01');
    const b = planBillboardInstances(faces, 'night-city-01');
    expect(a).toEqual(b);
  });

  it('keys off each face\'s own position, not array order', () => {
    const f1 = face(1, 2, 3);
    const f2 = face(10, 2, 3);
    const forward = planBillboardInstances([f1, f2], 'seed-a');
    const reversed = planBillboardInstances([f2, f1], 'seed-a');

    expect(forward[0]).toEqual(reversed[1]);
    expect(forward[1]).toEqual(reversed[0]);
  });

  it('produces different animation params for a different seed', () => {
    const faces = [face(1, 2, 3)];
    const a = planBillboardInstances(faces, 'seed-a');
    const b = planBillboardInstances(faces, 'seed-b');
    expect(a).not.toEqual(b);
  });

  it('varies params across faces at different positions (not all identical)', () => {
    const faces = Array.from({ length: 10 }, (_, i) => face(i * 5, 2, 3));
    const params = planBillboardInstances(faces, 'seed-a');
    const variantIndices = new Set(params.map((p) => p.variantIndex));
    expect(variantIndices.size).toBeGreaterThan(1);
  });

  it('keeps every variant index within the atlas\'s actual design count', () => {
    const faces = Array.from({ length: 50 }, (_, i) => face(i, 2, i * 3, i % 2 === 0 ? NEON_PINK : NEON_CYAN));
    const params = planBillboardInstances(faces, 'seed-a');
    for (const p of params) {
      expect(p.variantIndex).toBeGreaterThanOrEqual(0);
      expect(p.variantIndex).toBeLessThan(ATLAS_DESIGN_COUNT);
      expect([0, 1]).toContain(p.scrollAxis);
      expect(p.phase).toBeGreaterThanOrEqual(0);
      expect(p.phase).toBeLessThan(1);
    }
  });
});
