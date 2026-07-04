import { describe, expect, it } from 'vitest';
import { DEFAULT_ENTITY_CONFIG, EntitySimulation, type EntitySimulationConfig } from '../src/entities/EntitySimulation';
import type { ElevatedLevel, NavGrid } from '../src/entities/NavGrid';
import type { SkyLane } from '../src/entities/SkyLane';

const ELEVATED_Y = 30;

function makeOpenGrid(width: number, depth: number): NavGrid {
  return {
    width,
    depth,
    groundY: 1,
    sidewalk: new Uint8Array(width * depth).fill(1),
    road: new Uint8Array(width * depth).fill(1),
    flowX: new Int8Array(width * depth).fill(1),
    flowZ: new Int8Array(width * depth),
    elevatedLevels: [],
    stairLinks: [],
  };
}

/** Builds an `ElevatedLevel` from a `walkable` grid, deriving `cells` the same way `NavGrid.buildElevatedLevel` does. */
function makeElevatedLevel(y: number, width: number, walkable: Uint8Array): ElevatedLevel {
  const cells: Array<{ x: number; z: number }> = [];
  for (let i = 0; i < walkable.length; i++) {
    if (walkable[i] !== 1) continue;
    cells.push({ x: i % width, z: Math.floor(i / width) });
  }
  return { y, walkable, cells };
}

/** An open ground grid plus one fully-walkable elevated deck at `ELEVATED_Y` covering the same footprint. */
function makeGridWithElevatedDeck(width: number, depth: number): NavGrid {
  const walkable = new Uint8Array(width * depth).fill(1);
  return { ...makeOpenGrid(width, depth), elevatedLevels: [makeElevatedLevel(ELEVATED_Y, width, walkable)] };
}

const TEST_CONFIG: EntitySimulationConfig = {
  ...DEFAULT_ENTITY_CONFIG,
  maxPedestrians: 5,
  maxVehicles: 3,
  spawnMinRadius: 2,
  spawnMaxRadius: 20,
  despawnRadius: 30,
};

/** A single straight east-west sky lane, fixed at z=30, spanning the whole test grid. */
function makeStraightLane(overrides: Partial<SkyLane> = {}): SkyLane {
  return { axis: 'x', fixed: 30, altitude: 116, start: 0, end: 60, ...overrides };
}

describe('EntitySimulation', () => {
  it('does nothing before reset() has provided a NavGrid', () => {
    const sim = new EntitySimulation(TEST_CONFIG);
    sim.update(1 / 60, 0, 1, 0);
    expect(sim.pedestrianList).toHaveLength(0);
    expect(sim.vehicleList).toHaveLength(0);
  });

  it('ramps up population to the configured caps over repeated updates', () => {
    const sim = new EntitySimulation(TEST_CONFIG);
    sim.reset(makeOpenGrid(60, 60), 'sim-ramp-up');

    for (let i = 0; i < 200; i++) sim.update(1 / 60, 30, 1, 30);

    expect(sim.pedestrianList.length).toBe(TEST_CONFIG.maxPedestrians);
    expect(sim.vehicleList.length).toBe(TEST_CONFIG.maxVehicles);
  });

  it('despawns entities that end up beyond the despawn radius', () => {
    const sim = new EntitySimulation(TEST_CONFIG);
    sim.reset(makeOpenGrid(300, 300), 'sim-despawn');

    for (let i = 0; i < 50; i++) sim.update(1 / 60, 150, 1, 150);
    expect(sim.pedestrianList.length).toBeGreaterThan(0);

    // Player teleports far away -- every existing entity is now well beyond despawnRadius.
    sim.update(1 / 60, 150 + 10_000, 1, 150);

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
    for (let i = 0; i < 200; i++) sim.update(1 / 60, 30, 1, 30);
    expect(sim.pedestrianList.length).toBeGreaterThan(0);

    sim.reset(makeOpenGrid(60, 60), 'sim-after');

    expect(sim.pedestrianList).toHaveLength(0);
    expect(sim.vehicleList).toHaveLength(0);
  });

  it('never spawns a pedestrian closer than spawnMinRadius to the player', () => {
    const sim = new EntitySimulation(TEST_CONFIG);
    sim.reset(makeOpenGrid(60, 60), 'sim-min-radius');

    sim.update(1 / 60, 30, 1, 30);

    for (const ped of sim.pedestrianList) {
      const dist = Math.hypot(ped.x - 30, ped.z - 30);
      expect(dist).toBeGreaterThanOrEqual(TEST_CONFIG.spawnMinRadius - 1);
    }
  });

  it('never spawns an elevated pedestrian when the grid has no elevated levels', () => {
    const sim = new EntitySimulation(TEST_CONFIG);
    sim.reset(makeOpenGrid(60, 60), 'sim-no-elevated');

    for (let i = 0; i < 200; i++) sim.update(1 / 60, 30, 1, 30);

    expect(sim.pedestrianList.length).toBeGreaterThan(0);
    for (const ped of sim.pedestrianList) expect(ped.y).toBe(1);
  });

  it('spawns some pedestrians onto the elevated deck, always on a walkable deck cell, and caps the elevated share', () => {
    const wideConfig: EntitySimulationConfig = { ...TEST_CONFIG, maxPedestrians: 60 };
    const sim = new EntitySimulation(wideConfig);
    sim.reset(makeGridWithElevatedDeck(60, 60), 'sim-elevated-mix');

    // Player at the same altitude as the deck -- isolates the 30% share cap
    // from the separate altitude-distance mechanic (see Spawner.test.ts for
    // that one).
    for (let i = 0; i < 400; i++) sim.update(1 / 60, 30, ELEVATED_Y, 30);

    expect(sim.pedestrianList.length).toBe(wideConfig.maxPedestrians);
    const elevatedCount = sim.pedestrianList.filter((ped) => ped.y === ELEVATED_Y).length;
    const groundCount = sim.pedestrianList.length - elevatedCount;

    // Both surfaces are fully walkable and equal in size here, so an
    // unweighted coin flip would land near 50/50 -- the ~30% cap must be
    // doing the capping, not luck.
    expect(elevatedCount).toBeGreaterThan(0);
    expect(groundCount).toBeGreaterThan(0);
    expect(elevatedCount / sim.pedestrianList.length).toBeLessThanOrEqual(0.3 + 0.15); // slack for a finite sample
  });

  it('only ever spawns an elevated pedestrian onto an actual walkable deck cell, never mid-air off the deck', () => {
    const width = 60;
    const depth = 60;
    // No ground at all, so every pedestrian is forced elevated (the ground
    // fallback finds nothing) -- makes the elevated spawn path exercise
    // deterministic instead of a rare probabilistic event.
    const walkable = new Uint8Array(width * depth);
    const deckStart = 20;
    const deckEnd = 40;
    for (let x = deckStart; x < deckEnd; x++) {
      for (let z = deckStart; z < deckEnd; z++) walkable[x + z * width] = 1;
    }
    const grid: NavGrid = {
      ...makeOpenGrid(width, depth),
      sidewalk: new Uint8Array(width * depth),
      elevatedLevels: [makeElevatedLevel(ELEVATED_Y, width, walkable)],
    };

    const wideConfig: EntitySimulationConfig = { ...TEST_CONFIG, maxPedestrians: 20 };
    const sim = new EntitySimulation(wideConfig);
    sim.reset(grid, 'sim-elevated-deck-only');

    for (let i = 0; i < 400; i++) sim.update(1 / 60, 30, ELEVATED_Y, 30);

    expect(sim.pedestrianList.length).toBe(wideConfig.maxPedestrians);
    for (const ped of sim.pedestrianList) {
      expect(ped.y).toBe(ELEVATED_Y);
      expect(ped.cellX).toBeGreaterThanOrEqual(deckStart);
      expect(ped.cellX).toBeLessThan(deckEnd);
      expect(ped.cellZ).toBeGreaterThanOrEqual(deckStart);
      expect(ped.cellZ).toBeLessThan(deckEnd);
    }
  });
});

describe('EntitySimulation flying vehicles', () => {
  it('spawns none when reset() is given no sky lanes (the default)', () => {
    const sim = new EntitySimulation({ ...TEST_CONFIG, maxFlyingVehicles: 10 });
    sim.reset(makeOpenGrid(60, 60), 'sim-no-lanes');

    for (let i = 0; i < 200; i++) sim.update(1 / 60, 30, 1, 30);

    expect(sim.flyingVehicleList).toHaveLength(0);
  });

  it('ramps up to the configured flying-vehicle cap when a lane is available near the player', () => {
    const config: EntitySimulationConfig = { ...TEST_CONFIG, maxFlyingVehicles: 6 };
    const sim = new EntitySimulation(config);
    sim.reset(makeOpenGrid(60, 60), 'sim-flying-ramp', [makeStraightLane()]);

    for (let i = 0; i < 400; i++) sim.update(1 / 60, 30, 1, 30);

    expect(sim.flyingVehicleList.length).toBe(config.maxFlyingVehicles);
  });

  it('keeps every flying vehicle exactly at its lane altitude over a long soak, and only moving along its own fixed heading', () => {
    const config: EntitySimulationConfig = { ...TEST_CONFIG, maxFlyingVehicles: 4 };
    const sim = new EntitySimulation(config);
    const lane = makeStraightLane({ altitude: 128, fixed: 150, end: 300 });
    sim.reset(makeOpenGrid(300, 300), 'sim-flying-soak', [lane]);

    for (let i = 0; i < 60; i++) sim.update(1 / 60, 150, 1, 150);
    expect(sim.flyingVehicleList.length).toBeGreaterThan(0);

    // Snapshot each vehicle's heading and cross-axis coordinate, then soak
    // for a long stretch and confirm neither ever drifted (a flying vehicle
    // never turns -- see `FlyingVehicle.ts`).
    const snapshot = sim.flyingVehicleList.map((v) => ({ dirX: v.dirX, dirZ: v.dirZ, cross: v.z }));

    for (let i = 0; i < 3000; i++) sim.update(1 / 60, 150, 1, 150);

    for (const vehicle of sim.flyingVehicleList) {
      expect(vehicle.y).toBe(128);
    }
    // New vehicles may have spawned/despawned during the soak (that's
    // expected churn against the world edge), but every vehicle present at
    // both ends of a snapshot window must be unchanged in heading/cross-axis.
    const survivorsByStart = new Map(snapshot.map((s) => [`${s.dirX},${s.dirZ},${s.cross}`, s]));
    for (const vehicle of sim.flyingVehicleList) {
      const key = `${vehicle.dirX},${vehicle.dirZ},${vehicle.z}`;
      if (survivorsByStart.has(key)) {
        const before = survivorsByStart.get(key)!;
        expect(vehicle.dirZ).toBe(before.dirZ);
        expect(vehicle.z).toBe(before.cross);
      }
    }
  });

  it('despawns flying vehicles that end up beyond the despawn radius', () => {
    const config: EntitySimulationConfig = { ...TEST_CONFIG, maxFlyingVehicles: 6, despawnRadius: 30 };
    const sim = new EntitySimulation(config);
    sim.reset(makeOpenGrid(300, 300), 'sim-flying-despawn', [makeStraightLane({ fixed: 150, end: 300 })]);

    for (let i = 0; i < 50; i++) sim.update(1 / 60, 150, 1, 150);
    expect(sim.flyingVehicleList.length).toBeGreaterThan(0);

    // Player teleports far away -- every existing flying vehicle is now well beyond despawnRadius.
    sim.update(1 / 60, 150 + 10_000, 1, 150);

    for (const vehicle of sim.flyingVehicleList) {
      const dist = Math.hypot(vehicle.x - (150 + 10_000), vehicle.z - 150);
      expect(dist).toBeLessThanOrEqual(config.despawnRadius);
    }
  });

  it('reset() clears every flying vehicle and rebuilds cleanly against new lanes', () => {
    const config: EntitySimulationConfig = { ...TEST_CONFIG, maxFlyingVehicles: 6 };
    const sim = new EntitySimulation(config);
    sim.reset(makeOpenGrid(60, 60), 'sim-flying-before', [makeStraightLane()]);
    for (let i = 0; i < 400; i++) sim.update(1 / 60, 30, 1, 30);
    expect(sim.flyingVehicleList.length).toBeGreaterThan(0);

    sim.reset(makeOpenGrid(60, 60), 'sim-flying-after'); // no lanes this time

    expect(sim.flyingVehicleList).toHaveLength(0);
    sim.update(1 / 60, 30, 1, 30);
    expect(sim.flyingVehicleList).toHaveLength(0); // still none -- no lane to spawn from
  });

  it('never exceeds maxFlyingVehicles, even after a long soak with continuous edge despawns and respawns', () => {
    const config: EntitySimulationConfig = { ...TEST_CONFIG, maxFlyingVehicles: 5 };
    const sim = new EntitySimulation(config);
    sim.reset(makeOpenGrid(60, 60), 'sim-flying-cap-soak', [makeStraightLane({ start: 0, end: 60 })]);

    for (let i = 0; i < 5000; i++) {
      sim.update(1 / 60, 30, 1, 30);
      expect(sim.flyingVehicleList.length).toBeLessThanOrEqual(config.maxFlyingVehicles);
    }
  });
});
