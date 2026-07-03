import * as THREE from 'three';
import { Engine } from './engine/Engine';
import { ChunkRenderer } from './engine/ChunkRenderer';
import { FlyController } from './player/FlyController';
import { LookControls } from './player/LookControls';
import {
  ASPHALT,
  CONCRETE,
  METAL,
  NEON_CYAN,
  NEON_PINK,
  SIDEWALK,
  WINDOW_LIT,
} from './world/BlockRegistry';
import { World } from './world/World';

const canvas = document.getElementById('app') as HTMLCanvasElement;
const engine = new Engine(canvas);

engine.camera.position.set(64, 20, 80);

const world = new World();
const chunkRenderer = new ChunkRenderer(world, engine.scene);

// Basic placeholder lighting; Atmosphere.ts (fog/sky/day-night) lands in M5.
const hemiLight = new THREE.HemisphereLight(0x6a7fd6, 0x1a1420, 0.9);
engine.scene.add(hemiLight);
const sunLight = new THREE.DirectionalLight(0xfff2d8, 0.6);
sunLight.position.set(120, 150, 80);
engine.scene.add(sunLight);

const lookControls = new LookControls(engine.camera, canvas);
const flyController = new FlyController(engine.camera);
void lookControls;

// ---------------------------------------------------------------------------
// TEMP TEST TERRAIN — remove in M4 once real procgen (gen/CityGenerator.ts)
// exists. Only here to visually verify meshing, AO, colors, chunk borders.
// ---------------------------------------------------------------------------
function buildTestTerrain(): void {
  const GROUND_ORIGIN_X = 32;
  const GROUND_ORIGIN_Z = 32;
  const GROUND_SIZE = 128;

  // Flat ground: checker of SIDEWALK / ASPHALT across two chunk rows (y=0..1).
  for (let x = 0; x < GROUND_SIZE; x++) {
    for (let z = 0; z < GROUND_SIZE; z++) {
      const worldX = GROUND_ORIGIN_X + x;
      const worldZ = GROUND_ORIGIN_Z + z;
      const isRoadLane = z % 16 < 6;
      const surface = isRoadLane ? ASPHALT : SIDEWALK;
      world.setBlockRaw(worldX, 0, worldZ, CONCRETE);
      world.setBlockRaw(worldX, 1, worldZ, surface);
    }
  }

  // Small concrete test building with a lit-window pattern on its south face.
  const buildingX = GROUND_ORIGIN_X + 20;
  const buildingZ = GROUND_ORIGIN_Z + 20;
  const buildingWidth = 8;
  const buildingDepth = 8;
  const buildingHeight = 14;
  for (let x = 0; x < buildingWidth; x++) {
    for (let z = 0; z < buildingDepth; z++) {
      for (let y = 2; y < 2 + buildingHeight; y++) {
        const isShell = x === 0 || x === buildingWidth - 1 || z === 0 || z === buildingDepth - 1;
        if (!isShell) continue;
        const isSouthFace = z === 0;
        const isWindowSpot =
          isSouthFace && x % 2 === 1 && (y - 2) % 2 === 1 && (x + y) % 3 !== 0;
        const block = isWindowSpot ? WINDOW_LIT : CONCRETE;
        world.setBlockRaw(buildingX + x, y, buildingZ + z, block);
      }
    }
  }

  // Neon sign strip on the building's east flank.
  const neonX = buildingX + buildingWidth;
  const neonBaseY = 4;
  for (let i = 0; i < 6; i++) {
    world.setBlockRaw(neonX, neonBaseY + i, buildingZ + 2, i % 2 === 0 ? NEON_PINK : NEON_CYAN);
  }

  // Staircase of full blocks to eyeball AO + culling on a non-flat surface.
  const stairX = GROUND_ORIGIN_X + 40;
  const stairZBase = GROUND_ORIGIN_Z + 10;
  const stairSteps = 10;
  for (let step = 0; step < stairSteps; step++) {
    for (let h = 0; h <= step; h++) {
      for (let w = 0; w < 4; w++) {
        world.setBlockRaw(stairX + w, 2 + h, stairZBase + step, METAL);
      }
    }
  }

  world.remeshAll();
}

buildTestTerrain();

engine.start({
  update: (dt) => {
    flyController.update(dt);
  },
  render: () => {
    // Chunk rebuilds are budgeted per animation frame (not per fixed tick):
    // after a stall the accumulator can replay update() many times in one
    // frame, and running the rebuild budget there would blow past the
    // intended ~4-chunks/frame cap right when the machine is already behind.
    chunkRenderer.update();
  },
});
