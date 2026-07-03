import * as THREE from 'three';
import { neonChannelIntensity } from './neon';

/** Shared material for all non-emissive (solid) chunk geometry. */
export const solidMaterial = new THREE.MeshLambertMaterial({ vertexColors: true });

/**
 * Shared material for road-surface geometry (ASPHALT), kept separate from
 * `solidMaterial` so it alone can carry a wet-look PBR envMap (see
 * `EnvironmentProbe`) without affecting every other solid voxel. Physically
 * based so the CubeCamera-sourced envMap actually shows up as a reflective
 * sheen; roughness/metalness tuned for a wet asphalt look.
 */
export const roadMaterial = new THREE.MeshStandardMaterial({
  vertexColors: true,
  roughness: 0.18,
  metalness: 0.85,
  envMapIntensity: 1.4,
});

/**
 * Shared material for steady (non-flicker-animated) emissive blocks, e.g.
 * WINDOW_LIT. Kept separate from the 4 neon channel materials below so M5's
 * per-channel flicker/pulse/blink animation never touches lit windows.
 */
export const windowLitMaterial = new THREE.MeshBasicMaterial({
  vertexColors: true,
  toneMapped: false,
});

/**
 * Shared materials for the 4 neon flicker channels. Unlit + untonemapped so
 * they always read as bright/bloom-ready regardless of scene lighting.
 */
export const neonMaterials: readonly [
  THREE.MeshBasicMaterial,
  THREE.MeshBasicMaterial,
  THREE.MeshBasicMaterial,
  THREE.MeshBasicMaterial,
] = [
  new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false }),
  new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false }),
  new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false }),
  new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false }),
];

/**
 * HDR headroom multiplier applied on top of each channel's [0, 1] brightness
 * curve. Neon vertex colors are saturated hues (e.g. NEON_PINK, NEON_PURPLE)
 * whose luminance sits well under UnrealBloomPass's 0.85 threshold even at
 * full baked brightness -- a highly saturated color can have high individual
 * channel values but low overall luminance. Boosting the *material* color
 * (which Three.js multiplies against the baked vertex color) past 1.0 pushes
 * every channel's "on" state past the bloom threshold regardless of hue,
 * while a channel's "off"/dim state (flicker dropout, blink-off) stays
 * comfortably under it -- so bloom still reads as on/off, not a constant haze.
 */
const NEON_HDR_BOOST = 2.5;

/**
 * Modulates each neon channel material's `.color` by its per-channel
 * brightness curve (steady / slow pulse / occasional flicker / fast blink).
 * Three.js multiplies a MeshBasicMaterial's `.color` against interpolated
 * vertex colors, so this is 4 uniform-sized updates animating every neon
 * voxel in the scene, however many chunks they're spread across.
 */
export function updateNeon(time: number): void {
  for (let channel = 0; channel < neonMaterials.length; channel++) {
    const material = neonMaterials[channel] as THREE.MeshBasicMaterial;
    const intensity = neonChannelIntensity(channel as 0 | 1 | 2 | 3, time);
    material.color.setScalar(intensity * NEON_HDR_BOOST);
  }
}
