import { describe, expect, it } from 'vitest';
import { buildNavGrid, isRoadCell, type NavGrid } from '../src/entities/NavGrid';
import { createVehicleAt, stepVehicle } from '../src/entities/Vehicle';
import { ASPHALT, CONCRETE } from '../src/world/BlockRegistry';
import { World } from '../src/world/World';

const GROUND_Y = 1;
const WIDTH = 20;
const DEPTH = 20;

/** A 4-wide east-west road band (z = 5..8) spanning the full x range, two opposite-direction lanes. */
function buildEastWestRoadGrid(): NavGrid {
  const world = new World();
  for (let x = 0; x < WIDTH; x++) {
    for (let z = 5; z < 9; z++) {
      world.setBlock(x, 0, z, CONCRETE);
      world.setBlock(x, GROUND_Y, z, ASPHALT);
    }
  }
  return buildNavGrid(world, WIDTH, DEPTH, GROUND_Y);
}

function drive(vehicle: ReturnType<typeof createVehicleAt>, grid: NavGrid, ticks: number): void {
  const dt = 1 / 60;
  for (let i = 0; i < ticks; i++) stepVehicle(vehicle, dt, grid);
}

describe('stepVehicle', () => {
  it('stays on road cells and respects its lane direction along a straight corridor', () => {
    const grid = buildEastWestRoadGrid();
    // z=5 is the "near half" lane, which computeFlowField assigns +x.
    const vehicle = createVehicleAt(2, 5, 8);

    let lastCellX = vehicle.cellX;
    for (let i = 0; i < 300; i++) {
      stepVehicle(vehicle, 1 / 60, grid);
      expect(isRoadCell(grid, vehicle.cellX, vehicle.cellZ)).toBe(true);
      expect(vehicle.cellZ).toBe(5); // never drifts into the opposite lane
      expect(vehicle.cellX).toBeGreaterThanOrEqual(lastCellX);
      lastCellX = vehicle.cellX;
    }
    expect(vehicle.dirX).toBe(1);
    expect(vehicle.dirZ).toBe(0);
  });

  it('drives the opposite lane in the opposite direction', () => {
    const grid = buildEastWestRoadGrid();
    // z=8 is the "far half" lane, assigned -x.
    const vehicle = createVehicleAt(15, 8, 8);

    drive(vehicle, grid, 60);

    expect(vehicle.dirX).toBe(-1);
    expect(vehicle.cellX).toBeLessThan(15);
  });

  it('despawns gracefully upon reaching the map edge instead of driving off it', () => {
    const grid = buildEastWestRoadGrid();
    const vehicle = createVehicleAt(WIDTH - 2, 5, 8); // heading +x, near the edge

    drive(vehicle, grid, 300);

    expect(vehicle.alive).toBe(false);
    expect(vehicle.cellX).toBeLessThan(WIDTH); // never advanced onto/past an out-of-bounds cell
  });

  it('never enters a cell that is not part of the road network', () => {
    const grid = buildEastWestRoadGrid();
    const vehicle = createVehicleAt(2, 5, 8);

    for (let i = 0; i < 200; i++) {
      stepVehicle(vehicle, 1 / 60, grid);
      if (!vehicle.alive) break;
      expect(isRoadCell(grid, vehicle.cellX, vehicle.cellZ)).toBe(true);
    }
  });
});
