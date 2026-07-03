import * as THREE from 'three';
import { getBlock, type NeonChannel } from '../world/BlockRegistry';
import { CHUNK_SIZE, chunkLocalToWorld, type ChunkCoord } from '../world/coords';
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
 * Classic 3-neighbor-occluder baked AO for one quad corner.
 * Returns a level in [0, 3] where 3 = fully lit, 0 = fully occluded.
 */
function cornerAoLevel(
  world: World,
  x: number,
  y: number,
  z: number,
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

  const s1x = x + dir[0] + uUnit[0] * uSign;
  const s1y = y + dir[1] + uUnit[1] * uSign;
  const s1z = z + dir[2] + uUnit[2] * uSign;

  const s2x = x + dir[0] + vUnit[0] * vSign;
  const s2y = y + dir[1] + vUnit[1] * vSign;
  const s2z = z + dir[2] + vUnit[2] * vSign;

  const cx = x + dir[0] + uUnit[0] * uSign + vUnit[0] * vSign;
  const cy = y + dir[1] + uUnit[1] * uSign + vUnit[1] * vSign;
  const cz = z + dir[2] + uUnit[2] * uSign + vUnit[2] * vSign;

  const side1 = world.isOpaque(s1x, s1y, s1z) ? 1 : 0;
  const side2 = world.isOpaque(s2x, s2y, s2z) ? 1 : 0;
  const cornerOccluder = world.isOpaque(cx, cy, cz) ? 1 : 0;

  if (side1 && side2) return 0;
  return 3 - (side1 + side2 + cornerOccluder);
}

export interface MeshGroup {
  positions: number[];
  normals: number[];
  colors: number[];
}

function emptyGroup(): MeshGroup {
  return { positions: [], normals: [], colors: [] };
}

export interface ChunkMeshData {
  solid: MeshGroup;
  /** Steady (non-flicker-animated) emissive blocks, e.g. WINDOW_LIT — kept separate from the
   * neon channels so M5 per-channel flicker/pulse animation never touches lit windows. */
  windowLit: MeshGroup;
  neon: [MeshGroup, MeshGroup, MeshGroup, MeshGroup];
}

/**
 * Routes a block's faces into the correct output group: neon-channel blocks
 * go to their own channel (animated per-frame in M5), other emissive blocks
 * (e.g. WINDOW_LIT) go to the steady windowLit group so they never get
 * swept up in neon flicker/pulse animation, and everything else is solid.
 */
function groupFor(
  def: ReturnType<typeof getBlock>,
  solid: MeshGroup,
  windowLit: MeshGroup,
  neon: [MeshGroup, MeshGroup, MeshGroup, MeshGroup],
): MeshGroup {
  if (!def.emissive) return solid;
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

/**
 * Pure naive-culled mesh builder for one chunk: iterates every voxel, emits
 * a quad per exposed face (neighbor non-opaque, checked across chunk
 * boundaries via World.getBlock), with baked per-vertex AO and flat
 * directional shading. No Three.js types in the data it produces.
 */
export function buildChunkMeshData(world: World, chunk: ChunkCoord): ChunkMeshData {
  const solid = emptyGroup();
  const windowLit = emptyGroup();
  const neon: [MeshGroup, MeshGroup, MeshGroup, MeshGroup] = [
    emptyGroup(),
    emptyGroup(),
    emptyGroup(),
    emptyGroup(),
  ];

  for (let ly = 0; ly < CHUNK_SIZE; ly++) {
    for (let lz = 0; lz < CHUNK_SIZE; lz++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        const { x, y, z } = chunkLocalToWorld(chunk, { lx, ly, lz });
        const blockId = world.getBlock(x, y, z);
        if (blockId === 0) continue;
        const def = getBlock(blockId);

        const group: MeshGroup = groupFor(def, solid, windowLit, neon);
        const [r, g, b] = def.color;

        for (const face of FACES) {
          const nx = x + face.dir[0];
          const ny = y + face.dir[1];
          const nz = z + face.dir[2];
          if (world.isOpaque(nx, ny, nz)) continue;

          const aoLevels = face.corners.map((corner) =>
            cornerAoLevel(world, x, y, z, face.dir, corner),
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

          const emit = (i: number): void => {
            const shade = shadeAt(i);
            const pos = positions[i] as number[];
            pushVertex(group, pos[0] as number, pos[1] as number, pos[2] as number, face.normal, r * shade, g * shade, b * shade);
          };

          // Two triangles: (0,1,2) and (0,2,3).
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

  return { solid, windowLit, neon };
}

function groupToGeometry(group: MeshGroup): THREE.BufferGeometry | null {
  if (group.positions.length === 0) return null;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(group.positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(group.normals, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(group.colors, 3));
  return geometry;
}

export interface ChunkGeometries {
  solid: THREE.BufferGeometry | null;
  windowLit: THREE.BufferGeometry | null;
  neon: [
    THREE.BufferGeometry | null,
    THREE.BufferGeometry | null,
    THREE.BufferGeometry | null,
    THREE.BufferGeometry | null,
  ];
}

/** Builds real Three.js BufferGeometries for one chunk. The only world -> render bridge. */
export function meshChunk(world: World, chunk: ChunkCoord): ChunkGeometries {
  const data = buildChunkMeshData(world, chunk);
  return {
    solid: groupToGeometry(data.solid),
    windowLit: groupToGeometry(data.windowLit),
    neon: [
      groupToGeometry(data.neon[0]),
      groupToGeometry(data.neon[1]),
      groupToGeometry(data.neon[2]),
      groupToGeometry(data.neon[3]),
    ],
  };
}
