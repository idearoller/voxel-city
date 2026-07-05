import * as THREE from 'three';
import { FlyController } from './FlyController';
import { PlayController, type SupportProviderFn } from './PlayController';
import { findSpawnFeet } from './PlayerCollision';
import { TourController, type NavGridProvider } from './TourController';
import { WORLD_SIZE_Y } from '../world/coords';
import type { World } from '../world/World';

export type Mode = 'sandbox' | 'play' | 'tour';

export const SANDBOX_REACH = 60;
export const PLAY_REACH = 8;

/** Used when the current xz column has no solid ground to scan down onto. */
const SAFE_SPAWN_X = 48;
const SAFE_SPAWN_Z = 48;
const SAFE_SPAWN_Y = 10;

export type ModeChangeListener = (mode: Mode) => void;

/**
 * Owns the sandbox -> play -> tour -> sandbox switch (Tab cycles through all
 * three). Sandbox drives the camera via FlyController; play drives it via
 * PlayController with gravity/collision; tour drives it via TourController,
 * an auto-walking pedestrian-like body on the city's NavGrid (see
 * `TourController.ts`) that only mouse look can steer. All three share the
 * same camera and LookControls instance owned by main.ts.
 */
export class ModeManager {
  private mode: Mode = 'sandbox';
  private readonly listeners: ModeChangeListener[] = [];
  private readonly flyController: FlyController;
  private readonly playController: PlayController;
  private readonly tourController: TourController;
  private navGridProvider: NavGridProvider | null = null;

  constructor(
    private readonly camera: THREE.Camera,
    private readonly world: World,
  ) {
    this.flyController = new FlyController(camera);
    this.playController = new PlayController(camera, world);
    this.tourController = new TourController(camera, () => this.navGridProvider?.() ?? null);
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
    if (this.mode === 'sandbox') return SANDBOX_REACH;
    if (this.mode === 'play') return PLAY_REACH;
    // Tour mode disables voxel raycasting/editing entirely (main.ts gates
    // both the crosshair highlight and click-to-edit on `currentMode !==
    // 'tour'`) -- this value is never actually consulted, but 0 documents
    // "no reach" rather than silently reusing PLAY_REACH's number.
    return 0;
  }

  /** The AABB-relevant feet position in play mode, or the tour walker's current feet position in tour mode; meaningless (and unused) in sandbox. */
  get playerFeet(): readonly [number, number, number] {
    return this.mode === 'tour' ? this.tourController.getFeet() : this.playController.getFeet();
  }

  onModeChange(listener: ModeChangeListener): void {
    this.listeners.push(listener);
  }

  /** Forwards to the play controller's moving-support wiring (see `PlayController.setSupportProvider`) — e.g. `ElevatorSystem.supportAt`. */
  setSupportProvider(provider: SupportProviderFn | null): void {
    this.playController.setSupportProvider(provider);
  }

  /**
   * Wires the live city's navigation grid into tour mode (see
   * `TourController`'s `NavGridProvider`) — e.g. `() => entitySystem.navGrid`.
   * Not passed via the constructor because the first real `NavGrid` doesn't
   * exist until the first city generation/import completes, well after
   * `ModeManager` itself is constructed.
   */
  setNavGridProvider(provider: NavGridProvider | null): void {
    this.navGridProvider = provider;
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

  /** Fixed 60Hz simulation tick — routes to whichever controller is active. Tour's camera write happens later, in `render()`, not here (see `TourController`'s doc comment on why it's interpolated instead of stepped). */
  update(dt: number): void {
    if (this.mode === 'sandbox') {
      this.flyController.update(dt);
    } else if (this.mode === 'play') {
      this.playController.update(dt);
    } else {
      this.tourController.update(dt);
    }
  }

  /**
   * Per-render-frame camera placement for modes that need render-time
   * interpolation. Sandbox/play write `camera.position` directly inside
   * their own fixed-tick `update()` (immediate WASD response matters more
   * than smoothing there); tour instead lerps between its walker's previous
   * and current tick position by `alpha`, the same treatment `EntityRenderer`
   * gives every NPC — see `TourController.render`'s doc comment.
   */
  render(alpha: number): void {
    if (this.mode === 'tour') this.tourController.render(alpha);
  }

  private onKeyDown = (event: KeyboardEvent): void => {
    if (event.code !== 'Tab') return;
    event.preventDefault();
    this.cycleMode();
  };

  /** Advances sandbox -> play -> tour -> sandbox. Public (not just the Tab handler's private helper) so touch input's mode-switch button drives the exact same 3-way order — see `TouchControlsUI`'s mode button wiring in main.ts. */
  cycleMode(): void {
    if (this.mode === 'sandbox') {
      this.enterPlayMode();
    } else if (this.mode === 'play') {
      this.enterTourMode();
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

  /**
   * Switches to tour mode and starts the auto-walking NPC from the nearest
   * walkable sidewalk cell to the camera's *current* xz — read before the
   * mode flips, so entering from sandbox or play both hand off from
   * "roughly where the player already was" rather than a fixed spot. Leaving
   * tour (via `enterPlayMode`/`enterSandboxMode`) needs no matching
   * special-case: tour's own `render()` keeps the camera sitting exactly on
   * the walker's position every frame, so by the time either exit runs, the
   * camera is already positioned correctly for `enterPlayMode`'s
   * below-the-camera ground scan or `enterSandboxMode`'s "stay put".
   */
  enterTourMode(): void {
    const x = this.camera.position.x;
    const z = this.camera.position.z;
    this.mode = 'tour';
    this.tourController.start(x, z);
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
