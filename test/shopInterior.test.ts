import { beforeAll, describe, expect, it } from 'vitest';
import type { BuildingPlan, BuildingTier, DoorSide } from '../src/gen/buildings';
import { planBuilding, writeBuilding } from '../src/gen/buildings';
import { generateCity } from '../src/gen/CityGenerator';
import { District } from '../src/gen/districts';
import { stairShaftFootprintColumns } from '../src/gen/infrastructure';
import { CellType, type CityLayout, type Parcel } from '../src/gen/layout';
import { createRng } from '../src/gen/rng';
import { planShopInterior, SHOP_ARCHETYPES, type ShopArchetype } from '../src/gen/shopInterior';
import { scanElevatorShafts } from '../src/elevators/ElevatorScanner';
import { SHOP_COUNTER, SHOP_SHELF } from '../src/world/BlockRegistry';
import { World } from '../src/world/World';

const CITY_SIZE = 384;
const BASE_Y = 2;
/** Matches `buildings.ts`'s private DOOR_WIDTH — the doorway is always 2 voxels wide. */
const DOOR_WIDTH = 2;

function parcel(overrides: Partial<Parcel> = {}): Parcel {
  return { x: 40, z: 40, width: 20, depth: 16, blockX: 0, blockZ: 0, ...overrides };
}

function blockOnlyLayout(size = CITY_SIZE): CityLayout {
  return {
    gridSizeX: size,
    gridSizeZ: size,
    cells: new Uint8Array(size * size).fill(CellType.BLOCK),
    blocks: [],
  };
}

/** Real-floor walkability at `feetY`: solid underfoot, 2 clear voxels above — same convention as CityGenerator.test.ts / ElevatorRide.test.ts. */
function isWalkableFeet(world: World, x: number, feetY: number, z: number): boolean {
  return world.isSolid(x, feetY - 1, z) && !world.isSolid(x, feetY, z) && !world.isSolid(x, feetY + 1, z);
}

/** 4-connected flood fill of standable cells at a fixed feet height, starting from `start`. */
function floodFillCount(world: World, start: { x: number; z: number }, feetY: number, maxCells = 5000): number {
  if (!isWalkableFeet(world, start.x, feetY, start.z)) return 0;

  const visited = new Set<string>([`${start.x},${start.z}`]);
  const queue: Array<{ x: number; z: number }> = [start];
  while (queue.length > 0) {
    const cur = queue.shift() as { x: number; z: number };
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
      if (visited.size >= maxCells) return visited.size;
    }
  }
  return visited.size;
}

/** The interior cell directly behind a building's doorway, and the feet-Y a player standing there occupies. */
function doorwayEntry(plan: BuildingPlan): { x: number; z: number; feetY: number } {
  const tier0 = plan.tiers[0] as BuildingTier;
  const doorSide = plan.doorSide as DoorSide;
  const feetY = plan.baseY;
  switch (doorSide) {
    case 'south':
      return { x: plan.doorStart, z: tier0.z + 1, feetY };
    case 'north':
      return { x: plan.doorStart, z: tier0.z + tier0.depth - 2, feetY };
    case 'west':
      return { x: tier0.x + 1, z: plan.doorStart, feetY };
    case 'east':
      return { x: tier0.x + tier0.width - 2, z: plan.doorStart, feetY };
  }
}

/** One generated world plus its full generation result, per seed. */
function generateWorlds(seeds: readonly string[]) {
  return seeds.map((seed) => {
    const world = new World();
    const result = generateCity(world, seed);
    return { world, ...result };
  });
}

const SEEDS = Array.from({ length: 10 }, (_, i) => `shop-interior-${i}`);

describe('planShopInterior', () => {
  const tier0: BuildingTier = { yStart: 0, yEnd: 20, x: 40, z: 40, width: 12, depth: 10 };

  it('returns null for non-commercial districts', () => {
    const rng = createRng('non-commercial').fork('b');
    expect(planShopInterior(rng, District.RESIDENTIAL, 'south', tier0)).toBeNull();
  });

  it('returns null when the building has no doorway', () => {
    const rng = createRng('no-door').fork('b');
    expect(planShopInterior(rng, District.COMMERCIAL, null, tier0)).toBeNull();
  });

  it('returns null when the footprint is too small for a ring plus a core', () => {
    const tinyTier: BuildingTier = { yStart: 0, yEnd: 20, x: 40, z: 40, width: 4, depth: 4 };
    const rng = createRng('tiny-shop').fork('b');
    expect(planShopInterior(rng, District.COMMERCIAL, 'south', tinyTier)).toBeNull();
  });

  it('is deterministic for the same seed', () => {
    const planA = planShopInterior(createRng('det').fork('b'), District.COMMERCIAL, 'south', tier0);
    const planB = planShopInterior(createRng('det').fork('b'), District.COMMERCIAL, 'south', tier0);
    expect(planA).toEqual(planB);
  });

  it('produces every archetype across enough seeds (deterministic variety, not a fixed pick)', () => {
    const seen = new Set<ShopArchetype>();
    for (let i = 0; i < 100; i++) {
      const rng = createRng(`variety-${i}`).fork('b');
      const plan = planShopInterior(rng, District.COMMERCIAL, 'south', tier0);
      if (plan) seen.add(plan.archetype);
    }
    for (const archetype of SHOP_ARCHETYPES) expect(seen.has(archetype)).toBe(true);
  });

  it('keeps furniture confined to core, never on the ring the doorway opens onto', () => {
    for (const archetype of SHOP_ARCHETYPES) {
      let rng = createRng(`layout-${archetype}`).fork('b');
      let plan = planShopInterior(rng, District.COMMERCIAL, 'south', tier0);
      // Re-roll until we land on the archetype under test — rng.pick draws are opaque from here.
      for (let i = 0; i < 50 && plan?.archetype !== archetype; i++) {
        rng = createRng(`layout-${archetype}-${i}`).fork('b');
        plan = planShopInterior(rng, District.COMMERCIAL, 'south', tier0);
      }
      expect(plan?.archetype).toBe(archetype);
      expect(plan!.core.x0).toBeGreaterThan(plan!.interior.x0);
      expect(plan!.core.x1).toBeLessThan(plan!.interior.x1);
      expect(plan!.core.z0).toBeGreaterThan(plan!.interior.z0);
      expect(plan!.core.z1).toBeLessThan(plan!.interior.z1);
    }
  });
});

describe('shop interiors on real generator output', () => {
  // Generating a full 384x384 city is expensive; every test case in this
  // block wants the same seed batch, so generate it once up front instead of
  // per-`it` (10 full generations x ~6 assertions would otherwise dominate
  // this suite's runtime for no additional coverage).
  let shops: Array<{ world: World; plan: BuildingPlan }>;
  let worlds: ReturnType<typeof generateWorlds>;

  beforeAll(() => {
    worlds = generateWorlds(SEEDS);
    shops = worlds.flatMap(({ world, buildings }) =>
      buildings.filter((b) => b.shopInterior).map((plan) => ({ world, plan })),
    );
  });

  it('generates at least one commercial building with a shop interior across several seeds', () => {
    expect(shops.length).toBeGreaterThan(0);
  });

  it('every shop floods from its doorway to at least the full walkway ring — never a sealed pocket', () => {
    expect(shops.length).toBeGreaterThan(0);

    for (const { world, plan } of shops) {
      const interior = plan.shopInterior!.interior;
      const interiorWidth = interior.x1 - interior.x0 + 1;
      const interiorDepth = interior.z1 - interior.z0 + 1;
      const ringSize = 2 * (interiorWidth + interiorDepth) - 4;

      const entry = doorwayEntry(plan);
      const reach = floodFillCount(world, { x: entry.x, z: entry.z }, entry.feetY);
      expect(reach).toBeGreaterThanOrEqual(ringSize);
    }
  });

  it('furniture never occupies the doorway or the ring cell directly behind it', () => {
    for (const { world, plan } of shops) {
      const entry = doorwayEntry(plan);
      for (let w = 0; w < DOOR_WIDTH; w++) {
        const doorSide = plan.doorSide as DoorSide;
        const [dx, dz] =
          doorSide === 'south' || doorSide === 'north' ? [plan.doorStart + w - entry.x, 0] : [0, plan.doorStart + w - entry.z];
        expect(world.isSolid(entry.x + dx, entry.feetY, entry.z + dz)).toBe(false);
        expect(world.isSolid(entry.x + dx, entry.feetY + 1, entry.z + dz)).toBe(false);
      }
      // The ring cell directly behind the door must itself be clear (asserted via doorwayEntry's own walkability).
      expect(world.isSolid(entry.x, entry.feetY, entry.z)).toBe(false);
      expect(world.isSolid(entry.x, entry.feetY + 1, entry.z)).toBe(false);
    }
  });

  it('has at least 2 voxels of headroom above every cell the flood fill actually reaches', () => {
    for (const { world, plan } of shops) {
      const entry = doorwayEntry(plan);
      // Bounded to the room's own interior rect (with a 1-cell margin for the
      // doorway threshold itself) — a flood with no bound at all would leak
      // out through the doorway onto the street and effectively flood the
      // whole city's sidewalk network.
      const interior = plan.shopInterior!.interior;
      const inRoom = (x: number, z: number) =>
        x >= interior.x0 - 1 && x <= interior.x1 + 1 && z >= interior.z0 - 1 && z <= interior.z1 + 1;

      const visited = new Set<string>([`${entry.x},${entry.z}`]);
      const queue: Array<{ x: number; z: number }> = [{ x: entry.x, z: entry.z }];
      while (queue.length > 0) {
        const cur = queue.shift() as { x: number; z: number };
        expect(world.isSolid(cur.x, entry.feetY, cur.z)).toBe(false);
        expect(world.isSolid(cur.x, entry.feetY + 1, cur.z)).toBe(false);
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
          if (!inRoom(nx, nz)) continue;
          if (!isWalkableFeet(world, nx, entry.feetY, nz)) continue;
          visited.add(key);
          queue.push({ x: nx, z: nz });
        }
      }
    }
  });

  it('never breaches the shell — every non-doorway perimeter cell stays solid at every room-height row', () => {
    for (const { world, plan } of shops) {
      const tier0 = plan.tiers[0] as BuildingTier;
      const doorSide = plan.doorSide as DoorSide;

      for (let ry = 0; ry <= 3; ry++) {
        const y = plan.baseY + ry;
        for (let dx = 0; dx < tier0.width; dx++) {
          for (let dz = 0; dz < tier0.depth; dz++) {
            const isShell = dx === 0 || dx === tier0.width - 1 || dz === 0 || dz === tier0.depth - 1;
            if (!isShell) continue;

            const x = tier0.x + dx;
            const z = tier0.z + dz;
            const isDoorwayCell =
              ry <= 2 &&
              ((doorSide === 'south' && dz === 0) ||
                (doorSide === 'north' && dz === tier0.depth - 1) ||
                (doorSide === 'west' && dx === 0) ||
                (doorSide === 'east' && dx === tier0.width - 1)) &&
              (doorSide === 'south' || doorSide === 'north'
                ? x >= plan.doorStart && x < plan.doorStart + DOOR_WIDTH
                : z >= plan.doorStart && z < plan.doorStart + DOOR_WIDTH);
            if (isDoorwayCell) continue;

            expect(world.isSolid(x, y, z)).toBe(true);
          }
        }
      }
    }
  });

  it('never coexists with a real elevator shaft in the same building', () => {
    // A shop's whole ground floor is meant to be one open room; buildings
    // with a shopInterior plan are excluded from *elevator*-shaft candidacy
    // entirely (see infrastructure.ts's `planElevatorShafts`) rather than
    // having furniture dodge that shaft's fixed footprint, because the
    // shaft's wall blocks would otherwise land on the walkway ring itself
    // (a real defect this suite caught on real generator output for west-
    // and south-facing doors — see this file's git history). Bridge stair
    // shafts are handled differently — see the next two tests.
    let checkedAnyShaft = false;

    for (const { world, buildings } of worlds) {
      const shopFootprints = buildings
        .filter((b) => b.shopInterior)
        .map((b) => ({ x0: b.x, z0: b.z, x1: b.x + b.width - 1, z1: b.z + b.depth - 1 }));

      const overlapsAnyShop = (x: number, z: number) =>
        shopFootprints.some((f) => x >= f.x0 && x <= f.x1 && z >= f.z0 && z <= f.z1);

      for (const shaft of scanElevatorShafts(world)) {
        checkedAnyShaft = true;
        expect(overlapsAnyShop(shaft.wellX, shaft.wellZ)).toBe(false);
      }
    }

    // Not every seed batch is guaranteed to roll an elevator shaft; this just
    // proves the check has real teeth on this seed batch rather than
    // vacuously passing.
    expect(checkedAnyShaft).toBe(true);
  });

  it('when a shop building also gets a bridge stair shaft, the shaft footprint stays strictly inside the core, never on the ring', () => {
    // Task 4 (denser bridges): unlike the elevator shaft above, a bridge's
    // internal stair shaft is centered on the tower footprint (see
    // infrastructure.ts's `stairShaftOrigin`) rather than anchored to a fixed
    // corner, so shop buildings are no longer excluded from stair/bridge
    // candidacy. `BRIDGE_MIN_TOWER_FOOTPRINT` (>= 10) guarantees the centered
    // 3x3 shaft lands inside the core (one cell past the ring the doorway
    // depends on) — this asserts that invariant on real generator output.
    let checkedAnyShopStair = false;

    for (const { buildings, stairShafts } of worlds) {
      for (const building of buildings) {
        if (!building.shopInterior) continue;

        const columns = stairShaftFootprintColumns(building);
        const origin = columns[0]!;
        const shaft = stairShafts.find(
          (s) => s.originX === origin.x && s.originZ === origin.z && s.baseY === building.baseY,
        );
        if (!shaft) continue;
        checkedAnyShopStair = true;

        const interior = building.shopInterior.interior;
        for (const { x, z } of columns) {
          expect(x).toBeGreaterThan(interior.x0);
          expect(x).toBeLessThan(interior.x1);
          expect(z).toBeGreaterThan(interior.z0);
          expect(z).toBeLessThan(interior.z1);
        }
      }
    }

    // Not every seed batch pairs a shop building with a qualifying bridge;
    // this proves the check has real teeth on this seed batch.
    expect(checkedAnyShopStair).toBe(true);
  });

  it('skips furniture at every cell a coexisting stair shaft occupies, so the shaft never carves through a shelf/counter block', () => {
    let checkedAnyShopStair = false;

    for (const { world, buildings, stairShafts } of worlds) {
      for (const building of buildings) {
        if (!building.shopInterior) continue;

        const columns = stairShaftFootprintColumns(building);
        const origin = columns[0]!;
        const shaft = stairShafts.find(
          (s) => s.originX === origin.x && s.originZ === origin.z && s.baseY === building.baseY,
        );
        if (!shaft) continue;
        checkedAnyShopStair = true;

        for (const { x, z } of columns) {
          const block = world.getBlock(x, building.baseY, z);
          expect(block).not.toBe(SHOP_SHELF);
          expect(block).not.toBe(SHOP_COUNTER);
        }
      }
    }

    expect(checkedAnyShopStair).toBe(true);
  });

  it('is deterministic per seed: same seed reproduces the same archetype/color for every shop building', () => {
    const seed = 'shop-determinism';
    const worldA = new World();
    const worldB = new World();
    const { buildings: buildingsA } = generateCity(worldA, seed);
    const { buildings: buildingsB } = generateCity(worldB, seed);

    const archetypesA = buildingsA.map((b) => b.shopInterior?.archetype ?? null);
    const archetypesB = buildingsB.map((b) => b.shopInterior?.archetype ?? null);
    expect(archetypesA).toEqual(archetypesB);
    expect(archetypesA.some((a) => a !== null)).toBe(true);
  });
});

describe('planBuilding integration', () => {
  it('attaches a shopInterior plan only for commercial buildings with a doorway and large-enough footprint', () => {
    const layout = blockOnlyLayout();
    const rng = createRng('integration').fork('b');
    const plan = planBuilding(parcel(), rng, layout, BASE_Y, District.COMMERCIAL);
    expect(plan).not.toBeNull();
    if (plan!.doorSide) {
      expect(plan!.shopInterior).not.toBeNull();
    }
  });

  it('never attaches a shopInterior plan for non-commercial districts', () => {
    const layout = blockOnlyLayout();
    for (const district of [District.RESIDENTIAL, District.INDUSTRIAL, District.DOWNTOWN]) {
      const rng = createRng(`non-commercial-${district}`).fork('b');
      const plan = planBuilding(parcel(), rng, layout, BASE_Y, district);
      if (plan) expect(plan.shopInterior).toBeNull();
    }
  });

  it('writeBuilding on a commercial plan with a shopInterior actually writes furniture blocks into the world', () => {
    const layout = blockOnlyLayout();
    let plan: BuildingPlan | null = null;
    for (let i = 0; i < 50 && !plan?.shopInterior; i++) {
      plan = planBuilding(parcel(), createRng(`furniture-write-${i}`).fork('b'), layout, BASE_Y, District.COMMERCIAL);
    }
    expect(plan?.shopInterior).toBeTruthy();

    const world = new World();
    writeBuilding(world, plan as BuildingPlan);

    const tier0 = (plan as BuildingPlan).tiers[0] as BuildingTier;
    let furnitureCount = 0;
    for (let dx = 1; dx < tier0.width - 1; dx++) {
      for (let dz = 1; dz < tier0.depth - 1; dz++) {
        const block = world.getBlock(tier0.x + dx, (plan as BuildingPlan).baseY, tier0.z + dz);
        if (block === SHOP_COUNTER || block === SHOP_SHELF) furnitureCount++;
      }
    }
    expect(furnitureCount).toBeGreaterThan(0);
  });
});
