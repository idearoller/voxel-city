import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { buildNavGrid, type NavGrid } from '../src/entities/NavGrid';
import { EYE_HEIGHT } from '../src/player/PlayController';
import { TourController, type TourLookPort } from '../src/player/TourController';
import { TOUR_WALK_SPEED } from '../src/player/TourWalker';
import { CONCRETE, SIDEWALK } from '../src/world/BlockRegistry';
import { World } from '../src/world/World';

/**
 * Lightweight in-memory stand-in for `LookControls` -- exactly the
 * `TourLookPort` surface, with a manual `pushLookInput` hook standing in for
 * a real mouse-move/touch-drag event, so these tests can drive idle
 * cinematic auto-yaw without a canvas or DOM listeners.
 */
class FakeLookControls implements TourLookPort {
  yaw = 0;
  pitch = 0;
  private inputPending = false;

  get yawRadians(): number {
    return this.yaw;
  }

  get pitchRadians(): number {
    return this.pitch;
  }

  consumeLookInput(): boolean {
    const had = this.inputPending;
    this.inputPending = false;
    return had;
  }

  applyAutoYaw(yaw: number, pitch: number): void {
    this.yaw = yaw;
    this.pitch = pitch;
  }

  pushLookInput(): void {
    this.inputPending = true;
  }
}

const GROUND_Y = 1;
const WIDTH = 20;
const DEPTH = 20;

function buildGridWithSidewalkCells(cells: [number, number][]): NavGrid {
  const world = new World();
  for (const [x, z] of cells) {
    world.setBlock(x, 0, z, CONCRETE);
    world.setBlock(x, GROUND_Y, z, SIDEWALK);
  }
  return buildNavGrid(world, WIDTH, DEPTH, GROUND_Y);
}

function corridorGrid(length = 15): NavGrid {
  const cells: [number, number][] = [];
  for (let x = 0; x < length; x++) cells.push([x, 5]);
  return buildGridWithSidewalkCells(cells);
}

describe('TourController', () => {
  it('does nothing before start() has been called', () => {
    const camera = new THREE.PerspectiveCamera();
    camera.position.set(1, 2, 3);
    const controller = new TourController(camera, () => corridorGrid());

    controller.update(1 / 60);
    controller.render(0.5);

    expect(camera.position.toArray()).toEqual([1, 2, 3]);
    expect(controller.getFeet()).toEqual([0, 0, 0]);
  });

  it('start() places the walker on the nearest walkable cell to the given position', () => {
    const camera = new THREE.PerspectiveCamera();
    const controller = new TourController(camera, () => corridorGrid());

    controller.start(2.3, 5.1);
    controller.render(0);

    // corridorGrid's cells are centered at z=5.5; nearest cell to (2.3, 5.1) is (2, 5).
    expect(camera.position.x).toBeCloseTo(2.5, 5);
    expect(camera.position.z).toBeCloseTo(5.5, 5);
    expect(camera.position.y).toBeCloseTo(GROUND_Y + EYE_HEIGHT, 5);
  });

  it('falls back to a random walkable cell when nothing is near the requested position', () => {
    const camera = new THREE.PerspectiveCamera();
    const controller = new TourController(camera, () => buildGridWithSidewalkCells([[10, 10]]));

    // Far outside findNearestWalkableGroundCell's search radius from (10, 10).
    controller.start(500, 500);
    controller.render(0);

    expect(camera.position.x).toBeCloseTo(10.5, 5);
    expect(camera.position.z).toBeCloseTo(10.5, 5);
  });

  it('does nothing if the NavGrid provider has no grid yet', () => {
    const camera = new THREE.PerspectiveCamera();
    camera.position.set(9, 9, 9);
    const controller = new TourController(camera, () => null);

    controller.start(0, 0);
    controller.update(1 / 60);
    controller.render(1);

    expect(camera.position.toArray()).toEqual([9, 9, 9]);
  });

  it('walks forward over fixed ticks, and render() interpolates smoothly between ticks instead of snapping', () => {
    const camera = new THREE.PerspectiveCamera();
    const grid = corridorGrid();
    const controller = new TourController(camera, () => grid);
    controller.start(2, 5);

    // The first tick only picks a heading from a freshly-spawned (exactly
    // cell-centered) walker without moving -- see TourWalker.test.ts's
    // matching comment. The second tick is the one that actually advances
    // `x` away from its now-stale `prevX`.
    controller.update(1 / 60);
    controller.update(1 / 60);
    const feetAfterTicks = controller.getFeet();

    controller.render(0); // alpha=0 -> exactly the previous tick's position
    const xAtAlpha0 = camera.position.x;
    controller.render(1); // alpha->1 -> approaches the current tick's position
    const xAtAlpha1 = camera.position.x;

    expect(xAtAlpha0).toBeLessThan(xAtAlpha1);
    expect(xAtAlpha1).toBeCloseTo(feetAfterTicks[0], 5);
  });

  it('render(0)->render(1) spread is exactly one tick of walk once prev has genuinely diverged', () => {
    // Pins the prev-capture in stepTourWalker: without it, prev lags many
    // ticks behind and the render(0)->render(1) spread inflates to a
    // multi-tick sawtooth. The 2-tick smoothness test above cannot catch
    // that (prev ~ curr there), so this walks 30 straight ticks first.
    const camera = new THREE.PerspectiveCamera();
    const controller = new TourController(camera, () => corridorGrid());
    controller.start(7, 5); // corridor middle: 30 ticks (0.7u) cannot reach a dead end

    for (let i = 0; i < 30; i++) controller.update(1 / 60);

    controller.render(0);
    const xAtAlpha0 = camera.position.x;
    controller.render(1);
    const xAtAlpha1 = camera.position.x;

    expect(Math.abs(xAtAlpha1 - xAtAlpha0)).toBeCloseTo(TOUR_WALK_SPEED / 60, 5);
  });

  it('only ever writes camera position, never rotation, so mouse look stays independent', () => {
    const camera = new THREE.PerspectiveCamera();
    camera.quaternion.set(0.1, 0.2, 0.3, Math.sqrt(1 - 0.01 - 0.04 - 0.09));
    const before = camera.quaternion.clone();
    const controller = new TourController(camera, () => corridorGrid());

    controller.start(2, 5);
    for (let i = 0; i < 30; i++) controller.update(1 / 60);
    controller.render(0.5);

    expect(camera.quaternion.equals(before)).toBe(true);
  });

  it('never permanently stalls: respawns at a fresh cell once the walker dies on an isolated cell', () => {
    const camera = new THREE.PerspectiveCamera();
    const grid = buildGridWithSidewalkCells([
      [5, 5], // isolated -- the walker dies here immediately
      [15, 15],
    ]);
    const controller = new TourController(camera, () => grid);
    controller.start(5, 5);

    // One tick kills the isolated-cell walker and the same update() call
    // immediately respawns it at a fresh random walkable cell.
    controller.update(1 / 60);

    expect(controller.getFeet()).not.toEqual([0, 0, 0]);
    controller.render(0);
    // Must have landed on one of the two known walkable cells, not nowhere.
    const landedOnFive = Math.abs(camera.position.x - 5.5) < 0.01 && Math.abs(camera.position.z - 5.5) < 0.01;
    const landedOnFifteen = Math.abs(camera.position.x - 15.5) < 0.01 && Math.abs(camera.position.z - 15.5) < 0.01;
    expect(landedOnFive || landedOnFifteen).toBe(true);
  });

  it('keeps wandering indefinitely across many ticks without ever going permanently non-alive', () => {
    const camera = new THREE.PerspectiveCamera();
    const grid = corridorGrid(5); // short corridor, forces frequent dead-end reversal
    const controller = new TourController(camera, () => grid);
    controller.start(0, 5);

    for (let i = 0; i < 3000; i++) controller.update(1 / 60);

    // Still producing a real position after a long run -- never got stuck at
    // the fallback origin.
    controller.render(0.5);
    expect(camera.position.y).toBeGreaterThan(0);
  });

  describe('idle cinematic auto-yaw', () => {
    it('does nothing when constructed without a LookControls (existing callers keep working unchanged)', () => {
      const camera = new THREE.PerspectiveCamera();
      const controller = new TourController(camera, () => corridorGrid());
      controller.start(2, 5);

      for (let i = 0; i < 600; i++) controller.update(1 / 60);
      controller.render(0.5);

      expect(camera.quaternion.equals(new THREE.Quaternion())).toBe(true);
    });

    it('leaves LookControls untouched before the idle delay elapses', () => {
      const camera = new THREE.PerspectiveCamera();
      const lookControls = new FakeLookControls();
      const controller = new TourController(camera, () => corridorGrid(), lookControls);
      controller.start(2, 5);

      for (let i = 0; i < 60; i++) controller.update(1 / 60); // 1s, well under the ~4s default idle delay

      expect(lookControls.yaw).toBe(0);
      expect(lookControls.pitch).toBe(0);
    });

    it('eases LookControls yaw toward the walker heading once idle long enough', () => {
      const camera = new THREE.PerspectiveCamera();
      const lookControls = new FakeLookControls();
      lookControls.yaw = 0; // starts looking away from the corridor's axis entirely
      // A long corridor, started from its middle, so the walker cannot reach
      // either dead end (and reverse its heading) within this test's window
      // -- isolates "eases toward the current heading" from "heading itself
      // can later flip," which is covered by TourAutoLook.test.ts instead.
      const controller = new TourController(camera, () => corridorGrid(400), lookControls);
      controller.start(200, 5);

      // The corridor runs along the x axis, so the walker's heading is
      // either +x or -x (yaw = +-pi/2) depending on which way it happened to
      // set off -- either way, yaw should ease toward +-pi/2, not stay at 0.
      for (let i = 0; i < 1200; i++) controller.update(1 / 60); // 20s, comfortably past the default idle delay

      expect(Math.abs(lookControls.yaw)).toBeCloseTo(Math.PI / 2, 1);
      expect(Math.abs(lookControls.pitch)).toBeLessThan(1e-9); // pitch was already level; nothing to ease
    });

    it('real look input immediately cancels auto-yaw and keeps the idle timer from ever re-engaging while it keeps arriving', () => {
      const camera = new THREE.PerspectiveCamera();
      const lookControls = new FakeLookControls();
      lookControls.yaw = -1.5;
      const controller = new TourController(camera, () => corridorGrid(), lookControls);
      controller.start(2, 5);

      for (let i = 0; i < 600; i++) {
        lookControls.pushLookInput(); // simulates the player continuously moving the mouse
        controller.update(1 / 60);
      }

      // Auto-yaw never got a chance to touch the pose -- it's exactly what a
      // real mouse-move would have left it at (unchanged by TourController).
      expect(lookControls.yaw).toBe(-1.5);
    });

    it('resets the idle timer on every start(), so re-entering tour mode never inherits a stale near-threshold timer', () => {
      const camera = new THREE.PerspectiveCamera();
      const lookControls = new FakeLookControls();
      lookControls.yaw = -1.5;
      const controller = new TourController(camera, () => corridorGrid(), lookControls);
      controller.start(2, 5);

      // Idle almost to the threshold...
      for (let i = 0; i < 239; i++) controller.update(1 / 60); // ~3.98s, just under the 4s default
      expect(lookControls.yaw).toBe(-1.5);

      // ...then restart touring (as ModeManager.enterTourMode does on every re-entry).
      controller.start(2, 5);
      lookControls.yaw = -1.5;

      // A single further tick must not engage -- the idle timer restarted at start().
      controller.update(1 / 60);
      expect(lookControls.yaw).toBe(-1.5);
    });
  });
});
