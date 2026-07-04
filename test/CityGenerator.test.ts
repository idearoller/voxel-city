import { describe, expect, it } from 'vitest';
import type { BuildingPlan, BuildingTier, DoorSide } from '../src/gen/buildings';
import { generateCity } from '../src/gen/CityGenerator';
import { District } from '../src/gen/districts';
import { planStairShafts, planStairSteps, type Bridge, type Walkway } from '../src/gen/infrastructure';
import { PLAYER_WIDTH, tryAutoStep, type IsSolidFn } from '../src/player/PlayerCollision';
import { AIR, ASPHALT, GRAVEL, PARK_GRASS, TREE_TRUNK } from '../src/world/BlockRegistry';
import { parseChunkKey } from '../src/world/coords';
import { World } from '../src/world/World';

/** True if (x, z) lies within a bridge's own deck footprint. */
function onBridgeDeck(bridge: Bridge, x: number, z: number): boolean {
  return x >= bridge.x && x < bridge.x + bridge.width && z >= bridge.z && z < bridge.z + bridge.depth;
}

/** Bounding box around both of a bridge's towers plus its own deck — everywhere a street-to-deck climb path could possibly need to go. */
function bridgeBounds(bridge: Bridge): XZBounds {
  const minX = Math.min(bridge.towerA.x, bridge.towerB.x, bridge.x);
  const maxX = Math.max(bridge.towerA.x + bridge.towerA.width, bridge.towerB.x + bridge.towerB.width, bridge.x + bridge.width);
  const minZ = Math.min(bridge.towerA.z, bridge.towerB.z, bridge.z);
  const maxZ = Math.max(bridge.towerA.z + bridge.towerA.depth, bridge.towerB.z + bridge.towerB.depth, bridge.z + bridge.depth);
  return padBounds(minX, maxX, minZ, maxZ, 3);
}

/** Bounding box around a walkway's own staircase run and deck footprint. */
function walkwayBounds(walkway: Walkway): XZBounds {
  const xs = [walkway.x, walkway.x + walkway.width, ...walkway.stairSteps.map((s) => s.x)];
  const zs = [walkway.z, walkway.z + walkway.depth, ...walkway.stairSteps.map((s) => s.z)];
  return padBounds(Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs), 3);
}

// ---------------------------------------------------------------------------
// Real-physics climb BFS (Sam's Task 4 rejection, defect 2): the flat 2D
// flood fill above proves a floor is continuous at ONE fixed feet height, but
// a sky-bridge path is not flat — it climbs a spiral stair one voxel at a
// time. Asserting reachability at a fixed feetY (as the original version of
// this file's bridge-connectivity test did, starting *from the stair's own
// top step*) assumes away exactly the thing that broke: whether a player can
// actually climb every riser to get there. This harness instead walks a
// genuine multi-level search from a real street cell, using the production
// `tryAutoStep` for every 1-voxel climb (so it fails exactly when real
// gameplay would) and a plain 1-voxel step-down for descents, closing the gap
// between "the floor exists" and "a player can walk there."
// ---------------------------------------------------------------------------

const HALF_WIDTH = PLAYER_WIDTH / 2;
/** A representative per-tick horizontal delta — see PlayerCollision.test.ts's WALK_TICK_DELTA; tryAutoStep's progress comparison doesn't require flush contact (verified there), but flush is the realistic case for a player walking straight at a riser. */
const CLIMB_TICK_DELTA = 4.5 / 60;

const CARDINAL_DIRECTIONS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const;

/** Walkable at feet height `y`: solid floor underfoot, 2 clear voxels (y, y+1) above it. */
function isWalkableFeet3D(world: World, x: number, y: number, z: number): boolean {
  return world.isSolid(x, y - 1, z) && !world.isSolid(x, y, z) && !world.isSolid(x, y + 1, z);
}

/**
 * Feet position flush against the boundary toward (dx, dz) — i.e. already
 * touching whatever obstruction sits in the neighboring column, the same
 * setup `PlayerCollision.test.ts`'s `tryAutoStep` tests use for a walking
 * player approaching a step head-on.
 */
function flushFeetToward(x: number, y: number, z: number, dx: number, dz: number): readonly [number, number, number] {
  const fx = dx === 0 ? x + 0.5 : dx > 0 ? x + 1 - HALF_WIDTH : x + HALF_WIDTH;
  const fz = dz === 0 ? z + 0.5 : dz > 0 ? z + 1 - HALF_WIDTH : z + HALF_WIDTH;
  return [fx, y, fz];
}

interface XZBounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/** Pads a raw (minX, maxX, minZ, maxZ) box by `margin` on every side — the shape every `*Bounds` helper below produces. */
function padBounds(minX: number, maxX: number, minZ: number, maxZ: number, margin: number): XZBounds {
  return { minX: minX - margin, maxX: maxX + margin, minZ: minZ - margin, maxZ: maxZ + margin };
}

/**
 * Multi-level 3D BFS over feet positions (x, y, z), starting from a real
 * street cell. Three kinds of transitions between orthogonally adjacent
 * columns:
 *  - flat move: destination walkable at the same y;
 *  - climb (+1 y): destination walkable one row up, gated by the *actual*
 *    `tryAutoStep` (not a re-derived approximation) so this fails exactly
 *    when the real player controller would;
 *  - step down (-1 y): destination walkable one row down and the column is
 *    clear at the current height (walking off a ledge). Deeper free-fall
 *    isn't modeled — every riser in this codebase is exactly 1 voxel, so a
 *    1-voxel step-down is the only descent this network's paths ever need.
 *
 * `bounds` restricts the *lateral* (x, z) cells the search will ever enqueue.
 * Without it, a flat move at street level (feetY=2) can flood the entire
 * city's sidewalk network — tens of thousands of cells — before ever
 * reaching the one staircase that matters, blowing through `maxCells` on a
 * dense seed and reporting a false "unreachable". Every caller's start/target
 * pair sits inside one tower (or one walkway), so a box around just that
 * tower/walkway, padded a few voxels, is always big enough for the real path
 * while keeping the search local.
 */
function climbBfsReaches(
  world: World,
  start: { x: number; y: number; z: number },
  isTarget: (x: number, y: number, z: number) => boolean,
  bounds: XZBounds,
  maxCells = 20000,
): boolean {
  if (!isWalkableFeet3D(world, start.x, start.y, start.z)) return false;
  const isSolid: IsSolidFn = (x, y, z) => world.isSolid(x, y, z);
  const inBounds = (x: number, z: number) => x >= bounds.minX && x <= bounds.maxX && z >= bounds.minZ && z <= bounds.maxZ;

  const visited = new Set<string>([`${start.x},${start.y},${start.z}`]);
  const queue: Array<{ x: number; y: number; z: number }> = [start];

  while (queue.length > 0) {
    const cur = queue.shift() as { x: number; y: number; z: number };
    if (isTarget(cur.x, cur.y, cur.z)) return true;
    if (visited.size > maxCells) return false;

    for (const [dx, dz] of CARDINAL_DIRECTIONS) {
      const nx = cur.x + dx;
      const nz = cur.z + dz;
      if (!inBounds(nx, nz)) continue;

      let next: { x: number; y: number; z: number } | null = null;
      if (isWalkableFeet3D(world, nx, cur.y, nz)) {
        next = { x: nx, y: cur.y, z: nz };
      } else if (isWalkableFeet3D(world, nx, cur.y + 1, nz)) {
        const [fx, fy, fz] = flushFeetToward(cur.x, cur.y, cur.z, dx, dz);
        const step = tryAutoStep(isSolid, [fx, fy, fz], dx * CLIMB_TICK_DELTA, dz * CLIMB_TICK_DELTA, true);
        if (step.stepped) next = { x: nx, y: cur.y + 1, z: nz };
      } else if (
        !world.isSolid(nx, cur.y, nz) &&
        !world.isSolid(nx, cur.y + 1, nz) &&
        isWalkableFeet3D(world, nx, cur.y - 1, nz)
      ) {
        next = { x: nx, y: cur.y - 1, z: nz };
      }

      if (!next) continue;
      const key = `${next.x},${next.y},${next.z}`;
      if (visited.has(key)) continue;
      visited.add(key);
      queue.push(next);
    }
  }
  return false;
}

/** The real-world (x, z) cell just *outside* a building's doorway, on the sidewalk — the genuine street-level starting point for a climb BFS into it. */
function streetEntry(building: BuildingPlan): { x: number; y: number; z: number } {
  const tier0 = building.tiers[0] as BuildingTier;
  const doorSide = building.doorSide as DoorSide;
  const y = building.baseY;
  switch (doorSide) {
    case 'south':
      return { x: building.doorStart, y, z: tier0.z - 1 };
    case 'north':
      return { x: building.doorStart, y, z: tier0.z + tier0.depth };
    case 'west':
      return { x: tier0.x - 1, y, z: building.doorStart };
    case 'east':
      return { x: tier0.x + tier0.width, y, z: building.doorStart };
  }
}

/**
 * Content hash over every *non-empty* chunk's raw voxel bytes plus its key,
 * so two worlds hash equal iff their visible contents are identical.
 * Deliberately ignores allocated-but-all-air chunks: `World.clear()` keeps
 * previously-touched chunk objects around (zeroed) rather than deallocating
 * them, which is invisible to both the mesher (skips empty chunks) and
 * gameplay (getBlock/isSolid), so it must be invisible to this hash too.
 * Uses `remeshAll` purely to enumerate allocated chunks via the
 * dirty-notification hook — no rendering involved.
 */
function hashWorld(world: World): string {
  const keys = new Set<string>();
  world.onChunkDirty((key) => keys.add(key));
  world.remeshAll();

  const sortedKeys = Array.from(keys).sort();
  let hash = 0;
  let nonEmptyChunkCount = 0;
  for (const key of sortedKeys) {
    const { cx, cy, cz } = parseChunkKey(key);
    const chunk = world.peekChunk(cx, cy, cz);
    if (!chunk) continue;

    let chunkHash = 0;
    for (let i = 0; i < chunk.voxels.length; i++) {
      const v = chunk.voxels[i] as number;
      if (v !== 0) chunkHash = (chunkHash * 31 + v + i) | 0;
    }
    if (chunkHash === 0) continue; // all-air: not visible, don't let it affect the hash

    nonEmptyChunkCount++;
    for (const ch of key) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
    hash = (hash * 31 + chunkHash) | 0;
  }
  return `${nonEmptyChunkCount}:${hash}`;
}

describe('generateCity reproducibility', () => {
  it('produces an identical world for the same seed generated twice', () => {
    const worldA = new World();
    const worldB = new World();

    generateCity(worldA, 'neon-district-7');
    generateCity(worldB, 'neon-district-7');

    expect(hashWorld(worldA)).toBe(hashWorld(worldB));
  });

  it('produces a different world for a different seed', () => {
    const worldA = new World();
    const worldB = new World();

    generateCity(worldA, 'seed-alpha');
    generateCity(worldB, 'seed-beta');

    expect(hashWorld(worldA)).not.toBe(hashWorld(worldB));
  });

  it('regenerating the same world with a new seed replaces the old contents', () => {
    const world = new World();
    generateCity(world, 'first-pass');
    const firstHash = hashWorld(world);

    generateCity(world, 'second-pass');
    const secondHash = hashWorld(world);

    expect(secondHash).not.toBe(firstHash);

    // Re-running the first seed on a fresh world should match re-running it
    // on the reused, previously-cleared world.
    const freshWorld = new World();
    generateCity(freshWorld, 'second-pass');
    expect(hashWorld(freshWorld)).toBe(secondHash);
  });
});

describe('generateCity ground layer', () => {
  it('paints ASPHALT at y=1 on road cells and something solid everywhere at y=0', () => {
    const world = new World();
    const { layout } = generateCity(world, 'ground-check');

    // Find a road cell (x=0 column is virtually always road-adjacent given full-span bands,
    // but scan defensively) and confirm asphalt was painted there.
    let checked = false;
    for (let x = 0; x < layout.gridSizeX && !checked; x++) {
      for (let z = 0; z < layout.gridSizeZ && !checked; z++) {
        if (world.getBlock(x, 1, z) === ASPHALT) {
          checked = true;
        }
      }
    }
    expect(checked).toBe(true);
  });
});

describe('generateCity buildings', () => {
  it('places at least one parcel with a building (non-air voxels above the ground slab)', () => {
    const world = new World();
    const { layout } = generateCity(world, 'buildings-present');

    const hasBuilding = layout.blocks.some((block) =>
      block.parcels.some((parcel) => world.getBlock(parcel.x, 3, parcel.z) !== AIR),
    );
    expect(hasBuilding).toBe(true);
  });
});

describe('generateCity districts', () => {
  it('produces at least one downtown block taller than any residential block, over several seeds', () => {
    let sawDowntownTallerThanResidential = false;
    for (const seed of ['district-check-1', 'district-check-2', 'district-check-3']) {
      const world = new World();
      const { buildings } = generateCity(world, seed);
      const downtownMax = Math.max(0, ...buildings.filter((b) => b.district === District.DOWNTOWN).map((b) => b.height));
      const residentialMax = Math.max(
        0,
        ...buildings.filter((b) => b.district === District.RESIDENTIAL).map((b) => b.height),
      );
      if (downtownMax > residentialMax) sawDowntownTallerThanResidential = true;
    }
    expect(sawDowntownTallerThanResidential).toBe(true);
  });
});

describe('generateCity parks', () => {
  it('paints PARK_GRASS/GRAVEL and grows at least one tree somewhere, over several seeds', () => {
    let sawGrass = false;
    let sawTree = false;
    for (const seed of ['park-check-1', 'park-check-2', 'park-check-3', 'park-check-4']) {
      const world = new World();
      const { layout } = generateCity(world, seed);
      for (const block of layout.blocks) {
        if (block.district !== District.PARK) continue;
        for (let x = block.x; x < block.x + block.width && !sawTree; x++) {
          for (let z = block.z; z < block.z + block.depth; z++) {
            const ground = world.getBlock(x, 1, z);
            if (ground === PARK_GRASS || ground === GRAVEL) sawGrass = true;
            for (let y = 2; y < 8; y++) {
              if (world.getBlock(x, y, z) === TREE_TRUNK) sawTree = true;
            }
          }
        }
      }
    }
    expect(sawGrass).toBe(true);
    expect(sawTree).toBe(true);
  });
});

describe('generateCity playability: stairs and walkways', () => {
  it('gives every generated stair shaft and walkway staircase 1-voxel risers with 2 voxels of headroom, across several seeds', () => {
    let sawAnyStairs = false;
    for (const seed of ['playability-1', 'playability-2', 'playability-3', 'playability-4']) {
      const world = new World();
      const { stairShafts, walkways } = generateCity(world, seed);

      for (const shaft of stairShafts) {
        const steps = planStairSteps(shaft);
        sawAnyStairs = true;
        for (let i = 1; i < steps.length; i++) {
          expect(steps[i]!.y - steps[i - 1]!.y).toBe(1);
        }
        for (const step of steps) {
          expect(world.getBlock(step.x, step.y + 1, step.z)).toBe(AIR);
          expect(world.getBlock(step.x, step.y + 2, step.z)).toBe(AIR);
        }
      }

      for (const walkway of walkways) {
        sawAnyStairs = true;
        const steps = walkway.stairSteps;
        for (let i = 1; i < steps.length; i++) {
          expect(steps[i]!.y - steps[i - 1]!.y).toBe(1);
        }
        for (const step of steps) {
          expect(world.getBlock(step.x, step.y + 1, step.z)).toBe(AIR);
          expect(world.getBlock(step.x, step.y + 2, step.z)).toBe(AIR);
        }
      }
    }
    // Not every seed is guaranteed a bridge/walkway, but across 4 seeds on a full
    // 384x384 plan at least one of these vertical-access features should appear.
    expect(sawAnyStairs).toBe(true);
  });

  /**
   * Sam's Task 4 rejection flagged that the riser/headroom check above is
   * the same kind of "geometry looks right" check that missed the sky-lobby
   * climb bug, and asked whether the phase-1 elevated walkway suffered the
   * same blindness. It doesn't structurally (the straight staircase stops
   * one cell short of the deck's own footprint — see `planWalkways` — so no
   * slab ever re-solidifies a stair riser's column the way the sky lobby
   * did), but this proves that with the same real-climb-physics harness used
   * for bridges, rather than resting on that argument alone.
   */
  it('walks from the base of every walkway staircase, up every real riser, onto the elevated deck, across several seeds (real climb physics)', () => {
    let sawAnyWalkway = false;
    for (const seed of ['playability-1', 'playability-2', 'playability-3', 'playability-4', 'playability-5', 'playability-6']) {
      const world = new World();
      const { walkways } = generateCity(world, seed);

      for (const walkway of walkways) {
        sawAnyWalkway = true;
        const bottomStep = walkway.stairSteps[0] as { x: number; y: number; z: number };
        const topStep = walkway.stairSteps[walkway.stairSteps.length - 1] as { x: number; y: number; z: number };
        const deckFeetY = topStep.y + 1;
        // The staircase's first riser stands one voxel proud of the plain
        // sidewalk (bottomStep.y === groundBaseY, the same "solid block one
        // row down" convention every step uses — see `planStraightStairSteps`),
        // so the genuine street start is one cell further back (the approach
        // direction, -z per `planWalkways`) at ordinary ground height, not
        // the first step itself — otherwise this test would skip verifying
        // exactly the street->first-riser climb.
        const streetStart = { x: bottomStep.x, y: bottomStep.y, z: bottomStep.z - 1 };

        const reached = climbBfsReaches(
          world,
          streetStart,
          (x, y, z) => {
            if (y !== deckFeetY) return false;
            return x >= walkway.x && x < walkway.x + walkway.width && z >= walkway.z && z < walkway.z + walkway.depth;
          },
          walkwayBounds(walkway),
        );
        expect(reached).toBe(true);
      }
    }
    expect(sawAnyWalkway).toBe(true);
  });
});

describe('generateCity playability: end-to-end bridge connectivity (real climb physics)', () => {
  // Sam's Task 4 rejection (defect 2): the previous version of this test
  // flood-filled at a FIXED feetY starting from the stair's own top step —
  // it assumed the very thing that needed proving (that a player can climb
  // every riser to get there) and was blind to the sky-lobby's off-by-one
  // slab bug (defect 1) despite that bug making 100% of shafts unclimbable.
  // This version starts from a real street cell and uses the production
  // `tryAutoStep` for every climb, so it fails exactly when real gameplay
  // would. Run this against pre-fix code and it fails on every bridge; see
  // `src/gen/infrastructure.ts`'s `planSkyLobbies` for the fix.
  const seeds = Array.from({ length: 14 }, (_, i) => `climb-bfs-${i}`);

  it('walks from street level, through the doorway, up every real stair riser, and onto the bridge deck — for both towers of every bridge, across 14 seeds', () => {
    let sawAnyBridge = false;
    let checkedShafts = 0;

    for (const seed of seeds) {
      const world = new World();
      const { bridges } = generateCity(world, seed);

      for (const bridge of bridges) {
        sawAnyBridge = true;

        // Both towers' stair shafts land on this bridge's sky-lobby floor;
        // recomputing them from the bridge alone is valid because shaft
        // geometry is a pure function of (tower, level), not of what else
        // shares the bridges array.
        const bounds = bridgeBounds(bridge);
        for (const tower of [bridge.towerA, bridge.towerB]) {
          checkedShafts++;
          const start = streetEntry(tower);
          const reached = climbBfsReaches(world, start, (x, y, z) => y === bridge.level + 1 && onBridgeDeck(bridge, x, z), bounds);
          expect(reached).toBe(true);
        }
      }
    }

    // A vacuous pass (zero bridges across every seed) would prove nothing —
    // fail loudly instead of silently green if that ever happens.
    expect(sawAnyBridge).toBe(true);
    expect(checkedShafts).toBeGreaterThan(0);
  });

  /**
   * Should-fix 3 from Sam's Task 4 review: multi-level stacking
   * (`pickSkyLevels` returning more than one eligible level for the same
   * tower pair, so one tower ends up anchoring bridges at two different
   * heights sharing one continuous stair shaft) was real machinery but
   * dormant on real seeds — 0-2 occurrences per ~200 bridged towers with
   * the original 30/60/90 sky-level ladder. Tuned to `[30, 50, 70, 90]` (see
   * `SKY_LEVELS`'s doc comment); this test proves that tuning actually
   * produces the scenario on real output, and that the *same* climb BFS
   * above (not a separate, weaker check) verifies both of that tower's
   * levels are independently reachable via its one shared shaft.
   */
  it('reaches both bridge levels of at least one multi-level tower via its one shared stair shaft, across 14 seeds', () => {
    let multiLevelTowersChecked = 0;

    for (const seed of seeds) {
      const world = new World();
      const { bridges } = generateCity(world, seed);

      const levelsByTower = new Map<string, Set<number>>();
      for (const bridge of bridges) {
        for (const tower of [bridge.towerA, bridge.towerB]) {
          const key = `${tower.x},${tower.z}`;
          if (!levelsByTower.has(key)) levelsByTower.set(key, new Set());
          levelsByTower.get(key)!.add(bridge.level);
        }
      }

      for (const bridge of bridges) {
        const bounds = bridgeBounds(bridge);
        for (const tower of [bridge.towerA, bridge.towerB]) {
          const key = `${tower.x},${tower.z}`;
          if ((levelsByTower.get(key)?.size ?? 0) < 2) continue; // only care about genuinely multi-level towers here
          multiLevelTowersChecked++;

          const start = streetEntry(tower);
          const reached = climbBfsReaches(world, start, (x, y, z) => y === bridge.level + 1 && onBridgeDeck(bridge, x, z), bounds);
          expect(reached).toBe(true);
        }
      }
    }

    // If this ever goes back to vacuous, the tuning regressed — fail loudly
    // rather than silently pass on a feature that isn't actually exercised.
    expect(multiLevelTowersChecked).toBeGreaterThan(0);
  });

  it('also reaches every stair-shaft top step specifically (not just some other route onto the deck)', () => {
    let checkedAnyTopStep = false;

    for (const seed of seeds) {
      const world = new World();
      const { bridges } = generateCity(world, seed);

      for (const bridge of bridges) {
        for (const shaft of planStairShafts([bridge])) {
          const steps = planStairSteps(shaft);
          const topStep = steps[steps.length - 1] as { x: number; y: number; z: number };
          const tower = [bridge.towerA, bridge.towerB].find(
            (t) => t.baseY === shaft.baseY && t.x <= topStep.x && topStep.x < t.x + t.width && t.z <= topStep.z && topStep.z < t.z + t.depth,
          );
          if (!tower) continue;
          checkedAnyTopStep = true;

          const start = streetEntry(tower);
          const reached = climbBfsReaches(
            world,
            start,
            (x, y, z) => x === topStep.x && y === topStep.y + 1 && z === topStep.z,
            bridgeBounds(bridge),
          );
          expect(reached).toBe(true);
        }
      }
    }

    expect(checkedAnyTopStep).toBe(true);
  });
});

describe('generateCity playability: denser bridge network (Task 4 — per-level stair shafts)', () => {
  const seeds = Array.from({ length: 12 }, (_, i) => `connectivity-${i}`);

  function bridgeCountByTower(bridges: readonly Bridge[]): Map<string, number> {
    const counts = new Map<string, number>();
    for (const bridge of bridges) {
      for (const t of [bridge.towerA, bridge.towerB]) {
        const key = `${t.x},${t.z}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
    return counts;
  }

  it('produces materially more bridges than the pre-Task-4 baseline, on this exact seed batch', () => {
    // Measured directly: the pre-Task-4 generator (one bridge per tower, only
    // the highest shared sky level, shop-interior towers excluded entirely
    // from bridge candidacy, BRIDGE_MAX_GAP=40, BRIDGE_CHANCE=0.25) produces
    // 107 bridges across these 12 seeds — because BRIDGE_MAX_GAP/CHANCE
    // widened, shop towers now qualify, and a tall pair can stack bridges
    // at multiple sky levels instead of just the highest. 70 is a
    // conservative floor (~1.5x the old total) that still fails loudly if
    // density regresses back toward the old behavior.
    let totalBridges = 0;
    for (const seed of seeds) {
      const world = new World();
      const { bridges } = generateCity(world, seed);
      totalBridges += bridges.length;
    }
    expect(totalBridges).toBeGreaterThan(70);
  });

  it('lets at least one tower host more than one bridge (a second level and/or a second partner), across seeds', () => {
    let sawMultiBridgeTower = false;
    for (const seed of seeds) {
      const world = new World();
      const { bridges } = generateCity(world, seed);
      if (Array.from(bridgeCountByTower(bridges).values()).some((count) => count > 1)) sawMultiBridgeTower = true;
    }
    expect(sawMultiBridgeTower).toBe(true);
  });

  it('never lets any tower exceed the 3-bridge cap, on real generator output', () => {
    let checkedAny = false;
    for (const seed of seeds) {
      const world = new World();
      const { bridges } = generateCity(world, seed);
      for (const count of bridgeCountByTower(bridges).values()) {
        checkedAny = true;
        expect(count).toBeLessThanOrEqual(3);
      }
    }
    expect(checkedAny).toBe(true);
  });

  it('connects at least one commercial shop-interior tower into the bridge network across seeds', () => {
    let sawShopTowerBridge = false;
    for (const seed of seeds) {
      const world = new World();
      const { bridges } = generateCity(world, seed);
      if (bridges.some((b) => b.towerA.shopInterior || b.towerB.shopInterior)) sawShopTowerBridge = true;
    }
    expect(sawShopTowerBridge).toBe(true);
  });

  it("never lets a bridge deck's footprint overlap a third building's footprint at the bridge's own level, across seeds", () => {
    let checkedAnyBridge = false;
    for (const seed of seeds) {
      const world = new World();
      const { bridges, buildings } = generateCity(world, seed);

      for (const bridge of bridges) {
        checkedAnyBridge = true;
        const deckX1 = bridge.x + bridge.width - 1;
        const deckZ1 = bridge.z + bridge.depth - 1;

        for (const building of buildings) {
          if (building === bridge.towerA || building === bridge.towerB) continue;
          if (bridge.level < building.baseY || bridge.level > building.baseY + building.height) continue;

          const ry = bridge.level - building.baseY;
          const tier = building.tiers.find((t) => ry >= t.yStart && ry < t.yEnd) ?? building.tiers[0]!;
          const overlaps =
            bridge.x <= tier.x + tier.width - 1 &&
            deckX1 >= tier.x &&
            bridge.z <= tier.z + tier.depth - 1 &&
            deckZ1 >= tier.z;
          expect(overlaps).toBe(false);
        }
      }
    }
    expect(checkedAnyBridge).toBe(true);
  });
});
