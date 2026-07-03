/**
 * 2D city planning: an axis-aligned road grid over a square plan, subdivided
 * into city blocks and then into parcels. Pure 2D math — no Three.js, no
 * World — so `CityGenerator` extrudes this into voxels separately and it
 * stays trivially testable.
 */

import { District, zoneBlock, type DistrictContext } from './districts';
import type { Rng } from './rng';
import { WORLD_SIZE_X, WORLD_SIZE_Z } from '../world/coords';

export type { District } from './districts';

export const GRID_SIZE_X = WORLD_SIZE_X;
export const GRID_SIZE_Z = WORLD_SIZE_Z;

export const CellType = {
  ROAD: 0,
  BLOCK: 1,
} as const;
export type CellType = (typeof CellType)[keyof typeof CellType];

const MIN_BLOCK_SPAN = 24;
const MAX_BLOCK_SPAN = 48;
const MINOR_ROAD_WIDTH = 5;
const MAJOR_ROAD_WIDTH = 7;
/** A major (wide) avenue replaces a minor road every 3-4 minor roads. */
const MIN_MINOR_ROADS_BETWEEN_MAJORS = 3;
const MAX_MINOR_ROADS_BETWEEN_MAJORS = 4;

const SIDEWALK_INSET = 1;
const MIN_PARCEL_SIZE = 8;
const MIN_PARCELS_PER_BLOCK = 2;
const MAX_PARCELS_PER_BLOCK = 6;

export interface Span {
  /** Inclusive start coordinate. */
  start: number;
  /** Exclusive end coordinate. */
  end: number;
}

export interface Parcel extends Span2D {
  /** Column/row index of the owning block, purely for deterministic per-parcel forking upstream. */
  blockX: number;
  blockZ: number;
}

export interface Span2D {
  x: number;
  z: number;
  width: number;
  depth: number;
}

export interface CityBlock extends Span2D {
  parcels: Parcel[];
  district: District;
}

export interface CityLayout {
  gridSizeX: number;
  gridSizeZ: number;
  /** Row-major (index = x + z * gridSizeX) cell types. */
  cells: Uint8Array;
  blocks: CityBlock[];
}

/** Splits [0, size) into alternating block spans and road spans along one axis. */
function planAxis(
  size: number,
  rng: Rng,
): { blockSpans: Span[]; roadSpans: Span[] } {
  const blockSpans: Span[] = [];
  const roadSpans: Span[] = [];

  let cursor = 0;
  let minorRoadsSinceMajor = 0;
  let nextMajorAt = rng.intRange(MIN_MINOR_ROADS_BETWEEN_MAJORS, MAX_MINOR_ROADS_BETWEEN_MAJORS);

  while (cursor < size) {
    const blockLength = Math.min(rng.intRange(MIN_BLOCK_SPAN, MAX_BLOCK_SPAN), size - cursor);
    blockSpans.push({ start: cursor, end: cursor + blockLength });
    cursor += blockLength;

    if (cursor >= size) break;

    const isMajor = minorRoadsSinceMajor >= nextMajorAt;
    const roadWidth = Math.min(isMajor ? MAJOR_ROAD_WIDTH : MINOR_ROAD_WIDTH, size - cursor);
    if (roadWidth <= 0) break;

    roadSpans.push({ start: cursor, end: cursor + roadWidth });
    cursor += roadWidth;

    if (isMajor) {
      minorRoadsSinceMajor = 0;
      nextMajorAt = rng.intRange(MIN_MINOR_ROADS_BETWEEN_MAJORS, MAX_MINOR_ROADS_BETWEEN_MAJORS);
    } else {
      minorRoadsSinceMajor++;
    }
  }

  return { blockSpans, roadSpans };
}

function fillRoadBand(cells: Uint8Array, gridSizeX: number, gridSizeZ: number, span: Span, axis: 'x' | 'z'): void {
  if (axis === 'x') {
    for (let x = span.start; x < span.end; x++) {
      for (let z = 0; z < gridSizeZ; z++) {
        cells[x + z * gridSizeX] = CellType.ROAD;
      }
    }
  } else {
    for (let z = span.start; z < span.end; z++) {
      for (let x = 0; x < gridSizeX; x++) {
        cells[x + z * gridSizeX] = CellType.ROAD;
      }
    }
  }
}

/** Recursively BSP-splits a rect into 2-6 leaf parcels, each axis >= MIN_PARCEL_SIZE. */
function splitIntoParcels(rect: Span2D, rng: Rng, targetCount: number): Span2D[] {
  const rects: Span2D[] = [rect];

  const canSplit = (r: Span2D): boolean =>
    Math.max(r.width, r.depth) >= MIN_PARCEL_SIZE * 2;

  while (rects.length < targetCount) {
    const splittableIndex = rects.findIndex(canSplit);
    if (splittableIndex === -1) break;

    const target = rects[splittableIndex] as Span2D;
    const splitOnX = target.width >= target.depth;
    const length = splitOnX ? target.width : target.depth;
    const cut = rng.intRange(MIN_PARCEL_SIZE, length - MIN_PARCEL_SIZE);

    const a: Span2D = splitOnX
      ? { x: target.x, z: target.z, width: cut, depth: target.depth }
      : { x: target.x, z: target.z, width: target.width, depth: cut };
    const b: Span2D = splitOnX
      ? { x: target.x + cut, z: target.z, width: target.width - cut, depth: target.depth }
      : { x: target.x, z: target.z + cut, width: target.width, depth: target.depth - cut };

    rects.splice(splittableIndex, 1, a, b);
  }

  return rects;
}

function planParcels(block: Span2D, blockX: number, blockZ: number, rng: Rng): Parcel[] {
  const interior: Span2D = {
    x: block.x + SIDEWALK_INSET,
    z: block.z + SIDEWALK_INSET,
    width: block.width - SIDEWALK_INSET * 2,
    depth: block.depth - SIDEWALK_INSET * 2,
  };

  if (interior.width < MIN_PARCEL_SIZE || interior.depth < MIN_PARCEL_SIZE) {
    // Block too small (after the sidewalk ring) to host even one parcel.
    return [];
  }

  const targetCount = rng.intRange(MIN_PARCELS_PER_BLOCK, MAX_PARCELS_PER_BLOCK);
  return splitIntoParcels(interior, rng, targetCount).map((rect) => ({ ...rect, blockX, blockZ }));
}

/**
 * Plans a full city: road grid -> block rects -> BSP parcels with a
 * sidewalk ring. `rng` should already be a forked stream dedicated to
 * layout (see CityGenerator) so it doesn't perturb other sub-generators.
 */
export function planLayout(rng: Rng): CityLayout {
  const gridSizeX = GRID_SIZE_X;
  const gridSizeZ = GRID_SIZE_Z;
  const cells = new Uint8Array(gridSizeX * gridSizeZ).fill(CellType.BLOCK);

  const xAxis = planAxis(gridSizeX, rng.fork('roads-x'));
  const zAxis = planAxis(gridSizeZ, rng.fork('roads-z'));

  for (const span of xAxis.roadSpans) fillRoadBand(cells, gridSizeX, gridSizeZ, span, 'x');
  for (const span of zAxis.roadSpans) fillRoadBand(cells, gridSizeX, gridSizeZ, span, 'z');

  const parcelRng = rng.fork('parcels');
  const districtRng = rng.fork('districts');
  const districtCtx: DistrictContext = { gridSizeX, gridSizeZ, noiseSeed: districtRng.hashSeed() };
  const blocks: CityBlock[] = [];
  xAxis.blockSpans.forEach((xSpan, blockX) => {
    zAxis.blockSpans.forEach((zSpan, blockZ) => {
      const rect: Span2D = {
        x: xSpan.start,
        z: zSpan.start,
        width: xSpan.end - xSpan.start,
        depth: zSpan.end - zSpan.start,
      };
      const centerX = rect.x + rect.width / 2;
      const centerZ = rect.z + rect.depth / 2;
      const district = zoneBlock(centerX, centerZ, districtCtx, districtRng.fork(`${blockX},${blockZ}`));
      // Park blocks are rasterized whole (grass/paths/trees) by parks.ts
      // instead of subdivided into building parcels.
      const parcels =
        district === District.PARK ? [] : planParcels(rect, blockX, blockZ, parcelRng.fork(`${blockX},${blockZ}`));
      blocks.push({ ...rect, parcels, district });
    });
  });

  return { gridSizeX, gridSizeZ, cells, blocks };
}

export function cellAt(layout: CityLayout, x: number, z: number): CellType {
  if (x < 0 || x >= layout.gridSizeX || z < 0 || z >= layout.gridSizeZ) {
    return CellType.ROAD;
  }
  return layout.cells[x + z * layout.gridSizeX] as CellType;
}

/**
 * Finds a road cell near the plan's center (spiral outward search), for
 * spawning the player somewhere sensible after generation.
 */
export function findSpawnPoint(layout: CityLayout): { x: number; z: number } {
  const centerX = Math.floor(layout.gridSizeX / 2);
  const centerZ = Math.floor(layout.gridSizeZ / 2);

  const maxRadius = Math.max(layout.gridSizeX, layout.gridSizeZ);
  for (let radius = 0; radius <= maxRadius; radius++) {
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dz = -radius; dz <= radius; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== radius) continue;
        const x = centerX + dx;
        const z = centerZ + dz;
        if (cellAt(layout, x, z) === CellType.ROAD) {
          return { x, z };
        }
      }
    }
  }
  return { x: centerX, z: centerZ };
}
