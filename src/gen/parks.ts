/**
 * Park-district blocks: grass fill, a 2-wide gravel path cross connecting
 * all four block edges (so it always reaches the surrounding road) to a
 * central hub, scattered voxel trees kept clear of the paths, and a handful
 * of neon lamp posts along the path. `planPark` is pure (no World); `writePark`
 * performs the `setBlockRaw` calls.
 */

import type { CityBlock } from './layout';
import type { Rng } from './rng';
import { GRAVEL, METAL, NEON_CYAN, PARK_GRASS, TREE_LEAF, TREE_TRUNK } from '../world/BlockRegistry';
import type { World } from '../world/World';

const PARK_INSET = 1;
const TREE_MIN_TRUNK = 3;
const TREE_MAX_TRUNK = 5;
/** Roughly one tree per this many square voxels of plantable grass. */
const TREE_AREA_PER_TREE = 40;
const MIN_TREES = 2;
const LAMP_STRIDE = 10;
const LAMP_HEIGHT = 4;

export interface ParkTree {
  x: number;
  z: number;
  trunkHeight: number;
}

export interface ParkLamp {
  x: number;
  z: number;
}

export interface ParkPlan {
  /** Full block width x depth, minus PARK_INSET, filled with grass except where a path tile overrides it. */
  pathTiles: Array<{ x: number; z: number }>;
  trees: ParkTree[];
  lamps: ParkLamp[];
}

/** True if a tree trunk at (x, z) would put its trunk *or* any of its 8 canopy-spill neighbors on an obstacle column. */
function overlapsObstacle(x: number, z: number, obstacleColumns: ReadonlySet<string>): boolean {
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      if (obstacleColumns.has(`${x + dx},${z + dz}`)) return true;
    }
  }
  return false;
}

/**
 * Plans a park for one PARK-district block. The gravel path is a 2-wide
 * cross spanning the *entire* block rect (not the grass inset), so its four
 * arms run all the way out to the block's own edge cells. Those edge cells
 * are directly adjacent to the surrounding road band (every block in the
 * layout is bordered by road, never by another block), so the path connects
 * to the road through that adjacency rather than by stepping onto a road
 * cell itself — this is what "paths connect to road edges" means here.
 *
 * `obstacleColumns` — real generator-output testing (`CityGenerator.test.ts`'s
 * climb BFS) caught a tree planted directly in an elevated walkway's
 * staircase run: `CityGenerator` writes parks *after* walkways (see its own
 * doc comment for why billboards/bridges/parks are ordered the way they
 * are), so nothing previously stopped a tree's trunk or canopy from
 * re-solidifying a riser's headroom the same way the sky-lobby slab did to
 * bridge stairs. `obstacleColumns` is every (x, z) a walkway's deck or
 * staircase occupies, citywide; a tree roll (trunk *or* any of its 8 canopy
 * neighbors — the canopy spills one cell past the trunk, see `writeTree`)
 * that would land on one is skipped exactly like a roll landing on the
 * park's own path.
 */
export function planPark(block: CityBlock, rng: Rng, obstacleColumns: ReadonlySet<string> = new Set()): ParkPlan {
  const centerX = block.x + Math.floor(block.width / 2);
  const centerZ = block.z + Math.floor(block.depth / 2);

  const pathSet = new Set<string>();
  const pathTiles: Array<{ x: number; z: number }> = [];
  const addTile = (x: number, z: number): void => {
    const key = `${x},${z}`;
    if (pathSet.has(key)) return;
    pathSet.add(key);
    pathTiles.push({ x, z });
  };

  for (let x = block.x; x < block.x + block.width; x++) {
    addTile(x, centerZ);
    addTile(x, centerZ + 1);
  }
  for (let z = block.z; z < block.z + block.depth; z++) {
    addTile(centerX, z);
    addTile(centerX + 1, z);
  }

  const grassX = block.x + PARK_INSET;
  const grassZ = block.z + PARK_INSET;
  const grassWidth = block.width - PARK_INSET * 2;
  const grassDepth = block.depth - PARK_INSET * 2;

  const treeRng = rng.fork('trees');
  const treeCount = Math.max(MIN_TREES, Math.round((grassWidth * grassDepth) / TREE_AREA_PER_TREE));
  const trees: ParkTree[] = [];
  const maxAttempts = treeCount * 8;
  for (let attempt = 0; trees.length < treeCount && attempt < maxAttempts; attempt++) {
    const x = treeRng.intRange(grassX, grassX + grassWidth - 1);
    const z = treeRng.intRange(grassZ, grassZ + grassDepth - 1);
    if (pathSet.has(`${x},${z}`)) continue;
    if (overlapsObstacle(x, z, obstacleColumns)) continue;
    trees.push({ x, z, trunkHeight: treeRng.intRange(TREE_MIN_TRUNK, TREE_MAX_TRUNK) });
  }

  const lamps: ParkLamp[] = pathTiles.filter((_, i) => i % LAMP_STRIDE === 0);

  return { pathTiles, trees, lamps };
}

function writeTree(world: World, tree: ParkTree, baseY: number): void {
  const topY = baseY + tree.trunkHeight - 1;
  for (let h = 0; h < tree.trunkHeight; h++) {
    world.setBlockRaw(tree.x, baseY + h, tree.z, TREE_TRUNK);
  }

  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      if (dx === 0 && dz === 0) continue; // leave the trunk's own top voxel as trunk
      world.setBlockRaw(tree.x + dx, topY, tree.z + dz, TREE_LEAF);
      world.setBlockRaw(tree.x + dx, topY + 1, tree.z + dz, TREE_LEAF);
    }
  }
  world.setBlockRaw(tree.x, topY + 1, tree.z, TREE_LEAF);
  world.setBlockRaw(tree.x, topY + 2, tree.z, TREE_LEAF);
}

function writeLamp(world: World, lamp: ParkLamp, baseY: number): void {
  for (let h = 0; h < LAMP_HEIGHT; h++) {
    world.setBlockRaw(lamp.x, baseY + h, lamp.z, METAL);
  }
  world.setBlockRaw(lamp.x, baseY + LAMP_HEIGHT, lamp.z, NEON_CYAN);
}

/**
 * Writes a planned park. `groundSurfaceY` is the world Y of the walkable
 * ground surface row (the same row `CityGenerator.paintGround` fills with
 * ASPHALT/SIDEWALK) — parks overwrite it with grass/gravel instead.
 */
export function writePark(world: World, block: CityBlock, plan: ParkPlan, groundSurfaceY: number): void {
  const pathSet = new Set(plan.pathTiles.map((t) => `${t.x},${t.z}`));

  for (let x = block.x; x < block.x + block.width; x++) {
    for (let z = block.z; z < block.z + block.depth; z++) {
      const isPath = pathSet.has(`${x},${z}`);
      world.setBlockRaw(x, groundSurfaceY, z, isPath ? GRAVEL : PARK_GRASS);
    }
  }

  const baseY = groundSurfaceY + 1;
  for (const tree of plan.trees) writeTree(world, tree, baseY);
  for (const lamp of plan.lamps) writeLamp(world, lamp, baseY);
}
