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
