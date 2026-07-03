import { AIR, BLOCK_DEFS, type BlockDef } from '../world/BlockRegistry';

/** Every placeable block (all block defs except AIR), in registry order. */
const PLACEABLE_BLOCKS: readonly BlockDef[] = BLOCK_DEFS.filter((block) => block.id !== AIR);

/** Number keys 1-9 then 0 jump straight to the first 10 palette slots. */
const DIGIT_KEY_TO_INDEX: ReadonlyMap<string, number> = new Map([
  ['Digit1', 0],
  ['Digit2', 1],
  ['Digit3', 2],
  ['Digit4', 3],
  ['Digit5', 4],
  ['Digit6', 5],
  ['Digit7', 6],
  ['Digit8', 7],
  ['Digit9', 8],
  ['Digit0', 9],
]);

/** True while the user is typing into a text input (e.g. the Toolbar seed field) — digit/wheel hotkeys must not fire then. */
function isTypingIntoInput(): boolean {
  return document.activeElement instanceof HTMLInputElement;
}

function cssColor(block: BlockDef): string {
  const [r, g, b] = block.color;
  return `rgb(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)})`;
}

/**
 * Bottom-bar block palette: one swatch per placeable block, colored from the
 * block registry with a glow for emissive blocks. Selection via number keys
 * 1-9/0 or mouse wheel while pointer-locked (both sandbox and play edit the
 * world through the currently selected block).
 */
export class Palette {
  private selectedIndex = 0;
  private readonly root: HTMLElement;
  private readonly swatchEls: HTMLElement[] = [];

  constructor(
    container: HTMLElement,
    private readonly canvas: HTMLCanvasElement,
  ) {
    this.root = document.createElement('div');
    this.root.className = 'palette';
    this.root.style.pointerEvents = 'auto';

    for (const block of PLACEABLE_BLOCKS) {
      const swatch = document.createElement('div');
      swatch.className = 'palette-swatch';
      swatch.style.background = cssColor(block);
      if (block.emissive) {
        swatch.style.boxShadow = `0 0 10px ${cssColor(block)}`;
      }
      swatch.title = block.name;
      this.root.appendChild(swatch);
      this.swatchEls.push(swatch);
    }

    container.appendChild(this.root);
    this.updateSelectionStyle();

    window.addEventListener('keydown', this.onKeyDown);
    this.canvas.addEventListener('wheel', this.onWheel, { passive: false });
  }

  get selectedBlockId(): number {
    return (PLACEABLE_BLOCKS[this.selectedIndex] as BlockDef).id;
  }

  private onKeyDown = (event: KeyboardEvent): void => {
    if (isTypingIntoInput()) return;
    const index = DIGIT_KEY_TO_INDEX.get(event.code);
    if (index === undefined || index >= PLACEABLE_BLOCKS.length) return;
    this.select(index);
  };

  private onWheel = (event: WheelEvent): void => {
    if (document.pointerLockElement !== this.canvas) return;
    if (isTypingIntoInput()) return;
    event.preventDefault();
    const direction = event.deltaY > 0 ? 1 : -1;
    const count = PLACEABLE_BLOCKS.length;
    this.select((this.selectedIndex + direction + count) % count);
  };

  private select(index: number): void {
    this.selectedIndex = index;
    this.updateSelectionStyle();
  }

  private updateSelectionStyle(): void {
    this.swatchEls.forEach((el, i) => {
      el.classList.toggle('selected', i === this.selectedIndex);
    });
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    this.canvas.removeEventListener('wheel', this.onWheel);
    this.root.remove();
  }
}
