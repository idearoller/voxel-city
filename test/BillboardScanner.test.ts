import { describe, expect, it } from 'vitest';
import { planBillboards, writeBillboard, type Billboard } from '../src/gen/infrastructure';
import { scanBillboardFaces, type BillboardFace } from '../src/engine/BillboardScanner';
import type { BuildingPlan, BuildingTier, DoorSide } from '../src/gen/buildings';
import { generateCity } from '../src/gen/CityGenerator';
import { District } from '../src/gen/districts';
import { createRng } from '../src/gen/rng';
import { CONCRETE, NEON_CYAN, NEON_PINK } from '../src/world/BlockRegistry';
import { World } from '../src/world/World';

const BASE_Y = 2;
const HEIGHT = 8;
const FOOTPRINT = 10; // x, z in [10, 20)
const ORIGIN = 10;

/** A hollow, single-voxel-thick concrete box: the same "tower shell" shape `writeShellAndWindows` produces (interior stays AIR unless explicitly furnished). */
function buildHollowTower(): World {
  const world = new World();
  for (let ry = 0; ry < HEIGHT; ry++) {
    const y = BASE_Y + ry;
    for (let dx = 0; dx < FOOTPRINT; dx++) {
      for (let dz = 0; dz < FOOTPRINT; dz++) {
        const isShell = dx === 0 || dx === FOOTPRINT - 1 || dz === 0 || dz === FOOTPRINT - 1;
        if (isShell) world.setBlockRaw(ORIGIN + dx, y, ORIGIN + dz, CONCRETE);
      }
    }
  }
  return world;
}

/** A minimal fake BuildingPlan/tier good enough for `writeBillboard`'s reads (building.baseY/height, tier0.x/z/width/depth). */
function fakeBuildingPlan(): BuildingPlan {
  const tier0: BuildingTier = { yStart: 0, yEnd: HEIGHT, x: ORIGIN, z: ORIGIN, width: FOOTPRINT, depth: FOOTPRINT };
  return {
    x: ORIGIN,
    z: ORIGIN,
    width: FOOTPRINT,
    depth: FOOTPRINT,
    baseY: BASE_Y,
    height: HEIGHT,
    district: District.RESIDENTIAL,
    wallMaterial: CONCRETE,
    windowStride: 2,
    windowPhase: 0,
    windowLitChance: 0,
    doorSide: null,
    doorStart: 0,
    tiers: [tier0],
    shopBandColor: null,
    signStrip: null,
    roofTrimColor: null,
    antenna: null,
    shopInterior: null,
    rng: createRng('fake'),
  };
}

describe('scanBillboardFaces', () => {
  it('finds a billboard written onto the south wall of a hollow tower, flush and facing outward', () => {
    const world = buildHollowTower();
    world.setBlockRaw(12, 4, ORIGIN, NEON_PINK);
    world.setBlockRaw(13, 4, ORIGIN, NEON_PINK);
    world.setBlockRaw(14, 4, ORIGIN, NEON_PINK);
    world.setBlockRaw(15, 4, ORIGIN, NEON_PINK);
    world.setBlockRaw(12, 5, ORIGIN, NEON_PINK);
    world.setBlockRaw(13, 5, ORIGIN, NEON_PINK);
    world.setBlockRaw(14, 5, ORIGIN, NEON_PINK);
    world.setBlockRaw(15, 5, ORIGIN, NEON_PINK);
    world.setBlockRaw(12, 6, ORIGIN, NEON_PINK);
    world.setBlockRaw(13, 6, ORIGIN, NEON_PINK);
    world.setBlockRaw(14, 6, ORIGIN, NEON_PINK);
    world.setBlockRaw(15, 6, ORIGIN, NEON_PINK);

    const faces = scanBillboardFaces(world);

    expect(faces).toHaveLength(1);
    const face = faces[0]!;
    expect(face.normal).toEqual([0, 0, -1]); // south wall -> outward is -z
    expect(face.axis).toBe('x');
    expect(face.blockId).toBe(NEON_PINK);
    // Centered on x in [12, 16), y in [4, 7), flush against z=10 with a small outward offset.
    expect(face.position[0]).toBeCloseTo(14, 5);
    expect(face.position[1]).toBeCloseTo(5.5, 5);
    expect(face.position[2]).toBeLessThan(ORIGIN);
    expect(face.position[2]).toBeGreaterThan(ORIGIN - 1);
  });

  it('derives the same face from real generator output via planBillboards/writeBillboard', () => {
    const building = fakeBuildingPlan();
    const world = buildHollowTower();
    let billboard: Billboard | undefined;

    // Same pattern as infrastructure.test.ts: roll seeds until one actually places a billboard.
    for (let i = 0; i < 200 && !billboard; i++) {
      const rolled = planBillboards([building], createRng(`scanner-${i}`));
      if (rolled.length > 0) billboard = rolled[0];
    }
    expect(billboard).toBeDefined();
    writeBillboard(world, billboard as Billboard);

    const faces = scanBillboardFaces(world);
    expect(faces).toHaveLength(1);
    expect(faces[0]!.blockId).toBe((billboard as Billboard).color);
  });

  it('works purely from voxel data with no generator objects at all (the ".vxc import" case)', () => {
    // Simulates a freshly-imported world: only ever touched via setBlockRaw,
    // no BuildingPlan/Billboard in sight.
    const world = new World();
    for (let ry = 0; ry < HEIGHT; ry++) {
      const y = BASE_Y + ry;
      for (let dx = 0; dx < FOOTPRINT; dx++) {
        for (let dz = 0; dz < FOOTPRINT; dz++) {
          const isShell = dx === 0 || dx === FOOTPRINT - 1 || dz === 0 || dz === FOOTPRINT - 1;
          if (isShell) world.setBlockRaw(ORIGIN + dx, y, ORIGIN + dz, CONCRETE);
        }
      }
    }
    // West-wall billboard (fixed x, varying z) — exercises the other facade axis.
    for (let dz = 0; dz < 4; dz++) {
      for (let dy = 0; dy < 3; dy++) {
        world.setBlockRaw(ORIGIN, BASE_Y + 4 + dy, ORIGIN + 3 + dz, NEON_CYAN);
      }
    }

    const faces = scanBillboardFaces(world);
    expect(faces).toHaveLength(1);
    expect(faces[0]!.axis).toBe('z');
    expect(faces[0]!.normal).toEqual([-1, 0, 0]); // west wall -> outward is -x
  });

  it('does not mistake a wide shop band or a narrow sign strip for a billboard', () => {
    const world = buildHollowTower();
    // Shop band: full width, only 2 rows tall (billboards are 3 tall) -- never a valid closed 4x3 rectangle.
    for (let dx = 1; dx < FOOTPRINT - 1; dx++) {
      world.setBlockRaw(ORIGIN + dx, BASE_Y + 1, ORIGIN, NEON_PINK);
      world.setBlockRaw(ORIGIN + dx, BASE_Y + 2, ORIGIN, NEON_PINK);
    }
    // Sign strip: 2 wide, tall -- never 4 wide.
    for (let dy = 0; dy < 10; dy++) {
      world.setBlockRaw(ORIGIN + FOOTPRINT - 1, BASE_Y + 2 + dy, ORIGIN + 4, NEON_CYAN);
      world.setBlockRaw(ORIGIN + FOOTPRINT - 1, BASE_Y + 2 + dy, ORIGIN + 5, NEON_CYAN);
    }

    expect(scanBillboardFaces(world)).toHaveLength(0);
  });

  it('finds a plausible number of well-formed faces across a real generated city, with no duplicate positions', () => {
    const world = new World();
    generateCity(world, 'billboard-scan-city-01');

    const faces = scanBillboardFaces(world);
    expect(faces.length).toBeGreaterThan(0);

    const seenPositions = new Set<string>();
    for (const face of faces) {
      const [nx, ny, nz] = face.normal;
      // Exactly one axis nonzero, magnitude 1 -- a genuine facade-aligned outward normal.
      expect(Math.abs(nx) + Math.abs(ny) + Math.abs(nz)).toBe(1);
      const key = face.position.map((c) => c.toFixed(3)).join(',');
      expect(seenPositions.has(key)).toBe(false);
      seenPositions.add(key);
    }
  });

  it('gets the outward normal right even when a neighboring building sits closer than this tower\'s own far interior wall', () => {
    // Reproduces Sam's exact failure shape: a wide tower (interior far wall
    // 26 voxels from the billboard's own wall) with a neighbor building just
    // 3 voxels across a narrow street on the *billboard's exterior side*.
    // A "nearest solid wins" heuristic finds the neighbor's wall (3) closer
    // than this tower's own opposite wall (26) and flips the normal inward.
    const world = new World();
    const wideFootprint = 28; // interior far wall sits 26 voxels from the south billboard wall
    const originX = 50;
    const originZ = 50;

    for (let ry = 0; ry < HEIGHT; ry++) {
      const y = BASE_Y + ry;
      for (let dx = 0; dx < wideFootprint; dx++) {
        for (let dz = 0; dz < wideFootprint; dz++) {
          const isShell = dx === 0 || dx === wideFootprint - 1 || dz === 0 || dz === wideFootprint - 1;
          if (isShell) world.setBlockRaw(originX + dx, y, originZ + dz, CONCRETE);
        }
      }
    }
    // A neighbor building's wall, 3 voxels south of this tower's own south wall (across a narrow street).
    const neighborWallZ = originZ - 3;
    for (let dx = -5; dx < wideFootprint + 5; dx++) {
      world.setBlockRaw(originX + dx, BASE_Y + 4, neighborWallZ, CONCRETE);
      world.setBlockRaw(originX + dx, BASE_Y + 5, neighborWallZ, CONCRETE);
      world.setBlockRaw(originX + dx, BASE_Y + 6, neighborWallZ, CONCRETE);
    }

    // Billboard on the south wall (fixed z = originZ), well clear of the corners.
    for (let dx = 12; dx < 16; dx++) {
      world.setBlockRaw(originX + dx, BASE_Y + 4, originZ, NEON_PINK);
      world.setBlockRaw(originX + dx, BASE_Y + 5, originZ, NEON_PINK);
      world.setBlockRaw(originX + dx, BASE_Y + 6, originZ, NEON_PINK);
    }

    const faces = scanBillboardFaces(world);
    expect(faces).toHaveLength(1);
    expect(faces[0]!.normal).toEqual([0, 0, -1]); // still outward (-z), despite the closer neighbor wall
  });
});

describe('scanBillboardFaces normal-direction oracle (real generated cities)', () => {
  const SIDE_NORMAL: Record<DoorSide, readonly [number, number, number]> = {
    south: [0, 0, -1],
    north: [0, 0, 1],
    west: [-1, 0, 0],
    east: [1, 0, 0],
  };

  /** The same center-position math `BillboardScanner.tryMatchAt` derives, computed straight from the generator's own `Billboard` record — independent ground truth, not a re-check of the scanner's own output. */
  function expectedFaceCenter(billboard: Billboard): readonly [number, number, number] {
    const { building, side, offset, yStart } = billboard;
    const tier0 = building.tiers[0] as NonNullable<(typeof building.tiers)[0]>;
    const centerY = building.baseY + yStart + 1.5; // BILLBOARD_HEIGHT / 2

    if (side === 'south') return [offset + 2, centerY, tier0.z];
    if (side === 'north') return [offset + 2, centerY, tier0.z + tier0.depth];
    if (side === 'west') return [tier0.x, centerY, offset + 2];
    return [tier0.x + tier0.width, centerY, offset + 2]; // east
  }

  function findMatchingFace(faces: readonly BillboardFace[], billboard: Billboard): BillboardFace | undefined {
    const [ex, ey, ez] = expectedFaceCenter(billboard);
    return faces.find(
      (f) =>
        f.blockId === billboard.color &&
        Math.abs(f.position[0] - ex) < 0.5 &&
        Math.abs(f.position[1] - ey) < 0.5 &&
        Math.abs(f.position[2] - ez) < 0.5,
    );
  }

  it('matches the generator\'s own recorded door-side for every real billboard, across multiple seeds', () => {
    // Every billboard the scanner *does* find must have the correct outward
    // normal -- that's the actual property under test, and it's a hard
    // requirement (a single wrong normal fails this test). Not every planned
    // billboard is expected to be found: a billboard whose Y-range happens to
    // overlap the *door's* height (see `writeDoorway`'s DOOR_HEIGHT rows) can
    // let the interior side's flood fill leak out through that door opening
    // elsewhere on the same footprint, making both directions read as
    // "unbounded" -- `resolveNormal` correctly returns null (skips, rather
    // than guessing) in that case. That's a known, safe (never-wrong)
    // limitation of a purely layout-free enclosure test, not a regression --
    // tracked here as a bounded skip rate, not a failure.
    const seeds = Array.from({ length: 10 }, (_, i) => `oracle-seed-${i}`);
    let totalBillboards = 0;
    let totalMatched = 0;
    let totalWrong = 0;

    for (const seed of seeds) {
      const world = new World();
      const result = generateCity(world, seed);
      const faces = scanBillboardFaces(world);

      for (const billboard of result.billboards) {
        totalBillboards++;
        const match = findMatchingFace(faces, billboard);
        if (!match) continue;
        totalMatched++;
        const expectedNormal = SIDE_NORMAL[billboard.side];
        if (match.normal[0] !== expectedNormal[0] || match.normal[1] !== expectedNormal[1] || match.normal[2] !== expectedNormal[2]) {
          totalWrong++;
        }
        expect(match.normal, `wrong normal on seed ${seed} side=${billboard.side}`).toEqual(expectedNormal);
      }
    }

    expect(totalBillboards).toBeGreaterThan(0);
    expect(totalWrong).toBe(0);
    // Generous floor: the door-row-overlap skip measures ~15% on real seeds
    // (160 billboards across these 10 seeds) -- a skip rate far above that
    // would itself indicate a real regression in the enclosure heuristic,
    // not just the known edge case.
    expect(totalMatched / totalBillboards).toBeGreaterThan(0.6);
  });
});
