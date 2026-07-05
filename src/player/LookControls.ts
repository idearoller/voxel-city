import * as THREE from 'three';

const SENSITIVITY = 0.0022;
/**
 * Touch drags cover far less raw screen distance than a mouse's
 * `movementX`/`movementY` ticks tend to over the same rotation, so touch
 * gets its own (higher) sensitivity rather than reusing the mouse constant.
 */
const TOUCH_SENSITIVITY = 0.0032;
const MAX_PITCH = Math.PI / 2 - 0.01;

/**
 * Hand-rolled look controller. Owns the camera's quaternion, derived from
 * accumulated yaw/pitch driven either by mousemove deltas while the canvas
 * holds pointer lock, or — on touch devices, which never acquire pointer
 * lock — by `applyTouchDelta`, fed from `TouchInputController`'s right-half
 * drag handling. Both paths share the same yaw/pitch math (`applyDelta`).
 */
export class LookControls {
  private yaw = 0;
  private pitch = 0;
  /** Scratch `Euler` reused across every `applyDelta` call (mousemove fires far more often than once a frame) instead of allocated per call — nothing holds a reference to it past `setFromEuler`. */
  private readonly eulerScratch = new THREE.Euler(0, 0, 0, 'YXZ');

  constructor(
    private readonly camera: THREE.Camera,
    private readonly canvas: HTMLCanvasElement,
  ) {
    this.canvas.addEventListener('click', () => {
      // No touch-capability guard here: a real tap's synthetic "click" never
      // reaches this handler at all, because attachTouchInput's touchstart
      // listener calls preventDefault(), which suppresses it (see
      // TouchInputController.ts). So this only ever fires for an actual
      // mouse click — including on a touchscreen laptop, where a guard would
      // otherwise silently kill mouse-look/mouse-edit by never requesting
      // pointer lock. Phones simply reject requestPointerLock() harmlessly
      // if it's ever reached some other way.
      if (document.pointerLockElement !== this.canvas) {
        this.canvas.requestPointerLock();
      }
    });

    document.addEventListener('mousemove', this.onMouseMove);
  }

  get isLocked(): boolean {
    return document.pointerLockElement === this.canvas;
  }

  get yawRadians(): number {
    return this.yaw;
  }

  private onMouseMove = (event: MouseEvent): void => {
    if (!this.isLocked) return;
    this.applyDelta(event.movementX, event.movementY, SENSITIVITY);
  };

  /**
   * Touch-drag equivalent of `onMouseMove`: same yaw/pitch math, but with no
   * pointer-lock gate, since touch look never locks the pointer at all.
   */
  applyTouchDelta(deltaX: number, deltaY: number): void {
    this.applyDelta(deltaX, deltaY, TOUCH_SENSITIVITY);
  }

  private applyDelta(deltaX: number, deltaY: number, sensitivity: number): void {
    this.yaw -= deltaX * sensitivity;
    this.pitch -= deltaY * sensitivity;
    this.pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, this.pitch));

    this.camera.quaternion.setFromEuler(this.eulerScratch.set(this.pitch, this.yaw, 0, 'YXZ'));
  }

  dispose(): void {
    document.removeEventListener('mousemove', this.onMouseMove);
  }
}
