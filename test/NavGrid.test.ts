import { describe, expect, it } from 'vitest';
import { buildNavGrid, isRoadCell, isSidewalkCell } from '../src/entities/NavGrid';
import { ASPHALT, CONCRETE, SIDEWALK } from '../src/world/BlockRegistry';
import { World } from '../src/world/World';

const GROUND_Y = 1;
const WIDTH = 20;
const DEPTH = 20;

/** Paints a flat CONCRETE slab at y=0 with `surface` at y=GROUND_Y across the whole test footprint, leaving y=GROUND_Y+1 as AIR (default). */
function paintFloor(world: World, surface: number): void {
  for (let x = 0; x < WIDTH; x++) {
    for (let z = 0; z < DEPTH; z++) {
      world.setBlock(x, 0, z, CONCRETE);
      world.setBlock(x, GROUND_Y, z, surface);
    }
  }
}

describe('buildNavGrid', () => {
  it('marks SIDEWALK-surfaced, clear-above cells as walkable', () => {
    const world = new World();
    paintFloor(world, SIDEWALK);

    const grid = buildNavGrid(world, WIDTH, DEPTH, GROUND_Y);

    expect(isSidewalkCell(grid, 5, 5)).toBe(true);
    expect(isRoadCell(grid, 5, 5)).toBe(false);
  });

  it('marks ASPHALT-surfaced, clear-above cells as drivable', () => {
    const world = new World();
    paintFloor(world, ASPHALT);

    const grid = buildNavGrid(world, WIDTH, DEPTH, GROUND_Y);

    expect(isRoadCell(grid, 5, 5)).toBe(true);
    expect(isSidewalkCell(grid, 5, 5)).toBe(false);
  });

  it('excludes a surfaced cell that has no headroom clearance', () => {
    const world = new World();
    paintFloor(world, SIDEWALK);
    world.setBlock(5, GROUND_Y + 1, 5, CONCRETE); // a wall grew into this column

    const grid = buildNavGrid(world, WIDTH, DEPTH, GROUND_Y);

    expect(isSidewalkCell(grid, 5, 5)).toBe(false);
  });

  it('treats out-of-bounds coordinates as neither walkable nor drivable', () => {
    const world = new World();
    paintFloor(world, SIDEWALK);

    const grid = buildNavGrid(world, WIDTH, DEPTH, GROUND_Y);

    expect(isSidewalkCell(grid, -1, 0)).toBe(false);
    expect(isSidewalkCell(grid, WIDTH, 0)).toBe(false);
  });

  it('splits a 4-wide east-west road band into two opposite-direction lanes', () => {
    const world = new World();
    // A 4-wide road band running along x, spanning z = 5..8.
    for (let x = 0; x < WIDTH; x++) {
      world.setBlock(x, 0, 5, CONCRETE);
      for (let z = 5; z < 9; z++) {
        world.setBlock(x, 0, z, CONCRETE);
        world.setBlock(x, GROUND_Y, z, ASPHALT);
      }
    }

    const grid = buildNavGrid(world, WIDTH, DEPTH, GROUND_Y);

    // Near half of the band (z=5,6) travels +x; far half (z=7,8) travels -x.
    const midX = 10;
    expect(grid.flowX[midX + 5 * WIDTH]).toBe(1);
    expect(grid.flowZ[midX + 5 * WIDTH]).toBe(0);
    expect(grid.flowX[midX + 6 * WIDTH]).toBe(1);
    expect(grid.flowX[midX + 7 * WIDTH]).toBe(-1);
    expect(grid.flowX[midX + 8 * WIDTH]).toBe(-1);
  });

  it('assigns a north-south corridor a flowZ instead of flowX', () => {
    const world = new World();
    // A 4-wide road band running along z, spanning x = 5..8.
    for (let z = 0; z < DEPTH; z++) {
      for (let x = 5; x < 9; x++) {
        world.setBlock(x, 0, z, CONCRETE);
        world.setBlock(x, GROUND_Y, z, ASPHALT);
      }
    }

    const grid = buildNavGrid(world, WIDTH, DEPTH, GROUND_Y);

    const midZ = 10;
    expect(grid.flowZ[5 + midZ * WIDTH]).toBe(1);
    expect(grid.flowX[5 + midZ * WIDTH]).toBe(0);
    expect(grid.flowZ[8 + midZ * WIDTH]).toBe(-1);
  });
});
