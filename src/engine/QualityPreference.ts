/** Whatever main.ts hands in for persistence — real `window.localStorage`, structurally. Duplicated (not imported) from `audio/types.ts`'s `StorageLike` so `engine/` doesn't reach into `audio/` for an unrelated two-method interface. Mirrors `RainIntensityPreference`'s copy of the same shape. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** localStorage key for the persisted quality tier. */
const STORAGE_KEY = 'voxelcity-quality';

export type QualityTier = 'low' | 'medium' | 'high';

/** Every shipped build before this toggle existed ran at what's now "high" -- defaulting there means nobody's first load post-upgrade looks different; a hot MacBook or a phone is expected to opt *down*, not have the choice made for them. */
const DEFAULT_TIER: QualityTier = 'high';

function isQualityTier(value: string): value is QualityTier {
  return value === 'low' || value === 'medium' || value === 'high';
}

/**
 * Tiny persisted enum, split out of `main.ts` so the persistence logic
 * (read-on-construct, write-on-change, rejecting garbage input) is
 * unit-testable without a `THREE.Scene`. Mirrors `RainIntensityPreference`'s
 * shape: `storage` is nullable so non-browser contexts, or a browser with
 * `localStorage` unavailable entirely, can pass `null` and get an
 * in-memory-only, session-scoped value instead of a crash. (A *present but
 * throwing* storage -- e.g. Safari private-mode's `setItem` quirks -- isn't
 * separately guarded against here, same as `Rain`/`MutePreference`.)
 */
export class QualityPreference {
  private tierValue: QualityTier;

  constructor(private readonly storage: StorageLike | null) {
    this.tierValue = QualityPreference.parse(storage?.getItem(STORAGE_KEY) ?? null);
  }

  private static parse(raw: string | null): QualityTier {
    if (raw === null) return DEFAULT_TIER;
    return isQualityTier(raw) ? raw : DEFAULT_TIER;
  }

  get tier(): QualityTier {
    return this.tierValue;
  }

  set(tier: QualityTier): void {
    this.tierValue = tier;
    this.storage?.setItem(STORAGE_KEY, tier);
  }
}
