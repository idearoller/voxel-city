import * as THREE from 'three';
import { computeFixedSteps, FIXED_TIMESTEP } from './FixedTimestep';
import { applyPixelRatio } from './PixelRatioSync';

export interface EngineCallbacks {
  /** Called at a fixed 60Hz cadence for deterministic simulation logic. */
  update: (dt: number) => void;
  /** Called once per animation frame; alpha in [0,1) is the leftover accumulator fraction. */
  render: (alpha: number) => void;
}

/**
 * Structural port for a post-processing chain (implemented by `PostFX`).
 * Kept as an interface, not a direct `PostFX`/`EffectComposer` dependency,
 * so `Engine` stays free of postprocessing-specific imports; it only needs
 * something it can resize, ask to render, and (see `PixelRatioSync.ts`)
 * re-pixel-ratio.
 */
export interface Composer {
  resize: (width: number, height: number) => void;
  render: () => void;
  /** Must invalidate any pixel-ratio-derived render target sizing -- see `PixelRatioSync.ts`'s doc comment for why a bare `resize()` isn't enough. */
  setPixelRatio: (ratio: number) => void;
}

/**
 * Owns the renderer, scene, camera, resize handling, and the fixed-timestep
 * RAF loop. Simulation (`update`) runs at a fixed 60Hz cadence via an
 * accumulator; rendering (`render`) runs every animation frame with an
 * interpolation alpha.
 */
export class Engine {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly canvas: HTMLCanvasElement;

  private callbacks: EngineCallbacks | null = null;
  private composer: Composer | null = null;
  private accumulator = 0;
  private lastTime = 0;
  private rafHandle = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      powerPreference: 'high-performance',
    });
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    // Clamped to 1.5, not 2: on a retina display this is the difference
    // between rendering ~2.25x and ~4x the CSS pixel count through the full
    // EffectComposer chain (RenderPass + the 5-mip UnrealBloomPass blur,
    // see PostFX.ts) every frame -- a ~44% fill-rate cut on exactly the kind
    // of integrated GPU this matters most for. Bloom already dominates the
    // final look and masks aliasing (see PostFX's BLOOM_RESOLUTION_SCALE
    // comment), so the softer edges from a lower render resolution aren't
    // perceptible in practice.
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));

    this.scene = new THREE.Scene();

    this.camera = new THREE.PerspectiveCamera(
      70,
      window.innerWidth / window.innerHeight,
      0.1,
      600,
    );

    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  private resize(): void {
    const width = window.innerWidth;
    const height = window.innerHeight;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, true);
    this.composer?.resize(width, height);
  }

  /** Routes final-frame rendering through a post-processing chain (e.g. `PostFX`) instead of a bare `renderer.render()`. */
  setComposer(composer: Composer): void {
    this.composer = composer;
  }

  /**
   * Runtime hook for the quality toggle (see `QualityParams.ts`) to change
   * the devicePixelRatio clamp without a reload. Delegates the actual
   * renderer/composer/resize sequencing to `PixelRatioSync.applyPixelRatio`
   * -- see that module's doc comment for why the composer needs its own
   * explicit `setPixelRatio` call, not just a `resize()`.
   */
  setPixelRatio(ratio: number): void {
    applyPixelRatio(this.renderer, this.composer, () => this.resize(), ratio);
  }

  start(callbacks: EngineCallbacks): void {
    this.callbacks = callbacks;
    this.lastTime = performance.now();
    this.rafHandle = requestAnimationFrame(this.tick);
  }

  stop(): void {
    cancelAnimationFrame(this.rafHandle);
  }

  private tick = (now: number): void => {
    this.rafHandle = requestAnimationFrame(this.tick);
    if (!this.callbacks) return;

    const frameDelta = (now - this.lastTime) / 1000;
    this.lastTime = now;

    // computeFixedSteps (FixedTimestep.ts) both advances the accumulator and
    // caps catch-up steps at MAX_STEPS_PER_FRAME, dropping any backlog beyond
    // the cap. That subsumes what a raw frameDelta clamp (e.g. capping at
    // 0.25s/15 steps) would do: bounding steps directly bounds worst-case sim
    // CPU per frame regardless of how large frameDelta gets, so there's no
    // separate delta clamp to keep in sync with it.
    const { steps, accumulator } = computeFixedSteps(this.accumulator, frameDelta);
    this.accumulator = accumulator;
    for (let i = 0; i < steps; i++) {
      this.callbacks.update(FIXED_TIMESTEP);
    }

    const alpha = this.accumulator / FIXED_TIMESTEP;
    this.callbacks.render(alpha);

    if (this.composer) {
      this.composer.render();
    } else {
      this.renderer.render(this.scene, this.camera);
    }
  };
}
