import { describe, expect, it } from 'vitest';
import { neonChannelIntensity } from '../src/engine/neon';

describe('neonChannelIntensity', () => {
  it('channel 0 (steady) is always full intensity regardless of time', () => {
    expect(neonChannelIntensity(0, 0)).toBe(1);
    expect(neonChannelIntensity(0, 123.456)).toBe(1);
  });

  it('channel 1 (slow pulse) oscillates within a bounded range', () => {
    const samples = Array.from({ length: 50 }, (_, i) => neonChannelIntensity(1, i * 0.3));
    for (const value of samples) {
      expect(value).toBeGreaterThanOrEqual(0.55);
      expect(value).toBeLessThanOrEqual(1.0);
    }
    // It should actually vary, not sit at a constant value.
    expect(Math.max(...samples) - Math.min(...samples)).toBeGreaterThan(0.1);
  });

  it('channel 1 is deterministic for a given time', () => {
    expect(neonChannelIntensity(1, 7.5)).toBe(neonChannelIntensity(1, 7.5));
  });

  it('channel 2 (occasional flicker) is deterministic and mostly full-bright with rare dropouts', () => {
    const samples = Array.from({ length: 200 }, (_, i) => neonChannelIntensity(2, i * (1 / 8)));
    const dropouts = samples.filter((v) => v < 1);
    expect(dropouts.length).toBeGreaterThan(0);
    expect(dropouts.length).toBeLessThan(samples.length);
    for (const value of samples) {
      expect(value === 1 || value < 0.5).toBe(true);
    }
  });

  it('channel 3 (fast blink) toggles between two discrete levels over time', () => {
    const samples = new Set(
      Array.from({ length: 32 }, (_, i) => neonChannelIntensity(3, i * (1 / 8))),
    );
    expect(samples.size).toBe(2);
    expect(samples.has(1)).toBe(true);
  });
});
