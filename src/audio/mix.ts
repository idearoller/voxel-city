/**
 * Pure day/night + rain -> per-bus gain mix, no WebAudio, no DOM. Mirrors the
 * split between `dayNight.ts` (pure interpolation) and `Atmosphere.ts` (the
 * Three.js object it drives): keeping the curve here means the mix itself is
 * unit-testable without an AudioContext, and `AudioSystem.update()` just
 * pushes the result onto `AudioParam.setTargetAtTime` ramps every tick.
 *
 * `nightFactor` is derived from `dayFactor` (see `engine/dayNight.ts`) the
 * same way `Atmosphere.nightFactor` is (`1 - dayFactor(timeOfDay)`), so the
 * audio mix and the visual mood swing together without duplicating the
 * curve's shape.
 */

import { dayFactor } from '../engine/dayNight';

/** Conservative headroom bus levels (pre-compressor) — this is an ambient bed, not a foreground effect. */
const RAIN_BASE_GAIN = 0.18;
const HUM_BASE_GAIN = 0.05;
const TRAFFIC_BASE_GAIN = 0.09;

/** Sandbox mode is for building/editing, not immersion — ambient beds duck a bit so they don't compete with attention on the voxel grid. */
const SANDBOX_MIX_ATTENUATION = 0.6;

export interface AmbientState {
  /** Cyclic fraction in [0, 1) — same convention as `Atmosphere.currentTimeOfDay`. */
  timeOfDay: number;
  /** [0, 1] continuous rain amount — `Rain.enabled` gates this to 0 when rain is toggled off; otherwise it's the toolbar's intensity slider value (see `Rain.intensity`). */
  rainIntensity: number;
  isPlayMode: boolean;
}

export interface AmbientMix {
  rainGain: number;
  humGain: number;
  trafficGain: number;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/** Same derivation as `Atmosphere.nightFactor`: 1 at full night, 0 at full day. */
export function nightFactorFromTimeOfDay(timeOfDay: number): number {
  return 1 - dayFactor(timeOfDay);
}

/**
 * Computes the target gain for each ambient bus. Design rationale per bus:
 *
 *  - Rain: follows `rainIntensity` directly (silence when off); night gets a
 *    little more presence than day (0.55x-1.0x), echoing `Rain.ts`'s own
 *    opacity curve (`BASE_OPACITY * (0.5 + 0.5 * nightFactor)`) so the visual
 *    streaks and the audio bed brighten together rather than independently.
 *  - Neon hum: this is a night-city soundscape first — the hum is always
 *    faintly present (neon never fully switches off) but swells toward night
 *    (0.7x-1.0x) when the signs themselves are the brightest bloom source.
 *  - Traffic: the inverse lean — a *busier* daytime city, quieter (but never
 *    silent) once neon night takes over (0.6x-1.0x favoring day).
 *
 * Both hum and traffic duck by `SANDBOX_MIX_ATTENUATION` in sandbox/fly mode:
 * that's edit-and-build mode, not "walking the city", so the ambient bed
 * steps back rather than competing for attention.
 */
export function computeAmbientMix(state: AmbientState): AmbientMix {
  const night = clamp01(nightFactorFromTimeOfDay(state.timeOfDay));
  const rain = clamp01(state.rainIntensity);
  const modeAttenuation = state.isPlayMode ? 1 : SANDBOX_MIX_ATTENUATION;

  return {
    rainGain: RAIN_BASE_GAIN * rain * (0.55 + 0.45 * night),
    humGain: HUM_BASE_GAIN * (0.7 + 0.3 * night) * modeAttenuation,
    trafficGain: TRAFFIC_BASE_GAIN * (0.6 + 0.4 * (1 - night)) * modeAttenuation,
  };
}
