/**
 * Animated billboard display surfaces (Phase 2 Task 6, Part A): a thin
 * textured-quad layer drawn flush over the billboard faces `BillboardScanner`
 * finds, entirely separate from voxel geometry (the voxel mesher is
 * untouched — this is a second, small mesh layer).
 *
 * Draw-call discipline: every billboard quad shares ONE `THREE.InstancedMesh`
 * + ONE `ShaderMaterial` regardless of how many billboards exist in the
 * city — one draw call total, matching `EntityRenderer`'s
 * one-mesh-per-part convention. Per-billboard variation (which atlas design,
 * scroll axis/speed/phase) rides on a per-instance `aParams` attribute, not
 * per-mesh uniforms; `planBillboardInstances` derives that variation purely
 * from each face's own position + the city seed, so it's deterministic and
 * unit-testable without touching Three.js.
 */

import * as THREE from 'three';
import { ATLAS_COLS, ATLAS_DESIGN_COUNT, ATLAS_ROWS, ATLAS_TILE_SIZE } from './BillboardAtlas';
import type { BillboardFace } from './BillboardScanner';
import { BILLBOARD_HEIGHT, BILLBOARD_WIDTH } from '../gen/infrastructure';
import { createRng } from '../gen/rng';

/** Generous upper bound on simultaneous animated billboards — comfortably above what `BILLBOARD_CHANCE` (8% of buildings) produces even on a dense downtown-heavy seed. Extra faces past this are silently dropped (decorative feature, not correctness-critical). */
const MAX_BILLBOARDS = 256;

/** cycles/second range for the scrolling animation — slow enough to read as a scrolling sign, not a strobe. */
const SCROLL_SPEED_MIN = 0.08;
const SCROLL_SPEED_MAX = 0.35;

/** Same HDR-boost convention as `Materials.ts`'s `NEON_HDR_BOOST`, so billboards bloom consistently with every other neon surface. */
const HDR_BOOST = 2.5;
/** Brightness multiplier at full day vs full night (see `Atmosphere.nightFactor`) — dim but still legible by day, full neon punch at night. */
const DAY_BRIGHTNESS = 0.35;
const NIGHT_BRIGHTNESS = 1.0;

export interface BillboardInstanceParams {
  variantIndex: number;
  /** 0 = scrolls horizontally within its atlas tile, 1 = vertically. */
  scrollAxis: 0 | 1;
  /** Signed cycles/second; sign picks scroll direction. */
  scrollSpeed: number;
  /** [0, 1) phase offset so same-variant billboards don't scroll in lockstep. */
  phase: number;
}

/**
 * Derives each face's atlas variant + scroll animation from its own
 * position and the city seed — not array index, so it's stable regardless
 * of `scanBillboardFaces`' iteration order. Pure, no Three.js.
 */
export function planBillboardInstances(faces: readonly BillboardFace[], seed: string): BillboardInstanceParams[] {
  const rootRng = createRng(seed).fork('billboard-instances');
  return faces.map((face) => {
    const positionKey = face.position.map((c) => c.toFixed(3)).join(',');
    const faceRng = rootRng.fork(positionKey);
    const direction = faceRng.chance(0.5) ? 1 : -1;
    return {
      variantIndex: faceRng.intRange(0, ATLAS_DESIGN_COUNT - 1),
      scrollAxis: faceRng.chance(0.5) ? 0 : 1,
      scrollSpeed: direction * faceRng.float(SCROLL_SPEED_MIN, SCROLL_SPEED_MAX),
      phase: faceRng.float(0, 1),
    };
  });
}

const VERTEX_SHADER = /* glsl */ `
  attribute vec4 aParams;
  varying vec2 vUv;
  varying vec4 vParams;

  void main() {
    vUv = uv;
    vParams = aParams;
    vec4 worldPosition = instanceMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * modelViewMatrix * worldPosition;
  }
`;

const FRAGMENT_SHADER = /* glsl */ `
  uniform sampler2D map;
  uniform float uTime;
  uniform float uNightFactor;
  varying vec2 vUv;
  varying vec4 vParams;

  const float kCols = ${ATLAS_COLS.toFixed(1)};
  const float kRows = ${ATLAS_ROWS.toFixed(1)};
  const float kHdrBoost = ${HDR_BOOST.toFixed(2)};
  const float kDayBrightness = ${DAY_BRIGHTNESS.toFixed(2)};
  const float kNightBrightness = ${NIGHT_BRIGHTNESS.toFixed(2)};
  // Half a texel's worth of inset, in local [0,1] tile space -- keeps every
  // sample strictly inside its own tile even right at the scroll-wrap seam
  // (localUv hits exactly 0.0/1.0 once per cycle), belt-and-suspenders
  // alongside disabling mipmaps in BillboardAtlas.rasterizeAtlasTexture.
  const float kUvInset = 0.5 / ${ATLAS_TILE_SIZE.toFixed(1)};

  void main() {
    float variantIndex = vParams.x;
    float scrollAxis = vParams.y;
    float scrollSpeed = vParams.z;
    float phase = vParams.w;

    float col = mod(variantIndex, kCols);
    float row = floor(variantIndex / kCols + 0.001);
    vec2 cellSize = vec2(1.0 / kCols, 1.0 / kRows);

    float scroll = fract(uTime * scrollSpeed + phase);
    vec2 localUv = vUv;
    if (scrollAxis < 0.5) {
      localUv.x = fract(localUv.x + scroll);
    } else {
      localUv.y = fract(localUv.y + scroll);
    }
    localUv = clamp(localUv, kUvInset, 1.0 - kUvInset);

    vec2 atlasUv = vec2(col, row) * cellSize + localUv * cellSize;
    vec3 texColor = texture2D(map, atlasUv).rgb;

    float brightness = mix(kDayBrightness, kNightBrightness, uNightFactor);
    gl_FragColor = vec4(texColor * brightness * kHdrBoost, 1.0);
  }
`;

/**
 * Angle (radians, around Y) that rotates a `THREE.PlaneGeometry`'s default
 * +Z-facing normal to align with an axis-aligned outward `normal`.
 * `atan2(nx, nz)` gives the one rotation that maps `(0,0,1)` -> the target
 * for every one of the 4 cardinal normals `BillboardScanner` can produce.
 */
function yAngleForNormal(normal: readonly [number, number, number]): number {
  return Math.atan2(normal[0], normal[2]);
}

export class BillboardLayer {
  private readonly geometry: THREE.PlaneGeometry;
  private readonly material: THREE.ShaderMaterial;
  private readonly paramsAttribute: THREE.InstancedBufferAttribute;
  private readonly mesh: THREE.InstancedMesh;
  private readonly dummy = new THREE.Object3D();

  constructor(private readonly scene: THREE.Scene) {
    this.geometry = new THREE.PlaneGeometry(BILLBOARD_WIDTH, BILLBOARD_HEIGHT);
    this.paramsAttribute = new THREE.InstancedBufferAttribute(new Float32Array(MAX_BILLBOARDS * 4), 4);
    this.geometry.setAttribute('aParams', this.paramsAttribute);

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        map: { value: null },
        uTime: { value: 0 },
        uNightFactor: { value: 1 },
      },
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      toneMapped: false,
    });

    this.mesh = new THREE.InstancedMesh(this.geometry, this.material, MAX_BILLBOARDS);
    this.mesh.frustumCulled = false; // instances range across the whole city, like EntityRenderer's meshes
    this.mesh.count = 0;
    scene.add(this.mesh);
  }

  /** Swaps in the rasterized atlas texture (see `BillboardAtlas.rasterizeAtlasTexture`). */
  setAtlas(texture: THREE.Texture): void {
    this.material.uniforms.map!.value = texture;
  }

  /** Re-derives every instance's transform + animation params from a fresh scan. Safe to call after every generation/import. */
  rebuild(faces: readonly BillboardFace[], seed: string): void {
    const instances = planBillboardInstances(faces, seed);
    const count = Math.min(faces.length, MAX_BILLBOARDS);

    for (let i = 0; i < count; i++) {
      const face = faces[i] as BillboardFace;
      const params = instances[i] as BillboardInstanceParams;

      this.dummy.position.set(face.position[0], face.position[1], face.position[2]);
      this.dummy.rotation.set(0, yAngleForNormal(face.normal), 0);
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(i, this.dummy.matrix);

      const base = i * 4;
      this.paramsAttribute.array[base] = params.variantIndex;
      this.paramsAttribute.array[base + 1] = params.scrollAxis;
      this.paramsAttribute.array[base + 2] = params.scrollSpeed;
      this.paramsAttribute.array[base + 3] = params.phase;
    }

    this.mesh.count = count;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.paramsAttribute.needsUpdate = true;
  }

  /** Call once per animation frame: advances the scroll animation and applies the current day/night brightness. */
  update(elapsedTime: number, nightFactor: number): void {
    this.material.uniforms.uTime!.value = elapsedTime;
    this.material.uniforms.uNightFactor!.value = nightFactor;
  }

  dispose(): void {
    this.scene.remove(this.mesh);
    this.geometry.dispose();
    this.material.dispose();
  }
}
