import { describe, expect, it } from 'vitest';
import { District } from '../src/gen/districts';
import type { CityBlock } from '../src/gen/layout';
import { planPark, writePark } from '../src/gen/parks';
import { createRng } from '../src/gen/rng';
import { GRAVEL, PARK_GRASS, TREE_LEAF, TREE_TRUNK } from '../src/world/BlockRegistry';
import { World } from '../src/world/World';

function parkBlock(overrides: Partial<CityBlock> = {}): CityBlock {
  return { x: 100, z: 100, width: 24, depth: 24, parcels: [], district: District.PARK, ...overrides };
}

describe('planPark paths', () => {
  it('reaches all four block edges (so it always connects to the surrounding road)', () => {
    const block = parkBlock();
    const plan = planPark(block, createRng('park-edges'));
    const tiles = new Set(plan.pathTiles.map((t) => `${t.x},${t.z}`));

    let touchesWest = false;
    let touchesEast = false;
    let touchesNorth = false;
    let touchesSouth = false;
    for (const t of plan.pathTiles) {
      if (t.x === block.x) touchesWest = true;
      if (t.x === block.x + block.width - 1) touchesEast = true;
      if (t.z === block.z) touchesSouth = true;
      if (t.z === block.z + block.depth - 1) touchesNorth = true;
    }
    expect(touchesWest).toBe(true);
    expect(touchesEast).toBe(true);
    expect(touchesSouth).toBe(true);
    expect(touchesNorth).toBe(true);
    expect(tiles.size).toBeGreaterThan(0);
  });

  it('is deterministic for the same seed', () => {
    const block = parkBlock();
    const a = planPark(block, createRng('park-determinism'));
    const b = planPark(block, createRng('park-determinism'));
    expect(a).toEqual(b);
  });
});

describe('planPark trees', () => {
  it('never places a tree on a path tile', () => {
    const block = parkBlock();
    const plan = planPark(block, createRng('park-trees'));
    const pathSet = new Set(plan.pathTiles.map((t) => `${t.x},${t.z}`));
    for (const tree of plan.trees) {
      expect(pathSet.has(`${tree.x},${tree.z}`)).toBe(false);
    }
  });

  it('places at least one tree for a reasonably sized park', () => {
    const block = parkBlock();
    const plan = planPark(block, createRng('park-tree-count'));
    expect(plan.trees.length).toBeGreaterThan(0);
  });

  it('keeps trunk heights within [3, 5]', () => {
    const block = parkBlock();
    const plan = planPark(block, createRng('park-trunk-height'));
    for (const tree of plan.trees) {
      expect(tree.trunkHeight).toBeGreaterThanOrEqual(3);
      expect(tree.trunkHeight).toBeLessThanOrEqual(5);
    }
  });
});

describe('writePark', () => {
  const groundSurfaceY = 1;

  it('paints grass everywhere except gravel path tiles', () => {
    const block = parkBlock();
    const plan = planPark(block, createRng('park-write'));
    const world = new World();
    writePark(world, block, plan, groundSurfaceY);

    const pathSet = new Set(plan.pathTiles.map((t) => `${t.x},${t.z}`));
    for (let x = block.x; x < block.x + block.width; x++) {
      for (let z = block.z; z < block.z + block.depth; z++) {
        const expected = pathSet.has(`${x},${z}`) ? GRAVEL : PARK_GRASS;
        expect(world.getBlock(x, groundSurfaceY, z)).toBe(expected);
      }
    }
  });

  it('writes a tree as a trunk topped with leaves, standing on grass', () => {
    const block = parkBlock();
    const plan = planPark(block, createRng('park-tree-write'));
    const world = new World();
    writePark(world, block, plan, groundSurfaceY);

    expect(plan.trees.length).toBeGreaterThan(0);
    const tree = plan.trees[0]!;
    const baseY = groundSurfaceY + 1;
    expect(world.getBlock(tree.x, baseY, tree.z)).toBe(TREE_TRUNK);
    expect(world.getBlock(tree.x, baseY + tree.trunkHeight - 1, tree.z)).toBe(TREE_TRUNK);
    // Leaves surround the crown just above the trunk top.
    expect(world.getBlock(tree.x + 1, baseY + tree.trunkHeight - 1, tree.z)).toBe(TREE_LEAF);
  });
});
