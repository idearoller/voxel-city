import { describe, expect, it } from 'vitest';
import { buildNavGrid, isSidewalkCell, type NavGrid } from '../src/entities/NavGrid';
import { createPedestrianAt, stepPedestrian } from '../src/entities/Pedestrian';
import { CONCRETE, SIDEWALK } from '../src/world/BlockRegistry';
import { createRng } from '../src/gen/rng';
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

/** Runs stepPedestrian enough ticks to guarantee it has crossed several cells. */
function walk(ped: ReturnType<typeof createPedestrianAt>, grid: NavGrid, rng: ReturnType<typeof createRng>, ticks: number): void {
  const dt = 1 / 60;
  for (let i = 0; i < ticks; i++) stepPedestrian(ped, dt, grid, rng);
}

describe('stepPedestrian', () => {
  it('stays on sidewalk cells while walking a straight corridor', () => {
    const cells: [number, number][] = [];
    for (let x = 0; x < 15; x++) cells.push([x, 5]);
    const grid = buildGridWithSidewalkCells(cells);

    const ped = createPedestrianAt(2, 5, 1.4);
    const rng = createRng('ped-straight');
    walk(ped, grid, rng, 600); // 10s of sim time, ~14m at 1.4 m/s -- crosses the whole corridor

    expect(isSidewalkCell(grid, ped.cellX, ped.cellZ)).toBe(true);
  });

  it('never chooses a non-sidewalk neighbor as its next cell', () => {
    // An L-shaped corridor: straight along x, then a 90-degree turn along z.
    const cells: [number, number][] = [];
    for (let x = 0; x < 10; x++) cells.push([x, 5]);
    for (let z = 5; z < 10; z++) cells.push([9, z]);
    const grid = buildGridWithSidewalkCells(cells);

    const ped = createPedestrianAt(1, 5, 1.4);
    const rng = createRng('ped-corner');
    for (let i = 0; i < 900; i++) {
      stepPedestrian(ped, 1 / 60, grid, rng);
      expect(isSidewalkCell(grid, ped.cellX, ped.cellZ)).toBe(true);
    }
  });

  it('reverses direction at a dead end instead of leaving the sidewalk', () => {
    // A short 3-cell dead-end corridor: (0,5) - (1,5) - (2,5).
    const grid = buildGridWithSidewalkCells([
      [0, 5],
      [1, 5],
      [2, 5],
    ]);

    const ped = createPedestrianAt(0, 5, 1.4);
    const rng = createRng('ped-deadend');

    // Long enough to reach the far end and bounce back at least once.
    for (let i = 0; i < 1200; i++) {
      stepPedestrian(ped, 1 / 60, grid, rng);
      expect(ped.cellX).toBeGreaterThanOrEqual(0);
      expect(ped.cellX).toBeLessThanOrEqual(2);
      expect(ped.cellZ).toBe(5);
      expect(isSidewalkCell(grid, ped.cellX, ped.cellZ)).toBe(true);
    }
  });

  it('marks an isolated sidewalk cell pedestrian as not alive once it has nowhere to go', () => {
    const grid = buildGridWithSidewalkCells([[5, 5]]);
    const ped = createPedestrianAt(5, 5, 1.4);
    const rng = createRng('ped-isolated');

    stepPedestrian(ped, 1 / 60, grid, rng); // arrives immediately (already at cell center) -> chooseNextCell finds no candidates

    expect(ped.alive).toBe(false);
  });
});
