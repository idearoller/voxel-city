import { describe, expect, it } from 'vitest';
import { createRng } from '../src/gen/rng';
import { MAX_BUILDING_HEIGHT, MIN_BUILDING_HEIGHT, planBuilding, writeBuilding } from '../src/gen/buildings';
import { CellType, type CityLayout, type Parcel } from '../src/gen/layout';
import { AIR } from '../src/world/BlockRegistry';
import { World } from '../src/world/World';

const CITY_SIZE = 384;
const BASE_Y = 2;

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
    const plan = planBuilding(p, rng, blockOnlyLayout(), BASE_Y);

    expect(plan).not.toBeNull();
    const b = plan!;
    expect(b.x).toBeGreaterThanOrEqual(p.x);
    expect(b.z).toBeGreaterThanOrEqual(p.z);
    expect(b.x + b.width).toBeLessThanOrEqual(p.x + p.width);
    expect(b.z + b.depth).toBeLessThanOrEqual(p.z + p.depth);
  });

  it('returns null for a parcel too small to host a footprint', () => {
    const rng = createRng('tiny').fork('b');
    const plan = planBuilding(parcel({ width: 2, depth: 2 }), rng, blockOnlyLayout(), BASE_Y);
    expect(plan).toBeNull();
  });

  it('keeps height within [MIN_BUILDING_HEIGHT, MAX_BUILDING_HEIGHT] across many seeds/positions', () => {
    const layout = blockOnlyLayout();
    for (let i = 0; i < 100; i++) {
      const rng = createRng(`height-${i}`).fork('b');
      const p = parcel({ x: (i * 37) % 360, z: (i * 53) % 360 });
      const plan = planBuilding(p, rng, layout, BASE_Y);
      if (!plan) continue;
      expect(plan.height).toBeGreaterThanOrEqual(MIN_BUILDING_HEIGHT);
      expect(plan.height).toBeLessThanOrEqual(MAX_BUILDING_HEIGHT);
    }
  });
});

describe('planBuilding determinism', () => {
  it('produces an identical plan for the same seed', () => {
    const p = parcel();
    const layout = blockOnlyLayout();
    const planA = planBuilding(p, createRng('determinism').fork('b'), layout, BASE_Y);
    const planB = planBuilding(p, createRng('determinism').fork('b'), layout, BASE_Y);
    expect({ ...planA, rng: undefined }).toEqual({ ...planB, rng: undefined });
  });
});

describe('planBuilding door placement', () => {
  const p = parcel();

  it('biases the doorway toward a side that faces a nearby road', () => {
    const layout = layoutWithRoadOnOneSide(CITY_SIZE, 'south', p.z);
    for (let i = 0; i < 30; i++) {
      const rng = createRng(`road-bias-${i}`).fork('b');
      const plan = planBuilding(p, rng, layout, BASE_Y);
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
      const plan = planBuilding(p, createRng(`multi-side-${side}`).fork('b'), layout, BASE_Y);
      expect(plan).not.toBeNull();
      expect(plan!.doorSide).toBe(side);
    }
  });

  it('falls back to a uniform pick among fitting sides when no side faces a road (interior parcel)', () => {
    const layout = blockOnlyLayout();
    const seen = new Set<string>();
    for (let i = 0; i < 40; i++) {
      const plan = planBuilding(p, createRng(`no-road-${i}`).fork('b'), layout, BASE_Y);
      if (plan?.doorSide) seen.add(plan.doorSide);
    }
    // With no road anywhere, all four sides fit this parcel and should be reachable.
    expect(seen).toEqual(new Set(['north', 'south', 'east', 'west']));
  });
});

describe('writeBuilding', () => {
  it('carves an air doorway 2 wide x 3 high on the ground floor', () => {
    const world = new World();
    const p = parcel();
    const plan = planBuilding(p, createRng('door').fork('b'), blockOnlyLayout(), BASE_Y);
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

  it('writes a solid roof deck covering the full footprint', () => {
    const world = new World();
    const p = parcel();
    const plan = planBuilding(p, createRng('roof').fork('b'), blockOnlyLayout(), BASE_Y);
    expect(plan).not.toBeNull();
    const b = plan!;

    writeBuilding(world, b);

    const roofY = b.baseY + b.height;
    for (let dx = 0; dx < b.width; dx++) {
      for (let dz = 0; dz < b.depth; dz++) {
        expect(world.getBlock(b.x + dx, roofY, b.z + dz)).not.toBe(AIR);
      }
    }
  });

  it('leaves the building interior hollow (air) above the ground floor', () => {
    const world = new World();
    const p = parcel({ width: 20, depth: 16 });
    const plan = planBuilding(p, createRng('hollow').fork('b'), blockOnlyLayout(), BASE_Y);
    expect(plan).not.toBeNull();
    const b = plan!;

    writeBuilding(world, b);

    const interiorX = b.x + Math.floor(b.width / 2);
    const interiorZ = b.z + Math.floor(b.depth / 2);
    expect(world.getBlock(interiorX, b.baseY + Math.floor(b.height / 2), interiorZ)).toBe(AIR);
  });
});
