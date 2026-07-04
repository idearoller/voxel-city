/**
 * Pedestrian NPC simulation: cell-to-cell walking along the sidewalk grid,
 * plus (see `StairCommitment`) an optional vertical detour up or down a
 * `NavGrid.StairLink` connecting the ground row to an elevated deck. Pure
 * state + step function, no Three.js — `EntitySystem` drives this and hands
 * the result to the presentation layer (`engine/EntityRenderer`).
 */

import { isWalkableSurfaceCell, type NavGrid, type StairLink } from './NavGrid';
import type { Rng } from '../gen/rng';

/**
 * A pedestrian's commitment to walking a `StairLink` end-to-end, once begun.
 * `index` is the `link.steps` entry currently being walked toward; `direction`
 * is +1 while climbing (`steps` in increasing index, ground -> deck) or -1
 * while descending (deck -> ground). No mid-stair reversal is possible by
 * construction — `stepStairTransit` only ever advances `index` by
 * `direction`, never consults `Rng`, and `chooseNextCell` (where a normal
 * walker's turn-around logic lives) never runs while this is set.
 */
export interface StairCommitment {
  readonly link: StairLink;
  index: number;
  direction: 1 | -1;
}

export interface Pedestrian {
  /** Continuous world position, mid-stride between cell centers (or mid-riser while `stair` is set — see `stair`'s doc comment). */
  x: number;
  z: number;
  /** The sidewalk/deck/stair-step cell this pedestrian is currently walking towards. */
  cellX: number;
  cellZ: number;
  /**
   * The surface Y this pedestrian's feet rest on: `grid.groundY` for a
   * sidewalk/park-path walker, or one of `grid.elevatedLevels[].y` for a
   * skybridge/walkway walker. Fixed while `stair` is null; while mid-stair
   * (see `stair`) this instead interpolates continuously between the two —
   * the same "seek the target cell" treatment `x`/`z` already get, just
   * added to the vertical axis, which is what gives a climbing pedestrian a
   * smooth rise instead of a snap. `EntityRenderer` already reads this
   * directly (`feetY = ped.y + 1`) so a fractional value here "just works"
   * visually with no renderer change.
   */
  y: number;
  /** Current heading: one of -1/0/1 per axis, at most one axis nonzero. Zero,zero only at the instant of spawn. */
  dirX: number;
  dirZ: number;
  speed: number;
  /** False once the pedestrian has nowhere left to go (isolated cell, or its cell stopped being walkable) — the simulation removes it next tick. */
  alive: boolean;
  /**
   * Non-null exactly while this pedestrian is walking a stair (see
   * `StairCommitment`). Elevated NPCs are no longer unconditionally
   * deck-bound (contrast `NavGrid`'s doc comment describing the *nav data*,
   * which is still per-level): a wandering pedestrian that reaches a stair's
   * ground or deck landing may (see `TAKE_STAIRS_CHANCE`) detour onto it and
   * cross to the other surface, then resume ordinary wandering there.
   */
  stair: StairCommitment | null;
}

/** Distance below which a pedestrian is considered to have arrived at its target cell's center. */
const ARRIVE_EPS = 0.02;

/** Chance to take an available turn instead of continuing straight when both are on offer — keeps foot traffic from reading as a bunch of NPCs walking in dead-straight lines forever. */
const TURN_CHANCE_AT_INTERSECTION = 0.35;

/**
 * Chance a pedestrian standing at a stair's ground or deck landing detours
 * onto it instead of continuing to wander that surface — "may," not
 * "always" (task requirement), so stair traffic reads as a fraction of foot
 * traffic rather than everyone beelining for the nearest staircase. When the
 * landing has no other walkable neighbor at all (`candidates.length === 0` in
 * `chooseNextCell`), the stair is taken unconditionally regardless of this
 * roll — the alternative would be despawning at a live, walkable stair
 * entrance for no reason other than an unlucky roll.
 */
const TAKE_STAIRS_CHANCE = 0.5;

const NEIGHBOR_DIRS: readonly [number, number][] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/** Spawns a pedestrian already centered on (cellX, cellZ) at surface `y` — its first `step` will immediately pick a real heading. */
export function createPedestrianAt(cellX: number, cellZ: number, y: number, speed: number): Pedestrian {
  return {
    x: cellX + 0.5,
    z: cellZ + 0.5,
    cellX,
    cellZ,
    y,
    dirX: 0,
    dirZ: 0,
    speed,
    alive: true,
    stair: null,
  };
}

/**
 * Every stair link whose ground or deck landing is exactly `ped`'s current
 * cell — i.e. every stair `ped` could detour onto right now. Matches by
 * `ped.y` first (a ground-level pedestrian can only ever enter at a link's
 * `steps[0]`, an elevated one only at its `steps[last]`) so an elevated
 * walker on a *different* level than a link's own `levelY` never matches it.
 *
 * Usually at most one match. A tower with more than one bridge level shares
 * one continuous stair shaft (see `infrastructure.ts`'s `planStairShafts`),
 * so its ground landing is the *same* cell for every level's `StairLink` —
 * more than one real match here is expected in that case, not a bug, which
 * is why `chooseNextCell` picks among them with `rng` instead of always
 * taking the first (that would make every climb at that tower head for
 * whichever level happened to be derived first, every time).
 */
function findStairEntriesAtCurrentCell(ped: Pedestrian, grid: NavGrid): Array<{ link: StairLink; direction: 1 | -1 }> {
  const entries: Array<{ link: StairLink; direction: 1 | -1 }> = [];
  for (const link of grid.stairLinks) {
    const steps = link.steps;
    const ground = steps[0] as { x: number; y: number; z: number };
    const deck = steps[steps.length - 1] as { x: number; y: number; z: number };

    if (ped.y === grid.groundY && ped.cellX === ground.x && ped.cellZ === ground.z) entries.push({ link, direction: 1 });
    else if (ped.y === link.levelY && ped.cellX === deck.x && ped.cellZ === deck.z) entries.push({ link, direction: -1 });
  }
  return entries;
}

/**
 * Commits `ped` to walking `link` starting from its current
 * (already-arrived-at) landing cell, heading toward the first step in
 * `direction`. Exported so tests can force a deterministic stair crossing
 * without depending on an `Rng` roll landing a particular way — the same
 * seam existing tests already use for edits (e.g. directly mutating
 * `grid.elevatedLevels[].walkable`), just for this state instead of `grid`'s.
 */
export function beginStair(ped: Pedestrian, link: StairLink, direction: 1 | -1): void {
  const index = direction === 1 ? 1 : link.steps.length - 2;
  const next = link.steps[index] as { x: number; z: number };
  ped.stair = { link, index, direction };
  ped.dirX = Math.sign(next.x - ped.cellX);
  ped.dirZ = Math.sign(next.z - ped.cellZ);
}

function chooseNextCell(ped: Pedestrian, grid: NavGrid, rng: Rng): void {
  const candidates = NEIGHBOR_DIRS.filter(([dx, dz]) => isWalkableSurfaceCell(grid, ped.y, ped.cellX + dx, ped.cellZ + dz));

  const stairEntries = findStairEntriesAtCurrentCell(ped, grid);
  if (stairEntries.length > 0 && (candidates.length === 0 || rng.chance(TAKE_STAIRS_CHANCE))) {
    const entry = stairEntries.length === 1 ? (stairEntries[0] as { link: StairLink; direction: 1 | -1 }) : rng.pick(stairEntries);
    beginStair(ped, entry.link, entry.direction);
    return;
  }

  if (candidates.length === 0) {
    ped.alive = false;
    return;
  }

  const isReverse = ([dx, dz]: readonly [number, number]): boolean => dx === -ped.dirX && dz === -ped.dirZ;
  const nonReverse = candidates.filter((d) => !isReverse(d));

  let choice: readonly [number, number];
  if (nonReverse.length === 0) {
    // Dead end: reversing is the only option.
    choice = candidates[0] as [number, number];
  } else {
    const straight = nonReverse.find(([dx, dz]) => dx === ped.dirX && dz === ped.dirZ);
    if (straight && (nonReverse.length === 1 || !rng.chance(TURN_CHANCE_AT_INTERSECTION))) {
      choice = straight;
    } else {
      const turnOptions = straight ? nonReverse.filter((d) => d !== straight) : nonReverse;
      choice = rng.pick(turnOptions.length > 0 ? turnOptions : nonReverse);
    }
  }

  ped.dirX = choice[0];
  ped.dirZ = choice[1];
  ped.cellX += choice[0];
  ped.cellZ += choice[1];
}

/**
 * Advances a pedestrian mid-stair by `dt` seconds: seeks the next
 * `link.steps` entry in 3D (x, y and z all interpolate together, exactly
 * like a normal cell-to-cell walk except `y` moves too — see `Pedestrian.y`'s
 * doc comment), snapping to it and advancing `index` by `direction` on
 * arrival. Reaching past either end of `steps` completes the crossing: the
 * commitment is cleared and the pedestrian resumes ordinary wandering on the
 * new surface next tick. Despawns gracefully, mid-run, if `grid` no longer
 * lists this pedestrian's own stair — the same "an edit made my footing
 * disappear" pattern `stepPedestrian` already applies to a plain sidewalk/deck
 * cell (see its own doc comment), just checked against `stairLinks` instead.
 */
function stepStairTransit(ped: Pedestrian, dt: number, grid: NavGrid): void {
  const stair = ped.stair as StairCommitment;

  if (!grid.stairLinks.includes(stair.link)) {
    ped.alive = false;
    return;
  }

  const steps = stair.link.steps;
  const target = steps[stair.index] as { x: number; y: number; z: number };
  const targetX = target.x + 0.5;
  const targetZ = target.z + 0.5;
  const toX = targetX - ped.x;
  const toY = target.y - ped.y;
  const toZ = targetZ - ped.z;
  const dist = Math.hypot(toX, toY, toZ);

  if (dist < ARRIVE_EPS) {
    ped.x = targetX;
    ped.z = targetZ;
    ped.y = target.y;
    ped.cellX = target.x;
    ped.cellZ = target.z;

    const nextIndex = stair.index + stair.direction;
    if (nextIndex < 0 || nextIndex >= steps.length) {
      ped.stair = null; // reached the far landing -- resume ordinary wandering on the new surface
      return;
    }

    const next = steps[nextIndex] as { x: number; z: number };
    ped.dirX = Math.sign(next.x - target.x);
    ped.dirZ = Math.sign(next.z - target.z);
    stair.index = nextIndex;
    return;
  }

  const move = Math.min(dist, ped.speed * dt);
  ped.x += (toX / dist) * move;
  ped.y += (toY / dist) * move;
  ped.z += (toZ / dist) * move;
}

/** Advances a pedestrian by `dt` seconds: walks toward its current target cell center, picking a new one on arrival (or, mid-stair, toward its current target step — see `stepStairTransit`). */
export function stepPedestrian(ped: Pedestrian, dt: number, grid: NavGrid, rng: Rng): void {
  if (!ped.alive) return;

  if (ped.stair) {
    stepStairTransit(ped, dt, grid);
    return;
  }

  // Its own current cell may have stopped being walkable since it was chosen
  // (a rebuilt NavGrid whose deck/sidewalk shrank underneath it — see
  // `Pedestrian.y`'s doc comment). Catching that here, rather than only when
  // `chooseNextCell` next runs out of candidates, is what keeps a pedestrian
  // from lingering mid-air over a since-removed deck cell.
  if (!isWalkableSurfaceCell(grid, ped.y, ped.cellX, ped.cellZ)) {
    ped.alive = false;
    return;
  }

  const targetX = ped.cellX + 0.5;
  const targetZ = ped.cellZ + 0.5;
  const toX = targetX - ped.x;
  const toZ = targetZ - ped.z;
  const dist = Math.hypot(toX, toZ);

  if (dist < ARRIVE_EPS) {
    ped.x = targetX;
    ped.z = targetZ;
    chooseNextCell(ped, grid, rng);
    return;
  }

  const step = Math.min(dist, ped.speed * dt);
  ped.x += (toX / dist) * step;
  ped.z += (toZ / dist) * step;
}
