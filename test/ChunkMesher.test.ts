import { describe, expect, it } from 'vitest';
import {
  buildChunkMeshData,
  buildChunkMeshDataFromSnapshot,
  meshDataToBuffers,
  paddedIndex,
  CHUNK_PAD,
  type ChunkSnapshot,
} from '../src/engine/ChunkMesher';
import { ASPHALT, CONCRETE, NEON_CYAN, NEON_PINK, WINDOW_LIT } from '../src/world/BlockRegistry';
import { CHUNK_SIZE, CHUNK_VOXEL_COUNT, localIndex } from '../src/world/coords';
import { World } from '../src/world/World';

const ORIGIN_CHUNK = { cx: 0, cy: 0, cz: 0 };

/** Vertex count for a mesh group: 4 unique vertices per exposed quad face (indexed). */
function vertexCount(group: { positions: number[] }): number {
  return group.positions.length / 3;
}

/** Face count from the index buffer: 6 indices (2 triangles) per exposed quad face. */
function faceCount(group: { indices: number[] }): number {
  return group.indices.length / 6;
}

describe('buildChunkMeshData face culling', () => {
  it('produces no geometry for an empty (all-air) chunk', () => {
    const world = new World();
    const data = buildChunkMeshData(world, ORIGIN_CHUNK);
    expect(vertexCount(data.solid)).toBe(0);
    for (const neonGroup of data.neon) {
      expect(vertexCount(neonGroup)).toBe(0);
    }
  });

  it('emits 6 faces for a single isolated solid voxel', () => {
    const world = new World();
    world.setBlock(5, 5, 5, CONCRETE);

    const data = buildChunkMeshData(world, ORIGIN_CHUNK);

    expect(faceCount(data.solid)).toBe(6);
  });

  it('emits 10 faces for two adjacent solid voxels (the shared face is culled on both sides)', () => {
    const world = new World();
    world.setBlock(5, 5, 5, CONCRETE);
    world.setBlock(6, 5, 5, CONCRETE);

    const data = buildChunkMeshData(world, ORIGIN_CHUNK);

    expect(faceCount(data.solid)).toBe(10);
  });

  it('emits only the outer surface faces for a fully filled 3x3x3 cube', () => {
    const world = new World();
    for (let x = 0; x < 3; x++) {
      for (let y = 0; y < 3; y++) {
        for (let z = 0; z < 3; z++) {
          world.setBlock(x, y, z, CONCRETE);
        }
      }
    }

    const data = buildChunkMeshData(world, ORIGIN_CHUNK);

    // A filled NxNxN cube exposes 6*N^2 outer faces; all internal faces are culled.
    expect(faceCount(data.solid)).toBe(6 * 3 * 3);
  });

  it('routes emissive neon blocks into their channel group, not the solid group', () => {
    const world = new World();
    world.setBlock(2, 2, 2, NEON_CYAN);

    const data = buildChunkMeshData(world, ORIGIN_CHUNK);

    expect(vertexCount(data.solid)).toBe(0);
    expect(faceCount(data.neon[1])).toBe(6); // NEON_CYAN = channel 1
    expect(faceCount(data.neon[0])).toBe(0);
  });

  it('routes WINDOW_LIT into its own steady group, not a shared neon channel', () => {
    const world = new World();
    world.setBlock(2, 2, 2, WINDOW_LIT);
    world.setBlock(10, 10, 10, NEON_PINK); // NEON_PINK is also channel 0

    const data = buildChunkMeshData(world, ORIGIN_CHUNK);

    expect(faceCount(data.windowLit)).toBe(6);
    // Only NEON_PINK's faces should land in channel 0 -- WINDOW_LIT must not mix in.
    expect(faceCount(data.neon[0])).toBe(6);
    expect(vertexCount(data.solid)).toBe(0);
  });

  it('routes ASPHALT into the road group, not solid, and gives adjacent road voxels distinct color variation', () => {
    const world = new World();
    world.setBlock(2, 2, 2, ASPHALT);
    world.setBlock(4, 2, 2, ASPHALT);

    const data = buildChunkMeshData(world, ORIGIN_CHUNK);

    expect(vertexCount(data.solid)).toBe(0);
    expect(faceCount(data.road)).toBe(12); // 6 faces each, both isolated

    // Wet-mottled variation: two different world positions should not get
    // the exact same darkening tint (top-face red channel is a stand-in for
    // "the baked color", since AO/shade are identical for both isolated
    // voxels' top faces). 4 unique vertices per face, 6 faces per voxel.
    const topFaceFirstVertex = 2 * 4;
    const firstVoxelRed = data.road.colors[topFaceFirstVertex * 3];
    const secondVoxelRed = data.road.colors[(6 * 4 + topFaceFirstVertex) * 3];
    expect(firstVoxelRed).not.toBe(secondVoxelRed);
  });

  it('culls the shared face across a chunk border (voxels at local x=31 and x=32)', () => {
    const world = new World();
    // World x=31 is local x=31 in chunk cx=0; world x=32 is local x=0 in chunk cx=1.
    world.setBlock(31, 5, 5, CONCRETE);
    world.setBlock(32, 5, 5, CONCRETE);

    const chunk0Data = buildChunkMeshData(world, { cx: 0, cy: 0, cz: 0 });
    const chunk1Data = buildChunkMeshData(world, { cx: 1, cy: 0, cz: 0 });

    expect(faceCount(chunk0Data.solid)).toBe(5);
    expect(faceCount(chunk1Data.solid)).toBe(5);
  });
});

describe('buildChunkMeshData baked AO', () => {
  it('shades an AO-occluded top-face corner darker than an unoccluded one', () => {
    const world = new World();
    world.setBlock(10, 10, 10, CONCRETE);
    // Sits beside the (10,11,10) top-face corner at the same height, occluding it
    // without culling the top face itself (nothing directly above the voxel).
    world.setBlock(9, 11, 10, CONCRETE);

    const data = buildChunkMeshData(world, ORIGIN_CHUNK);

    // FACES order is +X, -X, +Y, -Y, +Z, -Z, 4 unique vertices per face
    // (indexed); the +Y (top) face is therefore the 3rd block of 4 vertices.
    const topFaceFirstVertex = 2 * 4;
    // Within a face's 4-vertex block the vertex order is corner0, corner1,
    // corner2, corner3 -- corner0 is the occluded corner (0,1,0) -> world
    // (10,11,10); corner2 is the opposite, unoccluded corner (1,1,1) ->
    // world (11,11,11).
    const occludedVertexIndex = topFaceFirstVertex + 0;
    const unoccludedVertexIndex = topFaceFirstVertex + 2;

    const colorAt = (vertexIndex: number): number => {
      const r = data.solid.colors[vertexIndex * 3];
      if (r === undefined) throw new Error(`no color at vertex ${vertexIndex}`);
      return r;
    };

    expect(colorAt(occludedVertexIndex)).toBeLessThan(colorAt(unoccludedVertexIndex));
  });
});

describe('buildChunkMeshData indexed geometry', () => {
  it('emits exactly 4 unique vertices and 6 indices ([0,1,2,0,2,3] per-face) for a single isolated voxel', () => {
    const world = new World();
    world.setBlock(5, 5, 5, CONCRETE);

    const data = buildChunkMeshData(world, ORIGIN_CHUNK);

    expect(vertexCount(data.solid)).toBe(6 * 4); // 6 faces x 4 unique verts, no cross-face sharing
    expect(data.solid.indices).toHaveLength(6 * 6); // 6 faces x 6 indices
    // Every face's 6 indices are relative to its own 4-vertex block:
    // [0,1,2,0,2,3] offset by faceIndex*4.
    for (let face = 0; face < 6; face++) {
      const base = face * 4;
      expect(data.solid.indices.slice(face * 6, face * 6 + 6)).toEqual([
        base,
        base + 1,
        base + 2,
        base,
        base + 2,
        base + 3,
      ]);
    }
  });

  it('never reuses a vertex across two different faces', () => {
    // A 2x2x2 filled cube: every exposed face is adjacent to another
    // exposed face at a shared edge, the case cross-face welding would
    // target. Assert vertex count still equals 4 per exposed face (24
    // faces here -- outer surface of a 2x2x2 cube is 6*2*2=24), i.e. no
    // welding happened.
    const world = new World();
    for (let x = 0; x < 2; x++) {
      for (let y = 0; y < 2; y++) {
        for (let z = 0; z < 2; z++) {
          world.setBlock(x, y, z, CONCRETE);
        }
      }
    }

    const data = buildChunkMeshData(world, ORIGIN_CHUNK);

    expect(faceCount(data.solid)).toBe(24);
    expect(vertexCount(data.solid)).toBe(24 * 4);
  });
});

describe('index buffer type selection (Uint16 vs Uint32 cutover)', () => {
  /**
   * Builds a snapshot with `CONCRETE` at every voxel matching a 3D
   * checkerboard parity: within the chunk, every solid voxel's 6
   * axis-neighbors have the opposite parity, so (with an all-air border)
   * every solid voxel exposes all 6 faces. That's the pathological case
   * called out in `MAX_UINT16_VERTEX_COUNT`'s doc comment -- half the
   * chunk's voxels (16,384) x 6 faces x 4 verts = 393,216 vertices in one
   * group, comfortably past the 65,536 Uint16 ceiling.
   */
  function checkerboardSnapshot(): ChunkSnapshot {
    const voxels = new Uint8Array(CHUNK_VOXEL_COUNT);
    const opaquePadded = new Uint8Array(CHUNK_PAD * CHUNK_PAD * CHUNK_PAD);
    for (let ly = 0; ly < CHUNK_SIZE; ly++) {
      for (let lz = 0; lz < CHUNK_SIZE; lz++) {
        for (let lx = 0; lx < CHUNK_SIZE; lx++) {
          if ((lx + ly + lz) % 2 === 0) {
            voxels[localIndex(lx, ly, lz)] = CONCRETE;
            opaquePadded[paddedIndex(lx, ly, lz)] = 1;
          }
        }
      }
    }
    return { voxels, opaquePadded };
  }

  it('picks Uint32Array when a group\'s vertex count exceeds the Uint16 ceiling', () => {
    const snapshot = checkerboardSnapshot();
    const data = buildChunkMeshDataFromSnapshot(snapshot, ORIGIN_CHUNK);
    expect(vertexCount(data.solid)).toBeGreaterThan(65_536);

    const buffers = meshDataToBuffers(data);

    expect(buffers.solid?.indices).toBeInstanceOf(Uint32Array);
    // Correctness, not just type: every index must still resolve to a real
    // vertex. Reduced rather than spread into Math.max -- this buffer has
    // hundreds of thousands of entries, well past the call-stack limit for
    // a spread argument list.
    const indices = buffers.solid?.indices as Uint32Array;
    let maxIndex = 0;
    for (const index of indices) maxIndex = Math.max(maxIndex, index);
    expect(maxIndex).toBe(vertexCount(data.solid) - 1);
  });

  it('picks Uint16Array for an ordinary, well-under-the-ceiling group', () => {
    const world = new World();
    world.setBlock(5, 5, 5, CONCRETE);
    const data = buildChunkMeshData(world, ORIGIN_CHUNK);

    const buffers = meshDataToBuffers(data);

    expect(buffers.solid?.indices).toBeInstanceOf(Uint16Array);
  });
});
