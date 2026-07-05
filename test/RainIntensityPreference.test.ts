import { describe, expect, it } from 'vitest';
import { RainIntensityPreference } from '../src/engine/RainIntensityPreference';
import type { StorageLike } from '../src/engine/RainIntensityPreference';

/** Minimal hand-rolled in-memory `StorageLike`, standing in for `window.localStorage`. */
class FakeStorage implements StorageLike {
  private readonly map = new Map<string, string>();

  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
}

describe('RainIntensityPreference', () => {
  it('defaults to full intensity when storage has no prior value', () => {
    expect(new RainIntensityPreference(new FakeStorage()).intensity).toBe(1);
  });

  it('defaults to full intensity when storage is null (non-browser context)', () => {
    expect(new RainIntensityPreference(null).intensity).toBe(1);
  });

  it('reads a previously persisted intensity on construction', () => {
    const storage = new FakeStorage();
    storage.setItem('voxelcity-rain-intensity', '0.4');
    expect(new RainIntensityPreference(storage).intensity).toBe(0.4);
  });

  it('reads the 0 and 1 endpoints back exactly', () => {
    const zeroStorage = new FakeStorage();
    zeroStorage.setItem('voxelcity-rain-intensity', '0');
    expect(new RainIntensityPreference(zeroStorage).intensity).toBe(0);

    const oneStorage = new FakeStorage();
    oneStorage.setItem('voxelcity-rain-intensity', '1');
    expect(new RainIntensityPreference(oneStorage).intensity).toBe(1);
  });

  it('clamps a persisted value above 1', () => {
    const storage = new FakeStorage();
    storage.setItem('voxelcity-rain-intensity', '5');
    expect(new RainIntensityPreference(storage).intensity).toBe(1);
  });

  it('clamps a persisted value below 0', () => {
    const storage = new FakeStorage();
    storage.setItem('voxelcity-rain-intensity', '-3');
    expect(new RainIntensityPreference(storage).intensity).toBe(0);
  });

  it('falls back to the default when the stored value is corrupt (non-numeric)', () => {
    const storage = new FakeStorage();
    storage.setItem('voxelcity-rain-intensity', 'not-a-number');
    expect(new RainIntensityPreference(storage).intensity).toBe(1);
  });

  it('set(...) persists across a fresh instance reading the same storage', () => {
    const storage = new FakeStorage();
    new RainIntensityPreference(storage).set(0.3);
    expect(new RainIntensityPreference(storage).intensity).toBe(0.3);
  });

  it('set(...) clamps out-of-range input before persisting', () => {
    const storage = new FakeStorage();
    const preference = new RainIntensityPreference(storage);
    preference.set(2.5);
    expect(preference.intensity).toBe(1);
    expect(new RainIntensityPreference(storage).intensity).toBe(1);

    preference.set(-1);
    expect(preference.intensity).toBe(0);
    expect(new RainIntensityPreference(storage).intensity).toBe(0);
  });

  it('works with storage present but never throws when storage is null', () => {
    const preference = new RainIntensityPreference(null);
    expect(() => preference.set(0.7)).not.toThrow();
    expect(preference.intensity).toBe(0.7);
  });
});
