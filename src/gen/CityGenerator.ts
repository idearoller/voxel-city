/**
 * Procgen pipeline orchestrator. Clears the world, plans a 2D layout, paints
 * ground, then extrudes buildings onto every parcel — writing only via
 * `setBlockRaw` and finishing with a single `remeshAll()`, per the world/gen
 * boundary rule. Staged as clear -> plan -> ground -> buildings so M6
 * (districts, bridges, stairs, parks, furniture) can insert stages between
 * ground and buildings, or extend the parcel loop, without reshaping this
 * file.
 */

import { planBuilding, writeBuilding } from './buildings';
import { CellType, cellAt, planLayout, type CityLayout } from './layout';
import { createRng } from './rng';
import { ASPHALT, CONCRETE, SIDEWALK } from '../world/BlockRegistry';
import type { World } from '../world/World';

/** Ground floor sits above the two-voxel-thick ground slab (y=0 concrete, y=1 road surface). */
export const BUILDING_BASE_Y = 2;

export interface GenerationResult {
  layout: CityLayout;
}

function paintGround(world: World, layout: CityLayout): void {
  for (let x = 0; x < layout.gridSizeX; x++) {
    for (let z = 0; z < layout.gridSizeZ; z++) {
      const surface = cellAt(layout, x, z) === CellType.ROAD ? ASPHALT : SIDEWALK;
      world.setBlockRaw(x, 0, z, CONCRETE);
      world.setBlockRaw(x, 1, z, surface);
    }
  }
}

function placeBuildings(world: World, layout: CityLayout, buildingsRng: ReturnType<typeof createRng>): void {
  for (const block of layout.blocks) {
    for (const parcel of block.parcels) {
      const parcelRng = buildingsRng.fork(`${parcel.x},${parcel.z}`);
      const plan = planBuilding(parcel, parcelRng, layout, BUILDING_BASE_Y);
      if (!plan) continue;
      writeBuilding(world, plan);
    }
  }
}

/**
 * Generates a full city into `world` for the given seed: same seed always
 * produces an identical world. Synchronous — callers driving UI (Toolbar)
 * are responsible for showing a loading overlay and yielding a frame before
 * calling this, since it can take a noticeable amount of time on the full
 * 384x384 plan.
 */
export function generateCity(world: World, seed: string): GenerationResult {
  world.clear();

  const rootRng = createRng(seed);
  const layout = planLayout(rootRng.fork('layout'));

  paintGround(world, layout);
  placeBuildings(world, layout, rootRng.fork('buildings'));

  world.remeshAll();

  return { layout };
}
