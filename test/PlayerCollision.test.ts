import { describe, expect, it } from 'vitest';
import {
  aabbFromFeet,
  aabbIntersectsSolid,
  moveAndCollide,
  tryAutoStep,
  voxelIntersectsAabb,
  PLAYER_HEIGHT,
} from '../src/player/PlayerCollision';

/** Builds an isSolid predicate from a plain set of "x,y,z" coordinate strings. */
function solidSetOf(coords: ReadonlyArray<readonly [number, number, number]>) {
  const set = new Set(coords.map(([x, y, z]) => `${x},${y},${z}`));
  return (x: number, y: number, z: number): boolean => set.has(`${x},${y},${z}`);
}

/** A flat floor at voxel row y=0 covering a generous xz area. */
function floorAt(y: number): ReadonlyArray<readonly [number, number, number]> {
  const coords: Array<readonly [number, number, number]> = [];
  for (let x = -5; x <= 20; x++) {
    for (let z = -5; z <= 20; z++) {
      coords.push([x, y, z]);
    }
  }
  return coords;
}

describe('aabbFromFeet', () => {
  it('builds a box 0.6 wide, PLAYER_HEIGHT tall, centered on feet xz', () => {
    const box = aabbFromFeet([10, 5, 10]);
    expect(box.minX).toBeCloseTo(9.7);
    expect(box.maxX).toBeCloseTo(10.3);
    expect(box.minZ).toBeCloseTo(9.7);
    expect(box.maxZ).toBeCloseTo(10.3);
    expect(box.minY).toBeCloseTo(5);
    expect(box.maxY).toBeCloseTo(5 + PLAYER_HEIGHT);
  });
});

describe('aabbIntersectsSolid', () => {
  it('detects overlap with a solid voxel', () => {
    const isSolid = solidSetOf([[10, 5, 10]]);
    const box = aabbFromFeet([10, 5, 10]);
    expect(aabbIntersectsSolid(isSolid, box)).toBe(true);
  });

  it('returns false in open air', () => {
    const isSolid = () => false;
    const box = aabbFromFeet([10, 5, 10]);
    expect(aabbIntersectsSolid(isSolid, box)).toBe(false);
  });
});

describe('voxelIntersectsAabb (place-rejection)', () => {
  it('rejects a voxel that overlaps the player AABB', () => {
    const box = aabbFromFeet([10, 5, 10]);
    expect(voxelIntersectsAabb([10, 5, 10], box)).toBe(true);
    expect(voxelIntersectsAabb([10, 6, 10], box)).toBe(true); // within height
  });

  it('allows a voxel outside the player AABB', () => {
    const box = aabbFromFeet([10, 5, 10]);
    expect(voxelIntersectsAabb([15, 5, 10], box)).toBe(false);
    expect(voxelIntersectsAabb([10, 5, 15], box)).toBe(false);
    expect(voxelIntersectsAabb([10, 10, 10], box)).toBe(false); // above head
  });
});

describe('moveAndCollide', () => {
  it('stops at a wall on the X axis and zeroes X velocity', () => {
    const isSolid = solidSetOf([...floorAt(0), [12, 1, 5]]);
    const result = moveAndCollide(isSolid, [10, 1, 5], [10, 0, 0], 1);
    // Wall face at x=12 (voxel spans [12,13)); box half-width 0.3, so max
    // reachable center x = 12 - 0.3 = 11.7.
    expect(result.position[0]).toBeCloseTo(11.7);
    expect(result.velocity[0]).toBe(0);
  });

  it('lands on a floor and reports grounded, zeroing downward velocity', () => {
    const isSolid = solidSetOf(floorAt(0));
    // Large dt so the requested downward delta overshoots the floor (voxel
    // row 0 spans [0,1), so the floor surface is at y=1); the resolver
    // should clamp the landing to y=1 rather than tunnel through.
    const result = moveAndCollide(isSolid, [10, 1.5, 5], [0, -27, 0], 1);
    expect(result.grounded).toBe(true);
    expect(result.velocity[1]).toBe(0);
    expect(result.position[1]).toBeCloseTo(1);
  });

  it('bumps a ceiling and zeroes upward velocity without setting grounded', () => {
    const isSolid = solidSetOf([...floorAt(0), [10, 5, 5]]);
    const result = moveAndCollide(isSolid, [10, 1, 5], [0, 20, 0], 1);
    // Ceiling voxel at y=5 (spans [5,6)); box height 1.8, so max feet y = 5 - 1.8 = 3.2.
    expect(result.position[1]).toBeCloseTo(3.2);
    expect(result.velocity[1]).toBe(0);
    expect(result.grounded).toBe(false);
  });

  it('resolves a corner (X and Z both blocked) leaving the player pinned against both walls', () => {
    // Wall at x=12 blocks the X move (matches the player's starting z=10);
    // wall at z=12 blocks the Z move (matches the player's post-X-resolve x=11).
    const isSolid = solidSetOf([...floorAt(0), [12, 1, 10], [11, 1, 12]]);
    const result = moveAndCollide(isSolid, [10, 1, 10], [10, 0, 10], 1);
    expect(result.position[0]).toBeCloseTo(11.7);
    expect(result.position[2]).toBeCloseTo(11.7);
    expect(result.velocity[0]).toBe(0);
    expect(result.velocity[2]).toBe(0);
  });

  it('falls freely with no floor beneath', () => {
    const isSolid = () => false;
    const result = moveAndCollide(isSolid, [10, 50, 10], [0, -27, 0], 1 / 60);
    expect(result.grounded).toBe(false);
    expect(result.position[1]).toBeCloseTo(50 - 27 / 60);
  });
});

// Realistic per-tick horizontal deltas: WALK_SPEED (4.5) and SPRINT_SPEED (7)
// from PlayController, integrated over one 60Hz fixed tick. The original
// bug (caught in review) used moveX=1 full voxel per call, which never
// happens at runtime and masked a floor-probe that could never be satisfied
// by a sub-voxel advance.
const WALK_TICK_DELTA = 4.5 / 60;
const SPRINT_TICK_DELTA = 7 / 60;

/** A 1-voxel-tall step: floor at y=0 for x<=11, floor+step (rows 0,1) at x=12. */
function oneVoxelStepWorld(): (x: number, y: number, z: number) => boolean {
  const coords: Array<readonly [number, number, number]> = [];
  for (let x = -5; x <= 11; x++) for (let z = -5; z <= 20; z++) coords.push([x, 0, z]);
  for (let z = -5; z <= 20; z++) {
    coords.push([12, 0, z]);
    coords.push([12, 1, z]);
  }
  return solidSetOf(coords);
}

/** A 2-voxel-tall wall: floor at y=0 everywhere, plus a wall at x=12 spanning rows 1-2. */
function twoVoxelWallWorld(): (x: number, y: number, z: number) => boolean {
  const coords: Array<readonly [number, number, number]> = [...floorAt(0)];
  for (let z = -5; z <= 20; z++) {
    coords.push([12, 1, z]);
    coords.push([12, 2, z]);
  }
  return solidSetOf(coords);
}

describe('tryAutoStep (realistic per-tick displacement)', () => {
  it('steps up a single voxel when flush against the step at walking speed', () => {
    const isSolid = oneVoxelStepWorld();
    // feet.x = 11.7 -> box.maxX = 12.0 exactly, already touching the step's
    // face (as it would be after a prior tick's grounded resolve clamped it
    // there), so this tick's move is fully blocked at ground level.
    const result = tryAutoStep(isSolid, [11.7, 1, 5], WALK_TICK_DELTA, 0, true);
    expect(result.stepped).toBe(true);
    expect(result.position[0]).toBeCloseTo(11.7 + WALK_TICK_DELTA);
    expect(result.position[1]).toBeCloseTo(1 + 1.05); // feet lifted by AUTO_STEP_LIFT, settles via gravity later
    expect(result.position[2]).toBeCloseTo(5);
  });

  it('steps up a single voxel at sprint speed too', () => {
    const isSolid = oneVoxelStepWorld();
    const result = tryAutoStep(isSolid, [11.7, 1, 5], SPRINT_TICK_DELTA, 0, true);
    expect(result.stepped).toBe(true);
    expect(result.position[0]).toBeCloseTo(11.7 + SPRINT_TICK_DELTA);
  });

  it('makes step progress even when only partially blocked this tick (not yet flush)', () => {
    // box.maxX = 11.95, short of the wall at x=12; a naive "did we cross a
    // full voxel" check would see partial ground progress and refuse, but
    // lifting should still find the full delta clear and win on progress.
    const isSolid = oneVoxelStepWorld();
    const result = tryAutoStep(isSolid, [11.65, 1, 5], WALK_TICK_DELTA, 0, true);
    expect(result.stepped).toBe(true);
    expect(result.position[0]).toBeCloseTo(11.65 + WALK_TICK_DELTA);
  });

  it('refuses a 2-voxel-tall obstacle at walking speed (lifting does not help)', () => {
    const isSolid = twoVoxelWallWorld();
    const result = tryAutoStep(isSolid, [11.7, 1, 5], WALK_TICK_DELTA, 0, true);
    expect(result.stepped).toBe(false);
    expect(result.position).toEqual([11.7, 1, 5]);
  });

  it('refuses to step when airborne, even flush against a valid 1-voxel step', () => {
    const isSolid = oneVoxelStepWorld();
    const result = tryAutoStep(isSolid, [11.7, 1, 5], WALK_TICK_DELTA, 0, false);
    expect(result.stepped).toBe(false);
  });

  it('does not step when nothing obstructs the move (no spurious lift on flat ground)', () => {
    const isSolid = solidSetOf(floorAt(0));
    const result = tryAutoStep(isSolid, [5, 1, 5], WALK_TICK_DELTA, 0, true);
    expect(result.stepped).toBe(false);
  });
});
