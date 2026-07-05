import { describe, expect, it } from 'vitest';
import type { BuildingPlan } from '../src/gen/buildings';
import { writeBuilding } from '../src/gen/buildings';
import { District } from '../src/gen/districts';
import {
  canElevatorAndStairShaftCoexist,
  planBillboards,
  planBridges,
  planElevatorShafts,
  planSkyLobbies,
  planStairShafts,
  planStairSteps,
  planStreetlights,
  planWalkways,
  stairShaftFootprintColumns,
  towerKey,
  writeBillboard,
  writeBridge,
  writeElevatorShaft,
  writeSkyLobby,
  writeStairShaft,
  writeStreetlight,
  writeWalkway,
  type Bridge,
} from '../src/gen/infrastructure';
import { CellType, type CityLayout, type CityBlock } from '../src/gen/layout';
import { createRng } from '../src/gen/rng';
import {
  AIR,
  CONCRETE,
  ELEVATOR_SHAFT,
  GRAVEL,
  METAL,
  NEON_CYAN,
  PARK_GRASS,
} from '../src/world/BlockRegistry';
import { World } from '../src/world/World';

function tower(overrides: Partial<BuildingPlan> = {}): BuildingPlan {
  const x = overrides.x ?? 0;
  const z = overrides.z ?? 0;
  const width = overrides.width ?? 10;
  const depth = overrides.depth ?? 10;
  const baseY = overrides.baseY ?? 2;
  const height = overrides.height ?? 60;
  const tiers = overrides.tiers ?? [{ yStart: 0, yEnd: height, x, z, width, depth }];
  return {
    x,
    z,
    width,
    depth,
    baseY,
    height,
    district: District.DOWNTOWN,
    wallMaterial: METAL,
    windowStride: 2,
    windowPhase: 0,
    windowLitChance: 0.4,
    doorSide: 'south',
    doorStart: x + 1,
    tiers,
    shopBandColor: null,
    signStrip: null,
    roofTrimColor: null,
    antenna: null,
    shopInterior: null,
    rng: createRng('fixture'),
    ...overrides,
  };
}

describe('planBridges', () => {
  it('produces a bridge for at least one seed among a set of adjacent tall towers, with correct geometry', () => {
    const towerA = tower({ x: 0, z: 0, width: 10, depth: 10, height: 60 });
    const towerB = tower({ x: 20, z: 0, width: 10, depth: 10, height: 60 });

    let found = false;
    for (let i = 0; i < 100 && !found; i++) {
      const bridges = planBridges([towerA, towerB], createRng(`bridge-search-${i}`));
      if (bridges.length === 0) continue;
      found = true;
      const bridge = bridges[0]!;

      expect(bridge.axis).toBe('x');
      expect(bridge.depth).toBe(3); // 3-wide deck across the (secondary) z axis
      expect([30, 50, 70, 90]).toContain(bridge.level);
      expect(bridge.x).toBe(towerA.x + towerA.width); // starts exactly at towerA's facing wall
      expect(bridge.x + bridge.width).toBe(towerB.x); // ends exactly at towerB's facing wall
      expect(bridge.towerA.x).toBe(towerA.x);
      expect(bridge.towerB.x).toBe(towerB.x);
    }
    expect(found).toBe(true);
  });

  it('never bridges towers farther apart than the max gap', () => {
    const towerA = tower({ x: 0, z: 0 });
    const towerB = tower({ x: 100, z: 0 }); // gap = 90, far beyond BRIDGE_MAX_GAP
    for (let i = 0; i < 20; i++) {
      const bridges = planBridges([towerA, towerB], createRng(`far-${i}`));
      expect(bridges).toHaveLength(0);
    }
  });

  it('never bridges towers whose footprints do not laterally overlap by at least the deck width', () => {
    const towerA = tower({ x: 0, z: 0, width: 10, depth: 10 });
    const towerB = tower({ x: 20, z: 30, width: 10, depth: 10 }); // no x or z overlap
    for (let i = 0; i < 20; i++) {
      const bridges = planBridges([towerA, towerB], createRng(`no-overlap-${i}`));
      expect(bridges).toHaveLength(0);
    }
  });

  it('never bridges towers too short to clear any sky level', () => {
    const towerA = tower({ x: 0, z: 0, height: 20 });
    const towerB = tower({ x: 20, z: 0, height: 20 });
    for (let i = 0; i < 20; i++) {
      const bridges = planBridges([towerA, towerB], createRng(`short-${i}`));
      expect(bridges).toHaveLength(0);
    }
  });

  /** Minimal valid shop-interior plan for a tower's tier0 — planBridges only checks truthiness, not shape. */
  function shopPlan(tier0: { x: number; z: number; width: number; depth: number }): NonNullable<BuildingPlan['shopInterior']> {
    return {
      archetype: 'convenience',
      neonColor: NEON_CYAN,
      doorSide: 'south',
      interior: { x0: tier0.x + 1, z0: tier0.z + 1, x1: tier0.x + tier0.width - 2, z1: tier0.z + tier0.depth - 2 },
      core: { x0: tier0.x + 2, z0: tier0.z + 2, x1: tier0.x + tier0.width - 3, z1: tier0.z + tier0.depth - 3 },
    };
  }

  it('connects towers even when both have a planned shop interior (Task 4: only the elevator shaft excludes shops, not the bridge stair shaft)', () => {
    const towerA = tower({ x: 0, z: 0, width: 10, depth: 10, height: 60, shopInterior: shopPlan({ x: 0, z: 0, width: 10, depth: 10 }) });
    const towerB = tower({ x: 20, z: 0, width: 10, depth: 10, height: 60, shopInterior: shopPlan({ x: 20, z: 0, width: 10, depth: 10 }) });

    let found = false;
    for (let i = 0; i < 100 && !found; i++) {
      const bridges = planBridges([towerA, towerB], createRng(`shop-bridge-${i}`));
      if (bridges.length > 0) found = true;
    }
    expect(found).toBe(true);
  });

  it('never lets any single tower anchor more than MAX_BRIDGES_PER_TOWER (3) bridges, even in a dense cluster', () => {
    // A central hub tower surrounded by four short-gap partners on every side
    // it can face: plenty of opportunity to over-connect if the cap were missing.
    const hub = tower({ x: 40, z: 40, width: 12, depth: 12, height: 100 });
    const north = tower({ x: 40, z: 10, width: 12, depth: 12, height: 100 });
    const south = tower({ x: 40, z: 70, width: 12, depth: 12, height: 100 });
    const east = tower({ x: 70, z: 40, width: 12, depth: 12, height: 100 });
    const west = tower({ x: 10, z: 40, width: 12, depth: 12, height: 100 });
    const buildings = [hub, north, south, east, west];

    for (let i = 0; i < 30; i++) {
      const bridges = planBridges(buildings, createRng(`cluster-${i}`));
      const hubCount = bridges.filter((b) => b.towerA === hub || b.towerB === hub).length;
      expect(hubCount).toBeLessThanOrEqual(3);
    }
  });

  it('can pick more than one sky level for a single very tall pair, stacking multiple bridges between the same two towers', () => {
    const towerA = tower({ x: 0, z: 0, width: 12, depth: 12, height: 120 });
    const towerB = tower({ x: 20, z: 0, width: 12, depth: 12, height: 120 });

    let sawMultiLevelPair = false;
    for (let i = 0; i < 300 && !sawMultiLevelPair; i++) {
      const bridges = planBridges([towerA, towerB], createRng(`stack-${i}`));
      const levels = new Set(bridges.map((b) => b.level));
      if (bridges.length >= 2 && levels.size >= 2) sawMultiLevelPair = true;
    }
    expect(sawMultiLevelPair).toBe(true);
  });
});

describe('writeBridge', () => {
  it('writes a flat METAL deck at the chosen level, 2-high NEON rails on the edges, and air door openings into both towers', () => {
    const towerA = tower({ x: 0, z: 0, width: 10, depth: 10, height: 60 });
    const towerB = tower({ x: 20, z: 0, width: 10, depth: 10, height: 60 });

    let bridge = null;
    for (let i = 0; i < 100 && !bridge; i++) {
      const bridges = planBridges([towerA, towerB], createRng(`write-search-${i}`));
      if (bridges.length > 0) bridge = bridges[0]!;
    }
    expect(bridge).not.toBeNull();
    const b = bridge!;

    const world = new World();
    writeBridge(world, b);

    // Deck: solid METAL across the full 3-wide band.
    for (let dx = 0; dx < b.width; dx++) {
      for (let dz = 0; dz < b.depth; dz++) {
        expect(world.getBlock(b.x + dx, b.level, b.z + dz)).toBe(METAL);
      }
    }
    // Rails: 2-high NEON on the two edge rows (axis 'x' => edges are z and z+depth-1).
    for (let dx = 0; dx < b.width; dx++) {
      for (const railZ of [b.z, b.z + b.depth - 1]) {
        expect(world.getBlock(b.x + dx, b.level + 1, railZ)).toBe(NEON_CYAN);
        expect(world.getBlock(b.x + dx, b.level + 2, railZ)).toBe(NEON_CYAN);
      }
    }
    // Middle lane stays clear (walkable), 2 voxels of headroom.
    const midZ = b.z + 1;
    for (let dx = 0; dx < b.width; dx++) {
      expect(world.getBlock(b.x + dx, b.level + 1, midZ)).toBe(AIR);
      expect(world.getBlock(b.x + dx, b.level + 2, midZ)).toBe(AIR);
    }
    // Door openings into both facing walls, at the middle lane.
    expect(world.getBlock(b.x - 1, b.level + 1, midZ)).toBe(AIR);
    expect(world.getBlock(b.x - 1, b.level + 2, midZ)).toBe(AIR);
    expect(world.getBlock(b.x + b.width, b.level + 1, midZ)).toBe(AIR);
    expect(world.getBlock(b.x + b.width, b.level + 2, midZ)).toBe(AIR);
  });
});

describe('stair shafts', () => {
  function findBridge(): ReturnType<typeof planBridges>[number] {
    const towerA = tower({ x: 0, z: 0, width: 10, depth: 10, height: 60 });
    const towerB = tower({ x: 20, z: 0, width: 10, depth: 10, height: 60 });
    for (let i = 0; i < 200; i++) {
      const bridges = planBridges([towerA, towerB], createRng(`shaft-search-${i}`));
      if (bridges.length > 0) return bridges[0]!;
    }
    throw new Error('no bridge found across 200 seeds — bridge search logic likely broken');
  }

  it('produces steps with exactly 1-voxel risers between orthogonally adjacent cells', () => {
    const bridge = findBridge();
    const [shaft] = planStairShafts([bridge]);
    const steps = planStairSteps(shaft!);

    expect(steps.length).toBeGreaterThan(1);
    for (let i = 1; i < steps.length; i++) {
      const prev = steps[i - 1]!;
      const cur = steps[i]!;
      expect(cur.y - prev.y).toBe(1);
      const dx = Math.abs(cur.x - prev.x);
      const dz = Math.abs(cur.z - prev.z);
      // Orthogonally adjacent: exactly one axis changes by exactly 1.
      expect(dx + dz).toBe(1);
    }
  });

  it('connects ground floor to the bridge level', () => {
    const bridge = findBridge();
    const [shaft] = planStairShafts([bridge]);
    const steps = planStairSteps(shaft!);
    expect(steps[0]!.y).toBe(shaft!.baseY);
    expect(steps[steps.length - 1]!.y).toBe(bridge.level);
  });

  it('leaves 2 voxels of headroom (air) above every step surface once written', () => {
    const bridge = findBridge();
    const [shaft] = planStairShafts([bridge]);
    const world = new World();
    writeStairShaft(world, shaft!);

    for (const step of planStairSteps(shaft!)) {
      expect(world.getBlock(step.x, step.y + 1, step.z)).toBe(AIR);
      expect(world.getBlock(step.x, step.y + 2, step.z)).toBe(AIR);
    }
  });

  it('gives both towers of a bridge their own shaft', () => {
    const bridge = findBridge();
    const shafts = planStairShafts([bridge]);
    expect(shafts).toHaveLength(2);
  });
});

describe('sky lobbies (the floor a bridge tower needs at its own level)', () => {
  function findBridgeFor(towerA: BuildingPlan, towerB: BuildingPlan): Bridge {
    for (let i = 0; i < 200; i++) {
      const bridges = planBridges([towerA, towerB], createRng(`lobby-search-${i}`));
      if (bridges.length > 0) return bridges[0]!;
    }
    throw new Error('no bridge found across 200 seeds — bridge search logic likely broken');
  }

  it('gives every stair top step a solid floor directly underneath it, and the deck door threshold too', () => {
    const towerA = tower({ x: 0, z: 0, width: 10, depth: 10, height: 60 });
    const towerB = tower({ x: 20, z: 0, width: 10, depth: 10, height: 60 });
    const bridge = findBridgeFor(towerA, towerB);

    const world = new World();
    writeBridge(world, bridge);
    for (const shaft of planStairShafts([bridge])) writeStairShaft(world, shaft);
    for (const lobby of planSkyLobbies([bridge])) writeSkyLobby(world, lobby);

    for (const shaft of planStairShafts([bridge])) {
      const steps = planStairSteps(shaft);
      const topStep = steps[steps.length - 1]!;
      expect(topStep.y).toBe(bridge.level);
      // The slab and the top step both write CONCRETE at the same cell — either way, solid.
      expect(world.isSolid(topStep.x, topStep.y, topStep.z)).toBe(true);
      expect(world.getBlock(topStep.x, topStep.y + 1, topStep.z)).toBe(AIR);
      expect(world.getBlock(topStep.x, topStep.y + 2, topStep.z)).toBe(AIR);
    }

    // Floor is solid under the door threshold on both facades, not just under the steps.
    expect(world.isSolid(bridge.x - 1, bridge.level, bridge.z + 1)).toBe(true);
    expect(world.isSolid(bridge.x + bridge.width, bridge.level, bridge.z + 1)).toBe(true);
  });

  it("covers the tower's full footprint at that level, except the (up to 3) headroom/climb columns for the risers just below the top step", () => {
    const towerA = tower({ x: 0, z: 0, width: 10, depth: 10, height: 60 });
    const towerB = tower({ x: 20, z: 0, width: 10, depth: 10, height: 60 });
    const bridge = findBridgeFor(towerA, towerB);

    const world = new World();
    const lobbies = planSkyLobbies([bridge]);
    for (const lobby of lobbies) writeSkyLobby(world, lobby);

    for (const t of [bridge.towerA, bridge.towerB]) {
      const tier0 = t.tiers[0]!;
      const lobby = lobbies.find((l) => l.x === tier0.x && l.z === tier0.z);
      expect(lobby).toBeDefined();
      // Exactly the risers whose occupancy-or-climb headroom depends on this
      // row need to stay open — up to 3 (fewer only for a very short shaft).
      // See `planSkyLobbies`'s doc comment for why it's 3, not 2 (Sam's Task
      // 4 rejection: real `tryAutoStep` needs headroom one row higher than
      // plain occupancy does).
      expect(lobby!.openColumns.length).toBeGreaterThan(0);
      expect(lobby!.openColumns.length).toBeLessThanOrEqual(3);

      const openSet = new Set(lobby!.openColumns.map((c) => `${c.x},${c.z}`));
      for (let dx = 0; dx < tier0.width; dx++) {
        for (let dz = 0; dz < tier0.depth; dz++) {
          const x = tier0.x + dx;
          const z = tier0.z + dz;
          if (openSet.has(`${x},${z}`)) continue; // left open for the risers' headroom.
          expect(world.getBlock(x, bridge.level, z)).toBe(CONCRETE);
        }
      }
    }
  });

  it('leaves the stairwell opening clear so the risers just below the top step keep their headroom', () => {
    const towerA = tower({ x: 0, z: 0, width: 10, depth: 10, height: 60 });
    const towerB = tower({ x: 20, z: 0, width: 10, depth: 10, height: 60 });
    const bridge = findBridgeFor(towerA, towerB);

    const world = new World();
    for (const shaft of planStairShafts([bridge])) writeStairShaft(world, shaft);
    for (const lobby of planSkyLobbies([bridge])) writeSkyLobby(world, lobby);

    for (const shaft of planStairShafts([bridge])) {
      for (const step of planStairSteps(shaft)) {
        expect(world.getBlock(step.x, step.y + 1, step.z)).toBe(AIR);
        expect(world.getBlock(step.x, step.y + 2, step.z)).toBe(AIR);
      }
    }
  });

  it('uses the SHRUNKEN setback footprint, not the ground footprint, when the bridge level lands above a setback', () => {
    // Hand-built bridge bypassing planBridges' own isGroundFootprintAt guard,
    // so this exercises tierAt's setback handling directly regardless of
    // whether current bridge selection would ever pick such a level.
    const narrowTier: BuildingPlan['tiers'][number] = { yStart: 20, yEnd: 60, x: 2, z: 2, width: 6, depth: 6 };
    const setbackTower = tower({
      x: 0,
      z: 0,
      width: 10,
      depth: 10,
      height: 60,
      tiers: [
        { yStart: 0, yEnd: 20, x: 0, z: 0, width: 10, depth: 10 },
        narrowTier,
      ],
    });
    const otherTower = tower({ x: 20, z: 0, width: 10, depth: 10, height: 60 });
    const bridge: Bridge = {
      axis: 'x',
      level: 30, // inside the narrow tier (yStart=20..60)
      x: 10,
      z: 3,
      width: 10,
      depth: 3,
      towerA: setbackTower,
      towerB: otherTower,
    };

    const [lobbyA] = planSkyLobbies([bridge]);
    expect(lobbyA).toMatchObject({ x: narrowTier.x, z: narrowTier.z, width: narrowTier.width, depth: narrowTier.depth });

    const world = new World();
    writeSkyLobby(world, lobbyA!);
    // Inside the shrunken footprint: solid floor.
    expect(world.getBlock(narrowTier.x + 1, bridge.level, narrowTier.z + 1)).toBe(CONCRETE);
    // Outside the shrunken footprint but inside the ground footprint: the slab must NOT have
    // been written there using the wrong (wider) tier — this cell stays untouched (AIR).
    expect(world.getBlock(0, bridge.level, 0)).toBe(AIR);
  });
});

describe('planWalkways', () => {
  function downtownBlock(overrides: Partial<CityBlock> = {}): CityBlock {
    return { x: 100, z: 100, width: 20, depth: 20, parcels: [], district: District.DOWNTOWN, ...overrides };
  }

  function layoutWith(blocks: CityBlock[]): CityLayout {
    return { gridSizeX: 384, gridSizeZ: 384, cells: new Uint8Array(384 * 384), blocks };
  }

  it('gives every planned walkway a straight stair with 1-voxel risers reaching WALKWAY_Y, and writes clean headroom', () => {
    const blocks = [downtownBlock({ x: 100, z: 100 }), downtownBlock({ x: 200, z: 200 })];
    const layout = layoutWith(blocks);
    const walkways = planWalkways(layout, 2);
    expect(walkways.length).toBeGreaterThan(0);

    const world = new World();
    for (const walkway of walkways) {
      writeWalkway(world, walkway);
      const steps = walkway.stairSteps;
      expect(steps[0]!.y).toBe(2);
      expect(steps[steps.length - 1]!.y).toBe(12);
      for (let i = 1; i < steps.length; i++) {
        expect(steps[i]!.y - steps[i - 1]!.y).toBe(1);
      }
      for (const step of steps) {
        expect(world.getBlock(step.x, step.y + 1, step.z)).toBe(AIR);
        expect(world.getBlock(step.x, step.y + 2, step.z)).toBe(AIR);
      }
      // Deck is a flat METAL surface at WALKWAY_Y.
      for (let dx = 0; dx < walkway.width; dx++) {
        for (let dz = 0; dz < walkway.depth; dz++) {
          expect(world.getBlock(walkway.x + dx, 12, walkway.z + dz)).toBe(METAL);
        }
      }
    }
  });
});

describe('planStreetlights', () => {
  it('places a light at the center of every interior road intersection, on a ROAD cell', () => {
    const gridSize = 100;
    const cells = new Uint8Array(gridSize * gridSize).fill(CellType.BLOCK);
    // Two road bands crossing: x in [40,45) and z in [40,45).
    for (let x = 0; x < gridSize; x++) {
      for (let z = 40; z < 45; z++) cells[x + z * gridSize] = CellType.ROAD;
    }
    for (let z = 0; z < gridSize; z++) {
      for (let x = 40; x < 45; x++) cells[x + z * gridSize] = CellType.ROAD;
    }
    const blocks: CityBlock[] = [
      { x: 0, z: 0, width: 40, depth: 40, parcels: [], district: District.RESIDENTIAL },
      { x: 45, z: 0, width: 40, depth: 40, parcels: [], district: District.RESIDENTIAL },
      { x: 0, z: 45, width: 40, depth: 40, parcels: [], district: District.RESIDENTIAL },
      { x: 45, z: 45, width: 40, depth: 40, parcels: [], district: District.RESIDENTIAL },
    ];
    const layout: CityLayout = { gridSizeX: gridSize, gridSizeZ: gridSize, cells, blocks };

    const lights = planStreetlights(layout);
    expect(lights).toHaveLength(1);
    expect(lights[0]).toEqual({ x: 42, z: 42 });
  });
});

describe('writeStreetlight', () => {
  it('writes a METAL pole topped with a NEON_CYAN head', () => {
    const world = new World();
    writeStreetlight(world, { x: 10, z: 10 }, 1);
    for (let h = 1; h <= 5; h++) {
      expect(world.getBlock(10, 1 + h, 10)).toBe(METAL);
    }
    expect(world.getBlock(10, 7, 10)).toBe(NEON_CYAN);
  });
});

describe('planBillboards / writeBillboard', () => {
  it('never places a billboard on a building that already has a sign strip', () => {
    const withSign = tower({
      x: 0,
      z: 0,
      signStrip: { side: 'north', offset: 2, yStart: 3, height: 10, color: NEON_CYAN },
    });
    for (let i = 0; i < 30; i++) {
      const billboards = planBillboards([withSign], createRng(`billboard-skip-${i}`));
      expect(billboards).toHaveLength(0);
    }
  });

  it('never places a billboard on the building\'s door-facing side', () => {
    const plain = tower({ x: 0, z: 0, doorSide: 'south' });
    let sawAny = false;
    for (let i = 0; i < 100; i++) {
      const billboards = planBillboards([plain], createRng(`billboard-side-${i}`));
      for (const b of billboards) {
        sawAny = true;
        expect(b.side).not.toBe('south');
      }
    }
    expect(sawAny).toBe(true);
  });

  it('writes a solid neon rectangle of the expected footprint', () => {
    const plain = tower({ x: 0, z: 0, width: 12, depth: 12, height: 30, doorSide: 'south' });
    let written = false;
    for (let i = 0; i < 100 && !written; i++) {
      const billboards = planBillboards([plain], createRng(`billboard-write-${i}`));
      if (billboards.length === 0) continue;
      const billboard = billboards[0]!;
      const world = new World();
      writeBillboard(world, billboard);
      const tier0 = billboard.building.tiers[0]!;
      for (let h = 0; h < 3; h++) {
        for (let w = 0; w < 4; w++) {
          const y = billboard.building.baseY + billboard.yStart + h;
          if (billboard.side === 'south') expect(world.getBlock(billboard.offset + w, y, tier0.z)).toBe(billboard.color);
          if (billboard.side === 'north')
            expect(world.getBlock(billboard.offset + w, y, tier0.z + tier0.depth - 1)).toBe(billboard.color);
        }
      }
      written = true;
    }
    expect(written).toBe(true);
  });
});

describe('planElevatorShafts / writeElevatorShaft', () => {
  it('never marks a tower that already got a real stair shaft, below the coexistence footprint threshold (width/depth 10 < 12)', () => {
    const withStairs = tower({ x: 0, z: 0, height: 60 });
    const stairKeys = new Set([towerKey(withStairs)]);
    for (let i = 0; i < 30; i++) {
      const markers = planElevatorShafts([withStairs], createRng(`elevator-skip-${i}`), stairKeys);
      expect(markers).toHaveLength(0);
    }
  });

  it('allows an elevator to coexist with a real stair shaft once the footprint clears the coexistence threshold (12x12)', () => {
    const withStairs = tower({ x: 0, z: 0, width: 12, depth: 12, height: 60 });
    const stairKeys = new Set([towerKey(withStairs)]);
    let found = false;
    for (let i = 0; i < 30 && !found; i++) {
      const markers = planElevatorShafts([withStairs], createRng(`elevator-coexist-${i}`), stairKeys);
      if (markers.length === 0) continue;
      found = true;
      expect(markers[0]!.coexistsWithStairShaft).toBe(true);
    }
    expect(found).toBe(true);
  });

  it('still excludes a stair-shaft tower whose footprint touches on both axes (10x10, 11x11, and the 10/11 mixes)', () => {
    const stairKeysForKey = (t: BuildingPlan) => new Set([towerKey(t)]);
    const bothTouching = [
      tower({ x: 0, z: 0, width: 10, depth: 10, height: 60 }),
      tower({ x: 0, z: 0, width: 11, depth: 11, height: 60 }),
      tower({ x: 0, z: 0, width: 10, depth: 11, height: 60 }),
      tower({ x: 0, z: 0, width: 11, depth: 10, height: 60 }),
    ];
    for (const t of bothTouching) {
      for (let i = 0; i < 30; i++) {
        const markers = planElevatorShafts([t], createRng(`elevator-both-touching-${i}`), stairKeysForKey(t));
        expect(markers, `width ${t.width}, depth ${t.depth}`).toHaveLength(0);
      }
    }
  });

  it('now allows coexistence when only ONE axis clears the threshold — the diagonally-separated case reclaimed from the old both-axes gate', () => {
    const stairKeysForKey = (t: BuildingPlan) => new Set([towerKey(t)]);
    // Width touches (10 or 11) but depth clears 12 (or vice versa): the two
    // 3x3 rects are diagonally offset — no shared wall — so this is now safe.
    const oneAxisClear = [
      tower({ x: 0, z: 0, width: 11, depth: 12, height: 60 }),
      tower({ x: 0, z: 0, width: 12, depth: 11, height: 60 }),
      tower({ x: 0, z: 0, width: 10, depth: 14, height: 60 }),
      tower({ x: 0, z: 0, width: 14, depth: 10, height: 60 }),
    ];
    for (const t of oneAxisClear) {
      let found = false;
      for (let i = 0; i < 30 && !found; i++) {
        const markers = planElevatorShafts([t], createRng(`elevator-one-axis-clear-${t.width}x${t.depth}-${i}`), stairKeysForKey(t));
        if (markers.length === 0) continue;
        found = true;
        expect(markers[0]!.coexistsWithStairShaft).toBe(true);
      }
      expect(found, `width ${t.width}, depth ${t.depth}`).toBe(true);
    }
  });

  it('still skips a tower with a planned shop interior even though bridges no longer exclude it (Task 4: only the elevator shaft is shop-excluded)', () => {
    const withShop = tower({
      x: 0,
      z: 0,
      width: 12,
      depth: 12,
      height: 60,
      shopInterior: {
        archetype: 'convenience',
        neonColor: NEON_CYAN,
        doorSide: 'south',
        interior: { x0: 1, z0: 1, x1: 10, z1: 10 },
        core: { x0: 2, z0: 2, x1: 9, z1: 9 },
      },
    });
    for (let i = 0; i < 30; i++) {
      const markers = planElevatorShafts([withShop], createRng(`elevator-shop-skip-${i}`), new Set());
      expect(markers).toHaveLength(0);
    }
  });

  it('never shares a column between the centered stair-shaft footprint and the NW-corner elevator footprint, on every footprint the predicate allows', () => {
    // Square towers at the coexistence threshold and above, plus the newly
    // reclaimed asymmetric shapes (one axis touching at 10/11, the other
    // clearing 12) — see `canElevatorAndStairShaftCoexist`'s doc comment.
    const sizes: Array<[number, number]> = [
      [12, 12],
      [13, 13],
      [20, 20],
      [10, 14],
      [14, 10],
      [11, 12],
      [12, 11],
    ];
    for (const [width, depth] of sizes) {
      expect(canElevatorAndStairShaftCoexist(width, depth), `width ${width}, depth ${depth}`).toBe(true);
      const t = tower({ x: 0, z: 0, width, depth, height: 60 });
      const stairColumns = new Set(stairShaftFootprintColumns(t).map((c) => `${c.x},${c.z}`));
      const elevatorColumns: Array<{ x: number; z: number }> = [];
      for (let dx = 0; dx < 3; dx++) {
        for (let dz = 0; dz < 3; dz++) elevatorColumns.push({ x: t.x + 1 + dx, z: t.z + 1 + dz });
      }

      for (const c of elevatorColumns) {
        expect(stairColumns.has(`${c.x},${c.z}`), `width ${width}, depth ${depth}: (${c.x},${c.z})`).toBe(false);
      }

      // Clearance: the nearest stair column must be at least 2 voxels away
      // (Chebyshev) from the nearest elevator column whenever BOTH axes
      // clear the threshold; the diagonally-separated shapes only guarantee
      // clearance on their one clear axis, not overall Chebyshev distance.
      const bothAxesClear = width >= 12 && depth >= 12;
      if (bothAxesClear) {
        let minChebyshev = Infinity;
        for (const e of elevatorColumns) {
          for (const s of stairShaftFootprintColumns(t)) {
            minChebyshev = Math.min(minChebyshev, Math.max(Math.abs(e.x - s.x), Math.abs(e.z - s.z)));
          }
        }
        expect(minChebyshev, `width ${width}, depth ${depth}`).toBeGreaterThanOrEqual(2);
      }
    }
  });

  it('canElevatorAndStairShaftCoexist truth table at the key footprint sizes', () => {
    // Both axes touching (gap 0 on x AND z): fused-wall risk, stays excluded.
    expect(canElevatorAndStairShaftCoexist(10, 10)).toBe(false);
    expect(canElevatorAndStairShaftCoexist(11, 11)).toBe(false);
    expect(canElevatorAndStairShaftCoexist(10, 11)).toBe(false);
    expect(canElevatorAndStairShaftCoexist(11, 10)).toBe(false);

    // Exactly one axis clears 12: rects are diagonally offset, no shared
    // wall — newly reclaimed by this task.
    expect(canElevatorAndStairShaftCoexist(10, 14)).toBe(true);
    expect(canElevatorAndStairShaftCoexist(14, 10)).toBe(true);
    expect(canElevatorAndStairShaftCoexist(11, 12)).toBe(true);
    expect(canElevatorAndStairShaftCoexist(12, 11)).toBe(true);

    // Both axes clear 12: unchanged from the old gate.
    expect(canElevatorAndStairShaftCoexist(12, 12)).toBe(true);
    expect(canElevatorAndStairShaftCoexist(20, 20)).toBe(true);
  });

  it("never opens an elevator door into a forbidden (stair-shaft) column when coexisting — picks the next candidate edge instead", () => {
    // Synthetic geometry: a real bridge tower can never get a stair shaft
    // below `BRIDGE_MIN_TOWER_FOOTPRINT` (10), so this exact tiny 4x8
    // footprint never occurs in the real pipeline (the geometric proof in
    // `canElevatorAndStairShaftCoexist`'s doc comment shows the two
    // footprints can never even touch a probe cell at any real footprint).
    // It's built here purely to force the normally-preferred south door
    // edge's cells inside `stairShaftFootprintColumns`' rectangle, isolating
    // the defensive skip in `pickDoorEdge` from the geometry that (correctly)
    // never exercises it on real output.
    const t = tower({
      x: 0,
      z: 0,
      width: 4,
      depth: 8,
      height: 40,
      tiers: [{ yStart: 0, yEnd: 40, x: 0, z: 0, width: 4, depth: 8 }],
    });
    const world = new World();
    for (let x = -3; x < 8; x++) {
      for (let z = -3; z < 12; z++) {
        world.setBlockRaw(x, t.baseY - 1, z, CONCRETE); // footing everywhere a door edge might open
      }
    }
    writeBuilding(world, t);

    // Sanity: this synthetic tier0 really does put the stair-shaft footprint
    // where it collides with the south door's cells.
    const stairColumns = new Set(stairShaftFootprintColumns(t).map((c) => `${c.x},${c.z}`));
    expect(stairColumns.has('2,3')).toBe(true); // south door cell (origin (1,1) + doorOffset (1,2))

    writeElevatorShaft(world, { building: t, x: 1, z: 1, coexistsWithStairShaft: true });

    // South door stays sealed — its column sits inside the forbidden stair footprint.
    expect(world.getBlock(2, t.baseY, 3)).toBe(ELEVATOR_SHAFT);
    // East door opens instead — clear of the stair footprint, with real footing.
    expect(world.getBlock(3, t.baseY, 2)).toBe(AIR);
  });

  it('writes a hollow 3x3 shaft of ELEVATOR_SHAFT wall blocks from ground to roof', () => {
    const t = tower({ x: 0, z: 0, width: 10, depth: 10, height: 40 });
    let written = false;
    for (let i = 0; i < 30 && !written; i++) {
      const markers = planElevatorShafts([t], createRng(`elevator-write-${i}`), new Set());
      if (markers.length === 0) continue;
      const marker = markers[0]!;
      const world = new World();
      writeElevatorShaft(world, marker);
      // Perimeter is ELEVATOR_SHAFT at a plain mid-shaft row (not a door row)...
      expect(world.getBlock(marker.x, t.baseY + 10, marker.z)).toBe(ELEVATOR_SHAFT);
      // ...and the center column stays hollow (air), an open shaft well.
      expect(world.getBlock(marker.x + 1, t.baseY + 5, marker.z + 1)).toBe(AIR);
      written = true;
    }
    expect(written).toBe(true);
  });

  it('carves a rideable ground-to-roof shaft: door openings at every stop, well punched clear through each deck', () => {
    const t = tower({ x: 0, z: 0, width: 10, depth: 10, height: 40 }); // single-tier (<= SETBACK_MIN_HEIGHT): stops are exactly ground + roof
    let written = false;
    for (let i = 0; i < 30 && !written; i++) {
      const markers = planElevatorShafts([t], createRng(`elevator-stops-${i}`), new Set());
      if (markers.length === 0) continue;
      const marker = markers[0]!;
      const world = new World();
      // Real footing everywhere `writeElevatorShaft` would run in the actual
      // pipeline: the citywide ground surface (`CityGenerator.paintGround`)
      // one row below baseY, and the tower's own shell/roof deck
      // (`writeBuilding` always runs before elevator shafts in
      // `placeVerticalInfrastructure`) — `pickDoorEdge` now requires genuine
      // footing behind a doorway, not just open air.
      for (let x = -2; x < 12; x++) {
        for (let z = -2; z < 12; z++) {
          world.setBlockRaw(x, t.baseY - 1, z, CONCRETE);
        }
      }
      writeBuilding(world, t);
      writeElevatorShaft(world, marker);

      const wellX = marker.x + 1;
      const wellZ = marker.z + 1;
      // Tower is 10x10 with plenty of interior beyond the shaft, so the door
      // opens on the south edge (see `pickDoorEdge`'s preference order) —
      // never the north edge, which would open straight onto the tower's own
      // perimeter wall one cell away (that was the phase-2 defect: an
      // unenterable/unexitable elevator at every stop).
      const doorX = marker.x + 1;
      const doorZ = marker.z + 2;
      const roofDeckY = t.baseY + t.height;

      // Ground doorway (2 voxels tall) into the shaft's well, plus neon frame posts either side.
      for (const y of [t.baseY, t.baseY + 1]) {
        expect(world.getBlock(doorX, y, doorZ)).toBe(AIR);
        expect(world.getBlock(marker.x, y, marker.z + 2)).toBe(NEON_CYAN);
        expect(world.getBlock(marker.x + 2, y, marker.z + 2)).toBe(NEON_CYAN);
      }
      // And confirm the north edge — the old (broken) door location — was
      // never touched: still solid shaft wall, not carved open.
      for (const y of [t.baseY, t.baseY + 1]) {
        expect(world.getBlock(marker.x + 1, y, marker.z)).toBe(ELEVATOR_SHAFT);
      }

      // Roof deck: the well is punched clear through the floor, and the roof doorway is carved the same way.
      expect(world.getBlock(wellX, roofDeckY, wellZ)).toBe(AIR);
      for (const y of [roofDeckY + 1, roofDeckY + 2]) {
        expect(world.getBlock(doorX, y, doorZ)).toBe(AIR);
      }

      written = true;
    }
    expect(written).toBe(true);
  });

  it('never lets the shaft rise past the highest tier whose footprint still contains it', () => {
    // Upper tier is inset by 3 on every side, well past the shaft's 1-voxel margin from tier0's corner -> shaft can only reach tier0's own boundary.
    const t = tower({
      x: 0,
      z: 0,
      width: 20,
      depth: 20,
      height: 60,
      tiers: [
        { yStart: 0, yEnd: 30, x: 0, z: 0, width: 20, depth: 20 },
        { yStart: 30, yEnd: 60, x: 3, z: 3, width: 14, depth: 14 },
      ],
    });
    let written = false;
    for (let i = 0; i < 30 && !written; i++) {
      const markers = planElevatorShafts([t], createRng(`elevator-cap-${i}`), new Set());
      if (markers.length === 0) continue;
      const marker = markers[0]!;
      const world = new World();
      writeElevatorShaft(world, marker);

      const wellX = marker.x + 1;
      const wellZ = marker.z + 1;
      const tier0DeckY = t.baseY + 30;

      // The shaft stops at tier0's own boundary — its well is punched through that deck...
      expect(world.getBlock(wellX, tier0DeckY, wellZ)).toBe(AIR);
      // ...but the wall tube never extends up to the (unreachable) true roof at all.
      expect(world.getBlock(marker.x, t.baseY + t.height, marker.z)).toBe(AIR);
      written = true;
    }
    expect(written).toBe(true);
  });

  /**
   * Regression coverage for a real, shipped defect (Sam's residual
   * bridge-reach review sweep, seeds `sam-probe-3`/`sam-probe-7` among
   * others): the elevator's fixed NW-corner footprint sits close enough to a
   * tower's own north/west wall that a bridge door carved into *that* wall
   * (always `bridge.towerB`'s door — see `canElevatorAndBridgeDoorCoexist`'s
   * doc comment) lands directly in the elevator's path, one row behind the
   * threshold. `canElevatorAndStairShaftCoexist` alone never caught this — it
   * only ever compares the elevator against the *centered* stair shaft, never
   * against a bridge door on the elevator's own near walls.
   */
  function bridgeAt(towerA: BuildingPlan, towerB: BuildingPlan, axis: 'x' | 'z', transverseOffset: number): Bridge {
    return axis === 'x'
      ? { axis, level: 30, x: towerA.x + towerA.width, z: towerB.z + transverseOffset - 1, width: 4, depth: 3, towerA, towerB }
      : { axis, level: 30, x: towerB.x + transverseOffset - 1, z: towerA.z + towerA.depth, width: 3, depth: 4, towerA, towerB };
  }

  it('never places an elevator whose fixed corner would block a bridge door on its own north wall (axis z, towerB)', () => {
    const towerA = tower({ x: 0, z: 0, width: 12, depth: 12, height: 60 });
    const towerB = tower({ x: 0, z: 30, width: 12, depth: 12, height: 60 });
    // Door's transverse (x) offset relative to towerB's own tier0 = 2, squarely inside the elevator's [1,3] range.
    const bridge = bridgeAt(towerA, towerB, 'z', 2);
    for (let i = 0; i < 30; i++) {
      const markers = planElevatorShafts([towerB], createRng(`elevator-door-block-z-${i}`), new Set(), [bridge]);
      expect(markers).toHaveLength(0);
    }
  });

  it('never places an elevator whose fixed corner would block a bridge door on its own west wall (axis x, towerB)', () => {
    const towerA = tower({ x: 0, z: 0, width: 12, depth: 12, height: 60 });
    const towerB = tower({ x: 30, z: 0, width: 12, depth: 12, height: 60 });
    const bridge = bridgeAt(towerA, towerB, 'x', 2);
    for (let i = 0; i < 30; i++) {
      const markers = planElevatorShafts([towerB], createRng(`elevator-door-block-x-${i}`), new Set(), [bridge]);
      expect(markers).toHaveLength(0);
    }
  });

  it('still allows an elevator when the bridge door offset clears the elevator range entirely', () => {
    const towerA = tower({ x: 0, z: 0, width: 12, depth: 12, height: 60 });
    const towerB = tower({ x: 0, z: 30, width: 12, depth: 12, height: 60 });
    // Offset 6 is well past the elevator's [1,3] range on a 12-wide tower.
    const bridge = bridgeAt(towerA, towerB, 'z', 6);
    let found = false;
    for (let i = 0; i < 30 && !found; i++) {
      const markers = planElevatorShafts([towerB], createRng(`elevator-door-clear-${i}`), new Set(), [bridge]);
      if (markers.length > 0) found = true;
    }
    expect(found).toBe(true);
  });

  it('never restricts towerA (the far-wall side of the bridge) — only towerB is ever at risk', () => {
    const towerA = tower({ x: 0, z: 0, width: 12, depth: 12, height: 60 });
    const towerB = tower({ x: 0, z: 30, width: 12, depth: 12, height: 60 });
    const bridge = bridgeAt(towerA, towerB, 'z', 2); // blocks towerB, irrelevant to towerA's own far (south) wall
    let found = false;
    for (let i = 0; i < 30 && !found; i++) {
      const markers = planElevatorShafts([towerA], createRng(`elevator-towerA-unaffected-${i}`), new Set(), [bridge]);
      if (markers.length > 0) found = true;
    }
    expect(found).toBe(true);
  });

  it('revert-probe: without the bridges argument (the pre-fix call shape), the blocking elevator is placed again', () => {
    const towerB = tower({ x: 0, z: 30, width: 12, depth: 12, height: 60 });
    let found = false;
    for (let i = 0; i < 30 && !found; i++) {
      // Same rng draws as the blocked case above, but `bridges` omitted entirely -- proves the gate, not the rng roll, is what suppresses the marker.
      const markers = planElevatorShafts([towerB], createRng(`elevator-door-block-z-${i}`), new Set());
      if (markers.length > 0) found = true;
    }
    expect(found).toBe(true);
  });
});

describe('parks ground materials smoke test (shared block ids)', () => {
  it('GRAVEL and PARK_GRASS are distinct registered block ids', () => {
    expect(GRAVEL).not.toBe(PARK_GRASS);
  });
});
