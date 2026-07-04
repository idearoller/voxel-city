import { describe, expect, it } from 'vitest';
import { generateCity } from '../src/gen/CityGenerator';
import { buildNavGrid } from '../src/entities/NavGrid';
import { ALTITUDE_BANDS, LANE_HALF_WIDTH, deriveSkyLanes, type SkyLane } from '../src/entities/SkyLane';
import { WORLD_SIZE_X, WORLD_SIZE_Z } from '../src/world/coords';
import { World } from '../src/world/World';
import { ASPHALT, CONCRETE } from '../src/world/BlockRegistry';

const GROUND_Y = 1;

/** Real generated cities across several seeds, to prove lane derivation against actual generator output rather than a synthetic fixture. */
const REAL_SEEDS = ['sky-seed-1', 'sky-seed-2', 'sky-seed-3', 'sky-seed-4', 'sky-seed-5'];

function buildRealNavGridAndWorld(seed: string): { world: World; road: Uint8Array } {
  const world = new World();
  generateCity(world, seed);
  const grid = buildNavGrid(world, WORLD_SIZE_X, WORLD_SIZE_Z, GROUND_Y);
  return { world, road: grid.road };
}

/** Every voxel a `lane` sweeps through: its full travel range, `2*LANE_HALF_WIDTH+1` cross-section, at its own chosen altitude (2 voxels tall, matching `deriveSkyLanes`' own clearance scan). */
function forEachLaneVoxel(lane: SkyLane, visit: (x: number, y: number, z: number) => void): void {
  for (let travel = lane.start; travel < lane.end; travel++) {
    for (let cross = lane.fixed - LANE_HALF_WIDTH; cross <= lane.fixed + LANE_HALF_WIDTH; cross++) {
      for (let y = lane.altitude; y < lane.altitude + 2; y++) {
        const x = lane.axis === 'x' ? travel : cross;
        const z = lane.axis === 'z' ? travel : cross;
        visit(x, y, z);
      }
    }
  }
}

describe('deriveSkyLanes on real generated cities', () => {
  it('derives at least one lane per seed, and every derived lane is genuinely clear of solid voxels along its entire swept corridor', () => {
    let totalLanes = 0;
    for (const seed of REAL_SEEDS) {
      const { world, road } = buildRealNavGridAndWorld(seed);
      const lanes = deriveSkyLanes(world, road, WORLD_SIZE_X, WORLD_SIZE_Z);
      expect(lanes.length).toBeGreaterThan(0);
      totalLanes += lanes.length;

      for (const lane of lanes) {
        let solidCount = 0;
        forEachLaneVoxel(lane, (x, y, z) => {
          if (world.isSolid(x, y, z)) solidCount++;
        });
        expect(solidCount).toBe(0);
      }
    }
    // Sanity: this isn't a degenerate "always exactly one" result -- real
    // cities produce a handful of major avenues in both directions.
    expect(totalLanes).toBeGreaterThanOrEqual(REAL_SEEDS.length * 2);
  });

  it('only ever picks altitudes from ALTITUDE_BANDS, and every lane spans the world axis it travels along', () => {
    for (const seed of REAL_SEEDS) {
      const { world, road } = buildRealNavGridAndWorld(seed);
      const lanes = deriveSkyLanes(world, road, WORLD_SIZE_X, WORLD_SIZE_Z);
      for (const lane of lanes) {
        expect(ALTITUDE_BANDS).toContain(lane.altitude);
        if (lane.axis === 'x') {
          expect(lane.start).toBe(0);
          expect(lane.end).toBe(WORLD_SIZE_X);
        } else {
          expect(lane.start).toBe(0);
          expect(lane.end).toBe(WORLD_SIZE_Z);
        }
      }
    }
  });

  it('never derives a lane centered on a minor (width-5) road band, only major (width-7) avenues', () => {
    // A major avenue is 7 wide (`MAJOR_ROAD_WIDTH` in gen/layout.ts); a minor
    // road is only 5. Checking that road pavement extends a full 3 cells to
    // either side of the derived centerline (7 total) directly rules out a
    // lane having landed on a minor road, where cell 3 out would already be
    // off the pavement.
    const HALF_MAJOR_WIDTH = 3;
    for (const seed of REAL_SEEDS) {
      const { world, road } = buildRealNavGridAndWorld(seed);
      const lanes = deriveSkyLanes(world, road, WORLD_SIZE_X, WORLD_SIZE_Z);
      for (const lane of lanes) {
        const probeTravel = lane.axis === 'x' ? Math.floor(WORLD_SIZE_X / 2) : Math.floor(WORLD_SIZE_Z / 2);
        for (let offset = -HALF_MAJOR_WIDTH; offset <= HALF_MAJOR_WIDTH; offset++) {
          const cross = lane.fixed + offset;
          const x = lane.axis === 'x' ? probeTravel : cross;
          const z = lane.axis === 'z' ? probeTravel : cross;
          expect(road[x + z * WORLD_SIZE_X]).toBe(1);
        }
      }
    }
  });
});

describe('deriveSkyLanes revert-probe: the clearance check actually rejects a blocked lane', () => {
  it('drops a candidate avenue whenever every altitude band is blocked by a real obstruction', () => {
    const width = 100;
    const depth = 100;
    const world = new World();
    // Paint one full-width major avenue (7-wide, x=40..47) spanning the whole z extent.
    for (let x = 40; x < 47; x++) {
      for (let z = 0; z < depth; z++) {
        world.setBlock(x, 0, z, CONCRETE);
        world.setBlock(x, GROUND_Y, z, ASPHALT);
      }
    }
    const grid = buildNavGrid(world, width, depth, GROUND_Y);
    const lanesBeforeObstruction = deriveSkyLanes(world, grid.road, width, depth);
    expect(lanesBeforeObstruction.length).toBe(1); // sanity: the avenue is clear, so it's derived

    // Now block every single altitude band directly over the avenue's centerline.
    const laneFixed = lanesBeforeObstruction[0]!.fixed;
    for (const altitude of ALTITUDE_BANDS) {
      world.setBlock(laneFixed, altitude, Math.floor(depth / 2), CONCRETE);
    }

    const lanesAfterObstruction = deriveSkyLanes(world, grid.road, width, depth);
    expect(lanesAfterObstruction.length).toBe(0); // this is the revert-probe: undoing this fix would make the lane reappear
  });

  it('rejects the lowest altitude band specifically and falls through to the next clear one', () => {
    const width = 100;
    const depth = 100;
    const world = new World();
    for (let x = 40; x < 47; x++) {
      for (let z = 0; z < depth; z++) {
        world.setBlock(x, 0, z, CONCRETE);
        world.setBlock(x, GROUND_Y, z, ASPHALT);
      }
    }
    const grid = buildNavGrid(world, width, depth, GROUND_Y);
    const before = deriveSkyLanes(world, grid.road, width, depth);
    const laneFixed = before[0]!.fixed;

    // Block only the lowest altitude band.
    world.setBlock(laneFixed, ALTITUDE_BANDS[0]!, Math.floor(depth / 2), CONCRETE);

    const after = deriveSkyLanes(world, grid.road, width, depth);
    expect(after.length).toBe(1);
    expect(after[0]!.altitude).toBe(ALTITUDE_BANDS[1]);
  });
});
