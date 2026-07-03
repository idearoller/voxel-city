import * as THREE from 'three';

const SENSITIVITY = 0.0022;
const MAX_PITCH = Math.PI / 2 - 0.01;

/**
 * Hand-rolled pointer-lock look controller. Owns the camera's quaternion,
 * derived from accumulated yaw/pitch driven by mousemove deltas while the
 * canvas holds pointer lock.
 */
export class LookControls {
  private yaw = 0;
  private pitch = 0;

  constructor(
    private readonly camera: THREE.Camera,
    private readonly canvas: HTMLCanvasElement,
  ) {
    this.canvas.addEventListener('click', () => {
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

    this.yaw -= event.movementX * SENSITIVITY;
    this.pitch -= event.movementY * SENSITIVITY;
    this.pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, this.pitch));

    this.camera.quaternion.setFromEuler(new THREE.Euler(this.pitch, this.yaw, 0, 'YXZ'));
  };

  dispose(): void {
    document.removeEventListener('mousemove', this.onMouseMove);
  }
}
