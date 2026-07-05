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
export type RainIntensityListener = (intensity: number) => void;

/**
 * Kept as a plain string union rather than importing `engine/QualityPreference`'s
 * `QualityTier` -- this file (like the rest of `ui/`) has no dependency on
 * `engine/` today (see `RainIntensityListener`'s plain `number`, not a
 * `RainIntensityPreference` import); main.ts is what wires the two together.
 */
export type QualityTier = 'low' | 'medium' | 'high';
export type QualityChangeListener = (tier: QualityTier) => void;

/** Cycle order for the QUALITY button: click steps forward, wrapping high -> low. */
const QUALITY_CYCLE: readonly QualityTier[] = ['low', 'medium', 'high'];

const QUALITY_LABEL: Record<QualityTier, string> = {
  low: '⚙ QUALITY: LOW',
  medium: '⚙ QUALITY: MED',
  high: '⚙ QUALITY: HIGH',
};

export class Toolbar {
  private readonly root: HTMLElement;
  private readonly seedInput: HTMLInputElement;
  private readonly pauseButton: HTMLButtonElement;
  private readonly rainButton: HTMLButtonElement;
  private readonly rainIntensitySlider: HTMLInputElement;
  private readonly muteButton: HTMLButtonElement;
  private readonly qualityButton: HTMLButtonElement;
  private readonly importFileInput: HTMLInputElement;
  private readonly listeners: GenerateRequestListener[] = [];
  private readonly pauseListeners: ToggleListener[] = [];
  private readonly rainListeners: ToggleListener[] = [];
  private readonly rainIntensityListeners: RainIntensityListener[] = [];
  private readonly muteListeners: ToggleListener[] = [];
  private readonly qualityListeners: QualityChangeListener[] = [];
  private readonly exportListeners: ExportRequestListener[] = [];
  private readonly importListeners: ImportRequestListener[] = [];
  private qualityTier: QualityTier = 'high';

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

    // Master/modifier split: the button above is the on/off switch (quick,
    // discoverable, matches every other toolbar toggle); this slider only
    // dials the *amount* of rain while it's on. A native `input[type=range]`
    // needs no extra wiring for touch (see `TouchControlsUI`'s buttons,
    // which are the DOM-button half of touch input) — it's already a
    // pointer-driven control in every mobile browser.
    this.rainIntensitySlider = document.createElement('input');
    this.rainIntensitySlider.type = 'range';
    this.rainIntensitySlider.className = 'toolbar-slider';
    this.rainIntensitySlider.min = '0';
    this.rainIntensitySlider.max = '1';
    this.rainIntensitySlider.step = '0.05';
    this.rainIntensitySlider.setAttribute('aria-label', 'Rain intensity');
    this.rainIntensitySlider.title = 'Rain intensity';
    this.rainIntensitySlider.addEventListener('input', () => {
      const intensity = Number(this.rainIntensitySlider.value);
      for (const listener of this.rainIntensityListeners) listener(intensity);
    });
    this.root.appendChild(this.rainIntensitySlider);

    this.muteButton = document.createElement('button');
    this.muteButton.type = 'button';
    this.muteButton.className = 'toolbar-button';
    this.muteButton.textContent = '\u{1F50A} SOUND'; // speaker, default unmuted
    this.muteButton.title = 'Mute/unmute ambient audio (M)';
    this.muteButton.addEventListener('click', () => {
      for (const listener of this.muteListeners) listener();
    });
    this.root.appendChild(this.muteButton);

    // Three-state cycle (not a checkbox-style toggle, since there are three
    // tiers, not two) -- matches the other toolbar buttons' click-to-act
    // shape rather than introducing a <select>, which the rest of the
    // toolbar has none of.
    this.qualityButton = document.createElement('button');
    this.qualityButton.type = 'button';
    this.qualityButton.className = 'toolbar-button';
    this.qualityButton.textContent = QUALITY_LABEL[this.qualityTier];
    this.qualityButton.title = 'Cycle render quality (Low/Medium/High) — lower for a cooler/faster device';
    this.qualityButton.addEventListener('click', () => {
      const currentIndex = QUALITY_CYCLE.indexOf(this.qualityTier);
      const next = QUALITY_CYCLE[(currentIndex + 1) % QUALITY_CYCLE.length] as QualityTier;
      this.setQuality(next);
      for (const listener of this.qualityListeners) listener(next);
    });
    this.root.appendChild(this.qualityButton);

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

  onRainIntensityChange(listener: RainIntensityListener): void {
    this.rainIntensityListeners.push(listener);
  }

  onToggleMute(listener: ToggleListener): void {
    this.muteListeners.push(listener);
  }

  onQualityChange(listener: QualityChangeListener): void {
    this.qualityListeners.push(listener);
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

  /** Reflects current rain-enabled state onto the toggle button and gates the intensity slider (it only affects anything while rain is on). */
  setRainEnabled(enabled: boolean): void {
    this.rainButton.classList.toggle('toolbar-button-active', !enabled);
    this.rainIntensitySlider.disabled = !enabled;
  }

  /** Reflects the current rain intensity onto the slider — used on startup to restore the persisted value. */
  setRainIntensity(intensity: number): void {
    this.rainIntensitySlider.value = String(intensity);
  }

  /** Reflects current audio-muted state onto the toggle button. */
  setMuted(muted: boolean): void {
    this.muteButton.textContent = muted ? '\u{1F507} SOUND' : '\u{1F50A} SOUND'; // muted-speaker vs speaker
    this.muteButton.classList.toggle('toolbar-button-active', muted);
  }

  /** Reflects the current city seed onto the seed input — used after a `.vxc` import restores a different seed. */
  setSeed(seed: string): void {
    this.seedInput.value = seed;
  }

  /** Reflects the current quality tier onto the button label — used both on startup (restoring the persisted tier) and after a click cycles it. */
  setQuality(tier: QualityTier): void {
    this.qualityTier = tier;
    this.qualityButton.textContent = QUALITY_LABEL[tier];
  }

  private requestGenerate(rawSeed: string): void {
    const seed = rawSeed.trim() || randomSeed();
    this.seedInput.value = seed;
    for (const listener of this.listeners) listener(seed);
  }
}
