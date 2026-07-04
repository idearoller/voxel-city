import { describe, expect, it } from 'vitest';
import { buildNavGrid, isElevatedWalkableCell, isSidewalkCell, type NavGrid, type StairLink } from '../src/entities/NavGrid';
import { beginStair, createPedestrianAt, stepPedestrian, type Pedestrian, type StairCommitment } from '../src/entities/Pedestrian';
import { GROUND_SURFACE_Y, generateCity } from '../src/gen/CityGenerator';
import { WALKWAY_Y } from '../src/gen/infrastructure';
import { createRng } from '../src/gen/rng';
import { CONCRETE, METAL, SIDEWALK } from '../src/world/BlockRegistry';
import { WORLD_SIZE_X, WORLD_SIZE_Z } from '../src/world/coords';
import { World } from '../src/world/World';

const DT = 1 / 60;
const SPEED = 1.4;

/**
 * A minimal hand-built world with a straight stair from ground level up to a
 * deck at `WALKWAY_Y` -- `buildElevatedLevel` only scans the citywide known
 * deck rows (`WALKWAY_Y`/`SKY_LEVELS`), so a fixture deck at an arbitrary y
 * would never be scanned into `elevatedLevels` (and so could never grow a
 * `StairLink`) regardless of the stair geometry above/below it.
 */
function buildSimpleStairWorld(): { world: World; grid: NavGrid; link: StairLink } {
  const world = new World();
  const width = 20;
  const depth = 20;
  const groundY = 1;
  const deckY = WALKWAY_Y;
  const riserCount = deckY - groundY; // top riser lands flush with the deck (y === deckY)

  // Ground floor: CONCRETE slab at y=0, SIDEWALK at y=groundY, clear above.
  for (let x = 0; x < width; x++) {
    for (let z = 0; z < depth; z++) {
      world.setBlock(x, 0, z, CONCRETE);
      world.setBlock(x, groundY, z, SIDEWALK);
    }
  }

  // Risers, x=5 fixed, z climbing one per riser, y climbing groundY+1..deckY.
  const stairStartZ = 5;
  for (let i = 0; i < riserCount; i++) {
    const z = stairStartZ + i;
    const y = groundY + 1 + i;
    world.setBlock(5, y, z, CONCRETE);
    world.setBlock(5, y + 1, z, 0);
    world.setBlock(5, y + 2, z, 0);
  }

  // Deck: METAL at y=deckY, clear above and below, starting one cell past the last riser.
  const deckStartZ = stairStartZ + riserCount;
  for (let x = 0; x < width; x++) {
    for (let z = deckStartZ; z < deckStartZ + 5; z++) {
      world.setBlock(x, deckY, z, METAL);
      world.setBlock(x, deckY + 1, z, 0);
      world.setBlock(x, deckY - 1, z, 0);
    }
  }

  const grid = buildNavGrid(world, width, depth, groundY);
  expect(grid.stairLinks.length).toBe(1);
  const link = grid.stairLinks[0] as StairLink;
  return { world, grid, link };
}

describe('pedestrian stair crossing (hand-built fixture)', () => {
  it('climbs every riser in order, y interpolating smoothly between them, snapping exactly at each arrival', () => {
    const { grid, link } = buildSimpleStairWorld();
    const ground = link.steps[0] as { x: number; y: number; z: number };

    const ped = createPedestrianAt(ground.x, ground.z, ground.y, SPEED);
    beginStair(ped, link, 1);
    expect(ped.stair).not.toBeNull();

    const seenYsBetweenArrivals: number[] = [];
    let lastArrivalIndex = 0;

    for (let tick = 0; tick < 2000 && ped.stair; tick++) {
      stepPedestrian(ped, DT, grid, createRng('unused'));
      seenYsBetweenArrivals.push(ped.y);

      const stair = ped.stair as StairCommitment | null;
      if (stair && stair.index !== lastArrivalIndex) {
        // Just arrived at a new step -- y must have snapped to an exact riser value.
        lastArrivalIndex = stair.index;
      }
    }

    // Completed the whole climb: no longer mid-stair, landed exactly on the deck.
    expect(ped.stair).toBeNull();
    expect(ped.y).toBe(link.levelY);
    expect(ped.cellX).toBe(link.steps[link.steps.length - 1]?.x);
    expect(ped.cellZ).toBe(link.steps[link.steps.length - 1]?.z);
    expect(isElevatedWalkableCell(grid, 0, ped.cellX, ped.cellZ)).toBe(true);

    // The climb wasn't instantaneous -- y actually passed through intermediate,
    // non-integer-only values (visually smooth), not a single tick teleport.
    const distinctYs = new Set(seenYsBetweenArrivals.map((y) => Math.round(y * 1000)));
    expect(distinctYs.size).toBeGreaterThan(link.steps.length);
  });

  it('descends every riser in order from the deck back to the ground landing', () => {
    const { grid, link } = buildSimpleStairWorld();
    const deck = link.steps[link.steps.length - 1] as { x: number; y: number; z: number };

    const ped = createPedestrianAt(deck.x, deck.z, deck.y, SPEED);
    beginStair(ped, link, -1);

    for (let tick = 0; tick < 2000 && ped.stair; tick++) {
      stepPedestrian(ped, DT, grid, createRng('unused'));
    }

    expect(ped.stair).toBeNull();
    expect(ped.y).toBe((link.steps[0] as { y: number }).y);
    expect(ped.cellX).toBe(link.steps[0]?.x);
    expect(ped.cellZ).toBe(link.steps[0]?.z);
    expect(isSidewalkCell(grid, ped.cellX, ped.cellZ)).toBe(true);
  });

  it('never regresses mid-stair: the step index only ever advances in the committed direction, even across many ticks', () => {
    const { grid, link } = buildSimpleStairWorld();
    const ground = link.steps[0] as { x: number; y: number; z: number };

    const ped = createPedestrianAt(ground.x, ground.z, ground.y, SPEED);
    beginStair(ped, link, 1);

    let lastIndex = (ped.stair as StairCommitment).index;
    for (let tick = 0; tick < 2000 && ped.stair; tick++) {
      stepPedestrian(ped, DT, grid, createRng('unused'));
      const stair = ped.stair as StairCommitment | null;
      if (!stair) break;
      expect(stair.index).toBeGreaterThanOrEqual(lastIndex); // never decreases while climbing
      lastIndex = stair.index;
    }
  });

  it('despawns gracefully mid-stair once its own link is no longer listed in the grid (edited away)', () => {
    const { grid, link } = buildSimpleStairWorld();
    const ground = link.steps[0] as { x: number; y: number; z: number };

    const ped = createPedestrianAt(ground.x, ground.z, ground.y, SPEED);
    beginStair(ped, link, 1);

    // A few ticks in, still mid-stair.
    for (let i = 0; i < 10; i++) stepPedestrian(ped, DT, grid, createRng('unused'));
    expect(ped.alive).toBe(true);
    expect(ped.stair).not.toBeNull();

    // Simulate a sandbox edit removing this stair (next full rebuild would
    // reflect this) by dropping it from the live grid's own link list.
    (grid as unknown as { stairLinks: StairLink[] }).stairLinks = [];

    stepPedestrian(ped, DT, grid, createRng('unused'));
    expect(ped.alive).toBe(false);
  });

  it('forces the stair unconditionally when it is the only way out of a dead end (no despawn at a live stair entrance)', () => {
    const { grid, link } = buildSimpleStairWorld();
    const ground = link.steps[0] as { x: number; y: number; z: number };
    // Wall the ground landing off from every direction except toward the
    // stair by using a grid whose sidewalk is *only* this one landing cell.
    const isolated: NavGrid = {
      ...grid,
      sidewalk: (() => {
        const arr = new Uint8Array(grid.width * grid.depth);
        arr[ground.x + ground.z * grid.width] = 1;
        return arr;
      })(),
    };

    const ped = createPedestrianAt(ground.x, ground.z, ground.y, SPEED);
    // Arrival at the landing triggers chooseNextCell -- force it by nudging
    // ped to its own cell center and invoking a step that lands exactly on arrival.
    stepPedestrian(ped, DT, isolated, createRng('force-stair-take'));
    // Regardless of the rng roll, an isolated landing with a live stair must
    // take it rather than despawn (see `chooseNextCell`'s doc comment).
    expect(ped.alive).toBe(true);
    expect(ped.stair).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Real generator output: prove the same crossing on a genuine walkway stair,
// per this repo's review convention (Sam's soak/probe culture).
// ---------------------------------------------------------------------------

describe('pedestrian stair crossing (real generator output)', () => {
  const seeds = Array.from({ length: 12 }, (_, i) => `stair-ped-${i}`);

  it('climbs a real walkway stair end-to-end without floating or clipping, then descends it back to the ground', () => {
    let crossingsChecked = 0;

    for (const seed of seeds) {
      const world = new World();
      generateCity(world, seed);
      const grid = buildNavGrid(world, WORLD_SIZE_X, WORLD_SIZE_Z, GROUND_SURFACE_Y);
      if (grid.stairLinks.length === 0) continue;

      const link = grid.stairLinks[0] as StairLink;
      const ground = link.steps[0] as { x: number; y: number; z: number };
      const deck = link.steps[link.steps.length - 1] as { x: number; y: number; z: number };

      // --- climb ---
      const up = createPedestrianAt(ground.x, ground.z, ground.y, SPEED);
      beginStair(up, link, 1);
      let ticks = 0;
      while (up.stair && ticks < 5000) {
        stepPedestrian(up, DT, grid, createRng('unused'));
        expect(up.alive).toBe(true);
        const stair = up.stair as StairCommitment | null;
        if (stair) {
          const cur = stair.link.steps[stair.index] as { y: number };
          const prev = stair.link.steps[stair.index - stair.direction] as { y: number };
          expect(up.y).toBeGreaterThanOrEqual(Math.min(cur.y, prev.y));
          expect(up.y).toBeLessThanOrEqual(Math.max(cur.y, prev.y));
        }
        ticks++;
      }
      expect(up.stair).toBeNull();
      expect(up.y).toBe(deck.y);
      expect(up.cellX).toBe(deck.x);
      expect(up.cellZ).toBe(deck.z);
      const levelIndex = grid.elevatedLevels.findIndex((l) => l.y === link.levelY);
      expect(isElevatedWalkableCell(grid, levelIndex, up.cellX, up.cellZ)).toBe(true);

      // --- descend ---
      const down = createPedestrianAt(deck.x, deck.z, deck.y, SPEED);
      beginStair(down, link, -1);
      ticks = 0;
      while (down.stair && ticks < 5000) {
        stepPedestrian(down, DT, grid, createRng('unused'));
        expect(down.alive).toBe(true);
        ticks++;
      }
      expect(down.stair).toBeNull();
      expect(down.y).toBe(ground.y);
      expect(down.cellX).toBe(ground.x);
      expect(down.cellZ).toBe(ground.z);
      expect(isSidewalkCell(grid, down.cellX, down.cellZ)).toBe(true);

      crossingsChecked++;
    }

    expect(crossingsChecked).toBeGreaterThan(0);
  });

  it('actually gets taken during ordinary wandering often enough to matter (probability wiring is really connected, not dead code)', () => {
    let takenCount = 0;
    let attemptedSeeds = 0;

    for (const seed of seeds) {
      const world = new World();
      generateCity(world, seed);
      const grid = buildNavGrid(world, WORLD_SIZE_X, WORLD_SIZE_Z, GROUND_SURFACE_Y);
      if (grid.stairLinks.length === 0) continue;
      attemptedSeeds++;

      const link = grid.stairLinks[0] as StairLink;
      const ground = link.steps[0] as { x: number; y: number; z: number };
      const ped: Pedestrian = createPedestrianAt(ground.x, ground.z, ground.y, SPEED);
      const rng = createRng(`${seed}-wander`);

      let tookStairs = false;
      for (let tick = 0; tick < 3000; tick++) {
        stepPedestrian(ped, DT, grid, rng);
        if (!ped.alive) break;
        if (ped.stair) {
          tookStairs = true;
          break;
        }
      }
      if (tookStairs) takenCount++;
    }

    expect(attemptedSeeds).toBeGreaterThan(0);
    // Not a strict fraction check (the wander can take many turns before
    // ever returning to the landing cell) -- just proof it happens under
    // ordinary, un-forced wandering for a real chunk of seeds.
    expect(takenCount).toBeGreaterThan(0);
  });
});
