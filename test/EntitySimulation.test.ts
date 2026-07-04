import { describe, expect, it } from 'vitest';
import { DEFAULT_ENTITY_CONFIG, EntitySimulation, type EntitySimulationConfig } from '../src/entities/EntitySimulation';
import type { NavGrid } from '../src/entities/NavGrid';

function makeOpenGrid(width: number, depth: number): NavGrid {
  return {
    width,
    depth,
    groundY: 1,
    sidewalk: new Uint8Array(width * depth).fill(1),
    road: new Uint8Array(width * depth).fill(1),
    flowX: new Int8Array(width * depth).fill(1),
    flowZ: new Int8Array(width * depth),
  };
}

const TEST_CONFIG: EntitySimulationConfig = {
  ...DEFAULT_ENTITY_CONFIG,
  maxPedestrians: 5,
  maxVehicles: 3,
  spawnMinRadius: 2,
  spawnMaxRadius: 20,
  despawnRadius: 30,
};

describe('EntitySimulation', () => {
  it('does nothing before reset() has provided a NavGrid', () => {
    const sim = new EntitySimulation(TEST_CONFIG);
    sim.update(1 / 60, 0, 0);
    expect(sim.pedestrianList).toHaveLength(0);
    expect(sim.vehicleList).toHaveLength(0);
  });

  it('ramps up population to the configured caps over repeated updates', () => {
    const sim = new EntitySimulation(TEST_CONFIG);
    sim.reset(makeOpenGrid(60, 60), 'sim-ramp-up');

    for (let i = 0; i < 200; i++) sim.update(1 / 60, 30, 30);

    expect(sim.pedestrianList.length).toBe(TEST_CONFIG.maxPedestrians);
    expect(sim.vehicleList.length).toBe(TEST_CONFIG.maxVehicles);
  });

  it('despawns entities that end up beyond the despawn radius', () => {
    const sim = new EntitySimulation(TEST_CONFIG);
    sim.reset(makeOpenGrid(300, 300), 'sim-despawn');

    for (let i = 0; i < 50; i++) sim.update(1 / 60, 150, 150);
    expect(sim.pedestrianList.length).toBeGreaterThan(0);

    // Player teleports far away -- every existing entity is now well beyond despawnRadius.
    sim.update(1 / 60, 150 + 10_000, 150);

    for (const ped of sim.pedestrianList) {
      const dist = Math.hypot(ped.x - (150 + 10_000), ped.z - 150);
      expect(dist).toBeLessThanOrEqual(TEST_CONFIG.despawnRadius);
    }
    for (const vehicle of sim.vehicleList) {
      const dist = Math.hypot(vehicle.x - (150 + 10_000), vehicle.z - 150);
      expect(dist).toBeLessThanOrEqual(TEST_CONFIG.despawnRadius);
    }
  });

  it('reset() clears every entity and rebuilds cleanly against a new grid', () => {
    const sim = new EntitySimulation(TEST_CONFIG);
    sim.reset(makeOpenGrid(60, 60), 'sim-before');
    for (let i = 0; i < 200; i++) sim.update(1 / 60, 30, 30);
    expect(sim.pedestrianList.length).toBeGreaterThan(0);

    sim.reset(makeOpenGrid(60, 60), 'sim-after');

    expect(sim.pedestrianList).toHaveLength(0);
    expect(sim.vehicleList).toHaveLength(0);
  });

  it('never spawns a pedestrian closer than spawnMinRadius to the player', () => {
    const sim = new EntitySimulation(TEST_CONFIG);
    sim.reset(makeOpenGrid(60, 60), 'sim-min-radius');

    sim.update(1 / 60, 30, 30);

    for (const ped of sim.pedestrianList) {
      const dist = Math.hypot(ped.x - 30, ped.z - 30);
      expect(dist).toBeGreaterThanOrEqual(TEST_CONFIG.spawnMinRadius - 1);
    }
  });
});
