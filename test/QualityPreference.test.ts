import { describe, expect, it } from 'vitest';
import { QualityPreference } from '../src/engine/QualityPreference';
import type { StorageLike } from '../src/engine/QualityPreference';

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

describe('QualityPreference', () => {
  it('defaults to high when storage has no prior value', () => {
    expect(new QualityPreference(new FakeStorage()).tier).toBe('high');
  });

  it('defaults to high when storage is null (non-browser context)', () => {
    expect(new QualityPreference(null).tier).toBe('high');
  });

  it('reads a previously persisted tier on construction', () => {
    const storage = new FakeStorage();
    storage.setItem('voxelcity-quality', 'low');
    expect(new QualityPreference(storage).tier).toBe('low');
  });

  it('reads each valid tier back exactly', () => {
    for (const tier of ['low', 'medium', 'high'] as const) {
      const storage = new FakeStorage();
      storage.setItem('voxelcity-quality', tier);
      expect(new QualityPreference(storage).tier).toBe(tier);
    }
  });

  it('falls back to the default when the stored value is garbage', () => {
    const storage = new FakeStorage();
    storage.setItem('voxelcity-quality', 'ultra-mega');
    expect(new QualityPreference(storage).tier).toBe('high');
  });

  it('falls back to the default when the stored value is empty', () => {
    const storage = new FakeStorage();
    storage.setItem('voxelcity-quality', '');
    expect(new QualityPreference(storage).tier).toBe('high');
  });

  it('set(...) persists across a fresh instance reading the same storage', () => {
    const storage = new FakeStorage();
    new QualityPreference(storage).set('medium');
    expect(new QualityPreference(storage).tier).toBe('medium');
  });

  it('works with storage present but never throws when storage is null', () => {
    const preference = new QualityPreference(null);
    expect(() => preference.set('low')).not.toThrow();
    expect(preference.tier).toBe('low');
  });
});
