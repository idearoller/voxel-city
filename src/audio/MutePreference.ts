import type { StorageLike } from './types';

/** localStorage key for the persisted mute toggle. */
const STORAGE_KEY = 'voxelcity-audio-muted';

/**
 * Tiny persisted boolean, split out of `AudioSystem` so the persistence
 * logic (read-on-construct, write-on-change) is unit-testable against a
 * hand-rolled fake `StorageLike` without touching WebAudio at all. `storage`
 * is nullable so callers in non-browser contexts (or a browser with
 * localStorage disabled/throwing, e.g. private-mode Safari quirks) can pass
 * `null` and get an in-memory-only, session-scoped mute flag instead of a
 * crash.
 */
export class MutePreference {
  private mutedFlag: boolean;

  constructor(private readonly storage: StorageLike | null) {
    this.mutedFlag = storage?.getItem(STORAGE_KEY) === '1';
  }

  get muted(): boolean {
    return this.mutedFlag;
  }

  set(muted: boolean): void {
    this.mutedFlag = muted;
    this.storage?.setItem(STORAGE_KEY, muted ? '1' : '0');
  }

  toggle(): boolean {
    this.set(!this.mutedFlag);
    return this.mutedFlag;
  }
}
