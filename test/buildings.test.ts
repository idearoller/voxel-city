import { describe, expect, it } from 'vitest';
import { createRng } from '../src/gen/rng';
import { MAX_BUILDING_HEIGHT, MIN_BUILDING_HEIGHT, planBuilding, writeBuilding } from '../src/gen/buildings';
import { District, DISTRICT_PARAMS } from '../src/gen/districts';
import { CellType, type CityLayout, type Parcel } from '../src/gen/layout';
import { AIR, GLASS_DARK, METAL, WINDOW_LIT } from '../src/world/BlockRegistry';
import { World } from '../src/world/World';

const CITY_SIZE = 384;
const BASE_Y = 2;
/** Used by tests that only care about generic shell/door/roof behavior, not district-specific massing. */
const NEUTRAL_DISTRICT = District.RESIDENTIAL;

function parcel(overrides: Partial<Parcel> = {}): Parcel {
  return { x: 40, z: 40, width: 20, depth: 16, blockX: 0, blockZ: 0, ...overrides };
}

/** A layout with no roads at all: every door-side scan misses, so planDoor always falls back to "any side". */
function blockOnlyLayout(size = CITY_SIZE): CityLayout {
  return {
    gridSizeX: size,
    gridSizeZ: size,
    cells: new Uint8Array(size * size).fill(CellType.BLOCK),
    blocks: [],
  };
}

/** A layout that is all BLOCK except a road band on one side, for exercising planDoor's road bias. */
function layoutWithRoadOnOneSide(size: number, side: 'north' | 'south' | 'east' | 'west', boundary: number): CityLayout {
  const layout = blockOnlyLayout(size);
  for (let x = 0; x < size; x++) {
    for (let z = 0; z < size; z++) {
      const isRoad =
        (side === 'south' && z < boundary) ||
        (side === 'north' && z >= boundary) ||
        (side === 'west' && x < boundary) ||
        (side === 'east' && x >= boundary);
      if (isRoad) layout.cells[x + z * size] = CellType.ROAD;
    }
  }
  return layout;
}

describe('planBuilding footprint', () => {
  it('stays within the parcel bounds after inset', () => {
    const rng = createRng('footprint').fork('b');
    const p = parcel();
    const plan = planBuilding(p, rng, blockOnlyLayout(), BASE_Y, NEUTRAL_DISTRICT);

    expect(plan).not.toBeNull();
    const b = plan!;
    expect(b.x).toBeGreaterThanOrEqual(p.x);
    expect(b.z).toBeGreaterThanOrEqual(p.z);
    expect(b.x + b.width).toBeLessThanOrEqual(p.x + p.width);
    expect(b.z + b.depth).toBeLessThanOrEqual(p.z + p.depth);
  });

  it('returns null for a parcel too small to host a footprint', () => {
    const rng = createRng('tiny').fork('b');
    const plan = planBuilding(parcel({ width: 2, depth: 2 }), rng, blockOnlyLayout(), BASE_Y, NEUTRAL_DISTRICT);
    expect(plan).toBeNull();
  });

  it('returns null for a park district (no buildings in parks)', () => {
    const rng = createRng('park-district').fork('b');
    const plan = planBuilding(parcel(), rng, blockOnlyLayout(), BASE_Y, District.PARK);
    expect(plan).toBeNull();
  });

  it('keeps height within [MIN_BUILDING_HEIGHT, MAX_BUILDING_HEIGHT] across many seeds/positions', () => {
    const layout = blockOnlyLayout();
    for (let i = 0; i < 100; i++) {
      const rng = createRng(`height-${i}`).fork('b');
      const p = parcel({ x: (i * 37) % 360, z: (i * 53) % 360 });
      const plan = planBuilding(p, rng, layout, BASE_Y, NEUTRAL_DISTRICT);
      if (!plan) continue;
      expect(plan.height).toBeGreaterThanOrEqual(MIN_BUILDING_HEIGHT);
      expect(plan.height).toBeLessThanOrEqual(MAX_BUILDING_HEIGHT);
    }
  });
});

describe('planBuilding district height ranges', () => {
  it('honors each district\'s [minHeight, maxHeight] range across many seeds', () => {
    const layout = blockOnlyLayout();
    for (const district of Object.values(District)) {
      if (district === District.PARK) continue;
      const params = DISTRICT_PARAMS[district];
      for (let i = 0; i < 30; i++) {
        const rng = createRng(`${district}-height-${i}`).fork('b');
        const p = parcel({ x: (i * 37) % 360, z: (i * 53) % 360 });
        const plan = planBuilding(p, rng, layout, BASE_Y, district);
        if (!plan) continue;
        expect(plan.height).toBeGreaterThanOrEqual(params.minHeight);
        expect(plan.height).toBeLessThanOrEqual(params.maxHeight);
      }
    }
  });
});

describe('planBuilding determinism', () => {
  it('produces an identical plan for the same seed', () => {
    const p = parcel();
    const layout = blockOnlyLayout();
    const planA = planBuilding(p, createRng('determinism').fork('b'), layout, BASE_Y, NEUTRAL_DISTRICT);
    const planB = planBuilding(p, createRng('determinism').fork('b'), layout, BASE_Y, NEUTRAL_DISTRICT);
    expect({ ...planA, rng: undefined }).toEqual({ ...planB, rng: undefined });
  });
});

describe('planBuilding door placement', () => {
  const p = parcel();

  it('biases the doorway toward a side that faces a nearby road', () => {
    const layout = layoutWithRoadOnOneSide(CITY_SIZE, 'south', p.z);
    for (let i = 0; i < 30; i++) {
      const rng = createRng(`road-bias-${i}`).fork('b');
      const plan = planBuilding(p, rng, layout, BASE_Y, NEUTRAL_DISTRICT);
      expect(plan).not.toBeNull();
      expect(plan!.doorSide).toBe('south');
    }
  });

  it('picks the road-facing side regardless of which side the road is on', () => {
    const boundaryFor: Record<'north' | 'south' | 'east' | 'west', number> = {
      south: p.z,
      north: p.z + p.depth,
      west: p.x,
      east: p.x + p.width,
    };
    for (const side of ['north', 'south', 'east', 'west'] as const) {
      const layout = layoutWithRoadOnOneSide(CITY_SIZE, side, boundaryFor[side]);
      const plan = planBuilding(p, createRng(`multi-side-${side}`).fork('b'), layout, BASE_Y, NEUTRAL_DISTRICT);
      expect(plan).not.toBeNull();
      expect(plan!.doorSide).toBe(side);
    }
  });

  it('falls back to a uniform pick among fitting sides when no side faces a road (interior parcel)', () => {
    const layout = blockOnlyLayout();
    const seen = new Set<string>();
    for (let i = 0; i < 40; i++) {
      const plan = planBuilding(p, createRng(`no-road-${i}`).fork('b'), layout, BASE_Y, NEUTRAL_DISTRICT);
      if (plan?.doorSide) seen.add(plan.doorSide);
    }
    // With no road anywhere, all four sides fit this parcel and should be reachable.
    expect(seen).toEqual(new Set(['north', 'south', 'east', 'west']));
  });
});

describe('planBuilding setback tiers', () => {
  it('extrudes a single full-footprint tier at or under the setback threshold', () => {
    // COMMERCIAL tops out at 40, at/under the setback threshold: never setback.
    const layout = blockOnlyLayout();
    for (let i = 0; i < 30; i++) {
      const rng = createRng(`no-setback-${i}`).fork('b');
      const plan = planBuilding(parcel(), rng, layout, BASE_Y, District.COMMERCIAL);
      if (!plan) continue;
      expect(plan.tiers).toHaveLength(1);
      expect(plan.tiers[0]).toMatchObject({ x: plan.x, z: plan.z, width: plan.width, depth: plan.depth });
    }
  });

  it('produces 2-3 tiers for a tall downtown tower, each narrower than or equal to the one below, covering the full height', () => {
    const layout = blockOnlyLayout();
    let sawMultiTier = false;
    for (let i = 0; i < 60; i++) {
      const rng = createRng(`setback-${i}`).fork('b');
      const plan = planBuilding(parcel({ width: 24, depth: 24 }), rng, layout, BASE_Y, District.DOWNTOWN);
      if (!plan || plan.height <= 40) continue;

      const tiers = plan.tiers;
      expect(tiers.length).toBeGreaterThanOrEqual(1);
      expect(tiers.length).toBeLessThanOrEqual(3);
      if (tiers.length > 1) sawMultiTier = true;

      // Contiguous, gapless, covers [0, height).
      expect(tiers[0]!.yStart).toBe(0);
      expect(tiers[tiers.length - 1]!.yEnd).toBe(plan.height);
      for (let t = 1; t < tiers.length; t++) {
        expect(tiers[t]!.yStart).toBe(tiers[t - 1]!.yEnd);
        expect(tiers[t]!.width).toBeLessThanOrEqual(tiers[t - 1]!.width);
        expect(tiers[t]!.depth).toBeLessThanOrEqual(tiers[t - 1]!.depth);
        // Each setback is centered: inset equally on both axes.
        expect(tiers[t]!.x).toBeGreaterThanOrEqual(tiers[t - 1]!.x);
        expect(tiers[t]!.z).toBeGreaterThanOrEqual(tiers[t - 1]!.z);
      }
    }
    expect(sawMultiTier).toBe(true);
  });
});

describe('planBuilding signage', () => {
  it('rolls a commercial shop band far more often than a residential one', () => {
    const layout = blockOnlyLayout();
    let commercialBands = 0;
    let residentialBands = 0;
    const trials = 60;
    for (let i = 0; i < trials; i++) {
      const commercialPlan = planBuilding(parcel(), createRng(`shop-c-${i}`).fork('b'), layout, BASE_Y, District.COMMERCIAL);
      if (commercialPlan?.shopBandColor !== null) commercialBands++;
      const residentialPlan = planBuilding(
        parcel(),
        createRng(`shop-r-${i}`).fork('b'),
        layout,
        BASE_Y,
        District.RESIDENTIAL,
      );
      if (residentialPlan?.shopBandColor !== null && residentialPlan?.shopBandColor !== undefined) residentialBands++;
    }
    expect(commercialBands).toBeGreaterThan(trials / 2);
    expect(residentialBands).toBe(0); // shop bands are commercial-only
  });

  it('never gives a downtown roof a non-null trim color, and never gives non-downtown one', () => {
    const layout = blockOnlyLayout();
    for (let i = 0; i < 20; i++) {
      const downtown = planBuilding(parcel(), createRng(`trim-d-${i}`).fork('b'), layout, BASE_Y, District.DOWNTOWN);
      if (downtown) expect(downtown.roofTrimColor).not.toBeNull();
      const industrial = planBuilding(
        parcel(),
        createRng(`trim-i-${i}`).fork('b'),
        layout,
        BASE_Y,
        District.INDUSTRIAL,
      );
      if (industrial) expect(industrial.roofTrimColor).toBeNull();
    }
  });
});

describe('writeBuilding', () => {
  it('carves an air doorway 2 wide x 3 high on the ground floor', () => {
    const world = new World();
    const p = parcel();
    const plan = planBuilding(p, createRng('door').fork('b'), blockOnlyLayout(), BASE_Y, NEUTRAL_DISTRICT);
    expect(plan).not.toBeNull();
    const b = plan!;
    expect(b.doorSide).not.toBeNull();

    writeBuilding(world, b);

    for (let h = 0; h < 3; h++) {
      for (let w = 0; w < 2; w++) {
        const y = b.baseY + h;
        let x = b.doorStart + w;
        let z = b.z;
        if (b.doorSide === 'north') z = b.z + b.depth - 1;
        else if (b.doorSide === 'west') {
          x = b.x;
          z = b.doorStart + w;
        } else if (b.doorSide === 'east') {
          x = b.x + b.width - 1;
          z = b.doorStart + w;
        }
        expect(world.getBlock(x, y, z)).toBe(AIR);
      }
    }
  });

  it('writes a solid roof deck covering the full top-tier footprint', () => {
    const world = new World();
    const p = parcel();
    const plan = planBuilding(p, createRng('roof').fork('b'), blockOnlyLayout(), BASE_Y, NEUTRAL_DISTRICT);
    expect(plan).not.toBeNull();
    const b = plan!;

    writeBuilding(world, b);

    const lastTier = b.tiers[b.tiers.length - 1]!;
    const roofY = b.baseY + lastTier.yEnd;
    for (let dx = 0; dx < lastTier.width; dx++) {
      for (let dz = 0; dz < lastTier.depth; dz++) {
        expect(world.getBlock(lastTier.x + dx, roofY, lastTier.z + dz)).not.toBe(AIR);
      }
    }
  });

  it('leaves the building interior hollow (air) above the ground floor', () => {
    const world = new World();
    const p = parcel({ width: 20, depth: 16 });
    const plan = planBuilding(p, createRng('hollow').fork('b'), blockOnlyLayout(), BASE_Y, NEUTRAL_DISTRICT);
    expect(plan).not.toBeNull();
    const b = plan!;

    writeBuilding(world, b);

    const interiorX = b.x + Math.floor(b.width / 2);
    const interiorZ = b.z + Math.floor(b.depth / 2);
    expect(world.getBlock(interiorX, b.baseY + Math.floor(b.height / 2), interiorZ)).toBe(AIR);
  });

  it('writes a walkable doorway even when a shop band or sign strip would otherwise overlap it', () => {
    // Commercial + door-facing shop band is the highest-risk overlap case.
    const world = new World();
    for (let i = 0; i < 30; i++) {
      const plan = planBuilding(
        parcel(),
        createRng(`door-vs-signage-${i}`).fork('b'),
        blockOnlyLayout(),
        BASE_Y,
        District.COMMERCIAL,
      );
      if (!plan?.doorSide) continue;
      writeBuilding(world, plan);
      const y = plan.baseY + 1; // a row shop bands/signs could plausibly touch
      let x = plan.doorStart;
      let z = plan.z;
      if (plan.doorSide === 'north') z = plan.z + plan.depth - 1;
      else if (plan.doorSide === 'west') {
        x = plan.x;
        z = plan.doorStart;
      } else if (plan.doorSide === 'east') {
        x = plan.x + plan.width - 1;
        z = plan.doorStart;
      }
      expect(world.getBlock(x, y, z)).toBe(AIR);
    }
  });

  it('paints district-appropriate wall material: downtown never uses plain CONCRETE', () => {
    let sawMetalOrGlass = false;
    for (let i = 0; i < 20; i++) {
      const plan = planBuilding(parcel(), createRng(`wallmat-${i}`).fork('b'), blockOnlyLayout(), BASE_Y, District.DOWNTOWN);
      if (!plan) continue;
      expect([METAL, GLASS_DARK]).toContain(plan.wallMaterial);
      sawMetalOrGlass = true;
    }
    expect(sawMetalOrGlass).toBe(true);
  });

  it('writes at least one lit window across many buildings (WINDOW_LIT is reachable)', () => {
    const world = new World();
    let sawLit = false;
    for (let i = 0; i < 15 && !sawLit; i++) {
      const plan = planBuilding(
        parcel({ x: 40 + i, z: 40 }),
        createRng(`lit-${i}`).fork('b'),
        blockOnlyLayout(),
        BASE_Y,
        District.DOWNTOWN,
      );
      if (!plan) continue;
      writeBuilding(world, plan);
      for (let dx = 0; dx < plan.width && !sawLit; dx++) {
        for (let dy = 1; dy < plan.height && !sawLit; dy++) {
          if (world.getBlock(plan.x + dx, plan.baseY + dy, plan.z) === WINDOW_LIT) sawLit = true;
        }
      }
    }
    expect(sawLit).toBe(true);
  });
});
