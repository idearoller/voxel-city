import type { QualityTier } from './QualityPreference';

export interface QualityParams {
  /**
   * Ceiling passed to `Engine.setPixelRatio` -- not device-aware by itself.
   * `main.ts`'s `applyQuality` clamps this against the actual
   * `window.devicePixelRatio` before applying it (`Math.min(dpr,
   * window.devicePixelRatio)`), the same way Engine's old hardcoded
   * `min(devicePixelRatio, 1.5)` did, so a devicePixelRatio=1 display never
   * gets upscaled to `high`'s 1.5 (that would be a supersampling
   * regression, not a saving, on exactly the low-DPR/thermal-limited
   * hardware this toggle targets).
   */
  dpr: number;
  /** Multiplies `ChunkVisibility.CULL_RADIUS` before it's handed to `ChunkRenderer.setCullRadius`. */
  cullRadiusScale: number;
  /** Passed to `PostFX.setBloomEnabled`. */
  bloomEnabled: boolean;
}

// Chunk-cull fog occlusion, at each tier's scaled radius --------------------
//
// `ChunkVisibility.CULL_RADIUS` was derived (see that module's doc comment)
// from Three.js's FogExp2 term `fogFactor = 1 - exp(-(density*distance)^2)`,
// picking the distance where `density*distance == sqrt(3)` (fogFactor ~=
// 0.95, "visually flattened"). Scaling that radius by `s` scales the
// exponent's base by `s` too, so the fogFactor at the *scaled* radius is:
//
//   fogFactor(s) = 1 - exp(-3 * s^2)
//
//   High   (s=1.0): 1 - exp(-3.00) ~= 0.950  (95.0% fogged -- the derivation's target)
//   Medium (s=0.8): 1 - exp(-1.92) ~= 0.854  (85.4% fogged -- a visible but soft fog line)
//   Low    (s=0.7): 1 - exp(-1.47) ~= 0.770  (77.0% fogged -- a more visible fog line than
//                                              Medium's, and the accepted trade for the
//                                              triangle-count cut on the thermal-throttling/
//                                              phone case this tier exists for)
//
// (0.6 was the first draft for Low: 34% transmittance at the cull edge --
// e.g. a still noticeably-lit neon tower simply vanishing at night, the most
// visible artifact this cull can produce. 0.7's 23% transmittance keeps that
// artifact much less obvious while still cutting cull-radius-squared
// triangle load roughly in half relative to High: 0.7^2 = 0.49 vs 1.0.)
//
// Medium's ~85% keeps the pop subtle (this is where most users who dial
// down from High should land); Low's ~77% is a deliberate, documented step
// down in fog-line quality in exchange for a large triangle-count win.
const LOW_CULL_RADIUS_SCALE = 0.7;
const MEDIUM_CULL_RADIUS_SCALE = 0.8;
const HIGH_CULL_RADIUS_SCALE = 1.0;

const QUALITY_PARAMS: Record<QualityTier, QualityParams> = {
  low: {
    // 1.0 devicePixelRatio: renders at exactly the CSS pixel count, the
    // cheapest a canvas can be per-frame short of dropping resolution below
    // native.
    dpr: 1.0,
    cullRadiusScale: LOW_CULL_RADIUS_SCALE,
    // Bloom's UnrealBloomPass is the single most expensive pass in PostFX's
    // chain (5-mip blur, see PostFX.ts) -- Low turns it off entirely rather
    // than shrinking it further, since a half-strength blur still pays
    // most of that fragment cost.
    bloomEnabled: false,
  },
  medium: {
    dpr: 1.25,
    cullRadiusScale: MEDIUM_CULL_RADIUS_SCALE,
    bloomEnabled: true,
  },
  high: {
    // Matches Engine's pre-existing hardcoded clamp -- current shipped
    // behavior, unchanged for anyone who never touches the toggle.
    dpr: 1.5,
    cullRadiusScale: HIGH_CULL_RADIUS_SCALE,
    bloomEnabled: true,
  },
};

/** Pure tier -> render-parameter lookup. No Three.js, no I/O -- `main.ts` applies the result to `Engine`/`ChunkRenderer`/`PostFX`. */
export function qualityParams(tier: QualityTier): QualityParams {
  return QUALITY_PARAMS[tier];
}
