/**
 * Pure distance-cull math for chunk meshes -- no Three.js. `ChunkRenderer`
 * applies this every frame to decide which of its meshes get `.visible =
 * true`, so that looking across the whole 384x384 city doesn't put all
 * ~274 chunk meshes (~4.9M triangles, see PERF.md) in the frustum at once.
 *
 * The cull radius is derived from, not just tuned near, `Atmosphere`'s fog:
 * Three.js's `FogExp2` shader term is
 *   fogFactor = 1 - exp(-(density * distance)^2)
 * At `density * distance = sqrt(3)`, fogFactor ~= 1 - exp(-3) ~= 0.95 -- the
 * same "visually flattened" threshold PERF.md's headroom analysis already
 * used for its (now-superseded) in-frustum triangle estimate. Solving for
 * distance at that threshold and `MIN_FOG_DENSITY` (the *thinnest* fog the
 * day/night cycle ever uses -- the case where things stay visible longest,
 * so the only one that's safe to cull against) gives `CULL_RADIUS` below.
 * Because the radius is computed from `MIN_FOG_DENSITY` rather than a
 * hardcoded number, it can't silently drift out of sync with `dayNight.ts`
 * if the fog presets ever change.
 */
import { CHUNK_SIZE } from '../world/coords';
import { MIN_FOG_DENSITY } from './dayNight';

/** density * distance at which FogExp2's fogFactor reaches ~0.95 (see module doc). */
const FOG_VISUAL_CUTOFF = Math.sqrt(3);

export const CULL_RADIUS = FOG_VISUAL_CUTOFF / MIN_FOG_DENSITY;

export interface ChunkCoord {
  cx: number;
  cy: number;
  cz: number;
}

/**
 * True if the chunk at `chunk` (a `CHUNK_SIZE`^3 world-space cube) has any
 * point within `radius` of the camera. Uses the chunk's nearest point to the
 * camera (its closest corner/face/interior point), not its center, so a
 * chunk isn't culled while a near corner of it would still be visible --
 * the difference matters most for large chunks and grazing angles.
 *
 * Allocation-free: called once per allocated chunk (~274-450) every frame.
 */
export function isChunkVisible(
  chunk: ChunkCoord,
  cameraX: number,
  cameraY: number,
  cameraZ: number,
  radius: number = CULL_RADIUS,
): boolean {
  const minX = chunk.cx * CHUNK_SIZE;
  const minY = chunk.cy * CHUNK_SIZE;
  const minZ = chunk.cz * CHUNK_SIZE;
  const maxX = minX + CHUNK_SIZE;
  const maxY = minY + CHUNK_SIZE;
  const maxZ = minZ + CHUNK_SIZE;

  // Clamped per-axis distance to the AABB: 0 if the camera's coordinate on
  // that axis already falls inside [min, max], else the gap to the nearer
  // face. At most one of the two terms in each `Math.max` is positive.
  const dx = Math.max(minX - cameraX, cameraX - maxX, 0);
  const dy = Math.max(minY - cameraY, cameraY - maxY, 0);
  const dz = Math.max(minZ - cameraZ, cameraZ - maxZ, 0);

  return dx * dx + dy * dy + dz * dz <= radius * radius;
}
