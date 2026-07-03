import { describe, expect, it } from 'vitest';
import { buildChunkMeshData } from '../src/engine/ChunkMesher';
import { ASPHALT, CONCRETE, NEON_CYAN, NEON_PINK, WINDOW_LIT } from '../src/world/BlockRegistry';
import { World } from '../src/world/World';

const ORIGIN_CHUNK = { cx: 0, cy: 0, cz: 0 };

/** Vertex count for a mesh group: 6 vertices per exposed quad face (2 non-indexed triangles). */
function vertexCount(group: { positions: number[] }): number {
  return group.positions.length / 3;
}

function faceCount(group: { positions: number[] }): number {
  return vertexCount(group) / 6;
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
    // voxels' top faces).
    const topFaceFirstVertex = 2 * 6;
    const firstVoxelRed = data.road.colors[topFaceFirstVertex * 3];
    const secondVoxelRed = data.road.colors[(6 * 6 + topFaceFirstVertex) * 3];
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

    // FACES order is +X, -X, +Y, -Y, +Z, -Z, 6 vertices (2 tris) per face;
    // the +Y (top) face is therefore the 3rd block of 6 vertices.
    const topFaceFirstVertex = 2 * 6;
    // Within a face's 6-vertex block the triangulation order is corner0,
    // corner1, corner2, corner0, corner2, corner3 -- corner0 is the occluded
    // corner (0,1,0) -> world (10,11,10); corner2 is the opposite, unoccluded
    // corner (1,1,1) -> world (11,11,11).
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
