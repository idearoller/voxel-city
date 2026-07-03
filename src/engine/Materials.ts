import * as THREE from 'three';

/** Shared material for all non-emissive (solid) chunk geometry. */
export const solidMaterial = new THREE.MeshLambertMaterial({ vertexColors: true });

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
