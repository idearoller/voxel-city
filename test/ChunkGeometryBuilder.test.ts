import { describe, expect, it } from 'vitest';
import { CONCRETE } from '../src/world/BlockRegistry';
import { World } from '../src/world/World';
import { meshChunk } from '../src/engine/ChunkGeometryBuilder';

// Guards the geometry-level index wiring: the mesher emits 4 vertices + 6
// indices per face, so a BufferGeometry built without setIndex would draw
// those 4-vertex runs as garbage triangles while every buffer-level test
// (which de-indexes MeshBuffers directly) stayed green. This is the only
// test that would fail if buffersToGeometry dropped its setIndex call.
describe('ChunkGeometryBuilder indexed geometry', () => {
  it('produces indexed BufferGeometries with 6 indices per face over 4-vertex quads', () => {
    const world = new World();
    world.setBlockRaw(4, 4, 4, CONCRETE); // isolated voxel: 6 faces

    const geometries = meshChunk(world, { cx: 0, cy: 0, cz: 0 });
    const solid = geometries.solid;
    expect(solid).not.toBeNull();

    const index = solid!.getIndex();
    expect(index).not.toBeNull();
    expect(index!.itemSize).toBe(1);
    // 6 faces x 4 unique vertices; 6 faces x 6 indices = 12 triangles.
    expect(solid!.getAttribute('position').count).toBe(24);
    expect(index!.count).toBe(36);
    // Every index must resolve to a real vertex — an unindexed draw of this
    // layout would read past the 4-vertex quads instead.
    for (let i = 0; i < index!.count; i++) {
      expect(index!.getX(i)).toBeLessThan(24);
    }
  });
});
