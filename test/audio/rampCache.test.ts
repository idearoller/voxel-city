import { describe, expect, it } from 'vitest';
import { RampTargetCache } from '../../src/audio/rampCache';

describe('RampTargetCache', () => {
  it('issues the first target unconditionally', () => {
    const cache = new RampTargetCache(1e-4);
    const issued: number[] = [];

    cache.set(0.5, (v) => issued.push(v));

    expect(issued).toEqual([0.5]);
  });

  it('skips a repeated target within epsilon of the last one issued', () => {
    const cache = new RampTargetCache(1e-3);
    const issued: number[] = [];

    cache.set(0.5, (v) => issued.push(v));
    cache.set(0.5, (v) => issued.push(v));
    cache.set(0.5 + 5e-4, (v) => issued.push(v)); // within epsilon

    expect(issued).toEqual([0.5]);
  });

  it('issues again once the target moves beyond epsilon', () => {
    const cache = new RampTargetCache(1e-3);
    const issued: number[] = [];

    cache.set(0.5, (v) => issued.push(v));
    cache.set(0.6, (v) => issued.push(v));

    expect(issued).toEqual([0.5, 0.6]);
  });

  it('compares against the last *issued* target, not a running current value -- an unissued in-between target never becomes the new baseline', () => {
    const cache = new RampTargetCache(0.05);
    const issued: number[] = [];

    cache.set(1.0, (v) => issued.push(v)); // issued, baseline = 1.0
    cache.set(1.02, (v) => issued.push(v)); // within epsilon of 1.0 -- skipped, baseline stays 1.0
    cache.set(1.04, (v) => issued.push(v)); // within epsilon of 1.0 (baseline never moved to 1.02) -- skipped

    expect(issued).toEqual([1.0]);
  });
});
