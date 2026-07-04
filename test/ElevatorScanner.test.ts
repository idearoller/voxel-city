import { describe, expect, it } from 'vitest';
import type { BuildingPlan } from '../src/gen/buildings';
import { writeBuilding } from '../src/gen/buildings';
import { District } from '../src/gen/districts';
import { planElevatorShafts, writeElevatorShaft } from '../src/gen/infrastructure';
import { createRng } from '../src/gen/rng';
import { scanElevatorShafts } from '../src/elevators/ElevatorScanner';
import { AIR, CONCRETE, ELEVATOR_SHAFT, METAL } from '../src/world/BlockRegistry';
import { World } from '../src/world/World';

/**
 * Paints a solid citywide ground surface one row below `baseY`, matching
 * `CityGenerator.paintGround`'s convention (real generator output always has
 * this; a bare `writeElevatorShaft` unit-test fixture must recreate it, since
 * `pickDoorEdge` now requires genuine footing — not just open air — behind a
 * doorway, see `gen/infrastructure.ts`).
 */
function paintGroundPlane(world: World, baseY: number, min: number, max: number): void {
  for (let x = min; x < max; x++) {
    for (let z = min; z < max; z++) {
      world.setBlockRaw(x, baseY - 1, z, CONCRETE);
    }
  }
}

function tower(overrides: Partial<BuildingPlan> = {}): BuildingPlan {
  const x = overrides.x ?? 0;
  const z = overrides.z ?? 0;
  const width = overrides.width ?? 10;
  const depth = overrides.depth ?? 10;
  const baseY = overrides.baseY ?? 2;
  const height = overrides.height ?? 40;
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

/** Builds a single hand-built shaft the same way the generator does (single-tier tower -> exactly a ground + roof stop) and returns its World + marker geometry. */
function buildGeneratedShaftWorld(height = 40): { world: World; wellX: number; wellZ: number; baseY: number; height: number } {
  const t = tower({ x: 0, z: 0, width: 10, depth: 10, height });
  const world = new World();
  paintGroundPlane(world, t.baseY, -2, 12);
  writeBuilding(world, t); // real shell + roof deck: pickDoorEdge needs genuine footing, not just an empty bare world
  for (let i = 0; i < 30; i++) {
    const markers = planElevatorShafts([t], createRng(`scanner-fixture-${i}`), new Set());
    if (markers.length === 0) continue;
    const marker = markers[0]!;
    writeElevatorShaft(world, marker);
    return { world, wellX: marker.x + 1, wellZ: marker.z + 1, baseY: t.baseY, height };
  }
  throw new Error('failed to roll an elevator marker across 30 seeds — check ELEVATOR_CHANCE/ELEVATOR_MIN_HEIGHT');
}

describe('scanElevatorShafts', () => {
  it('derives the well position and ground+roof stops from a generator-built shaft', () => {
    const { world, wellX, wellZ, baseY, height } = buildGeneratedShaftWorld(40);

    const shafts = scanElevatorShafts(world);
    expect(shafts).toHaveLength(1);
    const shaft = shafts[0]!;

    expect(shaft.wellX).toBe(wellX);
    expect(shaft.wellZ).toBe(wellZ);
    // Ground stop's feet-Y is baseY (city ground surface is one below baseY); roof stop's feet-Y is baseY+height+1.
    expect(shaft.stops).toEqual([baseY, baseY + height + 1]);
  });

  it('derives an additional mid-height stop for a setback tower whose upper tier still contains the shaft', () => {
    const t = tower({
      x: 0,
      z: 0,
      width: 20,
      depth: 20,
      height: 60,
      tiers: [
        { yStart: 0, yEnd: 30, x: 0, z: 0, width: 20, depth: 20 },
        // inset by exactly 1: still contains the shaft at (tier0.x+1, tier0.z+1), margin-0 containment holds.
        { yStart: 30, yEnd: 60, x: 1, z: 1, width: 18, depth: 18 },
      ],
    });
    const world = new World();
    paintGroundPlane(world, t.baseY, -2, 22);
    writeBuilding(world, t);
    let found = false;
    for (let i = 0; i < 30 && !found; i++) {
      const markers = planElevatorShafts([t], createRng(`scanner-midstop-${i}`), new Set());
      if (markers.length === 0) continue;
      writeElevatorShaft(world, markers[0]!);
      found = true;
    }
    expect(found).toBe(true);

    const shafts = scanElevatorShafts(world);
    expect(shafts).toHaveLength(1);
    // ground (baseY), tier0 boundary (baseY+30+1), roof (baseY+60+1).
    expect(shafts[0]!.stops).toEqual([t.baseY, t.baseY + 31, t.baseY + 61]);
  });

  it('is stable and NaN/crash-free on an empty world (no shafts at all)', () => {
    const world = new World();
    expect(scanElevatorShafts(world)).toEqual([]);
  });

  it('gracefully deactivates a shaft with a wall column punched out by a sandbox edit', () => {
    const { world, wellX, wellZ } = buildGeneratedShaftWorld(40);
    expect(scanElevatorShafts(world)).toHaveLength(1);

    // Blow out one whole corner wall column (a sandbox "remove" reaching top to bottom).
    for (let y = 0; y < 200; y++) {
      if (world.getBlock(wellX - 1, y, wellZ - 1) === ELEVATOR_SHAFT) {
        world.setBlock(wellX - 1, y, wellZ - 1, AIR);
      }
    }

    expect(scanElevatorShafts(world)).toEqual([]);
  });

  it('rejects a shaft whose 8 ring wall columns never overlap in Y (broken tube), without throwing', () => {
    const world = new World();
    const ox = 5;
    const oz = 5;
    const ringOffsets: Array<[number, number]> = [
      [0, 0],
      [1, 0],
      [2, 0],
      [0, 1],
      [2, 1],
      [0, 2],
      [1, 2],
      [2, 2],
    ];
    // Every ring column gets a single ELEVATOR_SHAFT block, but at a different, non-overlapping Y each time.
    ringOffsets.forEach(([dx, dz], i) => {
      world.setBlockRaw(ox + dx, i * 10, oz + dz, ELEVATOR_SHAFT);
    });

    expect(() => scanElevatorShafts(world)).not.toThrow();
    expect(scanElevatorShafts(world)).toEqual([]);
  });

  it('rejects a shaft with fewer than 2 stops (a sealed tube with no doorway at all)', () => {
    const world = new World();
    const ox = 5;
    const oz = 5;
    for (let y = 0; y < 20; y++) {
      for (let dx = 0; dx < 3; dx++) {
        for (let dz = 0; dz < 3; dz++) {
          if (dx === 1 && dz === 1) continue; // hollow well
          world.setBlockRaw(ox + dx, y, oz + dz, ELEVATOR_SHAFT);
        }
      }
    }
    // No doorway ever carved -> zero stops -> not a functional elevator.
    expect(scanElevatorShafts(world)).toEqual([]);
  });
});
