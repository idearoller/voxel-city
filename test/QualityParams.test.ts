import { describe, expect, it } from 'vitest';
import { qualityParams } from '../src/engine/QualityParams';

describe('qualityParams', () => {
  it('high matches the pre-existing shipped defaults (DPR clamp 1.5, full cull radius, bloom on)', () => {
    expect(qualityParams('high')).toEqual({ dpr: 1.5, cullRadiusScale: 1.0, bloomEnabled: true });
  });

  it('medium trims DPR and cull radius but keeps bloom on', () => {
    const params = qualityParams('medium');
    expect(params.dpr).toBe(1.25);
    expect(params.cullRadiusScale).toBe(0.8);
    expect(params.bloomEnabled).toBe(true);
  });

  it('low turns bloom off entirely and uses the cheapest DPR/cull radius', () => {
    const params = qualityParams('low');
    expect(params.dpr).toBe(1.0);
    expect(params.cullRadiusScale).toBe(0.7);
    expect(params.bloomEnabled).toBe(false);
  });

  it("each tier's dpr sits at or below the pre-existing 1.5 hardcoded ceiling (clamping against the actual devicePixelRatio happens separately, in main.ts's applyQuality -- see QualityParams.ts's flat values not being device-aware)", () => {
    for (const tier of ['low', 'medium', 'high'] as const) {
      expect(qualityParams(tier).dpr).toBeGreaterThan(0);
      expect(qualityParams(tier).dpr).toBeLessThanOrEqual(1.5);
    }
  });

  it('cull radius scale strictly decreases from high to low, matching the fog-occlusion tradeoff documented in QualityParams.ts', () => {
    expect(qualityParams('low').cullRadiusScale).toBeLessThan(qualityParams('medium').cullRadiusScale);
    expect(qualityParams('medium').cullRadiusScale).toBeLessThan(qualityParams('high').cullRadiusScale);
  });

  it('is a pure lookup: repeated calls for the same tier return equal values', () => {
    expect(qualityParams('medium')).toEqual(qualityParams('medium'));
  });
});
