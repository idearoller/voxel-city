import { describe, expect, it, vi } from 'vitest';
import { TouchInputController, type TouchInputCallbacks, type TouchPoint } from '../src/input/TouchInputController';
import { JOYSTICK_RADIUS_PX } from '../src/input/joystick';
import { TAP_MAX_DURATION_MS, TAP_MAX_MOVEMENT_PX } from '../src/input/tapGesture';

const VIEWPORT_WIDTH = 800;
const LEFT_X = 100; // left half
const RIGHT_X = 700; // right half

function touch(identifier: number, clientX: number, clientY: number): TouchPoint {
  return { identifier, clientX, clientY };
}

function makeCallbacks(): TouchInputCallbacks & {
  setKey: ReturnType<typeof vi.fn>;
  setSprint: ReturnType<typeof vi.fn>;
  applyLookDelta: ReturnType<typeof vi.fn>;
  onTap: ReturnType<typeof vi.fn>;
  onStickChange: ReturnType<typeof vi.fn>;
} {
  return {
    setKey: vi.fn(),
    setSprint: vi.fn(),
    applyLookDelta: vi.fn(),
    onTap: vi.fn(),
    onStickChange: vi.fn(),
  };
}

function makeController(callbacks: TouchInputCallbacks) {
  return new TouchInputController(callbacks, () => VIEWPORT_WIDTH);
}

describe('TouchInputController — left/right half routing', () => {
  it('spawns the joystick at the exact touch-down point for a left-half touch', () => {
    const callbacks = makeCallbacks();
    const controller = makeController(callbacks);

    controller.handleTouchStart([touch(1, LEFT_X, 200)], 0);

    expect(callbacks.onStickChange).toHaveBeenCalledWith({ origin: { x: LEFT_X, y: 200 }, knobOffset: { x: 0, y: 0 } });
  });

  it('does not spawn a joystick or move a key for a right-half touch-down', () => {
    const callbacks = makeCallbacks();
    const controller = makeController(callbacks);

    controller.handleTouchStart([touch(1, RIGHT_X, 200)], 0);

    expect(callbacks.onStickChange).not.toHaveBeenCalled();
    expect(callbacks.setKey).not.toHaveBeenCalled();
  });

  it('treats the exact viewport midpoint as the right half (boundary is left-exclusive)', () => {
    const callbacks = makeCallbacks();
    const controller = makeController(callbacks);

    controller.handleTouchStart([touch(1, VIEWPORT_WIDTH / 2, 200)], 0);

    expect(callbacks.onStickChange).not.toHaveBeenCalled();
  });
});

describe('TouchInputController — joystick movement', () => {
  it('presses forward (KeyW) when dragged straight up past the deadzone', () => {
    const callbacks = makeCallbacks();
    const controller = makeController(callbacks);

    controller.handleTouchStart([touch(1, LEFT_X, 200)], 0);
    controller.handleTouchMove([touch(1, LEFT_X, 200 - JOYSTICK_RADIUS_PX)]);

    expect(callbacks.setKey).toHaveBeenCalledWith('KeyW', true);
    expect(callbacks.setKey).not.toHaveBeenCalledWith('KeyA', true);
    expect(callbacks.setKey).not.toHaveBeenCalledWith('KeyD', true);
  });

  it('presses both forward and right for a diagonal drag', () => {
    const callbacks = makeCallbacks();
    const controller = makeController(callbacks);

    controller.handleTouchStart([touch(1, LEFT_X, 200)], 0);
    controller.handleTouchMove([touch(1, LEFT_X + JOYSTICK_RADIUS_PX, 200 - JOYSTICK_RADIUS_PX)]);

    expect(callbacks.setKey).toHaveBeenCalledWith('KeyW', true);
    expect(callbacks.setKey).toHaveBeenCalledWith('KeyD', true);
  });

  it('only calls setKey when a directional key actually changes state (no redundant repeats)', () => {
    const callbacks = makeCallbacks();
    const controller = makeController(callbacks);

    controller.handleTouchStart([touch(1, LEFT_X, 200)], 0);
    controller.handleTouchMove([touch(1, LEFT_X, 200 - JOYSTICK_RADIUS_PX)]);
    callbacks.setKey.mockClear();
    // A second move that lands on the exact same normalized vector should not re-fire KeyW.
    controller.handleTouchMove([touch(1, LEFT_X, 200 - JOYSTICK_RADIUS_PX)]);

    expect(callbacks.setKey).not.toHaveBeenCalled();
  });

  it('releases every held directional key on lift, leaving no stuck movement', () => {
    const callbacks = makeCallbacks();
    const controller = makeController(callbacks);

    controller.handleTouchStart([touch(1, LEFT_X, 200)], 0);
    controller.handleTouchMove([touch(1, LEFT_X + JOYSTICK_RADIUS_PX, 200 - JOYSTICK_RADIUS_PX)]);
    callbacks.setKey.mockClear();

    controller.handleTouchEnd([touch(1, LEFT_X + JOYSTICK_RADIUS_PX, 200 - JOYSTICK_RADIUS_PX)], 1000);

    expect(callbacks.setKey).toHaveBeenCalledWith('KeyW', false);
    expect(callbacks.setKey).toHaveBeenCalledWith('KeyD', false);
    expect(callbacks.onStickChange).toHaveBeenLastCalledWith(null);
  });

  it('a new touch after the joystick finger lifts spawns a fresh joystick at the new point (not sticky)', () => {
    const callbacks = makeCallbacks();
    const controller = makeController(callbacks);

    controller.handleTouchStart([touch(1, LEFT_X, 200)], 0);
    controller.handleTouchEnd([touch(1, LEFT_X, 200)], 100);
    callbacks.onStickChange.mockClear();

    controller.handleTouchStart([touch(2, LEFT_X + 40, 250)], 200);

    expect(callbacks.onStickChange).toHaveBeenCalledWith({
      origin: { x: LEFT_X + 40, y: 250 },
      knobOffset: { x: 0, y: 0 },
    });
  });

  it('ignores a second finger landing in the left half while the joystick finger is still down', () => {
    const callbacks = makeCallbacks();
    const controller = makeController(callbacks);

    controller.handleTouchStart([touch(1, LEFT_X, 200)], 0);
    callbacks.onStickChange.mockClear();

    controller.handleTouchStart([touch(2, LEFT_X + 10, 210)], 10);

    expect(callbacks.onStickChange).not.toHaveBeenCalled();

    // And moving the second (ignored) finger must not drive the joystick either.
    controller.handleTouchMove([touch(2, LEFT_X + 10 + JOYSTICK_RADIUS_PX, 210)]);
    expect(callbacks.setKey).not.toHaveBeenCalled();
  });
});

describe('TouchInputController — look drag', () => {
  it('applies incremental deltas relative to the previous point, not the original origin', () => {
    const callbacks = makeCallbacks();
    const controller = makeController(callbacks);

    controller.handleTouchStart([touch(1, RIGHT_X, 200)], 0);
    controller.handleTouchMove([touch(1, RIGHT_X + 10, 205)]);
    controller.handleTouchMove([touch(1, RIGHT_X + 25, 215)]);

    expect(callbacks.applyLookDelta).toHaveBeenNthCalledWith(1, 10, 5);
    // Second call must be relative to the *previous* point (RIGHT_X+10, 205), not the original origin.
    expect(callbacks.applyLookDelta).toHaveBeenNthCalledWith(2, 15, 10);
  });

  it('fires onTap for a short, stationary touch', () => {
    const callbacks = makeCallbacks();
    const controller = makeController(callbacks);

    controller.handleTouchStart([touch(1, RIGHT_X, 200)], 0);
    controller.handleTouchEnd([touch(1, RIGHT_X, 200)], 50);

    expect(callbacks.onTap).toHaveBeenCalledTimes(1);
  });

  it('does not fire onTap once the touch has moved past the drag threshold', () => {
    const callbacks = makeCallbacks();
    const controller = makeController(callbacks);

    controller.handleTouchStart([touch(1, RIGHT_X, 200)], 0);
    controller.handleTouchMove([touch(1, RIGHT_X + TAP_MAX_MOVEMENT_PX + 20, 200)]);
    controller.handleTouchEnd([touch(1, RIGHT_X + TAP_MAX_MOVEMENT_PX + 20, 200)], 50);

    expect(callbacks.onTap).not.toHaveBeenCalled();
  });

  it('does not fire onTap once the touch has lasted past the tap duration threshold, even without movement', () => {
    const callbacks = makeCallbacks();
    const controller = makeController(callbacks);

    controller.handleTouchStart([touch(1, RIGHT_X, 200)], 0);
    controller.handleTouchEnd([touch(1, RIGHT_X, 200)], TAP_MAX_DURATION_MS + 500);

    expect(callbacks.onTap).not.toHaveBeenCalled();
  });

  it('ignores a second finger landing in the right half while the look finger is still down', () => {
    const callbacks = makeCallbacks();
    const controller = makeController(callbacks);

    controller.handleTouchStart([touch(1, RIGHT_X, 200)], 0);
    controller.handleTouchStart([touch(2, RIGHT_X + 50, 210)], 10);

    // The second (ignored) finger's move must not produce a look-jump: only
    // the original look finger's deltas should ever reach applyLookDelta.
    controller.handleTouchMove([touch(2, RIGHT_X + 200, 210)]);
    expect(callbacks.applyLookDelta).not.toHaveBeenCalled();

    controller.handleTouchMove([touch(1, RIGHT_X + 5, 205)]);
    expect(callbacks.applyLookDelta).toHaveBeenCalledWith(5, 5);
  });
});

describe('TouchInputController — simultaneous joystick + look fingers', () => {
  it('tracks both fingers independently with no cross-talk between them', () => {
    const callbacks = makeCallbacks();
    const controller = makeController(callbacks);

    // Finger 1 lands left (joystick), finger 2 lands right (look) in the same batch.
    controller.handleTouchStart([touch(1, LEFT_X, 200), touch(2, RIGHT_X, 300)], 0);

    controller.handleTouchMove([touch(1, LEFT_X, 200 - JOYSTICK_RADIUS_PX)]);
    expect(callbacks.setKey).toHaveBeenCalledWith('KeyW', true);
    expect(callbacks.applyLookDelta).not.toHaveBeenCalled();

    callbacks.setKey.mockClear();
    controller.handleTouchMove([touch(2, RIGHT_X + 12, 305)]);
    expect(callbacks.applyLookDelta).toHaveBeenCalledWith(12, 5);
    expect(callbacks.setKey).not.toHaveBeenCalled();
  });

  it('lifting the joystick finger releases movement keys but leaves the still-down look finger untouched', () => {
    const callbacks = makeCallbacks();
    const controller = makeController(callbacks);

    controller.handleTouchStart([touch(1, LEFT_X, 200), touch(2, RIGHT_X, 300)], 0);
    controller.handleTouchMove([touch(1, LEFT_X, 200 - JOYSTICK_RADIUS_PX)]);
    callbacks.setKey.mockClear();

    controller.handleTouchEnd([touch(1, LEFT_X, 200 - JOYSTICK_RADIUS_PX)], 500);
    expect(callbacks.setKey).toHaveBeenCalledWith('KeyW', false);

    // The look finger (id 2) is still down; its own move must still work normally.
    controller.handleTouchMove([touch(2, RIGHT_X + 8, 300)]);
    expect(callbacks.applyLookDelta).toHaveBeenCalledWith(8, 0);
  });

  it('lifting the look finger classifies its own gesture without disturbing the still-active joystick', () => {
    const callbacks = makeCallbacks();
    const controller = makeController(callbacks);

    controller.handleTouchStart([touch(1, LEFT_X, 200), touch(2, RIGHT_X, 300)], 0);
    controller.handleTouchMove([touch(1, LEFT_X, 200 - JOYSTICK_RADIUS_PX)]);
    callbacks.setKey.mockClear();

    controller.handleTouchEnd([touch(2, RIGHT_X, 300)], 40); // short tap, no movement
    expect(callbacks.onTap).toHaveBeenCalledTimes(1);
    expect(callbacks.setKey).not.toHaveBeenCalled(); // joystick untouched by the look finger's release

    // Joystick finger can still drive movement afterward.
    controller.handleTouchMove([touch(1, LEFT_X + JOYSTICK_RADIUS_PX, 200 - JOYSTICK_RADIUS_PX)]);
    expect(callbacks.setKey).toHaveBeenCalledWith('KeyD', true);
  });
});

describe('TouchInputController — touchcancel', () => {
  it('releases the joystick without firing onTap (cancel is not a completed gesture)', () => {
    const callbacks = makeCallbacks();
    const controller = makeController(callbacks);

    controller.handleTouchStart([touch(1, LEFT_X, 200)], 0);
    controller.handleTouchMove([touch(1, LEFT_X, 200 - JOYSTICK_RADIUS_PX)]);
    callbacks.setKey.mockClear();

    controller.handleTouchCancel([touch(1, LEFT_X, 200 - JOYSTICK_RADIUS_PX)]);

    expect(callbacks.setKey).toHaveBeenCalledWith('KeyW', false);
    expect(callbacks.onStickChange).toHaveBeenLastCalledWith(null);
  });

  it('cancelling the look finger never fires onTap even for a short, stationary touch', () => {
    const callbacks = makeCallbacks();
    const controller = makeController(callbacks);

    controller.handleTouchStart([touch(1, RIGHT_X, 200)], 0);
    controller.handleTouchCancel([touch(1, RIGHT_X, 200)]);

    expect(callbacks.onTap).not.toHaveBeenCalled();
  });

  it('after a cancel, a fresh touch with the same identifier is tracked as a brand-new gesture', () => {
    const callbacks = makeCallbacks();
    const controller = makeController(callbacks);

    controller.handleTouchStart([touch(1, RIGHT_X, 200)], 0);
    controller.handleTouchCancel([touch(1, RIGHT_X, 200)]);

    controller.handleTouchStart([touch(1, RIGHT_X, 200)], 1000);
    controller.handleTouchEnd([touch(1, RIGHT_X, 200)], 1010);

    expect(callbacks.onTap).toHaveBeenCalledTimes(1);
  });
});

describe('TouchInputController — sprint routing (regression: fly-mode Shift/Ctrl conflict)', () => {
  it('reports full-deflection joystick sprint via setSprint, never via setKey', () => {
    const callbacks = makeCallbacks();
    const controller = makeController(callbacks);

    controller.handleTouchStart([touch(1, LEFT_X, 200)], 0);
    // Straight up, at the radius: full deflection -> sprint should engage.
    controller.handleTouchMove([touch(1, LEFT_X, 200 - JOYSTICK_RADIUS_PX)]);

    expect(callbacks.setSprint).toHaveBeenCalledWith(true);
    // setKey must never be asked to press a sprint-shaped key (ShiftLeft) —
    // that was the bug: a shared ShiftLeft code fed straight into
    // FlyController reads as fly-DOWN, not fly-sprint (Ctrl is fly's own
    // sprint key). setSprint exists precisely so the caller (ModeManager)
    // resolves the correct per-controller key instead of TouchInputController
    // picking one keycode for both.
    expect(callbacks.setKey).not.toHaveBeenCalledWith('ShiftLeft', expect.anything());
  });

  it('releases sprint on lift, once, without ever going through setKey', () => {
    const callbacks = makeCallbacks();
    const controller = makeController(callbacks);

    controller.handleTouchStart([touch(1, LEFT_X, 200)], 0);
    controller.handleTouchMove([touch(1, LEFT_X, 200 - JOYSTICK_RADIUS_PX)]);
    callbacks.setSprint.mockClear();

    controller.handleTouchEnd([touch(1, LEFT_X, 200 - JOYSTICK_RADIUS_PX)], 500);

    expect(callbacks.setSprint).toHaveBeenCalledWith(false);
    expect(callbacks.setKey).not.toHaveBeenCalledWith('ShiftLeft', expect.anything());
  });

  it('does not call setSprint again while deflection stays above the threshold (diffed like the directional keys)', () => {
    const callbacks = makeCallbacks();
    const controller = makeController(callbacks);

    controller.handleTouchStart([touch(1, LEFT_X, 200)], 0);
    controller.handleTouchMove([touch(1, LEFT_X, 200 - JOYSTICK_RADIUS_PX)]);
    callbacks.setSprint.mockClear();

    controller.handleTouchMove([touch(1, LEFT_X + 1, 200 - JOYSTICK_RADIUS_PX)]); // still full deflection

    expect(callbacks.setSprint).not.toHaveBeenCalled();
  });
});

describe('TouchInputController — optional onStickChange', () => {
  it('does not throw when onStickChange is omitted', () => {
    const callbacks: TouchInputCallbacks = {
      setKey: vi.fn(),
      setSprint: vi.fn(),
      applyLookDelta: vi.fn(),
      onTap: vi.fn(),
    };
    const controller = makeController(callbacks);

    expect(() => {
      controller.handleTouchStart([touch(1, LEFT_X, 200)], 0);
      controller.handleTouchMove([touch(1, LEFT_X, 200 - JOYSTICK_RADIUS_PX)]);
      controller.handleTouchEnd([touch(1, LEFT_X, 200 - JOYSTICK_RADIUS_PX)], 100);
    }).not.toThrow();
  });
});
