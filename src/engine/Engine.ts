import * as THREE from 'three';

const FIXED_TIMESTEP = 1 / 60;
const MAX_FRAME_DELTA = 0.25;

export interface EngineCallbacks {
  /** Called at a fixed 60Hz cadence for deterministic simulation logic. */
  update: (dt: number) => void;
  /** Called once per animation frame; alpha in [0,1) is the leftover accumulator fraction. */
  render: (alpha: number) => void;
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
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

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

    let frameDelta = (now - this.lastTime) / 1000;
    this.lastTime = now;
    frameDelta = Math.min(frameDelta, MAX_FRAME_DELTA);

    this.accumulator += frameDelta;
    while (this.accumulator >= FIXED_TIMESTEP) {
      this.callbacks.update(FIXED_TIMESTEP);
      this.accumulator -= FIXED_TIMESTEP;
    }

    const alpha = this.accumulator / FIXED_TIMESTEP;
    this.callbacks.render(alpha);
    this.renderer.render(this.scene, this.camera);
  };
}
