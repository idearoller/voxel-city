import * as THREE from 'three';
import { AUTO_STEP_LIFT, moveAndCollide, tryAutoStep } from './PlayerCollision';
import type { World } from '../world/World';

const WALK_SPEED = 4.5;
const SPRINT_SPEED = 7;
const GRAVITY = -27;
const JUMP_VELOCITY = 8.4;
const EYE_HEIGHT = 1.62;
/** How long a completed auto-step takes to visually smooth into the camera. */
const STEP_SMOOTH_SECONDS = 0.08;

interface KeyState {
  forward: boolean;
  back: boolean;
  left: boolean;
  right: boolean;
  jump: boolean;
  sprint: boolean;
}

/**
 * First-person walk controller: gravity, axis-separated AABB collision
 * (via PlayerCollision), jump, and Minecraft-style single-voxel auto-step
 * with smoothed eye-height easing. Drives the shared camera's position only
 * — rotation stays owned by LookControls.
 */
export class PlayController {
  private readonly keys: KeyState = {
    forward: false,
    back: false,
    left: false,
    right: false,
    jump: false,
    sprint: false,
  };

  private feet: readonly [number, number, number] = [0, 0, 0];
  private velocityY = 0;
  private grounded = false;
  /** Remaining vertical offset (world units) being eased out after an auto-step. */
  private stepSmoothRemaining = 0;

  private readonly forward = new THREE.Vector3();
  private readonly right = new THREE.Vector3();

  constructor(
    private readonly camera: THREE.Camera,
    private readonly world: World,
  ) {
    // Guarded so PlayController can be constructed in non-browser contexts
    // (unit/integration tests) that drive input via setKey() directly.
    if (typeof window !== 'undefined') {
      window.addEventListener('keydown', this.onKeyDown);
      window.addEventListener('keyup', this.onKeyUp);
    }
  }

  private readonly isSolid = (x: number, y: number, z: number): boolean => this.world.isSolid(x, y, z);

  /** Teleports the player to a feet position (world spawn / mode-switch entry), resetting velocity. */
  setFeet(feet: readonly [number, number, number]): void {
    this.feet = feet;
    this.velocityY = 0;
    this.grounded = false;
    this.stepSmoothRemaining = 0;
    this.syncCamera();
  }

  getFeet(): readonly [number, number, number] {
    return this.feet;
  }

  private onKeyDown = (event: KeyboardEvent): void => {
    this.setKey(event.code, true);
  };

  private onKeyUp = (event: KeyboardEvent): void => {
    this.setKey(event.code, false);
  };

  /**
   * Applies a raw key-code press/release. Public so both the real
   * window keydown/keyup listeners and tests (which have no DOM to dispatch
   * events on) can drive input through the same path.
   */
  setKey(code: string, pressed: boolean): void {
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
        this.keys.jump = pressed;
        break;
      case 'ShiftLeft':
      case 'ShiftRight':
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

    if (wish.lengthSq() > 0) {
      wish.normalize();
      const speed = this.keys.sprint ? SPRINT_SPEED : WALK_SPEED;
      wish.multiplyScalar(speed);
    }

    if (this.keys.jump && this.grounded) {
      this.velocityY = JUMP_VELOCITY;
      this.grounded = false;
    }
    this.velocityY += GRAVITY * dt;

    const wasGrounded = this.grounded;
    const moveResult = moveAndCollide(this.isSolid, this.feet, [wish.x, this.velocityY, wish.z], dt);

    const wantedX = wish.x !== 0;
    const wantedZ = wish.z !== 0;
    const blockedX = wantedX && moveResult.velocity[0] === 0;
    const blockedZ = wantedZ && moveResult.velocity[2] === 0;

    if (wasGrounded && (blockedX || blockedZ)) {
      const step = tryAutoStep(this.isSolid, this.feet, wish.x * dt, wish.z * dt, wasGrounded);
      if (step.stepped) {
        this.feet = step.position;
        this.velocityY = 0;
        // Not grounded yet: the lift overshoots the step surface by design
        // (AUTO_STEP_LIFT > 1 voxel), so gravity resolves the remaining drop
        // onto the step naturally over the next tick(s), same as any other
        // fall. Forcing grounded=true here would let a second auto-step
        // fire before the player has actually settled.
        this.grounded = false;
        // Feet jumped AUTO_STEP_LIFT instantly; ease the camera into that
        // rise over STEP_SMOOTH_SECONDS instead of snapping.
        this.stepSmoothRemaining = AUTO_STEP_LIFT;
      } else {
        this.applyMoveResult(moveResult);
      }
    } else {
      this.applyMoveResult(moveResult);
    }

    if (this.stepSmoothRemaining > 0) {
      const decay = (1 / STEP_SMOOTH_SECONDS) * dt;
      this.stepSmoothRemaining = Math.max(0, this.stepSmoothRemaining - decay);
    }

    this.syncCamera();
  }

  private applyMoveResult(result: { position: readonly [number, number, number]; velocity: readonly [number, number, number]; grounded: boolean }): void {
    this.feet = result.position;
    this.velocityY = result.velocity[1];
    this.grounded = result.grounded;
  }

  private syncCamera(): void {
    const eyeY = this.feet[1] + EYE_HEIGHT - this.stepSmoothRemaining;
    this.camera.position.set(this.feet[0], eyeY, this.feet[2]);
  }

  dispose(): void {
    if (typeof window !== 'undefined') {
      window.removeEventListener('keydown', this.onKeyDown);
      window.removeEventListener('keyup', this.onKeyUp);
    }
  }
}
