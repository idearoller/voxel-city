import { describe, expect, it } from 'vitest';
import { DEFAULT_TIME_OF_DAY, MIN_FOG_DENSITY, dayFactor, interpolateAtmosphere } from '../src/engine/dayNight';

describe('dayFactor', () => {
  it('is 0 at midnight (t=0)', () => {
    expect(dayFactor(0)).toBeCloseTo(0, 5);
  });

  it('is 1 at noon (t=0.5)', () => {
    expect(dayFactor(0.5)).toBeCloseTo(1, 5);
  });

  it('is 0 again approaching t=1 (wraps back to midnight)', () => {
    expect(dayFactor(1)).toBeCloseTo(0, 5);
  });

  it('is symmetric around noon', () => {
    expect(dayFactor(0.25)).toBeCloseTo(dayFactor(0.75), 5);
  });

  it('is mostly-night at the default time of day (0.85)', () => {
    expect(dayFactor(DEFAULT_TIME_OF_DAY)).toBeLessThan(0.3);
  });
});

describe('interpolateAtmosphere', () => {
  it('matches the night preset values at midnight', () => {
    const params = interpolateAtmosphere(0);
    expect(params.skyHorizonColor).toBe(0x2a1440);
    expect(params.skyZenithColor).toBe(0x05030c);
    expect(params.hemiIntensity).toBeCloseTo(0.25, 5);
    expect(params.moonIntensity).toBeCloseTo(0.15, 5);
    expect(params.bloomStrength).toBeCloseTo(0.95, 5);
    expect(params.starOpacity).toBeCloseTo(1, 5);
  });

  it('matches the day preset values at noon', () => {
    const params = interpolateAtmosphere(0.5);
    expect(params.skyHorizonColor).toBe(0x5c6f78);
    expect(params.skyZenithColor).toBe(0x29343a);
    expect(params.hemiIntensity).toBeCloseTo(0.55, 5);
    expect(params.moonIntensity).toBeCloseTo(0.4, 5);
    expect(params.bloomStrength).toBeCloseTo(0.35, 5);
    expect(params.starOpacity).toBeCloseTo(0, 5);
  });

  it('is strictly between night and day values at dawn (t=0.25)', () => {
    const params = interpolateAtmosphere(0.25);
    expect(params.hemiIntensity).toBeGreaterThan(0.25);
    expect(params.hemiIntensity).toBeLessThan(0.55);
    expect(params.bloomStrength).toBeGreaterThan(0.35);
    expect(params.bloomStrength).toBeLessThan(0.95);
    expect(params.starOpacity).toBeGreaterThan(0);
    expect(params.starOpacity).toBeLessThan(1);
  });

  it('bloom is strong (mostly-night) at the default time of day', () => {
    const params = interpolateAtmosphere(DEFAULT_TIME_OF_DAY);
    expect(params.bloomStrength).toBeGreaterThan(0.7);
  });

  it('has no independent fogColor field -- fog is synced to the sky horizon color by design', () => {
    const params = interpolateAtmosphere(0.37);
    expect('fogColor' in params).toBe(false);
  });
});

describe('MIN_FOG_DENSITY', () => {
  it('is the day preset\'s density (0.009) -- thinner than night\'s (0.012)', () => {
    expect(MIN_FOG_DENSITY).toBeCloseTo(interpolateAtmosphere(0.5).fogDensity, 5);
    expect(MIN_FOG_DENSITY).toBeLessThan(interpolateAtmosphere(0).fogDensity);
  });
});
