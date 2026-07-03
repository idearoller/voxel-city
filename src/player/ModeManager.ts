import * as THREE from 'three';
import { FlyController } from './FlyController';
import { PlayController } from './PlayController';
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
    window.addEventListener('keydown', this.onKeyDown);
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
      this.enterPlay();
    } else {
      this.enterSandbox();
    }
  }

  private enterPlay(): void {
    this.mode = 'play';
    const spawnFeet = this.findSpawn();
    this.playController.setFeet(spawnFeet);
    this.emitModeChange();
  }

  private enterSandbox(): void {
    this.mode = 'sandbox';
    this.emitModeChange();
  }

  private emitModeChange(): void {
    for (const listener of this.listeners) listener(this.mode);
  }

  /** Drops from above the camera's current xz onto the first solid voxel found, or a safe default. */
  private findSpawn(): readonly [number, number, number] {
    const isSolid = (x: number, y: number, z: number): boolean => this.world.isSolid(x, y, z);
    const x = Math.floor(this.camera.position.x);
    const z = Math.floor(this.camera.position.z);
    const topY = WORLD_SIZE_Y - 1;

    const atCamera = findSpawnFeet(isSolid, x, z, topY);
    if (atCamera) return atCamera;

    const atSafeDefault = findSpawnFeet(isSolid, SAFE_SPAWN_X, SAFE_SPAWN_Z, topY);
    if (atSafeDefault) return atSafeDefault;

    return [SAFE_SPAWN_X, SAFE_SPAWN_Y, SAFE_SPAWN_Z];
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    this.flyController.dispose();
    this.playController.dispose();
  }
}
