import { describe, expect, it } from 'vitest';
import { applyPixelRatio } from '../src/engine/PixelRatioSync';
import type { Composer } from '../src/engine/Engine';

/** Records calls instead of touching a real WebGLRenderer -- see `PixelRatioRenderer`'s doc comment for why only this one method is needed. */
class FakeRenderer {
  pixelRatioCalls: number[] = [];

  setPixelRatio(ratio: number): void {
    this.pixelRatioCalls.push(ratio);
  }
}

/** Records calls instead of a real `EffectComposer` -- this is exactly the port `Engine.setComposer` already takes in production (implemented for real by `PostFX`). */
class FakeComposer implements Composer {
  pixelRatioCalls: number[] = [];
  resizeCalls: Array<[number, number]> = [];
  renderCalls = 0;

  setPixelRatio(ratio: number): void {
    this.pixelRatioCalls.push(ratio);
  }

  resize(width: number, height: number): void {
    this.resizeCalls.push([width, height]);
  }

  render(): void {
    this.renderCalls++;
  }
}

describe('applyPixelRatio', () => {
  it('sets the ratio on both the renderer and the composer -- the composer call is what actually resizes its cached render targets (see this module\'s doc comment for the EffectComposer bug this guards against)', () => {
    const renderer = new FakeRenderer();
    const composer = new FakeComposer();

    applyPixelRatio(renderer, composer, () => {}, 1.25);

    expect(renderer.pixelRatioCalls).toEqual([1.25]);
    expect(composer.pixelRatioCalls).toEqual([1.25]);
  });

  it('still sets the renderer\'s ratio when there is no composer yet (Engine can be constructed before setComposer is called)', () => {
    const renderer = new FakeRenderer();

    expect(() => applyPixelRatio(renderer, null, () => {}, 1.0)).not.toThrow();
    expect(renderer.pixelRatioCalls).toEqual([1.0]);
  });

  it('calls resize() after setting the ratio on both, so ordinary width/height sizing (camera aspect, renderer size, bloom resolution) still runs', () => {
    const renderer = new FakeRenderer();
    const composer = new FakeComposer();
    const calls: string[] = [];

    applyPixelRatio(
      renderer,
      composer,
      () => calls.push('resize'),
      1.5,
    );

    // Both pixel-ratio calls must land before resize() runs, so a
    // composer.resize(w, h) that happened to also read the ratio internally
    // (as the real EffectComposer.setSize does) would see the new value.
    expect(composer.pixelRatioCalls).toEqual([1.5]);
    expect(calls).toEqual(['resize']);
  });

  it('never calls composer.resize/render itself -- that stays the caller\'s job, same division of responsibility as the rest of Engine', () => {
    const renderer = new FakeRenderer();
    const composer = new FakeComposer();

    applyPixelRatio(renderer, composer, () => {}, 1.0);

    expect(composer.resizeCalls).toEqual([]);
    expect(composer.renderCalls).toBe(0);
  });
});
