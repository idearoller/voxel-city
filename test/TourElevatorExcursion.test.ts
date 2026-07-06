import { describe, expect, it } from 'vitest';
import { buildNavGrid, type NavGrid } from '../src/entities/NavGrid';
import { createPedestrianAt } from '../src/entities/Pedestrian';
import type { ElevatorShaft } from '../src/elevators/ElevatorScanner';
import { createRng, type Rng } from '../src/gen/rng';
import {
  canReachFunctionalShaft,
  createTourExcursionIdleState,
  maybeBeginExcursion,
  pickTourSpawnCell,
  stepExcursion,
  stepExcursionIdleTimer,
  type TourExcursionIdleState,
  type TourExcursionState,
} from '../src/player/TourElevatorExcursion';
import type { TourWalker } from '../src/player/TourWalker';
import { CONCRETE, SIDEWALK } from '../src/world/BlockRegistry';
import { World } from '../src/world/World';

const GROUND_Y = 1;
const WIDTH = 60;
const DEPTH = 60;
const TICK = 1 / 60;

/** Builds a NavGrid from a plain list of sidewalk (x, z) cells at GROUND_Y. */
function buildGridWithSidewalkCells(cells: ReadonlyArray<readonly [number, number]>): NavGrid {
  const world = new World();
  for (const [x, z] of cells) {
    world.setBlock(x, 0, z, CONCRETE);
    world.setBlock(x, GROUND_Y, z, SIDEWALK);
  }
  return buildNavGrid(world, WIDTH, DEPTH, GROUND_Y);
}

/** A straight corridor along z=5, from x=0 to x=length-1, so BFS distance from any point is just the x difference. */
function corridorCells(length: number, z = 5): Array<[number, number]> {
  const cells: Array<[number, number]> = [];
  for (let x = 0; x < length; x++) cells.push([x, z]);
  return cells;
}

/** Hand-built shaft: only `wellX`/`wellZ`/`stops`/`doorCells` matter to this module -- `minY`/`maxY`/`id` are irrelevant placeholders. */
function shaftAt(wellX: number, wellZ: number, doorX: number, doorZ: number, groundFeetY = GROUND_Y + 1): ElevatorShaft {
  return {
    id: `shaft-${wellX}-${wellZ}`,
    wellX,
    wellZ,
    minY: 0,
    maxY: 10,
    stops: [groundFeetY, groundFeetY + 20],
    doorCells: [{ x: doorX, z: doorZ }, { x: doorX, z: doorZ }],
  };
}

function walkerAt(x: number, z: number): TourWalker {
  return createPedestrianAt(x, z, GROUND_Y, 1.4);
}

function idleAt(idleSeconds: number): TourExcursionIdleState {
  const state = createTourExcursionIdleState();
  state.idleSeconds = idleSeconds;
  return state;
}

describe('createTourExcursionIdleState / stepExcursionIdleTimer', () => {
  it('starts at zero and accumulates dt', () => {
    const state = createTourExcursionIdleState();
    expect(state.idleSeconds).toBe(0);
    stepExcursionIdleTimer(state, 1.5);
    stepExcursionIdleTimer(state, 2.5);
    expect(state.idleSeconds).toBe(4);
  });
});

describe('maybeBeginExcursion (decision policy)', () => {
  it('never begins before the idle threshold has elapsed, regardless of rng', () => {
    const grid = buildGridWithSidewalkCells(corridorCells(20));
    const shafts = [shaftAt(10, 10, 5, 5)];
    const walker = walkerAt(2, 5);
    const idleState = idleAt(0);

    for (let i = 0; i < 100; i++) {
      const rng = createRng(`below-threshold-${i}`);
      expect(maybeBeginExcursion(walker, 2, 5, grid, shafts, idleState, rng)).toBeNull();
    }
  });

  it('never begins when no functional shaft exists at all', () => {
    const grid = buildGridWithSidewalkCells(corridorCells(20));
    const walker = walkerAt(2, 5);
    const idleState = idleAt(1000);

    for (let i = 0; i < 100; i++) {
      const rng = createRng(`no-shafts-${i}`);
      expect(maybeBeginExcursion(walker, 2, 5, grid, [], idleState, rng)).toBeNull();
      idleState.idleSeconds = 1000; // maybeBeginExcursion resets it on every attempt; force it back above threshold for the next trial
    }
  });

  it('never begins when the only shaft is unreachable (isolated, no walkable path)', () => {
    // Two disconnected sidewalk islands: the walker's corridor never touches the shaft's door cell.
    const grid = buildGridWithSidewalkCells([...corridorCells(10), [40, 40]]);
    const shafts = [shaftAt(41, 41, 40, 40)];
    const walker = walkerAt(2, 5);
    const idleState = idleAt(1000);

    const excursion = maybeBeginExcursion(walker, 2, 5, grid, shafts, idleState, createRng('unreachable'));
    expect(excursion).toBeNull();
  });

  it('commits only a fraction of the time once idle long enough, never every time and never zero times', () => {
    const grid = buildGridWithSidewalkCells(corridorCells(20));
    const shafts = [shaftAt(10, 10, 10, 6)]; // door one step off the corridor at x=10
    const rootRng = createRng('excursion-probability');

    let commits = 0;
    const trials = 1500;
    for (let i = 0; i < trials; i++) {
      const walker = walkerAt(2, 5);
      const idleState = idleAt(1000);
      const trialRng: Rng = rootRng.fork(`trial-${i}`);
      const excursion = maybeBeginExcursion(walker, 2, 5, grid, shafts, idleState, trialRng);
      if (excursion) commits++;
    }

    const rate = commits / trials;
    expect(rate).toBeGreaterThan(0.1);
    expect(rate).toBeLessThan(0.6);
  });

  it('when it does commit, the path ends at a real walkable cell adjacent to the shaft door and heading points along the first leg', () => {
    const grid = buildGridWithSidewalkCells(corridorCells(20));
    const shafts = [shaftAt(10, 10, 10, 6)];
    const walker = walkerAt(2, 5);
    const idleState = idleAt(1000);

    let excursion: TourExcursionState | null = null;
    for (let i = 0; i < 200 && !excursion; i++) {
      idleState.idleSeconds = 1000;
      excursion = maybeBeginExcursion(walker, 2, 5, grid, shafts, idleState, createRng(`find-commit-${i}`));
    }

    expect(excursion).not.toBeNull();
    const path = excursion!.path;
    expect(path.length).toBeGreaterThan(0);
    const last = path[path.length - 1]!;
    // The door is at (10, 6); `findWalkableLandingNear`'s ring search finds
    // (9, 5) first (radius-1 ring, (dx, dz) = (-1, -1) is the first
    // candidate checked) since the whole corridor at z=5 is walkable.
    expect(last).toEqual({ x: 9, z: 5 });
    expect(walker.dirX).toBe(Math.sign(path[0]!.x - 2));
    expect(walker.dirZ).toBe(Math.sign(path[0]!.z - 5));
  });

  it('resets the idle timer once the chance roll lands, even if no shaft is reachable (BFS finding nothing is not the same as the roll failing)', () => {
    const grid = buildGridWithSidewalkCells(corridorCells(20));
    const walker = walkerAt(2, 5);

    let reset = false;
    for (let i = 0; i < 200 && !reset; i++) {
      const idleState = idleAt(1000);
      // No shafts at all -- BFS/targets always come up empty, so any
      // non-null-idle-reset here can only be attributed to the chance roll
      // itself landing, not to a path happening to be found.
      maybeBeginExcursion(walker, 2, 5, grid, [], idleState, createRng(`reset-check-${i}`));
      if (idleState.idleSeconds === 0) reset = true;
    }

    expect(reset).toBe(true);
  });

  it('leaves the idle timer untouched when the chance roll itself does not land', () => {
    const grid = buildGridWithSidewalkCells(corridorCells(20));
    const walker = walkerAt(2, 5);

    let sawUnchanged = false;
    for (let i = 0; i < 200 && !sawUnchanged; i++) {
      const idleState = idleAt(1000);
      maybeBeginExcursion(walker, 2, 5, grid, [], idleState, createRng(`no-roll-${i}`));
      if (idleState.idleSeconds === 1000) sawUnchanged = true;
    }

    expect(sawUnchanged).toBe(true);
  });

  it('only considers shafts whose stop matches the walker\'s own current level', () => {
    const grid = buildGridWithSidewalkCells(corridorCells(20));
    // A shaft whose only stops are far above the walker's ground level (1) -- never boardable from here.
    const shaft: ElevatorShaft = {
      id: 'elevated-only',
      wellX: 10,
      wellZ: 10,
      minY: 0,
      maxY: 40,
      stops: [30, 50],
      doorCells: [{ x: 10, z: 6 }, { x: 10, z: 6 }],
    };
    const walker = walkerAt(2, 5);
    const idleState = idleAt(1000);

    for (let i = 0; i < 200; i++) {
      idleState.idleSeconds = 1000;
      expect(maybeBeginExcursion(walker, 2, 5, grid, [shaft], idleState, createRng(`no-level-match-${i}`))).toBeNull();
    }
  });
});

describe('stepExcursion (walking the path)', () => {
  it('walks every waypoint in order and lands exactly on the final one, alive and at the same level', () => {
    const grid = buildGridWithSidewalkCells(corridorCells(20));
    const walker = walkerAt(2, 5);
    let state: TourExcursionState | null = {
      path: [
        { x: 3, z: 5 },
        { x: 4, z: 5 },
        { x: 5, z: 5 },
      ],
      index: 0,
    };

    for (let i = 0; i < 60 * 10 && state; i++) {
      state = stepExcursion(walker, state, TICK, grid);
    }

    expect(state).toBeNull();
    expect(walker.cellX).toBe(5);
    expect(walker.cellZ).toBe(5);
    expect(walker.x).toBeCloseTo(5.5, 5);
    expect(walker.z).toBeCloseTo(5.5, 5);
    expect(walker.y).toBe(GROUND_Y);
    expect(walker.alive).toBe(true);
  });

  it('captures a render-interpolation previous state each tick, distinct from a mid-leg current position', () => {
    const grid = buildGridWithSidewalkCells(corridorCells(20));
    const walker = walkerAt(2, 5);
    let state: TourExcursionState | null = { path: [{ x: 10, z: 5 }], index: 0 };

    state = stepExcursion(walker, state as TourExcursionState, TICK, grid);
    expect(walker.x).not.toBe(walker.prevX);
  });

  it('abandons cleanly (returns null) if a waypoint is no longer walkable -- a stale plan after the world changed underneath it', () => {
    const grid = buildGridWithSidewalkCells(corridorCells(20));
    // A grid where the previously-planned waypoint is no longer sidewalk at all (simulates a NavGrid rebuild mid-excursion).
    const changedGrid = buildGridWithSidewalkCells(corridorCells(5)); // corridor now stops short of x=10
    const walker = walkerAt(8, 5);
    const state: TourExcursionState = { path: [{ x: 10, z: 5 }], index: 0 };

    const result = stepExcursion(walker, state, TICK, changedGrid);

    expect(result).toBeNull();
    expect(grid).toBeDefined(); // sanity: original grid still constructible/usable, no shared-mutation surprises
  });

  it('never stalls: a bounded number of ticks always finishes a real path, however long', () => {
    const grid = buildGridWithSidewalkCells(corridorCells(50));
    const walker = walkerAt(2, 5);
    const path = Array.from({ length: 45 }, (_, i) => ({ x: 3 + i, z: 5 }));
    let state: TourExcursionState | null = { path, index: 0 };

    let ticks = 0;
    const MAX_TICKS = 60 * 120; // 2 minutes -- generous for a 45-cell walk at TOUR_WALK_SPEED
    while (state && ticks < MAX_TICKS) {
      state = stepExcursion(walker, state, TICK, grid);
      ticks++;
    }

    expect(state).toBeNull();
    expect(ticks).toBeLessThan(MAX_TICKS);
  });
});

describe('canReachFunctionalShaft', () => {
  it('is true when a shaft door is reachable via the walkable graph', () => {
    const grid = buildGridWithSidewalkCells(corridorCells(20));
    const shafts = [shaftAt(10, 10, 10, 6)];

    expect(canReachFunctionalShaft(grid, GROUND_Y, 2, 5, shafts)).toBe(true);
  });

  it('is false when every shaft is on a different, disconnected island', () => {
    const grid = buildGridWithSidewalkCells([...corridorCells(10), [40, 40]]);
    const shafts = [shaftAt(41, 41, 40, 40)];

    expect(canReachFunctionalShaft(grid, GROUND_Y, 2, 5, shafts)).toBe(false);
  });

  it('is false when there are no functional shafts at all', () => {
    const grid = buildGridWithSidewalkCells(corridorCells(20));

    expect(canReachFunctionalShaft(grid, GROUND_Y, 2, 5, [])).toBe(false);
  });
});

describe('pickTourSpawnCell (task #37 spawn-bias gate)', () => {
  it('always honors #37 (returns nearCell unchanged) when the spawn island already has a reachable shaft, regardless of rng', () => {
    const grid = buildGridWithSidewalkCells(corridorCells(20));
    const shafts = [shaftAt(10, 10, 10, 6)];
    const nearCell = { x: 2, z: 5 };

    for (let i = 0; i < 200; i++) {
      const rng = createRng(`reachable-island-${i}`);
      expect(pickTourSpawnCell(nearCell, grid, shafts, GROUND_Y, rng)).toEqual(nearCell);
    }
  });

  it('always honors #37 when there are no functional shafts at all, regardless of rng', () => {
    const grid = buildGridWithSidewalkCells(corridorCells(20));
    const nearCell = { x: 2, z: 5 };

    for (let i = 0; i < 200; i++) {
      const rng = createRng(`no-shafts-gate-${i}`);
      expect(pickTourSpawnCell(nearCell, grid, [], GROUND_Y, rng)).toEqual(nearCell);
    }
  });

  it('on a shaft-less island, the large majority of rolls still honor #37 -- bias is the minority outcome, not the default', () => {
    // Two disconnected islands: the walker's own corridor never touches the shaft's door cell.
    const grid = buildGridWithSidewalkCells([...corridorCells(10), [40, 40]]);
    const shafts = [shaftAt(41, 41, 40, 40)];
    const nearCell = { x: 2, z: 5 };
    const rootRng = createRng('gate-majority-check');

    let honored = 0;
    const trials = 2000;
    for (let i = 0; i < trials; i++) {
      const trialRng: Rng = rootRng.fork(`trial-${i}`);
      const cell = pickTourSpawnCell(nearCell, grid, shafts, GROUND_Y, trialRng);
      if (cell.x === nearCell.x && cell.z === nearCell.z) honored++;
    }

    const honoredRate = honored / trials;
    expect(honoredRate).toBeGreaterThan(0.5); // majority -- the whole point of gating the bias down from an unconditional 0.4
    expect(honoredRate).toBeLessThan(1); // but not literally every time -- the bias must still be reachable, or the shaft-less island could never get a ride
  });

  it('on a shaft-less island, some rolls do redirect to a real shaft door', () => {
    const grid = buildGridWithSidewalkCells([...corridorCells(10), [40, 40]]);
    const shafts = [shaftAt(41, 41, 40, 40)];
    const nearCell = { x: 2, z: 5 };

    let sawRedirect = false;
    for (let i = 0; i < 200 && !sawRedirect; i++) {
      const cell = pickTourSpawnCell(nearCell, grid, shafts, GROUND_Y, createRng(`redirect-check-${i}`));
      if (cell.x !== nearCell.x || cell.z !== nearCell.z) {
        sawRedirect = true;
        expect(cell).toEqual({ x: 40, z: 40 }); // the shaft's own ground door cell
      }
    }

    expect(sawRedirect).toBe(true);
  });
});
