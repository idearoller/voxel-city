import { describe, expect, it } from 'vitest';
import { buildNavGrid, isElevatedWalkableCell } from '../src/entities/NavGrid';
import { createPedestrianAt, stepPedestrian } from '../src/entities/Pedestrian';
import { GROUND_SURFACE_Y, generateCity } from '../src/gen/CityGenerator';
import { WALKWAY_Y } from '../src/gen/infrastructure';
import { createRng } from '../src/gen/rng';
import { METAL } from '../src/world/BlockRegistry';
import { WORLD_SIZE_X, WORLD_SIZE_Z } from '../src/world/coords';
import { World } from '../src/world/World';

const SEEDS = ['elevated-ped-1', 'elevated-ped-2', 'elevated-ped-3', 'elevated-ped-4', 'elevated-ped-5', 'elevated-ped-6'];
const TICKS = 1200; // 20s of sim time -- long enough to cross a deck end-to-end and bounce back at least once

/**
 * End-to-end proof (per this repo's review convention: nav/geometry claims
 * must hold against real generator output, not just hand-built fixtures)
 * that a pedestrian confined to a real skybridge or walkway deck stays on
 * that deck — never drifts onto the rail-blocked edge rows, never drops to
 * ground level, and every cell it occupies has an actual solid METAL floor
 * beneath it — for as long as it walks.
 */
describe('pedestrians walking real generated elevated decks', () => {
  it('stays on a real bridge deck for many ticks: never off-deck, never at ground level, always over a solid floor', () => {
    let bridgesWalked = 0;

    for (const seed of SEEDS) {
      const world = new World();
      const { bridges } = generateCity(world, seed);
      if (bridges.length === 0) continue;

      const grid = buildNavGrid(world, WORLD_SIZE_X, WORLD_SIZE_Z, GROUND_SURFACE_Y);
      const bridge = bridges[0] as (typeof bridges)[number];
      const levelIndex = grid.elevatedLevels.findIndex((level) => level.y === bridge.level);
      expect(levelIndex).toBeGreaterThanOrEqual(0);

      // The deck's own middle-lane starting cell (see NavGrid.test.ts's `bridgeMiddleLaneCells`).
      const startX = bridge.axis === 'x' ? bridge.x : bridge.x + 1;
      const startZ = bridge.axis === 'x' ? bridge.z + 1 : bridge.z;
      expect(isElevatedWalkableCell(grid, levelIndex, startX, startZ)).toBe(true);

      const ped = createPedestrianAt(startX, startZ, bridge.level, 1.4);
      const rng = createRng(`${seed}-bridge-walk`);

      for (let i = 0; i < TICKS; i++) {
        stepPedestrian(ped, 1 / 60, grid, rng);
        expect(ped.alive).toBe(true);
        expect(ped.y).toBe(bridge.level);
        expect(isElevatedWalkableCell(grid, levelIndex, ped.cellX, ped.cellZ)).toBe(true);
        expect(world.getBlock(ped.cellX, bridge.level, ped.cellZ)).toBe(METAL);
      }
      bridgesWalked++;
    }

    // Neutralize check: fails if no seed above produced a real bridge to walk.
    expect(bridgesWalked).toBeGreaterThan(0);
  });

  it('stays on a real walkway deck for many ticks: never off-deck, never at ground level, always over a solid floor', () => {
    let walkwaysWalked = 0;

    for (const seed of SEEDS) {
      const world = new World();
      const { walkways } = generateCity(world, seed);
      if (walkways.length === 0) continue;

      const grid = buildNavGrid(world, WORLD_SIZE_X, WORLD_SIZE_Z, GROUND_SURFACE_Y);
      const walkway = walkways[0] as (typeof walkways)[number];
      const levelIndex = grid.elevatedLevels.findIndex((level) => level.y === WALKWAY_Y);
      expect(levelIndex).toBeGreaterThanOrEqual(0);

      const startX = walkway.x;
      const startZ = walkway.z;
      expect(isElevatedWalkableCell(grid, levelIndex, startX, startZ)).toBe(true);

      const ped = createPedestrianAt(startX, startZ, WALKWAY_Y, 1.4);
      const rng = createRng(`${seed}-walkway-walk`);

      for (let i = 0; i < TICKS; i++) {
        stepPedestrian(ped, 1 / 60, grid, rng);
        expect(ped.alive).toBe(true);
        expect(ped.y).toBe(WALKWAY_Y);
        expect(isElevatedWalkableCell(grid, levelIndex, ped.cellX, ped.cellZ)).toBe(true);
        expect(world.getBlock(ped.cellX, WALKWAY_Y, ped.cellZ)).toBe(METAL);
      }
      walkwaysWalked++;
    }

    expect(walkwaysWalked).toBeGreaterThan(0);
  });
});
