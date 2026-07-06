/**
 * Tour-mode-only elevator *seeking*: occasionally, after wandering
 * organically for a while without a ride, the tour walker deliberately
 * detours toward the nearest functional elevator shaft's door on its current
 * level and walks there via a bounded graph search over the `NavGrid`, then
 * resumes ordinary wandering right at that door -- letting
 * `TourElevatorRide.ts`'s own `maybeBeginElevatorRide` (its `RIDE_CHANCE`
 * roll) decide from there, exactly as if the walker had reached that door
 * organically.
 *
 * This exists because riding purely opportunistically (only when ordinary
 * wander happens to pass a door) measured as *decorative*, not just rare, on
 * real generated cities: a real-stack soak (5 seeds x 40,000 ticks, one
 * random spawn each) produced zero eligible arrivals -- the walker never got
 * near a shaft at all, let alone rolled to board one. A city has only a
 * handful of functional shafts total (often 0-4), so a random walk from one
 * spawn point essentially never passes a specific building's door within any
 * bounded session, even though the same walk reaches *some* stair (a far
 * more numerous structure) far more often. Excursions close that gap without
 * touching the actual `RIDE_CHANCE` roll or the ride mechanics themselves --
 * they only make "does the walker ever get near a door" happen at a
 * reasonable cadence; whether it actually boards once there is still down to
 * chance, so the overall behavior still reads as occasional, not guaranteed
 * or dominating (see `EXCURSION_IDLE_SECONDS`/`EXCURSION_CHANCE_PER_ARRIVAL`'s
 * own doc comments for the tuning).
 *
 * Deliberately a *separate* module from `TourElevatorRide.ts`, not a folded-in
 * extension of it: seeking (navigating toward a door) and riding (operating
 * the car once there) are different concerns with different failure modes
 * (a seek can fail to find a reachable door at all; a ride can't, by
 * construction, since it never starts unless a landing was already verified
 * walkable). Same architecture as that module, though, and reuses its shared
 * pure helpers directly (`stepToward`, `findWalkableLandingNear`,
 * `walkerYToShaftFeetY`) rather than duplicating them: tour-only, lives in
 * `player/`, pure logic behind the same narrow `TourElevatorPort`, no changes
 * to `entities/Pedestrian.ts`'s shared wander/turn logic. BFS over the
 * walkable grid (not greedy neighbor-descent) guarantees a genuine shortest
 * path or a clean "unreachable within budget" `null` -- no risk of wedging on
 * a concave obstacle the way a greedy walk toward a door's raw (dx, dz) could
 * -- and its one-off cost (bounded node budget, see `MAX_BFS_VISITED`) is
 * paid once per excursion *decision* (roughly once a minute), never per tick.
 *
 * This module also owns the one deliberate exception to task #37's "tour
 * starts from/near your current position" promise: `pickTourSpawnCell`,
 * gated by `canReachFunctionalShaft` so it only overrides that promise when
 * the player's own spawn island genuinely has no reachable shaft at all --
 * see that function's own doc comment.
 */

import { isWalkableSurfaceCell, type NavGrid } from '../entities/NavGrid';
import { captureRenderPrevState, snapRenderPrevIfTeleported } from '../entities/Pedestrian';
import type { ElevatorShaft } from '../elevators/ElevatorScanner';
import type { Rng } from '../gen/rng';
import { findWalkableLandingNear, stepToward, walkerYToShaftFeetY } from './TourElevatorRide';
import type { TourWalker } from './TourWalker';

/**
 * Seconds of ordinary wandering (mid-ride/mid-excursion ticks don't count --
 * see `TourController.update`) before an excursion becomes *eligible* to
 * start. Deliberately long relative to `EXCURSION_CHANCE_PER_ARRIVAL`'s own
 * per-arrival roll cadence (ordinary cell arrivals happen roughly every
 * 0.5-1s at `TOUR_WALK_SPEED`): the pair together aim for one excursion
 * attempt roughly every 45-60s of real wander time, so a full tour session
 * reads as "wanders on foot, occasionally rides an elevator," not "beelines
 * for the elevator every chance it gets."
 */
const EXCURSION_IDLE_SECONDS = 45;

/**
 * Chance, at each ordinary-wander cell arrival once `EXCURSION_IDLE_SECONDS`
 * has elapsed, that this is the tick an excursion actually begins -- kept
 * probabilistic (rather than "always at exactly 45s") so the cadence doesn't
 * read as suspiciously metronomic, mirroring `TourElevatorRide.ts`'s
 * `RIDE_CHANCE` in spirit (a roll, not a guarantee) even though this is a
 * different roll for a different decision.
 */
const EXCURSION_CHANCE_PER_ARRIVAL = 0.35;

/**
 * Hard cap on cells visited by the excursion-target BFS (see
 * `findPathToNearestShaftDoor`) -- generously above what a real city's
 * walkable network needs for any two connected points (a full 384x384 grid
 * is 147,456 cells total; sidewalk/deck cells are a small fraction of that),
 * while still bounding the one-off cost of a decision that runs only about
 * once a minute. A search that exhausts this budget without reaching any
 * shaft door is treated exactly like "no reachable shaft this level" --
 * quietly skipped, retried on the next eligible arrival, never a stall.
 */
const MAX_BFS_VISITED = 20_000;

const NEIGHBOR_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/** Mutable idle-timing state, owned and stepped by `TourController` every ordinary-wander tick -- same "plain counter, reset on commit" shape as `TourAutoLook.ts`'s own idle state. */
export interface TourExcursionIdleState {
  idleSeconds: number;
}

export function createTourExcursionIdleState(): TourExcursionIdleState {
  return { idleSeconds: 0 };
}

/** Call once per ordinary-wander tick (never while riding or already on an excursion) to advance the idle clock. */
export function stepExcursionIdleTimer(state: TourExcursionIdleState, dt: number): void {
  state.idleSeconds += dt;
}

export interface TourExcursionState {
  readonly path: ReadonlyArray<{ readonly x: number; readonly z: number }>;
  index: number;
}

/**
 * Chance, once `pickTourSpawnCell` has already confirmed the player's own
 * spawn island has NO functional shaft reachable at all, that this session
 * spawns near a random shaft's door instead of honoring task #37's "tour
 * starts from/near your current position" promise anyway.
 *
 * Deliberately well under 0.5: even on a shaft-less island, the large
 * majority of tour entries should still start exactly where the player was
 * -- the override exists only to keep giving *some* sessions a real shot at
 * a ride across many play sessions, not to make every shaft-less spawn a
 * coin flip on being redirected. 0.25 keeps "usually honors #37" genuinely
 * true (75% of shaft-less-island entries) while still contributing
 * meaningfully to overall ride frequency over repeated sessions -- and,
 * since nearly every real spawn cell turns out to be on a shaft-less island
 * in the first place (`entities/NavGrid.ts`'s sidewalk network fragments
 * into many small, mutually-disconnected "islands" per city block -- no
 * crosswalks are modeled; a bounded BFS from a real spawn found ~1,250
 * reachable cells out of ~87,000 sidewalk cells citywide, containing none of
 * that city's 3 shaft doors), the *gate* itself only rarely suppresses this
 * roll in practice: lowering this constant, not the gate, is what actually
 * restores "usually honors #37" without collapsing ride frequency (soak-
 * verified -- see this module's test suite and the task's own soak table).
 */
export const SPAWN_NEAR_SHAFT_CHANCE = 0.25;

/**
 * Picks a random functional shaft's own ground-level door cell, or `null` if
 * there are none or an `SPAWN_NEAR_SHAFT_CHANCE` roll doesn't land. Pure
 * chance + pick, with no reachability awareness of its own -- callers that
 * care about task #37's "starts from/near your position" promise should go
 * through `pickTourSpawnCell` instead, which gates this behind
 * `canReachFunctionalShaft` first; this is exported separately mainly so it
 * can be pinned in isolation (see this module's own tests).
 */
export function pickSpawnBiasedShaftDoor(shafts: readonly ElevatorShaft[], rng: Rng): { x: number; z: number } | null {
  if (shafts.length === 0) return null;
  if (!rng.chance(SPAWN_NEAR_SHAFT_CHANCE)) return null;

  const shaft = rng.pick(shafts);
  // `stops`/`doorCells` are built in ascending Y order (see
  // `gen/infrastructure.ts`'s `elevatorDeckYs`), so index 0 is always the
  // lowest stop -- always the ground floor, never a sky-lobby level.
  const groundDoor = shaft.doorCells[0];
  return groundDoor ? { x: groundDoor.x, z: groundDoor.z } : null;
}

/**
 * Every functional shaft's landing cell at `levelY` (walker-space), deduped
 * to one entry per shaft door via `findWalkableLandingNear` -- reused
 * directly from `TourElevatorRide.ts` rather than re-implemented, so
 * "walkable landing" means exactly the same thing for seeking as it does for
 * riding.
 */
function collectShaftLandingsAtLevel(
  grid: NavGrid,
  shafts: readonly ElevatorShaft[],
  levelY: number,
): Array<{ x: number; z: number }> {
  const boardFeetY = walkerYToShaftFeetY(levelY);
  const landings: Array<{ x: number; z: number }> = [];
  for (const shaft of shafts) {
    const stopIndex = shaft.stops.indexOf(boardFeetY);
    if (stopIndex === -1) continue;
    const doorCell = shaft.doorCells[stopIndex];
    if (!doorCell) continue;
    const landing = findWalkableLandingNear(grid, levelY, doorCell.x, doorCell.z);
    if (landing) landings.push(landing);
  }
  return landings;
}

/**
 * Bounded breadth-first search over `grid`'s walkable cells at `levelY`,
 * starting from (startX, startZ), for the shortest path to whichever of
 * `targets` is nearest -- BFS visits in non-decreasing distance order, so the
 * first target cell dequeued is guaranteed nearest, not just "some" reachable
 * one. Returns the path *excluding* the start cell (the walker is already
 * there) and *including* the target, or `null` if no target is reachable
 * within `MAX_BFS_VISITED` visited cells (treated as "not reachable this
 * attempt," not an error -- see this module's own doc comment).
 */
function findPathToNearestShaftDoor(
  grid: NavGrid,
  levelY: number,
  startX: number,
  startZ: number,
  targets: readonly { x: number; z: number }[],
): Array<{ x: number; z: number }> | null {
  if (targets.length === 0) return null;

  const targetKeys = new Set(targets.map((t) => `${t.x},${t.z}`));
  const startKey = `${startX},${startZ}`;
  if (targetKeys.has(startKey)) return []; // already standing on a door's own landing cell -- nothing to walk.

  const cameFrom = new Map<string, string>();
  const visited = new Set<string>([startKey]);
  const queue: Array<{ x: number; z: number }> = [{ x: startX, z: startZ }];
  let head = 0;
  let foundKey: string | null = null;

  while (head < queue.length && visited.size <= MAX_BFS_VISITED && !foundKey) {
    const cur = queue[head++] as { x: number; z: number };
    for (const [dx, dz] of NEIGHBOR_OFFSETS) {
      const nx = cur.x + dx;
      const nz = cur.z + dz;
      const key = `${nx},${nz}`;
      if (visited.has(key)) continue;
      if (!isWalkableSurfaceCell(grid, levelY, nx, nz)) continue;

      visited.add(key);
      cameFrom.set(key, `${cur.x},${cur.z}`);
      if (targetKeys.has(key)) {
        foundKey = key;
        break;
      }
      queue.push({ x: nx, z: nz });
    }
  }

  if (!foundKey) return null;

  const path: Array<{ x: number; z: number }> = [];
  let cursor: string | null = foundKey;
  while (cursor !== null && cursor !== startKey) {
    const [x, z] = cursor.split(',').map(Number) as [number, number];
    path.push({ x, z });
    cursor = cameFrom.get(cursor) ?? null;
  }
  path.reverse();
  return path;
}

/**
 * True if some functional shaft's door is reachable from (startX, startZ) at
 * `levelY` via the walkable NavGrid graph, within the same bounded BFS
 * budget `maybeBeginExcursion` itself uses (`MAX_BFS_VISITED`) -- i.e. "could
 * an excursion starting here eventually succeed, given enough idle cycles."
 * Used by `pickTourSpawnCell` to gate its spawn-bias override: if this is
 * already true, biasing spawn would only be overriding the player's own
 * intended starting spot for no reason -- an excursion will get there on its
 * own, no override needed.
 */
export function canReachFunctionalShaft(
  grid: NavGrid,
  levelY: number,
  startX: number,
  startZ: number,
  shafts: readonly ElevatorShaft[],
): boolean {
  const targets = collectShaftLandingsAtLevel(grid, shafts, levelY);
  return findPathToNearestShaftDoor(grid, levelY, startX, startZ, targets) !== null;
}

/**
 * Resolves the actual spawn cell for a new tour session -- the one
 * deliberate, bounded exception to task #37's "tour starts from/near your
 * current position" promise, and gated so it only ever applies when honoring
 * #37 literally would mean this session could never include a ride at all.
 *
 * `nearCell` (the ordinary "closest walkable cell to wherever the player
 * was" result -- what `TourController.start` would use on its own) is
 * returned unchanged unless `canReachFunctionalShaft` proves `nearCell`'s own
 * island has no functional shaft reachable at all, in which case
 * `pickSpawnBiasedShaftDoor`'s own `SPAWN_NEAR_SHAFT_CHANCE` roll gets a
 * chance to redirect the spawn to a random shaft's door instead. So: an
 * island that can already reach an elevator via excursions always spawns the
 * player exactly where they stood (task #37, honored in full); a
 * shaft-less island *usually* still does too (see that constant's own doc
 * comment), and only occasionally spawns near a shaft instead -- which is
 * the only way that particular island's tour session could ever include a
 * ride at all.
 */
export function pickTourSpawnCell(
  nearCell: { x: number; z: number },
  grid: NavGrid,
  shafts: readonly ElevatorShaft[],
  levelY: number,
  rng: Rng,
): { x: number; z: number } {
  if (shafts.length === 0) return nearCell;
  if (canReachFunctionalShaft(grid, levelY, nearCell.x, nearCell.z, shafts)) return nearCell;

  return pickSpawnBiasedShaftDoor(shafts, rng) ?? nearCell;
}

/**
 * Call exactly once per tick that ordinary wandering (not a ride, not
 * already an excursion) just completed a cell-to-cell hop -- same "just
 * arrived, about to set off again" instant `maybeBeginElevatorRide` hooks
 * (see that function's own doc comment); `arrivedCellX`/`arrivedCellZ` is
 * the pre-hop cell, exactly as that function expects. Returns a fresh
 * excursion (the caller must undo the ordinary move the same way it already
 * does for a ride -- see `TourController.update`) only once
 * `EXCURSION_IDLE_SECONDS` has elapsed, an `EXCURSION_CHANCE_PER_ARRIVAL`
 * roll lands, and a bounded BFS finds a real path to some functional shaft's
 * door at the walker's own level. Resets the idle timer whenever the roll
 * lands, win or lose (i.e. even if no shaft is reachable this attempt) --
 * deliberate: it caps how often the (bounded but non-trivial) BFS itself can
 * run to roughly once per idle cycle, rather than potentially every single
 * arrival once idle long enough.
 */
export function maybeBeginExcursion(
  walker: TourWalker,
  arrivedCellX: number,
  arrivedCellZ: number,
  grid: NavGrid,
  shafts: readonly ElevatorShaft[],
  idleState: TourExcursionIdleState,
  rng: Rng,
): TourExcursionState | null {
  if (idleState.idleSeconds < EXCURSION_IDLE_SECONDS) return null;
  if (!rng.chance(EXCURSION_CHANCE_PER_ARRIVAL)) return null;

  idleState.idleSeconds = 0;

  const targets = collectShaftLandingsAtLevel(grid, shafts, walker.y);
  const path = findPathToNearestShaftDoor(grid, walker.y, arrivedCellX, arrivedCellZ, targets);
  if (!path || path.length === 0) return null;

  const first = path[0] as { x: number; z: number };
  walker.dirX = Math.sign(first.x - arrivedCellX);
  walker.dirZ = Math.sign(first.z - arrivedCellZ);

  return { path, index: 0 };
}

function advance(walker: TourWalker, state: TourExcursionState, dt: number, grid: NavGrid): TourExcursionState | null {
  const waypoint = state.path[state.index];
  if (!waypoint) return null; // defensive: an empty/exhausted path shouldn't reach here, but never stall on it.

  // The world can change underneath a multi-tick excursion (a NavGrid
  // rebuild from a sandbox edit or environment refresh mid-session) -- abandon
  // cleanly back to ordinary wander rather than walking onto ground that's no
  // longer real, the same "don't trust a stale plan" defensiveness
  // `stepStairTransit` already applies to `grid.stairLinks`.
  if (!isWalkableSurfaceCell(grid, walker.y, waypoint.x, waypoint.z)) return null;

  if (!stepToward(walker, waypoint.x + 0.5, waypoint.z + 0.5, dt)) return state;

  walker.cellX = waypoint.x;
  walker.cellZ = waypoint.z;

  const nextIndex = state.index + 1;
  if (nextIndex >= state.path.length) {
    // Arrived at the final waypoint (a shaft door's own landing cell) --
    // heading already points here from the previous leg's transition (or
    // from `maybeBeginExcursion`'s own initial set, if this was a one-leg
    // path), so there's nothing left to compute; resume ordinary wandering
    // next tick, which is exactly the "just arrived" moment
    // `maybeBeginElevatorRide` hooks into.
    return null;
  }

  const next = state.path[nextIndex] as { x: number; z: number };
  walker.dirX = Math.sign(next.x - waypoint.x);
  walker.dirZ = Math.sign(next.z - waypoint.z);
  return { ...state, index: nextIndex };
}

/**
 * Advances an in-progress excursion by one fixed tick. Returns the (possibly
 * updated) state to keep walking next tick, or `null` once it's finished --
 * either arrived at a shaft's door, or gave up because the world changed
 * underneath it -- either way leaving `walker` standing on a real,
 * already-confirmed-walkable cell, so the caller (`TourController.update`)
 * can safely resume ordinary `stepTourWalker` from there.
 *
 * Captures/snaps the walker's own render-interpolation `prev*` fields itself
 * every tick, the same shape `stepTourElevatorRide` uses -- excursions bypass
 * `stepPedestrian` entirely (see this module's doc comment), so nothing else
 * does this while one is in progress.
 */
export function stepExcursion(walker: TourWalker, state: TourExcursionState, dt: number, grid: NavGrid): TourExcursionState | null {
  captureRenderPrevState(walker);
  const next = advance(walker, state, dt, grid);
  snapRenderPrevIfTeleported(walker, dt);
  return next;
}
