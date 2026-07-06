/**
 * Tour-mode-only elevator riding: lets the auto-walking tour camera
 * occasionally detour onto an elevator it wanders past, ride it to an
 * adjacent stop, and resume ordinary wandering on the new level -- the
 * vertical-transport counterpart to `entities/Pedestrian.ts`'s stair
 * crossing (`StairCommitment`), implemented here in `player/` rather than
 * promoted into `entities/Pedestrian`.
 *
 * That's a deliberate architecture choice, not an oversight. A
 * `NavGrid.StairLink` is voxel-derived once, up front, and shared read-only
 * by every pedestrian and the tour walker alike -- riding an elevator instead
 * needs a *live* query into `ElevatorSystem`'s moving car state, the same
 * kind of dependency `player/PlayController.ts` already takes through its own
 * `SupportProviderFn` rather than teaching `entities/` about elevators
 * directly. Threading that same live dependency through `EntitySystem`'s
 * per-tick update for every NPC pedestrian in a city (dozens to hundreds, at
 * once, versus tour's single walker) -- plus giving every one of them this
 * same decision/wait/ride state machine -- is a much larger change than this
 * task asks for, and would leave the capability sitting unused on every
 * pedestrian that never opts into it (an inert lever, not a feature).
 * Ordinary pedestrian NPCs riding elevators stays out of scope (the task's
 * own "documented scope" note); this module's pure logic could be lifted
 * into `entities/` later and wired the same way if that's ever wanted. The
 * port below (`TourElevatorPort`) is kept narrow and structural for exactly
 * that reason -- `ElevatorSystem` already satisfies it as-is, no adapter
 * needed.
 */

import { isWalkableSurfaceCell, type NavGrid } from '../entities/NavGrid';
import { captureRenderPrevState, snapRenderPrevIfTeleported } from '../entities/Pedestrian';
import type { ElevatorShaft } from '../elevators/ElevatorScanner';
import type { Rng } from '../gen/rng';
import type { SupportSurface } from './PlayerCollision';
import type { TourWalker } from './TourWalker';

/**
 * The narrow slice of `ElevatorSystem` tour-mode riding (and, since Task 41's
 * follow-up, elevator-*seeking* -- see `TourElevatorExcursion.ts`) needs --
 * satisfied by `ElevatorSystem` itself as-is (see this module's doc comment).
 */
export interface TourElevatorPort {
  /** The shaft (if any) whose ride column contains world (x, z). */
  shaftAt(x: number, z: number): ElevatorShaft | null;
  /** The support surface a rider standing at `feet` should ride against, or null outside any shaft's column. */
  supportAt(feet: readonly [number, number, number]): SupportSurface | null;
  /** Requests the car serving `shaft` travel to the adjacent stop in `direction`; no-op if busy or already at the end. */
  callElevator(shaft: ElevatorShaft, direction: 1 | -1): void;
  /**
   * Every currently-functional shaft in the city (see `ElevatorScanner.ts`'s
   * `MIN_STOPS_FOR_FUNCTIONAL_SHAFT`) -- used by `TourElevatorExcursion.ts`
   * to find the nearest one to deliberately walk toward. Not needed for
   * riding itself (`shaftAt`/`supportAt`/`callElevator` are enough for that),
   * only for seeking.
   */
  shafts(): readonly ElevatorShaft[];
}

/**
 * Chance, each time the walker arrives at a cell that's a boardable
 * elevator's doorway at its own current level, that it detours onto the
 * elevator instead of continuing to wander -- "may," not "always" (task
 * requirement), mirroring `Pedestrian.ts`'s `TAKE_STAIRS_CHANCE` for the same
 * reason: elevator use should read as a rare, occasional detour, not every
 * passing walker beelining for the nearest shaft.
 */
const RIDE_CHANCE = 0.15;

/**
 * How long (seconds) the walker waits at a shaft's well for the car to
 * settle at its own stop before giving up and walking back to resume
 * ordinary wandering -- see the `waiting` phase. In ordinary play this
 * almost never actually elapses: boarding is only ever *decided* (see
 * `maybeBeginElevatorRide`) when the car is already confirmed parked at the
 * walker's own stop, exactly like a real play-mode rider must already be
 * standing on the platform to call it. The one way this can go stale after
 * that is the car having been left mid-transit by a previous session (e.g. a
 * play-mode ride still coasting to its target at the moment of a mode
 * switch) and not settling here in time -- a genuine, if rare, case, so this
 * is a real bounded escape hatch, not a dead branch.
 */
const MAX_WAIT_SECONDS = 5;

/** Horizontal arrival tolerance for the approach/exit/retreat walks, matching `entities/Pedestrian.ts`'s own `ARRIVE_EPS` -- kept as a separate constant (not imported) since the two modules deliberately have no dependency in that direction; see this module's doc comment. */
const ARRIVE_EPS = 0.02;

/** Tolerance for "the car is parked exactly at this feetY," matching `PlayerCollision.ts`'s `SUPPORT_RIDE_EPS` convention. */
const PARKED_EPS = 0.01;

/** How many outward rings to search from a stop's doorway for real walkable floor -- see `findWalkableLandingNear`. Small and bounded: a genuine sky-lobby/deck landing is expected right at or immediately beside the doorway, not across the map. */
const LANDING_SEARCH_RADIUS = 4;

/**
 * `ElevatorShaft.stops` (and everything derived from it: `shaft.doorCells`'
 * matching row, `ElevatorSimulation`'s `car.feetY`, `SupportSurface.surfaceY`)
 * uses `gen/infrastructure.ts`'s `elevatorDeckYs` convention: each stop is a
 * *floor slab* row, with the actual walkable/standable voxel one row above it
 * (`deckY + 1`) -- see that function's own doc comment. `NavGrid`/`Pedestrian`
 * instead label a walkable surface by the row the solid material *itself*
 * occupies (`groundY`, `ElevatedLevel.y`, `StairLink.levelY` are all this),
 * with the walker's own body occupying the row above that. Both conventions
 * describe the exact same physical floor -- there's no real height
 * difference to smooth over, only a one-row labeling offset between the two
 * layers (confirmed structurally: `elevatorDeckYs`' ground entry is
 * `baseY - 1`, exactly `NavGrid.groundY`, and its derived stop is `baseY`,
 * exactly `groundY + 1` -- the same relationship holds at every other stop
 * too, since every deck stop is anchored to a real `SkyLobby`/roof slab whose
 * own row is what `NavGrid` labels the level by). So converting between them
 * is a plain +-1, applied only at the two boundaries where a walker-space `y`
 * meets a shaft-space `stops`/`feetY` value -- never by moving the walker's
 * `y` an extra voxel, which would be a real (if tiny) visible pop for no
 * physical reason.
 */
function shaftFeetYToWalkerY(shaftFeetY: number): number {
  return shaftFeetY - 1;
}

/** Exported so `TourElevatorExcursion.ts` can match a shaft's `stops` entries against the walker's own (walker-space) `y` the same way this module does. */
export function walkerYToShaftFeetY(walkerY: number): number {
  return walkerY + 1;
}

export type TourElevatorPhase = 'approaching' | 'waiting' | 'riding' | 'exiting' | 'retreating';

export interface TourElevatorRideState {
  readonly shaft: ElevatorShaft;
  readonly direction: 1 | -1;
  readonly boardStopIndex: number;
  readonly destinationStopIndex: number;
  /** The doorway cell the walker started from -- `retreating` walks back here if the wait budget expires. Already known-walkable: it's wherever ordinary wandering had already put the walker. */
  readonly originDoorCell: { readonly x: number; readonly z: number };
  /** The confirmed-walkable cell the walker will resume ordinary wandering from once the ride completes (see `findWalkableLandingNear`). */
  readonly destinationDoorCell: { readonly x: number; readonly z: number };
  /** The board level's surface Y -- also `shaft.stops[boardStopIndex]`, kept alongside for readable comparisons at call sites. */
  readonly boardFeetY: number;
  /** The destination level's surface Y -- also `shaft.stops[destinationStopIndex]`. */
  readonly destinationFeetY: number;
  phase: TourElevatorPhase;
  waitedSeconds: number;
}

const NEIGHBOR_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/** True if the car serving `shaft` is currently parked (not mid-transit) exactly at `feetY`. */
function isCarParkedAt(port: TourElevatorPort, shaft: ElevatorShaft, feetY: number): boolean {
  const support = port.supportAt([shaft.wellX + 0.5, feetY, shaft.wellZ + 0.5]);
  return support !== null && support.deltaY === 0 && Math.abs(support.surfaceY - feetY) <= PARKED_EPS;
}

/**
 * Expanding-ring search (same technique as `TourWalker.ts`'s
 * `findNearestWalkableGroundCell`, generalized from ground-only to any
 * level via `isWalkableSurfaceCell`) for the closest walkable cell to a
 * stop's doorway. A doorway's own wall-cell (see `ElevatorShaft.doorCells`)
 * is a real physical opening, but isn't necessarily itself classified
 * walkable by `NavGrid` (e.g. a ground-floor doorway opening into a tower's
 * own interior, which `buildNavGrid`'s ground scan only recognizes as
 * sidewalk/gravel material, not "any standable floor") -- this finds the
 * nearest confirmed-real floor near it instead of assuming the doorway cell
 * itself is standable.
 */
export function findWalkableLandingNear(grid: NavGrid, feetY: number, centerX: number, centerZ: number): { x: number; z: number } | null {
  for (let radius = 0; radius <= LANDING_SEARCH_RADIUS; radius++) {
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dz = -radius; dz <= radius; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== radius) continue;
        const x = centerX + dx;
        const z = centerZ + dz;
        if (isWalkableSurfaceCell(grid, feetY, x, z)) return { x, z };
      }
    }
  }
  return null;
}

interface RidableDirection {
  direction: 1 | -1;
  destinationIndex: number;
  destinationFeetY: number;
  landing: { x: number; z: number };
}

/**
 * Call exactly once per tick that the ordinary wander step (`stepTourWalker`)
 * just moved the walker on from `arrivedCellX`/`arrivedCellZ` -- the cell it
 * was centered on this tick, before `chooseNextCell` picked its next target,
 * i.e. the same "just arrived, about to set off again" instant
 * `entities/Pedestrian.ts`'s own `chooseNextCell` runs at. Returns a fresh
 * ride commitment (the caller must then undo the ordinary move it just made
 * -- see `TourController.update`) only when `arrivedCellX`/`arrivedCellZ` is
 * exactly some shaft's doorway at the walker's own current level, that
 * doorway has a further stop in some direction whose own doorway leads to
 * confirmed-walkable floor nearby (never a "phantom" doorway -- see
 * `findWalkableLandingNear`), the car is already confirmed parked at the
 * walker's own stop (riding is only ever attempted when the walker could
 * physically already be standing on the car, exactly like a real play-mode
 * rider must be), and a `RIDE_CHANCE` roll lands. Returns null on every other
 * tick, which is the vast majority of them.
 */
export function maybeBeginElevatorRide(
  walker: TourWalker,
  arrivedCellX: number,
  arrivedCellZ: number,
  grid: NavGrid,
  port: TourElevatorPort,
  rng: Rng,
): TourElevatorRideState | null {
  for (const [dx, dz] of NEIGHBOR_OFFSETS) {
    const shaft = port.shaftAt(arrivedCellX + dx, arrivedCellZ + dz);
    if (!shaft) continue;

    const boardFeetY = walkerYToShaftFeetY(walker.y);
    const boardStopIndex = shaft.stops.findIndex((y, i) => {
      const door = shaft.doorCells[i];
      return y === boardFeetY && door?.x === arrivedCellX && door?.z === arrivedCellZ;
    });
    if (boardStopIndex === -1) continue;

    const candidateDirections: Array<1 | -1> = [];
    if (boardStopIndex > 0) candidateDirections.push(-1);
    if (boardStopIndex < shaft.stops.length - 1) candidateDirections.push(1);

    const ridable: RidableDirection[] = [];
    for (const direction of candidateDirections) {
      const destinationIndex = boardStopIndex + direction;
      const destinationFeetY = shaft.stops[destinationIndex] as number;
      const doorCell = shaft.doorCells[destinationIndex] as { x: number; z: number };
      const landing = findWalkableLandingNear(grid, shaftFeetYToWalkerY(destinationFeetY), doorCell.x, doorCell.z);
      if (landing) ridable.push({ direction, destinationIndex, destinationFeetY, landing });
    }
    if (ridable.length === 0) continue;
    if (!isCarParkedAt(port, shaft, boardFeetY)) continue;
    if (!rng.chance(RIDE_CHANCE)) return null;

    const chosen = ridable.length === 1 ? (ridable[0] as RidableDirection) : rng.pick(ridable);

    return {
      shaft,
      direction: chosen.direction,
      boardStopIndex,
      destinationStopIndex: chosen.destinationIndex,
      originDoorCell: { x: arrivedCellX, z: arrivedCellZ },
      destinationDoorCell: chosen.landing,
      boardFeetY,
      destinationFeetY: chosen.destinationFeetY,
      phase: 'approaching',
      waitedSeconds: 0,
    };
  }
  return null;
}

/** Moves `walker`'s x/z toward (targetX, targetZ) at its own walking speed, same convention as `entities/Pedestrian.ts`'s cell-to-cell walk -- returns true once arrived (and snaps exactly onto the target). Exported so `TourElevatorExcursion.ts` can walk a multi-waypoint path the same way. */
export function stepToward(walker: TourWalker, targetX: number, targetZ: number, dt: number): boolean {
  const toX = targetX - walker.x;
  const toZ = targetZ - walker.z;
  const dist = Math.hypot(toX, toZ);
  if (dist < ARRIVE_EPS) {
    walker.x = targetX;
    walker.z = targetZ;
    return true;
  }
  const step = Math.min(dist, walker.speed * dt);
  walker.x += (toX / dist) * step;
  walker.z += (toZ / dist) * step;
  return false;
}

function advance(walker: TourWalker, state: TourElevatorRideState, dt: number, port: TourElevatorPort): TourElevatorRideState | null {
  const { shaft } = state;
  const wellX = shaft.wellX + 0.5;
  const wellZ = shaft.wellZ + 0.5;

  switch (state.phase) {
    case 'approaching': {
      if (!stepToward(walker, wellX, wellZ, dt)) return state;
      walker.cellX = shaft.wellX;
      walker.cellZ = shaft.wellZ;
      if (isCarParkedAt(port, shaft, state.boardFeetY)) {
        port.callElevator(shaft, state.direction);
        return { ...state, phase: 'riding' };
      }
      // The car we confirmed parked when the ride began has, rarely, since
      // moved off this stop on its own (see MAX_WAIT_SECONDS' doc comment) --
      // wait for it to settle back here rather than boarding thin air.
      return { ...state, phase: 'waiting', waitedSeconds: 0 };
    }

    case 'waiting': {
      if (isCarParkedAt(port, shaft, state.boardFeetY)) {
        port.callElevator(shaft, state.direction);
        return { ...state, phase: 'riding' };
      }
      const waitedSeconds = state.waitedSeconds + dt;
      if (waitedSeconds > MAX_WAIT_SECONDS) {
        return { ...state, phase: 'retreating' };
      }
      return { ...state, waitedSeconds };
    }

    case 'riding': {
      const support = port.supportAt([wellX, state.boardFeetY, wellZ]);
      // `support.surfaceY` is shaft-space (matches `state.boardFeetY`/
      // `destinationFeetY`); `walker.y` is walker-space throughout the rest
      // of this state machine (approach/exit/retreat never touch it) -- this
      // is the one place a per-tick conversion is actually needed, since this
      // is the one place walker.y tracks a continuously-moving shaft-space
      // value (see this module's doc comment on the two conventions).
      if (support) walker.y = shaftFeetYToWalkerY(support.surfaceY);
      const arrived = support !== null && support.deltaY === 0 && Math.abs(support.surfaceY - state.destinationFeetY) <= PARKED_EPS;
      if (!arrived) return state;
      walker.y = shaftFeetYToWalkerY(state.destinationFeetY);
      return { ...state, phase: 'exiting' };
    }

    case 'exiting': {
      const dest = state.destinationDoorCell;
      if (!stepToward(walker, dest.x + 0.5, dest.z + 0.5, dt)) return state;
      walker.cellX = dest.x;
      walker.cellZ = dest.z;
      walker.dirX = Math.sign(dest.x - shaft.wellX);
      walker.dirZ = Math.sign(dest.z - shaft.wellZ);
      return null; // ride complete -- resume ordinary wandering on the new level
    }

    case 'retreating': {
      const origin = state.originDoorCell;
      if (!stepToward(walker, origin.x + 0.5, origin.z + 0.5, dt)) return state;
      walker.cellX = origin.x;
      walker.cellZ = origin.z;
      walker.dirX = Math.sign(origin.x - shaft.wellX);
      walker.dirZ = Math.sign(origin.z - shaft.wellZ);
      return null; // gave up -- resume ordinary wandering from where it started
    }
  }
}

/**
 * Advances an in-progress elevator ride by one fixed tick. Returns the
 * (possibly updated) state to keep riding next tick, or `null` once the ride
 * has fully finished -- either arrived and stepped off, or gave up and
 * walked back -- either way leaving `walker` standing on a real,
 * already-confirmed-walkable cell, so the caller (`TourController.update`)
 * can safely resume ordinary `stepTourWalker` from there.
 *
 * Captures/snaps the walker's own render-interpolation `prev*` fields itself
 * every tick, the same three-call shape `stepTourWalker` uses for ordinary
 * wandering -- riding bypasses `stepPedestrian` entirely (see this module's
 * doc comment on why elevator state lives here, not in `Pedestrian`), so
 * nothing else does this while a ride is in progress. `snapRenderPrevIfTeleported`
 * uses `walker.speed` (its ordinary horizontal walking pace) for its
 * per-tick safety margin, unmodified -- that's still safe here even though
 * `riding` moves vertically at the faster `ELEVATOR_SPEED`, because the
 * teleport threshold already scales with `TELEPORT_SAFETY_FACTOR` (8x), and
 * `ELEVATOR_SPEED` (3) is comfortably under `walker.speed * 8` (~11.2) for
 * every walking pace this game uses -- widening the margin per-phase would
 * be defensive-not-load-bearing, not a correctness requirement.
 */
export function stepTourElevatorRide(
  walker: TourWalker,
  state: TourElevatorRideState,
  dt: number,
  port: TourElevatorPort,
): TourElevatorRideState | null {
  captureRenderPrevState(walker);
  const next = advance(walker, state, dt, port);
  snapRenderPrevIfTeleported(walker, dt);
  return next;
}
