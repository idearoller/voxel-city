/**
 * Orchestrates functional elevators: rescans `World` for intact shafts (see
 * `ElevatorScanner`), steps the pure car simulation on the fixed 60Hz tick,
 * routes E/Q "call" input while the player is standing in a shaft, exposes
 * the moving support surface `PlayController` rides on, and syncs the
 * Three.js platform meshes once per animation frame — the same
 * scan/simulate/render split `EntitySystem` uses for pedestrians/vehicles.
 *
 * Deliberately has no persisted state of its own: everything is re-derived
 * from `World`'s blocks (see `ElevatorScanner`'s doc comment), so a fresh
 * `.vxc` import or a sandbox edit that breaks a shaft is handled by the next
 * `rebuild()` rather than by any explicit save/patch path.
 */

import * as THREE from 'three';
import { ElevatorRenderer } from '../engine/ElevatorRenderer';
import { scanElevatorShafts, type ElevatorShaft } from './ElevatorScanner';
import { ElevatorSimulation } from './ElevatorSimulation';
import type { SupportSurface } from '../player/PlayerCollision';
import type { World } from '../world/World';

/** Generous upper bound on simultaneously-active shafts across a full city — see `EntityRenderer`'s identical capacity-cap convention. */
const MAX_SHAFTS = 128;

const CALL_UP_CODE = 'KeyE';
const CALL_DOWN_CODE = 'KeyQ';

export class ElevatorSystem {
  private readonly simulation = new ElevatorSimulation();
  private readonly renderer: ElevatorRenderer;
  private scannedShafts: ElevatorShaft[] = [];
  private callUpPressed = false;
  private callDownPressed = false;

  constructor(scene: THREE.Scene, maxShafts: number = MAX_SHAFTS) {
    this.renderer = new ElevatorRenderer(scene, maxShafts);
    // Guarded so ElevatorSystem can be constructed in non-browser contexts
    // (unit/integration tests), same convention as PlayController/ModeManager.
    if (typeof window !== 'undefined') {
      window.addEventListener('keydown', this.onKeyDown);
    }
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.code === CALL_UP_CODE) this.callUpPressed = true;
    else if (event.code === CALL_DOWN_CODE) this.callDownPressed = true;
  };

  /** Rescans `world` for intact shafts. Call after city generation/import, and periodically after edits (see main.ts's environment-refresh debounce). */
  rebuild(world: World): void {
    this.scannedShafts = scanElevatorShafts(world);
    this.simulation.sync(this.scannedShafts);
  }

  /** The shaft (if any) whose ride column contains world (x, z) — used for both input routing and the HUD's "you're in an elevator" hint. */
  shaftAt(x: number, z: number): ElevatorShaft | null {
    const wx = Math.floor(x);
    const wz = Math.floor(z);
    for (const shaft of this.scannedShafts) {
      if (shaft.wellX === wx && shaft.wellZ === wz) return shaft;
    }
    return null;
  }

  /** The support surface a rider standing at `feet` should collide/carry against, or null outside any shaft's column. */
  supportAt(feet: readonly [number, number, number]): SupportSurface | null {
    const shaft = this.shaftAt(feet[0], feet[2]);
    if (!shaft) return null;
    const car = this.simulation.car(shaft.id);
    if (!car) return null;

    return {
      minX: shaft.wellX,
      maxX: shaft.wellX + 1,
      minZ: shaft.wellZ,
      maxZ: shaft.wellZ + 1,
      surfaceY: car.feetY,
      deltaY: car.lastDeltaY,
    };
  }

  /**
   * Every currently-scanned (i.e. functional -- `scanElevatorShafts` already
   * drops sub-`MIN_STOPS_FOR_FUNCTIONAL_SHAFT` shafts) shaft in the city.
   * Used by `player/TourElevatorExcursion.ts` to find the nearest one to
   * deliberately walk toward, rather than relying purely on chance encounters
   * during ordinary wander (see that module's doc comment).
   */
  shafts(): readonly ElevatorShaft[] {
    return this.scannedShafts;
  }

  /**
   * Requests the car serving `shaft` travel to the adjacent stop in
   * `direction` (1 = up, -1 = down) -- the exact same request `update()`'s
   * E/Q routing makes on behalf of a play-mode rider standing in the shaft,
   * exposed directly so a non-keyboard rider can make the same request
   * without a synthetic keypress. Tour mode's auto-walker is the first such
   * caller (see `player/TourElevatorRide.ts`); play mode continues to go
   * through `update()`'s keyboard gating unchanged. No-op if the car is
   * already moving or already at the end of `shaft.stops` in that direction
   * (see `ElevatorSimulation.call`).
   */
  callElevator(shaft: ElevatorShaft, direction: 1 | -1): void {
    this.simulation.call(shaft, direction);
  }

  /** Fixed 60Hz tick: consumes any queued call input (play mode only, only while standing in a shaft) and steps every car. */
  update(dt: number, playerFeet: readonly [number, number, number], isPlayMode: boolean): void {
    if (isPlayMode) {
      const shaft = this.shaftAt(playerFeet[0], playerFeet[2]);
      if (shaft) {
        if (this.callUpPressed) this.simulation.call(shaft, 1);
        else if (this.callDownPressed) this.simulation.call(shaft, -1);
      }
    }
    this.callUpPressed = false;
    this.callDownPressed = false;

    this.simulation.update(dt);
  }

  /** Per-animation-frame sync of platform instance matrices from current car state. */
  render(): void {
    this.renderer.update(this.scannedShafts, this.simulation);
  }

  dispose(): void {
    if (typeof window !== 'undefined') window.removeEventListener('keydown', this.onKeyDown);
    this.renderer.dispose();
  }
}
