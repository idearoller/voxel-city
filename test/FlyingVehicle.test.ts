import { describe, expect, it } from 'vitest';
import {
  applyFlyingVehicleFollowSpacing,
  captureRenderPrevState,
  createFlyingVehicleOnLane,
  FLYING_VEHICLE_FOLLOW_DISTANCE,
  FLYING_VEHICLE_MIN_SEPARATION,
  snapRenderPrevIfTeleported,
  stepFlyingVehicle,
  type FlyingVehicle,
} from '../src/entities/FlyingVehicle';
import type { SkyLane } from '../src/entities/SkyLane';

const WIDTH = 400;
const DEPTH = 400;

function makeLane(overrides: Partial<SkyLane> = {}): SkyLane {
  return { axis: 'x', fixed: 200, altitude: 116, start: 0, end: WIDTH, ...overrides };
}

describe('createFlyingVehicleOnLane', () => {
  it('places the vehicle at the lane fixed coordinate and the given travel coordinate, at the lane altitude', () => {
    const lane = makeLane({ axis: 'x', fixed: 150, altitude: 128 });
    const vehicle = createFlyingVehicleOnLane(lane, 30, 1, 15);

    expect(vehicle.x).toBe(30);
    expect(vehicle.z).toBe(150);
    expect(vehicle.y).toBe(128);
    expect(vehicle.alive).toBe(true);
  });

  it('sets heading along the lane axis only, matching the requested direction', () => {
    const xLane = makeLane({ axis: 'x' });
    const forward = createFlyingVehicleOnLane(xLane, 10, 1, 15);
    expect(forward.dirX).toBe(1);
    expect(forward.dirZ).toBe(0);

    const backward = createFlyingVehicleOnLane(xLane, 10, -1, 15);
    expect(backward.dirX).toBe(-1);
    expect(backward.dirZ).toBe(0);

    const zLane = makeLane({ axis: 'z', fixed: 80 });
    const zForward = createFlyingVehicleOnLane(zLane, 10, 1, 15);
    expect(zForward.dirX).toBe(0);
    expect(zForward.dirZ).toBe(1);
    expect(zForward.x).toBe(80);
    expect(zForward.z).toBe(10);
  });
});

describe('stepFlyingVehicle', () => {
  it('advances position along its heading at speed*dt, holding altitude and cross-axis coordinate fixed', () => {
    const lane = makeLane({ axis: 'x', fixed: 200, altitude: 104 });
    const vehicle = createFlyingVehicleOnLane(lane, 50, 1, 20);

    for (let i = 0; i < 60; i++) stepFlyingVehicle(vehicle, 1 / 60, WIDTH, DEPTH);

    expect(vehicle.x).toBeCloseTo(70, 5); // 50 + 20 * 1s
    expect(vehicle.z).toBe(200);
    expect(vehicle.y).toBe(104);
    expect(vehicle.alive).toBe(true);
  });

  it('never turns: dirX/dirZ stay exactly what they were set to at spawn, however long it flies', () => {
    const lane = makeLane({ axis: 'z', fixed: 90 });
    const vehicle = createFlyingVehicleOnLane(lane, 50, -1, 18);

    for (let i = 0; i < 500; i++) {
      stepFlyingVehicle(vehicle, 1 / 60, WIDTH, DEPTH);
      if (!vehicle.alive) break;
      expect(vehicle.dirX).toBe(0);
      expect(vehicle.dirZ).toBe(-1);
    }
  });

  it('despawns the instant it crosses the world edge, in either travel direction', () => {
    const lane = makeLane({ axis: 'x', fixed: 200 });
    const nearFarEdge = createFlyingVehicleOnLane(lane, WIDTH - 5, 1, 50);
    for (let i = 0; i < 60 && nearFarEdge.alive; i++) stepFlyingVehicle(nearFarEdge, 1 / 60, WIDTH, DEPTH);
    expect(nearFarEdge.alive).toBe(false);

    const nearNearEdge = createFlyingVehicleOnLane(lane, 5, -1, 50);
    for (let i = 0; i < 60 && nearNearEdge.alive; i++) stepFlyingVehicle(nearNearEdge, 1 / 60, WIDTH, DEPTH);
    expect(nearNearEdge.alive).toBe(false);
  });

  it('does nothing once already dead (no further movement, stays dead)', () => {
    const lane = makeLane();
    const vehicle = createFlyingVehicleOnLane(lane, 50, 1, 20);
    vehicle.alive = false;
    const xBefore = vehicle.x;

    stepFlyingVehicle(vehicle, 1 / 60, WIDTH, DEPTH);

    expect(vehicle.x).toBe(xBefore);
    expect(vehicle.alive).toBe(false);
  });
});

describe('applyFlyingVehicleFollowSpacing', () => {
  const lane = makeLane({ axis: 'x', fixed: 200 });

  it('never lets a same-lane follower closer than FLYING_VEHICLE_MIN_SEPARATION to its leader', () => {
    const lead = createFlyingVehicleOnLane(lane, 100 + FLYING_VEHICLE_MIN_SEPARATION - 1, 1, 20);
    const rear = createFlyingVehicleOnLane(lane, 100, 1, 20);

    applyFlyingVehicleFollowSpacing([lead, rear], 1 / 60);

    expect(lead.x - rear.x).toBeCloseTo(FLYING_VEHICLE_MIN_SEPARATION, 10);
  });

  it('slows a follower toward a slower leader once the gap closes inside FLYING_VEHICLE_FOLLOW_DISTANCE', () => {
    const midGap = (FLYING_VEHICLE_MIN_SEPARATION + FLYING_VEHICLE_FOLLOW_DISTANCE) / 2;
    const lead = createFlyingVehicleOnLane(lane, 100 + midGap, 1, 10);
    const rear = createFlyingVehicleOnLane(lane, 100, 1, 20);

    applyFlyingVehicleFollowSpacing([lead, rear], 1); // 1s tick -- enough headroom for FLYING_VEHICLE_MAX_ACCEL to reach the target

    expect(rear.speed).toBeLessThan(20);
    expect(rear.speed).toBeLessThanOrEqual(lead.speed + 1e-9);
  });

  it('leaves a solo flyer cruising at its own speed (no leader in its lane)', () => {
    const solo = createFlyingVehicleOnLane(lane, 100, 1, 18);
    solo.speed = 10;

    applyFlyingVehicleFollowSpacing([solo], 1);

    expect(solo.speed).toBeCloseTo(18, 5);
  });

  it('does not affect opposite-direction flyers sharing the same physical lane (out of scope -- see module doc comment)', () => {
    const forward = createFlyingVehicleOnLane(lane, 100, 1, 20);
    const backward = createFlyingVehicleOnLane(lane, 100.5, -1, 20); // right next to each other, opposing headings

    applyFlyingVehicleFollowSpacing([forward, backward], 1 / 60);

    expect(forward.speed).toBe(20);
    expect(backward.speed).toBe(20);
  });

  it('does not affect flyers on a different lane (different fixed cross-axis coordinate)', () => {
    const lead = createFlyingVehicleOnLane(lane, 120, 1, 20);
    const otherLane = makeLane({ axis: 'x', fixed: 210 });
    const other = createFlyingVehicleOnLane(otherLane, 100, 1, 20);

    applyFlyingVehicleFollowSpacing([lead, other], 1 / 60);

    expect(other.speed).toBe(20);
  });

  it('soaks a same-lane pair over a long flight: no overlap and no teleport', () => {
    const vehicles: FlyingVehicle[] = [
      createFlyingVehicleOnLane(lane, 0, 1, 25),
      createFlyingVehicleOnLane(lane, 20, 1, 15), // slower leader ahead
    ];
    const dt = 1 / 60;
    const maxPerTickDisplacement = 25 * dt * 1.5;

    for (let tick = 0; tick < 1200; tick++) {
      const before = vehicles.map((v) => ({ x: v.x, z: v.z }));
      for (const v of vehicles) stepFlyingVehicle(v, dt, WIDTH, DEPTH);
      applyFlyingVehicleFollowSpacing(vehicles, dt);

      for (let i = 0; i < vehicles.length; i++) {
        const v = vehicles[i] as FlyingVehicle;
        const prev = before[i] as { x: number; z: number };
        const displacement = Math.hypot(v.x - prev.x, v.z - prev.z);
        expect(displacement).toBeLessThanOrEqual(maxPerTickDisplacement);
      }

      const [rear, lead2] = vehicles as [FlyingVehicle, FlyingVehicle];
      if (rear.alive && lead2.alive) {
        expect(lead2.x - rear.x).toBeGreaterThanOrEqual(FLYING_VEHICLE_MIN_SEPARATION - 1e-6);
      }
    }
  });
});

describe('render-interpolation state (prevX/prevZ)', () => {
  it('createFlyingVehicleOnLane seeds prev equal to the initial position, so a fresh spawn never smears in', () => {
    const lane = makeLane({ axis: 'x', fixed: 150, altitude: 128 });
    const vehicle = createFlyingVehicleOnLane(lane, 30, 1, 15);
    expect(vehicle.prevX).toBe(vehicle.x);
    expect(vehicle.prevZ).toBe(vehicle.z);
  });

  it('captureRenderPrevState snapshots the current position, and a subsequent step leaves it holding the pre-step position', () => {
    const lane = makeLane({ axis: 'x', fixed: 200, altitude: 104 });
    const vehicle = createFlyingVehicleOnLane(lane, 50, 1, 20);

    const xBefore = vehicle.x;
    const zBefore = vehicle.z;

    captureRenderPrevState(vehicle);
    stepFlyingVehicle(vehicle, 1 / 60, WIDTH, DEPTH);

    expect(vehicle.x).not.toBe(xBefore); // sanity: the step actually moved it
    expect(vehicle.prevX).toBe(xBefore);
    expect(vehicle.prevZ).toBe(zBefore);
  });

  it('snapRenderPrevIfTeleported leaves prev untouched after ordinary bounded movement', () => {
    const lane = makeLane({ axis: 'x', fixed: 200, altitude: 104 });
    const vehicle = createFlyingVehicleOnLane(lane, 50, 1, 20);
    captureRenderPrevState(vehicle);
    vehicle.x += (20 * (1 / 60)) / 2; // well within the speed*dt bound

    snapRenderPrevIfTeleported(vehicle, 1 / 60);

    expect(vehicle.prevX).toBe(50);
  });

  it('snapRenderPrevIfTeleported collapses prev to current when a same-tick jump is implausibly large', () => {
    const lane = makeLane({ axis: 'x', fixed: 200, altitude: 104 });
    const vehicle = createFlyingVehicleOnLane(lane, 50, 1, 20);
    captureRenderPrevState(vehicle);
    vehicle.x += 500; // a teleport far beyond anything stepFlyingVehicle could produce in one tick

    snapRenderPrevIfTeleported(vehicle, 1 / 60);

    expect(vehicle.prevX).toBe(vehicle.x); // snapped -- no smear across the sky next render
    expect(vehicle.prevZ).toBe(vehicle.z);
  });
});
