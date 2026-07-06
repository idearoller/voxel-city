import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { buildNavGrid, type NavGrid } from '../src/entities/NavGrid';
import { GROUND_SURFACE_Y, generateCity } from '../src/gen/CityGenerator';
import { scanElevatorShafts, type ElevatorShaft } from '../src/elevators/ElevatorScanner';
import { ElevatorSimulation } from '../src/elevators/ElevatorSimulation';
import type { SupportSurface } from '../src/player/PlayerCollision';
import { TourController } from '../src/player/TourController';
import type { TourElevatorPort } from '../src/player/TourElevatorRide';
import { WORLD_SIZE_X, WORLD_SIZE_Z } from '../src/world/coords';
import { World } from '../src/world/World';

const TICK = 1 / 60;

/**
 * Real-stack elevator port: wraps a real `ElevatorSimulation` synced against
 * real `scanElevatorShafts` output, the same shape `elevators/ElevatorSystem.ts`
 * itself is (minus its Three.js rendering, irrelevant here) -- not a
 * hand-rolled stand-in with invented geometry, so this test exercises the
 * actual car kinematics a real `ElevatorSystem` would produce against the
 * actual voxels `generateCity` wrote.
 */
class RealStackElevatorPort implements TourElevatorPort {
  private readonly sim = new ElevatorSimulation();

  constructor(private readonly knownShafts: readonly ElevatorShaft[]) {
    this.sim.sync(knownShafts);
  }

  shaftAt(x: number, z: number): ElevatorShaft | null {
    const wx = Math.floor(x);
    const wz = Math.floor(z);
    return this.knownShafts.find((s) => s.wellX === wx && s.wellZ === wz) ?? null;
  }

  shafts(): readonly ElevatorShaft[] {
    return this.knownShafts;
  }

  supportAt(feet: readonly [number, number, number]): SupportSurface | null {
    const shaft = this.shaftAt(feet[0], feet[2]);
    if (!shaft) return null;
    const car = this.sim.car(shaft.id);
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

  callElevator(shaft: ElevatorShaft, direction: 1 | -1): void {
    this.sim.call(shaft, direction);
  }

  tick(dt: number): void {
    this.sim.update(dt);
  }
}

/**
 * Drives a real ride-or-bust attempt: spawns the tour walker exactly on
 * `shaft`'s ground doorway (a real, already-NavGrid-confirmed-walkable cell —
 * see the test below's own sanity check), then ticks the real elevator port
 * and controller together (mirroring main.ts's own per-frame order:
 * elevator simulation steps before `TourController.update`) for up to
 * `ticksPerAttempt`. `maybeBeginElevatorRide`'s decision runs on the very
 * first tick after any `start()` (a freshly spawned pedestrian is already
 * cell-centered, so `stepPedestrian` calls `chooseNextCell` -- and this
 * hook -- immediately, see `TourController.update`'s doc comment), so one
 * attempt is exactly one independent `RIDE_CHANCE` roll at that doorway,
 * decoupled from whatever direction ordinary wandering happens to send the
 * walker afterward.
 */
function attemptRide(
  controller: TourController,
  port: RealStackElevatorPort,
  doorX: number,
  doorZ: number,
  ticksPerAttempt: number,
): boolean {
  controller.start(doorX + 0.5, doorZ + 0.5);
  const startingCount = controller.getCompletedElevatorRideCount();
  for (let i = 0; i < ticksPerAttempt; i++) {
    port.tick(TICK);
    controller.update(TICK);
    if (controller.getCompletedElevatorRideCount() > startingCount) return true;
  }
  return false;
}

/**
 * Enough sim-seconds for a full approach + ride + exit to complete at this
 * shaft's own stop gap (see the pinned shaft's `stops` below: a ~29-floor
 * rise at `ELEVATOR_SPEED` = 3 u/s is ~10s == 600 ticks; comfortably under
 * this budget even with the short walk to/from the well on each end).
 */
const TICKS_PER_ATTEMPT = 60 * 30;
/** Enough independent `RIDE_CHANCE` (~0.15) rolls that at least one succeeding is a near-certainty (1 - 0.85^80 > 0.999994), while still keeping the whole test fast. */
const MAX_ATTEMPTS = 80;

describe('TourElevatorRide real-stack integration (Task 41 fix verification)', () => {
  /**
   * Pinned seed + shaft, found by sweeping `elevator-soak-0`..`elevator-soak-79`
   * for the first city with a functional (bridge-anchored, 2+ stop) elevator
   * shaft after the gen/infrastructure.ts fix -- `elevator-soak-0` already
   * has three. This one's stops are `[2, 31]` (ground + one real sky-lobby
   * level), and its ground doorway was independently confirmed
   * NavGrid-walkable (see this suite's own sanity-check test) -- i.e. this is
   * exactly the scenario Sam's pre-fix soak found zero of.
   */
  const SEED = 'elevator-soak-0';
  const WELL_X = 171;
  const WELL_Z = 196;

  function loadCity(): { world: World; grid: NavGrid; shaft: ElevatorShaft } {
    const world = new World();
    generateCity(world, SEED);
    const grid = buildNavGrid(world, WORLD_SIZE_X, WORLD_SIZE_Z, GROUND_SURFACE_Y);
    const shafts = scanElevatorShafts(world);
    const shaft = shafts.find((s) => s.wellX === WELL_X && s.wellZ === WELL_Z);
    if (!shaft) throw new Error(`pinned shaft not found at (${WELL_X}, ${WELL_Z}) for seed ${SEED} -- did the generator change?`);
    return { world, grid, shaft };
  }

  it('sanity check: the pinned shaft is genuinely functional and its ground doorway is real NavGrid-walkable floor', () => {
    const { grid, shaft } = loadCity();

    expect(shaft.stops.length).toBeGreaterThanOrEqual(2);

    const groundDoor = shaft.doorCells[0]!;
    const groundFeetY = (shaft.stops[0] as number) - 1; // shaft-space -> walker-space, see TourElevatorRide.ts's doc comment
    expect(grid.sidewalk[groundDoor.x + groundDoor.z * grid.width]).toBe(1);
    expect(groundFeetY).toBe(grid.groundY);
  });

  it('completes at least one real elevator ride on a real generated city (real generateCity + scanElevatorShafts + ElevatorSimulation + TourController)', () => {
    const { grid, shaft } = loadCity();
    const port = new RealStackElevatorPort([shaft]);
    const camera = new THREE.PerspectiveCamera();
    const controller = new TourController(camera, () => grid, undefined, port);
    const groundDoor = shaft.doorCells[0]!;

    let completed = false;
    for (let attempt = 0; attempt < MAX_ATTEMPTS && !completed; attempt++) {
      completed = attemptRide(controller, port, groundDoor.x, groundDoor.z, TICKS_PER_ATTEMPT);
    }

    expect(completed).toBe(true);
    expect(controller.getCompletedElevatorRideCount()).toBeGreaterThan(0);
  });

  /**
   * Reachability regression coverage (round 2 of Task 41's review): the test
   * above proves riding is mechanically correct once the walker is standing
   * at the door, but a real-stack soak (5 seeds x 40,000 ticks, one ordinary
   * random spawn each -- see this suite's own history) showed that starting
   * an ordinary tour session from an arbitrary point almost never brings the
   * walker anywhere near a specific shaft on its own: `entities/NavGrid.ts`'s
   * sidewalk network fragments into many disconnected "islands" per city
   * block, so a random spawn is very likely on an island with no functional
   * shaft at all. `TourController.start`'s spawn bias
   * (`pickSpawnBiasedShaftDoor`) plus `TourElevatorExcursion.ts`'s
   * deliberate walk-to-the-door behavior together are what closes that gap.
   *
   * This test drives that *entire* real path -- `controller.start(x, z)`
   * with `x`/`z` deliberately far from every shaft (never hand-placed at a
   * door, unlike the test above) -- across several simulated tour-session
   * entries (mirroring a player toggling tour mode on and off across a real
   * play session), each bounded to 10 simulated minutes, on this seed's 3
   * functional shafts. A majority of real soak runs produced a ride within
   * that budget (see the task's own soak table); this pins that a handful of
   * attempts on one committed seed reliably reproduces it, bounded so a
   * regression fails the test suite rather than hanging.
   */
  it('reaches and rides an elevator from an ordinary (non-door) spawn, across a handful of simulated tour-session entries', () => {
    const { grid, shaft } = loadCity();
    const port = new RealStackElevatorPort([shaft]);
    const camera = new THREE.PerspectiveCamera();
    const controller = new TourController(camera, () => grid, undefined, port);

    // Deliberately far from the shaft, and not itself walkable -- start()
    // must fall back to its own nearest-walkable-cell search exactly like a
    // real mode-entry would, not rely on this test handing it a real cell.
    const farX = grid.width / 2;
    const farZ = grid.depth / 2;

    const TEN_MINUTES_OF_TICKS = 60 * 60 * 10;
    const MAX_SESSION_ENTRIES = 10;

    let completed = false;
    for (let entry = 0; entry < MAX_SESSION_ENTRIES && !completed; entry++) {
      controller.start(farX, farZ);
      for (let i = 0; i < TEN_MINUTES_OF_TICKS && !completed; i++) {
        port.tick(TICK);
        controller.update(TICK);
        completed = controller.getCompletedElevatorRideCount() > 0;
      }
    }

    expect(completed).toBe(true);
  });
});
