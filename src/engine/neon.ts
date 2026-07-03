/**
 * Pure per-channel neon brightness modulation, sampled once a frame per
 * channel in `Materials.updateNeon(time)`. Four shared neon materials cover
 * thousands of voxels, so animating brightness here (multiplied onto each
 * material's `.color`, which Three.js multiplies against baked vertex
 * colors) is effectively free compared to touching geometry.
 *
 * Deterministic and hash-based (no Math.random) so behavior is reproducible
 * and unit-testable: the same `time` always yields the same intensity.
 */

export type NeonChannel = 0 | 1 | 2 | 3;

const PULSE_SPEED = 1.4; // radians/sec-ish, "slow" sine pulse
const PULSE_MIN = 0.55;
const PULSE_MAX = 1.0;

const FLICKER_BUCKET_RATE = 8; // buckets/sec — "occasional" dropout
const FLICKER_DROPOUT_CHANCE = 0.18;
const FLICKER_DROPOUT_LEVEL = 0.15;

const BLINK_BUCKET_RATE = 8; // buckets/sec — "fast" on/off

/** Deterministic 0..1 hash of an integer, via a fixed-point mix (no trig, no Math.random). */
function hash01(n: number): number {
  let x = (n ^ 0x9e3779b9) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b) >>> 0;
  x = (x ^ (x >>> 16)) >>> 0;
  return x / 0xffffffff;
}

function steady(): number {
  return 1;
}

function slowPulse(time: number): number {
  const wave = (Math.sin(time * PULSE_SPEED) + 1) / 2; // 0..1
  return PULSE_MIN + wave * (PULSE_MAX - PULSE_MIN);
}

function occasionalFlicker(time: number): number {
  const bucket = Math.floor(time * FLICKER_BUCKET_RATE);
  return hash01(bucket) < FLICKER_DROPOUT_CHANCE ? FLICKER_DROPOUT_LEVEL : 1;
}

function fastBlink(time: number): number {
  const bucket = Math.floor(time * BLINK_BUCKET_RATE);
  return bucket % 2 === 0 ? 1 : 0.12;
}

/** Brightness multiplier in [0, 1] for the given neon channel at the given time. */
export function neonChannelIntensity(channel: NeonChannel, time: number): number {
  switch (channel) {
    case 0:
      return steady();
    case 1:
      return slowPulse(time);
    case 2:
      return occasionalFlicker(time);
    case 3:
      return fastBlink(time);
  }
}
