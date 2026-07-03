/**
 * Top toolbar: seed text input, Generate button, dice (random seed) button.
 * Pure DOM UI — emits `onGenerate(seed)`, has no knowledge of World/engine;
 * main.ts owns the actual (async) generation lifecycle and loading overlay.
 */

function randomSeed(): string {
  return Math.random().toString(36).slice(2, 10);
}

export type GenerateRequestListener = (seed: string) => void;

export class Toolbar {
  private readonly root: HTMLElement;
  private readonly seedInput: HTMLInputElement;
  private readonly listeners: GenerateRequestListener[] = [];

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

    container.appendChild(this.root);
  }

  onGenerateRequest(listener: GenerateRequestListener): void {
    this.listeners.push(listener);
  }

  private requestGenerate(rawSeed: string): void {
    const seed = rawSeed.trim() || randomSeed();
    this.seedInput.value = seed;
    for (const listener of this.listeners) listener(seed);
  }
}
