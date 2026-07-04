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

const BRIDGE_MAX_GAP = 40;
const BRIDGE_CHANCE = 0.25;
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
const SKY_LEVELS = [30, 60, 90] as const;
/** Deck (1) + rails (2) + headroom (1) that must fit below the tower's roof at the chosen sky level. */
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

function candidateTowers(buildings: readonly BuildingPlan[]): BuildingPlan[] {
  return buildings.filter(
    (b) => b.height >= BRIDGE_MIN_TOWER_HEIGHT && b.width >= BRIDGE_MIN_TOWER_FOOTPRINT && b.depth >= BRIDGE_MIN_TOWER_FOOTPRINT,
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

/** Picks the highest sky level both towers clear (with margin) at their un-setback-shrunk footprint, or null. */
/** The top step's own row plus the 2 risers below it all need to clear any setback deck above. */
const STAIR_TOP_HEADROOM_CLEARANCE = 3;

function pickSkyLevel(a: BuildingPlan, b: BuildingPlan): number | null {
  const minTop = Math.min(a.baseY + a.height, b.baseY + b.height);
  let chosen: number | null = null;
  for (const level of SKY_LEVELS) {
    if (level + SKY_LEVEL_MARGIN > minTop) continue;
    if (!isGroundFootprintAt(a, level) || !isGroundFootprintAt(b, level)) continue;
    if (
      !hasSetbackHeadroomAbove(a, level, STAIR_TOP_HEADROOM_CLEARANCE) ||
      !hasSetbackHeadroomAbove(b, level, STAIR_TOP_HEADROOM_CLEARANCE)
    ) {
      continue;
    }
    chosen = level;
  }
  return chosen;
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
 * footprints face each other with enough lateral overlap for a 3-wide deck,
 * and who share a valid sky level, rolls a BRIDGE_CHANCE coin (forked per
 * pair so it's independent of pair iteration order) for a bridge.
 *
 * Each tower may host at most one bridge. A second bridge on the same tower
 * would need its own stair shaft, but shafts are keyed by tower position
 * alone (see `planStairShafts`) and always spiral up from the same 3x3
 * origin — a shaft climbing past a lower bridge's level would have to punch
 * through that lower bridge's own sky-lobby floor, which spans the tower's
 * *entire* footprint. One bridge per tower sidesteps that conflict entirely
 * rather than trying to keep two floors and two shafts from overlapping.
 *
 * The gap between the two bridge towers is otherwise unchecked ground — a
 * third, unrelated building can sit in it. Its footprint at the bridge's
 * level (if it even reaches that high) is excluded from candidacy so the
 * deck can never be routed straight through someone else's wall.
 */
export function planBridges(buildings: readonly BuildingPlan[], rng: Rng): Bridge[] {
  const towers = candidateTowers(buildings);
  const bridgedTowers = new Set<string>();
  const bridges: Bridge[] = [];

  for (let i = 0; i < towers.length; i++) {
    for (let j = i + 1; j < towers.length; j++) {
      const a = towers[i] as BuildingPlan;
      const b = towers[j] as BuildingPlan;
      if (bridgedTowers.has(towerKey(a)) || bridgedTowers.has(towerKey(b))) continue;

      const info = gapBetween(a, b);
      if (!info || info.gap <= 0 || info.gap > BRIDGE_MAX_GAP) continue;

      const level = pickSkyLevel(a, b);
      if (level === null) continue;

      const pairRng = rng.fork(`${towerKey(a)}-${towerKey(b)}`);
      if (!pairRng.chance(BRIDGE_CHANCE)) continue;

      const laneSpan = info.overlapEnd - info.overlapStart;
      const laneStart = info.overlapStart + Math.floor((laneSpan - BRIDGE_DECK_WIDTH) / 2);
      const [first, second] = info.aFirst ? [a, b] : [b, a];

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

      bridgedTowers.add(towerKey(a));
      bridgedTowers.add(towerKey(b));
      bridges.push({ ...deck, level, towerA: first, towerB: second });
    }
  }

  return bridges;
}

/**
 * Writes a bridge: a solid METAL deck across the full 3-wide band, 2-high
 * NEON rails along the two edge rows (leaving the 1-wide middle lane walkable
 * with 2 voxels of headroom), and a door opening punched into each tower's
 * facing wall at the middle lane so the deck reads as reachable, not just
 * decorative.
 */
export function writeBridge(world: World, bridge: Bridge): void {
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
        world.setBlockRaw(x + dx, level + 2, railZ, NEON_CYAN);
      }
    }
    const midZ = z + 1;
    for (let dy = 1; dy <= 2; dy++) {
      world.setBlockRaw(x - 1, level + dy, midZ, AIR);
      world.setBlockRaw(x + width, level + dy, midZ, AIR);
    }
  } else {
    for (let dz = 0; dz < depth; dz++) {
      for (const railX of [x, x + width - 1]) {
        world.setBlockRaw(railX, level + 1, z + dz, NEON_CYAN);
        world.setBlockRaw(railX, level + 2, z + dz, NEON_CYAN);
      }
    }
    const midX = x + 1;
    for (let dy = 1; dy <= 2; dy++) {
      world.setBlockRaw(midX, level + dy, z - 1, AIR);
      world.setBlockRaw(midX, level + dy, z + depth, AIR);
    }
  }
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
 * The slab leaves open exactly the 1-2 columns the risers *just below* the
 * top step need for their own headroom (their step is at y=level-1 or
 * y=level-2, so their "2 voxels of air above" reaches up to y=level, which a
 * blanket slab would otherwise cap). Earlier this excluded the whole 3x3
 * shaft footprint instead, which was worse: the ring is built so every cell
 * is on the shaft's outer edge, so the top step's *own* grid neighbors are
 * other ring cells — blanket-excluding all of them could wall the top step
 * off from the rest of the floor entirely (observed on narrow-footprint
 * towers, where the shaft leaves no slab margin on one side). Excluding only
 * the two columns that actually need to stay open lets every other ring
 * cell — including the top step's non-predecessor neighbors — get a normal
 * solid floor, so the top step always has a walkable way out.
 */
export interface SkyLobby {
  x: number;
  z: number;
  width: number;
  depth: number;
  y: number;
  /** Absolute (x, z) columns to leave uncovered at y — headroom for the riser(s) just below the top step. */
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
      // writeStairShaft, not the slab); the up-to-2 entries before it are
      // the risers whose headroom this slab would otherwise cap.
      const openColumns = steps.slice(Math.max(0, steps.length - 3), steps.length - 1).map((s) => ({ x: s.x, z: s.z }));

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
const WALKWAY_Y = 12;
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
const BILLBOARD_WIDTH = 4;
const BILLBOARD_HEIGHT = 3;
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

export interface ElevatorShaftMarker {
  building: BuildingPlan;
  x: number;
  z: number;
}

/**
 * Rolls an empty 3x3-walled shaft for some tall towers. Skips towers that
 * already got a real stair shaft so the two never overlap.
 */
export function planElevatorShafts(
  buildings: readonly BuildingPlan[],
  rng: Rng,
  stairShaftTowerKeys: ReadonlySet<string>,
): ElevatorShaftMarker[] {
  const markers: ElevatorShaftMarker[] = [];

  for (const building of buildings) {
    if (building.height < ELEVATOR_MIN_HEIGHT) continue;
    const key = towerKey(building);
    if (stairShaftTowerKeys.has(key)) continue;

    const buildingRng = rng.fork(key);
    if (!buildingRng.chance(ELEVATOR_CHANCE)) continue;

    const tier0 = building.tiers[0] as NonNullable<(typeof building.tiers)[0]>;
    markers.push({ building, x: tier0.x + 1, z: tier0.z + 1 });
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
 * tier boundary up to and including `elevatorTopDeckY`. Each entry is a solid
 * floor row; a rider's feet stand at `deckY + 1` (matching `Bridge.level` /
 * `SkyLobby.y`'s "solid floor at Y, walkable at Y+1" convention elsewhere in
 * this module).
 */
function elevatorDeckYs(building: BuildingPlan, x: number, z: number): number[] {
  const topDeckY = elevatorTopDeckY(building, x, z);
  const deckYs = [building.baseY - 1];
  for (const tier of building.tiers) {
    const absY = building.baseY + tier.yEnd;
    if (absY > topDeckY) break;
    deckYs.push(absY);
  }
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
 */
function pickDoorEdge(world: World, x: number, z: number, doorYs: readonly [number, number]): DoorEdge | null {
  const floorY = doorYs[0] - 1;
  for (const edge of DOOR_EDGES) {
    const [outDx, outDz] = edge.outwardOffset;
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
 */
export function writeElevatorShaft(world: World, marker: ElevatorShaftMarker): void {
  const { building, x, z } = marker;
  const deckYs = elevatorDeckYs(building, x, z);
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

  for (const deckY of deckYs) {
    const doorYs: readonly [number, number] = [deckY + 1, deckY + 2];
    const edge = pickDoorEdge(world, x, z, doorYs);
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
