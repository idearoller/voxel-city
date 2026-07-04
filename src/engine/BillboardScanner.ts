/**
 * Derives animated-billboard quad placements directly from a `World`'s
 * voxel data — no `CityLayout`/`Billboard[]` plan object involved, same
 * "layout-free" convention `NavGrid.buildNavGrid` and `layout.ts`'s
 * `findGroundSpawnPoint` already use, so this works identically after a
 * fresh generation or a `.vxc` import (neither of which keeps the
 * generator's own planning objects around).
 *
 * `gen/infrastructure.ts`'s `writeBillboard` paints a flat
 * `BILLBOARD_WIDTH` x `BILLBOARD_HEIGHT` rectangle of a single neon block
 * id into a tower's 1-voxel-thick facade shell. That exact size is what
 * disambiguates a billboard from every other flat neon surface the
 * generator paints onto a facade — a shop band is 2 rows tall and spans a
 * whole wall (`width`/`depth` voxels wide, far more than `BILLBOARD_WIDTH`
 * for anything but the smallest parcels), a sign strip is only
 * `SIGN_WIDTH` (2) voxels wide, and bridge rails are a 2-row band along a
 * deck edge, not a bounded rectangle at all. Scanning for a *closed*
 * (all 4 borders non-matching) exact-size rectangle of one neon color means
 * a billboard is never mistaken for a fragment of a larger neon surface, and
 * vice versa.
 *
 * No Three.js — pure voxel-grid geometry, unit-testable without a renderer.
 */

import { BILLBOARD_HEIGHT, BILLBOARD_WIDTH } from '../gen/infrastructure';
import { NEON_CYAN, NEON_PINK, NEON_PURPLE, NEON_YELLOW } from '../world/BlockRegistry';
import type { Chunk } from '../world/Chunk';
import { CHUNK_SIZE, localIndex } from '../world/coords';
import type { World } from '../world/World';

const BILLBOARD_BLOCK_IDS: readonly number[] = [NEON_PINK, NEON_CYAN, NEON_YELLOW, NEON_PURPLE];

/** One axis a facade rectangle can vary along; the other of (x, z) is fixed at the plane's coordinate. */
type FacadeAxis = 'x' | 'z';

export interface BillboardFace {
  /** World-space center of the quad, flush against the facade with a small outward offset along `normal` to avoid z-fighting. */
  position: readonly [number, number, number];
  /** Outward-facing unit normal — exactly one axis nonzero, magnitude 1. */
  normal: readonly [number, number, number];
  /** Facade-plane axis this face varies along (its width axis; height is always y). */
  axis: FacadeAxis;
  /** The neon block id this billboard was painted with — folded into the per-instance atlas variant pick so the same city always looks the same (see `BillboardLayer`). */
  blockId: number;
}

/** Small outward push off the voxel face so the quad never z-fights with the wall behind it. */
const FLUSH_OFFSET = 0.02;

// Block ids are stored as `Uint8Array` bytes (see `Chunk.voxels`), so a
// 256-entry lookup table covers every possible id; this turns the ~9M
// per-cell reject check `scanCore` runs into a single indexed byte read
// instead of an `Array.includes` scan through `BILLBOARD_BLOCK_IDS` on
// every cell.
const BILLBOARD_ID_LOOKUP = ((): Uint8Array => {
  const table = new Uint8Array(256);
  for (const id of BILLBOARD_BLOCK_IDS) table[id] = 1;
  return table;
})();

function isBillboardBlock(id: number): boolean {
  return BILLBOARD_ID_LOOKUP[id] === 1;
}

/** All cells of a candidate WIDTH x HEIGHT rectangle share `blockId`, with every bordering cell (one step past each of the 4 edges) NOT matching it — i.e. this is an exact, closed rectangle, not a fragment of something larger. */
function isClosedRectangle(
  world: World,
  blockId: number,
  x0: number,
  y0: number,
  z0: number,
  axis: FacadeAxis,
): boolean {
  for (let w = 0; w < BILLBOARD_WIDTH; w++) {
    for (let h = 0; h < BILLBOARD_HEIGHT; h++) {
      const x = axis === 'x' ? x0 + w : x0;
      const z = axis === 'z' ? z0 + w : z0;
      if (world.getBlock(x, y0 + h, z) !== blockId) return false;
    }
  }

  const borderMatches = (w: number, h: number): boolean => {
    const x = axis === 'x' ? x0 + w : x0;
    const z = axis === 'z' ? z0 + w : z0;
    return world.getBlock(x, y0 + h, z) === blockId;
  };

  for (let w = -1; w <= BILLBOARD_WIDTH; w++) {
    if (borderMatches(w, -1)) return false;
    if (borderMatches(w, BILLBOARD_HEIGHT)) return false;
  }
  for (let h = 0; h < BILLBOARD_HEIGHT; h++) {
    if (borderMatches(-1, h)) return false;
    if (borderMatches(BILLBOARD_WIDTH, h)) return false;
  }

  return true;
}

/**
 * Upper bound on cells visited by `isBoundedRegion`'s flood fill. Must
 * comfortably exceed the largest realistic hollow-interior cross-section
 * (`MAX_FOOTPRINT`-ish towers cap out well under 60x60 = 3600) so a genuine
 * interior always finishes before hitting the cap, while staying far below
 * the size of a real exterior region (city blocks + streets span the
 * gridsize, tens of thousands of connected open cells) so an exterior probe
 * reliably blows the cap instead of coincidentally terminating early.
 */
const FLOOD_FILL_CAP = 4096;

const CARDINAL_OFFSETS: readonly (readonly [number, number])[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/**
 * Floods every non-solid (x, z) cell reachable from (startX, startZ) at
 * fixed `y`, staying within the plane (no vertical movement — see this
 * module's doc comment on why a single Y-row is deliberately used, not a
 * full 3D fill). Returns true if the flood exhausts naturally before
 * `FLOOD_FILL_CAP` cells (a bounded, enclosed region — a hollow interior),
 * false if it hits the cap still growing (an open, unbounded region — the
 * exterior street grid).
 */
function isBoundedRegion(world: World, startX: number, y: number, startZ: number): boolean {
  if (world.isSolid(startX, y, startZ)) return true; // caller only probes non-solid starting cells; treated as trivially bounded if this ever isn't so.

  const visited = new Set<number>();
  const key = (x: number, z: number): number => (x + 4096) * 65536 + (z + 4096);
  const queue: Array<[number, number]> = [[startX, startZ]];
  visited.add(key(startX, startZ));

  while (queue.length > 0) {
    if (visited.size > FLOOD_FILL_CAP) return false;
    const [x, z] = queue.shift() as [number, number];
    for (const [dx, dz] of CARDINAL_OFFSETS) {
      const nx = x + dx;
      const nz = z + dz;
      const k = key(nx, nz);
      if (visited.has(k)) continue;
      if (world.isSolid(nx, y, nz)) continue;
      visited.add(k);
      queue.push([nx, nz]);
    }
  }
  return true;
}

/**
 * Which of the two directions perpendicular to the facade plane is
 * "outward" (away from the building's own hollow interior). Towers are
 * hollow shells — the voxel immediately behind the facade is open air on
 * *both* sides (exterior sky, or the hollow interior), so adjacency alone
 * can't tell them apart, and comparing raw distance-to-nearest-solid is
 * actively wrong in a dense city: a neighboring building across a narrow
 * street can sit far closer (2-4 voxels) than this tower's own opposite
 * interior wall (can be 20+ voxels for a wide footprint), which flips the
 * "nearer = interior" assumption backwards.
 *
 * Enclosure, not distance, is what actually distinguishes them: this
 * tower's own hollow interior is a bounded region (walled in on every side
 * at this Y row, since a tower's shell is solid all the way around except
 * its own doorway, which sits on a *different* facade in the common case —
 * see `planBillboards`, which never places a billboard on the door side),
 * so a flood fill from the interior side exhausts quickly. The exterior
 * side connects to the open street grid — hundreds to thousands of
 * connected cells, including straight through any nearby neighboring
 * building's own gaps — so its flood fill reliably blows past a cap sized
 * well above the largest plausible interior and well below the open city
 * grid (`isBoundedRegion` / `FLOOD_FILL_CAP`). Returns null when both (or
 * neither) directions resolve the same way — nothing sane to derive; caller
 * skips this face rather than guessing.
 *
 * Known, deliberately-accepted edge case: the interior side's single-row
 * flood fill can leak into "unbounded" territory through more than one
 * route, not just one. The most direct is a billboard whose Y-range happens
 * to overlap the door's own height (`writeDoorway`'s 3 rows), letting that
 * row escape through the door opening on a *different* wall of the same
 * footprint (interiors have no floor-to-floor partitions — see
 * `writeShellAndWindows`). But measurement against real generator output
 * shows door-height overlap accounts for only a majority, not all, of
 * skips: large hollow interiors and window/setback carve-outs can also
 * flood-fill past `FLOOD_FILL_CAP` on their own at certain rows, with no
 * door involved at all. Whatever the route, both sides then agree (both
 * open) and this returns null — the face is skipped rather than
 * mis-oriented. Confirmed on real generator output
 * (`test/BillboardScanner.test.ts`'s oracle test, 10 seeds, 160 real
 * billboards): this skips ~15% of billboards — about 76% of those skips are
 * the door-height case, the remaining ~24% the other flood-leak routes
 * above — and produces zero wrong normals, a large improvement over the
 * previous nearest-solid-hit heuristic it replaced, which got ~70% of normals wrong
 * in the same measurement (dense-city neighbor buildings sitting closer
 * than a tower's own far interior wall). Resolving the remaining skips
 * would need door position and/or interior layout, neither of which is
 * available to a purely voxel-scan (layout-free) function — an acceptable
 * trade (invisible billboard, never a backwards one) for staying
 * import-safe.
 */
function resolveNormal(world: World, x: number, y: number, z: number, axis: FacadeAxis): readonly [number, number, number] | null {
  const [dx, dz] = axis === 'x' ? [0, 1] : [1, 0];
  const posBounded = isBoundedRegion(world, x + dx, y, z + dz);
  const negBounded = isBoundedRegion(world, x - dx, y, z - dz);

  if (posBounded === negBounded) return null; // ambiguous -- both enclosed or both open, can't tell interior from exterior here
  const interiorIsPositive = posBounded;
  const sign = interiorIsPositive ? -1 : 1;
  return axis === 'x' ? [0, 0, sign] : [sign, 0, 0];
}

/** True if (x0, y0, z0) is the bottom-left-most corner of a billboard rectangle varying along `axis`, i.e. the one canonical cell every match reports from. */
function tryMatchAt(world: World, x0: number, y0: number, z0: number, axis: FacadeAxis): BillboardFace | null {
  const blockId = world.getBlock(x0, y0, z0);
  if (!isBillboardBlock(blockId)) return null;
  if (!isClosedRectangle(world, blockId, x0, y0, z0, axis)) return null;

  const normal = resolveNormal(world, x0, y0, z0, axis);
  if (!normal) return null;

  const [nx, , nz] = normal;
  const centerY = y0 + BILLBOARD_HEIGHT / 2;

  // The facade plane is a single voxel layer: its "min" face (world coord =
  // the voxel's own integer position) faces the -axis direction, its "max"
  // face (voxel position + 1) faces +axis — see `ChunkMesher`'s FACES table,
  // which builds quad corners the same way. Pick whichever face the
  // resolved outward normal actually points through, along the axis this
  // rectangle is fixed on (the other, varying axis is centered on the
  // rectangle's own span).
  let centerX: number;
  let centerZ: number;
  if (axis === 'x') {
    centerX = x0 + BILLBOARD_WIDTH / 2;
    centerZ = nz > 0 ? z0 + 1 : z0;
  } else {
    centerZ = z0 + BILLBOARD_WIDTH / 2;
    centerX = nx > 0 ? x0 + 1 : x0;
  }

  return {
    position: [centerX + nx * FLUSH_OFFSET, centerY, centerZ + nz * FLUSH_OFFSET],
    normal,
    axis,
    blockId,
  };
}

/**
 * Reads the block id at (x, y, z) for the coarse per-cell reject check
 * only — the one call site that runs once per voxel in the whole world
 * (~9M cells for a full 274-chunk city). Swappable so
 * `scanBillboardFacesViaWorldGetBlock` (test-only, see below) can drive the
 * exact same loop through `World.getBlock`'s translation path as a
 * known-correct oracle, without duplicating `scanCore`.
 */
type CandidateBlockReader = (chunk: Chunk, lx: number, ly: number, lz: number, x: number, y: number, z: number) => number;

/**
 * Direct flat-array read, bypassing `World.getBlock`'s per-call
 * `chunkKey`/`Map.get`/`worldToChunk`/`worldToLocal` chain entirely: the
 * outer loop already has `chunk` and `(lx, ly, lz)` in hand from
 * `allocatedChunkEntries()`, and `Chunk.voxels`' flat layout
 * (`lx + lz*CHUNK_SIZE + ly*CHUNK_SIZE*CHUNK_SIZE`, see `coords.ts`'
 * `localIndex`) is exactly what `Chunk.getLocal` reads too — same bytes,
 * none of the redundant translation.
 */
const readCandidateBlockFast: CandidateBlockReader = (chunk, lx, ly, lz) =>
  chunk.voxels[localIndex(lx, ly, lz)] as number;

/**
 * Shared scan loop: every currently-allocated chunk of `world`, decomposed
 * into world-space (x, y, z), rejecting non-billboard-colored cells via
 * `readCandidateBlock` before any rectangle/normal work runs (billboards
 * are sparse — `BILLBOARD_CHANCE` = 8% of buildings). Cross-chunk work
 * (`isClosedRectangle`'s border reads, `resolveNormal`'s flood fill) still
 * goes through `world.getBlock`/`world.isSolid`, since a billboard
 * rectangle or flood fill can straddle a chunk boundary; those only run for
 * the sparse set of cells that pass the coarse check, so their translation
 * cost is negligible in aggregate.
 */
function scanCore(world: World, readCandidateBlock: CandidateBlockReader): BillboardFace[] {
  const faces: BillboardFace[] = [];
  const seen = new Set<string>();

  for (const { cx, cy, cz, chunk } of world.allocatedChunkEntries()) {
    const baseX = cx * CHUNK_SIZE;
    const baseY = cy * CHUNK_SIZE;
    const baseZ = cz * CHUNK_SIZE;

    for (let lx = 0; lx < CHUNK_SIZE; lx++) {
      for (let ly = 0; ly < CHUNK_SIZE; ly++) {
        for (let lz = 0; lz < CHUNK_SIZE; lz++) {
          const x = baseX + lx;
          const y = baseY + ly;
          const z = baseZ + lz;
          if (!isBillboardBlock(readCandidateBlock(chunk, lx, ly, lz, x, y, z))) continue;

          for (const axis of ['x', 'z'] as const) {
            const face = tryMatchAt(world, x, y, z, axis);
            if (!face) continue;
            const key = `${axis}:${x},${y},${z}`;
            if (seen.has(key)) continue;
            seen.add(key);
            faces.push(face);
          }
        }
      }
    }
  }

  return faces;
}

/**
 * Scans every currently-allocated chunk of `world` for billboard faces.
 * Reads each cell's candidate block id directly off `Chunk.voxels` (see
 * `readCandidateBlockFast`) instead of going through `world.getBlock`'s
 * per-call chunk-map lookup and coordinate translation — that translation,
 * paid ~9M times for a full 274-chunk city, was the dominant cost. Measured
 * on a representative generated city (`generateCity(world,
 * 'perf-harness-01')`, single-threaded dev hardware): ~1650ms before this
 * change, ~290ms after — a ~5.7x wall-clock improvement (see
 * `test/BillboardScanner.test.ts`'s parity test, which cross-checks this
 * path's output against the `world.getBlock` path verbatim to prove the
 * speedup didn't change any result). Sparse cross-chunk work (rectangle
 * borders, flood-fill normal resolution) still goes through `World`, since
 * only ~8% of buildings have a billboard at all — this only needs to run
 * once, right after generation/import, not per frame.
 */
export function scanBillboardFaces(world: World): BillboardFace[] {
  return scanCore(world, readCandidateBlockFast);
}

/**
 * Test-only oracle: identical scan, but reads every candidate cell through
 * `world.getBlock` instead of `Chunk.voxels` directly — the pre-optimization
 * behavior, kept alive solely so `test/BillboardScanner.test.ts` can assert
 * the fast path in `scanBillboardFaces` produces byte-identical output on a
 * real generated city, without duplicating `scanCore`'s rectangle/normal
 * logic. Not part of the module's public API for production use.
 */
export function scanBillboardFacesViaWorldGetBlock(world: World): BillboardFace[] {
  return scanCore(world, (_chunk, _lx, _ly, _lz, x, y, z) => world.getBlock(x, y, z));
}
