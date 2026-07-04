import * as THREE from 'three';
import { Engine } from './engine/Engine';
import { ChunkRenderer } from './engine/ChunkRenderer';
import { EntitySystem } from './entities/EntitySystem';
import { Atmosphere } from './engine/Atmosphere';
import { EnvironmentProbe } from './engine/EnvironmentProbe';
import { updateNeon, roadMaterial } from './engine/Materials';
import { PostFX } from './engine/PostFX';
import { Rain } from './engine/Rain';
import { ModeManager } from './player/ModeManager';
import { LookControls } from './player/LookControls';
import { aabbFromFeet, voxelIntersectsAabb } from './player/PlayerCollision';
import { raycastVoxels } from './player/VoxelRaycast';
import { GROUND_SURFACE_Y, generateCity } from './gen/CityGenerator';
import { findGroundSpawnPoint, findSpawnPoint } from './gen/layout';
import { SerializerError, importWorld, serializeWorld } from './io/Serializer';
import { AIR, ASPHALT } from './world/BlockRegistry';
import { CHUNK_SIZE, WORLD_SIZE_X, WORLD_SIZE_Y, WORLD_SIZE_Z } from './world/coords';
import { World } from './world/World';
import { ErrorToast } from './ui/ErrorToast';
import { FpsCounter } from './ui/FpsCounter';
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
const entitySystem = new EntitySystem(engine.scene);

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
const errorToast = new ErrorToast(uiRoot);
modeManager.onModeChange((mode) => hud.setMode(mode));

// Dev-only FPS readout, toggled with F3; never constructed in a production build.
const fpsCounter = import.meta.env.DEV ? new FpsCounter(uiRoot) : null;

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

/** The most recently generated/imported seed — shown in the toolbar and used as the export filename/meta. */
let currentSeed = DEFAULT_SEED;

function spawnAboveCity(seed: string): void {
  const layout = generateCity(world, seed).layout;
  const spawn = findSpawnPoint(layout);
  engine.camera.position.set(spawn.x + 0.5, SPAWN_HEIGHT_ABOVE_ROAD, spawn.z + 0.5);
  environmentProbePosition.set(layout.gridSizeX / 2, ENVIRONMENT_PROBE_HEIGHT, layout.gridSizeZ / 2);
}

async function runGeneration(seed: string): Promise<void> {
  overlay.classList.add('visible');
  await nextPaintedFrame();
  currentSeed = seed;
  spawnAboveCity(seed);
  chunkRenderer.rebuildAllDirty();
  entitySystem.rebuild(world, GROUND_SURFACE_Y, seed);
  refreshEnvironmentProbe();
  // Land the player on the street in play mode rather than leaving them
  // floating in sandbox fly — the camera is already sitting above the
  // generated spawn point, so this drops straight onto it.
  modeManager.enterPlayMode();
  overlay.classList.remove('visible');
}

// ---------------------------------------------------------------------------
// Export/import (.vxc): DOM glue only — actual encode/decode/apply lives in
// io/Serializer.ts, which stays free of DOM and Three.js dependencies.
// ---------------------------------------------------------------------------

function exportCity(): void {
  const buffer = serializeWorld(world, {
    seed: currentSeed,
    timeOfDay: atmosphere.currentTimeOfDay,
    bounds: { x: WORLD_SIZE_X, y: WORLD_SIZE_Y, z: WORLD_SIZE_Z },
    chunkSize: CHUNK_SIZE,
  });
  const blob = new Blob([buffer], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `city-${currentSeed}.vxc`;
  link.click();
  URL.revokeObjectURL(url);
}

/**
 * `generateCity`'s spawn placement uses `findSpawnPoint(layout)`, but an
 * imported city has no `CityLayout` (it's a 2D planning artifact that's
 * never serialized) — only voxel data. This is the layout-free fallback:
 * probe `World.getBlock` for a road-surface block at ground level instead of
 * consulting a layout's road cells. Same spiral-outward search either way.
 */
function spawnAboveImportedCity(): void {
  const spawn = findGroundSpawnPoint(
    (x, z) => world.getBlock(x, GROUND_SURFACE_Y, z) === ASPHALT,
    WORLD_SIZE_X,
    WORLD_SIZE_Z,
  );
  engine.camera.position.set(spawn.x + 0.5, SPAWN_HEIGHT_ABOVE_ROAD, spawn.z + 0.5);
  environmentProbePosition.set(WORLD_SIZE_X / 2, ENVIRONMENT_PROBE_HEIGHT, WORLD_SIZE_Z / 2);
}

async function importCity(file: File): Promise<void> {
  overlay.classList.add('visible');
  await nextPaintedFrame();
  try {
    const buffer = await file.arrayBuffer();
    const meta = importWorld(world, buffer);
    currentSeed = meta.seed;
    toolbar.setSeed(currentSeed);
    // meta.timeOfDay comes from parsed-but-unvalidated JSON; a NaN/Infinity
    // here would poison Atmosphere.setTimeOfDay's modulo forever.
    if (Number.isFinite(meta.timeOfDay)) {
      atmosphere.setTimeOfDay(meta.timeOfDay);
    }
    spawnAboveImportedCity();
    chunkRenderer.rebuildAllDirty();
    entitySystem.rebuild(world, GROUND_SURFACE_Y, meta.seed);
    refreshEnvironmentProbe();
    // Same rationale as runGeneration: drop the player onto the street
    // (layout-free ASPHALT spawn) in play mode instead of sandbox fly.
    modeManager.enterPlayMode();
  } catch (error) {
    const message =
      error instanceof SerializerError ? error.message : 'Failed to import .vxc file: not a valid city save.';
    errorToast.show(message);
  } finally {
    overlay.classList.remove('visible');
  }
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
toolbar.onExportRequest(() => exportCity());
toolbar.onImportRequest((file) => {
  void importCity(file);
});

void runGeneration(DEFAULT_SEED);

let elapsedTime = 0;

engine.start({
  update: (dt) => {
    elapsedTime += dt;
    modeManager.update(dt);
    atmosphere.update(dt);
    rain.update(dt, engine.camera.position, atmosphere.nightFactor);
    entitySystem.update(dt, engine.camera.position.x, engine.camera.position.z);
  },
  render: () => {
    // Chunk rebuilds are budgeted per animation frame (not per fixed tick):
    // after a stall the accumulator can replay update() many times in one
    // frame, and running the rebuild budget there would blow past the
    // intended ~4-chunks/frame cap right when the machine is already behind.
    chunkRenderer.update();
    updateNeon(elapsedTime);
    entitySystem.render();

    const hit = currentHit();
    if (hit) {
      highlightBox.position.set(hit.pos[0] + 0.5, hit.pos[1] + 0.5, hit.pos[2] + 0.5);
      highlightBox.visible = true;
    } else {
      highlightBox.visible = false;
    }

    fpsCounter?.tick();
  },
});

void lookControls;
