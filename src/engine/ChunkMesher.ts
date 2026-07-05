import { AIR, getBlock, type NeonChannel } from '../world/BlockRegistry';
import { CHUNK_SIZE, CHUNK_VOXEL_COUNT, chunkLocalToWorld, localIndex, type ChunkCoord } from '../world/coords';
import type { World } from '../world/World';

type Vec3 = readonly [number, number, number];

interface FaceSpec {
  /** Offset to the neighboring voxel this face looks into (used for culling + AO). */
  readonly dir: Vec3;
  readonly normal: Vec3;
  /** Four corners of the quad, as {0,1} offsets from the voxel's min corner, CCW when viewed from outside. */
  readonly corners: readonly [Vec3, Vec3, Vec3, Vec3];
  /** Flat baked shade approximating a fixed key light, independent of AO. */
  readonly shade: number;
}

const FACES: readonly FaceSpec[] = [
  {
    dir: [1, 0, 0],
    normal: [1, 0, 0],
    corners: [
      [1, 0, 0],
      [1, 1, 0],
      [1, 1, 1],
      [1, 0, 1],
    ],
    shade: 0.8,
  },
  {
    dir: [-1, 0, 0],
    normal: [-1, 0, 0],
    corners: [
      [0, 0, 1],
      [0, 1, 1],
      [0, 1, 0],
      [0, 0, 0],
    ],
    shade: 0.8,
  },
  {
    dir: [0, 1, 0],
    normal: [0, 1, 0],
    corners: [
      [0, 1, 0],
      [0, 1, 1],
      [1, 1, 1],
      [1, 1, 0],
    ],
    shade: 1.0,
  },
  {
    dir: [0, -1, 0],
    normal: [0, -1, 0],
    corners: [
      [0, 0, 1],
      [0, 0, 0],
      [1, 0, 0],
      [1, 0, 1],
    ],
    shade: 0.5,
  },
  {
    dir: [0, 0, 1],
    normal: [0, 0, 1],
    corners: [
      [1, 0, 1],
      [1, 1, 1],
      [0, 1, 1],
      [0, 0, 1],
    ],
    shade: 0.6,
  },
  {
    dir: [0, 0, -1],
    normal: [0, 0, -1],
    corners: [
      [0, 0, 0],
      [0, 1, 0],
      [1, 1, 0],
      [1, 0, 0],
    ],
    shade: 0.6,
  },
];

const AO_SHADE: readonly [number, number, number, number] = [0.45, 0.6, 0.8, 1.0];

/** Wet-mottled puddle look for road voxels: darkens each voxel's base color by a small, deterministic per-position amount. */
const ROAD_TINT_MIN = 0.82;
const ROAD_TINT_MAX = 1.0;

/**
 * Deterministic 0..1 hash of a voxel's world position (no Math.random, so
 * meshing stays pure and reproducible). Same mixing strategy as
 * `neon.ts`'s `hash01`, just seeded from 3 coordinates instead of 1.
 */
function hash01(x: number, y: number, z: number): number {
  let h = (x * 374761393 + y * 668265263 + z * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 0xffffffff;
}

/** Per-voxel darkening multiplier for road surfaces, giving a wet-mottled puddle variation. */
function roadTintFactor(x: number, y: number, z: number): number {
  return ROAD_TINT_MIN + hash01(x, y, z) * (ROAD_TINT_MAX - ROAD_TINT_MIN);
}

const AXIS_UNIT: readonly [Vec3, Vec3, Vec3] = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];

function axisUnit(axis: 0 | 1 | 2): Vec3 {
  return AXIS_UNIT[axis];
}

/** Which axis index (0=x,1=y,2=z) a face's normal points along. */
function normalAxisOf(dir: Vec3): 0 | 1 | 2 {
  if (dir[0] !== 0) return 0;
  if (dir[1] !== 0) return 1;
  return 2;
}

/**
 * Chunk size plus a 1-voxel margin on every side (32 + 1 + 1). Every neighbor
 * lookup the mesher performs — face-culling and the 3-neighbor-occluder AO
 * corner check alike — reaches at most 1 voxel past the chunk's own bounds
 * along any single axis (never 2, even at a chunk corner: the face direction
 * offsets the normal axis by 1, the AO tangent offsets each add at most 1 to
 * the other two axes), so this margin is exactly sufficient.
 */
export const CHUNK_PAD = CHUNK_SIZE + 2;
const CHUNK_PAD_VOXEL_COUNT = CHUNK_PAD * CHUNK_PAD * CHUNK_PAD;

/**
 * Flat index into a `CHUNK_PAD`-sided cube for a chunk-local coordinate in
 * `[-1, CHUNK_SIZE]` along each axis (i.e. the chunk itself plus its
 * 1-voxel border shell).
 */
export function paddedIndex(lx: number, ly: number, lz: number): number {
  return (lx + 1) + (lz + 1) * CHUNK_PAD + (ly + 1) * CHUNK_PAD * CHUNK_PAD;
}

/**
 * Everything `buildChunkMeshDataFromSnapshot` needs to mesh one chunk,
 * copied out of `World` up front so meshing itself never touches `World`
 * (or the DOM/Three.js) again — the whole reason this is worker-portable.
 */
export interface ChunkSnapshot {
  /** This chunk's own voxel ids, `Chunk.voxels`' flat local-index layout (length `CHUNK_VOXEL_COUNT`). */
  readonly voxels: Uint8Array;
  /**
   * Opacity (0/1) for every voxel in the chunk plus its 1-voxel border
   * shell, indexed via `paddedIndex`. This is *only* opacity (not full
   * block ids) because that's all the mesher ever needs from a neighbor —
   * see `CHUNK_PAD`'s doc comment.
   */
  readonly opaquePadded: Uint8Array;
}

/**
 * Copies the live voxel data + border opacity a `ChunkCoord` needs to be
 * meshed into a snapshot that owns its own memory (safe to hand to a worker
 * as a transferable, or read at any later time regardless of subsequent
 * `World` mutation). The only function in this module that still touches
 * `World` — everything downstream of this is pure.
 */
export function buildChunkSnapshot(world: World, chunk: ChunkCoord): ChunkSnapshot {
  const source = world.peekChunk(chunk.cx, chunk.cy, chunk.cz);
  const voxels = new Uint8Array(CHUNK_VOXEL_COUNT);
  if (source) {
    voxels.set(source.voxels);
  }

  const opaquePadded = new Uint8Array(CHUNK_PAD_VOXEL_COUNT);
  for (let py = -1; py <= CHUNK_SIZE; py++) {
    for (let pz = -1; pz <= CHUNK_SIZE; pz++) {
      for (let px = -1; px <= CHUNK_SIZE; px++) {
        const { x, y, z } = chunkLocalToWorld(chunk, { lx: px, ly: py, lz: pz });
        if (world.isOpaque(x, y, z)) {
          opaquePadded[paddedIndex(px, py, pz)] = 1;
        }
      }
    }
  }

  return { voxels, opaquePadded };
}

/**
 * Classic 3-neighbor-occluder baked AO for one quad corner, resolved
 * entirely against a snapshot's padded opacity shell (chunk-local
 * coordinates in, no `World` involved).
 * Returns a level in [0, 3] where 3 = fully lit, 0 = fully occluded.
 */
function cornerAoLevel(
  opaquePadded: Uint8Array,
  lx: number,
  ly: number,
  lz: number,
  dir: Vec3,
  corner: Vec3,
): number {
  const normalAxis = normalAxisOf(dir);
  const tangentAxes = ([0, 1, 2] as const).filter((a) => a !== normalAxis) as [0 | 1 | 2, 0 | 1 | 2];
  const [uAxis, vAxis] = tangentAxes;

  const uSign = corner[uAxis] === 1 ? 1 : -1;
  const vSign = corner[vAxis] === 1 ? 1 : -1;

  const uUnit = axisUnit(uAxis);
  const vUnit = axisUnit(vAxis);

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

export interface MeshGroup {
  positions: number[];
  normals: number[];
  colors: number[];
  /**
   * Triangle indices into this group's own position/normal/color arrays, 6
   * per quad face (two triangles, `[0,1,2, 0,2,3]` relative to that face's 4
   * vertices). Vertices are never shared *across* faces — each face's AO
   * shading and normal are baked per-vertex and differ face to face — only
   * a single quad's own 2 triangles share its 4 vertices.
   */
  indices: number[];
}

function emptyGroup(): MeshGroup {
  return { positions: [], normals: [], colors: [], indices: [] };
}

export interface ChunkMeshData {
  solid: MeshGroup;
  /** Road-surface blocks (ASPHALT), routed to their own group so they can carry the
   * wet-look envMap PBR material (see `EnvironmentProbe`) without affecting other solids. */
  road: MeshGroup;
  /** Steady (non-flicker-animated) emissive blocks, e.g. WINDOW_LIT — kept separate from the
   * neon channels so M5 per-channel flicker/pulse animation never touches lit windows. */
  windowLit: MeshGroup;
  neon: [MeshGroup, MeshGroup, MeshGroup, MeshGroup];
}

/**
 * Routes a block's faces into the correct output group: neon-channel blocks
 * go to their own channel (animated per-frame in M5), other emissive blocks
 * (e.g. WINDOW_LIT) go to the steady windowLit group so they never get
 * swept up in neon flicker/pulse animation, road blocks go to the road
 * group (wet-look PBR material), and everything else is solid.
 */
function groupFor(
  def: ReturnType<typeof getBlock>,
  solid: MeshGroup,
  road: MeshGroup,
  windowLit: MeshGroup,
  neon: [MeshGroup, MeshGroup, MeshGroup, MeshGroup],
): MeshGroup {
  if (!def.emissive) return def.road ? road : solid;
  if (def.neonChannel !== undefined) return neon[def.neonChannel as NeonChannel];
  return windowLit;
}

function pushVertex(
  group: MeshGroup,
  x: number,
  y: number,
  z: number,
  normal: Vec3,
  r: number,
  g: number,
  b: number,
): void {
  group.positions.push(x, y, z);
  group.normals.push(normal[0], normal[1], normal[2]);
  group.colors.push(r, g, b);
}

/** Appends the 6 indices (2 triangles, `[0,1,2, 0,2,3]`) for the quad whose 4 vertices were just pushed starting at `firstVertexIndex`. */
function pushQuadIndices(group: MeshGroup, firstVertexIndex: number): void {
  group.indices.push(
    firstVertexIndex,
    firstVertexIndex + 1,
    firstVertexIndex + 2,
    firstVertexIndex,
    firstVertexIndex + 2,
    firstVertexIndex + 3,
  );
}

/**
 * Pure naive-culled mesh builder for one chunk: iterates every voxel in a
 * `ChunkSnapshot`, emits a quad per exposed face (neighbor non-opaque, via
 * the snapshot's padded opacity shell) with baked per-vertex AO and flat
 * directional shading. No `World`, no Three.js — this is the function a
 * mesher worker calls, and the sync fallback path calls it too, so their
 * output is identical by construction rather than by convention.
 */
export function buildChunkMeshDataFromSnapshot(snapshot: ChunkSnapshot, chunk: ChunkCoord): ChunkMeshData {
  const solid = emptyGroup();
  const road = emptyGroup();
  const windowLit = emptyGroup();
  const neon: [MeshGroup, MeshGroup, MeshGroup, MeshGroup] = [
    emptyGroup(),
    emptyGroup(),
    emptyGroup(),
    emptyGroup(),
  ];
  const { opaquePadded } = snapshot;
  const isOpaqueLocal = (lx: number, ly: number, lz: number): boolean =>
    opaquePadded[paddedIndex(lx, ly, lz)] === 1;

  for (let ly = 0; ly < CHUNK_SIZE; ly++) {
    for (let lz = 0; lz < CHUNK_SIZE; lz++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        const blockId = snapshot.voxels[localIndex(lx, ly, lz)] as number;
        if (blockId === AIR) continue;
        const def = getBlock(blockId);
        const { x, y, z } = chunkLocalToWorld(chunk, { lx, ly, lz });

        const group: MeshGroup = groupFor(def, solid, road, windowLit, neon);
        const tint = def.road ? roadTintFactor(x, y, z) : 1;
        const [r, g, b] = def.color;

        for (const face of FACES) {
          const nlx = lx + face.dir[0];
          const nly = ly + face.dir[1];
          const nlz = lz + face.dir[2];
          if (isOpaqueLocal(nlx, nly, nlz)) continue;

          const aoLevels = face.corners.map((corner) =>
            cornerAoLevel(opaquePadded, lx, ly, lz, face.dir, corner),
          );

          const positions = face.corners.map((corner) => [
            x + corner[0],
            y + corner[1],
            z + corner[2],
          ]);

          const shadeAt = (i: number): number => {
            const level = aoLevels[i] as number;
            const aoShade = AO_SHADE[level] as number;
            return face.shade * aoShade;
          };

          // 4 unique vertices for this quad (not shared with any other
          // face's vertices — AO/normal are baked per-face), indexed by the
          // 2 triangles (0,1,2) and (0,2,3) that make it up.
          const firstVertexIndex = group.positions.length / 3;
          for (let i = 0; i < 4; i++) {
            const shade = shadeAt(i) * tint;
            const pos = positions[i] as number[];
            pushVertex(group, pos[0] as number, pos[1] as number, pos[2] as number, face.normal, r * shade, g * shade, b * shade);
          }
          pushQuadIndices(group, firstVertexIndex);
        }
      }
    }
  }

  return { solid, road, windowLit, neon };
}

/**
 * Convenience wrapper for callers that still have a `World` handy (existing
 * tests, and the sync fallback scheduler): builds the snapshot, then
 * delegates to the pure, worker-portable `buildChunkMeshDataFromSnapshot`.
 */
export function buildChunkMeshData(world: World, chunk: ChunkCoord): ChunkMeshData {
  return buildChunkMeshDataFromSnapshot(buildChunkSnapshot(world, chunk), chunk);
}

/**
 * Largest vertex index a `Uint16Array` index buffer can address. A chunk is
 * 32^3 = 32,768 voxels; a single material group could in principle contain
 * *every* voxel in the chunk arranged so every face of every voxel is
 * exposed (a 3D-checkerboard "pathological" fill, where every solid voxel's
 * 6 neighbors are all air) — 32,768 voxels x 6 faces x 4 unique vertices =
 * 786,432 vertices for that one group, which overflows a `Uint16Array`
 * (max index 65,535) by more than 10x. That worst case is unlikely in a
 * real generated city but is a legitimate reachable state of this data
 * structure (nothing upstream rules it out), so the choice below is made
 * per-buffer from the group's *actual* vertex count rather than assumed:
 * `Uint16Array` (2 bytes/index) whenever the group's vertex count fits,
 * falling back to `Uint32Array` (4 bytes/index) only when it doesn't.
 * Picking Uint16 unconditionally would silently corrupt rendering on a
 * dense-enough chunk (indices wrapping mod 65,536); picking Uint32
 * unconditionally would give up half the index-buffer memory savings on
 * every ordinary chunk for a case that essentially never happens.
 */
const MAX_UINT16_VERTEX_COUNT = 65_536;

/** One mesh group's vertex attributes as typed arrays — the wire format sent back from a mesher worker via transferable `ArrayBuffer`s. */
export interface MeshBuffers {
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
  /** `Uint16Array` when the group's vertex count fits, `Uint32Array` otherwise — see `MAX_UINT16_VERTEX_COUNT`. */
  indices: Uint16Array | Uint32Array;
}

function groupToBuffers(group: MeshGroup): MeshBuffers | null {
  if (group.positions.length === 0) return null;
  const vertexCount = group.positions.length / 3;
  const indices =
    vertexCount <= MAX_UINT16_VERTEX_COUNT ? Uint16Array.from(group.indices) : Uint32Array.from(group.indices);
  return {
    positions: Float32Array.from(group.positions),
    normals: Float32Array.from(group.normals),
    colors: Float32Array.from(group.colors),
    indices,
  };
}

export interface ChunkMeshBuffers {
  solid: MeshBuffers | null;
  road: MeshBuffers | null;
  windowLit: MeshBuffers | null;
  neon: [MeshBuffers | null, MeshBuffers | null, MeshBuffers | null, MeshBuffers | null];
}

/** Converts pure mesh data (plain number arrays) into the typed-array wire format transferred between a mesher worker and the main thread. */
export function meshDataToBuffers(data: ChunkMeshData): ChunkMeshBuffers {
  return {
    solid: groupToBuffers(data.solid),
    road: groupToBuffers(data.road),
    windowLit: groupToBuffers(data.windowLit),
    neon: [
      groupToBuffers(data.neon[0]),
      groupToBuffers(data.neon[1]),
      groupToBuffers(data.neon[2]),
      groupToBuffers(data.neon[3]),
    ],
  };
}
