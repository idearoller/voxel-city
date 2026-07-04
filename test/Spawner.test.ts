import { describe, expect, it } from 'vitest';
import { isSidewalkCell, type ElevatedLevel, type NavGrid } from '../src/entities/NavGrid';
import {
  isBeyondDespawnRadius,
  pickElevatedSpawnCell,
  pickFlyingVehicleSpawn,
  pickSpawnCell,
} from '../src/entities/Spawner';
import type { SkyLane } from '../src/entities/SkyLane';
import { createRng } from '../src/gen/rng';

function makeGrid(
  width: number,
  depth: number,
  walkableCells: [number, number][],
  elevatedLevels: readonly ElevatedLevel[] = [],
): NavGrid {
  const sidewalk = new Uint8Array(width * depth);
  for (const [x, z] of walkableCells) sidewalk[x + z * width] = 1;
  return {
    width,
    depth,
    groundY: 1,
    sidewalk,
    road: new Uint8Array(width * depth),
    flowX: new Int8Array(width * depth),
    flowZ: new Int8Array(width * depth),
    elevatedLevels,
  };
}

/** Builds an `ElevatedLevel`, deriving `cells` from `walkable` the same way `NavGrid.buildElevatedLevel` does. */
function makeElevatedLevelFrom(y: number, width: number, walkable: Uint8Array): ElevatedLevel {
  const cells: Array<{ x: number; z: number }> = [];
  for (let i = 0; i < walkable.length; i++) {
    if (walkable[i] !== 1) continue;
    cells.push({ x: i % width, z: Math.floor(i / width) });
  }
  return { y, walkable, cells };
}

/** A fully-walkable `width` x `depth` elevated level at `y`. */
function makeElevatedLevel(width: number, depth: number, y: number): ElevatedLevel {
  return makeElevatedLevelFrom(y, width, new Uint8Array(width * depth).fill(1));
}

describe('pickSpawnCell', () => {
  it('only returns cells within [minRadius, maxRadius) of the player', () => {
    const width = 100;
    const depth = 100;
    const walkable: [number, number][] = [];
    for (let x = 0; x < width; x++) {
      for (let z = 0; z < depth; z++) walkable.push([x, z]);
    }
    const grid = makeGrid(width, depth, walkable);
    const rng = createRng('spawn-radius');
    const playerX = 50;
    const playerZ = 50;
    const minRadius = 20;
    const maxRadius = 40;

    for (let i = 0; i < 50; i++) {
      const result = pickSpawnCell(grid, isSidewalkCell, playerX, playerZ, minRadius, maxRadius, rng);
      expect(result).not.toBeNull();
      const dx = (result as { x: number }).x - playerX;
      const dz = (result as { z: number }).z - playerZ;
      const dist = Math.hypot(dx, dz);
      // Allow slight slack for the floor() truncation of a continuous point.
      expect(dist).toBeGreaterThanOrEqual(minRadius - 1);
      expect(dist).toBeLessThanOrEqual(maxRadius + 1);
    }
  });

  it('never returns a cell for which isWalkable is false', () => {
    const grid = makeGrid(50, 50, [[25, 25]]); // only one walkable cell in the whole grid
    const rng = createRng('spawn-single');

    const result = pickSpawnCell(grid, isSidewalkCell, 25, 25, 0, 5, rng, 200);

    if (result) {
      expect(result).toEqual({ x: 25, z: 25 });
    }
  });

  it('returns null when no attempt lands on a walkable cell', () => {
    const grid = makeGrid(50, 50, []); // nothing walkable at all
    const rng = createRng('spawn-none');

    const result = pickSpawnCell(grid, isSidewalkCell, 25, 25, 5, 20, rng, 16);

    expect(result).toBeNull();
  });
});

describe('pickElevatedSpawnCell', () => {
  it('returns null when the grid has no elevated levels at all', () => {
    const grid = makeGrid(50, 50, [[25, 25]]);
    const rng = createRng('elevated-none');

    for (let i = 0; i < 50; i++) expect(pickElevatedSpawnCell(grid, 25, 1, 25, 2, 20, rng)).toBeNull();
  });

  it('returns null when the only elevated deck exists but sits entirely outside the spawn annulus', () => {
    // Deck cells all at (5, 5) area, player far away at (500, 500) -- same
    // altitude, so this isolates "deck out of horizontal range" specifically.
    const level = makeElevatedLevel(10, 10, 30);
    const grid = makeGrid(600, 600, [], [level]);
    const rng = createRng('elevated-out-of-range');

    for (let i = 0; i < 50; i++) expect(pickElevatedSpawnCell(grid, 500, 30, 500, 35, 90, rng)).toBeNull();
  });

  it('samples directly from the deck: every non-null result is an actual walkable cell within the horizontal annulus', () => {
    // A deck much larger than the annulus that will actually be sampled from
    // it -- proves cells are drawn from the deck's own list, not rejected
    // repeatedly against a citywide grid.
    const width = 200;
    const depth = 200;
    const walkable = new Uint8Array(width * depth);
    for (let x = 0; x < width; x++) {
      for (let z = 0; z < depth; z++) walkable[x + z * width] = 1;
    }
    const level = makeElevatedLevelFrom(30, width, walkable);
    const grid = makeGrid(width, depth, [], [level]);
    const rng = createRng('elevated-sample');
    const playerX = 100;
    const playerZ = 100;
    const playerY = 30; // same altitude as the deck -- isolates cell sampling from the vertical-distance mechanic
    const minRadius = 35;
    const maxRadius = 90;

    let hits = 0;
    for (let i = 0; i < 300; i++) {
      const result = pickElevatedSpawnCell(grid, playerX, playerY, playerZ, minRadius, maxRadius, rng);
      if (!result) continue;
      hits++;
      expect(level.walkable[result.x + result.z * width]).toBe(1);
      expect(result.y).toBe(30);
      const dist = Math.hypot(result.x - playerX, result.z - playerZ);
      expect(dist).toBeGreaterThanOrEqual(minRadius);
      expect(dist).toBeLessThan(maxRadius);
    }
    expect(hits).toBeGreaterThan(0);
  });

  it('caps the elevated share at ~maxElevatedShare when the deck is fully available in the annulus', () => {
    const width = 200;
    const depth = 200;
    const walkable = new Uint8Array(width * depth).fill(1);
    const level = makeElevatedLevelFrom(30, width, walkable);
    const grid = makeGrid(width, depth, [], [level]);
    const rng = createRng('elevated-cap');
    const playerX = 100;
    const playerZ = 100;
    const playerY = 30;

    let hits = 0;
    const trials = 2000;
    for (let i = 0; i < trials; i++) {
      if (pickElevatedSpawnCell(grid, playerX, playerY, playerZ, 35, 90, rng)) hits++;
    }

    const share = hits / trials;
    expect(share).toBeGreaterThan(0.15);
    expect(share).toBeLessThan(0.45); // 0.3 target with statistical slack
  });

  it('requires more horizontal distance for a deck whose altitude differs more from the player (no overhead pop-in)', () => {
    // A deck cell at a fixed, moderate horizontal offset from the player --
    // right at the point where a horizontal-only check would already accept
    // it (just past the plain minRadius), but not past an altitude-inflated
    // effective minRadius.
    const width = 100;
    const depth = 100;
    const cellX = 55; // 5 units horizontally from the player at x=50 -- inside plain minRadius(2) but should fail once altitude is added
    const walkable = new Uint8Array(width * depth);
    walkable[cellX + 50 * width] = 1;
    const level = makeElevatedLevelFrom(30, width, walkable);
    const grid = makeGrid(width, depth, [], [level]);

    const sameAltitudeRng = createRng('elevated-vertical-same');
    const sameAltitudeHit = pickElevatedSpawnCell(grid, 50, 30, 50, 2, 90, sameAltitudeRng, 1); // maxElevatedShare=1 to force the roll through
    expect(sameAltitudeHit).not.toBeNull(); // horizontal offset (5) already clears the plain minRadius (2)

    const farBelowRng = createRng('elevated-vertical-far');
    const farBelowMiss = pickElevatedSpawnCell(grid, 50, 1, 50, 2, 90, farBelowRng, 1); // player 29 below the deck
    expect(farBelowMiss).toBeNull(); // effective minRadius (2 + 29) far exceeds the 5-unit horizontal offset
  });

  it('picks among multiple in-range elevated levels weighted by their own in-annulus cell count', () => {
    const width = 100;
    const bigWalkable = new Uint8Array(width * width);
    for (let x = 40; x < 60; x++) {
      for (let z = 40; z < 60; z++) bigWalkable[x + z * width] = 1;
    }
    const bigLevel = makeElevatedLevelFrom(30, width, bigWalkable); // 400 cells, all within range

    const smallWalkable = new Uint8Array(width * width);
    smallWalkable[10 + 10 * width] = 1; // well outside the big patch (40-60, 40-60), so cell coordinates never overlap
    const smallLevel = makeElevatedLevelFrom(30, width, smallWalkable); // 1 cell -- same y is fine, this models two separate deck patches

    const grid = makeGrid(width, width, [], [bigLevel, smallLevel]);
    const rng = createRng('elevated-weighted');

    let bigCount = 0;
    let smallCount = 0;
    const trials = 500;
    for (let i = 0; i < trials; i++) {
      const result = pickElevatedSpawnCell(grid, 50, 30, 50, 0, 90, rng, 1); // maxElevatedShare=1, minRadius=0 -- every trial should hit
      if (!result) continue;
      if (bigWalkable[result.x + result.z * width] === 1) bigCount++;
      else smallCount++;
    }

    expect(bigCount + smallCount).toBeGreaterThan(0);
    expect(bigCount).toBeGreaterThan(smallCount); // overwhelmingly weighted toward the bigger deck
  });
});

describe('pickFlyingVehicleSpawn', () => {
  it('returns null when there are no lanes at all', () => {
    const rng = createRng('flying-no-lanes');
    expect(pickFlyingVehicleSpawn([], 0, 0, 10, 50, rng)).toBeNull();
  });

  it('only ever returns a position within [minRadius, maxRadius) of the player', () => {
    const lanes: SkyLane[] = [
      { axis: 'x', fixed: 100, altitude: 104, start: 0, end: 400 },
      { axis: 'z', fixed: 250, altitude: 116, start: 0, end: 400 },
    ];
    const rng = createRng('flying-radius');
    const playerX = 100;
    const playerZ = 100;
    const minRadius = 20;
    const maxRadius = 90;

    for (let i = 0; i < 100; i++) {
      const result = pickFlyingVehicleSpawn(lanes, playerX, playerZ, minRadius, maxRadius, rng);
      if (!result) continue;
      const x = result.lane.axis === 'x' ? result.travelCoord : result.lane.fixed;
      const z = result.lane.axis === 'z' ? result.travelCoord : result.lane.fixed;
      const dist = Math.hypot(x - playerX, z - playerZ);
      expect(dist).toBeGreaterThanOrEqual(minRadius);
      expect(dist).toBeLessThan(maxRadius);
    }
  });

  it('returns null when no lane passes anywhere near the spawn annulus', () => {
    const lanes: SkyLane[] = [{ axis: 'x', fixed: 5, altitude: 104, start: 0, end: 10 }];
    const rng = createRng('flying-out-of-range');
    // Player is far from the only lane's entire short span.
    expect(pickFlyingVehicleSpawn(lanes, 5000, 5000, 10, 50, rng, 30)).toBeNull();
  });

  it('produces both directions of travel over many draws', () => {
    const lanes: SkyLane[] = [{ axis: 'x', fixed: 100, altitude: 104, start: 0, end: 400 }];
    const rng = createRng('flying-directions');
    const seen = new Set<number>();
    for (let i = 0; i < 200; i++) {
      const result = pickFlyingVehicleSpawn(lanes, 100, 100, 0, 200, rng);
      if (result) seen.add(result.direction);
    }
    expect(seen.has(1)).toBe(true);
    expect(seen.has(-1)).toBe(true);
  });

  it('travelCoord always falls within the chosen lane\'s own [start, end) range', () => {
    const lanes: SkyLane[] = [{ axis: 'z', fixed: 50, altitude: 104, start: 20, end: 60 }];
    const rng = createRng('flying-travel-range');
    for (let i = 0; i < 100; i++) {
      const result = pickFlyingVehicleSpawn(lanes, 50, 40, 0, 100, rng);
      if (!result) continue;
      expect(result.travelCoord).toBeGreaterThanOrEqual(20);
      expect(result.travelCoord).toBeLessThan(60);
    }
  });
});

describe('isBeyondDespawnRadius', () => {
  it('is false for an entity within the despawn radius', () => {
    expect(isBeyondDespawnRadius(10, 10, 0, 0, 20)).toBe(false);
  });

  it('is true for an entity beyond the despawn radius', () => {
    expect(isBeyondDespawnRadius(100, 0, 0, 0, 20)).toBe(true);
  });
});
