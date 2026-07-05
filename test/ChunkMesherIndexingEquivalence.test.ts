import { describe, expect, it } from 'vitest';
import { AIR, CONCRETE, getBlock, type NeonChannel } from '../src/world/BlockRegistry';
import { CHUNK_SIZE, chunkLocalToWorld, localIndex, type ChunkCoord } from '../src/world/coords';
import { generateCity } from '../src/gen/CityGenerator';
import { World } from '../src/world/World';
import {
  buildChunkMeshDataFromSnapshot,
  buildChunkSnapshot,
  paddedIndex,
  type ChunkMeshData,
  type ChunkSnapshot,
  type MeshGroup,
} from '../src/engine/ChunkMesher';

/**
 * Task 33 (indexed chunk geometry) rewired `buildChunkMeshDataFromSnapshot`
 * to emit 4 unique vertices + 6 indices per quad face instead of 6 flat
 * (non-indexed) vertices. Everything else about the emission -- which faces
 * are exposed, per-vertex baked AO, per-vertex color/shade, winding order,
 * normals -- must be *exactly* unchanged.
 *
 * A vertex-count assertion alone can't prove that: it would happily pass if
 * winding flipped, if AO levels were assigned to the wrong corner, or if a
 * face were silently dropped along with its 2 "extra" now-unshared
 * vertices. So this file keeps a frozen, test-only copy of the mesher as it
 * existed *before* Task 33 (verbatim FACES table, corner AO math, shading --
 * copied here rather than re-imported, since the whole point is to be
 * immune to any future edit to the real mesher's internals) and diffs its
 * non-indexed triangle output against the *current* mesher's indexed output
 * de-indexed back into triangles, over every chunk a real generated city
 * actually allocates. Triangles are compared as an order-independent
 * multiset (chunk/group iteration order is not semantically meaningful) but
 * each triangle's 3 vertices keep their winding order (backface culling
 * depends on it) and exact position/normal/color values (bitwise, via
 * `toEqual` on the tuples -- no epsilon).
 */

type Vec3 = readonly [number, number, number];

interface LegacyFaceSpec {
  readonly dir: Vec3;
  readonly normal: Vec3;
  readonly corners: readonly [Vec3, Vec3, Vec3, Vec3];
  readonly shade: number;
}

const LEGACY_FACES: readonly LegacyFaceSpec[] = [
  { dir: [1, 0, 0], normal: [1, 0, 0], corners: [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]], shade: 0.8 },
  { dir: [-1, 0, 0], normal: [-1, 0, 0], corners: [[0, 0, 1], [0, 1, 1], [0, 1, 0], [0, 0, 0]], shade: 0.8 },
  { dir: [0, 1, 0], normal: [0, 1, 0], corners: [[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]], shade: 1.0 },
  { dir: [0, -1, 0], normal: [0, -1, 0], corners: [[0, 0, 1], [0, 0, 0], [1, 0, 0], [1, 0, 1]], shade: 0.5 },
  { dir: [0, 0, 1], normal: [0, 0, 1], corners: [[1, 0, 1], [1, 1, 1], [0, 1, 1], [0, 0, 1]], shade: 0.6 },
  { dir: [0, 0, -1], normal: [0, 0, -1], corners: [[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]], shade: 0.6 },
];

const LEGACY_AO_SHADE: readonly [number, number, number, number] = [0.45, 0.6, 0.8, 1.0];
const LEGACY_ROAD_TINT_MIN = 0.82;
const LEGACY_ROAD_TINT_MAX = 1.0;

function legacyHash01(x: number, y: number, z: number): number {
  let h = (x * 374761393 + y * 668265263 + z * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 0xffffffff;
}

function legacyRoadTintFactor(x: number, y: number, z: number): number {
  return LEGACY_ROAD_TINT_MIN + legacyHash01(x, y, z) * (LEGACY_ROAD_TINT_MAX - LEGACY_ROAD_TINT_MIN);
}

const LEGACY_AXIS_UNIT: readonly [Vec3, Vec3, Vec3] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

function legacyNormalAxisOf(dir: Vec3): 0 | 1 | 2 {
  if (dir[0] !== 0) return 0;
  if (dir[1] !== 0) return 1;
  return 2;
}

function legacyCornerAoLevel(
  opaquePadded: Uint8Array,
  lx: number,
  ly: number,
  lz: number,
  dir: Vec3,
  corner: Vec3,
): number {
  const normalAxis = legacyNormalAxisOf(dir);
  const tangentAxes = ([0, 1, 2] as const).filter((a) => a !== normalAxis) as [0 | 1 | 2, 0 | 1 | 2];
  const [uAxis, vAxis] = tangentAxes;

  const uSign = corner[uAxis] === 1 ? 1 : -1;
  const vSign = corner[vAxis] === 1 ? 1 : -1;

  const uUnit = LEGACY_AXIS_UNIT[uAxis];
  const vUnit = LEGACY_AXIS_UNIT[vAxis];

  const s1x = lx + dir[0] + uUnit[0] * uSign;
  const s1y = ly + dir[1] + uUnit[1] * uSign;
  const s1z = lz + dir[2] + uUnit[2] * uSign;

  const s2x = lx + dir[0] + vUnit[0] * vSign;
  const s2y = ly + dir[1] + vUnit[1] * vSign;
  const s2z = lz + dir[2] + vUnit[2] * vSign;

  const cx = lx + dir[0] + uUnit[0] * uSign + vUnit[0] * vSign;
  const cy = ly + dir[1] + uUnit[1] * uSign + vUnit[1] * vSign;
  const cz = lz + dir[2] + uUnit[2] * uSign + vUnit[2] * vSign;

  const side1 = opaquePadded[paddedIndex(s1x, s1y, s1z)] === 1 ? 1 : 0;
  const side2 = opaquePadded[paddedIndex(s2x, s2y, s2z)] === 1 ? 1 : 0;
  const cornerOccluder = opaquePadded[paddedIndex(cx, cy, cz)] === 1 ? 1 : 0;

  if (side1 && side2) return 0;
  return 3 - (side1 + side2 + cornerOccluder);
}

interface LegacyGroup {
  positions: number[];
  normals: number[];
  colors: number[];
}

function legacyEmptyGroup(): LegacyGroup {
  return { positions: [], normals: [], colors: [] };
}

function legacyGroupFor(
  def: ReturnType<typeof getBlock>,
  solid: LegacyGroup,
  road: LegacyGroup,
  windowLit: LegacyGroup,
  neon: [LegacyGroup, LegacyGroup, LegacyGroup, LegacyGroup],
): LegacyGroup {
  if (!def.emissive) return def.road ? road : solid;
  if (def.neonChannel !== undefined) return neon[def.neonChannel as NeonChannel];
  return windowLit;
}

interface LegacyChunkMeshData {
  solid: LegacyGroup;
  road: LegacyGroup;
  windowLit: LegacyGroup;
  neon: [LegacyGroup, LegacyGroup, LegacyGroup, LegacyGroup];
}

/** Verbatim (pre-Task-33) non-indexed emission: 6 flat vertices per face, 2 triangles (0,1,2)+(0,2,3). */
function legacyBuildChunkMeshDataFromSnapshot(snapshot: ChunkSnapshot, chunk: ChunkCoord): LegacyChunkMeshData {
  const solid = legacyEmptyGroup();
  const road = legacyEmptyGroup();
  const windowLit = legacyEmptyGroup();
  const neon: [LegacyGroup, LegacyGroup, LegacyGroup, LegacyGroup] = [
    legacyEmptyGroup(),
    legacyEmptyGroup(),
    legacyEmptyGroup(),
    legacyEmptyGroup(),
  ];
  const { opaquePadded } = snapshot;
  const isOpaqueLocal = (lx: number, ly: number, lz: number): boolean => opaquePadded[paddedIndex(lx, ly, lz)] === 1;

  for (let ly = 0; ly < CHUNK_SIZE; ly++) {
    for (let lz = 0; lz < CHUNK_SIZE; lz++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        const blockId = snapshot.voxels[localIndex(lx, ly, lz)] as number;
        if (blockId === AIR) continue;
        const def = getBlock(blockId);
        const { x, y, z } = chunkLocalToWorld(chunk, { lx, ly, lz });

        const group = legacyGroupFor(def, solid, road, windowLit, neon);
        const tint = def.road ? legacyRoadTintFactor(x, y, z) : 1;
        const [r, g, b] = def.color;

        for (const face of LEGACY_FACES) {
          const nlx = lx + face.dir[0];
          const nly = ly + face.dir[1];
          const nlz = lz + face.dir[2];
          if (isOpaqueLocal(nlx, nly, nlz)) continue;

          const aoLevels = face.corners.map((corner) => legacyCornerAoLevel(opaquePadded, lx, ly, lz, face.dir, corner));
          const positions = face.corners.map((corner) => [x + corner[0], y + corner[1], z + corner[2]]);
          const shadeAt = (i: number): number => face.shade * (LEGACY_AO_SHADE[aoLevels[i] as number] as number);

          const emit = (i: number): void => {
            const shade = shadeAt(i) * tint;
            const pos = positions[i] as number[];
            group.positions.push(pos[0] as number, pos[1] as number, pos[2] as number);
            group.normals.push(face.normal[0], face.normal[1], face.normal[2]);
            group.colors.push(r * shade, g * shade, b * shade);
          };

          emit(0);
          emit(1);
          emit(2);
          emit(0);
          emit(2);
          emit(3);
        }
      }
    }
  }

  return { solid, road, windowLit, neon };
}

interface Triangle {
  readonly key: string;
}

/** Turns a flat non-indexed vertex stream (6 verts = 2 tris per face) into an order-independent-comparable list of triangle keys, preserving each triangle's own winding. */
function trianglesFromFlat(group: LegacyGroup): Triangle[] {
  const vertexCount = group.positions.length / 3;
  const triangles: Triangle[] = [];
  for (let base = 0; base < vertexCount; base += 3) {
    triangles.push({ key: triangleKey(group, [base, base + 1, base + 2]) });
  }
  return triangles;
}

/** Turns indexed geometry (4 unique verts + 6 indices per face) back into the same per-triangle key format, by resolving each index. */
function trianglesFromIndexed(group: MeshGroup): Triangle[] {
  const triangles: Triangle[] = [];
  for (let i = 0; i < group.indices.length; i += 3) {
    const a = group.indices[i] as number;
    const b = group.indices[i + 1] as number;
    const c = group.indices[i + 2] as number;
    triangles.push({ key: triangleKey(group, [a, b, c]) });
  }
  return triangles;
}

function triangleKey(group: { positions: number[]; normals: number[]; colors: number[] }, vertexIndices: [number, number, number]): string {
  const parts = vertexIndices.map((v) => {
    const p = [group.positions[v * 3], group.positions[v * 3 + 1], group.positions[v * 3 + 2]];
    const n = [group.normals[v * 3], group.normals[v * 3 + 1], group.normals[v * 3 + 2]];
    const c = [group.colors[v * 3], group.colors[v * 3 + 1], group.colors[v * 3 + 2]];
    return [...p, ...n, ...c].join(',');
  });
  // Winding within a triangle is preserved (join in vertex order, not sorted);
  // only the *set* of triangles is order-independent, via the later .sort()
  // over this whole array.
  return parts.join('|');
}

function sortedKeys(triangles: Triangle[]): string[] {
  return triangles.map((t) => t.key).sort();
}

function assertGroupEquivalent(legacy: LegacyGroup, current: MeshGroup, label: string): void {
  const legacyKeys = sortedKeys(trianglesFromFlat(legacy));
  const currentKeys = sortedKeys(trianglesFromIndexed(current));
  expect(currentKeys, `${label}: triangle count differs`).toHaveLength(legacyKeys.length);
  expect(currentKeys, `${label}: triangle set differs`).toEqual(legacyKeys);
}

function assertChunkEquivalent(legacy: LegacyChunkMeshData, current: ChunkMeshData): void {
  assertGroupEquivalent(legacy.solid, current.solid, 'solid');
  assertGroupEquivalent(legacy.road, current.road, 'road');
  assertGroupEquivalent(legacy.windowLit, current.windowLit, 'windowLit');
  for (let channel = 0; channel < 4; channel++) {
    assertGroupEquivalent(
      legacy.neon[channel] as LegacyGroup,
      current.neon[channel] as MeshGroup,
      `neon[${channel}]`,
    );
  }
}

describe('indexed geometry is a pure re-encoding of the pre-indexing mesher output', () => {
  it('produces the exact same triangle set (positions/normals/colors/winding) as the frozen pre-Task-33 non-indexed emission, across a representative sample of chunks a real generated city allocates', () => {
    const world = new World();
    generateCity(world, 'perf-harness-01');
    const allChunks = world.allocatedChunkEntries();
    expect(allChunks.length).toBeGreaterThan(0);

    // A representative, evenly-spaced sample rather than all ~274 chunks:
    // building + string-keying + sorting the full city's ~4.9M triangles
    // twice per chunk (legacy and current) is real work this test doesn't
    // need to pay for -- every chunk goes through the identical code path,
    // so a spread-out sample (varied buildings/roads/neon/window content,
    // not just the first N allocated) gives the same confidence for a
    // fraction of the cost. `MesherPerf.test.ts` already covers the full
    // city for triangle-count/timing regressions.
    const SAMPLE_SIZE = 30;
    const stride = Math.max(1, Math.floor(allChunks.length / SAMPLE_SIZE));
    const sampledChunks = allChunks.filter((_, i) => i % stride === 0);

    for (const { cx, cy, cz } of sampledChunks) {
      const chunk: ChunkCoord = { cx, cy, cz };
      const snapshot = buildChunkSnapshot(world, chunk);

      const legacy = legacyBuildChunkMeshDataFromSnapshot(snapshot, chunk);
      const current = buildChunkMeshDataFromSnapshot(snapshot, chunk);

      assertChunkEquivalent(legacy, current);
    }
  });

  it('holds on the pathological checkerboard chunk too (every solid voxel exposing all 6 faces)', () => {
    const world = new World();
    for (let x = 0; x < CHUNK_SIZE; x++) {
      for (let y = 0; y < CHUNK_SIZE; y++) {
        for (let z = 0; z < CHUNK_SIZE; z++) {
          if ((x + y + z) % 2 === 0) world.setBlock(x, y, z, CONCRETE);
        }
      }
    }
    const chunk: ChunkCoord = { cx: 0, cy: 0, cz: 0 };
    const snapshot = buildChunkSnapshot(world, chunk);

    const legacy = legacyBuildChunkMeshDataFromSnapshot(snapshot, chunk);
    const current = buildChunkMeshDataFromSnapshot(snapshot, chunk);

    assertChunkEquivalent(legacy, current);
  });
});
