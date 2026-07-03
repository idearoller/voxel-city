import * as THREE from 'three';
import { Engine } from './engine/Engine';
import { ChunkRenderer } from './engine/ChunkRenderer';
import { Atmosphere } from './engine/Atmosphere';
import { EnvironmentProbe } from './engine/EnvironmentProbe';
import { updateNeon, roadMaterial } from './engine/Materials';
import { PostFX } from './engine/PostFX';
import { Rain } from './engine/Rain';
import { ModeManager } from './player/ModeManager';
import { LookControls } from './player/LookControls';
import { aabbFromFeet, voxelIntersectsAabb } from './player/PlayerCollision';
import { raycastVoxels } from './player/VoxelRaycast';
import { generateCity } from './gen/CityGenerator';
import { findSpawnPoint } from './gen/layout';
import { AIR } from './world/BlockRegistry';
import { WORLD_SIZE_X, WORLD_SIZE_Z } from './world/coords';
import { World } from './world/World';
import { Hud } from './ui/Hud';
import { Palette } from './ui/Palette';
import { Toolbar } from './ui/Toolbar';
import './ui/ui.css';

const DEFAULT_SEED = 'night-city-01';
const SPAWN_HEIGHT_ABOVE_ROAD = 6;
const ENVIRONMENT_PROBE_HEIGHT = 25;
/** Re-render the wet-street cubemap after this many edits even if the debounce timer hasn't fired. */
const ENVIRONMENT_REFRESH_EDIT_COUNT = 20;
const ENVIRONMENT_REFRESH_DEBOUNCE_MS = 3000;

const canvas = document.getElementById('app') as HTMLCanvasElement;
const uiRoot = document.getElementById('ui-root') as HTMLElement;
const engine = new Engine(canvas);

const world = new World();
const chunkRenderer = new ChunkRenderer(world, engine.scene);

const atmosphere = new Atmosphere(engine.scene);
const rain = new Rain(engine.scene);
const postFX = new PostFX(engine.renderer, engine.scene, engine.camera);
engine.setComposer(postFX);
atmosphere.onBloomStrengthChange((strength) => postFX.setBloomStrength(strength));

const environmentProbe = new EnvironmentProbe(engine.renderer);
// Defaults to the world's geometric center; `spawnAboveCity` overwrites this
// with the actual city center (from the generated layout) after each run.
const environmentProbePosition = new THREE.Vector3(
  WORLD_SIZE_X / 2,
  ENVIRONMENT_PROBE_HEIGHT,
  WORLD_SIZE_Z / 2,
);
let editsSinceEnvironmentRefresh = 0;
let environmentRefreshTimeout: ReturnType<typeof setTimeout> | undefined;

function refreshEnvironmentProbe(): void {
  editsSinceEnvironmentRefresh = 0;
  if (environmentRefreshTimeout !== undefined) {
    clearTimeout(environmentRefreshTimeout);
    environmentRefreshTimeout = undefined;
  }
  environmentProbe.refresh(engine.scene, environmentProbePosition, roadMaterial);
}

function scheduleEnvironmentRefresh(): void {
  editsSinceEnvironmentRefresh++;
  if (editsSinceEnvironmentRefresh >= ENVIRONMENT_REFRESH_EDIT_COUNT) {
    refreshEnvironmentProbe();
    return;
  }
  if (environmentRefreshTimeout !== undefined) clearTimeout(environmentRefreshTimeout);
  environmentRefreshTimeout = setTimeout(refreshEnvironmentProbe, ENVIRONMENT_REFRESH_DEBOUNCE_MS);
}

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
    scheduleEnvironmentRefresh();
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
    scheduleEnvironmentRefresh();
  }
});

// ---------------------------------------------------------------------------
// Procedural city generation: seed UI (Toolbar) + a loading overlay, since
// generateCity() (plus the full mesh rebuild below) is synchronous and can
// take a noticeable moment on the full 384x384 plan. We show the overlay,
// yield two animation frames so the "visible" class actually gets painted
// before the heavy synchronous work blocks the main thread — a single rAF
// resolves as a microtask *before* the browser paints, so the overlay would
// never actually appear on screen — then generate, flush every resulting
// dirty chunk into meshes in one go (see ChunkRenderer.rebuildAllDirty), and
// only then drop the camera and hide the overlay. Without that flush,
// remeshAll() marks 300+ chunks dirty and the budgeted per-frame update()
// would dribble the city in chunk-by-chunk over dozens of frames on a now-
// hidden overlay.
// ---------------------------------------------------------------------------
const overlay = document.createElement('div');
overlay.className = 'gen-overlay';
const overlayText = document.createElement('div');
overlayText.className = 'gen-overlay-text';
overlayText.textContent = 'GENERATING SECTOR…';
overlay.appendChild(overlayText);
uiRoot.appendChild(overlay);

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

/** Waits for two animation frames, guaranteeing at least one real paint has happened in between. */
async function nextPaintedFrame(): Promise<void> {
  await nextFrame();
  await nextFrame();
}

function spawnAboveCity(seed: string): void {
  const layout = generateCity(world, seed).layout;
  const spawn = findSpawnPoint(layout);
  engine.camera.position.set(spawn.x + 0.5, SPAWN_HEIGHT_ABOVE_ROAD, spawn.z + 0.5);
  environmentProbePosition.set(layout.gridSizeX / 2, ENVIRONMENT_PROBE_HEIGHT, layout.gridSizeZ / 2);
}

async function runGeneration(seed: string): Promise<void> {
  overlay.classList.add('visible');
  await nextPaintedFrame();
  spawnAboveCity(seed);
  chunkRenderer.rebuildAllDirty();
  refreshEnvironmentProbe();
  overlay.classList.remove('visible');
}

const toolbar = new Toolbar(uiRoot, DEFAULT_SEED);
toolbar.onGenerateRequest((seed) => {
  void runGeneration(seed);
});
toolbar.onTogglePause(() => {
  atmosphere.togglePaused();
  toolbar.setPaused(atmosphere.isPaused);
});
toolbar.onToggleRain(() => {
  rain.toggle();
  toolbar.setRainEnabled(rain.enabled);
});

void runGeneration(DEFAULT_SEED);

let elapsedTime = 0;

engine.start({
  update: (dt) => {
    elapsedTime += dt;
    modeManager.update(dt);
    atmosphere.update(dt);
    rain.update(dt, engine.camera.position, atmosphere.nightFactor);
  },
  render: () => {
    // Chunk rebuilds are budgeted per animation frame (not per fixed tick):
    // after a stall the accumulator can replay update() many times in one
    // frame, and running the rebuild budget there would blow past the
    // intended ~4-chunks/frame cap right when the machine is already behind.
    chunkRenderer.update();
    updateNeon(elapsedTime);

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
