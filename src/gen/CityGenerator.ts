/**
 * Procgen pipeline orchestrator. Clears the world, plans a 2D layout
 * (roads, districts, parcels), paints ground, extrudes buildings onto every
 * parcel, then layers the city-scale connective tissue on top: sky bridges
 * + their internal stair shafts, elevated downtown walkways, streetlights,
 * billboards, elevator-shaft markers, and park blocks — writing only via
 * `setBlockRaw` and finishing with a single `remeshAll()`, per the
 * world/gen boundary rule.
 */

import { planBuilding, writeBuilding, type BuildingPlan } from './buildings';
import { District } from './districts';
import {
  planBillboards,
  planBridges,
  planElevatorShafts,
  planSkyLobbies,
  planStairShafts,
  planStreetlights,
  planWalkways,
  towerKey,
  writeBillboard,
  writeBridge,
  writeElevatorShaft,
  writeSkyLobby,
  writeStairShaft,
  writeStreetlight,
  writeWalkway,
  type Bridge,
  type StairShaft,
  type Walkway,
} from './infrastructure';
import { CellType, cellAt, planLayout, type CityLayout } from './layout';
import { planPark, writePark } from './parks';
import { createRng, type Rng } from './rng';
import { ASPHALT, CONCRETE, SIDEWALK } from '../world/BlockRegistry';
import type { World } from '../world/World';

/** Ground floor sits above the two-voxel-thick ground slab (y=0 concrete, y=1 road surface). */
export const BUILDING_BASE_Y = 2;
/** The walkable ground-surface row painted by `paintGround` (road/sidewalk, or grass/gravel for parks). */
export const GROUND_SURFACE_Y = BUILDING_BASE_Y - 1;

export interface GenerationResult {
  layout: CityLayout;
  buildings: BuildingPlan[];
  bridges: Bridge[];
  stairShafts: StairShaft[];
  walkways: Walkway[];
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

/** Extrudes every non-park parcel's building and returns the plans, so later stages (bridges, billboards) can query tower geometry. */
function placeBuildings(world: World, layout: CityLayout, buildingsRng: Rng): BuildingPlan[] {
  const plans: BuildingPlan[] = [];
  for (const block of layout.blocks) {
    for (const parcel of block.parcels) {
      const parcelRng = buildingsRng.fork(`${parcel.x},${parcel.z}`);
      const plan = planBuilding(parcel, parcelRng, layout, BUILDING_BASE_Y, block.district);
      if (!plan) continue;
      writeBuilding(world, plan);
      plans.push(plan);
    }
  }
  return plans;
}

/** Bridges between nearby towers, the internal stair shafts that reach them, elevated walkways, and elevator-shaft markers. */
function placeVerticalInfrastructure(
  world: World,
  layout: CityLayout,
  buildings: BuildingPlan[],
  rng: Rng,
): { bridges: Bridge[]; stairShafts: StairShaft[]; walkways: Walkway[] } {
  const bridges = planBridges(buildings, rng.fork('bridges'));
  for (const bridge of bridges) writeBridge(world, bridge);

  const stairShafts = planStairShafts(bridges);
  for (const shaft of stairShafts) writeStairShaft(world, shaft);

  // Towers are hollow shells with no floors of their own — without a slab
  // here, the stair's top step is a block floating in open air with no
  // walkable path to the bridge doorway. One slab per (tower, level) closes
  // that gap: continuous solid floor from the top step to the door threshold.
  const skyLobbies = planSkyLobbies(bridges);
  for (const lobby of skyLobbies) writeSkyLobby(world, lobby);

  const stairTowerKeys = new Set(
    bridges.flatMap((bridge) => [towerKey(bridge.towerA), towerKey(bridge.towerB)]),
  );
  const elevatorShafts = planElevatorShafts(buildings, rng.fork('elevators'), stairTowerKeys);
  for (const marker of elevatorShafts) writeElevatorShaft(world, marker);

  const walkways = planWalkways(layout, BUILDING_BASE_Y);
  for (const walkway of walkways) writeWalkway(world, walkway);

  return { bridges, stairShafts, walkways };
}

/** Streetlights at road intersections and scattered neon billboards on blank facades. */
function placeStreetFurniture(world: World, layout: CityLayout, buildings: BuildingPlan[], rng: Rng): void {
  const streetlights = planStreetlights(layout);
  for (const light of streetlights) writeStreetlight(world, light, GROUND_SURFACE_Y);

  const billboards = planBillboards(buildings, rng.fork('billboards'));
  for (const billboard of billboards) writeBillboard(world, billboard);
}

/** Grass, gravel paths, trees, and lamps for every PARK-district block. */
function placeParks(world: World, layout: CityLayout, rng: Rng): void {
  for (const block of layout.blocks) {
    if (block.district !== District.PARK) continue;
    const plan = planPark(block, rng.fork(`${block.x},${block.z}`));
    writePark(world, block, plan, GROUND_SURFACE_Y);
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
  const buildings = placeBuildings(world, layout, rootRng.fork('buildings'));
  // Street furniture (billboards in particular) paints directly onto building
  // facades, so it must run *before* the bridge stage: a bridge's door carve
  // has to be the last write to its own threshold cells, or a billboard that
  // happens to land there re-solidifies the opening and boxes the stairs in.
  placeStreetFurniture(world, layout, buildings, rootRng.fork('furniture'));
  const { bridges, stairShafts, walkways } = placeVerticalInfrastructure(
    world,
    layout,
    buildings,
    rootRng.fork('infrastructure'),
  );
  placeParks(world, layout, rootRng.fork('parks'));

  world.remeshAll();

  return { layout, buildings, bridges, stairShafts, walkways };
}
