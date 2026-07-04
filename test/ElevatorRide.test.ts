import { describe, expect, it } from 'vitest';
import type { BuildingPlan } from '../src/gen/buildings';
import { writeBuilding } from '../src/gen/buildings';
import { District } from '../src/gen/districts';
import { planElevatorShafts, writeElevatorShaft } from '../src/gen/infrastructure';
import { createRng } from '../src/gen/rng';
import { scanElevatorShafts, type ElevatorShaft } from '../src/elevators/ElevatorScanner';
import { ElevatorSimulation } from '../src/elevators/ElevatorSimulation';
import {
  isStandingOnSupport,
  isVoxelInsideSupport,
  moveAndCollide,
  type SupportSurface,
} from '../src/player/PlayerCollision';
import { AIR, CONCRETE, ELEVATOR_SHAFT, METAL } from '../src/world/BlockRegistry';
import { World } from '../src/world/World';

const TICK = 1 / 60;

/** Real-floor walkability at `feetY`: solid underfoot, 2 clear voxels above — same convention `CityGenerator.test.ts`'s connectivity check uses. */
function isWalkableFeet(world: World, x: number, feetY: number, z: number): boolean {
  return world.isSolid(x, feetY - 1, z) && !world.isSolid(x, feetY, z) && !world.isSolid(x, feetY + 1, z);
}

/**
 * 4-connected flood fill of standable cells at a fixed feet height, starting
 * from `start` — but `start` itself is always treated as walkable
 * regardless of world blocks, since it's the elevator *platform*, a
 * synthetic support surface with no real floor voxel underneath (see
 * `PlayerCollision.SupportSurface`). Every other cell must be a real,
 * unassisted floor. This is the direct counter to the shipped defect: a
 * doorway that opens onto a solid wall (or a 1-cell dead-end pocket boxed in
 * by the tower's own perimeter) floods to only the start cell itself plus
 * maybe one pocket — nowhere near a real interior.
 */
function floodFillStandableCount(
  world: World,
  start: { x: number; z: number },
  feetY: number,
  maxCells = 500,
): number {
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

/** Below this, a "reachable area" is really just the well plus a sealed door pocket — the exact shape of the shipped defect. */
const SEALED_POCKET_CEILING = 2;
/** A genuinely open interior floor, well above what a sealed pocket could ever flood to. */
const REAL_INTERIOR_FLOOR = 20;

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
    rng: createRng('fixture'),
    ...overrides,
  };
}

/**
 * A tower with a functional elevator shaft and, deliberately, no stair shaft
 * at all — the roof interior is reachable *only* by riding the elevator.
 * Mirrors the real generator's ground-surface convention (solid at
 * baseY - 1) just enough for the ground stop to have real footing.
 */
function buildIsolatedTowerWithElevator(): { world: World; shaft: ElevatorShaft; baseY: number; roofFeetY: number } {
  const height = 40;
  const t = tower({ x: 0, z: 0, width: 10, depth: 10, height });
  const world = new World();

  for (let x = -2; x < 12; x++) {
    for (let z = -2; z < 12; z++) {
      world.setBlockRaw(x, t.baseY - 1, z, CONCRETE);
    }
  }
  writeBuilding(world, t);

  for (let i = 0; i < 30; i++) {
    const markers = planElevatorShafts([t], createRng(`ride-fixture-${i}`), new Set());
    if (markers.length === 0) continue;
    writeElevatorShaft(world, markers[0]!);
    const shafts = scanElevatorShafts(world);
    const shaft = shafts[0] as ElevatorShaft;
    return { world, shaft, baseY: t.baseY, roofFeetY: t.baseY + height + 1 };
  }
  throw new Error('failed to roll an elevator marker across 30 seeds');
}

/** One PlayController-style tick: carries the rider by the platform's delta if standing on it, then resolves normal gravity/collision against world solidity + the platform's synthetic solid slab. */
function tickRider(
  world: World,
  feet: readonly [number, number, number],
  velocityY: number,
  support: SupportSurface | null,
): { feet: readonly [number, number, number]; velocityY: number; grounded: boolean } {
  const riding = support !== null && isStandingOnSupport(feet, support);
  let carried = feet;
  let vy = velocityY;
  if (riding) {
    carried = [feet[0], support!.surfaceY, feet[2]];
    vy = 0;
  }

  const isSolid = support
    ? (x: number, y: number, z: number) => world.isSolid(x, y, z) || isVoxelInsideSupport(x, y, z, support)
    : (x: number, y: number, z: number) => world.isSolid(x, y, z);

  const nextVy = vy - 27 * TICK;
  const result = moveAndCollide(isSolid, carried, [0, nextVy, 0], TICK);
  return { feet: result.position, velocityY: result.velocity[1], grounded: riding || result.grounded };
}

describe('elevator ride: player-carry + only-reachable-by-elevator connectivity', () => {
  it('carries the rider smoothly from the ground stop to the roof stop with no fall-through and no clipping', () => {
    const { world, shaft } = buildIsolatedTowerWithElevator();

    // Sanity check *before* riding: the ground stop's doorway must actually
    // lead somewhere. Flood-filling from the well (the platform's own
    // footprint, not a real floor voxel — see `floodFillStandableCount`)
    // through the doorway must reach a real interior floor, not just the
    // well plus a sealed door pocket (the exact shape of the shipped
    // defect, where the door opened onto the tower's own perimeter wall).
    const groundReach = floodFillStandableCount(world, { x: shaft.wellX, z: shaft.wellZ }, shaft.stops[0] as number);
    expect(groundReach).toBeGreaterThan(SEALED_POCKET_CEILING);
    expect(groundReach).toBeGreaterThanOrEqual(REAL_INTERIOR_FLOOR);

    const sim = new ElevatorSimulation();
    sim.sync([shaft]);

    // Rider starts standing in the well at the ground stop.
    let feet: readonly [number, number, number] = [shaft.wellX + 0.5, shaft.stops[0] as number, shaft.wellZ + 0.5];
    let velocityY = 0;

    sim.call(shaft, 1); // call the car up to the next (roof) stop

    for (let i = 0; i < 60 * 30; i++) {
      sim.update(TICK);
      const car = sim.car(shaft.id)!;
      const support: SupportSurface = {
        minX: shaft.wellX,
        maxX: shaft.wellX + 1,
        minZ: shaft.wellZ,
        maxZ: shaft.wellZ + 1,
        surfaceY: car.feetY,
        deltaY: car.lastDeltaY,
      };
      const step = tickRider(world, feet, velocityY, support);
      feet = step.feet;
      velocityY = step.velocityY;

      // The rider must never fall below the platform's current surface (that
      // would be fall-through) nor drift meaningfully away from it (that
      // would be clipping through the shaft wall or losing the carry).
      expect(feet[1]).toBeGreaterThanOrEqual(car.feetY - 0.01);
      expect(feet[1]).toBeLessThanOrEqual(car.feetY + 0.01);

      if (car.targetFeetY === null && car.feetY === shaft.stops[shaft.stops.length - 1]) break;
    }

    const finalCar = sim.car(shaft.id)!;
    expect(finalCar.feetY).toBe(shaft.stops[shaft.stops.length - 1]);
    expect(feet[1]).toBeCloseTo(finalCar.feetY, 5);

    // Having arrived, the rider can walk out onto the (only-elevator-reachable)
    // roof floor cleanly — proven the same way as the ground stop: flood-fill
    // from the platform through the doorway must reach a real interior floor,
    // not a sealed pocket.
    const roofReach = floodFillStandableCount(world, { x: shaft.wellX, z: shaft.wellZ }, finalCar.feetY);
    expect(roofReach).toBeGreaterThan(SEALED_POCKET_CEILING);
    expect(roofReach).toBeGreaterThanOrEqual(REAL_INTERIOR_FLOOR);
  });

  it('flags a doorway carved on the perimeter-facing (north) edge as unenterable — the exact defect this shaft used to ship with', () => {
    // Hand-builds the *old*, buggy geometry directly (bypassing
    // `pickDoorEdge`, which now always prefers an interior-facing edge) to
    // prove the flood-fill technique above actually catches it: if
    // `writeElevatorShaft` ever regresses to carving the door on the wall
    // one cell from the tower's own north perimeter, this is what the
    // real generator's output would flood-fill to, and it must read as
    // sealed, not open.
    const height = 40;
    // doorSide 'north' (carved at z = depth - 1 = 9) deliberately keeps the
    // tower's *own* doorway far from the shaft's north wall at z = 0-1, so
    // the "outward neighbor is solid" check below isn't accidentally
    // satisfied by an unrelated coincidence.
    const t = tower({ x: 0, z: 0, width: 10, depth: 10, height, doorSide: 'north' });
    const world = new World();
    for (let x = -2; x < 12; x++) {
      for (let z = -2; z < 12; z++) {
        world.setBlockRaw(x, t.baseY - 1, z, CONCRETE);
      }
    }
    writeBuilding(world, t);

    const shaftX = 1;
    const shaftZ = 1; // tier0.x + 1, tier0.z + 1 — the real shaft origin convention
    for (let dx = 0; dx < 3; dx++) {
      for (let dz = 0; dz < 3; dz++) {
        const isShell = dx === 0 || dx === 2 || dz === 0 || dz === 2;
        if (!isShell) continue;
        world.setBlockRaw(shaftX + dx, t.baseY, shaftZ + dz, ELEVATOR_SHAFT);
      }
    }
    // North door: offset (1, 0) — one cell from the tower's own north wall (z = 0).
    const doorX = shaftX + 1;
    const doorZ = shaftZ;
    for (const y of [t.baseY, t.baseY + 1]) {
      world.setBlockRaw(doorX, y, doorZ, AIR);
    }
    // Confirms this is genuinely the regression scenario: the door's outward neighbor is solid (the tower's own perimeter), not open interior.
    expect(world.isSolid(doorX, t.baseY, doorZ - 1)).toBe(true);

    const wellX = shaftX + 1;
    const wellZ = shaftZ + 1;
    const reach = floodFillStandableCount(world, { x: wellX, z: wellZ }, t.baseY);

    expect(reach).toBeLessThanOrEqual(SEALED_POCKET_CEILING);
  });

  it('an inset-2 setback still yields a scanned, rideable shaft (regression guard: the well used to coincide with the upper tier\'s own wall corner)', () => {
    // 24x24 ground tier, upper tier inset by exactly 2 on every side. The
    // shaft's fixed origin is (tier0.x + 1, tier0.z + 1), so its well sits at
    // (tier0.x + 2, tier0.z + 2) — exactly the upper tier's own (x, z)
    // corner when the inset is 2. Before the fix, `writeBuilding`'s own
    // shell wall for that tier ran straight through the well for the whole
    // height of the shaft's housing rows, `ElevatorScanner` saw a
    // non-hollow well there, and silently dropped the entire shaft — no
    // platform, no error, just gone.
    const t = tower({
      x: 0,
      z: 0,
      width: 24,
      depth: 24,
      height: 60,
      tiers: [
        { yStart: 0, yEnd: 30, x: 0, z: 0, width: 24, depth: 24 },
        { yStart: 30, yEnd: 60, x: 2, z: 2, width: 20, depth: 20 },
      ],
    });
    const world = new World();
    for (let x = -2; x < 26; x++) {
      for (let z = -2; z < 26; z++) {
        world.setBlockRaw(x, t.baseY - 1, z, CONCRETE);
      }
    }
    writeBuilding(world, t);

    let written = false;
    for (let i = 0; i < 30 && !written; i++) {
      const markers = planElevatorShafts([t], createRng(`inset2-regression-${i}`), new Set());
      if (markers.length === 0) continue;
      writeElevatorShaft(world, markers[0]!);
      written = true;
    }
    expect(written).toBe(true);

    const shafts = scanElevatorShafts(world);
    expect(shafts).toHaveLength(1);
    expect(shafts[0]!.stops.length).toBeGreaterThanOrEqual(2);
  });

  it('every stop of a setback tower floods from the platform to real standable floor — no sealed stops on any served level', () => {
    // Two representative geometries that both used to produce a sealed
    // (unenterable/unexitable) stop somewhere: an inset-2 tower (the well
    // itself nearly collides with the upper tier's wall) and a narrow
    // upper tier (an inset that leaves only a sliver of real floor along
    // one axis, so whichever edge worked for the ground stop may no longer
    // be open — or footed — higher up).
    const insetTwoTower = tower({
      x: 0,
      z: 0,
      width: 24,
      depth: 24,
      height: 60,
      tiers: [
        { yStart: 0, yEnd: 30, x: 0, z: 0, width: 24, depth: 24 },
        { yStart: 30, yEnd: 60, x: 2, z: 2, width: 20, depth: 20 },
      ],
    });
    const narrowUpperTierTower = tower({
      x: 100,
      z: 100,
      width: 8,
      depth: 8,
      height: 50,
      tiers: [
        { yStart: 0, yEnd: 25, x: 100, z: 100, width: 8, depth: 8 },
        { yStart: 25, yEnd: 50, x: 101, z: 101, width: 6, depth: 4 },
      ],
    });

    for (const t of [insetTwoTower, narrowUpperTierTower]) {
      const world = new World();
      for (let x = t.x - 2; x < t.x + t.width + 2; x++) {
        for (let z = t.z - 2; z < t.z + t.depth + 2; z++) {
          world.setBlockRaw(x, t.baseY - 1, z, CONCRETE);
        }
      }
      writeBuilding(world, t);

      let marker: { building: BuildingPlan; x: number; z: number } | null = null;
      for (let i = 0; i < 30 && !marker; i++) {
        const markers = planElevatorShafts([t], createRng(`setback-stops-${t.x}-${i}`), new Set());
        if (markers.length === 0) continue;
        marker = markers[0]!;
        writeElevatorShaft(world, marker);
      }
      expect(marker).not.toBeNull();

      const shafts = scanElevatorShafts(world);
      expect(shafts).toHaveLength(1);
      const shaft = shafts[0]!;
      expect(shaft.stops.length).toBeGreaterThanOrEqual(2);

      for (const stop of shaft.stops) {
        const reach = floodFillStandableCount(world, { x: shaft.wellX, z: shaft.wellZ }, stop);
        expect(reach, `tower at (${t.x},${t.z}), stop ${stop}`).toBeGreaterThan(SEALED_POCKET_CEILING);
      }
    }
  });

  it('a rider not standing on the platform is unaffected by its motion (falls normally instead of teleporting with it)', () => {
    const { world, shaft } = buildIsolatedTowerWithElevator();
    const sim = new ElevatorSimulation();
    sim.sync([shaft]);
    sim.call(shaft, 1);

    // Bystander floats mid-air well inside the tower's hollow interior, off to the side of the shaft's own footprint.
    const startY = (shaft.stops[0] as number) + 20;
    let feet: readonly [number, number, number] = [shaft.wellX + 3.5, startY, shaft.wellZ + 0.5];
    let velocityY = 0;

    for (let i = 0; i < 30; i++) {
      sim.update(TICK);
      const step = tickRider(world, feet, velocityY, null);
      feet = step.feet;
      velocityY = step.velocityY;
    }

    // Gravity pulled the bystander down; they did not track the car's ascent (which moved *up*).
    expect(feet[1]).toBeLessThan(startY);
  });
});
