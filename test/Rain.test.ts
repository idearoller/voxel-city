import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { Rain, rainDrawVertexCount } from '../src/engine/Rain';

describe('rainDrawVertexCount', () => {
  const streakCount = 4000;

  it('is 0 at intensity 0', () => {
    expect(rainDrawVertexCount(0, streakCount)).toBe(0);
  });

  it('is 2 vertices per streak at intensity 1 (every streak drawn)', () => {
    expect(rainDrawVertexCount(1, streakCount)).toBe(streakCount * 2);
  });

  it('is always an even number (2 vertices per streak, head + tail)', () => {
    for (const intensity of [0, 0.01, 0.33, 0.5, 0.67, 0.99, 1]) {
      expect(rainDrawVertexCount(intensity, streakCount) % 2).toBe(0);
    }
  });

  it('rounds to the nearest streak rather than always flooring or ceiling', () => {
    // 0.5 of 4000 streaks = 2000 streaks = 4000 vertices, exactly representable.
    expect(rainDrawVertexCount(0.5, streakCount)).toBe(4000);
    // With a small streak count, 0.35 of 10 streaks = 3.5 streaks: rounding
    // (not flooring) takes this up to 4 streaks / 8 vertices.
    expect(rainDrawVertexCount(0.35, 10)).toBe(8);
  });

  it('is monotonically non-decreasing as intensity increases', () => {
    let previous = rainDrawVertexCount(0, streakCount);
    for (let i = 1; i <= 20; i++) {
      const current = rainDrawVertexCount(i / 20, streakCount);
      expect(current).toBeGreaterThanOrEqual(previous);
      previous = current;
    }
  });

  it('clamps out-of-range intensity instead of over/under-drawing', () => {
    expect(rainDrawVertexCount(-5, streakCount)).toBe(0);
    expect(rainDrawVertexCount(5, streakCount)).toBe(streakCount * 2);
  });
});

describe('Rain', () => {
  function makeRain(): Rain {
    return new Rain(new THREE.Scene());
  }

  it('defaults to full intensity (draws every streak) so existing rain looks unchanged out of the box', () => {
    const rain = makeRain();
    expect(rain.intensity).toBe(1);
    const geometry = rain.lineSegments.geometry;
    expect(geometry.drawRange.count).toBe(4000 * 2);
  });

  it('setIntensity updates the exposed intensity and the geometry draw range together', () => {
    const rain = makeRain();
    rain.setIntensity(0.25);
    expect(rain.intensity).toBe(0.25);
    expect(rain.lineSegments.geometry.drawRange.count).toBe(rainDrawVertexCount(0.25));
  });

  it('setIntensity(0) still leaves the object enabled and visible — draw range does the hiding, not visibility', () => {
    const rain = makeRain();
    rain.setIntensity(0);
    expect(rain.enabled).toBe(true);
    expect(rain.lineSegments.visible).toBe(true);
    expect(rain.lineSegments.geometry.drawRange.count).toBe(0);
  });

  it('clamps an out-of-range setIntensity call', () => {
    const rain = makeRain();
    rain.setIntensity(2.5);
    expect(rain.intensity).toBe(1);
    rain.setIntensity(-1);
    expect(rain.intensity).toBe(0);
  });

  it('setEnabled(false) hides the whole object regardless of intensity (on/off master switch)', () => {
    const rain = makeRain();
    rain.setIntensity(1);
    rain.setEnabled(false);
    expect(rain.lineSegments.visible).toBe(false);
    // Intensity is preserved so re-enabling restores the same amount of rain.
    expect(rain.intensity).toBe(1);
  });

  it('toggle flips enabled without touching intensity', () => {
    const rain = makeRain();
    rain.setIntensity(0.6);
    rain.toggle();
    expect(rain.enabled).toBe(false);
    expect(rain.intensity).toBe(0.6);
    rain.toggle();
    expect(rain.enabled).toBe(true);
    expect(rain.intensity).toBe(0.6);
  });

  it('update() does not touch the draw range (no per-frame buffer rebuild)', () => {
    const rain = makeRain();
    rain.setIntensity(0.4);
    const before = rain.lineSegments.geometry.drawRange.count;
    rain.update(0.016, new THREE.Vector3(1, 2, 3), 0.5);
    expect(rain.lineSegments.geometry.drawRange.count).toBe(before);
  });
});
