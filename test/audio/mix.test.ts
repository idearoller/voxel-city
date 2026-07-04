import { describe, expect, it } from 'vitest';
import { computeAmbientMix, nightFactorFromTimeOfDay } from '../../src/audio/mix';

describe('nightFactorFromTimeOfDay', () => {
  it('is 1 at midnight (t=0)', () => {
    expect(nightFactorFromTimeOfDay(0)).toBeCloseTo(1, 5);
  });

  it('is 0 at noon (t=0.5)', () => {
    expect(nightFactorFromTimeOfDay(0.5)).toBeCloseTo(0, 5);
  });
});

describe('computeAmbientMix', () => {
  const midnight = 0;
  const noon = 0.5;

  it('rain is silent when rainIntensity is 0, regardless of time of day', () => {
    expect(computeAmbientMix({ timeOfDay: midnight, rainIntensity: 0, isPlayMode: true }).rainGain).toBe(0);
    expect(computeAmbientMix({ timeOfDay: noon, rainIntensity: 0, isPlayMode: true }).rainGain).toBe(0);
  });

  it('rain gain is louder at night than at day for the same rain intensity', () => {
    const nightRain = computeAmbientMix({ timeOfDay: midnight, rainIntensity: 1, isPlayMode: true }).rainGain;
    const dayRain = computeAmbientMix({ timeOfDay: noon, rainIntensity: 1, isPlayMode: true }).rainGain;
    expect(nightRain).toBeGreaterThan(dayRain);
  });

  it('rain gain is never fully silent while raining, even at full day', () => {
    const dayRain = computeAmbientMix({ timeOfDay: noon, rainIntensity: 1, isPlayMode: true }).rainGain;
    expect(dayRain).toBeGreaterThan(0);
  });

  it('rain gain is unaffected by play/sandbox mode (only hum/traffic duck in sandbox)', () => {
    const playRain = computeAmbientMix({ timeOfDay: midnight, rainIntensity: 1, isPlayMode: true }).rainGain;
    const sandboxRain = computeAmbientMix({ timeOfDay: midnight, rainIntensity: 1, isPlayMode: false }).rainGain;
    expect(sandboxRain).toBe(playRain);
  });

  it('neon hum is always present (never silent), even at full day with no rain', () => {
    const dayHum = computeAmbientMix({ timeOfDay: noon, rainIntensity: 0, isPlayMode: true }).humGain;
    expect(dayHum).toBeGreaterThan(0);
  });

  it('neon hum swells at night relative to day', () => {
    const nightHum = computeAmbientMix({ timeOfDay: midnight, rainIntensity: 0, isPlayMode: true }).humGain;
    const dayHum = computeAmbientMix({ timeOfDay: noon, rainIntensity: 0, isPlayMode: true }).humGain;
    expect(nightHum).toBeGreaterThan(dayHum);
  });

  it('traffic is busier by day than by night', () => {
    const dayTraffic = computeAmbientMix({ timeOfDay: noon, rainIntensity: 0, isPlayMode: true }).trafficGain;
    const nightTraffic = computeAmbientMix({ timeOfDay: midnight, rainIntensity: 0, isPlayMode: true }).trafficGain;
    expect(dayTraffic).toBeGreaterThan(nightTraffic);
  });

  it('traffic is never fully silent at night', () => {
    const nightTraffic = computeAmbientMix({ timeOfDay: midnight, rainIntensity: 0, isPlayMode: true }).trafficGain;
    expect(nightTraffic).toBeGreaterThan(0);
  });

  it('sandbox mode attenuates hum and traffic relative to play mode at the same time of day', () => {
    const play = computeAmbientMix({ timeOfDay: midnight, rainIntensity: 0, isPlayMode: true });
    const sandbox = computeAmbientMix({ timeOfDay: midnight, rainIntensity: 0, isPlayMode: false });
    expect(sandbox.humGain).toBeLessThan(play.humGain);
    expect(sandbox.trafficGain).toBeLessThan(play.trafficGain);
  });

  it('clamps out-of-range rainIntensity instead of producing negative or runaway gain', () => {
    const negative = computeAmbientMix({ timeOfDay: midnight, rainIntensity: -5, isPlayMode: true });
    const excessive = computeAmbientMix({ timeOfDay: midnight, rainIntensity: 5, isPlayMode: true });
    expect(negative.rainGain).toBe(0);
    expect(excessive.rainGain).toBe(
      computeAmbientMix({ timeOfDay: midnight, rainIntensity: 1, isPlayMode: true }).rainGain,
    );
  });

  it('is a pure function: identical input produces identical output', () => {
    const state = { timeOfDay: 0.37, rainIntensity: 0.6, isPlayMode: true };
    expect(computeAmbientMix(state)).toEqual(computeAmbientMix({ ...state }));
  });
});
