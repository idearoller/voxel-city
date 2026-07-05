import type { Composer } from './Engine';

/**
 * Structural port for the one method `applyPixelRatio` needs from
 * `THREE.WebGLRenderer` -- kept minimal (not importing `THREE.WebGLRenderer`
 * itself) so this stays testable with a plain fake in Node, same rationale
 * as `Engine`'s own `Composer` port.
 */
export interface PixelRatioRenderer {
  setPixelRatio: (ratio: number) => void;
}

/**
 * Propagation logic for `Engine.setPixelRatio`, extracted so it's
 * unit-testable without a real `WebGLRenderer`/`EffectComposer` (`Engine`
 * itself needs a real GL context, which Node doesn't have -- see
 * `FixedTimestep.ts` for the same rationale applied to the RAF loop).
 *
 * Exists because of a real bug: `THREE.WebGLRenderer.setPixelRatio` resizes
 * its own drawing buffer immediately, but `EffectComposer` caches its own
 * pixel ratio at construction time (`renderer.getPixelRatio()`) and only
 * re-reads it -- and re-sizes `renderTarget1`/`renderTarget2` accordingly --
 * inside its own `setPixelRatio()`/`reset()`. A bare `composer.setSize(w, h)`
 * (what `resize()` calls) reuses that stale cached ratio, so RenderPass's
 * and UnrealBloomPass's render targets (the two expensive passes; OutputPass
 * is terminal and blits whatever size it's given) would stay frozen at
 * construction-time resolution forever if only `renderer.setPixelRatio` and
 * `resize()` were called. Calling `composer.setPixelRatio` here is what
 * actually invalidates that cache.
 */
export function applyPixelRatio(
  renderer: PixelRatioRenderer,
  composer: Composer | null,
  resize: () => void,
  ratio: number,
): void {
  renderer.setPixelRatio(ratio);
  composer?.setPixelRatio(ratio);
  resize();
}
