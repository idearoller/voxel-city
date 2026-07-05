import * as THREE from 'three';
import { FlyController } from './FlyController';
import { PlayController, type SupportProviderFn } from './PlayController';
import { findSpawnFeet } from './PlayerCollision';
import { WORLD_SIZE_Y } from '../world/coords';
import type { World } from '../world/World';

export type Mode = 'sandbox' | 'play';

export const SANDBOX_REACH = 60;
export const PLAY_REACH = 8;

/** Used when the current xz column has no solid ground to scan down onto. */
const SAFE_SPAWN_X = 48;
const SAFE_SPAWN_Z = 48;
const SAFE_SPAWN_Y = 10;

export type ModeChangeListener = (mode: Mode) => void;

/**
 * Owns the sandbox <-> play switch (Tab). Sandbox drives the camera via
 * FlyController; play drives it via PlayController with gravity/collision.
 * Both share the same camera and LookControls instance owned by main.ts.
 */
export class ModeManager {
  private mode: Mode = 'sandbox';
  private readonly listeners: ModeChangeListener[] = [];
  private readonly flyController: FlyController;
  private readonly playController: PlayController;

  constructor(
    private readonly camera: THREE.Camera,
    private readonly world: World,
  ) {
    this.flyController = new FlyController(camera);
    this.playController = new PlayController(camera, world);
    // Guarded so ModeManager can be constructed in non-browser contexts
    // (unit/integration tests) that drive mode transitions via
    // enterPlayMode()/enterSandboxMode() directly.
    if (typeof window !== 'undefined') {
      window.addEventListener('keydown', this.onKeyDown);
    }
  }

  get currentMode(): Mode {
    return this.mode;
  }

  get reach(): number {
    return this.mode === 'sandbox' ? SANDBOX_REACH : PLAY_REACH;
  }

  /** The AABB-relevant feet position, only meaningful in play mode. */
  get playerFeet(): readonly [number, number, number] {
    return this.playController.getFeet();
  }

  onModeChange(listener: ModeChangeListener): void {
    this.listeners.push(listener);
  }

  /** Forwards to the play controller's moving-support wiring (see `PlayController.setSupportProvider`) — e.g. `ElevatorSystem.supportAt`. */
  setSupportProvider(provider: SupportProviderFn | null): void {
    this.playController.setSupportProvider(provider);
  }

  /**
   * Feeds a virtual key press/release into *both* underlying controllers,
   * mirroring what a real window keydown/keyup does today — `FlyController`
   * and `PlayController` each independently listen for the same
   * `KeyboardEvent`s and track their own `keys` state regardless of which
   * mode is active; only `update()` picks whichever one actually moves the
   * camera. Touch input has no native `KeyboardEvent`s to dispatch, so this
   * is how it reaches the same fan-out — the controllers themselves stay
   * completely unaware the "keypress" came from a touch joystick/button
   * rather than a keyboard.
   */
  setVirtualKey(code: string, pressed: boolean): void {
    this.flyController.setKey(code, pressed);
    this.playController.setKey(code, pressed);
  }

  /**
   * Feeds a virtual "sprint" press/release into each controller's own
   * *actual* sprint binding — unlike `setVirtualKey`, this is deliberately
   * not a single shared keycode, because "sprint" isn't the same physical
   * key in both controllers: `PlayController.setKey` treats Shift as
   * sprint, but `FlyController.setKey` treats Shift as fly-down and Ctrl as
   * its own sprint multiplier. Reusing Shift for touch sprint in both modes
   * would make a full-deflection joystick push descend instead of sprint
   * while flying. Same fan-out-to-both rationale as `setVirtualKey`: only
   * the active controller's `update()` runs, so feeding the inactive one is
   * harmless and keeps behavior symmetric across a mode switch.
   */
  setVirtualSprint(pressed: boolean): void {
    this.playController.setKey('ShiftLeft', pressed);
    this.flyController.setKey('ControlLeft', pressed);
  }

  update(dt: number): void {
    if (this.mode === 'sandbox') {
      this.flyController.update(dt);
    } else {
      this.playController.update(dt);
    }
  }

  private onKeyDown = (event: KeyboardEvent): void => {
    if (event.code !== 'Tab') return;
    event.preventDefault();
    this.toggle();
  };

  private toggle(): void {
    if (this.mode === 'sandbox') {
      this.enterPlayMode();
    } else {
      this.enterSandboxMode();
    }
  }

  /**
   * Switches to play mode and drops the player onto solid ground below the
   * camera's current xz (see `findSpawn`). Used both for the Tab toggle and
   * to put the player on the street right after city generation/import,
   * where the caller has already positioned the camera above the spawn
   * point — so "below the camera" and "the generated spawn point" are the
   * same place.
   */
  enterPlayMode(): void {
    this.mode = 'play';
    const spawnFeet = this.findSpawn();
    this.playController.setFeet(spawnFeet);
    this.emitModeChange();
  }

  /** Switches to sandbox (fly) mode, keeping the camera at its current position. */
  enterSandboxMode(): void {
    this.mode = 'sandbox';
    this.emitModeChange();
  }

  private emitModeChange(): void {
    for (const listener of this.listeners) listener(this.mode);
  }

  /**
   * Drops from above the camera's current xz onto the first solid voxel
   * found, or a safe default. Scans down from the camera's own height
   * rather than the world ceiling: on startup the camera sits at
   * spawn+6 directly above the street, so this finds the asphalt; on a
   * Tab-from-fly toggle it means "drop onto whatever is under me", which
   * correctly stops at a bridge/walkway deck below a sandbox-flying camera
   * instead of tunneling through it down to street level.
   */
  private findSpawn(): readonly [number, number, number] {
    const isSolid = (x: number, y: number, z: number): boolean => this.world.isSolid(x, y, z);
    const x = Math.floor(this.camera.position.x);
    const z = Math.floor(this.camera.position.z);
    const topY = Math.min(WORLD_SIZE_Y - 1, Math.ceil(this.camera.position.y));

    const atCamera = findSpawnFeet(isSolid, x, z, topY);
    if (atCamera) return atCamera;

    const atSafeDefault = findSpawnFeet(isSolid, SAFE_SPAWN_X, SAFE_SPAWN_Z, topY);
    if (atSafeDefault) return atSafeDefault;

    return [SAFE_SPAWN_X, SAFE_SPAWN_Y, SAFE_SPAWN_Z];
  }

  dispose(): void {
    if (typeof window !== 'undefined') {
      window.removeEventListener('keydown', this.onKeyDown);
    }
    this.flyController.dispose();
    this.playController.dispose();
  }
}
