import { describe, expect, it } from 'vitest';
import { raycastVoxels } from '../src/player/VoxelRaycast';

/** Builds an isSolid predicate from a plain set of "x,y,z" coordinate strings. */
function solidSetOf(coords: ReadonlyArray<readonly [number, number, number]>) {
  const set = new Set(coords.map(([x, y, z]) => `${x},${y},${z}`));
  return (x: number, y: number, z: number): boolean => set.has(`${x},${y},${z}`);
}

describe('raycastVoxels', () => {
  it('hits a voxel directly ahead along +x with a -x normal', () => {
    const isSolid = solidSetOf([[5, 0, 0]]);
    const hit = raycastVoxels({
      origin: [0.5, 0.5, 0.5],
      direction: [1, 0, 0],
      maxDistance: 60,
      isSolid,
    });
    expect(hit).toEqual({ pos: [5, 0, 0], normal: [-1, 0, 0] });
  });

  it('hits a voxel along -y with a +y normal (looking down at a floor)', () => {
    const isSolid = solidSetOf([[0, -3, 0]]);
    const hit = raycastVoxels({
      origin: [0.5, 0.5, 0.5],
      direction: [0, -1, 0],
      maxDistance: 60,
      isSolid,
    });
    expect(hit).toEqual({ pos: [0, -3, 0], normal: [0, 1, 0] });
  });

  it('returns null when nothing is hit within maxDistance', () => {
    const isSolid = solidSetOf([[100, 0, 0]]);
    const hit = raycastVoxels({
      origin: [0.5, 0.5, 0.5],
      direction: [1, 0, 0],
      maxDistance: 8,
      isSolid,
    });
    expect(hit).toBeNull();
  });

  it('returns null for an all-air world', () => {
    const isSolid = () => false;
    const hit = raycastVoxels({
      origin: [0, 0, 0],
      direction: [1, 1, 1],
      maxDistance: 60,
      isSolid,
    });
    expect(hit).toBeNull();
  });

  it('handles a diagonal ray hitting the nearer of two candidate axes correctly', () => {
    // A 45-degree ray in the XZ plane should walk voxel-by-voxel along the
    // diagonal, hitting (3,0,3) rather than skipping past it.
    const isSolid = solidSetOf([[3, 0, 3]]);
    const hit = raycastVoxels({
      origin: [0.5, 0.5, 0.5],
      direction: [1, 0, 1],
      maxDistance: 60,
      isSolid,
    });
    expect(hit).not.toBeNull();
    expect(hit?.pos).toEqual([3, 0, 3]);
  });

  it('works with negative-coordinate origins and targets', () => {
    const isSolid = solidSetOf([[-5, -2, -3]]);
    const hit = raycastVoxels({
      origin: [-0.5, -0.5, -0.5],
      direction: [-1, -0.3, -0.5],
      maxDistance: 60,
      isSolid,
    });
    expect(hit).not.toBeNull();
    expect(hit?.pos).toEqual([-5, -2, -3]);
  });

  it('reports a hit immediately when the origin starts inside a solid voxel', () => {
    const isSolid = solidSetOf([[2, 2, 2]]);
    const hit = raycastVoxels({
      origin: [2.5, 2.5, 2.5],
      direction: [1, 0, 0],
      maxDistance: 60,
      isSolid,
    });
    expect(hit).toEqual({ pos: [2, 2, 2], normal: [0, 0, 0] });
  });

  it('handles an origin exactly on an integer grid boundary', () => {
    // Origin sits exactly at x=5.0 (the boundary between voxel 4 and voxel
    // 5). floor(5.0) = 5, so the ray should start inside voxel (5, 0, 0).
    const isSolid = solidSetOf([[8, 0, 0]]);
    const hit = raycastVoxels({
      origin: [5, 0.5, 0.5],
      direction: [1, 0, 0],
      maxDistance: 60,
      isSolid,
    });
    expect(hit).toEqual({ pos: [8, 0, 0], normal: [-1, 0, 0] });
  });

  it('returns null for a zero-length direction vector instead of throwing', () => {
    const isSolid = solidSetOf([[0, 0, 0]]);
    const hit = raycastVoxels({
      origin: [5, 5, 5],
      direction: [0, 0, 0],
      maxDistance: 60,
      isSolid,
    });
    expect(hit).toBeNull();
  });

  it('respects a short reach (play-mode 8 voxel distance) vs long reach (sandbox 60)', () => {
    const isSolid = solidSetOf([[10, 0, 0]]);
    const short = raycastVoxels({
      origin: [0.5, 0.5, 0.5],
      direction: [1, 0, 0],
      maxDistance: 8,
      isSolid,
    });
    const long = raycastVoxels({
      origin: [0.5, 0.5, 0.5],
      direction: [1, 0, 0],
      maxDistance: 60,
      isSolid,
    });
    expect(short).toBeNull();
    expect(long).toEqual({ pos: [10, 0, 0], normal: [-1, 0, 0] });
  });
});
