import { describe, expect, it } from 'vitest';
import type { BuildingPlan } from '../src/gen/buildings';
import { writeBuilding } from '../src/gen/buildings';
import { District } from '../src/gen/districts';
import { planElevatorShafts, planSkyLobbies, writeElevatorShaft, writeSkyLobby, type Bridge } from '../src/gen/infrastructure';
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

/** Minimal `Bridge` referencing `tower` at `level` for both ends -- `elevatorDeckYs`/`planSkyLobbies` only ever care about tower-membership and `level`, never the deck's own x/z/width/axis, so these are harmless placeholders. */
function bridgeAtLevel(tower: BuildingPlan, level: number): Bridge {
  return { axis: 'x', level, x: 0, z: 0, width: 3, depth: 3, towerA: tower, towerB: tower };
}

/** Writes the real `SkyLobby` floor for every `bridges` entry -- the footing `pickDoorEdge` requires behind a non-ground doorway, exactly as `placeVerticalInfrastructure` does before `writeElevatorShaft` in the real pipeline. */
function writeLobbiesFor(world: World, bridges: readonly Bridge[]): void {
  for (const lobby of planSkyLobbies(bridges)) writeSkyLobby(world, lobby);
}

/**
 * Builds a single hand-built shaft the same way the generator does and
 * returns its World + marker geometry. `bridgeLevels` are this tower's own
 * sky-lobby levels (see `elevatorDeckYs`'s doc comment for why a shaft's
 * non-ground stops are anchored to real bridge levels, not tier boundaries)
 * -- pass none for a ground-only (non-functional, single-stop) shaft.
 */
function buildGeneratedShaftWorld(
  height = 40,
  bridgeLevels: readonly number[] = [],
): { world: World; wellX: number; wellZ: number; baseY: number; height: number } {
  const t = tower({ x: 0, z: 0, width: 10, depth: 10, height });
  const world = new World();
  paintGroundPlane(world, t.baseY, -2, 12);
  writeBuilding(world, t); // real shell + roof deck: pickDoorEdge needs genuine footing, not just an empty bare world

  const bridges = bridgeLevels.map((level) => bridgeAtLevel(t, level));
  writeLobbiesFor(world, bridges);

  for (let i = 0; i < 30; i++) {
    const markers = planElevatorShafts([t], createRng(`scanner-fixture-${i}`), new Set());
    if (markers.length === 0) continue;
    const marker = markers[0]!;
    writeElevatorShaft(world, marker, bridges);
    return { world, wellX: marker.x + 1, wellZ: marker.z + 1, baseY: t.baseY, height };
  }
  throw new Error('failed to roll an elevator marker across 30 seeds — check ELEVATOR_CHANCE/ELEVATOR_MIN_HEIGHT');
}

describe('scanElevatorShafts', () => {
  it('derives the well position and ground+bridge-level stops from a generator-built shaft', () => {
    // Tall enough (90) that a bridge level of 30 sits comfortably below the
    // roof with plenty of margin -- this test cares about stop *derivation*,
    // not eligibility margins (see infrastructure.test.ts's `planBridges`
    // suite for those).
    const { world, wellX, wellZ, baseY } = buildGeneratedShaftWorld(90, [30]);

    const shafts = scanElevatorShafts(world);
    expect(shafts).toHaveLength(1);
    const shaft = shafts[0]!;

    expect(shaft.wellX).toBe(wellX);
    expect(shaft.wellZ).toBe(wellZ);
    // Ground stop's feet-Y is baseY (city ground surface is one below baseY);
    // the tower's one bridge-level stop's feet-Y is level+1 -- a shaft now
    // only ever gets a stop where NavGrid can actually recognize the landing
    // (this tower's own real sky lobby), never an arbitrary tier boundary —
    // see `elevatorDeckYs`'s doc comment.
    expect(shaft.stops).toEqual([baseY, 31]);
  });

  it('derives one stop per distinct bridge level this tower has, ascending and deduped, alongside the ground stop', () => {
    // Two real sky-lobby levels on the same tower (as if it anchors bridges
    // at two different heights) -- deliberately passed out of order to prove
    // the output is sorted, not just echoed back in input order.
    const { world, baseY } = buildGeneratedShaftWorld(90, [50, 30]);

    const shafts = scanElevatorShafts(world);
    expect(shafts).toHaveLength(1);
    expect(shafts[0]!.stops).toEqual([baseY, 31, 51]);
  });

  it('is stable and NaN/crash-free on an empty world (no shafts at all)', () => {
    const world = new World();
    expect(scanElevatorShafts(world)).toEqual([]);
  });

  it('gracefully deactivates a shaft with a wall column punched out by a sandbox edit', () => {
    const { world, wellX, wellZ } = buildGeneratedShaftWorld(40, [20]);
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
