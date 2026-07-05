import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { FlyController } from '../src/player/FlyController';

const FIXED_DT = 1 / 60;

/** A camera facing world +X, independent of position (only orientation matters to FlyController). */
function forwardCamera(): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(0, 0, 0);
  camera.lookAt(new THREE.Vector3(1, 0, 0));
  return camera;
}

describe('FlyController.setKey (public — driven by touch input, not just real keydown/keyup)', () => {
  it('moves the camera forward over time once KeyW is set pressed', () => {
    const camera = forwardCamera();
    const controller = new FlyController(camera);

    controller.setKey('KeyW', true);
    for (let tick = 0; tick < 30; tick++) controller.update(FIXED_DT);

    expect(camera.position.x).toBeGreaterThan(0);
  });

  it('stops accelerating once the key is released (setKey(false))', () => {
    const camera = forwardCamera();
    const controller = new FlyController(camera);

    controller.setKey('KeyW', true);
    for (let tick = 0; tick < 30; tick++) controller.update(FIXED_DT);
    const xAtRelease = camera.position.x;
    controller.setKey('KeyW', false);
    for (let tick = 0; tick < 60; tick++) controller.update(FIXED_DT);

    // Damped velocity decays toward zero rather than coasting indefinitely,
    // so position gain after release is small relative to the gain while held.
    const gainAfterRelease = camera.position.x - xAtRelease;
    expect(gainAfterRelease).toBeLessThan(xAtRelease);
  });

  it('moves straight up on Space (fly-up), the same virtual key touch UP button sends', () => {
    const camera = forwardCamera();
    const controller = new FlyController(camera);

    controller.setKey('Space', true);
    for (let tick = 0; tick < 30; tick++) controller.update(FIXED_DT);

    expect(camera.position.y).toBeGreaterThan(0);
  });
});
