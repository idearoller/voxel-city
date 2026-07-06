import { AIR, BLOCK_DEFS, type BlockDef } from '../world/BlockRegistry';

/**
 * Kept as a plain string union rather than importing `player/ModeManager`'s
 * `Mode` — this file (like the rest of `ui/`, see `Toolbar.QualityTier`'s
 * doc comment) has no dependency on code outside `ui/`; `main.ts` is what
 * wires the two together.
 */
export type PaletteMode = 'sandbox' | 'play' | 'tour';

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

    PLACEABLE_BLOCKS.forEach((block, index) => {
      const swatch = document.createElement('div');
      swatch.className = 'palette-swatch';
      swatch.style.background = cssColor(block);
      if (block.emissive) {
        swatch.style.boxShadow = `0 0 10px ${cssColor(block)}`;
      }
      swatch.title = block.name;
      // Click/tap selects directly — the only selection path that works
      // without a keyboard or scroll wheel, i.e. on touch.
      swatch.addEventListener('click', () => this.select(index));
      this.root.appendChild(swatch);
      this.swatchEls.push(swatch);
    });

    container.appendChild(this.root);
    this.updateSelectionStyle();

    window.addEventListener('keydown', this.onKeyDown);
    this.canvas.addEventListener('wheel', this.onWheel, { passive: false });
  }

  get selectedBlockId(): number {
    return (PLACEABLE_BLOCKS[this.selectedIndex] as BlockDef).id;
  }

  /**
   * Hides the whole swatch bar in tour mode: editing is disabled there (see
   * main.ts's `currentMode === 'tour'` guards on both voxel edits and the
   * touch edit-mode button/`Hud` crosshair), so a block selector would be
   * offering a choice that can never be placed. Sandbox and play both show
   * it unconditionally today (there is no existing precedent for hiding it
   * in either), so tour is the only mode this newly gates off.
   */
  setMode(mode: PaletteMode): void {
    this.root.classList.toggle('hidden', mode === 'tour');
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
