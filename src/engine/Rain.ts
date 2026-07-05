import * as THREE from 'three';

const STREAK_COUNT = 4000;
const STREAK_LENGTH = 0.5;
const BOX_X = 40;
const BOX_Y = 30;
const BOX_Z = 40;
const FALL_SPEED = 18;
const BASE_OPACITY = 0.35;

const RAIN_VERTEX_SHADER = /* glsl */ `
  uniform float uTime;
  uniform vec3 uCameraPos;
  uniform float uFallSpeed;
  uniform float uBoxY;

  // 0 for a streak's head vertex, STREAK_LENGTH for its tail vertex. Both
  // vertices of a streak share the same baked position.y (the streak's
  // wrap-space anchor); the mod is taken once on that shared anchor and the
  // fixed length offset is applied *after* wrapping, so a streak straddling
  // the wrap boundary gets shifted as a rigid unit instead of its two
  // vertices wrapping independently (which used to stretch ~67 streaks/frame
  // across the full box height).
  attribute float aLengthOffset;

  void main() {
    // position.xz are baked camera-relative offsets in [-BOX_X/2, BOX_X/2] /
    // [-BOX_Z/2, BOX_Z/2]; position.y is the streak's shared wrap-space
    // anchor, scrolling downward over time — the only per-frame cost is this
    // uniform update, no CPU touches the ~8000 vertices themselves.
    float wrappedAnchorY = mod(position.y - uTime * uFallSpeed, uBoxY);
    float y = wrappedAnchorY - aLengthOffset;
    vec3 worldPos = vec3(position.x + uCameraPos.x, y, position.z + uCameraPos.z);
    gl_Position = projectionMatrix * viewMatrix * vec4(worldPos, 1.0);
  }
`;

const RAIN_FRAGMENT_SHADER = /* glsl */ `
  uniform float uOpacity;
  void main() {
    gl_FragColor = vec4(0.75, 0.85, 1.0, uOpacity);
  }
`;

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/**
 * Maps a continuous `intensity` in [0, 1] to an integer vertex count for
 * `BufferGeometry.setDrawRange` (2 vertices per streak, head+tail). This is
 * the cheapest correct lever for a visible rain *amount*: swapping an
 * integer draw range costs nothing per frame and needs no buffer rebuild,
 * unlike varying `STREAK_COUNT` itself which would require re-baking the
 * whole geometry. Exported for unit testing without a `THREE.Scene`.
 */
export function rainDrawVertexCount(intensity: number, streakCount: number = STREAK_COUNT): number {
  return Math.round(clamp01(intensity) * streakCount) * 2;
}

function buildGeometry(): THREE.BufferGeometry {
  const positions = new Float32Array(STREAK_COUNT * 2 * 3);
  const lengthOffsets = new Float32Array(STREAK_COUNT * 2);

  for (let i = 0; i < STREAK_COUNT; i++) {
    const x = (Math.random() - 0.5) * BOX_X;
    const y = Math.random() * BOX_Y;
    const z = (Math.random() - 0.5) * BOX_Z;

    const headIndex = i * 2;
    const tailIndex = i * 2 + 1;

    // Both vertices share the same baked anchor position; only
    // `aLengthOffset` (applied post-wrap in the shader) distinguishes them.
    positions[headIndex * 3] = x;
    positions[headIndex * 3 + 1] = y;
    positions[headIndex * 3 + 2] = z;
    lengthOffsets[headIndex] = 0;

    positions[tailIndex * 3] = x;
    positions[tailIndex * 3 + 1] = y;
    positions[tailIndex * 3 + 2] = z;
    lengthOffsets[tailIndex] = STREAK_LENGTH;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('aLengthOffset', new THREE.Float32BufferAttribute(lengthOffsets, 1));
  // Wrapping happens entirely in the vertex shader against a synthetic
  // camera-relative box, so the default (tiny, local-space) bounding sphere
  // would cause the renderer to frustum-cull the rain incorrectly.
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), Math.max(BOX_X, BOX_Y, BOX_Z));

  return geometry;
}

/**
 * GPU rain: ~4000 short vertical line streaks in a box that follows the
 * camera in xz, falling and wrapping entirely in the vertex shader. One
 * draw call, zero per-frame CPU work beyond updating 3 uniforms.
 */
export class Rain {
  readonly lineSegments: THREE.LineSegments;
  private readonly material: THREE.ShaderMaterial;
  private readonly timeUniform: { value: number };
  private readonly cameraPosUniform: { value: THREE.Vector3 };
  private readonly opacityUniform: { value: number };
  private enabledFlag = true;
  private intensityFlag = 1;

  constructor(scene: THREE.Scene) {
    const geometry = buildGeometry();
    geometry.setDrawRange(0, rainDrawVertexCount(this.intensityFlag));
    this.timeUniform = { value: 0 };
    this.cameraPosUniform = { value: new THREE.Vector3() };
    this.opacityUniform = { value: BASE_OPACITY };

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: this.timeUniform,
        uCameraPos: this.cameraPosUniform,
        uFallSpeed: { value: FALL_SPEED },
        uBoxY: { value: BOX_Y },
        uOpacity: this.opacityUniform,
      },
      vertexShader: RAIN_VERTEX_SHADER,
      fragmentShader: RAIN_FRAGMENT_SHADER,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    });

    this.lineSegments = new THREE.LineSegments(geometry, this.material);
    this.lineSegments.frustumCulled = false;
    scene.add(this.lineSegments);
  }

  get enabled(): boolean {
    return this.enabledFlag;
  }

  setEnabled(enabled: boolean): void {
    this.enabledFlag = enabled;
    this.lineSegments.visible = enabled;
  }

  toggle(): void {
    this.setEnabled(!this.enabledFlag);
  }

  /** Current rain amount in [0, 1]; independent of `enabled` (the on/off master switch — see `main.ts`'s toolbar wiring). */
  get intensity(): number {
    return this.intensityFlag;
  }

  /** Clamps `intensity` to [0, 1] and swaps the draw range to the matching streak count. No per-frame cost: this only runs on user input, not every tick. */
  setIntensity(intensity: number): void {
    this.intensityFlag = clamp01(intensity);
    this.lineSegments.geometry.setDrawRange(0, rainDrawVertexCount(this.intensityFlag));
  }

  /** `nightFactor` in [0, 1] fades rain streaks down (never fully invisible) as day approaches, matching the atmosphere's mood shift. */
  update(dt: number, cameraPosition: THREE.Vector3, nightFactor: number): void {
    this.timeUniform.value += dt;
    this.cameraPosUniform.value.copy(cameraPosition);
    this.opacityUniform.value = BASE_OPACITY * (0.5 + 0.5 * nightFactor);
  }

  dispose(): void {
    this.lineSegments.geometry.dispose();
    this.material.dispose();
  }
}
