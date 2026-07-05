import { describe, expect, it } from 'vitest';
import { buildNavGrid, isRoadCell, type NavGrid } from '../src/entities/NavGrid';
import {
  applyVehicleFollowSpacing,
  createVehicleAt,
  stepVehicle,
  VEHICLE_FOLLOW_DISTANCE,
  VEHICLE_MIN_SEPARATION,
  type Vehicle,
} from '../src/entities/Vehicle';
import { ASPHALT, CONCRETE } from '../src/world/BlockRegistry';
import { World } from '../src/world/World';

const GROUND_Y = 1;
const WIDTH = 20;
const DEPTH = 20;

/** A 4-wide east-west road band (z = 5..8) spanning the full x range, two opposite-direction lanes. */
function buildEastWestRoadGrid(): NavGrid {
  const world = new World();
  for (let x = 0; x < WIDTH; x++) {
    for (let z = 5; z < 9; z++) {
      world.setBlock(x, 0, z, CONCRETE);
      world.setBlock(x, GROUND_Y, z, ASPHALT);
    }
  }
  return buildNavGrid(world, WIDTH, DEPTH, GROUND_Y);
}

/**
 * Two full-width bands crossing at a real 4-way junction: an east-west band
 * (z = 5..8) and a north-south band (x = 5..8), each spanning the entire
 * grid — the same "every corridor is a continuous Manhattan-grid band"
 * topology `gen/layout.ts` actually produces, unlike the single isolated
 * band every other test in this file drives on. Note the cells right at the
 * two bands' shared corners are a known `computeFlowField` rough edge (see
 * `Vehicle.ts`'s module doc comment): their local radius-probe can disagree
 * with an immediate neighbor on the same axis. Through-traffic sails past
 * that untouched (it only ever reads its *own* heading, not the cell's), so
 * the contract this describe block locks in is behavioral — lane discipline
 * and forward progress — not "every cell's flow matches," which the data
 * itself doesn't guarantee at those corners.
 */
function buildCrossingRoadGrid(): NavGrid {
  const world = new World();
  for (let x = 0; x < WIDTH; x++) {
    for (let z = 5; z < 9; z++) {
      world.setBlock(x, 0, z, CONCRETE);
      world.setBlock(x, GROUND_Y, z, ASPHALT);
    }
  }
  for (let z = 0; z < DEPTH; z++) {
    for (let x = 5; x < 9; x++) {
      world.setBlock(x, 0, z, CONCRETE);
      world.setBlock(x, GROUND_Y, z, ASPHALT);
    }
  }
  return buildNavGrid(world, WIDTH, DEPTH, GROUND_Y);
}

/**
 * A proper T-junction (not a symmetric crossing): an east-west band (z =
 * 5..8) that dead-ends at x = 8, meeting a north-south band (x = 9..12) that
 * runs the whole grid. Eastbound traffic on the east-west band is forced to
 * actually turn here — the scenario `advanceCell`'s turn branch exists for —
 * onto a corridor it was never previously heading along.
 */
function buildTJunctionGrid(): NavGrid {
  const world = new World();
  for (let x = 0; x <= 8; x++) {
    for (let z = 5; z < 9; z++) {
      world.setBlock(x, 0, z, CONCRETE);
      world.setBlock(x, GROUND_Y, z, ASPHALT);
    }
  }
  for (let z = 0; z < DEPTH; z++) {
    for (let x = 9; x < 13; x++) {
      world.setBlock(x, 0, z, CONCRETE);
      world.setBlock(x, GROUND_Y, z, ASPHALT);
    }
  }
  return buildNavGrid(world, WIDTH, DEPTH, GROUND_Y);
}

function drive(vehicle: ReturnType<typeof createVehicleAt>, grid: NavGrid, ticks: number): void {
  const dt = 1 / 60;
  for (let i = 0; i < ticks; i++) stepVehicle(vehicle, dt, grid);
}

describe('stepVehicle', () => {
  it('stays on road cells and respects its lane direction along a straight corridor', () => {
    const grid = buildEastWestRoadGrid();
    // z=5 is the "near half" lane, which computeFlowField assigns +x.
    const vehicle = createVehicleAt(2, 5, 8);

    let lastCellX = vehicle.cellX;
    for (let i = 0; i < 300; i++) {
      stepVehicle(vehicle, 1 / 60, grid);
      expect(isRoadCell(grid, vehicle.cellX, vehicle.cellZ)).toBe(true);
      expect(vehicle.cellZ).toBe(5); // never drifts into the opposite lane
      expect(vehicle.cellX).toBeGreaterThanOrEqual(lastCellX);
      lastCellX = vehicle.cellX;
    }
    expect(vehicle.dirX).toBe(1);
    expect(vehicle.dirZ).toBe(0);
  });

  it('drives the opposite lane in the opposite direction', () => {
    const grid = buildEastWestRoadGrid();
    // z=8 is the "far half" lane, assigned -x.
    const vehicle = createVehicleAt(15, 8, 8);

    drive(vehicle, grid, 60);

    expect(vehicle.dirX).toBe(-1);
    expect(vehicle.cellX).toBeLessThan(15);
  });

  it('despawns gracefully upon reaching the map edge instead of driving off it', () => {
    const grid = buildEastWestRoadGrid();
    const vehicle = createVehicleAt(WIDTH - 2, 5, 8); // heading +x, near the edge

    drive(vehicle, grid, 300);

    expect(vehicle.alive).toBe(false);
    expect(vehicle.cellX).toBeLessThan(WIDTH); // never advanced onto/past an out-of-bounds cell
  });

  it('never enters a cell that is not part of the road network', () => {
    const grid = buildEastWestRoadGrid();
    const vehicle = createVehicleAt(2, 5, 8);

    for (let i = 0; i < 200; i++) {
      stepVehicle(vehicle, 1 / 60, grid);
      if (!vehicle.alive) break;
      expect(isRoadCell(grid, vehicle.cellX, vehicle.cellZ)).toBe(true);
    }
  });
});

describe('stepVehicle at a crossing-roads intersection (junction contract)', () => {
  it('through-traffic on either band crosses the junction in lane, making forward progress until it despawns off the map edge', () => {
    const grid = buildCrossingRoadGrid();
    // z=5 is the east-west band's near-half lane (assigned +x); drive straight across the whole grid, through the north-south crossing.
    const vehicle = createVehicleAt(1, 5, 8);

    let lastCellX = vehicle.cellX;
    for (let i = 0; i < 400; i++) {
      stepVehicle(vehicle, 1 / 60, grid);
      if (!vehicle.alive) break;
      expect(vehicle.cellZ).toBe(5); // never drifts lanes crossing the junction
      expect(vehicle.cellX).toBeGreaterThanOrEqual(lastCellX); // never reverses/oscillates
      lastCellX = vehicle.cellX;
    }
    expect(vehicle.alive).toBe(false); // ran off the far edge rather than getting stuck
  });

  it('a vehicle forced to turn at a T-junction snaps onto the new corridor\'s own lane and never doubles back against it', () => {
    const grid = buildTJunctionGrid();
    // Drives the east-west band's dead end straight into the T, forcing a
    // real turn onto the north-south corridor (see buildTJunctionGrid doc).
    const vehicle = createVehicleAt(1, 5, 8);
    const visited = new Set<string>();
    let lastKey = `${vehicle.cellX},${vehicle.cellZ}`;
    visited.add(lastKey);
    let turned = false;

    for (let i = 0; i < 600; i++) {
      stepVehicle(vehicle, 1 / 60, grid);
      if (!vehicle.alive) break;
      const key = `${vehicle.cellX},${vehicle.cellZ}`;
      if (key !== lastKey) {
        // A vehicle that ever doubles back re-visits a cell it already left
        // — exactly the oscillation a bad turn-time lane choice would cause.
        expect(visited.has(key)).toBe(false);
        visited.add(key);
        lastKey = key;
      }
      if (vehicle.dirZ !== 0) turned = true;
    }

    expect(turned).toBe(true); // actually exercised the turn, not just despawned going straight
    expect(vehicle.alive).toBe(false); // eventually drives off the north-south band's far edge
  });

  it('snaps sideways onto a self-consistent lane when the turn cell itself is a tie-broken contradiction', () => {
    // buildCrossingRoadGrid's own flow field has a genuine self-contradiction
    // right at (8,7)/(8,8): the crossing's tie-break assigns that column
    // +x, but the very next cell east of it (9,7)/(9,8) -- still the same
    // east-west far lane, just outside the crossing's footprint -- is
    // correctly assigned -x (see this suite's module doc comment). A
    // vehicle spawning there (dirX=dirZ=0, so its very first step goes
    // through the same "establish a heading" branch a post-turn vehicle
    // does) naively reads (8,8)'s own (+1, 0) and would immediately
    // contradict (9,8)'s (-1, 0) one step later -- exactly what
    // `pickStableLane` exists to catch, by snapping sideways (to z=6, whose
    // entire lane agrees with +x all the way through) before ever
    // committing to (9,8). Neutralizing `pickStableLane` to a no-op (return
    // its input unchanged) makes this test fail: the vehicle lands on
    // (9,8) with dirX=+1 while grid.flowX there is -1, a same-axis
    // contradiction the assertion below catches immediately.
    const grid = buildCrossingRoadGrid();
    const vehicle = createVehicleAt(8, 8, 8);

    stepVehicle(vehicle, 1 / 60, grid); // establishes the initial heading from (8, 8)'s own flow
    drive(vehicle, grid, 30); // arrives at the first real cell past that decision

    const idx = vehicle.cellX + vehicle.cellZ * grid.width;
    const flowX = grid.flowX[idx] as number;
    const flowZ = grid.flowZ[idx] as number;
    if (flowX !== 0 && vehicle.dirX !== 0) expect(vehicle.dirX).toBe(flowX);
    if (flowZ !== 0 && vehicle.dirZ !== 0) expect(vehicle.dirZ).toBe(flowZ);
    // The whole point of the snap: it should have moved off z=8 rather than committing to the contradicting (9,8).
    expect(vehicle.cellZ).not.toBe(8);
  });
});

/** A same-lane, eastbound pair: `rear` follows `lead` down the +x axis at a shared cellZ. */
function makePair(gap: number, leadSpeed: number, rearCruiseSpeed: number): { lead: Vehicle; rear: Vehicle } {
  const lead = createVehicleAt(20, 5, leadSpeed);
  lead.dirX = 1;
  lead.x = 20 + gap;

  const rear = createVehicleAt(20, 5, rearCruiseSpeed);
  rear.dirX = 1;
  // rear.x already sits at 20.5 from createVehicleAt.
  return { lead, rear };
}

describe('applyVehicleFollowSpacing', () => {
  it('hard-clamps an already-established pairing immediately when physics closes the gap past the floor (genuine overshoot)', () => {
    // First call establishes lead as rear's leader (comfortably outside the
    // floor) so the *second* call's gap violation is against a pairing that
    // already existed -- the steady-state case, which must still snap
    // straight to the floor with no tolerance (see this task's doc comment
    // on applyVehicleFollowSpacing: a birth intrusion is the only case that
    // eases instead of clamping).
    const { lead, rear } = makePair(VEHICLE_FOLLOW_DISTANCE, 8, 8);
    applyVehicleFollowSpacing([lead, rear], 1 / 60);

    // Physics (e.g. the leader braking harder than VEHICLE_MAX_ACCEL could
    // react to) closes the gap past the floor on some later tick.
    rear.x = lead.x - (VEHICLE_MIN_SEPARATION - 1);
    applyVehicleFollowSpacing([lead, rear], 1 / 60);

    expect(lead.x - rear.x).toBeCloseTo(VEHICLE_MIN_SEPARATION, 10);
  });

  it('does not teleport a freshly-joined pairing that arrives already inside the floor -- tags it as a birth intrusion instead', () => {
    // No prior call establishing this pairing: from applyVehicleFollowSpacing's
    // point of view, this is exactly the "just turned into an already-occupied
    // lane" scenario -- lead and rear have never been leader/follower before.
    const { lead, rear } = makePair(VEHICLE_MIN_SEPARATION - 1, 8, 8);
    const rearXBefore = rear.x;
    const initialGap = lead.x - rear.x; // < VEHICLE_MIN_SEPARATION by construction

    applyVehicleFollowSpacing([lead, rear], 1 / 60);

    expect(rear.x).toBe(rearXBefore); // never moved -- no backward teleport
    expect(rear.intrusionGap).toBeCloseTo(initialGap, 10);
    expect(rear.speed).toBeLessThan(8); // braking toward 0, per followTargetSpeed at/under the floor
  });

  it('eases a birth intrusion open over several ticks: the gap never shrinks further and fully recovers, all via normal braking/pull-away motion (no clamp-sized jumps)', () => {
    const dt = 1 / 60;
    const { lead, rear } = makePair(VEHICLE_MIN_SEPARATION - 1.5, 10, 8); // lead faster, so it pulls away once rear brakes off
    const vehicles = [lead, rear];

    let prevGap = lead.x - rear.x;
    let maxBackwardStep = 0;
    let ticksInIntrusion = 0;
    let recovered = false;

    for (let tick = 0; tick < 300 && !recovered; tick++) {
      const rearXBefore = rear.x;
      // Same per-tick order as EntitySimulation.update: step first (using
      // each vehicle's speed from the end of the previous tick), then
      // follow-spacing corrects position/speed for the next tick.
      lead.x += lead.speed * dt;
      rear.x += rear.speed * dt;
      applyVehicleFollowSpacing(vehicles, dt);

      const backwardStep = rearXBefore - rear.x;
      if (backwardStep > maxBackwardStep) maxBackwardStep = backwardStep;

      const gap = lead.x - rear.x;
      if (gap < VEHICLE_MIN_SEPARATION) {
        ticksInIntrusion++;
        expect(gap).toBeGreaterThanOrEqual(prevGap - 1e-9); // monotonic: never shrinks further
        expect(rear.intrusionGap).toBeDefined();
      } else {
        recovered = true;
      }
      prevGap = gap;
    }

    expect(recovered).toBe(true); // actually cleared the floor, not stuck forever
    expect(ticksInIntrusion).toBeGreaterThan(0); // exercised real easing, not an instant no-op
    expect(ticksInIntrusion).toBeLessThan(300); // bounded recovery, not a slow-motion permanent intrusion
    expect(maxBackwardStep).toBeLessThan(0.05); // nowhere near a VEHICLE_MIN_SEPARATION-sized (4) jump
    expect(rear.intrusionGap).toBeUndefined(); // tag cleared once recovered
  });

  it('re-tags against a new leader instead of enforcing a stale intrusion floor when a third vehicle turns in mid-recovery', () => {
    // Regression for a leader-swap-while-tagged bug: R is birth-tagged
    // following A at gap 3.5 (< VEHICLE_MIN_SEPARATION). A beat later, B
    // turns into the SAME lane between A and R, arriving only 2.0 ahead of
    // R -- closer than R's stale 3.5 floor. If the monotonic no-shrink
    // branch fired here (comparing against the OLD floor rather than
    // re-tagging against the NEW leader B), it would clamp R backward by up
    // to 1.5 units in one tick -- exactly the teleport this carve-out
    // exists to remove, just relocated to a leader swap instead of a turn.
    const dt = 1 / 60;

    const A = createVehicleAt(20, 5, 8);
    A.dirX = 1;
    const R = createVehicleAt(20, 5, 8);
    R.dirX = 1;
    R.x = 0;
    A.x = R.x + 3.5;

    // Tick 1: R joins A's lane already 3.5 inside the floor -- birth intrusion, tagged not clamped.
    applyVehicleFollowSpacing([A, R], dt);
    expect(R.intrusionGap).toBeCloseTo(3.5, 10);
    expect(R.x).toBe(0);

    // Tick 2: B turns in between A and R, becoming R's new, nearer leader.
    const B = createVehicleAt(20, 5, 8);
    B.dirX = 1;
    B.x = R.x + 2.0;
    const rearXBeforeSwap = R.x;

    applyVehicleFollowSpacing([A, B, R], dt);

    expect(R.x).toBe(rearXBeforeSwap); // no backward teleport
    expect(R.intrusionGap).toBeCloseTo(2.0, 10); // re-tagged against B's actual gap, not clamped to the stale 3.5 floor
    expect(R.prevLeader).toBe(B);
  });

  it('slows a follower toward the leader speed once the gap closes inside VEHICLE_FOLLOW_DISTANCE, without exceeding the leader', () => {
    const midGap = (VEHICLE_MIN_SEPARATION + VEHICLE_FOLLOW_DISTANCE) / 2;
    const { lead, rear } = makePair(midGap, 4, 10); // leader much slower than the follower's own cruise speed

    applyVehicleFollowSpacing([lead, rear], 1); // 1s tick -- enough headroom for VEHICLE_MAX_ACCEL to reach the target

    expect(rear.speed).toBeLessThan(10); // eased down from its own cruise speed
    expect(rear.speed).toBeLessThanOrEqual(lead.speed + 1e-9);
  });

  it('leaves a follower cruising at full speed once the gap clears VEHICLE_FOLLOW_DISTANCE', () => {
    const { lead, rear } = makePair(VEHICLE_FOLLOW_DISTANCE + 5, 4, 8);
    rear.speed = 6; // below cruise, to prove it accelerates back up rather than staying capped

    applyVehicleFollowSpacing([lead, rear], 1);

    expect(rear.speed).toBeCloseTo(8, 5);
  });

  it('does not affect vehicles in a different lane (different cross-axis cell), even if physically nearby', () => {
    const { lead } = makePair(0, 8, 8);
    const other = createVehicleAt(20, 6, 8); // adjacent row -- a different lane entirely
    other.dirX = 1;
    other.x = lead.x - 0.5; // deliberately overlapping lead's x, but not its lane

    applyVehicleFollowSpacing([lead, other], 1 / 60);

    expect(other.speed).toBe(8); // untouched -- never grouped with `lead`'s lane
  });

  it('does not affect opposite-direction vehicles on the same road cell column, per this task\'s scope', () => {
    const eastbound = createVehicleAt(20, 5, 8);
    eastbound.dirX = 1;
    const westbound = createVehicleAt(20, 5, 8);
    westbound.dirX = -1;
    westbound.x = eastbound.x + 0.1; // right next to each other, opposing headings

    applyVehicleFollowSpacing([eastbound, westbound], 1 / 60);

    expect(eastbound.speed).toBe(8);
    expect(westbound.speed).toBe(8);
  });

  it('smooths speed changes rather than teleporting them: a full stop takes several ticks to ease into, not one', () => {
    const { lead, rear } = makePair(VEHICLE_MIN_SEPARATION, 0, 8);
    lead.speed = 0; // leader already stopped dead

    applyVehicleFollowSpacing([lead, rear], 1 / 60);

    expect(rear.speed).toBeGreaterThan(0); // eased down, not snapped straight to 0 in a single 1/60s tick
  });

  it('resolves a whole stopped queue leader-first: a three-car queue never overlaps anywhere down the chain', () => {
    const back = createVehicleAt(20, 5, 8);
    back.dirX = 1;
    back.x = 20.5;
    const middle = createVehicleAt(20, 5, 8);
    middle.dirX = 1;
    middle.x = 20.5 + VEHICLE_MIN_SEPARATION;
    const front = createVehicleAt(20, 5, 8);
    front.dirX = 1;
    front.x = middle.x + VEHICLE_MIN_SEPARATION;
    front.speed = 0; // stopped dead at the front of the queue
    const queue = [back, middle, front];

    // Establish all three pairings at a compliant spacing first, so the
    // follow-up violation below is against already-existing pairings (the
    // steady-state case this test is actually about), not a birth intrusion.
    applyVehicleFollowSpacing(queue, 1 / 60);

    // Physics now closes both gaps past the floor on some later tick.
    middle.x = back.x + (VEHICLE_MIN_SEPARATION - 1);
    front.x = middle.x + (VEHICLE_MIN_SEPARATION - 1);
    applyVehicleFollowSpacing(queue, 1 / 60);

    expect(front.x - middle.x).toBeGreaterThanOrEqual(VEHICLE_MIN_SEPARATION - 1e-9);
    expect(middle.x - back.x).toBeGreaterThanOrEqual(VEHICLE_MIN_SEPARATION - 1e-9);
  });

  it('soaks a lane of vehicles driving a real road grid: no overlap and no teleport over a long run', () => {
    const grid = buildEastWestRoadGrid();
    const vehicles = [
      createVehicleAt(2, 5, 9),
      createVehicleAt(6, 5, 6), // slower leader ahead -- forces the follower behind it to yield
    ];
    const dt = 1 / 60;
    const maxPerTickDisplacement = 9 * dt * 1.5; // fastest cruise speed * dt, with slack

    for (let tick = 0; tick < 1200; tick++) {
      const before = vehicles.map((v) => ({ x: v.x, z: v.z }));
      for (const v of vehicles) stepVehicle(v, dt, grid);
      applyVehicleFollowSpacing(vehicles, dt);

      for (let i = 0; i < vehicles.length; i++) {
        const v = vehicles[i] as Vehicle;
        const prev = before[i] as { x: number; z: number };
        const displacement = Math.hypot(v.x - prev.x, v.z - prev.z);
        expect(displacement).toBeLessThanOrEqual(maxPerTickDisplacement);
      }

      const [rear, lead] = vehicles as [Vehicle, Vehicle];
      if (rear.alive && lead.alive && rear.cellZ === lead.cellZ && rear.dirX === lead.dirX && rear.dirX !== 0) {
        expect(lead.x - rear.x).toBeGreaterThanOrEqual(VEHICLE_MIN_SEPARATION - 1e-6);
      }
    }
  });
});
