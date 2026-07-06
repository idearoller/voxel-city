import { describe, expect, it } from 'vitest';
import { ElevatorSimulation } from '../src/elevators/ElevatorSimulation';
import type { ElevatorShaft } from '../src/elevators/ElevatorScanner';

function shaft(overrides: Partial<ElevatorShaft> = {}): ElevatorShaft {
  return {
    id: 'shaft-1',
    wellX: 10,
    wellZ: 20,
    minY: 2,
    maxY: 40,
    stops: [2, 20, 41],
    doorCells: [
      { x: 9, z: 20 },
      { x: 9, z: 20 },
      { x: 9, z: 20 },
    ],
    ...overrides,
  };
}

describe('ElevatorSimulation', () => {
  it('parks a freshly synced shaft at its lowest stop', () => {
    const sim = new ElevatorSimulation();
    const s = shaft();
    sim.sync([s]);

    const car = sim.car(s.id);
    expect(car?.feetY).toBe(2);
    expect(car?.targetFeetY).toBeNull();
  });

  it('moves toward the called stop and lands on it exactly, without overshoot', () => {
    const sim = new ElevatorSimulation();
    const s = shaft();
    sim.sync([s]);
    sim.call(s, 1); // ground (2) -> next stop up (20)

    // Step in coarse 0.5s chunks; speed is small enough that overshoot would show up as skipping past 20.
    for (let i = 0; i < 40; i++) {
      sim.update(0.5);
    }

    const car = sim.car(s.id)!;
    expect(car.feetY).toBe(20);
    expect(car.targetFeetY).toBeNull();
  });

  it('never overshoots even with a single large dt step', () => {
    const sim = new ElevatorSimulation();
    const s = shaft();
    sim.sync([s]);
    sim.call(s, 1);

    sim.update(1000); // absurdly large single step
    const car = sim.car(s.id)!;
    expect(car.feetY).toBe(20);
  });

  it('reports the per-tick delta a rider should be carried by, then zero once parked', () => {
    const sim = new ElevatorSimulation();
    const s = shaft();
    sim.sync([s]);
    sim.call(s, 1);

    sim.update(1 / 60);
    const midway = sim.car(s.id)!;
    expect(midway.lastDeltaY).toBeGreaterThan(0);

    // Run it to completion, then one more idle tick.
    for (let i = 0; i < 600; i++) sim.update(1 / 60);
    sim.update(1 / 60);
    expect(sim.car(s.id)!.lastDeltaY).toBe(0);
  });

  it('ignores a call while already in transit (must arrive before it can be redirected)', () => {
    const sim = new ElevatorSimulation();
    const s = shaft();
    sim.sync([s]);
    sim.call(s, 1); // heading for stop index 1 (Y=20)
    sim.update(1 / 60);

    sim.call(s, -1); // should be ignored: car is mid-transit
    expect(sim.car(s.id)!.targetFeetY).toBe(20);
  });

  it('refuses to call past the top or bottom stop', () => {
    const sim = new ElevatorSimulation();
    const s = shaft();
    sim.sync([s]);

    sim.call(s, -1); // already at the bottom stop
    expect(sim.car(s.id)!.targetFeetY).toBeNull();

    for (let i = 0; i < 200; i++) sim.update(0.5); // no-op: nothing was ever called
    sim.call(s, 1);
    for (let i = 0; i < 200; i++) sim.update(0.5);
    sim.call(s, 1);
    for (let i = 0; i < 200; i++) sim.update(0.5);
    expect(sim.car(s.id)!.feetY).toBe(41); // topmost stop reached

    sim.call(s, 1); // already at the top
    expect(sim.car(s.id)!.targetFeetY).toBeNull();
  });

  it('drops a car whose shaft disappeared on rescan, and re-parks a reappearing one fresh', () => {
    const sim = new ElevatorSimulation();
    const s = shaft();
    sim.sync([s]);
    sim.call(s, 1);
    sim.update(0.5);

    sim.sync([]); // shaft gone (e.g. a sandbox edit broke it)
    expect(sim.car(s.id)).toBeUndefined();

    sim.sync([s]); // reappears (e.g. undone, or regenerated identically)
    expect(sim.car(s.id)?.feetY).toBe(2);
  });

  it('snaps a parked car onto the nearest surviving stop if its exact stop was removed by an edit', () => {
    const sim = new ElevatorSimulation();
    const s = shaft({ stops: [2, 20, 41] });
    sim.sync([s]);
    sim.call(s, 1);
    for (let i = 0; i < 200; i++) sim.update(0.5); // parked at 20

    const shrunk = shaft({ stops: [2, 41] }); // middle stop edited away
    sim.sync([shrunk]);
    expect(sim.car(shrunk.id)!.feetY).toBe(2); // nearest surviving stop to 20 (|20-2|=18 < |20-41|=21)
  });
});
