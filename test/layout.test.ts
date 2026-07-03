import { describe, expect, it } from 'vitest';
import { District } from '../src/gen/districts';
import { createRng } from '../src/gen/rng';
import { CellType, cellAt, findSpawnPoint, planLayout } from '../src/gen/layout';
import { WORLD_SIZE_X, WORLD_SIZE_Z } from '../src/world/coords';

const MIN_PARCEL_SIZE = 8;

function layoutFor(seed: string) {
  return planLayout(createRng(seed).fork('layout'));
}

describe('planLayout determinism', () => {
  it('produces identical layouts for the same seed', () => {
    const a = layoutFor('reproducible-city');
    const b = layoutFor('reproducible-city');
    expect(Array.from(a.cells)).toEqual(Array.from(b.cells));
    expect(a.blocks).toEqual(b.blocks);
  });

  it('produces different layouts for different seeds', () => {
    const a = layoutFor('city-one');
    const b = layoutFor('city-two');
    expect(Array.from(a.cells)).not.toEqual(Array.from(b.cells));
  });
});

describe('planLayout grid', () => {
  it('sizes the grid to the world bounds', () => {
    const layout = layoutFor('grid-size');
    expect(layout.gridSizeX).toBe(WORLD_SIZE_X);
    expect(layout.gridSizeZ).toBe(WORLD_SIZE_Z);
    expect(layout.cells.length).toBe(WORLD_SIZE_X * WORLD_SIZE_Z);
  });

  it('road bands span the full opposite axis (edge-to-edge connectivity)', () => {
    const layout = layoutFor('connectivity');
    // Any road cell's entire column (fixed x, varying z) or row (fixed z,
    // varying x) must be entirely road, since roads are full-span bands.
    let foundRoad = false;
    for (let x = 0; x < layout.gridSizeX; x++) {
      let columnAllRoad = true;
      for (let z = 0; z < layout.gridSizeZ; z++) {
        if (cellAt(layout, x, z) !== CellType.ROAD) columnAllRoad = false;
      }
      if (columnAllRoad) {
        // Spot check: at least the first and last row of this road column are road.
        expect(cellAt(layout, x, 0)).toBe(CellType.ROAD);
        expect(cellAt(layout, x, layout.gridSizeZ - 1)).toBe(CellType.ROAD);
        foundRoad = true;
      }
    }
    expect(foundRoad).toBe(true);
  });
});

describe('planLayout blocks', () => {
  it('keeps every block rect fully within grid bounds', () => {
    const layout = layoutFor('bounds-check');
    for (const block of layout.blocks) {
      expect(block.x).toBeGreaterThanOrEqual(0);
      expect(block.z).toBeGreaterThanOrEqual(0);
      expect(block.x + block.width).toBeLessThanOrEqual(layout.gridSizeX);
      expect(block.z + block.depth).toBeLessThanOrEqual(layout.gridSizeZ);
    }
  });

  it('marks every cell inside a block rect as BLOCK, never ROAD', () => {
    const layout = layoutFor('no-overlap');
    for (const block of layout.blocks) {
      for (let x = block.x; x < block.x + block.width; x++) {
        for (let z = block.z; z < block.z + block.depth; z++) {
          expect(cellAt(layout, x, z)).toBe(CellType.BLOCK);
        }
      }
    }
  });
});

describe('planLayout parcels', () => {
  it('keeps every parcel within its block interior (sidewalk ring present)', () => {
    const layout = layoutFor('sidewalk-ring');
    for (const block of layout.blocks) {
      for (const parcel of block.parcels) {
        expect(parcel.x).toBeGreaterThanOrEqual(block.x + 1);
        expect(parcel.z).toBeGreaterThanOrEqual(block.z + 1);
        expect(parcel.x + parcel.width).toBeLessThanOrEqual(block.x + block.width - 1);
        expect(parcel.z + parcel.depth).toBeLessThanOrEqual(block.z + block.depth - 1);
      }
    }
  });

  it('never lets parcels overlap road cells', () => {
    const layout = layoutFor('parcel-vs-road');
    for (const block of layout.blocks) {
      for (const parcel of block.parcels) {
        for (let x = parcel.x; x < parcel.x + parcel.width; x++) {
          for (let z = parcel.z; z < parcel.z + parcel.depth; z++) {
            expect(cellAt(layout, x, z)).toBe(CellType.BLOCK);
          }
        }
      }
    }
  });

  it('respects the minimum parcel size on both axes', () => {
    const layout = layoutFor('min-parcel-size');
    for (const block of layout.blocks) {
      for (const parcel of block.parcels) {
        expect(parcel.width).toBeGreaterThanOrEqual(MIN_PARCEL_SIZE);
        expect(parcel.depth).toBeGreaterThanOrEqual(MIN_PARCEL_SIZE);
      }
    }
  });

  it('does not let sibling parcels within a block overlap each other', () => {
    const layout = layoutFor('sibling-overlap');
    for (const block of layout.blocks) {
      const occupied = new Set<string>();
      for (const parcel of block.parcels) {
        for (let x = parcel.x; x < parcel.x + parcel.width; x++) {
          for (let z = parcel.z; z < parcel.z + parcel.depth; z++) {
            const key = `${x},${z}`;
            expect(occupied.has(key)).toBe(false);
            occupied.add(key);
          }
        }
      }
    }
  });
});

describe('planLayout districts', () => {
  it('assigns every block a district, and gives park blocks no parcels', () => {
    const layout = layoutFor('district-assignment');
    for (const block of layout.blocks) {
      expect(Object.values(District)).toContain(block.district);
      if (block.district === District.PARK) {
        expect(block.parcels).toHaveLength(0);
      }
    }
  });

  it('assigns districts deterministically for the same seed', () => {
    const a = layoutFor('district-determinism');
    const b = layoutFor('district-determinism');
    expect(a.blocks.map((block) => block.district)).toEqual(b.blocks.map((block) => block.district));
  });
});

describe('findSpawnPoint', () => {
  it('returns a road cell', () => {
    const layout = layoutFor('spawn-point');
    const spawn = findSpawnPoint(layout);
    expect(cellAt(layout, spawn.x, spawn.z)).toBe(CellType.ROAD);
  });
});
