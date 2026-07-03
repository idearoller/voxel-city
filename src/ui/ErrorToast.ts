/**
 * On-theme, auto-dismissing error banner — used in place of `window.alert`
 * for recoverable UI errors (e.g. a corrupt `.vxc` import). Click anywhere
 * on it to dismiss early.
 */
const AUTO_DISMISS_MS = 6000;

export class ErrorToast {
  private readonly el: HTMLElement;
  private dismissTimeout: ReturnType<typeof setTimeout> | undefined;

  constructor(container: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'error-toast';
    this.el.style.pointerEvents = 'auto';
    this.el.addEventListener('click', () => this.dismiss());
    container.appendChild(this.el);
  }

  show(message: string): void {
    this.el.textContent = message;
    this.el.classList.add('visible');
    if (this.dismissTimeout !== undefined) clearTimeout(this.dismissTimeout);
    this.dismissTimeout = setTimeout(() => this.dismiss(), AUTO_DISMISS_MS);
  }

  private dismiss(): void {
    this.el.classList.remove('visible');
    if (this.dismissTimeout !== undefined) {
      clearTimeout(this.dismissTimeout);
      this.dismissTimeout = undefined;
    }
  }

  dispose(): void {
    if (this.dismissTimeout !== undefined) clearTimeout(this.dismissTimeout);
    this.el.remove();
  }
}
