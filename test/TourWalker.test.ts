import { describe, expect, it } from 'vitest';
import { buildNavGrid, isSidewalkCell, type NavGrid } from '../src/entities/NavGrid';
import { createRng } from '../src/gen/rng';
import {
  createTourWalker,
  findNearestWalkableGroundCell,
  pickRandomWalkableGroundCell,
  stepTourWalker,
  TOUR_WALK_SPEED,
} from '../src/player/TourWalker';
import { CONCRETE, SIDEWALK } from '../src/world/BlockRegistry';
import { World } from '../src/world/World';

const GROUND_Y = 1;
const WIDTH = 20;
const DEPTH = 20;

function buildGridWithSidewalkCells(cells: [number, number][]): NavGrid {
  const world = new World();
  for (const [x, z] of cells) {
    world.setBlock(x, 0, z, CONCRETE);
    world.setBlock(x, GROUND_Y, z, SIDEWALK);
  }
  return buildNavGrid(world, WIDTH, DEPTH, GROUND_Y);
}

describe('findNearestWalkableGroundCell', () => {
  it('finds the cell itself when the given position is already walkable', () => {
    const grid = buildGridWithSidewalkCells([[5, 5]]);
    expect(findNearestWalkableGroundCell(grid, 5.3, 5.7)).toEqual({ x: 5, z: 5 });
  });

  it('finds the closest walkable cell by expanding rings when the exact position is not walkable', () => {
    // Walkable only at (10, 10); searching from (7, 10) should expand outward
    // and land on it rather than some farther cell.
    const grid = buildGridWithSidewalkCells([[10, 10]]);
    expect(findNearestWalkableGroundCell(grid, 7, 10)).toEqual({ x: 10, z: 10 });
  });

  it('prefers the nearer of two candidate cells', () => {
    const grid = buildGridWithSidewalkCells([
      [3, 3],
      [15, 15],
    ]);
    expect(findNearestWalkableGroundCell(grid, 4, 4)).toEqual({ x: 3, z: 3 });
  });

  it('returns null when nothing walkable exists on the grid at all', () => {
    const grid = buildGridWithSidewalkCells([]);
    expect(findNearestWalkableGroundCell(grid, 5, 5)).toBeNull();
  });
});

describe('pickRandomWalkableGroundCell', () => {
  it('always returns a walkable cell when one exists', () => {
    const grid = buildGridWithSidewalkCells([
      [2, 2],
      [7, 9],
      [15, 3],
    ]);
    const rng = createRng('tour-random-cell');
    for (let i = 0; i < 20; i++) {
      const cell = pickRandomWalkableGroundCell(grid, rng);
      expect(cell).not.toBeNull();
      expect(isSidewalkCell(grid, (cell as { x: number; z: number }).x, (cell as { x: number; z: number }).z)).toBe(true);
    }
  });

  it('returns null when the grid has no walkable ground at all', () => {
    const grid = buildGridWithSidewalkCells([]);
    const rng = createRng('tour-random-cell-empty');
    expect(pickRandomWalkableGroundCell(grid, rng)).toBeNull();
  });
});

describe('stepTourWalker', () => {
  it('walks the sidewalk network exactly like an ordinary pedestrian, never leaving walkable cells', () => {
    const cells: [number, number][] = [];
    for (let x = 0; x < 15; x++) cells.push([x, 5]);
    const grid = buildGridWithSidewalkCells(cells);

    const walker = createTourWalker(2, 5, GROUND_Y, TOUR_WALK_SPEED);
    const rng = createRng('tour-walk-straight');
    for (let i = 0; i < 900; i++) {
      stepTourWalker(walker, 1 / 60, grid, rng);
      expect(isSidewalkCell(grid, walker.cellX, walker.cellZ)).toBe(true);
    }
  });

  it('captures a render-interpolation previous state distinct from a mid-stride current position', () => {
    const cells: [number, number][] = [];
    for (let x = 0; x < 10; x++) cells.push([x, 5]);
    const grid = buildGridWithSidewalkCells(cells);

    const walker = createTourWalker(2, 5, GROUND_Y, TOUR_WALK_SPEED);
    const rng = createRng('tour-walk-interp');
    // A freshly-spawned walker starts exactly centered on its cell, so its
    // first tick only picks a heading (see `stepPedestrian`'s "already at
    // cell center" branch) without moving -- the second tick is the one
    // that actually walks toward the newly-chosen target cell.
    stepTourWalker(walker, 1 / 60, grid, rng);
    stepTourWalker(walker, 1 / 60, grid, rng);

    expect(walker.x).not.toBe(walker.prevX);
  });

  it('dies once stranded on an isolated cell with nowhere to go, same as stepPedestrian', () => {
    const grid = buildGridWithSidewalkCells([[5, 5]]);
    const walker = createTourWalker(5, 5, GROUND_Y, TOUR_WALK_SPEED);
    const rng = createRng('tour-walk-isolated');

    stepTourWalker(walker, 1 / 60, grid, rng);

    expect(walker.alive).toBe(false);
  });
});
