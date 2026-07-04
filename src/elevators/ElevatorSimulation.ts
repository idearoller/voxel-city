/**
 * Pure kinematic state machine for elevator cars: one parked-or-moving
 * platform per scanned `ElevatorShaft`, always sitting exactly on a stop
 * except while transiting between two adjacent ones. No Three.js — mirrors
 * `entities/EntitySimulation.ts`'s "pure sim, dumb renderer" split.
 */

import type { ElevatorShaft } from './ElevatorScanner';

/** Vertical travel speed, in world units (voxels) per second. */
const ELEVATOR_SPEED = 3;

export interface ElevatorCarState {
  /** Current platform surface Y (world coordinate a rider's feet rest at). */
  feetY: number;
  /** Stop the car is currently travelling to, or null when parked. */
  targetFeetY: number | null;
  /** Y delta applied this `update()` tick — 0 while parked. Riders are carried by exactly this much. */
  lastDeltaY: number;
}

/** The stop in `stops` nearest to `feetY` — used to re-anchor a car whose shaft geometry shifted under it (a sandbox edit moved/removed stops). */
function nearestStop(stops: readonly number[], feetY: number): number {
  let best = stops[0] as number;
  let bestDist = Math.abs(best - feetY);
  for (const stop of stops) {
    const dist = Math.abs(stop - feetY);
    if (dist < bestDist) {
      best = stop;
      bestDist = dist;
    }
  }
  return best;
}

/**
 * Owns every active car, keyed by `ElevatorShaft.id`. `sync()` reconciles
 * against a fresh scan (new shafts get a parked car at their lowest stop;
 * shafts that vanished — e.g. a broken shaft after a sandbox edit — lose
 * theirs); `update()` steps every in-transit car at a fixed speed and clamps
 * exactly onto its target, never overshooting.
 */
export class ElevatorSimulation {
  private readonly cars = new Map<string, ElevatorCarState>();

  car(shaftId: string): ElevatorCarState | undefined {
    return this.cars.get(shaftId);
  }

  /** Reconciles car state against the latest `scanElevatorShafts` result. Call once per rescan, before the next `update()`. */
  sync(shafts: readonly ElevatorShaft[]): void {
    const liveIds = new Set(shafts.map((s) => s.id));
    for (const id of this.cars.keys()) {
      if (!liveIds.has(id)) this.cars.delete(id);
    }

    for (const shaft of shafts) {
      const existing = this.cars.get(shaft.id);
      if (!existing) {
        this.cars.set(shaft.id, { feetY: shaft.stops[0] as number, targetFeetY: null, lastDeltaY: 0 });
        continue;
      }
      // A parked car whose exact stop no longer exists (edit shifted the
      // shaft's stop list) snaps to the nearest surviving one rather than
      // being left floating at a Y that's no longer a valid floor.
      if (existing.targetFeetY === null && !shaft.stops.includes(existing.feetY)) {
        existing.feetY = nearestStop(shaft.stops, existing.feetY);
      }
    }
  }

  /**
   * Calls the car at `shaft` to the next stop in `direction` (1 = up, -1 =
   * down). A no-op while already moving, or when already at the topmost/
   * bottommost stop — both are "direction rules" enforced here rather than
   * left to the caller.
   */
  call(shaft: ElevatorShaft, direction: 1 | -1): void {
    const car = this.cars.get(shaft.id);
    if (!car || car.targetFeetY !== null) return;

    const currentIndex = shaft.stops.indexOf(car.feetY);
    if (currentIndex === -1) return;

    const nextIndex = currentIndex + direction;
    if (nextIndex < 0 || nextIndex >= shaft.stops.length) return;

    car.targetFeetY = shaft.stops[nextIndex] as number;
  }

  /** Advances every in-transit car by one fixed tick, landing exactly on its target instead of overshooting past it. */
  update(dt: number): void {
    const maxStep = ELEVATOR_SPEED * dt;

    for (const car of this.cars.values()) {
      if (car.targetFeetY === null) {
        car.lastDeltaY = 0;
        continue;
      }

      const before = car.feetY;
      const remaining = car.targetFeetY - car.feetY;
      if (Math.abs(remaining) <= maxStep) {
        car.feetY = car.targetFeetY;
        car.targetFeetY = null;
      } else {
        car.feetY += Math.sign(remaining) * maxStep;
      }
      car.lastDeltaY = car.feetY - before;
    }
  }
}
