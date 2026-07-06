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
  repairBridgeRailFencing,
  stairShaftFootprintColumns,
  towerKey,
  writeBillboard,
  writeBridgeDeckAndRails,
  writeBridgeWalkway,
  writeElevatorShaft,
  writeSkyLobby,
  writeStairShaft,
  writeStreetlight,
  writeWalkway,
  type Billboard,
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
  /** Every billboard the generator actually wrote, in `writeBillboard` order — the ground truth `BillboardScanner`'s voxel-scan should reproduce (see `test/BillboardScanner.test.ts`'s oracle test). */
  billboards: Billboard[];
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

/**
 * Plans (but does not write) every non-park parcel's building. Split from
 * writing so bridges/stair shafts can be planned from the resulting
 * `BuildingPlan[]` — a pure computation — *before* any building is written:
 * a shop-interior building's furniture layout needs to know its stair
 * shaft's footprint (if it gets one) to avoid placing furniture there (see
 * `writeAllBuildings`), and that footprint isn't knowable until the
 * whole-city bridge plan exists.
 */
function planAllBuildings(layout: CityLayout, buildingsRng: Rng): BuildingPlan[] {
  const plans: BuildingPlan[] = [];
  for (const block of layout.blocks) {
    for (const parcel of block.parcels) {
      const parcelRng = buildingsRng.fork(`${parcel.x},${parcel.z}`);
      const plan = planBuilding(parcel, parcelRng, layout, BUILDING_BASE_Y, block.district);
      if (plan) plans.push(plan);
    }
  }
  return plans;
}

/**
 * The stair-shaft footprint (as a `"x,z"` column set) for every planned
 * building that both has a shop interior and will end up with a bridge stair
 * shaft — i.e. the exact set `writeAllBuildings` needs to keep shop furniture
 * off of. Buildings with no shop interior, or a shop interior but no shaft,
 * are simply absent from the map (callers should treat a missing entry the
 * same as an empty exclusion set).
 */
function shopShaftColumnsByTower(buildings: readonly BuildingPlan[], bridges: readonly Bridge[]): Map<string, ReadonlySet<string>> {
  const stairTowerKeys = new Set(bridges.flatMap((bridge) => [towerKey(bridge.towerA), towerKey(bridge.towerB)]));
  const map = new Map<string, ReadonlySet<string>>();
  for (const building of buildings) {
    if (!building.shopInterior) continue;
    if (!stairTowerKeys.has(towerKey(building))) continue;
    map.set(towerKey(building), new Set(stairShaftFootprintColumns(building).map((c) => `${c.x},${c.z}`)));
  }
  return map;
}

/** Writes every planned building, passing each shop building its stair shaft's footprint (if any) so furniture placement can dodge it. */
function writeAllBuildings(world: World, buildings: readonly BuildingPlan[], shaftColumnsByTower: ReadonlyMap<string, ReadonlySet<string>>): void {
  for (const plan of buildings) {
    writeBuilding(world, plan, shaftColumnsByTower.get(towerKey(plan)));
  }
}

/** Bridges between nearby towers, the internal stair shafts that reach them, elevated walkways, and elevator-shaft markers. */
function placeVerticalInfrastructure(
  world: World,
  layout: CityLayout,
  buildings: BuildingPlan[],
  bridges: readonly Bridge[],
  rng: Rng,
): { stairShafts: StairShaft[]; walkways: Walkway[] } {
  // Deck+rails for every bridge first, then every bridge's walkway clear
  // (middle lane + both doors) — never interleaved per bridge. Two bridges
  // can meet the same tower corner at the same level with overlapping
  // footprints (one bridge's rail band crossing the other's own middle lane
  // or door), so clearing every walkway only after every rail is written
  // guarantees the walkway clear is always the last write to touch its own
  // cells, regardless of which bridge comes first in `bridges`. See
  // `writeBridgeWalkway`'s doc comment in infrastructure.ts for the full
  // mechanism this ordering fixes.
  for (const bridge of bridges) writeBridgeDeckAndRails(world, bridge);
  for (const bridge of bridges) writeBridgeWalkway(world, bridge);

  // Third pass, after every bridge's deck+rails and every bridge's walkway
  // are in place: re-fence any rail cell one bridge's walkway clear erased
  // from a *different* bridge's rail band at a crossing (Task 39). See
  // `repairBridgeRailFencing`'s doc comment in infrastructure.ts for the full
  // mechanism and why this needs its own pass rather than folding into
  // either loop above.
  repairBridgeRailFencing(world, bridges);

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
  const elevatorShafts = planElevatorShafts(buildings, rng.fork('elevators'), stairTowerKeys, bridges);
  for (const marker of elevatorShafts) writeElevatorShaft(world, marker);

  const walkways = planWalkways(layout, BUILDING_BASE_Y);
  for (const walkway of walkways) writeWalkway(world, walkway);

  return { stairShafts, walkways };
}

/** Streetlights at road intersections and scattered neon billboards on blank facades. Returns the billboards actually written, so callers (and `GenerationResult`) have ground truth to check a voxel re-scan against. */
function placeStreetFurniture(world: World, layout: CityLayout, buildings: BuildingPlan[], rng: Rng): Billboard[] {
  const streetlights = planStreetlights(layout);
  for (const light of streetlights) writeStreetlight(world, light, GROUND_SURFACE_Y);

  const billboards = planBillboards(buildings, rng.fork('billboards'));
  for (const billboard of billboards) writeBillboard(world, billboard);
  return billboards;
}

/**
 * Every (x, z) column a walkway's deck or staircase occupies, citywide — see
 * `parks.ts`'s `planPark` doc comment for why this exists: parks are written
 * *after* walkways (this function's own caller order), so nothing otherwise
 * stops a tree from being planted directly in a staircase's path.
 */
function walkwayObstacleColumns(walkways: readonly Walkway[]): Set<string> {
  const columns = new Set<string>();
  for (const walkway of walkways) {
    for (let dx = 0; dx < walkway.width; dx++) {
      for (let dz = 0; dz < walkway.depth; dz++) {
        columns.add(`${walkway.x + dx},${walkway.z + dz}`);
      }
    }
    for (const step of walkway.stairSteps) columns.add(`${step.x},${step.z}`);
  }
  return columns;
}

/** Grass, gravel paths, trees, and lamps for every PARK-district block. */
function placeParks(world: World, layout: CityLayout, rng: Rng, obstacleColumns: ReadonlySet<string>): void {
  for (const block of layout.blocks) {
    if (block.district !== District.PARK) continue;
    const plan = planPark(block, rng.fork(`${block.x},${block.z}`), obstacleColumns);
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
  const buildings = planAllBuildings(layout, rootRng.fork('buildings'));

  // Bridges are planned (pure — no world writes) before any building is
  // written: a shop-interior building's furniture layout needs to know
  // whether it's getting a stair shaft, and where, to dodge that footprint
  // (see `shopShaftColumnsByTower`). `infrastructureRng` is threaded through
  // to `placeVerticalInfrastructure` below so every fork key under
  // 'infrastructure' (bridges, elevators) is drawn from exactly the same
  // sub-stream it always was, regardless of when the plan is computed.
  const infrastructureRng = rootRng.fork('infrastructure');
  const bridges = planBridges(buildings, infrastructureRng.fork('bridges'));
  writeAllBuildings(world, buildings, shopShaftColumnsByTower(buildings, bridges));

  // Street furniture (billboards in particular) paints directly onto building
  // facades, so it must run *before* the bridge stage: a bridge's door carve
  // has to be the last write to its own threshold cells, or a billboard that
  // happens to land there re-solidifies the opening and boxes the stairs in.
  const billboards = placeStreetFurniture(world, layout, buildings, rootRng.fork('furniture'));
  const { stairShafts, walkways } = placeVerticalInfrastructure(world, layout, buildings, bridges, infrastructureRng);
  placeParks(world, layout, rootRng.fork('parks'), walkwayObstacleColumns(walkways));

  world.remeshAll();

  return { layout, buildings, bridges, stairShafts, walkways, billboards };
}
