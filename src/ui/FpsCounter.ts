/**
 * Tiny dev-only FPS readout, toggled with F3. main.ts only constructs this
 * when `import.meta.env.DEV`, so it never ships in a production build.
 */
const SAMPLE_INTERVAL_SECONDS = 0.5;

export class FpsCounter {
  private readonly el: HTMLElement;
  private visible = false;
  private lastTime = performance.now();
  private framesSinceUpdate = 0;
  private elapsedSinceUpdate = 0;

  constructor(container: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'fps-counter';
    container.appendChild(this.el);
    window.addEventListener('keydown', this.onKeyDown);
  }

  private onKeyDown = (event: KeyboardEvent): void => {
    if (event.code !== 'F3') return;
    event.preventDefault();
    this.visible = !this.visible;
    this.el.classList.toggle('visible', this.visible);
  };

  /** Call once per rendered animation frame. */
  tick(): void {
    const now = performance.now();
    const dt = (now - this.lastTime) / 1000;
    this.lastTime = now;
    if (!this.visible) return;

    this.framesSinceUpdate++;
    this.elapsedSinceUpdate += dt;
    if (this.elapsedSinceUpdate >= SAMPLE_INTERVAL_SECONDS) {
      const fps = Math.round(this.framesSinceUpdate / this.elapsedSinceUpdate);
      this.el.textContent = `${fps} FPS`;
      this.framesSinceUpdate = 0;
      this.elapsedSinceUpdate = 0;
    }
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    this.el.remove();
  }
}
