import { classifyGesture, type GestureSample } from './tapGesture';
import {
  clampKnobOffset,
  computeJoystickVector,
  joystickToDirectionalKeys,
  NEUTRAL_DIRECTIONAL_KEYS,
  type DirectionalKeys,
  type Point,
} from './joystick';

/**
 * Minimal shape pulled out of a native `Touch` — lets `TouchInputController`
 * be driven with plain objects in tests instead of constructing real
 * `TouchEvent`/`Touch` instances (not reliably constructible in jsdom-less
 * node tests), while `attachTouchInput` below adapts real events to it.
 */
export interface TouchPoint {
  readonly identifier: number;
  readonly clientX: number;
  readonly clientY: number;
}

export interface StickVisual {
  readonly origin: Point;
  readonly knobOffset: Point;
}

export interface TouchInputCallbacks {
  /** Feeds a virtual key press/release into the active move controller(s) — see `ModeManager.setVirtualKey`. */
  setKey(code: string, pressed: boolean): void;
  /**
   * Feeds a virtual "sprint" press/release (joystick at/beyond
   * `SPRINT_MAGNITUDE_THRESHOLD` deflection) — kept *separate* from `setKey`
   * because "sprint" isn't the same physical key in both modes:
   * `PlayController` reads Shift as sprint, but `FlyController` reads Shift
   * as fly-down and Ctrl as its own sprint (see `FlyController.setKey`). A
   * single shared keycode here would make a full-deflection joystick push
   * descend instead of sprinting in sandbox mode. See `ModeManager.setVirtualSprint`.
   */
  setSprint(pressed: boolean): void;
  /** Applies an incremental look-rotation delta, bypassing pointer lock — see `LookControls.applyTouchDelta`. */
  applyLookDelta(deltaX: number, deltaY: number): void;
  /** Fired on a short, stationary tap in the look/edit half — drives whichever voxel action (place/remove) is currently selected. */
  onTap(): void;
  /** Fired whenever the movement joystick's visual should update, or with `null` once the finger lifts. */
  onStickChange?: (stick: StickVisual | null) => void;
}

/** Movement axes only — `sprint` is deliberately excluded, see `TouchInputCallbacks.setSprint`. */
const DIRECTIONAL_KEY_CODES: Record<'forward' | 'back' | 'left' | 'right', string> = {
  forward: 'KeyW',
  back: 'KeyS',
  left: 'KeyA',
  right: 'KeyD',
};

/**
 * Touch equivalent of WASD + mouse-look + click-to-edit, tracked entirely by
 * touch `identifier` (never `touches[0]`) so two simultaneous fingers — one
 * driving the move joystick, one driving look — never interfere with each
 * other, and a finger lift only ever releases *that* finger's own state.
 *
 * Left half of the viewport: touch-down anywhere spawns a floating joystick
 * at that point; dragging from there drives the same WASD(+sprint) intent
 * the keyboard produces, via `setKey`/`setSprint` (see `joystickToDirectionalKeys`).
 *
 * Right half: dragging rotates the camera (`applyLookDelta`); a short,
 * near-stationary touch (`classifyGesture` -> 'tap') instead fires `onTap`
 * — the touch equivalent of a mouse click, used for voxel editing.
 *
 * Deliberately DOM-free (plain `TouchPoint` arrays in, callbacks out) so all
 * of this — including the multi-touch bookkeeping — is unit-testable
 * without jsdom or synthetic `TouchEvent`s; `attachTouchInput` is the thin
 * real-DOM adapter.
 */
export class TouchInputController {
  private joystickTouchId: number | null = null;
  private joystickOrigin: Point | null = null;
  private lastDirectionalKeys: DirectionalKeys = NEUTRAL_DIRECTIONAL_KEYS;

  private lookTouchId: number | null = null;
  private lookLastPoint: Point | null = null;
  private lookGestureStart: GestureSample | null = null;

  constructor(
    private readonly callbacks: TouchInputCallbacks,
    private readonly getViewportWidth: () => number,
  ) {}

  handleTouchStart(touches: readonly TouchPoint[], timeMs: number): void {
    for (const touch of touches) {
      if (this.isLeftHalf(touch.clientX)) {
        if (this.joystickTouchId !== null) continue; // joystick finger already claimed
        this.joystickTouchId = touch.identifier;
        this.joystickOrigin = { x: touch.clientX, y: touch.clientY };
        this.lastDirectionalKeys = NEUTRAL_DIRECTIONAL_KEYS;
        this.reportStick(this.joystickOrigin, { x: 0, y: 0 });
      } else {
        if (this.lookTouchId !== null) continue; // look finger already claimed
        this.lookTouchId = touch.identifier;
        this.lookLastPoint = { x: touch.clientX, y: touch.clientY };
        this.lookGestureStart = { x: touch.clientX, y: touch.clientY, timeMs };
      }
    }
  }

  handleTouchMove(touches: readonly TouchPoint[]): void {
    for (const touch of touches) {
      if (touch.identifier === this.joystickTouchId && this.joystickOrigin) {
        const current: Point = { x: touch.clientX, y: touch.clientY };
        const vector = computeJoystickVector(this.joystickOrigin, current);
        this.applyDirectionalKeys(joystickToDirectionalKeys(vector));
        this.reportStick(this.joystickOrigin, clampKnobOffset(this.joystickOrigin, current));
      } else if (touch.identifier === this.lookTouchId && this.lookLastPoint) {
        const deltaX = touch.clientX - this.lookLastPoint.x;
        const deltaY = touch.clientY - this.lookLastPoint.y;
        this.callbacks.applyLookDelta(deltaX, deltaY);
        this.lookLastPoint = { x: touch.clientX, y: touch.clientY };
      }
    }
  }

  handleTouchEnd(touches: readonly TouchPoint[], timeMs: number): void {
    for (const touch of touches) {
      if (touch.identifier === this.joystickTouchId) {
        this.releaseJoystick();
      } else if (touch.identifier === this.lookTouchId) {
        this.releaseLook(touch, timeMs);
      }
    }
  }

  /** Same release as `handleTouchEnd`, but never fires `onTap` — a cancelled touch (e.g. an incoming system gesture) is not a completed gesture. */
  handleTouchCancel(touches: readonly TouchPoint[]): void {
    for (const touch of touches) {
      if (touch.identifier === this.joystickTouchId) {
        this.releaseJoystick();
      } else if (touch.identifier === this.lookTouchId) {
        this.lookTouchId = null;
        this.lookLastPoint = null;
        this.lookGestureStart = null;
      }
    }
  }

  private isLeftHalf(x: number): boolean {
    return x < this.getViewportWidth() / 2;
  }

  private releaseJoystick(): void {
    this.applyDirectionalKeys(NEUTRAL_DIRECTIONAL_KEYS);
    this.joystickTouchId = null;
    this.joystickOrigin = null;
    this.reportStick(null, null);
  }

  private releaseLook(touch: TouchPoint, timeMs: number): void {
    const start = this.lookGestureStart;
    this.lookTouchId = null;
    this.lookLastPoint = null;
    this.lookGestureStart = null;
    if (!start) return;
    const end: GestureSample = { x: touch.clientX, y: touch.clientY, timeMs };
    if (classifyGesture(start, end) === 'tap') this.callbacks.onTap();
  }

  private applyDirectionalKeys(next: DirectionalKeys): void {
    for (const key of Object.keys(DIRECTIONAL_KEY_CODES) as (keyof typeof DIRECTIONAL_KEY_CODES)[]) {
      if (this.lastDirectionalKeys[key] !== next[key]) {
        this.callbacks.setKey(DIRECTIONAL_KEY_CODES[key], next[key]);
      }
    }
    if (this.lastDirectionalKeys.sprint !== next.sprint) {
      this.callbacks.setSprint(next.sprint);
    }
    this.lastDirectionalKeys = next;
  }

  private reportStick(origin: Point | null, knobOffset: Point | null): void {
    if (!this.callbacks.onStickChange) return;
    this.callbacks.onStickChange(origin && knobOffset ? { origin, knobOffset } : null);
  }
}

function toTouchPoints(list: TouchList): TouchPoint[] {
  const points: TouchPoint[] = [];
  for (let i = 0; i < list.length; i++) {
    const touch = list.item(i);
    if (touch) points.push({ identifier: touch.identifier, clientX: touch.clientX, clientY: touch.clientY });
  }
  return points;
}

/**
 * Wires a `TouchInputController` to real `TouchEvent`s on `canvas`. Kept
 * separate from the controller itself so the controller's gesture logic —
 * multi-touch bookkeeping, joystick math, tap classification — stays
 * testable by calling its `handleTouch*` methods directly with plain
 * touch-point arrays, with no jsdom / synthetic `TouchEvent` construction
 * needed in tests. Listeners are non-passive: `preventDefault` suppresses
 * both the browser's scroll/pinch-zoom gestures over the canvas and the
 * ~300ms-delayed synthetic mouse/click events touches would otherwise also
 * generate (which would otherwise double-fire the desktop mousedown-edit
 * path). Returns a disposer.
 */
export function attachTouchInput(canvas: HTMLCanvasElement, controller: TouchInputController): () => void {
  const onStart = (event: TouchEvent): void => {
    event.preventDefault();
    controller.handleTouchStart(toTouchPoints(event.changedTouches), event.timeStamp);
  };
  const onMove = (event: TouchEvent): void => {
    event.preventDefault();
    controller.handleTouchMove(toTouchPoints(event.changedTouches));
  };
  const onEnd = (event: TouchEvent): void => {
    event.preventDefault();
    controller.handleTouchEnd(toTouchPoints(event.changedTouches), event.timeStamp);
  };
  const onCancel = (event: TouchEvent): void => {
    controller.handleTouchCancel(toTouchPoints(event.changedTouches));
  };

  canvas.addEventListener('touchstart', onStart, { passive: false });
  canvas.addEventListener('touchmove', onMove, { passive: false });
  canvas.addEventListener('touchend', onEnd, { passive: false });
  canvas.addEventListener('touchcancel', onCancel, { passive: false });

  return () => {
    canvas.removeEventListener('touchstart', onStart);
    canvas.removeEventListener('touchmove', onMove);
    canvas.removeEventListener('touchend', onEnd);
    canvas.removeEventListener('touchcancel', onCancel);
  };
}
