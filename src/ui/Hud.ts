import type { Mode } from '../player/ModeManager';

const HINTS: Record<Mode, string> = {
  sandbox: 'WASD + Space/Shift fly · Ctrl sprint · LMB remove · RMB place · Tab: play mode',
  play: 'WASD walk · Shift sprint · Space jump · LMB remove · RMB place · Tab: sandbox mode',
};

/** CSS crosshair + mode indicator + controls hint line, plain DOM overlay. */
export class Hud {
  private readonly modeEl: HTMLElement;
  private readonly hintEl: HTMLElement;

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

    this.setMode('sandbox');
  }

  setMode(mode: Mode): void {
    this.modeEl.textContent = mode.toUpperCase();
    this.modeEl.classList.toggle('play', mode === 'play');
    this.hintEl.textContent = HINTS[mode];
  }
}
