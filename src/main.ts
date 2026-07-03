import * as THREE from 'three';
import { Engine } from './engine/Engine';
import { ChunkRenderer } from './engine/ChunkRenderer';
import { ModeManager } from './player/ModeManager';
import { LookControls } from './player/LookControls';
import { aabbFromFeet, voxelIntersectsAabb } from './player/PlayerCollision';
import { raycastVoxels } from './player/VoxelRaycast';
import {
  AIR,
  ASPHALT,
  CONCRETE,
  METAL,
  NEON_CYAN,
  NEON_PINK,
  SIDEWALK,
  WINDOW_LIT,
} from './world/BlockRegistry';
import { World } from './world/World';
import { Hud } from './ui/Hud';
import { Palette } from './ui/Palette';
import './ui/ui.css';

const canvas = document.getElementById('app') as HTMLCanvasElement;
const uiRoot = document.getElementById('ui-root') as HTMLElement;
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
const modeManager = new ModeManager(engine.camera, world);

const hud = new Hud(uiRoot);
const palette = new Palette(uiRoot, canvas);
modeManager.onModeChange((mode) => hud.setMode(mode));

canvas.addEventListener('contextmenu', (event) => event.preventDefault());

// ---------------------------------------------------------------------------
// Target-block highlight: a thin edge box snapped to whatever voxel the
// crosshair is currently over, hidden when nothing is in reach.
// ---------------------------------------------------------------------------
const highlightGeometry = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1));
const highlightMaterial = new THREE.LineBasicMaterial({ color: 0xffffff, toneMapped: false });
const highlightBox = new THREE.LineSegments(highlightGeometry, highlightMaterial);
highlightBox.visible = false;
engine.scene.add(highlightBox);

const rayOrigin = new THREE.Vector3();
const rayDirection = new THREE.Vector3();

function currentHit() {
  engine.camera.getWorldPosition(rayOrigin);
  engine.camera.getWorldDirection(rayDirection);
  return raycastVoxels({
    origin: [rayOrigin.x, rayOrigin.y, rayOrigin.z],
    direction: [rayDirection.x, rayDirection.y, rayDirection.z],
    maxDistance: modeManager.reach,
    isSolid: (x, y, z) => world.isSolid(x, y, z),
  });
}

canvas.addEventListener('mousedown', (event) => {
  if (document.pointerLockElement !== canvas) return;

  const hit = currentHit();
  if (!hit) return;

  if (event.button === 0) {
    // Left click: remove the targeted voxel.
    world.setBlock(hit.pos[0], hit.pos[1], hit.pos[2], AIR);
  } else if (event.button === 2) {
    // Right click: place the selected block on the face the ray entered through.
    const placeX = hit.pos[0] + hit.normal[0];
    const placeY = hit.pos[1] + hit.normal[1];
    const placeZ = hit.pos[2] + hit.normal[2];

    if (modeManager.currentMode === 'play') {
      const playerBox = aabbFromFeet(modeManager.playerFeet);
      if (voxelIntersectsAabb([placeX, placeY, placeZ], playerBox)) return;
    }

    world.setBlock(placeX, placeY, placeZ, palette.selectedBlockId);
  }
});

// ---------------------------------------------------------------------------
// TEMP TEST TERRAIN — remove in M4 once real procgen (gen/CityGenerator.ts)
// exists. Only here to visually verify meshing, AO, colors, chunk borders,
// and (M2/M3) editing + collision against hand-built geometry.
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

  // Staircase of full blocks — collision test bed for M3 auto-step.
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
    modeManager.update(dt);
  },
  render: () => {
    // Chunk rebuilds are budgeted per animation frame (not per fixed tick):
    // after a stall the accumulator can replay update() many times in one
    // frame, and running the rebuild budget there would blow past the
    // intended ~4-chunks/frame cap right when the machine is already behind.
    chunkRenderer.update();

    const hit = currentHit();
    if (hit) {
      highlightBox.position.set(hit.pos[0] + 0.5, hit.pos[1] + 0.5, hit.pos[2] + 0.5);
      highlightBox.visible = true;
    } else {
      highlightBox.visible = false;
    }
  },
});

void lookControls;
