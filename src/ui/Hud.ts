import type { Mode } from '../player/ModeManager';

const HINTS: Record<Mode, string> = {
  sandbox: 'WASD + Space/Shift fly · Ctrl sprint · LMB remove · RMB place · Tab: play mode',
  play: 'WASD walk · Shift sprint · Space jump · LMB remove · RMB place · Tab: sandbox mode',
};

/** How long the mode indicator's attention-grabbing flash animation runs. */
const MODE_FLASH_MS = 500;

/** CSS crosshair + mode indicator + controls hint line, plain DOM overlay. */
export class Hud {
  private readonly modeEl: HTMLElement;
  private readonly hintEl: HTMLElement;
  /** null until the first setMode call, so the initial render never flashes. */
  private previousMode: Mode | null = null;
  private flashTimeout: ReturnType<typeof setTimeout> | undefined;

  constructor(container: HTMLElement) {
    const crosshair = document.createElement('div');
    crosshair.className = 'hud-crosshair';
    container.appendChild(crosshair);

    this.modeEl = document.createElement('div');
    this.modeEl.className = 'hud-mode';
    container.appendChild(this.modeEl);

    this.hintEl = document.createElement('div');
    this.hintEl.className = 'hud-hint';
    container.appendChild(this.hintEl);

    // Render the initial (pre-generation) sandbox state directly, without
    // going through setMode: that keeps previousMode at null, so the first
    // *real* setMode call — main.ts entering play mode once city generation
    // finishes — is still treated as "initial" and doesn't flash either.
    this.modeEl.textContent = 'sandbox'.toUpperCase();
    this.hintEl.textContent = HINTS.sandbox;
  }

  setMode(mode: Mode): void {
    const changed = this.previousMode !== null && this.previousMode !== mode;
    this.previousMode = mode;

    this.modeEl.textContent = mode.toUpperCase();
    this.modeEl.classList.toggle('play', mode === 'play');
    this.hintEl.textContent = HINTS[mode];

    if (changed) this.flashModeIndicator();
  }

  /** Briefly re-triggers the mode indicator's CSS flash animation so a Tab switch is noticeable. */
  private flashModeIndicator(): void {
    this.modeEl.classList.remove('hud-mode--flash');
    // Force a reflow so re-adding the class restarts the animation even if
    // it's re-triggered before the previous flash finished.
    void this.modeEl.offsetWidth;
    this.modeEl.classList.add('hud-mode--flash');

    if (this.flashTimeout !== undefined) clearTimeout(this.flashTimeout);
    this.flashTimeout = setTimeout(() => {
      this.modeEl.classList.remove('hud-mode--flash');
      this.flashTimeout = undefined;
    }, MODE_FLASH_MS);
  }

  dispose(): void {
    if (this.flashTimeout !== undefined) clearTimeout(this.flashTimeout);
  }
}
