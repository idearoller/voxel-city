import { describe, expect, it } from 'vitest';
import { MutePreference } from '../../src/audio/MutePreference';
import type { StorageLike } from '../../src/audio/types';

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

describe('MutePreference', () => {
  it('defaults to unmuted when storage has no prior value', () => {
    expect(new MutePreference(new FakeStorage()).muted).toBe(false);
  });

  it('defaults to unmuted when storage is null (non-browser context)', () => {
    expect(new MutePreference(null).muted).toBe(false);
  });

  it('reads a previously persisted mute flag on construction', () => {
    const storage = new FakeStorage();
    storage.setItem('voxelcity-audio-muted', '1');
    expect(new MutePreference(storage).muted).toBe(true);
  });

  it('treats any stored value other than exactly "1" as unmuted', () => {
    const storage = new FakeStorage();
    storage.setItem('voxelcity-audio-muted', 'true');
    expect(new MutePreference(storage).muted).toBe(false);
  });

  it('set(true) persists across a fresh instance reading the same storage', () => {
    const storage = new FakeStorage();
    new MutePreference(storage).set(true);
    expect(new MutePreference(storage).muted).toBe(true);
  });

  it('set(false) persists and overwrites a previous mute', () => {
    const storage = new FakeStorage();
    storage.setItem('voxelcity-audio-muted', '1');
    const preference = new MutePreference(storage);
    preference.set(false);
    expect(preference.muted).toBe(false);
    expect(new MutePreference(storage).muted).toBe(false);
  });

  it('toggle flips the flag and returns the new value', () => {
    const preference = new MutePreference(new FakeStorage());
    expect(preference.toggle()).toBe(true);
    expect(preference.muted).toBe(true);
    expect(preference.toggle()).toBe(false);
    expect(preference.muted).toBe(false);
  });

  it('toggle persists through storage when one is provided', () => {
    const storage = new FakeStorage();
    const preference = new MutePreference(storage);
    preference.toggle();
    expect(new MutePreference(storage).muted).toBe(true);
  });

  it('works with storage present but never throws when storage is null', () => {
    const preference = new MutePreference(null);
    expect(() => preference.toggle()).not.toThrow();
    expect(preference.muted).toBe(true);
  });
});
