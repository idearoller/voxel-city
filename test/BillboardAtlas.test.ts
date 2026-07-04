import { describe, expect, it } from 'vitest';
import { ATLAS_DESIGN_COUNT, planAtlasLayout, type AtlasDesignKind } from '../src/engine/BillboardAtlas';

describe('planAtlasLayout', () => {
  it('is deterministic: the same seed always produces the same structure', () => {
    const a = planAtlasLayout('night-city-01');
    const b = planAtlasLayout('night-city-01');
    expect(a).toEqual(b);
  });

  it('produces a different layout for a different seed', () => {
    const a = planAtlasLayout('night-city-01');
    const b = planAtlasLayout('some-other-seed');
    expect(a).not.toEqual(b);
  });

  it('plans exactly ATLAS_DESIGN_COUNT designs', () => {
    const designs = planAtlasLayout('seed-a');
    expect(designs).toHaveLength(ATLAS_DESIGN_COUNT);
  });

  it('cycles through every design kind at least once regardless of seed', () => {
    for (const seed of ['seed-a', 'seed-b', 'seed-c']) {
      const designs = planAtlasLayout(seed);
      const kinds = new Set(designs.map((d) => d.kind));
      const expectedKinds: AtlasDesignKind[] = ['glyphStrip', 'geometricPattern', 'brandMark'];
      for (const kind of expectedKinds) expect(kinds.has(kind)).toBe(true);
    }
  });

  it('only populates the fields relevant to each design\'s own kind', () => {
    const designs = planAtlasLayout('seed-a');
    for (const design of designs) {
      if (design.kind === 'glyphStrip') {
        expect(design.glyphRows.length).toBeGreaterThan(0);
        expect(design.patternBands).toHaveLength(0);
        expect(design.brandRings).toBe(0);
      } else if (design.kind === 'geometricPattern') {
        expect(design.patternBands.length).toBeGreaterThan(0);
        expect(design.glyphRows).toHaveLength(0);
        expect(design.brandRings).toBe(0);
      } else {
        expect(design.brandRings).toBeGreaterThan(0);
        expect(design.glyphRows).toHaveLength(0);
        expect(design.patternBands).toHaveLength(0);
      }
    }
  });

  it('keeps every glyph block and pattern band within the [0, 1] fractional tile space', () => {
    const designs = planAtlasLayout('seed-a');
    for (const design of designs) {
      for (const row of design.glyphRows) {
        for (const glyph of row) {
          expect(glyph.x).toBeGreaterThanOrEqual(0);
          expect(glyph.x + glyph.width).toBeLessThanOrEqual(1.001);
        }
      }
      for (const band of design.patternBands) {
        expect(band.y).toBeGreaterThanOrEqual(0);
        expect(band.y + band.height).toBeLessThanOrEqual(1.001);
      }
    }
  });
});
