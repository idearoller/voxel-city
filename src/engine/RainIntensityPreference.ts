/** Whatever main.ts hands in for persistence — real `window.localStorage`, structurally. Duplicated (not imported) from `audio/types.ts`'s `StorageLike` so `engine/` doesn't reach into `audio/` for an unrelated two-method interface. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** localStorage key for the persisted rain intensity slider. */
const STORAGE_KEY = 'voxelcity-rain-intensity';

/** Rain was always full-strength whenever enabled before this slider existed; keeping that as the default preserves existing users' expectations on their first load post-upgrade. */
const DEFAULT_INTENSITY = 1;

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/**
 * Tiny persisted float in [0, 1], split out of `Rain`/`main.ts` so the
 * persistence logic (read-on-construct, write-on-change, clamping garbage
 * input) is unit-testable without a `THREE.Scene`. Mirrors
 * `audio/MutePreference`'s shape: `storage` is nullable so non-browser
 * contexts (or a browser with localStorage disabled/throwing) get an
 * in-memory-only, session-scoped value instead of a crash.
 */
export class RainIntensityPreference {
  private intensityValue: number;

  constructor(private readonly storage: StorageLike | null) {
    this.intensityValue = RainIntensityPreference.parse(storage?.getItem(STORAGE_KEY) ?? null);
  }

  private static parse(raw: string | null): number {
    if (raw === null) return DEFAULT_INTENSITY;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? clamp01(parsed) : DEFAULT_INTENSITY;
  }

  get intensity(): number {
    return this.intensityValue;
  }

  set(intensity: number): void {
    this.intensityValue = clamp01(intensity);
    this.storage?.setItem(STORAGE_KEY, String(this.intensityValue));
  }
}
