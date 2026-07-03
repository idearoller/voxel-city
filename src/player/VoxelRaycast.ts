/**
 * Voxel raycasting via the Amanatides & Woo DDA algorithm. Pure world-data-in,
 * result-out — no Three.js types, so this is unit-testable without a renderer
 * and reusable for both sandbox and play-mode block targeting.
 */

export interface RayHit {
  /** World voxel coordinate of the hit block. */
  pos: readonly [number, number, number];
  /** Face normal the ray entered through, one axis unit vector. */
  normal: readonly [number, number, number];
}

export interface VoxelRaycastQuery {
  origin: readonly [number, number, number];
  direction: readonly [number, number, number];
  maxDistance: number;
  /** Returns true if the given voxel coordinate should stop the ray. */
  isSolid: (x: number, y: number, z: number) => boolean;
}

function sign(n: number): number {
  if (n > 0) return 1;
  if (n < 0) return -1;
  return 0;
}

/**
 * Steps a ray through the voxel grid one cell at a time, always advancing
 * along whichever axis reaches its next grid line soonest. Returns the first
 * solid voxel hit (per `isSolid`) within `maxDistance`, plus the axis-aligned
 * face normal the ray crossed to enter it, or null if nothing was hit.
 */
export function raycastVoxels(query: VoxelRaycastQuery): RayHit | null {
  const { origin, direction, maxDistance, isSolid } = query;

  const dirLength = Math.hypot(direction[0], direction[1], direction[2]);
  if (dirLength === 0) return null;
  const dx = direction[0] / dirLength;
  const dy = direction[1] / dirLength;
  const dz = direction[2] / dirLength;

  let x = Math.floor(origin[0]);
  let y = Math.floor(origin[1]);
  let z = Math.floor(origin[2]);

  const stepX = sign(dx);
  const stepY = sign(dy);
  const stepZ = sign(dz);

  // Distance along the ray to cross one full voxel, per axis.
  const tDeltaX = dx !== 0 ? Math.abs(1 / dx) : Infinity;
  const tDeltaY = dy !== 0 ? Math.abs(1 / dy) : Infinity;
  const tDeltaZ = dz !== 0 ? Math.abs(1 / dz) : Infinity;

  // Distance along the ray to the first grid line crossing, per axis.
  const nextBoundary = (originCoord: number, cell: number, step: number): number => {
    if (step > 0) return cell + 1 - originCoord;
    if (step < 0) return originCoord - cell;
    return Infinity;
  };

  let tMaxX = stepX !== 0 ? nextBoundary(origin[0], x, stepX) * tDeltaX : Infinity;
  let tMaxY = stepY !== 0 ? nextBoundary(origin[1], y, stepY) * tDeltaY : Infinity;
  let tMaxZ = stepZ !== 0 ? nextBoundary(origin[2], z, stepZ) * tDeltaZ : Infinity;

  let normal: readonly [number, number, number] = [0, 0, 0];

  if (isSolid(x, y, z)) {
    return { pos: [x, y, z], normal: [0, 0, 0] };
  }

  let traveled = 0;
  while (traveled <= maxDistance) {
    if (tMaxX < tMaxY && tMaxX < tMaxZ) {
      x += stepX;
      traveled = tMaxX;
      tMaxX += tDeltaX;
      normal = [-stepX, 0, 0];
    } else if (tMaxY < tMaxZ) {
      y += stepY;
      traveled = tMaxY;
      tMaxY += tDeltaY;
      normal = [0, -stepY, 0];
    } else {
      z += stepZ;
      traveled = tMaxZ;
      tMaxZ += tDeltaZ;
      normal = [0, 0, -stepZ];
    }

    if (traveled > maxDistance) break;

    if (isSolid(x, y, z)) {
      return { pos: [x, y, z], normal };
    }
  }

  return null;
}
