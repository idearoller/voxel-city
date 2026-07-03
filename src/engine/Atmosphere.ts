import * as THREE from 'three';
import { DEFAULT_TIME_OF_DAY, interpolateAtmosphere } from './dayNight';

const SKY_RADIUS = 500;
const STAR_COUNT = 1500;
const STAR_FIELD_RADIUS = 480;
/** Full day/night cycle length in seconds when playing (slow — this is ambiance, not a clock). */
const CYCLE_DURATION_SECONDS = 300;

const SKY_VERTEX_SHADER = /* glsl */ `
  varying vec3 vWorldDirection;
  void main() {
    vWorldDirection = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const SKY_FRAGMENT_SHADER = /* glsl */ `
  uniform vec3 uHorizonColor;
  uniform vec3 uZenithColor;
  varying vec3 vWorldDirection;
  void main() {
    float h = clamp(vWorldDirection.y * 0.5 + 0.5, 0.0, 1.0);
    vec3 color = mix(uHorizonColor, uZenithColor, pow(h, 0.55));
    gl_FragColor = vec4(color, 1.0);
  }
`;

function buildSky(): THREE.Mesh {
  const geometry = new THREE.SphereGeometry(SKY_RADIUS, 32, 16);
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uHorizonColor: { value: new THREE.Color(0x2a1440) },
      uZenithColor: { value: new THREE.Color(0x05030c) },
    },
    vertexShader: SKY_VERTEX_SHADER,
    fragmentShader: SKY_FRAGMENT_SHADER,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
  });
  const sky = new THREE.Mesh(geometry, material);
  sky.renderOrder = -1000;
  return sky;
}

/** Scatters points across the upper hemisphere only (stars never appear below the horizon). */
function buildStars(): THREE.Points {
  const positions = new Float32Array(STAR_COUNT * 3);
  for (let i = 0; i < STAR_COUNT; i++) {
    const theta = Math.random() * Math.PI * 2;
    // Bias toward the zenith a little so stars don't crowd the horizon band.
    const phi = Math.acos(Math.random()); // [0, PI/2), 0 = straight up
    const x = Math.sin(phi) * Math.cos(theta);
    const y = Math.cos(phi);
    const z = Math.sin(phi) * Math.sin(theta);
    positions[i * 3] = x * STAR_FIELD_RADIUS;
    positions[i * 3 + 1] = y * STAR_FIELD_RADIUS;
    positions[i * 3 + 2] = z * STAR_FIELD_RADIUS;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));

  const material = new THREE.PointsMaterial({
    color: 0xffffff,
    size: 1.4,
    sizeAttenuation: false,
    transparent: true,
    opacity: 1,
    depthWrite: false,
    fog: false,
  });

  return new THREE.Points(geometry, material);
}

/**
 * Owns every atmosphere-driven scene object: the procedural sky dome, the
 * star field, and the ambient/moon lights. `update(dt)` advances a slowly
 * ticking, pausable `timeOfDay` clock and pushes `interpolateAtmosphere()`'s
 * output onto all of them plus `scene.fog`. `PostFX.setBloomStrength` is
 * wired in externally via `onBloomStrengthChange` so this module doesn't
 * need to know about postprocessing.
 */
export class Atmosphere {
  readonly sky: THREE.Mesh;
  readonly stars: THREE.Points;
  readonly hemiLight: THREE.HemisphereLight;
  readonly moonLight: THREE.DirectionalLight;

  private readonly skyHorizonColor: THREE.Color;
  private readonly skyZenithColor: THREE.Color;
  private readonly starsMaterial: THREE.PointsMaterial;
  private readonly fog: THREE.FogExp2;

  private timeOfDay = DEFAULT_TIME_OF_DAY;
  private paused = false;
  private bloomStrengthListener: ((strength: number) => void) | null = null;

  constructor(private readonly scene: THREE.Scene) {
    this.sky = buildSky();
    this.stars = buildStars();
    this.hemiLight = new THREE.HemisphereLight(0x8a7fd6, 0x120a1a, 0.25);
    this.moonLight = new THREE.DirectionalLight(0x9fb0ff, 0.15);
    this.moonLight.position.set(80, 140, 60);

    const skyMaterial = this.sky.material as THREE.ShaderMaterial;
    this.skyHorizonColor = skyMaterial.uniforms.uHorizonColor?.value as THREE.Color;
    this.skyZenithColor = skyMaterial.uniforms.uZenithColor?.value as THREE.Color;
    this.starsMaterial = this.stars.material as THREE.PointsMaterial;

    scene.add(this.sky, this.stars, this.hemiLight, this.moonLight);
    this.fog = new THREE.FogExp2(0x0b0716, 0.012);
    scene.fog = this.fog;

    this.applyTimeOfDay();
  }

  /** Notified with the day/night-interpolated bloom strength every time it changes. */
  onBloomStrengthChange(listener: (strength: number) => void): void {
    this.bloomStrengthListener = listener;
    listener(interpolateAtmosphere(this.timeOfDay).bloomStrength);
  }

  get currentTimeOfDay(): number {
    return this.timeOfDay;
  }

  setTimeOfDay(t: number): void {
    this.timeOfDay = ((t % 1) + 1) % 1;
    this.applyTimeOfDay();
  }

  get isPaused(): boolean {
    return this.paused;
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
  }

  togglePaused(): void {
    this.setPaused(!this.paused);
  }

  update(dt: number): void {
    if (!this.paused) {
      this.setTimeOfDay(this.timeOfDay + dt / CYCLE_DURATION_SECONDS);
    }
  }

  private applyTimeOfDay(): void {
    const params = interpolateAtmosphere(this.timeOfDay);

    this.skyHorizonColor.setHex(params.skyHorizonColor);
    this.skyZenithColor.setHex(params.skyZenithColor);

    // Fog is synced to the sky horizon color by design (see `dayNight.ts`),
    // not an independent preset.
    this.fog.color.setHex(params.skyHorizonColor);
    this.fog.density = params.fogDensity;

    this.hemiLight.color.setHex(params.hemiSkyColor);
    this.hemiLight.groundColor.setHex(params.hemiGroundColor);
    this.hemiLight.intensity = params.hemiIntensity;

    this.moonLight.color.setHex(params.moonColor);
    this.moonLight.intensity = params.moonIntensity;

    this.starsMaterial.opacity = params.starOpacity;
    this.stars.visible = params.starOpacity > 0.01;

    this.bloomStrengthListener?.(params.bloomStrength);
  }

  /**
   * Fraction of "night" in [0, 1], for anything outside this module that
   * also fades with darkness (e.g. `Rain`'s streak opacity). Star opacity
   * is already exactly this curve (1 at full night, 0 at full day), so it
   * doubles as the night factor rather than recomputing it separately.
   */
  get nightFactor(): number {
    return interpolateAtmosphere(this.timeOfDay).starOpacity;
  }

  /**
   * Removes every object this instance added to the scene and disposes
   * their GPU resources (geometry/material). Mirrors `EnvironmentProbe.
   * dispose` / `PostFX.dispose`. Phase-2 teardown hook: main.ts never tears
   * the app down today (single page, lives for the whole session), so
   * nothing calls this yet — it exists so a future teardown path (e.g.
   * hot-swapping scenes) doesn't have to retrofit disposal here.
   */
  dispose(): void {
    this.scene.remove(this.sky, this.stars, this.hemiLight, this.moonLight);
    this.sky.geometry.dispose();
    (this.sky.material as THREE.ShaderMaterial).dispose();
    this.stars.geometry.dispose();
    this.starsMaterial.dispose();
  }
}
