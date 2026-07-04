import { describe, expect, it } from 'vitest';
import { createFlyingVehicleOnLane, stepFlyingVehicle } from '../src/entities/FlyingVehicle';
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
