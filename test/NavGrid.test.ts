import { describe, expect, it } from 'vitest';
import { buildNavGrid, isElevatedWalkableCell, isRoadCell, isSidewalkCell } from '../src/entities/NavGrid';
import { GROUND_SURFACE_Y, generateCity } from '../src/gen/CityGenerator';
import { planSkyLobbies, WALKWAY_Y, type Bridge, type SkyLobby, type Walkway } from '../src/gen/infrastructure';
import { AIR, ASPHALT, CONCRETE, GRAVEL, SIDEWALK } from '../src/world/BlockRegistry';
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

/** A sky lobby's own real floor footprint (its tier rect minus `openColumns`, the shaft-continuation holes `writeSkyLobby` deliberately leaves open) -- the ground truth `NavGrid.ts`'s bounded tower-lobby flood should stay within. */
function skyLobbyFootprintCells(lobby: SkyLobby): Array<{ x: number; z: number }> {
  const open = new Set(lobby.openColumns.map((c) => `${c.x},${c.z}`));
  const cells: Array<{ x: number; z: number }> = [];
  for (let dx = 0; dx < lobby.width; dx++) {
    for (let dz = 0; dz < lobby.depth; dz++) {
      const x = lobby.x + dx;
      const z = lobby.z + dz;
      if (open.has(`${x},${z}`)) continue;
      cells.push({ x, z });
    }
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

  it('never marks a walkable elevated cell that is not part of some real bridge/walkway/sky-lobby footprint (no rooftop-parapet or other false positives)', () => {
    // The subset check Sam's review flagged as missing: it's not enough to
    // prove every real bridge/walkway cell is found (the two tests above) --
    // a scan that also picks up unrelated METAL-with-clearance geometry
    // (rooftop parapet trim sitting on a solid roof, an antenna platform,
    // etc.) would still pass those, while still populating pedestrians on a
    // skyscraper roof edge that was never a deck. This asserts the reverse
    // direction: scanned walkable cells ⊆ real bridge/walkway/sky-lobby
    // footprints -- `planSkyLobbies` (the same pure planner `generateCity`
    // itself calls to write the real lobby slabs) is the ground truth for a
    // tower's own sky-lobby floor, exactly as `bridges`/`walkways` already
    // are for a deck.
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
      for (const lobby of planSkyLobbies(bridges)) {
        for (const { x, z } of skyLobbyFootprintCells(lobby)) realDeckCellKeys.add(`${lobby.y},${x},${z}`);
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

// ---------------------------------------------------------------------------
// stairLinks, derived from real generator output. `deriveStairLinks` walks a
// monotonic chain of stair-tread voxels purely by content (see NavGrid.ts's
// own doc comment for why that's what disambiguates a real stair from an
// ordinary CONCRETE floor slab), so these tests hold it to the same "prove it
// against real generated cities" bar as the elevated-level tests above,
// cross-checked against `planWalkways`' own `stairSteps` plan (test-only —
// production code never reads it, only the voxels it wrote).
// ---------------------------------------------------------------------------

describe('buildNavGrid stairLinks (real generator output)', () => {
  const seeds = Array.from({ length: 10 }, (_, i) => `stair-links-${i}`);

  /**
   * Whether `link`'s risers are exactly `walkway`'s own real riser sequence
   * (ignoring `link`'s extra ground-landing entry at index 0, and its extra
   * deck-landing entry at the very end -- `deriveStairLinks` adds both of
   * those on top of the risers `writeSteps` wrote, which is exactly
   * `walkway.stairSteps`). Matching this way, rather than by the ground
   * landing cell, is deliberate: a stair's real riser geometry is the one
   * thing `planWalkways` fully determines, but its ground *landing* cell is
   * not uniquely determined by design -- the sidewalk at the stair's base is
   * often walkable on more than one side, and `deriveStairLinks` picks
   * whichever real sidewalk neighbor it finds first (any of them is a
   * legitimate place to start climbing), not necessarily the one directly
   * "behind" the bottom riser.
   */
  function linkMatchesWalkwayRisers(link: { steps: ReadonlyArray<{ x: number; y: number; z: number }> }, walkway: Walkway): boolean {
    const risers = link.steps.slice(1, link.steps.length - 1);
    if (risers.length !== walkway.stairSteps.length) return false;
    return risers.every((s, i) => {
      const real = walkway.stairSteps[i] as { x: number; y: number; z: number };
      return s.x === real.x && s.y === real.y && s.z === real.z;
    });
  }

  it('finds every real walkway stair whose base sits on real sidewalk, its steps monotonic in y and every step properly footed', () => {
    let linksChecked = 0;
    let walkwaysMatched = 0;

    for (const seed of seeds) {
      const world = new World();
      const { walkways } = generateCity(world, seed);
      const grid = buildNavGrid(world, WORLD_SIZE_X, WORLD_SIZE_Z, GROUND_SURFACE_Y);

      const walkwaysWithStairs = walkways.filter((w) => w.stairSteps.length > 0);
      // A tower's own internal spiral stairs also produce `stairLinks` now
      // (see `NavGrid.ts`'s tower-lobby derivation) -- scope this walkway-only
      // check to links actually landing on `WALKWAY_Y`, the same way the
      // assertions below do.
      const walkwayLinks = grid.stairLinks.filter((link) => link.levelY === WALKWAY_Y);
      // Never more links than real walkways -- a link only exists per genuine stair.
      expect(walkwayLinks.length).toBeLessThanOrEqual(walkwaysWithStairs.length);

      for (const walkway of walkwaysWithStairs) {
        if (walkwayLinks.some((link) => linkMatchesWalkwayRisers(link, walkway))) walkwaysMatched++;
      }

      for (const link of walkwayLinks) {
        expect(link.levelY).toBe(WALKWAY_Y);

        // Monotonic in y, one riser at a time, ground cell first -- except the
        // very last hop (top tread -> deck), which is a flat lateral step onto
        // the deck's own y (see `StairLink`'s doc comment).
        expect(link.steps[0]?.y).toBe(GROUND_SURFACE_Y);
        expect(link.steps[link.steps.length - 1]?.y).toBe(WALKWAY_Y);
        for (let i = 1; i < link.steps.length - 1; i++) {
          expect(link.steps[i]?.y).toBe((link.steps[i - 1]?.y as number) + 1);
        }
        expect(link.steps[link.steps.length - 1]?.y).toBe(link.steps[link.steps.length - 2]?.y);

        // Every step properly footed: solid directly beneath, clear at foot height.
        for (const step of link.steps) {
          expect(world.isSolid(step.x, step.y, step.z)).toBe(true);
          expect(world.getBlock(step.x, step.y + 1, step.z)).toBe(AIR);
        }

        // The ground landing is a genuine sidewalk/gravel cell, and the deck
        // landing a genuine elevated-deck cell -- not just "some CONCRETE".
        expect(isSidewalkCell(grid, link.steps[0]?.x as number, link.steps[0]?.z as number)).toBe(true);
        const levelIndex = grid.elevatedLevels.findIndex((l) => l.y === WALKWAY_Y);
        expect(
          isElevatedWalkableCell(grid, levelIndex, link.steps[link.steps.length - 1]?.x as number, link.steps[link.steps.length - 1]?.z as number),
        ).toBe(true);

        linksChecked++;
      }
    }

    // Neutralize checks: if no seed produced a walkway stair at all, or the
    // riser-matching predicate itself was broken, every assertion above (and
    // `walkwaysMatched`) would be vacuously satisfied.
    expect(linksChecked).toBeGreaterThan(0);
    expect(walkwaysMatched).toBeGreaterThan(0);
  });

  it('never produces a step sequence that regresses, or repeats a y anywhere but the final deck landing (revert-probe: a broken monotonic check would let a flat floor slab masquerade as a stair)', () => {
    let linksChecked = 0;

    for (const seed of seeds) {
      const world = new World();
      generateCity(world, seed);
      const grid = buildNavGrid(world, WORLD_SIZE_X, WORLD_SIZE_Z, GROUND_SURFACE_Y);

      for (const link of grid.stairLinks) {
        const ys = link.steps.map((s) => s.y);
        const sorted = [...ys].sort((a, b) => a - b);
        expect(ys).toEqual(sorted); // never decreases, ground to deck

        // Exactly one repeated y is allowed (the top tread and the deck it
        // leads onto, both at levelY) -- a real stair never repeats anywhere
        // else, unlike a flat floor slab, which would repeat throughout.
        const repeats = ys.length - new Set(ys).size;
        expect(repeats).toBe(1);

        linksChecked++;
      }
    }

    expect(linksChecked).toBeGreaterThan(0);
  });
});
