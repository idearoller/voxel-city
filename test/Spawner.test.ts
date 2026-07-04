import { describe, expect, it } from 'vitest';
import { isSidewalkCell, type NavGrid } from '../src/entities/NavGrid';
import { isBeyondDespawnRadius, pickSpawnCell } from '../src/entities/Spawner';
import { createRng } from '../src/gen/rng';

function makeGrid(width: number, depth: number, walkableCells: [number, number][]): NavGrid {
  const sidewalk = new Uint8Array(width * depth);
  for (const [x, z] of walkableCells) sidewalk[x + z * width] = 1;
  return {
    width,
    depth,
    groundY: 1,
    sidewalk,
    road: new Uint8Array(width * depth),
    flowX: new Int8Array(width * depth),
    flowZ: new Int8Array(width * depth),
  };
}

describe('pickSpawnCell', () => {
  it('only returns cells within [minRadius, maxRadius) of the player', () => {
    const width = 100;
    const depth = 100;
    const walkable: [number, number][] = [];
    for (let x = 0; x < width; x++) {
      for (let z = 0; z < depth; z++) walkable.push([x, z]);
    }
    const grid = makeGrid(width, depth, walkable);
    const rng = createRng('spawn-radius');
    const playerX = 50;
    const playerZ = 50;
    const minRadius = 20;
    const maxRadius = 40;

    for (let i = 0; i < 50; i++) {
      const result = pickSpawnCell(grid, isSidewalkCell, playerX, playerZ, minRadius, maxRadius, rng);
      expect(result).not.toBeNull();
      const dx = (result as { x: number }).x - playerX;
      const dz = (result as { z: number }).z - playerZ;
      const dist = Math.hypot(dx, dz);
      // Allow slight slack for the floor() truncation of a continuous point.
      expect(dist).toBeGreaterThanOrEqual(minRadius - 1);
      expect(dist).toBeLessThanOrEqual(maxRadius + 1);
    }
  });

  it('never returns a cell for which isWalkable is false', () => {
    const grid = makeGrid(50, 50, [[25, 25]]); // only one walkable cell in the whole grid
    const rng = createRng('spawn-single');

    const result = pickSpawnCell(grid, isSidewalkCell, 25, 25, 0, 5, rng, 200);

    if (result) {
      expect(result).toEqual({ x: 25, z: 25 });
    }
  });

  it('returns null when no attempt lands on a walkable cell', () => {
    const grid = makeGrid(50, 50, []); // nothing walkable at all
    const rng = createRng('spawn-none');

    const result = pickSpawnCell(grid, isSidewalkCell, 25, 25, 5, 20, rng, 16);

    expect(result).toBeNull();
  });
});

describe('isBeyondDespawnRadius', () => {
  it('is false for an entity within the despawn radius', () => {
    expect(isBeyondDespawnRadius(10, 10, 0, 0, 20)).toBe(false);
  });

  it('is true for an entity beyond the despawn radius', () => {
    expect(isBeyondDespawnRadius(100, 0, 0, 0, 20)).toBe(true);
  });
});
