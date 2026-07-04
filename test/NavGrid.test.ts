import { describe, expect, it } from 'vitest';
import { buildNavGrid, isElevatedWalkableCell, isRoadCell, isSidewalkCell } from '../src/entities/NavGrid';
import { GROUND_SURFACE_Y, generateCity } from '../src/gen/CityGenerator';
import { WALKWAY_Y, type Bridge, type Walkway } from '../src/gen/infrastructure';
import { ASPHALT, CONCRETE, GRAVEL, SIDEWALK } from '../src/world/BlockRegistry';
import { WORLD_SIZE_X, WORLD_SIZE_Z } from '../src/world/coords';
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

  it('marks GRAVEL-surfaced (park path), clear-above cells as walkable sidewalk', () => {
    const world = new World();
    paintFloor(world, GRAVEL);

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

// ---------------------------------------------------------------------------
// Elevated levels, derived from real generator output. `buildNavGrid` scans
// known deck rows (`WALKWAY_Y`, `SKY_LEVELS`) for METAL-with-clearance cells
// rather than trusting `GenerationResult`'s `bridges`/`walkways` plans (see
// this file's own doc comment for why: a `.vxc` import has no such plan) --
// these tests are the oracle check that the voxel-scan finds exactly the
// real bridges/walkways `generateCity` actually wrote, per this repo's
// review convention of proving nav/geometry claims against real generator
// output rather than hand-built fixtures alone.
// ---------------------------------------------------------------------------

/** Middle-lane cells only: the 1-wide walkable strip of a 3-wide bridge deck, excluding its two rail-blocked edge rows/columns. */
function bridgeMiddleLaneCells(bridge: Bridge): Array<{ x: number; z: number }> {
  const cells: Array<{ x: number; z: number }> = [];
  if (bridge.axis === 'x') {
    const midZ = bridge.z + 1;
    for (let x = bridge.x; x < bridge.x + bridge.width; x++) cells.push({ x, z: midZ });
  } else {
    const midX = bridge.x + 1;
    for (let z = bridge.z; z < bridge.z + bridge.depth; z++) cells.push({ x: midX, z });
  }
  return cells;
}

/** The two rail-blocked edge rows/columns of a 3-wide bridge deck -- never walkable. */
function bridgeRailEdgeCells(bridge: Bridge): Array<{ x: number; z: number }> {
  const cells: Array<{ x: number; z: number }> = [];
  if (bridge.axis === 'x') {
    for (const railZ of [bridge.z, bridge.z + bridge.depth - 1]) {
      for (let x = bridge.x; x < bridge.x + bridge.width; x++) cells.push({ x, z: railZ });
    }
  } else {
    for (const railX of [bridge.x, bridge.x + bridge.width - 1]) {
      for (let z = bridge.z; z < bridge.z + bridge.depth; z++) cells.push({ x: railX, z });
    }
  }
  return cells;
}

function walkwayFootprintCells(walkway: Walkway): Array<{ x: number; z: number }> {
  const cells: Array<{ x: number; z: number }> = [];
  for (let dx = 0; dx < walkway.width; dx++) {
    for (let dz = 0; dz < walkway.depth; dz++) cells.push({ x: walkway.x + dx, z: walkway.z + dz });
  }
  return cells;
}

/** A bridge's *entire* 3-wide deck rectangle, rail rows/columns included (unlike `bridgeMiddleLaneCells`) -- the full footprint `writeBridge` paints METAL across. */
function bridgeFullFootprintCells(bridge: Bridge): Array<{ x: number; z: number }> {
  const cells: Array<{ x: number; z: number }> = [];
  for (let dx = 0; dx < bridge.width; dx++) {
    for (let dz = 0; dz < bridge.depth; dz++) cells.push({ x: bridge.x + dx, z: bridge.z + dz });
  }
  return cells;
}

describe('buildNavGrid elevated levels (real generator output)', () => {
  const seeds = ['elevated-nav-1', 'elevated-nav-2', 'elevated-nav-3', 'elevated-nav-4', 'elevated-nav-5'];

  it("finds every real bridge's middle lane walkable, and its rail-blocked edges not walkable", () => {
    let bridgesChecked = 0;

    for (const seed of seeds) {
      const world = new World();
      const { bridges } = generateCity(world, seed);
      const grid = buildNavGrid(world, WORLD_SIZE_X, WORLD_SIZE_Z, GROUND_SURFACE_Y);

      for (const bridge of bridges) {
        const levelIndex = grid.elevatedLevels.findIndex((level) => level.y === bridge.level);
        expect(levelIndex).toBeGreaterThanOrEqual(0);

        for (const { x, z } of bridgeMiddleLaneCells(bridge)) {
          expect(isElevatedWalkableCell(grid, levelIndex, x, z)).toBe(true);
        }
        for (const { x, z } of bridgeRailEdgeCells(bridge)) {
          expect(isElevatedWalkableCell(grid, levelIndex, x, z)).toBe(false);
        }
        bridgesChecked++;
      }
    }

    // A neutralize check: if the elevated scan (or the seeds above) somehow
    // stopped producing any real bridges, the assertions above would all be
    // vacuously true and this suite would pass for the wrong reason.
    expect(bridgesChecked).toBeGreaterThan(0);
  });

  it("finds every real walkway's full deck footprint walkable", () => {
    let walkwaysChecked = 0;

    for (const seed of seeds) {
      const world = new World();
      const { walkways } = generateCity(world, seed);
      const grid = buildNavGrid(world, WORLD_SIZE_X, WORLD_SIZE_Z, GROUND_SURFACE_Y);

      for (const walkway of walkways) {
        const levelIndex = grid.elevatedLevels.findIndex((level) => level.y === WALKWAY_Y);
        expect(levelIndex).toBeGreaterThanOrEqual(0);

        for (const { x, z } of walkwayFootprintCells(walkway)) {
          expect(isElevatedWalkableCell(grid, levelIndex, x, z)).toBe(true);
        }
        walkwaysChecked++;
      }
    }

    expect(walkwaysChecked).toBeGreaterThan(0);
  });

  it('never marks a walkable elevated cell that is not part of some real bridge/walkway footprint (no rooftop-parapet or other false positives)', () => {
    // The subset check Sam's review flagged as missing: it's not enough to
    // prove every real bridge/walkway cell is found (the two tests above) --
    // a scan that also picks up unrelated METAL-with-clearance geometry
    // (rooftop parapet trim sitting on a solid roof, an antenna platform,
    // etc.) would still pass those, while still populating pedestrians on a
    // skyscraper roof edge that was never a deck. This asserts the reverse
    // direction: scanned walkable cells ⊆ real bridge/walkway footprints.
    let levelsChecked = 0;

    for (const seed of seeds) {
      const world = new World();
      const { bridges, walkways } = generateCity(world, seed);
      const grid = buildNavGrid(world, WORLD_SIZE_X, WORLD_SIZE_Z, GROUND_SURFACE_Y);

      const realDeckCellKeys = new Set<string>();
      for (const bridge of bridges) {
        for (const { x, z } of bridgeFullFootprintCells(bridge)) realDeckCellKeys.add(`${bridge.level},${x},${z}`);
      }
      for (const walkway of walkways) {
        for (const { x, z } of walkwayFootprintCells(walkway)) realDeckCellKeys.add(`${WALKWAY_Y},${x},${z}`);
      }

      for (const level of grid.elevatedLevels) {
        for (let i = 0; i < level.walkable.length; i++) {
          if (level.walkable[i] !== 1) continue;
          const x = i % WORLD_SIZE_X;
          const z = Math.floor(i / WORLD_SIZE_X);
          expect(realDeckCellKeys.has(`${level.y},${x},${z}`)).toBe(true);
        }
        levelsChecked++;
      }
    }

    expect(levelsChecked).toBeGreaterThan(0);
  });
});
