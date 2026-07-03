import * as THREE from 'three';

const CUBE_RENDER_TARGET_SIZE = 256;
const NEAR = 1;
const FAR = 1000;

/**
 * One-shot (not per-frame) environment reflection source for the wet-street
 * look: a CubeCamera renders the scene into a 256px cube target, PMREM turns
 * that into a proper prefiltered env map, and the result is assigned to
 * `roadMaterial.envMap`. Call `refresh()` after city generation/import and
 * after edits settle (debounced by the caller) — never every frame, this is
 * comparatively expensive.
 */
export class EnvironmentProbe {
  private readonly cubeRenderTarget: THREE.WebGLCubeRenderTarget;
  private readonly cubeCamera: THREE.CubeCamera;
  private readonly pmremGenerator: THREE.PMREMGenerator;
  /**
   * `PMREMGenerator.fromCubemap()` returns a `WebGLRenderTarget`, not just a
   * texture -- keeping only `.texture` and disposing that leaks the render
   * target itself on every refresh. Passing the previous target back in as
   * the second (`renderTarget`) argument lets PMREM reuse/dispose it
   * internally instead, so there's at most one live target at a time.
   */
  private currentEnvRT: THREE.WebGLRenderTarget | null = null;

  constructor(private readonly renderer: THREE.WebGLRenderer) {
    this.cubeRenderTarget = new THREE.WebGLCubeRenderTarget(CUBE_RENDER_TARGET_SIZE);
    this.cubeCamera = new THREE.CubeCamera(NEAR, FAR, this.cubeRenderTarget);
    this.pmremGenerator = new THREE.PMREMGenerator(renderer);
  }

  /** Re-renders the cubemap from `position` and assigns a fresh prefiltered envMap onto `material`. */
  refresh(scene: THREE.Scene, position: THREE.Vector3, material: THREE.MeshStandardMaterial): void {
    this.cubeCamera.position.copy(position);
    this.cubeCamera.update(this.renderer, scene);

    this.currentEnvRT = this.pmremGenerator.fromCubemap(this.cubeRenderTarget.texture, this.currentEnvRT);

    material.envMap = this.currentEnvRT.texture;
    material.needsUpdate = true;
  }

  dispose(): void {
    this.cubeRenderTarget.dispose();
    this.pmremGenerator.dispose();
    this.currentEnvRT?.dispose();
    this.currentEnvRT = null;
  }
}
