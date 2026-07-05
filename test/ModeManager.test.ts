import * as THREE from 'three';
import { beforeEach, describe, expect, it } from 'vitest';
import { ModeManager } from '../src/player/ModeManager';
import type { Mode } from '../src/player/ModeManager';
import { CONCRETE } from '../src/world/BlockRegistry';
import { World } from '../src/world/World';

/** A stationary camera positioned above a given xz column, looking down +X. */
function cameraAt(x: number, y: number, z: number): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(x, y, z);
  camera.lookAt(new THREE.Vector3(x + 1, y, z));
  return camera;
}

/** A single flat ground slab at y=0 covering [0, size) x [0, size), for spawn-scan tests. */
function buildFlatWorld(size = 10): World {
  const world = new World();
  for (let x = 0; x < size; x++) {
    for (let z = 0; z < size; z++) {
      world.setBlockRaw(x, 0, z, CONCRETE);
    }
  }
  return world;
}

describe('ModeManager', () => {
  let world: World;

  beforeEach(() => {
    world = buildFlatWorld();
  });

  it('starts in sandbox mode', () => {
    const modeManager = new ModeManager(cameraAt(5, 20, 5), world);
    expect(modeManager.currentMode).toBe('sandbox');
  });

  it('enterPlayMode switches to play and drops the player onto solid ground below the camera xz', () => {
    const camera = cameraAt(5, 20, 5);
    const modeManager = new ModeManager(camera, world);

    modeManager.enterPlayMode();

    expect(modeManager.currentMode).toBe('play');
    // Ground top is y=0 (CONCRETE at y=0), so feet land at y=1.
    expect(modeManager.playerFeet).toEqual([5, 1, 5]);
  });

  it('enterPlayMode uses the camera position at call time, not a fixed default', () => {
    // Solid column only exists at x=3,z=3, elsewhere the flat world stops at size 10;
    // use a second isolated column at a different height to prove it's camera-relative.
    world.setBlockRaw(3, 4, 3, CONCRETE);
    const camera = cameraAt(3, 20, 3);
    const modeManager = new ModeManager(camera, world);

    modeManager.enterPlayMode();

    // Scans downward from topY and lands on the first solid voxel found,
    // which is the higher block at y=4 (feet at y=5), not the y=0 slab.
    expect(modeManager.playerFeet).toEqual([3, 5, 3]);
  });

  it('enterSandboxMode switches back to sandbox and leaves the play feet position untouched', () => {
    const camera = cameraAt(5, 20, 5);
    const modeManager = new ModeManager(camera, world);
    modeManager.enterPlayMode();
    const feetAtEntry = modeManager.playerFeet;

    modeManager.enterSandboxMode();

    expect(modeManager.currentMode).toBe('sandbox');
    expect(modeManager.playerFeet).toEqual(feetAtEntry);
  });

  it('notifies listeners on every mode transition', () => {
    const camera = cameraAt(5, 20, 5);
    const modeManager = new ModeManager(camera, world);
    const seen: Mode[] = [];
    modeManager.onModeChange((mode) => seen.push(mode));

    modeManager.enterPlayMode();
    modeManager.enterSandboxMode();

    expect(seen).toEqual(['play', 'sandbox']);
  });

  it('scans down from the camera height, not the world ceiling, so an overhead deck does not intercept the street spawn', () => {
    // Street-level ground already covers this column (buildFlatWorld). Add an
    // overhead bridge/walkway deck well above the camera to reproduce the
    // sky-bridge bug: a naive top-down scan from the world ceiling would hit
    // the deck first and spawn the player on top of it instead of the street.
    world.setBlockRaw(5, 8, 5, CONCRETE);
    // Camera sits below the deck (as it does at startup: spawn + a small
    // height offset), so the scan should never reach y=8 at all.
    const camera = cameraAt(5, 6, 5);
    const modeManager = new ModeManager(camera, world);

    modeManager.enterPlayMode();

    // Lands on the street (y=0 slab -> feet at y=1), under the deck, not on it.
    expect(modeManager.playerFeet).toEqual([5, 1, 5]);
  });

  it('falls back to the safe default spawn when there is no ground below the camera or the safe column', () => {
    const emptyWorld = new World();
    const camera = cameraAt(200, 20, 200);
    const modeManager = new ModeManager(camera, emptyWorld);

    modeManager.enterPlayMode();

    // SAFE_SPAWN_X/Z/Y from ModeManager.ts.
    expect(modeManager.playerFeet).toEqual([48, 10, 48]);
  });

  it('reach is larger in sandbox mode than in play mode', () => {
    const modeManager = new ModeManager(cameraAt(5, 20, 5), world);
    const sandboxReach = modeManager.reach;

    modeManager.enterPlayMode();

    expect(modeManager.reach).toBeLessThan(sandboxReach);
  });

  describe('setVirtualKey (touch input path)', () => {
    it('drives movement in sandbox (fly) mode exactly like a real keydown would', () => {
      const camera = cameraAt(5, 20, 5);
      const modeManager = new ModeManager(camera, world);

      modeManager.setVirtualKey('KeyW', true);
      for (let tick = 0; tick < 30; tick++) modeManager.update(1 / 60);

      // FlyController moves the camera along its own forward direction; cameraAt looks toward +x.
      expect(camera.position.x).toBeGreaterThan(5);
    });

    it('feeds both controllers so movement resumes correctly after a mode switch mid-hold', () => {
      const camera = cameraAt(5, 20, 5);
      const modeManager = new ModeManager(camera, world);

      // Held before ever switching to play — mirrors a touch joystick already
      // pushed forward at the moment the mode-toggle button is tapped.
      modeManager.setVirtualKey('KeyW', true);
      modeManager.enterPlayMode();
      const feetBefore = modeManager.playerFeet;

      for (let tick = 0; tick < 30; tick++) modeManager.update(1 / 60);

      // PlayController also received the virtual keydown (see setVirtualKey's
      // fan-out) even though it wasn't the active controller when it fired.
      expect(modeManager.playerFeet[0]).not.toBe(feetBefore[0]);
    });

    it('releases movement when set to false — gain after release decays instead of continuing at the held rate', () => {
      const camera = cameraAt(5, 20, 5);
      const modeManager = new ModeManager(camera, world);

      modeManager.setVirtualKey('KeyW', true);
      for (let tick = 0; tick < 30; tick++) modeManager.update(1 / 60);
      const xAtRelease = camera.position.x;

      modeManager.setVirtualKey('KeyW', false);
      for (let tick = 0; tick < 30; tick++) modeManager.update(1 / 60);
      const gainAfterRelease = camera.position.x - xAtRelease;

      expect(gainAfterRelease).toBeGreaterThan(0); // damped velocity coasts briefly...
      expect(gainAfterRelease).toBeLessThan(xAtRelease); // ...but decays, it doesn't keep accelerating.
    });
  });

  describe('setVirtualSprint (regression: a full-deflection joystick must sprint in fly mode, not descend)', () => {
    it('speeds up forward flight instead of dropping the camera (fly-mode Y stays flat)', () => {
      const camera = cameraAt(5, 20, 5);
      const modeManager = new ModeManager(camera, world); // starts in sandbox/fly

      modeManager.setVirtualKey('KeyW', true);
      modeManager.setVirtualSprint(true);
      for (let tick = 0; tick < 60; tick++) modeManager.update(1 / 60);

      // The bug this guards against: a shared ShiftLeft code reaches
      // FlyController as fly-DOWN (see FlyController.setKey), sinking the
      // camera instead of sprinting. setVirtualSprint must route fly-mode
      // sprint through Ctrl instead, leaving y untouched.
      expect(camera.position.y).toBeCloseTo(20, 5);
    });

    it('walking forward with sprint covers more ground than without it, over the same real fly physics', () => {
      const world2 = buildFlatWorld(200); // wide enough that neither run clips the edge
      const baseline = cameraAt(5, 20, 5);
      const baselineManager = new ModeManager(baseline, world2);
      baselineManager.setVirtualKey('KeyW', true);
      for (let tick = 0; tick < 60; tick++) baselineManager.update(1 / 60);

      const sprinting = cameraAt(5, 20, 5);
      const sprintManager = new ModeManager(sprinting, world2);
      sprintManager.setVirtualKey('KeyW', true);
      sprintManager.setVirtualSprint(true);
      for (let tick = 0; tick < 60; tick++) sprintManager.update(1 / 60);

      expect(sprinting.position.x).toBeGreaterThan(baseline.position.x);
    });

    it('play-mode sprint still works via Shift, unaffected by the fly-mode Ctrl routing', () => {
      const camera = cameraAt(5, 20, 5);
      const modeManager = new ModeManager(camera, world);
      modeManager.enterPlayMode();

      modeManager.setVirtualKey('KeyW', true);
      modeManager.setVirtualSprint(true);
      for (let tick = 0; tick < 30; tick++) modeManager.update(1 / 60);
      const sprintX = modeManager.playerFeet[0];

      const walkCamera = cameraAt(5, 20, 5);
      const walkManager = new ModeManager(walkCamera, world);
      walkManager.enterPlayMode();
      walkManager.setVirtualKey('KeyW', true);
      for (let tick = 0; tick < 30; tick++) walkManager.update(1 / 60);
      const walkX = walkManager.playerFeet[0];

      expect(sprintX).toBeGreaterThan(walkX);
    });
  });
});
