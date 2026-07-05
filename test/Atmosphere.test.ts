import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { Atmosphere } from '../src/engine/Atmosphere';
import * as dayNight from '../src/engine/dayNight';

describe('Atmosphere', () => {
  it('caches interpolateAtmosphere per setTimeOfDay call -- nightFactor reads the cache instead of recomputing', () => {
    const atmosphere = new Atmosphere(new THREE.Scene());
    const spy = vi.spyOn(dayNight, 'interpolateAtmosphere');
    spy.mockClear();

    atmosphere.setTimeOfDay(0.5);
    const callsAfterSet = spy.mock.calls.length;
    expect(callsAfterSet).toBeGreaterThan(0); // setTimeOfDay itself must still recompute once

    // Reverting the cache (having nightFactor call interpolateAtmosphere
    // directly again) is exactly the regression this test catches: reading
    // nightFactor any number of times must not issue further calls.
    const first = atmosphere.nightFactor;
    const second = atmosphere.nightFactor;
    expect(spy.mock.calls.length).toBe(callsAfterSet);
    expect(first).toBe(second);
    expect(first).toBeCloseTo(dayNight.interpolateAtmosphere(0.5).starOpacity, 10);

    spy.mockRestore();
  });

  it('nightFactor reflects a later setTimeOfDay call, not a stale cache from construction', () => {
    const atmosphere = new Atmosphere(new THREE.Scene());

    atmosphere.setTimeOfDay(0); // midnight -- full night
    const midnightFactor = atmosphere.nightFactor;
    atmosphere.setTimeOfDay(0.5); // noon -- full day
    const noonFactor = atmosphere.nightFactor;

    expect(midnightFactor).toBeGreaterThan(noonFactor);
    expect(noonFactor).toBeCloseTo(0, 5);
    expect(midnightFactor).toBeCloseTo(1, 5);
  });
});
