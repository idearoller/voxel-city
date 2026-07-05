import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

const BLOOM_RADIUS = 0.5;
const BLOOM_THRESHOLD = 0.85;
/** Bloom runs at half the render target resolution — the blur dominates the
 * visual result, so this halves the cost of the most expensive pass with no
 * perceptible quality loss. */
const BLOOM_RESOLUTION_SCALE = 0.5;

/**
 * Post-processing chain: RenderPass -> UnrealBloomPass (half-res) ->
 * OutputPass. Implements Engine's `Composer` port so `Engine` can drive it
 * without importing postprocessing types itself.
 */
export class PostFX {
  private readonly composer: EffectComposer;
  private readonly bloomPass: UnrealBloomPass;
  private readonly outputPass: OutputPass;

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera) {
    const size = renderer.getSize(new THREE.Vector2());

    this.composer = new EffectComposer(renderer);
    this.composer.addPass(new RenderPass(scene, camera));

    this.bloomPass = new UnrealBloomPass(
      new THREE.Vector2(size.x * BLOOM_RESOLUTION_SCALE, size.y * BLOOM_RESOLUTION_SCALE),
      // Initial strength is a throwaway 0: the day/night cycle is the only
      // source of truth for bloom strength (0.35 day / 0.95 night, see
      // `dayNight.ts`), and `Atmosphere.onBloomStrengthChange` immediately
      // calls `setBloomStrength` with the real value as soon as it's wired
      // up in main.ts, before any frame renders.
      0,
      BLOOM_RADIUS,
      BLOOM_THRESHOLD,
    );
    this.composer.addPass(this.bloomPass);

    this.outputPass = new OutputPass();
    this.composer.addPass(this.outputPass);
  }

  /** Day/night cycle modulates bloom strength (day 0.35 / night 0.95, see `dayNight.ts`). */
  setBloomStrength(strength: number): void {
    this.bloomPass.strength = strength;
  }

  /**
   * Runtime bloom bypass for the quality toggle's Low tier (see
   * `QualityParams.ts`) -- bloom's `UnrealBloomPass` is the single most
   * expensive pass in this chain (5-mip blur), so switching it off is the
   * toggle's single biggest lever. Sets `Pass.enabled`, which
   * `EffectComposer.render()` already respects by skipping disabled passes
   * entirely, rather than removing/re-adding the pass or rebuilding the
   * composer -- no render target is allocated or disposed either way, so
   * this is leak-free and freely reversible at runtime.
   */
  setBloomEnabled(enabled: boolean): void {
    this.bloomPass.enabled = enabled;
  }

  resize(width: number, height: number): void {
    this.composer.setSize(width, height);
    this.bloomPass.resolution.set(width * BLOOM_RESOLUTION_SCALE, height * BLOOM_RESOLUTION_SCALE);
  }

  /**
   * Runtime hook for the quality toggle's DPR lever (see `PixelRatioSync.ts`
   * for why `Engine.setPixelRatio` calls this specifically, not just
   * `resize()`). `EffectComposer` caches its own pixel ratio at construction
   * time and only re-derives `renderTarget1`/`renderTarget2`'s device-pixel
   * size inside its own `setPixelRatio()` -- a bare `composer.setSize(w, h)`
   * (what `resize()` calls) reuses that stale cached ratio, so without this
   * method the two expensive passes (RenderPass, UnrealBloomPass) would stay
   * frozen at whatever ratio was in effect when this `PostFX` was
   * constructed, no matter how many times `resize()` ran afterwards.
   */
  setPixelRatio(ratio: number): void {
    this.composer.setPixelRatio(ratio);
  }

  render(): void {
    this.composer.render();
  }

  /**
   * Disposes the composer's own render targets plus every pass's GPU
   * resources. Mirrors `EnvironmentProbe.dispose` / `Atmosphere.dispose`.
   * Phase-2 teardown hook, intentionally uncalled today: main.ts never
   * tears the app down (single page, lives for the whole session).
   */
  dispose(): void {
    this.composer.dispose();
    this.bloomPass.dispose();
    this.outputPass.dispose();
  }
}
