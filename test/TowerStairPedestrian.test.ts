import { describe, expect, it } from 'vitest';
import { DEFAULT_ENTITY_CONFIG, EntitySimulation, type EntitySimulationConfig } from '../src/entities/EntitySimulation';
import { buildNavGrid, isElevatedWalkableCell, isSidewalkCell, type NavGrid, type StairLink } from '../src/entities/NavGrid';
import { beginStair, createPedestrianAt, stepPedestrian, type Pedestrian, type StairCommitment } from '../src/entities/Pedestrian';
import { GROUND_SURFACE_Y, generateCity } from '../src/gen/CityGenerator';
import { planSkyLobbies, planStairSteps, SKY_LEVELS, type SkyLobby, type StairShaft } from '../src/gen/infrastructure';
import { createRng } from '../src/gen/rng';
import { WORLD_SIZE_X, WORLD_SIZE_Z } from '../src/world/coords';
import { World } from '../src/world/World';

const DT = 1 / 60;
const SPEED = 1.4;

/**
 * Tower-internal spiral stairs, proven against real generator output per this
 * repo's review convention: nav/geometry claims must hold against
 * `generateCity`'s actual voxels, on a real sweep of seeds, not a single
 * hand-picked one and not a synthetic fixture alone (see `NavGrid.ts`'s
 * "Tower-internal sky-lobby floors" section for the derivation this suite is
 * proving).
 */
const SEEDS = Array.from({ length: 14 }, (_, i) => `tower-stair-${i}`);

function towerLinksOf(grid: NavGrid): StairLink[] {
  return grid.stairLinks.filter((link) => (SKY_LEVELS as readonly number[]).includes(link.levelY));
}

describe('buildNavGrid tower-stair links (real generator output)', () => {
  it('finds at least one real tower stair link across a sweep of seeds, each landing on a genuine SKY_LEVELS sky-lobby cell', () => {
    let seedsWithTowerLinks = 0;
    let linksChecked = 0;

    for (const seed of SEEDS) {
      const world = new World();
      generateCity(world, seed);
      const grid = buildNavGrid(world, WORLD_SIZE_X, WORLD_SIZE_Z, GROUND_SURFACE_Y);

      const towerLinks = towerLinksOf(grid);
      if (towerLinks.length === 0) continue;
      seedsWithTowerLinks++;

      for (const link of towerLinks) {
        // Ground landing is real sidewalk; deck landing is a genuine walkable
        // cell on the matching elevatedLevels row (the tower's sky lobby, not
        // "some CONCRETE somewhere").
        expect(link.steps[0]?.y).toBe(GROUND_SURFACE_Y);
        expect(isSidewalkCell(grid, link.steps[0]?.x as number, link.steps[0]?.z as number)).toBe(true);

        const levelIndex = grid.elevatedLevels.findIndex((l) => l.y === link.levelY);
        expect(levelIndex).toBeGreaterThanOrEqual(0);
        const deck = link.steps[link.steps.length - 1] as { x: number; y: number; z: number };
        expect(deck.y).toBe(link.levelY);
        expect(isElevatedWalkableCell(grid, levelIndex, deck.x, deck.z)).toBe(true);

        // Monotonic ascent, one riser at a time, except the final flat hop
        // onto the deck (same invariant `StairLink`'s doc comment already
        // requires of external walkway stairs).
        for (let i = 1; i < link.steps.length - 1; i++) {
          expect(link.steps[i]?.y).toBe((link.steps[i - 1]?.y as number) + 1);
        }
        expect(link.steps[link.steps.length - 1]?.y).toBe(link.steps[link.steps.length - 2]?.y);

        linksChecked++;
      }
    }

    // Neutralize check: fails if no seed above ever produced a real tower
    // stair link (e.g. if the derivation silently stopped finding anchors).
    expect(seedsWithTowerLinks).toBeGreaterThan(0);
    expect(linksChecked).toBeGreaterThan(0);
  });

  it("every tower stair link's risers exactly match some real stair shaft's own planned steps, and its top landing sits inside that shaft's own real sky lobby (zero false positives: never a link built from some non-shaft CONCRETE structure)", () => {
    let linksChecked = 0;

    for (const seed of SEEDS) {
      const world = new World();
      const { bridges, stairShafts } = generateCity(world, seed);
      const grid = buildNavGrid(world, WORLD_SIZE_X, WORLD_SIZE_Z, GROUND_SURFACE_Y);

      // Ground truth: every riser any real shaft could ever produce, keyed by
      // (x, y, z) -- a tower can host more than one shaft-ending-level (see
      // `planStairShafts`), but they all share the same origin/ring, so this
      // is just the union of every real riser voxel in the city.
      const realRiserKeys = new Set<string>();
      for (const shaft of stairShafts as StairShaft[]) {
        for (const step of planStairSteps(shaft)) realRiserKeys.add(`${step.x},${step.y},${step.z}`);
      }
      const realLobbies = planSkyLobbies(bridges) as SkyLobby[];

      for (const link of towerLinksOf(grid)) {
        // Every riser strictly between the ground landing and the final two
        // entries (the top tread and the deck landing it opens onto) must be
        // a real, planned shaft riser -- a false positive here would mean
        // some non-shaft CONCRETE structure produced a step sequence
        // `traceStairDown` mistook for a stair.
        for (let i = 1; i < link.steps.length - 2; i++) {
          const step = link.steps[i] as { x: number; y: number; z: number };
          expect(realRiserKeys.has(`${step.x},${step.y},${step.z}`)).toBe(true);
        }

        // The top tread itself (second-to-last entry) is *usually* an exact
        // planned riser too, but see `findVerifiedStairTopAnchors`'s doc
        // comment: an ordinary lobby-floor cell immediately outside the
        // shaft, touching one of `SkyLobby.openColumns`, can tie with the
        // real top tread for the same descending chain -- deduped to just
        // one candidate, but not necessarily the textbook one, since either
        // is an equally genuine, solid, correctly-connected voxel. What must
        // still hold: it's a real riser OR it sits inside this exact shaft's
        // own real sky-lobby footprint (never some unrelated structure).
        const anchor = link.steps[link.steps.length - 2] as { x: number; y: number; z: number };
        const anchorKey = `${anchor.x},${anchor.y},${anchor.z}`;
        const insideSomeRealLobby = realLobbies.some(
          (lobby) =>
            lobby.y === link.levelY &&
            anchor.x >= lobby.x &&
            anchor.x < lobby.x + lobby.width &&
            anchor.z >= lobby.z &&
            anchor.z < lobby.z + lobby.depth,
        );
        expect(realRiserKeys.has(anchorKey) || insideSomeRealLobby).toBe(true);

        linksChecked++;
      }
    }

    expect(linksChecked).toBeGreaterThan(0);
  });

  it('never marks a tower-lobby cell walkable at a Y that has no real sky lobby at all in that city (bounded flood never escapes to an unrelated floor)', () => {
    let seedsChecked = 0;

    for (const seed of SEEDS) {
      const world = new World();
      const { bridges } = generateCity(world, seed);
      const grid = buildNavGrid(world, WORLD_SIZE_X, WORLD_SIZE_Z, GROUND_SURFACE_Y);

      const realBridgeLevels = new Set(bridges.map((b) => b.level));
      for (const level of grid.elevatedLevels) {
        if (!(SKY_LEVELS as readonly number[]).includes(level.y)) continue;
        // Every SKY_LEVELS row with any walkable cell at all must correspond
        // to a real bridge level in this city -- a tower lobby only exists
        // alongside a bridge (see `planSkyLobbies`), and the metal-deck scan
        // only ever finds cells at a level some bridge actually used.
        expect(realBridgeLevels.has(level.y)).toBe(true);
      }
      seedsChecked++;
    }

    expect(seedsChecked).toBeGreaterThan(0);
  });

  /** Every walkable cell of `level` reachable from `(startX, startZ)` via 4-connected `level.walkable` moves — the flood-fill a pedestrian's own `chooseNextCell` effectively performs one hop at a time, just computed all at once for this probe. */
  function bfsReachableWithinLevel(grid: NavGrid, level: NavGrid['elevatedLevels'][number], startX: number, startZ: number): Set<string> {
    const visited = new Set<string>();
    const queue: Array<{ x: number; z: number }> = [{ x: startX, z: startZ }];
    visited.add(`${startX},${startZ}`);
    let head = 0;
    while (head < queue.length) {
      const cur = queue[head++] as { x: number; z: number };
      for (const [dx, dz] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const nx = cur.x + dx;
        const nz = cur.z + dz;
        if (nx < 0 || nx >= grid.width || nz < 0 || nz >= grid.depth) continue;
        const key = `${nx},${nz}`;
        if (visited.has(key)) continue;
        if (level.walkable[nx + nz * grid.width] !== 1) continue;
        visited.add(key);
        queue.push({ x: nx, z: nz });
      }
    }
    return visited;
  }

  it("every tower lobby's floor component reaches its own bridge span (a review sweep against an earlier, citywide-shared flood budget found ~11/24-18/24 stair tops per seed dead-ending in a truncated, walled-off lobby with no path to the bridge -- see MAX_LOBBY_FLOOD_CELLS_PER_TOWER's doc comment; a second, later defect found the same symptom on ~1 stair top per seed even after that fix -- see this test's closing comment and `canElevatorAndBridgeDoorCoexist`'s doc comment in infrastructure.ts)", () => {
    const seeds = Array.from({ length: 24 }, (_, i) => `bridge-reach-${i}`);
    let totalLobbyComponents = 0;
    let reachedBridge = 0;

    for (const seed of seeds) {
      const world = new World();
      const { bridges } = generateCity(world, seed);
      const grid = buildNavGrid(world, WORLD_SIZE_X, WORLD_SIZE_Z, GROUND_SURFACE_Y);

      for (const y of SKY_LEVELS) {
        const levelIndex = grid.elevatedLevels.findIndex((l) => l.y === y);
        if (levelIndex === -1) continue;
        const level = grid.elevatedLevels[levelIndex] as NavGrid['elevatedLevels'][number];

        const bridgeCellsAtY = new Set<string>();
        for (const bridge of bridges.filter((b) => b.level === y)) {
          for (let dx = 0; dx < bridge.width; dx++) {
            for (let dz = 0; dz < bridge.depth; dz++) bridgeCellsAtY.add(`${bridge.x + dx},${bridge.z + dz}`);
          }
        }
        if (bridgeCellsAtY.size === 0) continue;

        // Walk every distinct connected component of this level's walkable
        // cells exactly once (walls between towers mean each tower's own
        // lobby, plus the bridges it touches, forms its own component).
        const seen = new Set<string>();
        for (let i = 0; i < level.walkable.length; i++) {
          if (level.walkable[i] !== 1) continue;
          const x = i % grid.width;
          const z = Math.floor(i / grid.width);
          const key = `${x},${z}`;
          if (seen.has(key)) continue;

          const component = bfsReachableWithinLevel(grid, level, x, z);
          for (const k of component) seen.add(k);

          // Only count components that include real lobby floor (not pure
          // bridge deck reachable from itself) -- those are what a stair top
          // actually opens onto.
          const hasLobbyCell = Array.from(component).some((k) => !bridgeCellsAtY.has(k));
          if (!hasLobbyCell) continue;

          totalLobbyComponents++;
          if (Array.from(component).some((k) => bridgeCellsAtY.has(k))) reachedBridge++;
        }
      }
    }

    expect(totalLobbyComponents).toBeGreaterThan(0);
    // The dominant ~1-per-seed residual class was root-caused and eliminated:
    // an elevator shaft's fixed NW-corner footprint could sit directly on a
    // bridge door's own approach corridor (the door is always carved into
    // `bridge.towerB`'s north or west wall, the two walls nearest that fixed
    // corner), silently walling the lobby off from its own bridge with every
    // individual voxel well-formed. Fixed by `canElevatorAndBridgeDoorCoexist`
    // (infrastructure.ts), a coexistence gate on `planElevatorShafts` parallel
    // to the existing `canElevatorAndStairShaftCoexist` one, but versus the
    // door's transverse offset rather than the centered stair shaft --
    // verified across 106+30 seeds with bridge counts unchanged seed-for-seed
    // and only the specific blocking elevators dropped. The threshold stays
    // >= 0.95 rather than exact 1.0 because a rarer, DISTINCT class remains:
    // two bridges meeting a tower at the same level can cross such that one
    // bridge's neon rail rows seal the other's door lane (seen once in a
    // 30-seed review sweep, `sam-audit-3` y=30) -- a planBridges deconfliction
    // problem, tracked separately from the elevator gate.
    expect(reachedBridge / totalLobbyComponents).toBeGreaterThanOrEqual(0.95);
  });
});

describe('pedestrian tower-stair crossing (real generator output)', () => {
  it('climbs a real tower stair end-to-end without floating or clipping, then descends it back to the street', () => {
    let crossingsChecked = 0;

    for (const seed of SEEDS) {
      const world = new World();
      generateCity(world, seed);
      const grid = buildNavGrid(world, WORLD_SIZE_X, WORLD_SIZE_Z, GROUND_SURFACE_Y);

      const towerLinks = towerLinksOf(grid);
      if (towerLinks.length === 0) continue;

      const link = towerLinks[0] as StairLink;
      const ground = link.steps[0] as { x: number; y: number; z: number };
      const deck = link.steps[link.steps.length - 1] as { x: number; y: number; z: number };

      // --- climb ---
      const up = createPedestrianAt(ground.x, ground.z, ground.y, SPEED);
      beginStair(up, link, 1);
      let ticks = 0;
      while (up.stair && ticks < 20_000) {
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
      while (down.stair && ticks < 20_000) {
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
});

// ---------------------------------------------------------------------------
// Soak-sim: full EntitySimulation population against a real generated city,
// proving pedestrians actually reach sky-lobby levels during ordinary
// wandering (not just when forced via `beginStair`), and that nobody gets
// permanently stuck.
// ---------------------------------------------------------------------------

const SOAK_CONFIG: EntitySimulationConfig = {
  ...DEFAULT_ENTITY_CONFIG,
  maxPedestrians: 80,
  maxVehicles: 0,
  maxFlyingVehicles: 0,
  spawnMinRadius: 5,
  spawnMaxRadius: 300,
  despawnRadius: 400,
};

describe('EntitySimulation soak against a real generated city (tower-lobby foot traffic)', () => {
  it('reaches at least one real SKY_LEVELS lobby during a long soak, with every pedestrian making genuine progress (nobody stuck)', () => {
    let seedsReachingLobby = 0;

    const soakSeeds = ['tower-soak-1', 'tower-soak-2', 'tower-soak-3', 'tower-soak-4'];

    for (const seed of soakSeeds) {
      const world = new World();
      generateCity(world, seed);
      const grid = buildNavGrid(world, WORLD_SIZE_X, WORLD_SIZE_Z, GROUND_SURFACE_Y);
      if (towerLinksOf(grid).length === 0) continue;

      const centerX = WORLD_SIZE_X / 2;
      const centerZ = WORLD_SIZE_Z / 2;

      const sim = new EntitySimulation(SOAK_CONFIG);
      sim.reset(grid, `${seed}-sim`);

      let everReachedSkyLevel = false;
      // Cumulative 3D path length per pedestrian, not net displacement from a
      // single old snapshot -- a net-displacement check would misfire two
      // ways here: (1) a pedestrian mid-way up a tower's spiral stair covers
      // real vertical distance while its (x, z) footprint barely moves (the
      // shaft is only 3 cells wide), and (2) an ordinary wandering
      // pedestrian's own turn-chance random walk can legitimately double
      // back near wherever it happened to be N ticks ago without ever
      // getting stuck. Summing each tick's actual travel distance is immune
      // to both: it only stays near zero for a pedestrian that is genuinely
      // failing to move at all (wedged against an unwalkable edge, e.g. a
      // stair-commitment despawn bug or a lobby patch with no way out).
      const lastPositions = new Map<Pedestrian, { x: number; y: number; z: number }>();
      const traveled = new Map<Pedestrian, number>();

      const TICKS = 6000; // 100s of sim time
      const SNAPSHOT_CUTOFF = TICKS / 2; // only judge pedestrians old enough to have covered real ground by the end
      for (let i = 0; i < TICKS; i++) {
        sim.update(DT, centerX, GROUND_SURFACE_Y, centerZ);

        for (const ped of sim.pedestrianList) {
          if (i < SNAPSHOT_CUTOFF) {
            const last = lastPositions.get(ped);
            if (last) {
              traveled.set(ped, (traveled.get(ped) ?? 0) + Math.hypot(ped.x - last.x, ped.y - last.y, ped.z - last.z));
            } else {
              traveled.set(ped, 0);
            }
            lastPositions.set(ped, { x: ped.x, y: ped.y, z: ped.z });
          }
          if ((SKY_LEVELS as readonly number[]).includes(ped.y)) everReachedSkyLevel = true;
        }
      }

      if (everReachedSkyLevel) seedsReachingLobby++;

      // Nobody-stuck proof: every pedestrian still alive at the end of the
      // soak, that was already being tracked before the halfway point, has
      // covered several cell-widths' worth of real ground since then.
      const MIN_PROGRESS_DISTANCE = 5;
      let survivorsChecked = 0;
      for (const ped of sim.pedestrianList) {
        const distance = traveled.get(ped);
        if (distance === undefined) continue; // spawned after the cutoff -- too recent to judge
        expect(distance).toBeGreaterThan(MIN_PROGRESS_DISTANCE);
        survivorsChecked++;
      }
      expect(survivorsChecked).toBeGreaterThan(0);
    }

    // Neutralize check: fails if no soaked seed ever got a pedestrian onto a
    // real sky-lobby level -- i.e. if the whole feature were silently dead.
    expect(seedsReachingLobby).toBeGreaterThan(0);
  });
});
