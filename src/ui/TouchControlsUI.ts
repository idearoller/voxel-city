import type { Mode } from '../player/ModeManager';
import type { StickVisual } from '../input/TouchInputController';

export type EditMode = 'place' | 'remove';
export type EditModeListener = (mode: EditMode) => void;

export interface TouchControlsCallbacks {
  /** Same virtual-key path the movement joystick uses — see `ModeManager.setVirtualKey`. */
  setKey(code: string, pressed: boolean): void;
  onModeToggle(): void;
  onMuteToggle(): void;
}

/**
 * DOM overlay for touch play, plain-DOM like the rest of `ui/` (Hud,
 * Toolbar, Palette): a floating joystick visual (positioned via `setStick`,
 * fed by `TouchInputController.onStickChange`) plus a button bar for the
 * actions that have no natural touch-drag equivalent — jump/fly-up-down,
 * sandbox/play switch, place/remove edit toggle, mute. Hidden by default;
 * `main.ts` calls `setVisible(true)` once touch capability is confirmed
 * (either up front, or on the device's first real touch, for hybrid
 * touch+mouse laptops).
 */
export class TouchControlsUI {
  readonly root: HTMLElement;
  private readonly stickBase: HTMLElement;
  private readonly stickKnob: HTMLElement;
  private readonly jumpButton: HTMLButtonElement;
  private readonly flyUpButton: HTMLButtonElement;
  private readonly flyDownButton: HTMLButtonElement;
  private readonly editModeButton: HTMLButtonElement;
  private readonly muteButton: HTMLButtonElement;

  private editMode: EditMode = 'remove';
  private readonly editModeListeners: EditModeListener[] = [];

  constructor(
    container: HTMLElement,
    private readonly callbacks: TouchControlsCallbacks,
  ) {
    this.root = document.createElement('div');
    this.root.className = 'touch-controls';

    this.stickBase = document.createElement('div');
    this.stickBase.className = 'touch-stick-base';
    this.stickKnob = document.createElement('div');
    this.stickKnob.className = 'touch-stick-knob';
    this.stickBase.appendChild(this.stickKnob);
    this.root.appendChild(this.stickBase);

    const buttonBar = document.createElement('div');
    buttonBar.className = 'touch-button-bar';

    this.jumpButton = this.makeButton(buttonBar, '⏶', 'Jump', 'touch-button-jump');
    this.bindHold(this.jumpButton, 'Space');

    this.flyUpButton = this.makeButton(buttonBar, '▲', 'Fly up', 'touch-button-flyup');
    this.bindHold(this.flyUpButton, 'Space');

    this.flyDownButton = this.makeButton(buttonBar, '▼', 'Fly down', 'touch-button-flydown');
    this.bindHold(this.flyDownButton, 'ShiftLeft');

    const modeButton = this.makeButton(buttonBar, '⇄', 'Switch mode', 'touch-button-mode');
    modeButton.addEventListener('click', () => this.callbacks.onModeToggle());

    this.editModeButton = this.makeButton(buttonBar, '−', 'Toggle place/remove', 'touch-button-editmode');
    this.editModeButton.addEventListener('click', () => this.toggleEditMode());

    this.muteButton = this.makeButton(buttonBar, '\u{1F50A}', 'Mute/unmute ambient audio', 'touch-button-mute');
    this.muteButton.addEventListener('click', () => this.callbacks.onMuteToggle());

    this.root.appendChild(buttonBar);
    container.appendChild(this.root);

    this.setMode('sandbox');
    this.hideStick();
  }

  /** Shows/hides the whole overlay — gated on touch-capability detection in main.ts, not on anything this class knows about. */
  setVisible(visible: boolean): void {
    this.root.classList.toggle('visible', visible);
  }

  /**
   * Swaps jump (play) for fly-up/fly-down (sandbox), mirroring the Hud's
   * hint-line mode swap. Also hides the place/remove edit toggle in tour
   * mode: `main.ts` gates `performTouchEdit` off entirely once
   * `currentMode === 'tour'` (mouse look is the only live input there, same
   * as desktop — see `Hud`'s matching crosshair hide), so leaving this
   * button visible would offer a lever connected to nothing.
   */
  setMode(mode: Mode): void {
    this.jumpButton.classList.toggle('hidden', mode !== 'play');
    this.flyUpButton.classList.toggle('hidden', mode !== 'sandbox');
    this.flyDownButton.classList.toggle('hidden', mode !== 'sandbox');
    this.editModeButton.classList.toggle('hidden', mode === 'tour');
  }

  /** Reflects current audio-muted state onto the mute button — same icon swap as `Toolbar.setMuted`. */
  setMuted(muted: boolean): void {
    this.muteButton.textContent = muted ? '\u{1F507}' : '\u{1F50A}';
    this.muteButton.classList.toggle('touch-button-active', muted);
  }

  /** Positions/shows the floating joystick visual, or hides it when `stick` is `null` (finger lifted). */
  setStick(stick: StickVisual | null): void {
    if (!stick) {
      this.hideStick();
      return;
    }
    this.stickBase.style.left = `${stick.origin.x}px`;
    this.stickBase.style.top = `${stick.origin.y}px`;
    this.stickKnob.style.transform = `translate(${stick.knobOffset.x}px, ${stick.knobOffset.y}px)`;
    this.stickBase.classList.add('visible');
  }

  onEditModeChange(listener: EditModeListener): void {
    this.editModeListeners.push(listener);
  }

  dispose(): void {
    this.root.remove();
  }

  private hideStick(): void {
    this.stickBase.classList.remove('visible');
    this.stickKnob.style.transform = 'translate(0px, 0px)';
  }

  private toggleEditMode(): void {
    this.editMode = this.editMode === 'remove' ? 'place' : 'remove';
    this.editModeButton.textContent = this.editMode === 'remove' ? '−' : '+';
    this.editModeButton.classList.toggle('touch-button-active', this.editMode === 'place');
    for (const listener of this.editModeListeners) listener(this.editMode);
  }

  /** touchstart/touchend-bound "hold" button — jump/fly-up/fly-down all read as a held key for as long as the finger is down, matching keyboard hold semantics. Non-passive + preventDefault avoids the browser's delayed synthetic click re-triggering this on release. */
  private bindHold(button: HTMLButtonElement, code: string): void {
    button.addEventListener(
      'touchstart',
      (event) => {
        event.preventDefault();
        this.callbacks.setKey(code, true);
      },
      { passive: false },
    );
    const release = (event: Event): void => {
      event.preventDefault();
      this.callbacks.setKey(code, false);
    };
    button.addEventListener('touchend', release, { passive: false });
    button.addEventListener('touchcancel', release, { passive: false });
  }

  private makeButton(parent: HTMLElement, label: string, title: string, extraClassName: string): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `touch-button ${extraClassName}`;
    button.textContent = label;
    button.title = title;
    parent.appendChild(button);
    return button;
  }
}
