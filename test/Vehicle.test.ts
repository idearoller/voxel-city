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

/**
 * Two full-width bands crossing at a real 4-way junction: an east-west band
 * (z = 5..8) and a north-south band (x = 5..8), each spanning the entire
 * grid — the same "every corridor is a continuous Manhattan-grid band"
 * topology `gen/layout.ts` actually produces, unlike the single isolated
 * band every other test in this file drives on. Note the cells right at the
 * two bands' shared corners are a known `computeFlowField` rough edge (see
 * `Vehicle.ts`'s module doc comment): their local radius-probe can disagree
 * with an immediate neighbor on the same axis. Through-traffic sails past
 * that untouched (it only ever reads its *own* heading, not the cell's), so
 * the contract this describe block locks in is behavioral — lane discipline
 * and forward progress — not "every cell's flow matches," which the data
 * itself doesn't guarantee at those corners.
 */
function buildCrossingRoadGrid(): NavGrid {
  const world = new World();
  for (let x = 0; x < WIDTH; x++) {
    for (let z = 5; z < 9; z++) {
      world.setBlock(x, 0, z, CONCRETE);
      world.setBlock(x, GROUND_Y, z, ASPHALT);
    }
  }
  for (let z = 0; z < DEPTH; z++) {
    for (let x = 5; x < 9; x++) {
      world.setBlock(x, 0, z, CONCRETE);
      world.setBlock(x, GROUND_Y, z, ASPHALT);
    }
  }
  return buildNavGrid(world, WIDTH, DEPTH, GROUND_Y);
}

/**
 * A proper T-junction (not a symmetric crossing): an east-west band (z =
 * 5..8) that dead-ends at x = 8, meeting a north-south band (x = 9..12) that
 * runs the whole grid. Eastbound traffic on the east-west band is forced to
 * actually turn here — the scenario `advanceCell`'s turn branch exists for —
 * onto a corridor it was never previously heading along.
 */
function buildTJunctionGrid(): NavGrid {
  const world = new World();
  for (let x = 0; x <= 8; x++) {
    for (let z = 5; z < 9; z++) {
      world.setBlock(x, 0, z, CONCRETE);
      world.setBlock(x, GROUND_Y, z, ASPHALT);
    }
  }
  for (let z = 0; z < DEPTH; z++) {
    for (let x = 9; x < 13; x++) {
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

describe('stepVehicle at a crossing-roads intersection (junction contract)', () => {
  it('through-traffic on either band crosses the junction in lane, making forward progress until it despawns off the map edge', () => {
    const grid = buildCrossingRoadGrid();
    // z=5 is the east-west band's near-half lane (assigned +x); drive straight across the whole grid, through the north-south crossing.
    const vehicle = createVehicleAt(1, 5, 8);

    let lastCellX = vehicle.cellX;
    for (let i = 0; i < 400; i++) {
      stepVehicle(vehicle, 1 / 60, grid);
      if (!vehicle.alive) break;
      expect(vehicle.cellZ).toBe(5); // never drifts lanes crossing the junction
      expect(vehicle.cellX).toBeGreaterThanOrEqual(lastCellX); // never reverses/oscillates
      lastCellX = vehicle.cellX;
    }
    expect(vehicle.alive).toBe(false); // ran off the far edge rather than getting stuck
  });

  it('a vehicle forced to turn at a T-junction snaps onto the new corridor\'s own lane and never doubles back against it', () => {
    const grid = buildTJunctionGrid();
    // Drives the east-west band's dead end straight into the T, forcing a
    // real turn onto the north-south corridor (see buildTJunctionGrid doc).
    const vehicle = createVehicleAt(1, 5, 8);
    const visited = new Set<string>();
    let lastKey = `${vehicle.cellX},${vehicle.cellZ}`;
    visited.add(lastKey);
    let turned = false;

    for (let i = 0; i < 600; i++) {
      stepVehicle(vehicle, 1 / 60, grid);
      if (!vehicle.alive) break;
      const key = `${vehicle.cellX},${vehicle.cellZ}`;
      if (key !== lastKey) {
        // A vehicle that ever doubles back re-visits a cell it already left
        // — exactly the oscillation a bad turn-time lane choice would cause.
        expect(visited.has(key)).toBe(false);
        visited.add(key);
        lastKey = key;
      }
      if (vehicle.dirZ !== 0) turned = true;
    }

    expect(turned).toBe(true); // actually exercised the turn, not just despawned going straight
    expect(vehicle.alive).toBe(false); // eventually drives off the north-south band's far edge
  });

  it('snaps sideways onto a self-consistent lane when the turn cell itself is a tie-broken contradiction', () => {
    // buildCrossingRoadGrid's own flow field has a genuine self-contradiction
    // right at (8,7)/(8,8): the crossing's tie-break assigns that column
    // +x, but the very next cell east of it (9,7)/(9,8) -- still the same
    // east-west far lane, just outside the crossing's footprint -- is
    // correctly assigned -x (see this suite's module doc comment). A
    // vehicle spawning there (dirX=dirZ=0, so its very first step goes
    // through the same "establish a heading" branch a post-turn vehicle
    // does) naively reads (8,8)'s own (+1, 0) and would immediately
    // contradict (9,8)'s (-1, 0) one step later -- exactly what
    // `pickStableLane` exists to catch, by snapping sideways (to z=6, whose
    // entire lane agrees with +x all the way through) before ever
    // committing to (9,8). Neutralizing `pickStableLane` to a no-op (return
    // its input unchanged) makes this test fail: the vehicle lands on
    // (9,8) with dirX=+1 while grid.flowX there is -1, a same-axis
    // contradiction the assertion below catches immediately.
    const grid = buildCrossingRoadGrid();
    const vehicle = createVehicleAt(8, 8, 8);

    stepVehicle(vehicle, 1 / 60, grid); // establishes the initial heading from (8, 8)'s own flow
    drive(vehicle, grid, 30); // arrives at the first real cell past that decision

    const idx = vehicle.cellX + vehicle.cellZ * grid.width;
    const flowX = grid.flowX[idx] as number;
    const flowZ = grid.flowZ[idx] as number;
    if (flowX !== 0 && vehicle.dirX !== 0) expect(vehicle.dirX).toBe(flowX);
    if (flowZ !== 0 && vehicle.dirZ !== 0) expect(vehicle.dirZ).toBe(flowZ);
    // The whole point of the snap: it should have moved off z=8 rather than committing to the contradicting (9,8).
    expect(vehicle.cellZ).not.toBe(8);
  });
});
