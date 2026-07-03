import * as THREE from 'three';

const BASE_SPEED = 15;
const SPRINT_MULTIPLIER = 4;
/** Fraction of velocity retained per second of no input (higher = snappier stop). */
const DAMPING_PER_SECOND = 10;

interface KeyState {
  forward: boolean;
  back: boolean;
  left: boolean;
  right: boolean;
  up: boolean;
  down: boolean;
  sprint: boolean;
}

/**
 * Sandbox free-fly movement: WASD horizontal (relative to camera yaw),
 * Space/Shift for world up/down, Ctrl for a 4x speed multiplier, with
 * exponential velocity damping for smooth accel/decel.
 */
export class FlyController {
  private readonly keys: KeyState = {
    forward: false,
    back: false,
    left: false,
    right: false,
    up: false,
    down: false,
    sprint: false,
  };

  private readonly velocity = new THREE.Vector3();
  private readonly forward = new THREE.Vector3();
  private readonly right = new THREE.Vector3();

  constructor(private readonly camera: THREE.Camera) {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
  }

  private onKeyDown = (event: KeyboardEvent): void => {
    this.setKey(event.code, true);
  };

  private onKeyUp = (event: KeyboardEvent): void => {
    this.setKey(event.code, false);
  };

  private setKey(code: string, pressed: boolean): void {
    switch (code) {
      case 'KeyW':
        this.keys.forward = pressed;
        break;
      case 'KeyS':
        this.keys.back = pressed;
        break;
      case 'KeyA':
        this.keys.left = pressed;
        break;
      case 'KeyD':
        this.keys.right = pressed;
        break;
      case 'Space':
        this.keys.up = pressed;
        break;
      case 'ShiftLeft':
      case 'ShiftRight':
        this.keys.down = pressed;
        break;
      case 'ControlLeft':
      case 'ControlRight':
        this.keys.sprint = pressed;
        break;
    }
  }

  update(dt: number): void {
    this.camera.getWorldDirection(this.forward);
    this.forward.y = 0;
    this.forward.normalize();
    this.right.crossVectors(this.forward, this.camera.up).normalize();

    const wish = new THREE.Vector3();
    if (this.keys.forward) wish.add(this.forward);
    if (this.keys.back) wish.sub(this.forward);
    if (this.keys.right) wish.add(this.right);
    if (this.keys.left) wish.sub(this.right);
    if (this.keys.up) wish.y += 1;
    if (this.keys.down) wish.y -= 1;

    if (wish.lengthSq() > 0) {
      wish.normalize();
      const speed = BASE_SPEED * (this.keys.sprint ? SPRINT_MULTIPLIER : 1);
      wish.multiplyScalar(speed);
    }

    const damping = Math.exp(-DAMPING_PER_SECOND * dt);
    this.velocity.lerp(wish, 1 - damping);

    this.camera.position.addScaledVector(this.velocity, dt);
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
  }
}
