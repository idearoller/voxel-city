import { describe, expect, it } from 'vitest';
import { buildNavGrid, isElevatedWalkableCell, isSidewalkCell, type NavGrid } from '../src/entities/NavGrid';
import { captureRenderPrevState, createPedestrianAt, snapRenderPrevIfTeleported, stepPedestrian } from '../src/entities/Pedestrian';
import { CONCRETE, METAL, SIDEWALK } from '../src/world/BlockRegistry';
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

    const ped = createPedestrianAt(2, 5, GROUND_Y, 1.4);
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

    const ped = createPedestrianAt(1, 5, GROUND_Y, 1.4);
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

    const ped = createPedestrianAt(0, 5, GROUND_Y, 1.4);
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
    const ped = createPedestrianAt(5, 5, GROUND_Y, 1.4);
    const rng = createRng('ped-isolated');

    stepPedestrian(ped, 1 / 60, grid, rng); // arrives immediately (already at cell center) -> chooseNextCell finds no candidates

    expect(ped.alive).toBe(false);
  });

  it('marks a pedestrian not-alive once its own current cell stops being walkable', () => {
    const grid = buildGridWithSidewalkCells([
      [4, 5],
      [5, 5],
      [6, 5],
    ]);
    const ped = createPedestrianAt(5, 5, GROUND_Y, 1.4);
    const rng = createRng('ped-floor-removed');

    // Simulate a sandbox edit + rebuild that shrank the sidewalk out from
    // under this pedestrian's current cell, without moving it first.
    grid.sidewalk[5 + 5 * WIDTH] = 0;

    stepPedestrian(ped, 1 / 60, grid, rng);

    expect(ped.alive).toBe(false);
  });
});

const ELEVATED_Y = 30;

/** An elevated deck: every (x, z) in `cells` is walkable at `ELEVATED_Y`, nothing else is. */
function buildGridWithElevatedDeck(cells: [number, number][]): NavGrid {
  const world = new World();
  for (const [x, z] of cells) {
    world.setBlock(x, ELEVATED_Y, z, METAL);
  }
  return buildNavGrid(world, WIDTH, DEPTH, GROUND_Y);
}

describe('stepPedestrian on an elevated deck', () => {
  it('walks a deck corridor without ever leaving deck cells', () => {
    const cells: [number, number][] = [];
    for (let x = 0; x < 12; x++) cells.push([x, 5]);
    const grid = buildGridWithElevatedDeck(cells);
    expect(grid.elevatedLevels).toHaveLength(1);

    const ped = createPedestrianAt(2, 5, ELEVATED_Y, 1.4);
    const rng = createRng('ped-deck-straight');

    for (let i = 0; i < 900; i++) {
      stepPedestrian(ped, 1 / 60, grid, rng);
      expect(ped.alive).toBe(true);
      expect(ped.y).toBe(ELEVATED_Y);
      expect(isElevatedWalkableCell(grid, 0, ped.cellX, ped.cellZ)).toBe(true);
    }
  });

  it('never steps onto an open deck edge (no rail-cell headroom) even when neighboring ground-level sidewalk exists directly below', () => {
    // A 3-wide bridge-shaped deck: only the middle row (z=5) has clearance
    // above it (mimics a bridge's rail-blocked edge rows) -- z=4 and z=6 are
    // METAL with something solid stacked on top, exactly like a rail.
    const world = new World();
    for (let x = 0; x < 10; x++) {
      world.setBlock(x, ELEVATED_Y, 4, METAL);
      world.setBlock(x, ELEVATED_Y + 1, 4, METAL); // "rail" blocking headroom
      world.setBlock(x, ELEVATED_Y, 5, METAL);
      world.setBlock(x, ELEVATED_Y, 6, METAL);
      world.setBlock(x, ELEVATED_Y + 1, 6, METAL);
    }
    // Ground-level sidewalk directly underneath the whole footprint -- a
    // pedestrian confined to the deck must never wander down onto it.
    for (let x = 0; x < 10; x++) {
      for (let z = 4; z <= 6; z++) {
        world.setBlock(x, 0, z, CONCRETE);
        world.setBlock(x, GROUND_Y, z, SIDEWALK);
      }
    }
    const grid = buildNavGrid(world, WIDTH, DEPTH, GROUND_Y);

    const ped = createPedestrianAt(2, 5, ELEVATED_Y, 1.4);
    const rng = createRng('ped-deck-rails');

    for (let i = 0; i < 900; i++) {
      stepPedestrian(ped, 1 / 60, grid, rng);
      expect(ped.alive).toBe(true);
      expect(ped.cellZ).toBe(5); // never strays onto the rail-blocked z=4/z=6 rows
      expect(ped.y).toBe(ELEVATED_Y); // never drops to the ground row below
    }
  });

  it('reverses at a deck dead end instead of falling off the edge', () => {
    const grid = buildGridWithElevatedDeck([
      [0, 5],
      [1, 5],
      [2, 5],
    ]);
    const ped = createPedestrianAt(0, 5, ELEVATED_Y, 1.4);
    const rng = createRng('ped-deck-deadend');

    for (let i = 0; i < 1200; i++) {
      stepPedestrian(ped, 1 / 60, grid, rng);
      expect(ped.alive).toBe(true);
      expect(ped.cellX).toBeGreaterThanOrEqual(0);
      expect(ped.cellX).toBeLessThanOrEqual(2);
      expect(ped.cellZ).toBe(5);
    }
  });

  it('despawns gracefully (never floats) once its deck cell is edited away', () => {
    const grid = buildGridWithElevatedDeck([
      [4, 5],
      [5, 5],
      [6, 5],
    ]);
    const ped = createPedestrianAt(5, 5, ELEVATED_Y, 1.4);
    const rng = createRng('ped-deck-edited-away');

    // Simulate a sandbox edit removing the deck cell the pedestrian is
    // standing on (next NavGrid rebuild would reflect this).
    (grid.elevatedLevels[0] as { walkable: Uint8Array }).walkable[5 + 5 * WIDTH] = 0;

    stepPedestrian(ped, 1 / 60, grid, rng);

    expect(ped.alive).toBe(false);
  });
});

describe('render-interpolation state (prevX/prevY/prevZ/prevDirX/prevDirZ)', () => {
  it('createPedestrianAt seeds prev equal to the initial position/heading, so a fresh spawn never smears in', () => {
    const ped = createPedestrianAt(4, 6, 12, 1.4);
    expect(ped.prevX).toBe(ped.x);
    expect(ped.prevY).toBe(ped.y);
    expect(ped.prevZ).toBe(ped.z);
    expect(ped.prevDirX).toBe(ped.dirX);
    expect(ped.prevDirZ).toBe(ped.dirZ);
  });

  it('captureRenderPrevState snapshots the current position/heading, and a subsequent step leaves it holding the pre-step values', () => {
    const cells: [number, number][] = [];
    for (let x = 0; x < 15; x++) cells.push([x, 5]);
    const grid = buildGridWithSidewalkCells(cells);
    const rng = createRng('ped-prev-capture');
    const ped = createPedestrianAt(5, 5, GROUND_Y, 2);
    // Give it a real heading first so dirX/dirZ aren't both still 0.
    stepPedestrian(ped, 1 / 60, grid, rng);

    const xBefore = ped.x;
    const zBefore = ped.z;
    const dirXBefore = ped.dirX;
    const dirZBefore = ped.dirZ;

    captureRenderPrevState(ped);
    stepPedestrian(ped, 1 / 60, grid, rng);

    expect(ped.x).not.toBe(xBefore); // sanity: the step actually moved it
    expect(ped.prevX).toBe(xBefore);
    expect(ped.prevZ).toBe(zBefore);
    expect(ped.prevDirX).toBe(dirXBefore);
    expect(ped.prevDirZ).toBe(dirZBefore);
  });

  it('snapRenderPrevIfTeleported leaves prev untouched after ordinary bounded movement', () => {
    const ped = createPedestrianAt(5, 5, GROUND_Y, 2);
    captureRenderPrevState(ped);
    ped.x += (2 * (1 / 60)) / 2; // well within the speed*dt bound

    snapRenderPrevIfTeleported(ped, 1 / 60);

    expect(ped.prevX).toBe(5.5); // unchanged from captureRenderPrevState's snapshot
  });

  it('snapRenderPrevIfTeleported collapses prev to current when a same-tick jump is implausibly large', () => {
    const ped = createPedestrianAt(5, 5, GROUND_Y, 2);
    captureRenderPrevState(ped);
    ped.x += 500; // a teleport far beyond anything stepPedestrian could produce in one tick

    snapRenderPrevIfTeleported(ped, 1 / 60);

    expect(ped.prevX).toBe(ped.x); // snapped -- no smear across the map next render
    expect(ped.prevY).toBe(ped.y);
    expect(ped.prevZ).toBe(ped.z);
  });
});
