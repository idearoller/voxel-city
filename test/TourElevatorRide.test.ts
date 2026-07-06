import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { buildNavGrid, type NavGrid } from '../src/entities/NavGrid';
import { createPedestrianAt } from '../src/entities/Pedestrian';
import type { ElevatorShaft } from '../src/elevators/ElevatorScanner';
import { ElevatorSimulation } from '../src/elevators/ElevatorSimulation';
import { createRng, type Rng } from '../src/gen/rng';
import type { SupportSurface } from '../src/player/PlayerCollision';
import {
  maybeBeginElevatorRide,
  stepTourElevatorRide,
  type TourElevatorPort,
  type TourElevatorRideState,
} from '../src/player/TourElevatorRide';
import { TourController } from '../src/player/TourController';
import type { TourWalker } from '../src/player/TourWalker';
import { AIR, CONCRETE, METAL, SIDEWALK } from '../src/world/BlockRegistry';
import { World } from '../src/world/World';

const GROUND_Y = 1; // walker-/NavGrid-space: matches NavGrid.groundY, the row Pedestrian.y uses.
const DECK_Y = 12; // WALKWAY_Y — the only row buildNavGrid actually scans for a non-ground deck.
const DECK_FEET_Y = DECK_Y; // ElevatedLevel.y / StairLink.levelY / shaft stop convention: the deck's own solid-surface row (walker-/NavGrid-space).
const WIDTH = 40;
const DEPTH = 40;

const WELL_X = 10;
const WELL_Z = 10;
const GROUND_DOOR = { x: WELL_X, z: WELL_Z - 1 };
const DECK_DOOR = { x: WELL_X, z: WELL_Z + 1 };

/**
 * `ElevatorShaft.stops` (and everything derived from it: `TourElevatorRideState.boardFeetY`/
 * `destinationFeetY`, `SupportSurface.surfaceY`) is shaft-space, always
 * exactly `walkerY + 1` for the same physical floor -- see
 * `TourElevatorRide.ts`'s doc comment on the two conventions. These fixtures
 * deliberately keep both spellings distinct (rather than reusing GROUND_Y/
 * DECK_FEET_Y with an inline `+ 1` at every call site) so a test asserting
 * against the wrong one fails obviously rather than silently passing off a
 * coincidental value.
 */
const SHAFT_GROUND_FEET_Y = GROUND_Y + 1;
const SHAFT_DECK_FEET_Y = DECK_FEET_Y + 1;

function testShaft(): ElevatorShaft {
  return {
    id: 'test-shaft',
    wellX: WELL_X,
    wellZ: WELL_Z,
    minY: SHAFT_GROUND_FEET_Y,
    maxY: SHAFT_DECK_FEET_Y,
    stops: [SHAFT_GROUND_FEET_Y, SHAFT_DECK_FEET_Y],
    doorCells: [GROUND_DOOR, DECK_DOOR],
  };
}

/** A ground sidewalk corridor along z = WELL_Z - 1, passing through the shaft's ground doorway, plus a small walkable deck patch around the shaft's deck doorway. */
function buildGridWithShaft(): NavGrid {
  const world = new World();
  for (let x = 0; x <= 20; x++) {
    world.setBlock(x, 0, WELL_Z - 1, CONCRETE);
    world.setBlock(x, GROUND_Y, WELL_Z - 1, SIDEWALK);
  }
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      const x = WELL_X + dx;
      const z = WELL_Z + 1 + dz;
      world.setBlock(x, DECK_Y - 1, z, AIR);
      world.setBlock(x, DECK_Y, z, METAL);
      world.setBlock(x, DECK_Y + 1, z, AIR);
    }
  }
  return buildNavGrid(world, WIDTH, DEPTH, GROUND_Y);
}

/** A grid with the same ground corridor but no deck at all -- the shaft's "up" doorway leads nowhere walkable. */
function buildGridWithoutDeck(): NavGrid {
  const world = new World();
  for (let x = 0; x <= 20; x++) {
    world.setBlock(x, 0, WELL_Z - 1, CONCRETE);
    world.setBlock(x, GROUND_Y, WELL_Z - 1, SIDEWALK);
  }
  return buildNavGrid(world, WIDTH, DEPTH, GROUND_Y);
}

function walkerAtGroundDoor(): TourWalker {
  return createPedestrianAt(GROUND_DOOR.x, GROUND_DOOR.z, GROUND_Y, 1.4);
}

/** Real `ElevatorSimulation`-backed fake -- exercises the actual car kinematics (speed, clamped arrival), not a hand-rolled stand-in, so ride tests see the same timing a real `ElevatorSystem` would produce. */
class SimulatedElevatorPort implements TourElevatorPort {
  readonly sim = new ElevatorSimulation();
  private readonly knownShafts: ElevatorShaft[];

  constructor(shafts: ElevatorShaft[]) {
    this.knownShafts = shafts;
    this.sim.sync(shafts);
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

/** Always reports the car busy (mid-transit) at every stop -- used to force `waiting`/`retreating`. */
class NeverParkedPort implements TourElevatorPort {
  constructor(private readonly shaft: ElevatorShaft) {}

  shaftAt(x: number, z: number): ElevatorShaft | null {
    return Math.floor(x) === this.shaft.wellX && Math.floor(z) === this.shaft.wellZ ? this.shaft : null;
  }

  shafts(): readonly ElevatorShaft[] {
    return [this.shaft];
  }

  supportAt(feet: readonly [number, number, number]): SupportSurface | null {
    const shaft = this.shaftAt(feet[0], feet[2]);
    if (!shaft) return null;
    return { minX: shaft.wellX, maxX: shaft.wellX + 1, minZ: shaft.wellZ, maxZ: shaft.wellZ + 1, surfaceY: shaft.stops[0] as number, deltaY: 0.5 };
  }

  callElevator(): void {
    // never actually parks -- deliberately a no-op for this fake.
  }
}

const TICK = 1 / 60;

describe('maybeBeginElevatorRide (decision policy)', () => {
  it('returns null when the arrived cell borders no shaft at all', () => {
    const grid = buildGridWithShaft();
    const port = new SimulatedElevatorPort([testShaft()]);
    const walker = createPedestrianAt(2, WELL_Z - 1, GROUND_Y, 1.4);
    const rng = createRng('no-shaft-nearby');

    expect(maybeBeginElevatorRide(walker, 2, WELL_Z - 1, grid, port, rng)).toBeNull();
  });

  it('never commits when the destination doorway leads nowhere walkable (no deck at all)', () => {
    const grid = buildGridWithoutDeck();
    const port = new SimulatedElevatorPort([testShaft()]);
    const walker = walkerAtGroundDoor();

    for (let i = 0; i < 200; i++) {
      const rng = createRng(`no-deck-${i}`);
      expect(maybeBeginElevatorRide(walker, GROUND_DOOR.x, GROUND_DOOR.z, grid, port, rng)).toBeNull();
    }
  });

  it('never commits when the car is not currently parked at the walker\'s own stop', () => {
    const grid = buildGridWithShaft();
    const shaft = testShaft();
    const port = new SimulatedElevatorPort([shaft]);
    port.sim.call(shaft, 1); // car is now travelling away from the ground stop
    port.tick(TICK); // advance once so the car's motion is actually reflected (deltaY != 0)
    const walker = walkerAtGroundDoor();

    for (let i = 0; i < 200; i++) {
      const rng = createRng(`car-busy-${i}`);
      expect(maybeBeginElevatorRide(walker, GROUND_DOOR.x, GROUND_DOOR.z, grid, port, rng)).toBeNull();
    }
  });

  it('commits only a fraction of the time across many independent rng draws, never every time and never zero times', () => {
    const grid = buildGridWithShaft();
    const port = new SimulatedElevatorPort([testShaft()]);
    const rootRng = createRng('ride-probability');

    let commits = 0;
    const trials = 2000;
    for (let i = 0; i < trials; i++) {
      const walker = walkerAtGroundDoor();
      const trialRng: Rng = rootRng.fork(`trial-${i}`);
      const ride = maybeBeginElevatorRide(walker, GROUND_DOOR.x, GROUND_DOOR.z, grid, port, trialRng);
      if (ride) commits++;
    }

    const rate = commits / trials;
    expect(rate).toBeGreaterThan(0.03);
    expect(rate).toBeLessThan(0.35);
  });

  it('when it does commit, the resulting state points up from the ground door toward the deck door', () => {
    const grid = buildGridWithShaft();
    const port = new SimulatedElevatorPort([testShaft()]);

    let ride: TourElevatorRideState | null = null;
    for (let i = 0; i < 500 && !ride; i++) {
      const walker = walkerAtGroundDoor();
      ride = maybeBeginElevatorRide(walker, GROUND_DOOR.x, GROUND_DOOR.z, grid, port, createRng(`find-commit-${i}`));
    }

    expect(ride).not.toBeNull();
    expect(ride!.direction).toBe(1);
    expect(ride!.phase).toBe('approaching');
    expect(ride!.boardFeetY).toBe(SHAFT_GROUND_FEET_Y);
    expect(ride!.destinationFeetY).toBe(SHAFT_DECK_FEET_Y);
    expect(ride!.originDoorCell).toEqual(GROUND_DOOR);
  });
});

describe('stepTourElevatorRide (ride state machine)', () => {
  it('walks the full cycle: approaching -> riding -> exiting, landing exactly on the destination stop', () => {
    const shaft = testShaft();
    const port = new SimulatedElevatorPort([shaft]);
    const walker = walkerAtGroundDoor();

    let state: TourElevatorRideState | null = {
      shaft,
      direction: 1,
      boardStopIndex: 0,
      destinationStopIndex: 1,
      originDoorCell: GROUND_DOOR,
      destinationDoorCell: DECK_DOOR,
      boardFeetY: SHAFT_GROUND_FEET_Y,
      destinationFeetY: SHAFT_DECK_FEET_Y,
      phase: 'approaching',
      waitedSeconds: 0,
    };

    const seenPhases = new Set<string>();
    for (let i = 0; i < 60 * 30 && state; i++) {
      port.tick(TICK);
      state = stepTourElevatorRide(walker, state, TICK, port);
      if (state) seenPhases.add(state.phase);
    }

    expect(state).toBeNull(); // ride completed
    expect(seenPhases.has('approaching')).toBe(true);
    expect(seenPhases.has('riding')).toBe(true);
    expect(seenPhases.has('exiting')).toBe(true);
    expect(seenPhases.has('waiting')).toBe(false); // car was already parked -- never had to wait

    expect(walker.y).toBe(DECK_FEET_Y);
    expect(walker.cellX).toBe(DECK_DOOR.x);
    expect(walker.cellZ).toBe(DECK_DOOR.z);
    expect(walker.x).toBeCloseTo(DECK_DOOR.x + 0.5, 5);
    expect(walker.z).toBeCloseTo(DECK_DOOR.z + 0.5, 5);
  });

  it('never carries the walker below the car\'s current surface, and never lets it drift off the car horizontally while riding', () => {
    const shaft = testShaft();
    const port = new SimulatedElevatorPort([shaft]);
    const walker = walkerAtGroundDoor();

    let state: TourElevatorRideState | null = {
      shaft,
      direction: 1,
      boardStopIndex: 0,
      destinationStopIndex: 1,
      originDoorCell: GROUND_DOOR,
      destinationDoorCell: DECK_DOOR,
      boardFeetY: SHAFT_GROUND_FEET_Y,
      destinationFeetY: SHAFT_DECK_FEET_Y,
      phase: 'approaching',
      waitedSeconds: 0,
    };

    for (let i = 0; i < 60 * 30 && state; i++) {
      port.tick(TICK);
      const wasRiding = state.phase === 'riding';
      state = stepTourElevatorRide(walker, state, TICK, port);
      if (wasRiding) {
        expect(walker.x).toBeCloseTo(shaft.wellX + 0.5, 5);
        expect(walker.z).toBeCloseTo(shaft.wellZ + 0.5, 5);
      }
    }
  });

  it('bounded-wait bailout: gives up and retreats to the origin door after MAX_WAIT_SECONDS if the car never settles', () => {
    const shaft = testShaft();
    const port = new NeverParkedPort(shaft);
    const walker = walkerAtGroundDoor();

    let state: TourElevatorRideState | null = {
      shaft,
      direction: 1,
      boardStopIndex: 0,
      destinationStopIndex: 1,
      originDoorCell: GROUND_DOOR,
      destinationDoorCell: DECK_DOOR,
      boardFeetY: SHAFT_GROUND_FEET_Y,
      destinationFeetY: SHAFT_DECK_FEET_Y,
      phase: 'approaching',
      waitedSeconds: 0,
    };

    let ticks = 0;
    const seenPhases = new Set<string>();
    // Bounded loop -- must terminate (return null) well before this budget,
    // or the test itself proves the "never stalls" requirement failed.
    const MAX_TICKS = 60 * 60;
    while (state && ticks < MAX_TICKS) {
      state = stepTourElevatorRide(walker, state, TICK, port);
      if (state) seenPhases.add(state.phase);
      ticks++;
    }

    expect(state).toBeNull(); // gave up cleanly, did not stall forever
    expect(seenPhases.has('waiting')).toBe(true);
    expect(seenPhases.has('retreating')).toBe(true);
    expect(seenPhases.has('riding')).toBe(false); // car never actually parked, so it never boarded

    expect(walker.y).toBe(GROUND_Y); // never left its original level
    expect(walker.cellX).toBe(GROUND_DOOR.x);
    expect(walker.cellZ).toBe(GROUND_DOOR.z);
  });

  it('render-interpolation: captures a distinct prev state every tick, including during the purely-vertical riding phase', () => {
    const shaft = testShaft();
    const port = new SimulatedElevatorPort([shaft]);
    const walker = walkerAtGroundDoor();

    let state: TourElevatorRideState | null = {
      shaft,
      direction: 1,
      boardStopIndex: 0,
      destinationStopIndex: 1,
      originDoorCell: GROUND_DOOR,
      destinationDoorCell: DECK_DOOR,
      boardFeetY: SHAFT_GROUND_FEET_Y,
      destinationFeetY: SHAFT_DECK_FEET_Y,
      phase: 'approaching',
      waitedSeconds: 0,
    };

    // Advance until the ride is confirmed riding (vertical motion in progress).
    for (let i = 0; i < 60 * 5 && state && state.phase !== 'riding'; i++) {
      port.tick(TICK);
      state = stepTourElevatorRide(walker, state, TICK, port);
    }
    expect(state?.phase).toBe('riding');

    port.tick(TICK);
    const yBefore = walker.y;
    state = stepTourElevatorRide(walker, state as TourElevatorRideState, TICK, port);

    expect(walker.prevY).toBeCloseTo(yBefore, 5); // prev captured at the start of this tick, before the car moved
    expect(walker.y).toBeGreaterThan(walker.prevY); // car moved up this tick
  });
});

describe('TourController elevator riding: end-to-end wiring', () => {
  function buildController(port: TourElevatorPort, grid: NavGrid): { controller: TourController; camera: THREE.Camera } {
    const camera = new THREE.PerspectiveCamera();
    return { controller: new TourController(camera, () => grid, undefined, port), camera };
  }

  it('the camera rises smoothly during a ride: render(0)->render(1) spread while riding is bounded by the elevator\'s own per-tick speed, not a teleport', () => {
    const shaft = testShaft();
    const port = new SimulatedElevatorPort([shaft]);
    const grid = buildGridWithShaft();
    const { controller, camera } = buildController(port, grid);
    controller.start(2, WELL_Z - 1);

    // Drive real ticks (via the public start()/update()/getFeet() surface,
    // exactly as main.ts would) until the walker is confirmed riding
    // (strictly between the ground and deck stops), bounded so a failure to
    // ever board fails the test loudly instead of looping forever.
    let riding = false;
    for (let i = 0; i < 20000 && !riding; i++) {
      port.tick(TICK);
      controller.update(TICK);
      const y = controller.getFeet()[1];
      if (y > GROUND_Y + 0.001 && y < DECK_FEET_Y) riding = true;
    }
    expect(riding).toBe(true);

    port.tick(TICK);
    controller.update(TICK);

    controller.render(0);
    const yAtAlpha0 = camera.position.y;
    controller.render(1);
    const yAtAlpha1 = camera.position.y;

    const spread = Math.abs(yAtAlpha1 - yAtAlpha0);
    expect(spread).toBeGreaterThan(0);
    expect(spread).toBeLessThanOrEqual(3 * TICK + 1e-9); // ELEVATOR_SPEED = 3 u/s, no teleport-sized jump
  });

  it('long soak: 1000+ ticks with an elevator available -- the walker keeps moving or riding, never stalls', () => {
    const shaft = testShaft();
    const port = new SimulatedElevatorPort([shaft]);
    const grid = buildGridWithShaft();
    const { controller } = buildController(port, grid);
    controller.start(2, WELL_Z - 1);

    let lastFeet = controller.getFeet();
    let sawMovement = false;

    for (let i = 0; i < 1500; i++) {
      port.tick(TICK);
      controller.update(TICK);
      const feet = controller.getFeet();
      expect(Number.isFinite(feet[0])).toBe(true);
      expect(Number.isFinite(feet[1])).toBe(true);
      expect(Number.isFinite(feet[2])).toBe(true);
      if (feet[0] !== lastFeet[0] || feet[1] !== lastFeet[1] || feet[2] !== lastFeet[2]) sawMovement = true;
      lastFeet = feet;
    }

    expect(sawMovement).toBe(true);
    controller.render(0.5);
  });

  it('mid-ride mode exit: freezing update() mid-ride does not throw, and start() cleanly discards the stale ride on re-entry', () => {
    const shaft = testShaft();
    const port = new SimulatedElevatorPort([shaft]);
    const grid = buildGridWithShaft();
    const { controller } = buildController(port, grid);
    controller.start(2, WELL_Z - 1);

    // Force a ride to begin by walking the corridor until the decision
    // policy commits (bounded by a generous tick budget -- if it never
    // commits within this budget the test fails loudly rather than hanging).
    let rode = false;
    for (let i = 0; i < 20000 && !rode; i++) {
      port.tick(TICK);
      controller.update(TICK);
      const feet = controller.getFeet();
      if (feet[1] > GROUND_Y + 0.001 && feet[1] < DECK_FEET_Y) rode = true;
    }
    expect(rode).toBe(true);

    // "Mode switch away from tour": simply stop calling controller.update().
    // The elevator's own simulation keeps running (main.ts always ticks it
    // unconditionally) -- that must not throw or corrupt anything either.
    for (let i = 0; i < 60; i++) port.tick(TICK);

    // Re-entering tour mode discards the stale ride outright.
    expect(() => controller.start(2, WELL_Z - 1)).not.toThrow();
    controller.render(0);
    expect(controller.getFeet()[1]).toBe(GROUND_Y); // back to ordinary ground-level wandering, not stuck mid-shaft
  });
});
