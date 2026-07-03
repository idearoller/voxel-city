/**
 * Top toolbar: seed text input, Generate button, dice (random seed) button.
 * Pure DOM UI — emits `onGenerate(seed)`, has no knowledge of World/engine;
 * main.ts owns the actual (async) generation lifecycle and loading overlay.
 */

function randomSeed(): string {
  return Math.random().toString(36).slice(2, 10);
}

export type GenerateRequestListener = (seed: string) => void;
export type ToggleListener = () => void;
export type ExportRequestListener = () => void;
export type ImportRequestListener = (file: File) => void;

export class Toolbar {
  private readonly root: HTMLElement;
  private readonly seedInput: HTMLInputElement;
  private readonly pauseButton: HTMLButtonElement;
  private readonly rainButton: HTMLButtonElement;
  private readonly importFileInput: HTMLInputElement;
  private readonly listeners: GenerateRequestListener[] = [];
  private readonly pauseListeners: ToggleListener[] = [];
  private readonly rainListeners: ToggleListener[] = [];
  private readonly exportListeners: ExportRequestListener[] = [];
  private readonly importListeners: ImportRequestListener[] = [];

  constructor(container: HTMLElement, initialSeed: string) {
    this.root = document.createElement('div');
    this.root.className = 'toolbar';
    this.root.style.pointerEvents = 'auto';

    this.seedInput = document.createElement('input');
    this.seedInput.type = 'text';
    this.seedInput.className = 'toolbar-input';
    this.seedInput.value = initialSeed;
    this.seedInput.spellcheck = false;
    this.seedInput.setAttribute('aria-label', 'City seed');
    this.root.appendChild(this.seedInput);

    const generateButton = document.createElement('button');
    generateButton.type = 'button';
    generateButton.className = 'toolbar-button';
    generateButton.textContent = 'GENERATE';
    generateButton.addEventListener('click', () => this.requestGenerate(this.seedInput.value));
    this.root.appendChild(generateButton);

    const diceButton = document.createElement('button');
    diceButton.type = 'button';
    diceButton.className = 'toolbar-button toolbar-dice';
    diceButton.textContent = '\u{1F3B2}'; // dice emoji
    diceButton.title = 'Random seed';
    diceButton.addEventListener('click', () => {
      this.seedInput.value = randomSeed();
      this.requestGenerate(this.seedInput.value);
    });
    this.root.appendChild(diceButton);

    this.seedInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') this.requestGenerate(this.seedInput.value);
    });

    this.pauseButton = document.createElement('button');
    this.pauseButton.type = 'button';
    this.pauseButton.className = 'toolbar-button';
    this.pauseButton.textContent = '⏸ CYCLE'; // pause symbol, default running
    this.pauseButton.title = 'Pause/resume day-night cycle';
    this.pauseButton.addEventListener('click', () => {
      for (const listener of this.pauseListeners) listener();
    });
    this.root.appendChild(this.pauseButton);

    this.rainButton = document.createElement('button');
    this.rainButton.type = 'button';
    this.rainButton.className = 'toolbar-button';
    this.rainButton.textContent = '☔ RAIN'; // umbrella, default on
    this.rainButton.title = 'Toggle rain';
    this.rainButton.addEventListener('click', () => {
      for (const listener of this.rainListeners) listener();
    });
    this.root.appendChild(this.rainButton);

    const exportButton = document.createElement('button');
    exportButton.type = 'button';
    exportButton.className = 'toolbar-button';
    exportButton.textContent = '⤓ EXPORT'; // download arrow
    exportButton.title = 'Export city to a .vxc file';
    exportButton.addEventListener('click', () => {
      for (const listener of this.exportListeners) listener();
    });
    this.root.appendChild(exportButton);

    const importButton = document.createElement('button');
    importButton.type = 'button';
    importButton.className = 'toolbar-button';
    importButton.textContent = '⤒ IMPORT'; // upload arrow
    importButton.title = 'Import a city from a .vxc file';
    importButton.addEventListener('click', () => this.importFileInput.click());
    this.root.appendChild(importButton);

    this.importFileInput = document.createElement('input');
    this.importFileInput.type = 'file';
    this.importFileInput.accept = '.vxc';
    this.importFileInput.style.display = 'none';
    this.importFileInput.addEventListener('change', () => {
      const file = this.importFileInput.files?.[0];
      this.importFileInput.value = ''; // allow re-selecting the same file twice in a row
      if (!file) return;
      for (const listener of this.importListeners) listener(file);
    });
    this.root.appendChild(this.importFileInput);

    container.appendChild(this.root);
  }

  onGenerateRequest(listener: GenerateRequestListener): void {
    this.listeners.push(listener);
  }

  onTogglePause(listener: ToggleListener): void {
    this.pauseListeners.push(listener);
  }

  onToggleRain(listener: ToggleListener): void {
    this.rainListeners.push(listener);
  }

  onExportRequest(listener: ExportRequestListener): void {
    this.exportListeners.push(listener);
  }

  /** Fires with the raw `File` the user picked; main.ts owns reading/decoding it. */
  onImportRequest(listener: ImportRequestListener): void {
    this.importListeners.push(listener);
  }

  /** Reflects current day/night-cycle pause state onto the toggle button. */
  setPaused(paused: boolean): void {
    this.pauseButton.textContent = paused ? '▶ CYCLE' : '⏸ CYCLE';
    this.pauseButton.classList.toggle('toolbar-button-active', paused);
  }

  /** Reflects current rain-enabled state onto the toggle button. */
  setRainEnabled(enabled: boolean): void {
    this.rainButton.classList.toggle('toolbar-button-active', !enabled);
  }

  /** Reflects the current city seed onto the seed input — used after a `.vxc` import restores a different seed. */
  setSeed(seed: string): void {
    this.seedInput.value = seed;
  }

  private requestGenerate(rawSeed: string): void {
    const seed = rawSeed.trim() || randomSeed();
    this.seedInput.value = seed;
    for (const listener of this.listeners) listener(seed);
  }
}
