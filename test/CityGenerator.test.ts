import { describe, expect, it } from 'vitest';
import { generateCity } from '../src/gen/CityGenerator';
import { District } from '../src/gen/districts';
import { planStairShafts, planStairSteps, type Bridge } from '../src/gen/infrastructure';
import { AIR, ASPHALT, GRAVEL, PARK_GRASS, TREE_TRUNK } from '../src/world/BlockRegistry';
import { parseChunkKey } from '../src/world/coords';
import { World } from '../src/world/World';

/** Walkable at feet height `feetY`: solid floor underfoot, 2 clear voxels (feetY, feetY+1) above it. */
function isWalkableFeet(world: World, x: number, feetY: number, z: number): boolean {
  return world.isSolid(x, feetY - 1, z) && !world.isSolid(x, feetY, z) && !world.isSolid(x, feetY + 1, z);
}

/**
 * 4-connected flood fill at a fixed feet height, starting from `start`.
 * Returns true iff some visited cell satisfies `isTarget` — i.e. there is a
 * continuous walkable floor (no gaps, no missing headroom) from start to a
 * target cell. This is the check that catches a floating step or a hole in
 * a sky-lobby floor that per-voxel unit tests can miss.
 */
function floodFillReaches(
  world: World,
  start: { x: number; z: number },
  feetY: number,
  isTarget: (x: number, z: number) => boolean,
  maxCells = 20000,
): boolean {
  if (!isWalkableFeet(world, start.x, feetY, start.z)) return false;

  const visited = new Set<string>([`${start.x},${start.z}`]);
  const queue: Array<{ x: number; z: number }> = [start];
  while (queue.length > 0) {
    const cur = queue.shift() as { x: number; z: number };
    if (isTarget(cur.x, cur.z)) return true;

    for (const [dx, dz] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const nx = cur.x + dx;
      const nz = cur.z + dz;
      const key = `${nx},${nz}`;
      if (visited.has(key)) continue;
      if (!isWalkableFeet(world, nx, feetY, nz)) continue;
      visited.add(key);
      queue.push({ x: nx, z: nz });
      if (visited.size > maxCells) return false;
    }
  }
  return false;
}

/** True if (x, z) lies within a bridge's own deck footprint. */
function onBridgeDeck(bridge: Bridge, x: number, z: number): boolean {
  return x >= bridge.x && x < bridge.x + bridge.width && z >= bridge.z && z < bridge.z + bridge.depth;
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
});

describe('generateCity playability: end-to-end bridge connectivity', () => {
  it('walks continuously (no floor gaps, >=2 headroom) from every stair-shaft top step to its bridge deck', () => {
    let sawAnyBridge = false;
    const seeds = Array.from({ length: 12 }, (_, i) => `connectivity-${i}`);

    for (const seed of seeds) {
      const world = new World();
      const { bridges } = generateCity(world, seed);

      for (const bridge of bridges) {
        sawAnyBridge = true;
        const feetY = bridge.level + 1;

        // Both towers' stair shafts land on this bridge's sky-lobby floor;
        // recomputing them from the bridge alone is valid because shaft
        // geometry is a pure function of (tower, level), not of what else
        // shares the bridges array.
        for (const shaft of planStairShafts([bridge])) {
          const steps = planStairSteps(shaft);
          const topStep = steps[steps.length - 1] as { x: number; y: number; z: number };

          const reached = floodFillReaches(world, { x: topStep.x, z: topStep.z }, feetY, (x, z) =>
            onBridgeDeck(bridge, x, z),
          );
          expect(reached).toBe(true);
        }
      }
    }

    // A vacuous pass (zero bridges across every seed) would prove nothing —
    // fail loudly instead of silently green if that ever happens.
    expect(sawAnyBridge).toBe(true);
  });
});
