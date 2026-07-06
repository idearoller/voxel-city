/**
 * City-scale connective tissue that sits above individual buildings: sky
 * bridges between nearby towers, the internal stair shafts that reach them,
 * elevated downtown street-level walkways, streetlights, scattered
 * billboards, and non-functional elevator-shaft markers (a phase-2 hook).
 *
 * Every `plan*` function is pure — it only reads `BuildingPlan`/`CityLayout`
 * data already produced by `layout.ts`/`buildings.ts` — so bridge/stair
 * geometry invariants (riser height, headroom, deck width...) are testable
 * without touching a World. Every `write*` function performs the matching
 * `setBlockRaw` calls, per the gen/ boundary rule.
 */

import type { BuildingPlan, BuildingTier, DoorSide } from './buildings';
import { District } from './districts';
import { CellType, cellAt, type CityLayout, type Span } from './layout';
import type { Rng } from './rng';
import {
  AIR,
  CONCRETE,
  ELEVATOR_SHAFT,
  METAL,
  NEON_CYAN,
  NEON_PINK,
  NEON_PURPLE,
  NEON_YELLOW,
} from '../world/BlockRegistry';
import type { World } from '../world/World';

type Vec3 = { x: number; y: number; z: number };

/** Stable identity key for a tower, used to dedupe stair shafts / elevator shafts per building. */
function towerKey(building: BuildingPlan): string {
  return `${building.x},${building.z}`;
}

// ---------------------------------------------------------------------------
// Bridges / skywalks
// ---------------------------------------------------------------------------

const BRIDGE_MAX_GAP = 48;
const BRIDGE_CHANCE = 0.35;
/** Each tower can anchor at most this many bridges (to distinct partners and/or distinct levels), so a busy hub tower doesn't sprout an unreadable tangle of decks. */
const MAX_BRIDGES_PER_TOWER = 3;
/** A tower must clear the lowest sky level (plus deck/rail/headroom margin) to be a bridge candidate. */
const BRIDGE_MIN_TOWER_HEIGHT = 30;
/**
 * A tower's ground-tier footprint must be at least this wide/deep on both
 * axes to be a bridge candidate. The internal stair shaft is a fixed 3x3
 * centered on the footprint (see `stairShaftOrigin`); on a narrower tower
 * the shaft can eat into — or entirely replace — the one interior row of
 * floor margin around it, leaving the top step's own facing wall row inside
 * the shaft itself. 10 leaves several clear rows of walkable floor on every
 * side of the shaft, which is what the sky lobby needs to actually connect
 * the stairs to the bridge door rather than boxing the top step in.
 */
const BRIDGE_MIN_TOWER_FOOTPRINT = 10;
/**
 * Every 20 voxels rather than 30 (was `[30, 60, 90]`): with `planTiers`'
 * setback boundary timing (roughly 40-70% of a tower's own height for a
 * single setback, 40-55% for the first of two), very few real towers still
 * have a ground-footprint at y=60 by the time they're tall enough to clear
 * it with margin — measured on real generator output, multi-level stacking
 * (`pickSkyLevels` returning >1 eligible level for the same pair) occurred
 * on only ~1% of bridged towers with `[30, 60, 90]`, i.e. the machinery was
 * real but essentially dormant. A denser ladder gives more towers a second
 * (or third) level they can still clear before their own setback shrinks
 * the footprint, without changing anything about how a level is chosen or
 * how many bridges a tower may anchor (`MAX_BRIDGES_PER_TOWER` still caps
 * that).
 */
export const SKY_LEVELS = [30, 50, 70, 90] as const;
/**
 * Deck (1) + rail (1) + headroom (2) that must fit below the tower's roof at
 * the chosen sky level. Kept at its original total of 4 (rather than shrunk
 * to 3 to match the rail's own height dropping from 2 voxels to 1 — see
 * `writeBridgeDeckAndRails`) so eligibility is unchanged: this is a
 * conservative "does the level fit" gate, not a tight packing, and towers
 * that used to qualify should keep qualifying.
 */
const SKY_LEVEL_MARGIN = 4;
const BRIDGE_DECK_WIDTH = 3;

export interface Bridge {
  axis: 'x' | 'z';
  /** Absolute world Y of the solid deck surface; the walkable lane is level+1/level+2. */
  level: number;
  x: number;
  z: number;
  width: number;
  depth: number;
  towerA: BuildingPlan;
  towerB: BuildingPlan;
}

/**
 * Buildings with a planned shop interior are NOT excluded here (unlike
 * `planElevatorShafts`, which still excludes them — see that function's doc
 * comment). A bridge's internal stair shaft is *centered* on the tower's
 * footprint (see `stairShaftOrigin`): with `BRIDGE_MIN_TOWER_FOOTPRINT` >= 10
 * and a shop's ring sitting one cell in from the wall, the centered 3x3
 * shaft always lands inside the shop's core (one more cell in from the
 * ring), never on the ring itself — the elevator shaft's problem was its
 * *fixed NW-corner* anchor, which is a different footprint entirely. See
 * `shopInterior.ts`'s doc comment for the full picture and
 * `stairShaftFootprintColumns` for the geometry other modules rely on.
 */
function candidateTowers(buildings: readonly BuildingPlan[]): BuildingPlan[] {
  return buildings.filter(
    (b) =>
      b.height >= BRIDGE_MIN_TOWER_HEIGHT &&
      b.width >= BRIDGE_MIN_TOWER_FOOTPRINT &&
      b.depth >= BRIDGE_MIN_TOWER_FOOTPRINT,
  );
}

/**
 * The massing tier whose [yStart, yEnd) contains `absoluteY`, or the ground
 * tier as a fallback if `absoluteY` is somehow outside every tier (shouldn't
 * happen for any Y a caller has already height-checked, but a full-footprint
 * tier is a safer default than crashing). Callers that write floor slabs at
 * an arbitrary sky level MUST go through this rather than assuming tier0 —
 * a setback boundary can land exactly at that level and shrink the footprint.
 */
function tierAt(building: BuildingPlan, absoluteY: number): BuildingTier {
  const ry = absoluteY - building.baseY;
  const tier = building.tiers.find((t) => ry >= t.yStart && ry < t.yEnd);
  return tier ?? (building.tiers[0] as BuildingTier);
}

/** True if `absoluteY` falls inside a tier whose footprint still matches the ground tier (no setback yet). */
function isGroundFootprintAt(building: BuildingPlan, absoluteY: number): boolean {
  const tier = tierAt(building, absoluteY);
  const base = building.tiers[0] as BuildingTier;
  return tier.x === base.x && tier.z === base.z && tier.width === base.width && tier.depth === base.depth;
}

/**
 * True if there's no setback terrace deck within `minClearance` voxels above
 * `absoluteY`. `writeSetbackDecks` caps every non-top tier with a solid
 * CONCRETE slab across its *entire* footprint at y = baseY + tier.yEnd — the
 * same "floor caps headroom" problem `SkyLobby` works around for the sky
 * lobby's own floor, except this one is baked into the tower regardless of
 * whether it hosts a bridge. A bridge level chosen too close under one of
 * these decks would leave the stair's top step boxed in exactly like an
 * unguarded sky-lobby floor did — so a candidate level needs its own 3 clear
 * rows (the top step's row plus the 2 rows below it) before the next deck.
 */
function hasSetbackHeadroomAbove(building: BuildingPlan, absoluteY: number, minClearance: number): boolean {
  const tier = tierAt(building, absoluteY);
  const isTopTier = tier === building.tiers[building.tiers.length - 1];
  if (isTopTier) return true; // no further setback above — only the roof, already margin-checked separately.
  const deckY = building.baseY + tier.yEnd;
  return deckY - absoluteY >= minClearance;
}

interface GapInfo {
  axis: 'x' | 'z';
  gap: number;
  overlapStart: number;
  overlapEnd: number;
  /** True if `a` sits on the lower-coordinate side of the gap. */
  aFirst: boolean;
}

/** Finds the facing gap between two footprints along whichever axis actually separates them, if any. */
function gapBetween(a: BuildingPlan, b: BuildingPlan): GapInfo | null {
  const xGapAB = b.x - (a.x + a.width);
  const xGapBA = a.x - (b.x + b.width);
  if (xGapAB > 0 || xGapBA > 0) {
    const aFirst = xGapAB > 0;
    const gap = aFirst ? xGapAB : xGapBA;
    const overlapStart = Math.max(a.z, b.z);
    const overlapEnd = Math.min(a.z + a.depth, b.z + b.depth);
    if (overlapEnd - overlapStart >= BRIDGE_DECK_WIDTH) {
      return { axis: 'x', gap, overlapStart, overlapEnd, aFirst };
    }
  }
  const zGapAB = b.z - (a.z + a.depth);
  const zGapBA = a.z - (b.z + b.depth);
  if (zGapAB > 0 || zGapBA > 0) {
    const aFirst = zGapAB > 0;
    const gap = aFirst ? zGapAB : zGapBA;
    const overlapStart = Math.max(a.x, b.x);
    const overlapEnd = Math.min(a.x + a.width, b.x + b.width);
    if (overlapEnd - overlapStart >= BRIDGE_DECK_WIDTH) {
      return { axis: 'z', gap, overlapStart, overlapEnd, aFirst };
    }
  }
  return null;
}

/**
 * Every sky level (ascending) both towers clear, with margin, at their
 * un-setback-shrunk footprint — not just the highest. A tall enough pair can
 * host a bridge at each of several levels (subject to `MAX_BRIDGES_PER_TOWER`
 * and the per-pair/per-level chance roll in `planBridges`), which is what
 * gives a tall tower pair a stacked, multi-level bridge connection instead of
 * capping out at one.
 */
/** The top step's own row plus the 2 risers below it all need to clear any setback deck above. */
const STAIR_TOP_HEADROOM_CLEARANCE = 3;

function pickSkyLevels(a: BuildingPlan, b: BuildingPlan): number[] {
  const minTop = Math.min(a.baseY + a.height, b.baseY + b.height);
  const levels: number[] = [];
  for (const level of SKY_LEVELS) {
    if (level + SKY_LEVEL_MARGIN > minTop) continue;
    if (!isGroundFootprintAt(a, level) || !isGroundFootprintAt(b, level)) continue;
    if (
      !hasSetbackHeadroomAbove(a, level, STAIR_TOP_HEADROOM_CLEARANCE) ||
      !hasSetbackHeadroomAbove(b, level, STAIR_TOP_HEADROOM_CLEARANCE)
    ) {
      continue;
    }
    levels.push(level);
  }
  return levels;
}

interface Rect2D {
  x: number;
  z: number;
  width: number;
  depth: number;
}

function rectsOverlap(p: Rect2D, q: Rect2D): boolean {
  return p.x < q.x + q.width && p.x + p.width > q.x && p.z < q.z + q.depth && p.z + p.depth > q.z;
}

/**
 * True if some *other* building physically occupies the deck's footprint at
 * the deck's own Y level — i.e. a third tower sitting in the gap between the
 * two bridge towers, tall enough to reach that height. Buildings that don't
 * reach `level` at all (short neighbors) can't block it. The reachable range
 * is inclusive of the roof deck itself: `writeRoof` writes a full CONCRETE
 * slab at y = baseY + height (one past the last wall row), so a building
 * whose roof lands exactly on the bridge level still physically blocks it.
 */
function deckBlockedByOtherBuilding(
  deck: Rect2D,
  level: number,
  buildings: readonly BuildingPlan[],
  towerA: BuildingPlan,
  towerB: BuildingPlan,
): boolean {
  for (const building of buildings) {
    if (building === towerA || building === towerB) continue;
    if (level < building.baseY || level > building.baseY + building.height) continue;
    if (rectsOverlap(deck, tierAt(building, level))) return true;
  }
  return false;
}

/**
 * Plans sky bridges: every candidate tower pair within BRIDGE_MAX_GAP whose
 * footprints face each other with enough lateral overlap for a 3-wide deck
 * gets one bridge candidate *per* sky level they both clear (see
 * `pickSkyLevels`), each independently rolling a BRIDGE_CHANCE coin (forked
 * per pair *and* level, so it's independent of pair/level iteration order).
 *
 * A tower may host up to `MAX_BRIDGES_PER_TOWER` bridges total — to distinct
 * partner towers, at distinct levels, or both. Multiple bridges at
 * *different* levels on the same tower share one stair shaft: shafts are
 * keyed by (tower, level) in `planStairShafts`/`planSkyLobbies`, and every
 * level's shaft spirals up from the exact same 3x3 origin (see
 * `stairShaftOrigin`), so a higher-level shaft's steps are just a
 * continuation of a lower-level shaft's steps for the same tower — one
 * continuous staircase serves every bridge level that tower has, not a
 * separate climb per level. Multiple bridges at the *same* level on the same
 * tower (to different neighbors) share one sky-lobby floor the same way,
 * each carving its own door into its own facing wall.
 *
 * The gap between the two bridge towers is otherwise unchecked ground — a
 * third, unrelated building can sit in it. Its footprint at the bridge's
 * level (if it even reaches that high) is excluded from candidacy so the
 * deck can never be routed straight through someone else's wall.
 */
export function planBridges(buildings: readonly BuildingPlan[], rng: Rng): Bridge[] {
  const towers = candidateTowers(buildings);
  const bridgeCountByTower = new Map<string, number>();
  const bridges: Bridge[] = [];

  const hasCapacity = (tower: BuildingPlan) => (bridgeCountByTower.get(towerKey(tower)) ?? 0) < MAX_BRIDGES_PER_TOWER;

  for (let i = 0; i < towers.length; i++) {
    for (let j = i + 1; j < towers.length; j++) {
      const a = towers[i] as BuildingPlan;
      const b = towers[j] as BuildingPlan;
      if (!hasCapacity(a) || !hasCapacity(b)) continue;

      const info = gapBetween(a, b);
      if (!info || info.gap <= 0 || info.gap > BRIDGE_MAX_GAP) continue;

      const levels = pickSkyLevels(a, b);
      if (levels.length === 0) continue;

      const laneSpan = info.overlapEnd - info.overlapStart;
      const laneStart = info.overlapStart + Math.floor((laneSpan - BRIDGE_DECK_WIDTH) / 2);
      const [first, second] = info.aFirst ? [a, b] : [b, a];

      for (const level of levels) {
        if (!hasCapacity(a) || !hasCapacity(b)) break;

        const pairRng = rng.fork(`${towerKey(a)}-${towerKey(b)}-${level}`);
        if (!pairRng.chance(BRIDGE_CHANCE)) continue;

        const deck =
          info.axis === 'x'
            ? {
                axis: 'x' as const,
                x: first.x + first.width,
                z: laneStart,
                width: second.x - (first.x + first.width),
                depth: BRIDGE_DECK_WIDTH,
              }
            : {
                axis: 'z' as const,
                x: laneStart,
                z: first.z + first.depth,
                width: BRIDGE_DECK_WIDTH,
                depth: second.z - (first.z + first.depth),
              };

        if (deckBlockedByOtherBuilding(deck, level, buildings, first, second)) continue;

        bridgeCountByTower.set(towerKey(a), (bridgeCountByTower.get(towerKey(a)) ?? 0) + 1);
        bridgeCountByTower.set(towerKey(b), (bridgeCountByTower.get(towerKey(b)) ?? 0) + 1);
        bridges.push({ ...deck, level, towerA: first, towerB: second });
      }
    }
  }

  return bridges;
}

/**
 * Writes a bridge's solid METAL deck across the full 3-wide band and a
 * 1-high NEON rail along its two edge rows — but NOT the walkway clearing
 * (middle lane + both door openings); see `writeBridgeWalkway` for that, and
 * this pair's own doc comment for why they're split out rather than one
 * function like before.
 *
 * The rail is exactly 1 voxel tall (`level + 1`, i.e. flush with the deck's
 * own walking surface, nothing at `level + 2`) rather than the 2 voxels it
 * used to be. A standing player's eyes sit roughly 1.6-1.7m above the deck
 * they're walking on — comfortably inside the `level + 2` cell — so a
 * 2-high rail put solid material directly in the eyeline and walled off the
 * city while crossing a bridge. A 1-high rail tops out well below eye
 * height (classic low guard-rail look) while `level + 2` stays open sky.
 *
 * Deliberate tradeoff (Task 34): a 1-high rail is exactly the height
 * `tryAutoStep` (`src/player/PlayerCollision.ts`) climbs, unlike the old 2-high rail
 * which it always refused (taller obstacles get no benefit from the lift).
 * So a player who deliberately strafes off the walkable middle lane onto a
 * rail cell, then keeps moving the same direction, auto-steps onto the
 * rail's top and off the bridge's edge into open air one tick later — the
 * old rail made that impossible; this one doesn't. Left as-is rather than
 * "fixed": normal forward travel down the middle lane never touches a rail
 * cell (`writeBridgeWalkway` only clears/uses the lane one row in from
 * both rails), so this requires the same kind of deliberate sideways move a
 * real waist-high guard rail doesn't stop a person from climbing over
 * either — it reads as parkour, not an accidental fall, and NPCs can't do
 * it at all (`NavGrid`'s `walkable` grid never marks a rail cell walkable,
 * so pedestrian pathing never routes through one; see `buildElevatedLevel`).
 * Preventing it outright would need a collision shape shorter than a full
 * voxel that still renders/reads as 1 voxel tall, which this engine's
 * binary per-voxel collision doesn't support — worth revisiting only if
 * partial-height collision ever gets added for another reason.
 */
export function writeBridgeDeckAndRails(world: World, bridge: Bridge): void {
  const { axis, level, x, z, width, depth } = bridge;

  for (let dx = 0; dx < width; dx++) {
    for (let dz = 0; dz < depth; dz++) {
      world.setBlockRaw(x + dx, level, z + dz, METAL);
    }
  }

  if (axis === 'x') {
    for (let dx = 0; dx < width; dx++) {
      for (const railZ of [z, z + depth - 1]) {
        world.setBlockRaw(x + dx, level + 1, railZ, NEON_CYAN);
      }
    }
  } else {
    for (let dz = 0; dz < depth; dz++) {
      for (const railX of [x, x + width - 1]) {
        world.setBlockRaw(railX, level + 1, z + dz, NEON_CYAN);
      }
    }
  }
}

/**
 * Clears (to AIR, at `level + 1`/`level + 2`) the bridge's entire walkable
 * run: its own 1-wide middle lane for the deck's full length, plus the two
 * door cells one step beyond each end where the lane meets its towers' walls.
 * All one contiguous run along the bridge's own axis, from one door cell to
 * the other, which is why this is a single loop rather than "clear the middle
 * lane" and "carve the doors" as two separate steps like before.
 *
 * Split out from the deck/rail write (`writeBridgeDeckAndRails`) so a caller
 * writing a whole city's worth of bridges can run every bridge's deck+rails
 * pass *before* any bridge's walkway-clear pass (see
 * `placeVerticalInfrastructure` in `CityGenerator.ts`). That ordering is
 * load-bearing, not stylistic: two bridges meeting the same tower corner at
 * the same `SKY_LEVELS` level can have overlapping footprints, and it is NOT
 * only the two door cells at risk — a perpendicular bridge's 3-wide rail band
 * can cross directly over the *interior* of another bridge's own middle lane,
 * anywhere along its length, not just at the doors (observed on real
 * generator output, seed `sam-audit-3`, y=30: a first attempt at this fix that
 * only reordered the door carve left the interior lane cell one step past the
 * door still sealed by a crossing bridge's rail — the middle lane had never
 * been anything other than "whatever nobody else happened to write there",
 * which a crossing bridge's rail write is a perfectly good counterexample to).
 * With a single `writeBridge` pass per bridge in array order, whichever
 * bridge wrote its rails *after* the other's walkway existed would silently
 * reseal part of it — a stranded sky lobby with every voxel individually
 * well-formed, same symptom as the elevator-vs-bridge-door class
 * (`canElevatorAndBridgeDoorCoexist`) but a different mechanism entirely
 * (bridge-vs-bridge, not elevator-vs-bridge), and order-dependent rather than
 * geometry-dependent — the same two bridges could seal or not seal each
 * other's walkway purely based on which happened to iterate first.
 *
 * Doing every deck+rail write first, then every walkway clear, makes a
 * walkway clear always the last write to touch its own cells regardless of
 * bridge iteration order: no rail written by any bridge, including ones that
 * appear later in the array, can still be standing there afterward. This only
 * ever touches `level + 1`/`level + 2` (never `level` itself, the solid
 * deck/floor row), so it can never punch a hole in another bridge's walkable
 * deck *surface* — at worst it removes a purely decorative rail segment where
 * two bridges cross, which reads as a doorway through that rail rather than a
 * rail gap error.
 */
export function writeBridgeWalkway(world: World, bridge: Bridge): void {
  const { axis, level, x, z, width, depth } = bridge;

  if (axis === 'x') {
    const midZ = z + 1;
    for (let dx = -1; dx <= width; dx++) {
      for (let dy = 1; dy <= 2; dy++) {
        world.setBlockRaw(x + dx, level + dy, midZ, AIR);
      }
    }
  } else {
    const midX = x + 1;
    for (let dz = -1; dz <= depth; dz++) {
      for (let dy = 1; dy <= 2; dy++) {
        world.setBlockRaw(midX, level + dy, z + dz, AIR);
      }
    }
  }
}

/**
 * Writes one bridge fully in isolation: deck, rails, middle lane, and both
 * door openings. Callers writing a *whole set* of bridges into the same world
 * (chiefly `CityGenerator.ts`) must NOT use this — they need every bridge's
 * deck+rail pass to run before any bridge's walkway-clear pass, which this
 * single-bridge convenience can't provide; see `writeBridgeWalkway`'s doc
 * comment for exactly why that ordering matters. This exists for callers that
 * only ever write one bridge into a world (tests, chiefly) where no other
 * bridge can contend for the same cells.
 */
export function writeBridge(world: World, bridge: Bridge): void {
  writeBridgeDeckAndRails(world, bridge);
  writeBridgeWalkway(world, bridge);
}

/**
 * Re-fences any bridge rail cell left open by a *different* bridge's walkway
 * clear (Task 39). `writeBridgeWalkway`'s doc comment above explains why deck
 * +rails must be written for every bridge before any bridge's walkway is
 * cleared: it keeps a walkway-clear from ever being re-sealed by a rail
 * written later. But that ordering has its own mirror-image gap — a walkway
 * clear is deliberately unaware of which cells belong to some *other*
 * bridge's rail band, so when bridge B's middle-lane column happens to cross
 * bridge A's rail row (same junction geometry as this file's "crossing
 * bridges" test suite), B's clear pass erases A's rail voxel there right
 * along with whatever B itself owns at that cell. The result is a deck cell
 * that is solid METAL at `level` with open air at `level + 1` — exactly what
 * `NavGrid.buildElevatedLevel` reads as an ordinary walkable deck cell — but
 * on one of A's own two *edge* rows, where a rail is supposed to stand
 * between the deck and open space. A pedestrian NPC never walks there
 * (`NavGrid` only marks a bridge's middle lane walkable), but a player who
 * strafes onto that edge finds no rail and can step straight off into air.
 *
 * Run once, after *every* bridge's deck+rails and *every* bridge's walkway
 * have been written (see `placeVerticalInfrastructure` in `CityGenerator.ts`),
 * this scans each bridge's own two rail rows for a cell that should have a
 * rail but doesn't, and restores it — *unless* that exact cell also lies on
 * some *other* bridge's own solid deck body (its 1-wide middle lane,
 * strictly within that bridge's own `width`/`depth` footprint — deliberately
 * *not* including the two door cells one step beyond its ends). That is the
 * genuine-junction case: another bridge's actual floor physically continues
 * through this cell, so fencing it would wall off a real crossing a player
 * needs to walk straight through — a regression this fix must not
 * introduce. Elsewhere — including a cell reached only by another bridge's
 * *door* corridor rather than its deck body — the rail is restored, because
 * nothing real connects there: the door corridor is a 1-cell reach past
 * that bridge's own floor for a *different* purpose (landing on the far
 * tower's own threshold, filled in later by `writeSkyLobby`), not a second
 * bridge's deck. Excluding door cells from the junction test specifically is
 * what tells the false case (a stray door corridor incidentally grazing
 * another bridge's rail row, deck genuinely absent) apart from the true one
 * (an actual crossing deck): a door corridor's own `level` cell frequently
 * isn't even that bridge's own solid floor yet at repair time (sky lobbies
 * are written later in `placeVerticalInfrastructure`), so treating it as
 * equivalent to real deck would restore rails inconsistently depending on
 * pipeline ordering rather than on the geometry that actually matters.
 *
 * Honest scope note: this pass is defense-in-depth, not a live-bug repair.
 * A 1000-seed audit found the fencing invariant already holds on every real
 * generated city — actual crossings come out as symmetric plus-crossroads
 * whose open lane arms are genuine junctions (bridge lanes are always
 * centered via `laneStart`). The false-connection case this pass restores is
 * only reachable with off-center overlaps current planning never emits; the
 * pass exists so the invariant survives future bridge-planning changes.
 *
 * Chosen over the alternatives:
 *  - Reordering the two existing passes further (e.g. per-bridge-pair-aware
 *    clearing) would need every bridge to know about every *other* bridge's
 *    footprint while clearing its own walkway, coupling a single-bridge
 *    function to whatever else shares its world — exactly the kind of
 *    interleaving `writeBridgeWalkway`'s own doc comment already rejected
 *    once for the resealing bug.
 *  - Making `writeBridgeWalkway` "rail-aware" (skip clearing a cell that
 *    holds another bridge's rail) would need each bridge's clear pass to
 *    check every other bridge's rail geometry inline, and still wouldn't
 *    handle the case where the clear runs *before* the other bridge's rail
 *    is even written (order otherwise doesn't matter for the clear itself).
 *    A single self-contained post-pass over the finished world, run once
 *    after all writes, needs no cross-bridge awareness during either
 *    existing pass and is trivial to reason about in isolation.
 */
export function repairBridgeRailFencing(world: World, bridges: readonly Bridge[]): void {
  for (const bridge of bridges) refenceBridge(world, bridge, bridges);
}

/** Re-fences one bridge's two rail rows/columns; see `repairBridgeRailFencing`. */
function refenceBridge(world: World, bridge: Bridge, allBridges: readonly Bridge[]): void {
  const { axis, x, z, width, depth } = bridge;

  if (axis === 'x') {
    for (let dx = 0; dx < width; dx++) {
      refenceRailCell(world, bridge, allBridges, x + dx, z);
      refenceRailCell(world, bridge, allBridges, x + dx, z + depth - 1);
    }
  } else {
    for (let dz = 0; dz < depth; dz++) {
      refenceRailCell(world, bridge, allBridges, x, z + dz);
      refenceRailCell(world, bridge, allBridges, x + width - 1, z + dz);
    }
  }
}

/**
 * Restores a single missing rail voxel at deck-edge cell `(x, bridge.level, z)`
 * unless some *other* bridge's own walkway lane legitimately claims this
 * exact cell (see `repairBridgeRailFencing`'s doc comment for why that's the
 * right test rather than a geometric "is the far side walkable" probe).
 */
function refenceRailCell(world: World, bridge: Bridge, allBridges: readonly Bridge[], x: number, z: number): void {
  const { level } = bridge;
  if (world.getBlock(x, level, z) !== METAL) return; // not a deck cell at all
  if (world.getBlock(x, level + 1, z) === NEON_CYAN) return; // rail already intact

  const isGenuineJunction = allBridges.some((other) => other !== bridge && isOwnDeckLaneCell(other, x, z));
  if (isGenuineJunction) return; // another bridge's real deck continues through here

  world.setBlockRaw(x, level + 1, z, NEON_CYAN);
}

/**
 * True if `(x, z)` is part of `bridge`'s own solid deck's middle lane —
 * strictly within its own `width`/`depth` footprint, deliberately excluding
 * the two door cells one step beyond each end that `writeBridgeWalkway` also
 * clears (see `repairBridgeRailFencing`'s doc comment for why the door cells
 * don't count as a "real deck continues here" signal). Kept geometry-only
 * (no world reads) so it answers "does this bridge's own floor genuinely
 * occupy this cell" regardless of what any other bridge's writes did there,
 * or what order those writes ran in.
 */
function isOwnDeckLaneCell(bridge: Bridge, x: number, z: number): boolean {
  const { axis, x: bx, z: bz, width, depth } = bridge;
  if (axis === 'x') {
    const midZ = bz + 1;
    return z === midZ && x >= bx && x <= bx + width - 1;
  }
  const midX = bx + 1;
  return x === midX && z >= bz && z <= bz + depth - 1;
}

// ---------------------------------------------------------------------------
// Internal stair shafts (tower ground floor -> bridge level)
// ---------------------------------------------------------------------------

/**
 * Ring of (dx, dz) offsets within a 3x3 footprint, ordered so each entry is
 * orthogonally adjacent to the previous one. Walking this ring while
 * incrementing Y by 1 every step produces a spiral staircase made entirely
 * of single-voxel risers between adjacent cells — climbable by the play
 * controller's auto-step (which only climbs exactly 1-voxel-high, adjacent
 * obstacles). The center cell (1, 1) is left as an open shaft well.
 */
const STAIR_SPIRAL_RING: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [2, 0],
  [2, 1],
  [2, 2],
  [1, 2],
  [0, 2],
  [0, 1],
  [0, 0],
];

export interface StairShaft {
  originX: number;
  originZ: number;
  baseY: number;
  topY: number;
}

/**
 * The 3x3 shaft footprint's lower corner, centered on the tower's ground
 * tier. Shared by `planStairShafts` (to place the steps) and
 * `planSkyLobbies` (to cut a matching stairwell opening through the sky
 * lobby floor) so the two never drift apart.
 */
function stairShaftOrigin(tower: BuildingPlan): { x: number; z: number } {
  const tier0 = tower.tiers[0] as NonNullable<(typeof tower.tiers)[0]>;
  return {
    x: tier0.x + Math.floor(tier0.width / 2) - 1,
    z: tier0.z + Math.floor(tier0.depth / 2) - 1,
  };
}

/**
 * The 9 (x, z) columns of a tower's 3x3 stair-shaft footprint, independent of
 * shaft height. Exposed so callers that need to know *where* a stair shaft
 * will stand without caring about its vertical extent — chiefly
 * `CityGenerator`, which uses this to keep a shop interior's furniture
 * layout from placing anything where the shaft is about to rise (see
 * `shopInterior.ts`'s `writeShopInterior` `excludeColumns` parameter) — don't
 * have to duplicate `stairShaftOrigin`'s formula.
 */
export function stairShaftFootprintColumns(tower: BuildingPlan): Array<{ x: number; z: number }> {
  const origin = stairShaftOrigin(tower);
  const columns: Array<{ x: number; z: number }> = [];
  for (let dx = 0; dx < 3; dx++) {
    for (let dz = 0; dz < 3; dz++) {
      columns.push({ x: origin.x + dx, z: origin.z + dz });
    }
  }
  return columns;
}

/** Plans one internal spiral stair shaft per (tower, bridge level) pair, deduped so a shared tower gets one shaft per level. */
export function planStairShafts(bridges: readonly Bridge[]): StairShaft[] {
  const seen = new Set<string>();
  const shafts: StairShaft[] = [];

  for (const bridge of bridges) {
    for (const tower of [bridge.towerA, bridge.towerB]) {
      const key = `${towerKey(tower)}:${bridge.level}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const origin = stairShaftOrigin(tower);
      shafts.push({ originX: origin.x, originZ: origin.z, baseY: tower.baseY, topY: bridge.level });
    }
  }

  return shafts;
}

/** Pure step geometry for a spiral stair shaft: one entry per riser, from baseY up to (and including) topY. */
export function planStairSteps(shaft: StairShaft): Vec3[] {
  const steps: Vec3[] = [];
  let i = 0;
  for (let y = shaft.baseY; y <= shaft.topY; y++) {
    const [dx, dz] = STAIR_SPIRAL_RING[i % STAIR_SPIRAL_RING.length] as readonly [number, number];
    steps.push({ x: shaft.originX + dx, y, z: shaft.originZ + dz });
    i++;
  }
  return steps;
}

/** Writes a solid step block plus 2 voxels of headroom above every riser. */
export function writeSteps(world: World, steps: readonly Vec3[]): void {
  for (const step of steps) {
    world.setBlockRaw(step.x, step.y, step.z, CONCRETE);
    world.setBlockRaw(step.x, step.y + 1, step.z, AIR);
    world.setBlockRaw(step.x, step.y + 2, step.z, AIR);
  }
}

export function writeStairShaft(world: World, shaft: StairShaft): void {
  writeSteps(world, planStairSteps(shaft));
}

// ---------------------------------------------------------------------------
// Sky lobbies (the floor a bridge tower needs at its own bridge level)
// ---------------------------------------------------------------------------

/**
 * A tower is a hollow shell — `writeShellAndWindows` only paints the
 * perimeter, never a floor — so without this, the stair shaft's top step at
 * y=level is a single block floating in open air: nothing connects it to the
 * bridge doorway punched into the facade. `SkyLobby` is that missing floor: a
 * full CONCRETE slab at y=level covering the tower's *own* footprint at that
 * height (via `tierAt`, not tier0 — a setback boundary can land exactly on a
 * bridge level and shrink the footprint there), so the top step, the walk to
 * the door, and the door threshold are all on one continuous, solid floor.
 *
 * The slab leaves open exactly the (up to) 3 columns that would otherwise cap
 * headroom a rider still needs below the top step. This count comes directly
 * from `PlayerCollision.tryAutoStep`'s real gate, not from "2 voxels of
 * standing headroom" intuition — the two are different requirements and
 * conflating them was a real, shipped defect (Sam's Task 4 review): climbing
 * from feet-row `y` to `y+1` additionally requires row `y+2` clear *at the
 * departure column* (see `tryAutoStep`'s lifted-box pre-check), one row
 * higher than the "`y+1` clear" that mere occupancy at row `y` needs. Walking
 * that back from the top step (feet row `level+1`):
 *  - the step directly below (feet row `level`) needs row `level+1` clear
 *    just to stand there — ordinary occupancy, not climbing;
 *  - the step below that (feet row `level-1`) needs row `level+1` clear as
 *    its OWN occupancy headroom, i.e. its "2 voxels above" reaches up to
 *    `level+1`... no clearance of the lobby's own row (`level`) needed yet;
 *  - restated in terms of the lobby's row `level` specifically: it is
 *    row-(level) headroom for the step at feet-row `level-1` (ordinary
 *    occupancy) AND for the step at feet-row `level-2` (ordinary occupancy,
 *    its "+2" reaches `level`) AND for the *climb* from feet-row `level-2`
 *    onward (needs row `level` clear at ITS OWN column, i.e. the step at
 *    feet-row `level-3`'s climb-gate). That's 3 distinct step columns whose
 *    access depends on row `level` staying open, not 2 — a real generator
 *    output BFS using the actual `tryAutoStep` (see
 *    `CityGenerator.test.ts`'s climb-BFS harness) caught every shaft
 *    failing at exactly the third one when only 2 were kept open. Earlier
 *    this excluded the whole 3x3 shaft footprint instead, which was worse:
 *    the ring is built so every cell is on the shaft's outer edge, so the
 *    top step's *own* grid neighbors are other ring cells —
 *    blanket-excluding all of them could wall the top step off from the
 *    rest of the floor entirely (observed on narrow-footprint towers, where
 *    the shaft leaves no slab margin on one side). Excluding only the
 *    columns that actually need to stay open lets every other ring cell —
 *    including the top step's non-predecessor neighbors — get a normal
 *    solid floor, so the top step always has a walkable way out.
 */
export interface SkyLobby {
  x: number;
  z: number;
  width: number;
  depth: number;
  y: number;
  /** Absolute (x, z) columns to leave uncovered at y — occupancy/climb headroom for the risers just below the top step (see `planSkyLobbies`'s doc comment for why this is up to 3 columns). */
  openColumns: ReadonlyArray<{ x: number; z: number }>;
}

/** Plans one sky-lobby floor per (tower, bridge level) pair — one per stair shaft, deduped the same way. */
export function planSkyLobbies(bridges: readonly Bridge[]): SkyLobby[] {
  const seen = new Set<string>();
  const lobbies: SkyLobby[] = [];

  for (const bridge of bridges) {
    for (const tower of [bridge.towerA, bridge.towerB]) {
      const key = `${towerKey(tower)}:${bridge.level}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const tier = tierAt(tower, bridge.level);
      const origin = stairShaftOrigin(tower);
      const shaft: StairShaft = { originX: origin.x, originZ: origin.z, baseY: tower.baseY, topY: bridge.level };
      const steps = planStairSteps(shaft);

      // The last entry is the top step itself (its own cell is written by
      // writeStairShaft, not the slab — it must stay solid, it's the floor);
      // the up-to-3 entries before it are the steps whose occupancy-or-climb
      // headroom this slab would otherwise cap (see this function's doc
      // comment for exactly why it's 3, not 2).
      const openColumns = steps.slice(Math.max(0, steps.length - 4), steps.length - 1).map((s) => ({ x: s.x, z: s.z }));

      lobbies.push({ x: tier.x, z: tier.z, width: tier.width, depth: tier.depth, y: bridge.level, openColumns });
    }
  }

  return lobbies;
}

export function writeSkyLobby(world: World, lobby: SkyLobby): void {
  const openSet = new Set(lobby.openColumns.map((c) => `${c.x},${c.z}`));
  for (let dx = 0; dx < lobby.width; dx++) {
    for (let dz = 0; dz < lobby.depth; dz++) {
      const x = lobby.x + dx;
      const z = lobby.z + dz;
      if (openSet.has(`${x},${z}`)) continue;
      world.setBlockRaw(x, lobby.y, z, CONCRETE);
    }
  }
}

// ---------------------------------------------------------------------------
// Elevated downtown walkways (external straight stairs from the sidewalk)
// ---------------------------------------------------------------------------

/** Absolute world Y of the elevated walkway deck; the walkable surface is one voxel above it. */
export const WALKWAY_Y = 12;
const WALKWAY_DECK_DEPTH = 2;
const WALKWAY_MIN_BLOCK_WIDTH = 6;

export interface Walkway {
  x: number;
  z: number;
  width: number;
  depth: number;
  stairSteps: Vec3[];
}

function planStraightStairSteps(origin: { x: number; z: number }, dir: readonly [number, number], baseY: number, topY: number): Vec3[] {
  const steps: Vec3[] = [];
  let x = origin.x;
  let z = origin.z;
  for (let y = baseY; y <= topY; y++) {
    steps.push({ x, y, z });
    x += dir[0];
    z += dir[1];
  }
  return steps;
}

/**
 * Plans one elevated walkway (with its external staircase) for every 2nd
 * downtown block, running along the block's south sidewalk edge. Skipped
 * where the block is too narrow or too close to the world edge to fit the
 * staircase's run.
 */
export function planWalkways(layout: CityLayout, groundBaseY: number): Walkway[] {
  const walkways: Walkway[] = [];
  let downtownIndex = 0;

  for (const block of layout.blocks) {
    if (block.district !== District.DOWNTOWN) continue;
    downtownIndex++;
    if (downtownIndex % 2 !== 0) continue;
    if (block.width < WALKWAY_MIN_BLOCK_WIDTH) continue;

    const runLength = WALKWAY_Y - groundBaseY;
    const deckZ = block.z - WALKWAY_DECK_DEPTH;
    // Stop one cell short of the deck's own footprint so the last riser and
    // the deck's first row don't fight over the same voxel.
    const stairStartZ = deckZ - 1 - runLength;
    if (deckZ < 0 || stairStartZ < 0) continue;

    const stairSteps = planStraightStairSteps({ x: block.x, z: stairStartZ }, [0, 1], groundBaseY, WALKWAY_Y);
    walkways.push({ x: block.x, z: deckZ, width: block.width, depth: WALKWAY_DECK_DEPTH, stairSteps });
  }

  return walkways;
}

export function writeWalkway(world: World, walkway: Walkway): void {
  for (let dx = 0; dx < walkway.width; dx++) {
    for (let dz = 0; dz < walkway.depth; dz++) {
      world.setBlockRaw(walkway.x + dx, WALKWAY_Y, walkway.z + dz, METAL);
    }
  }
  writeSteps(world, walkway.stairSteps);
}

// ---------------------------------------------------------------------------
// Streetlights (at road intersections)
// ---------------------------------------------------------------------------

const STREETLIGHT_POLE_HEIGHT = 5;

export interface Streetlight {
  x: number;
  z: number;
}

/** Distinct (start, size) spans a set of blocks occupy along one axis, deduped and sorted. */
function uniqueAxisSpans(blocks: CityLayout['blocks'], axis: 'x' | 'z'): Span[] {
  const seen = new Map<string, Span>();
  for (const block of blocks) {
    const start = axis === 'x' ? block.x : block.z;
    const size = axis === 'x' ? block.width : block.depth;
    const key = `${start}:${size}`;
    if (!seen.has(key)) seen.set(key, { start, end: start + size });
  }
  return Array.from(seen.values()).sort((a, b) => a.start - b.start);
}

/** The road gaps strictly between consecutive block spans along one axis. */
function interiorGaps(spans: readonly Span[]): Span[] {
  const gaps: Span[] = [];
  for (let i = 0; i < spans.length - 1; i++) {
    const start = (spans[i] as Span).end;
    const end = (spans[i + 1] as Span).start;
    if (end > start) gaps.push({ start, end });
  }
  return gaps;
}

/** Plans one streetlight at the center of every interior road-x-road intersection. */
export function planStreetlights(layout: CityLayout): Streetlight[] {
  const xGaps = interiorGaps(uniqueAxisSpans(layout.blocks, 'x'));
  const zGaps = interiorGaps(uniqueAxisSpans(layout.blocks, 'z'));
  const lights: Streetlight[] = [];

  for (const xGap of xGaps) {
    for (const zGap of zGaps) {
      const x = Math.floor((xGap.start + xGap.end) / 2);
      const z = Math.floor((zGap.start + zGap.end) / 2);
      if (cellAt(layout, x, z) === CellType.ROAD) {
        lights.push({ x, z });
      }
    }
  }

  return lights;
}

export function writeStreetlight(world: World, light: Streetlight, groundY: number): void {
  for (let h = 1; h <= STREETLIGHT_POLE_HEIGHT; h++) {
    world.setBlockRaw(light.x, groundY + h, light.z, METAL);
  }
  world.setBlockRaw(light.x, groundY + STREETLIGHT_POLE_HEIGHT + 1, light.z, NEON_CYAN);
}

// ---------------------------------------------------------------------------
// Billboards (scattered on blank facades)
// ---------------------------------------------------------------------------

const BILLBOARD_CHANCE = 0.08;
/**
 * Exported: `engine/BillboardScanner.ts` matches this exact WIDTH x HEIGHT
 * footprint to find real billboard faces by voxel-scanning a `World` alone
 * (works identically after generation or `.vxc` import, neither of which
 * keeps a `Billboard[]` around) — see that module's doc comment for why an
 * exact-size match is enough to disambiguate a billboard from every other
 * flat neon surface this file writes (shop bands, sign strips, bridge
 * rails), all of which are shaped differently.
 */
export const BILLBOARD_WIDTH = 4;
export const BILLBOARD_HEIGHT = 3;
const BILLBOARD_COLORS = [NEON_PINK, NEON_CYAN, NEON_YELLOW, NEON_PURPLE] as const;
const ALL_SIDES: readonly DoorSide[] = ['north', 'south', 'east', 'west'];

export interface Billboard {
  building: BuildingPlan;
  side: DoorSide;
  offset: number;
  yStart: number;
  color: number;
}

/** Rolls a scattered neon billboard on a random non-door facade for a small fraction of buildings. */
export function planBillboards(buildings: readonly BuildingPlan[], rng: Rng): Billboard[] {
  const billboards: Billboard[] = [];

  for (const building of buildings) {
    if (building.signStrip) continue; // don't double up signage on the same tower
    const buildingRng = rng.fork(towerKey(building));
    if (!buildingRng.chance(BILLBOARD_CHANCE)) continue;

    const candidateSides = ALL_SIDES.filter((side) => side !== building.doorSide);
    const tier0 = building.tiers[0] as NonNullable<(typeof building.tiers)[0]>;
    const side = buildingRng.pick(candidateSides);
    const tangentLength = side === 'north' || side === 'south' ? tier0.width : tier0.depth;
    if (tangentLength < BILLBOARD_WIDTH + 2 || building.height < BILLBOARD_HEIGHT + 4) continue;

    const tangentOrigin = side === 'north' || side === 'south' ? tier0.x : tier0.z;
    const offset = tangentOrigin + buildingRng.intRange(1, tangentLength - BILLBOARD_WIDTH - 1);
    const yStart = buildingRng.intRange(2, building.height - BILLBOARD_HEIGHT - 1);
    const color = buildingRng.pick(BILLBOARD_COLORS);
    billboards.push({ building, side, offset, yStart, color });
  }

  return billboards;
}

export function writeBillboard(world: World, billboard: Billboard): void {
  const { building, side, offset, yStart, color } = billboard;
  const tier0 = building.tiers[0] as NonNullable<(typeof building.tiers)[0]>;

  for (let h = 0; h < BILLBOARD_HEIGHT; h++) {
    const y = building.baseY + yStart + h;
    for (let w = 0; w < BILLBOARD_WIDTH; w++) {
      if (side === 'south') world.setBlockRaw(offset + w, y, tier0.z, color);
      else if (side === 'north') world.setBlockRaw(offset + w, y, tier0.z + tier0.depth - 1, color);
      else if (side === 'west') world.setBlockRaw(tier0.x, y, offset + w, color);
      else world.setBlockRaw(tier0.x + tier0.width - 1, y, offset + w, color);
    }
  }
}

// ---------------------------------------------------------------------------
// Elevator shafts (functional — see `elevators/ElevatorScanner.ts` for the
// runtime side that re-derives rideable stops from these blocks)
// ---------------------------------------------------------------------------

const ELEVATOR_CHANCE = 0.15;
const ELEVATOR_MIN_HEIGHT = 30;
/** Rows of solid "penthouse" wall above the topmost stop's floor, enough to carve that stop's own 2-voxel doorway into. */
const ELEVATOR_HOUSING_ROWS = 2;

/**
 * The elevator's footprint is fixed at the tower's NW interior corner —
 * relative to the tower's own origin its 3x3 rect spans offsets `[1, 3]` on
 * both axes (see `planElevatorShafts`). Used as one input rect to
 * `canElevatorAndStairShaftCoexist`.
 */
const ELEVATOR_FOOTPRINT_RANGE: readonly [number, number] = [1, 3];

/**
 * The stair shaft is *centered* on the tower: its origin is
 * `floor(size / 2) - 1` (see `stairShaftOrigin`), so its 3x3 rect spans
 * `[floor(size / 2) - 1, floor(size / 2) + 1]` on that axis. `size` is the
 * tower's width (for the x-axis rect) or depth (for the z-axis rect).
 */
function stairFootprintRange(size: number): [number, number] {
  const origin = Math.floor(size / 2) - 1;
  return [origin, origin + 2];
}

/**
 * Empty columns strictly between two 1-D ranges — `0` when they're adjacent
 * (touching, no gap), positive when there's real clearance, and `-1` as a
 * defensive sentinel for overlap (never actually reached: see
 * `canElevatorAndStairShaftCoexist`'s doc comment for why the elevator and
 * stair ranges can never overlap at any real tower footprint).
 */
function rangeGap(a: readonly [number, number], b: readonly [number, number]): number {
  const [aMin, aMax] = a;
  const [bMin, bMax] = b;
  if (aMax < bMin) return bMin - aMax - 1;
  if (bMax < aMin) return aMin - bMax - 1;
  return -1;
}

/**
 * True when a stair shaft and an elevator shaft can coexist on the same
 * tower footprint (`width` x `depth`) with real clearance between their two
 * 3x3 rects, rather than sharing a column or fusing walls together.
 *
 * Two axis-aligned rects share no wall as long as there's at least 1 empty
 * column of gap between them on *either* axis alone — a gap on one axis
 * keeps the rects apart along that whole axis regardless of what the other
 * axis does (this is what makes a diagonally-offset pair like a 10-wide,
 * 14-deep tower safe: the axes touch on x but the z gap alone separates
 * them). So the predicate is `gap(x) >= 1 OR gap(z) >= 1`, computed honestly
 * from the two rects rather than assumed.
 *
 * At `BRIDGE_MIN_TOWER_FOOTPRINT` (10) and up, `stairFootprintRange`'s min
 * (`floor(size/2) - 1`) is always >= 4, strictly past the elevator range's
 * max of 3 — so the two ranges never overlap on either axis (the `-1`
 * sentinel in `rangeGap` never fires on real geometry); they're always
 * either touching (gap 0) or clear (gap >= 1). At size 10 or 11,
 * `floor(size/2) - 1` is 4 either way, so both give gap 0 (touching) — only
 * at size >= 12 does an axis open up a real gap. Below 10, no stair shaft
 * exists at all (`BRIDGE_MIN_TOWER_FOOTPRINT`), so this is never evaluated.
 */
export function canElevatorAndStairShaftCoexist(width: number, depth: number): boolean {
  const gapX = rangeGap(ELEVATOR_FOOTPRINT_RANGE, stairFootprintRange(width));
  const gapZ = rangeGap(ELEVATOR_FOOTPRINT_RANGE, stairFootprintRange(depth));
  return gapX >= 1 || gapZ >= 1;
}

/**
 * The single transverse column (relative to `tower`'s own tier0 origin) a
 * pedestrian walks straight down when stepping through `bridge`'s door onto
 * `tower`'s sky lobby, or `null` if `tower` isn't the wall-adjacent side of
 * this bridge at all (see this function's doc comment for which side that
 * is). Unlike `stairFootprintRange`, this is a single column, not a 3-wide
 * range — a bridge door is only ever `writeBridge`'s one `midX`/`midZ` lane
 * wide.
 */
function bridgeDoorTransverseOffset(tower: BuildingPlan, bridge: Bridge): number | null {
  if (bridge.towerB !== tower) return null; // see doc comment below: only towerB's door ever lands near the elevator's fixed corner
  const tier0 = tower.tiers[0] as NonNullable<(typeof tower.tiers)[0]>;
  return bridge.axis === 'x' ? bridge.z + 1 - tier0.z : bridge.x + 1 - tier0.x;
}

/**
 * True when placing an elevator shaft at `tower`'s fixed NW corner (see
 * `planElevatorShafts`) would never physically block any of `tower`'s own
 * bridge doorways.
 *
 * `writeBridge` always carves a bridge's door into the *higher-coordinate*
 * partner's own north (axis `'z'`) or west (axis `'x'`) wall — i.e.
 * `bridge.towerB`, never `towerA` (whose door lands on the opposite,
 * lower-coordinate-facing wall: south or east). Those are exactly the two
 * walls nearest the elevator's fixed corner (`ELEVATOR_FOOTPRINT_RANGE`
 * starts one column in from both of them), so `towerA`'s door is never at
 * risk — only `towerB`'s.
 *
 * A door is a single column, not a 3-wide rect like a stair shaft, so the
 * geometry is simpler than `canElevatorAndStairShaftCoexist`: a pedestrian
 * walks straight in from the door at a fixed transverse offset, and only
 * ever collides with the elevator if that one offset falls inside
 * `ELEVATOR_FOOTPRINT_RANGE` — the elevator's shell (`writeElevatorShaft`'s
 * `isShell` rows) occupies every transverse offset in that range for the
 * *entire* depth the elevator extends into the room, so there is no partial
 * miss the way there can be between two same-width rects. This was a real,
 * shipped defect (Sam's residual-bridge-reach review): an elevator sitting
 * on this corridor silently walled a stair top off from its own bridge, with
 * no error anywhere — voxels were all individually well-formed, just
 * arranged so nothing could walk from one to the other.
 */
export function canElevatorAndBridgeDoorCoexist(tower: BuildingPlan, bridges: readonly Bridge[]): boolean {
  for (const bridge of bridges) {
    const offset = bridgeDoorTransverseOffset(tower, bridge);
    if (offset === null) continue;
    if (offset >= ELEVATOR_FOOTPRINT_RANGE[0] && offset <= ELEVATOR_FOOTPRINT_RANGE[1]) return false;
  }
  return true;
}

export interface ElevatorShaftMarker {
  building: BuildingPlan;
  x: number;
  z: number;
  /**
   * True when this tower also has a bridge stair shaft (see
   * `planElevatorShafts`'s coexistence gate). `writeElevatorShaft` uses this
   * to defensively exclude `stairShaftFootprintColumns` from door-edge
   * candidates — belt-and-suspenders on top of the geometric proof above,
   * which already guarantees no real collision at any footprint a stair
   * shaft can exist on.
   */
  coexistsWithStairShaft: boolean;
}

/**
 * Rolls an empty 3x3-walled shaft for some tall towers. A tower that already
 * has a bridge stair shaft (see `planStairShafts`) is only eligible once
 * `canElevatorAndStairShaftCoexist` says its footprint gives the two 3x3
 * rects (elevator at the fixed NW corner, stairs centered) real clearance on
 * at least one axis — see that function's doc comment for the geometric
 * proof. Below that, the tower keeps the pre-existing "stairs only" behavior.
 *
 * Independently, skips any building with a planned shop interior (see
 * `shopInterior.ts`) regardless of stair-shaft coexistence — unlike a
 * bridge's *centered* stair shaft (see `candidateTowers`, which no longer
 * excludes shops for exactly this reason), this shaft's footprint is anchored
 * to the tower's fixed NW interior corner, which can land squarely on that
 * room's doorway-adjacent walkway ring, sealing it off, and a shop's whole
 * ground floor is meant to be one open retail room rather than sharing it
 * with a vertical core.
 *
 * Independently again, a tower with any bridge attached is only eligible
 * once `canElevatorAndBridgeDoorCoexist` says the elevator's fixed corner
 * won't block that bridge's own door corridor (see that function's doc
 * comment) — a *different* collision than the stair-shaft one above: the
 * stair shaft is centered on the tower, so it's the elevator's diagonal
 * opposite; a bridge door can land on the elevator's own north or west wall,
 * which `canElevatorAndStairShaftCoexist`'s footprint-vs-footprint check
 * never considers at all. `bridges` defaults to empty for callers (chiefly
 * this file's own tests) that construct towers without a full bridge plan —
 * skipping this check entirely is correct there since there's no door to
 * collide with.
 */
export function planElevatorShafts(
  buildings: readonly BuildingPlan[],
  rng: Rng,
  stairShaftTowerKeys: ReadonlySet<string>,
  bridges: readonly Bridge[] = [],
): ElevatorShaftMarker[] {
  const markers: ElevatorShaftMarker[] = [];

  for (const building of buildings) {
    if (building.height < ELEVATOR_MIN_HEIGHT) continue;
    if (building.shopInterior) continue;
    const key = towerKey(building);
    const hasStairShaft = stairShaftTowerKeys.has(key);
    if (hasStairShaft && !canElevatorAndStairShaftCoexist(building.width, building.depth)) {
      continue;
    }
    if (!canElevatorAndBridgeDoorCoexist(building, bridges)) {
      continue;
    }

    const buildingRng = rng.fork(key);
    if (!buildingRng.chance(ELEVATOR_CHANCE)) continue;

    const tier0 = building.tiers[0] as NonNullable<(typeof building.tiers)[0]>;
    markers.push({ building, x: tier0.x + 1, z: tier0.z + 1, coexistsWithStairShaft: hasStairShaft });
  }

  return markers;
}

/** True if `tier`'s footprint fully contains the shaft's 3x3 rect at (x, z). */
function tierContainsShaft(tier: BuildingTier, x: number, z: number): boolean {
  return tier.x <= x && tier.z <= z && tier.x + tier.width >= x + 3 && tier.z + tier.depth >= z + 3;
}

/**
 * A setback tower's upper tiers inset *toward* the shaft's fixed corner
 * position (see `planElevatorShafts`), so the shaft can only ever rise
 * through the contiguous prefix of tiers (starting at the ground tier, which
 * always contains it) that still fully contain its 3x3 footprint. Returns
 * the absolute Y of the highest deck the shaft can reach — either a
 * mid-building setback deck (if a later tier no longer contains the shaft)
 * or the tower's true roof (if every tier does).
 */
function elevatorTopDeckY(building: BuildingPlan, x: number, z: number): number {
  let topY = building.baseY;
  for (const tier of building.tiers) {
    if (!tierContainsShaft(tier, x, z)) break;
    topY = building.baseY + tier.yEnd;
  }
  return topY;
}

/**
 * Ascending "deck Y" floor levels the shaft serves: the city-wide ground
 * surface (one below `baseY`, same convention `paintGround` uses) plus every
 * distinct level (ascending, deduped) this specific tower has a real bridge
 * at (`bridge.towerA`/`towerB` matching `building`), restricted to levels the
 * shaft's own footprint can still physically reach (`elevatorTopDeckY`).
 * Each entry is a solid floor row; a rider's feet stand at `deckY + 1`
 * (matching `Bridge.level` / `SkyLobby.y`'s "solid floor at Y, walkable at
 * Y+1" convention elsewhere in this module).
 *
 * This used to walk every massing-tier boundary instead (`building.tiers`)
 * -- geometrically real floors, but essentially never the *specific* rows
 * `entities/NavGrid.ts` actually recognizes as walkable (`WALKWAY_Y`/
 * `SKY_LEVELS`, and even then only where a real `SkyLobby` or bridge deck
 * exists). A tower's own tier boundaries almost never coincide with those
 * fixed rows, so every non-ground stop a shaft used to get was, in practice,
 * unreachable by any pedestrian or the tour walker -- measured on real
 * generated cities as a hard zero (Sam's Task 41 review: 40,000-tick soaks
 * across 5 seeds produced zero eligible arrivals and zero rides). Anchoring
 * to `bridge.level` instead means every non-ground stop is backed by a real
 * `SkyLobby` floor (see `planSkyLobbies`), connected into that level's
 * walkable interior the exact same way a bridge's own stair top is -- so a
 * `TourElevatorRide` (or a play-mode rider) that reaches this stop finds
 * real, NavGrid-recognized floor on the other side of the doorway, not a
 * disconnected slab.
 *
 * A tower with no bridges at all now yields a shaft with just the ground
 * stop, which `elevators/ElevatorScanner.ts`'s `MIN_STOPS_FOR_FUNCTIONAL_SHAFT`
 * already treats as non-functional -- correct, not a regression: an
 * elevator that goes nowhere real shouldn't register as rideable at all.
 * `writeElevatorShaft` still writes the shell regardless (harmless unused
 * geometry, not a bug); it just won't scan as a usable shaft.
 */
function elevatorDeckYs(building: BuildingPlan, x: number, z: number, bridges: readonly Bridge[]): number[] {
  const topDeckY = elevatorTopDeckY(building, x, z);
  const deckYs = [building.baseY - 1];

  const skyLevels = new Set<number>();
  for (const bridge of bridges) {
    if (bridge.towerA !== building && bridge.towerB !== building) continue;
    if (bridge.level > topDeckY) continue;
    skyLevels.add(bridge.level);
  }
  for (const level of Array.from(skyLevels).sort((a, b) => a - b)) deckYs.push(level);

  return deckYs;
}

/**
 * One candidate wall the doorway can be carved through: the ring-cell offset
 * of the door itself, the two flanking corner offsets that get the neon door
 * frame, and the offset of the cell one step *beyond* that wall — used to
 * test whether this edge actually opens onto open interior space.
 */
interface DoorEdge {
  doorOffset: readonly [number, number];
  frameOffsetA: readonly [number, number];
  frameOffsetB: readonly [number, number];
  outwardOffset: readonly [number, number];
}

/**
 * The shaft's origin is always `(tier0.x + 1, tier0.z + 1)` (see
 * `planElevatorShafts`) — one cell in from the tower's own *north* and
 * *west* walls, but (footprint permitting) several cells short of its
 * *south* and *east* walls. So the north/west edges always open straight
 * onto the tower's own perimeter shell (a solid wall one cell away, not
 * interior), while south/east are the ones that can actually reach the
 * hollow interior — tried in that preference order, with north/west kept
 * only as a last-resort fallback (see `pickDoorEdge`).
 */
const DOOR_EDGES: readonly DoorEdge[] = [
  { doorOffset: [1, 2], frameOffsetA: [0, 2], frameOffsetB: [2, 2], outwardOffset: [1, 3] }, // south
  { doorOffset: [2, 1], frameOffsetA: [2, 0], frameOffsetB: [2, 2], outwardOffset: [3, 1] }, // east
  { doorOffset: [1, 0], frameOffsetA: [0, 0], frameOffsetB: [2, 0], outwardOffset: [1, -1] }, // north
  { doorOffset: [0, 1], frameOffsetA: [0, 0], frameOffsetB: [0, 2], outwardOffset: [-1, 1] }, // west
];

/**
 * Picks whichever `DOOR_EDGE` actually opens onto real *standable* space at
 * this specific stop — both doorway rows non-solid one step beyond the
 * candidate wall, **and** solid footing directly under them (the same
 * "solid floor, 2 clear voxels above" test used everywhere else a floor is
 * verified in this codebase, e.g. `writeSteps`). Open-but-unfooted matters:
 * a narrow tower's roof/deck doesn't extend past its own footprint, so a
 * door that only checks "is it air out there" can open straight off the
 * edge of the building into thin air — technically unblocked, but a rider
 * stepping through it would fall, not "exit."
 *
 * Checked per-stop, not once for the whole shaft: an inset setback tier can
 * be narrow along one axis without being narrow along the other, so the
 * edge that works for the ground stop is not guaranteed to still have real
 * footing at a mid-building or roof stop sitting inside a differently-shaped
 * tier (see `elevatorDeckYs`). Returns null only when every edge fails at
 * this stop (a degenerately narrow tier): `writeElevatorShaft` then leaves
 * that one stop doorless rather than the whole shaft, which
 * `elevators/ElevatorScanner.ts` simply doesn't count as a stop.
 *
 * `forbiddenColumns`, when given, is the coexisting stair shaft's own 3x3
 * footprint (see `canElevatorAndStairShaftCoexist`'s doc comment): an
 * edge whose door or outward-probe cell lands there is skipped outright,
 * before even checking footing/clearance. The geometric proof there already
 * guarantees this never actually triggers at any footprint a stair shaft can
 * exist on — this is a cheap defensive check, not load-bearing geometry.
 */
function pickDoorEdge(
  world: World,
  x: number,
  z: number,
  doorYs: readonly [number, number],
  forbiddenColumns: ReadonlySet<string> | null,
): DoorEdge | null {
  const floorY = doorYs[0] - 1;
  for (const edge of DOOR_EDGES) {
    const [doorDx, doorDz] = edge.doorOffset;
    const [outDx, outDz] = edge.outwardOffset;
    if (forbiddenColumns) {
      if (forbiddenColumns.has(`${x + doorDx},${z + doorDz}`)) continue;
      if (forbiddenColumns.has(`${x + outDx},${z + outDz}`)) continue;
    }
    const hasFooting = world.isSolid(x + outDx, floorY, z + outDz);
    const isClearAtBothRows = doorYs.every((y) => !world.isSolid(x + outDx, y, z + outDz));
    if (hasFooting && isClearAtBothRows) return edge;
  }
  return null;
}

/**
 * Writes a functional elevator shaft: a hollow 3x3-walled tube from the
 * ground up through `elevatorTopDeckY` (plus a short housing above the
 * topmost stop to carve its doorway into — like a rooftop machine-room
 * bulkhead), with the vertical "well" (the shaft's own hollow center column)
 * kept hollow for the tube's *entire* height — not just at each deck row —
 * and a 2-voxel-tall neon-framed doorway carved at every stop, through
 * whichever wall is actually open there (chosen independently per stop; see
 * `pickDoorEdge`), so the shaft is enterable from — and exits back onto —
 * the tower's own hollow interior at every floor it serves.
 * `elevators/ElevatorScanner.ts` re-derives all of this (well position, stop
 * levels) purely by reading these blocks back — this function's only job is
 * to lay them out correctly.
 *
 * The unconditional full-height well clear (below) matters because the
 * shaft's fixed corner position can coincide exactly with an *upper* tier's
 * own wall corner — e.g. an inset-2 setback puts that tier's origin at
 * `tier0.x + 2, tier0.z + 2`, exactly the well's `(x + 1, z + 1)` — in which
 * case `writeBuilding` already painted that tier's own shell wall straight
 * through the well for the whole height of the (non-containing) housing
 * rows above the shaft's true top stop. Only clearing the well at each
 * planned deck row (the original approach) missed that: the housing rows
 * aren't a deck, so the well stayed solid there, `ElevatorScanner` saw a
 * non-hollow well, and silently dropped the entire shaft.
 *
 * `bridges` defaults to empty for callers (chiefly this file's own tests)
 * that only care about a bare ground-stop shaft and don't want to build a
 * full bridge/sky-lobby fixture — same convention `planElevatorShafts`
 * already uses for the same reason. Passed through unchanged to
 * `elevatorDeckYs`, which is where it actually matters (see that function's
 * doc comment).
 */
export function writeElevatorShaft(world: World, marker: ElevatorShaftMarker, bridges: readonly Bridge[] = []): void {
  const { building, x, z } = marker;
  const deckYs = elevatorDeckYs(building, x, z, bridges);
  const topDeckY = deckYs[deckYs.length - 1] as number;
  const wallTopY = topDeckY + ELEVATOR_HOUSING_ROWS;

  for (let y = building.baseY; y <= wallTopY; y++) {
    for (let dx = 0; dx < 3; dx++) {
      for (let dz = 0; dz < 3; dz++) {
        const isShell = dx === 0 || dx === 2 || dz === 0 || dz === 2;
        if (!isShell) continue;
        world.setBlockRaw(x + dx, y, z + dz, ELEVATOR_SHAFT);
      }
    }
    world.setBlockRaw(x + 1, y, z + 1, AIR); // well stays hollow through the whole tube, regardless of what any tier's own walls would otherwise put there here
  }

  // See `pickDoorEdge`'s doc comment: this is a defensive belt-and-suspenders
  // exclusion, not load-bearing geometry — coexistence is only ever granted
  // (see `canElevatorAndStairShaftCoexist`) with real clearance between the
  // two footprints.
  const forbiddenColumns: ReadonlySet<string> | null = marker.coexistsWithStairShaft
    ? new Set(stairShaftFootprintColumns(building).map((c) => `${c.x},${c.z}`))
    : null;

  for (const deckY of deckYs) {
    const doorYs: readonly [number, number] = [deckY + 1, deckY + 2];
    const edge = pickDoorEdge(world, x, z, doorYs, forbiddenColumns);
    if (!edge) continue; // no wall open at this specific stop (a degenerately narrow tier) -> leave just this stop sealed

    const [doorDx, doorDz] = edge.doorOffset;
    const [frameADx, frameADz] = edge.frameOffsetA;
    const [frameBDx, frameBDz] = edge.frameOffsetB;

    for (const doorY of doorYs) {
      world.setBlockRaw(x + doorDx, doorY, z + doorDz, AIR);
      world.setBlockRaw(x + frameADx, doorY, z + frameADz, NEON_CYAN); // door-frame posts flanking the opening
      world.setBlockRaw(x + frameBDx, doorY, z + frameBDz, NEON_CYAN);
    }
  }
}

export { towerKey };
