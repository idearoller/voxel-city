/**
 * Procedural texture atlas for animated billboard faces (Phase 2 Task 6,
 * Part A): a small grid of self-contained "ad" tile designs — glyph strips,
 * geometric cyberpunk patterns, brand-like marks — generated at startup with
 * a `CanvasTexture`, no external assets (keeps the app self-contained /
 * CSP-friendly).
 *
 * Split in two, same convention as `BlockRegistry`/`ChunkMesher`: `planAtlasLayout`
 * is pure data (which tile gets which design, colors, glyph placement) —
 * deterministic per seed, unit-testable without a DOM. `rasterizeAtlasTexture`
 * is the thin, untested layer that actually draws it onto a real
 * `HTMLCanvasElement` — canvas 2D rasterization needs a real DOM, which this
 * project's vitest environment (`environment: 'node'`, see `vitest.config.ts`)
 * doesn't provide, so no test imports or calls it.
 */

import * as THREE from 'three';
import { createRng, type Rng } from '../gen/rng';

/** One design per atlas cell. 8 designs fit a 4x2 grid at a comfortable per-tile resolution. */
export const ATLAS_COLS = 4;
export const ATLAS_ROWS = 2;
export const ATLAS_DESIGN_COUNT = ATLAS_COLS * ATLAS_ROWS;

/** Pixels per tile in the rasterized texture (kept modest — these are unlit, blocky neon signs, not detailed art). */
export const ATLAS_TILE_SIZE = 128;

export type AtlasDesignKind = 'glyphStrip' | 'geometricPattern' | 'brandMark';

/** A single glyph-like block within a glyphStrip design: a filled rectangle at a fractional (x, width) offset within the tile. */
export interface GlyphBlock {
  x: number;
  width: number;
}

/** One row of a geometricPattern design: a horizontal band at a fractional (y, height), alternating on/off across `segments` columns. */
export interface PatternBand {
  y: number;
  height: number;
  segments: number;
  phase: number;
}

export interface AtlasDesignPlan {
  kind: AtlasDesignKind;
  /** Background color behind the design, as a hex string (`"#rrggbb"`). */
  background: string;
  /** Foreground (glyph/pattern/mark) color, as a hex string. */
  foreground: string;
  glyphRows: readonly GlyphBlock[][];
  patternBands: readonly PatternBand[];
  /** Number of concentric rings for a brandMark design. */
  brandRings: number;
}

const KIND_CYCLE: readonly AtlasDesignKind[] = ['glyphStrip', 'geometricPattern', 'brandMark'];

const BACKGROUNDS = ['#0a0410', '#04080c', '#0c0208', '#02060a'];
const FOREGROUNDS = ['#ff2d95', '#2df5ff', '#ffe742', '#aa3cff', '#40e8ff', '#ff5540'];

const GLYPH_ROWS_MIN = 3;
const GLYPH_ROWS_MAX = 5;
const GLYPHS_PER_ROW_MIN = 3;
const GLYPHS_PER_ROW_MAX = 6;

const PATTERN_BANDS_MIN = 3;
const PATTERN_BANDS_MAX = 6;
const PATTERN_SEGMENTS_MIN = 3;
const PATTERN_SEGMENTS_MAX = 8;

const BRAND_RINGS_MIN = 2;
const BRAND_RINGS_MAX = 5;

function planGlyphRows(rng: Rng): GlyphBlock[][] {
  const rowCount = rng.intRange(GLYPH_ROWS_MIN, GLYPH_ROWS_MAX);
  const rows: GlyphBlock[][] = [];
  for (let r = 0; r < rowCount; r++) {
    const glyphCount = rng.intRange(GLYPHS_PER_ROW_MIN, GLYPHS_PER_ROW_MAX);
    const glyphs: GlyphBlock[] = [];
    for (let g = 0; g < glyphCount; g++) {
      glyphs.push({ x: g / glyphCount, width: (1 / glyphCount) * rng.float(0.45, 0.8) });
    }
    rows.push(glyphs);
  }
  return rows;
}

function planPatternBands(rng: Rng): PatternBand[] {
  const bandCount = rng.intRange(PATTERN_BANDS_MIN, PATTERN_BANDS_MAX);
  const bands: PatternBand[] = [];
  for (let b = 0; b < bandCount; b++) {
    bands.push({
      y: b / bandCount,
      height: (1 / bandCount) * rng.float(0.4, 0.75),
      segments: rng.intRange(PATTERN_SEGMENTS_MIN, PATTERN_SEGMENTS_MAX),
      phase: rng.intRange(0, 1),
    });
  }
  return bands;
}

/**
 * Deterministic layout for `ATLAS_DESIGN_COUNT` atlas tiles: which kind of
 * design each cell gets (cycled, not random, so every design kind actually
 * appears at least twice regardless of seed) plus that kind's own randomized
 * parameters, colors, and glyph/pattern placement — everything
 * `rasterizeAtlasTexture` needs to draw it, without touching a canvas.
 */
export function planAtlasLayout(seed: string): AtlasDesignPlan[] {
  const rootRng = createRng(seed).fork('billboard-atlas');
  const designs: AtlasDesignPlan[] = [];

  for (let i = 0; i < ATLAS_DESIGN_COUNT; i++) {
    const designRng = rootRng.fork(`design-${i}`);
    const kind = KIND_CYCLE[i % KIND_CYCLE.length] as AtlasDesignKind;
    designs.push({
      kind,
      background: designRng.pick(BACKGROUNDS),
      foreground: designRng.pick(FOREGROUNDS),
      glyphRows: kind === 'glyphStrip' ? planGlyphRows(designRng) : [],
      patternBands: kind === 'geometricPattern' ? planPatternBands(designRng) : [],
      brandRings: kind === 'brandMark' ? designRng.intRange(BRAND_RINGS_MIN, BRAND_RINGS_MAX) : 0,
    });
  }

  return designs;
}

function drawGlyphStrip(ctx: CanvasRenderingContext2D, plan: AtlasDesignPlan, originX: number, originY: number): void {
  const rowHeight = ATLAS_TILE_SIZE / plan.glyphRows.length;
  ctx.fillStyle = plan.foreground;
  plan.glyphRows.forEach((glyphs, r) => {
    const y = originY + r * rowHeight;
    for (const glyph of glyphs) {
      ctx.fillRect(originX + glyph.x * ATLAS_TILE_SIZE, y + rowHeight * 0.15, glyph.width * ATLAS_TILE_SIZE, rowHeight * 0.7);
    }
  });
}

function drawGeometricPattern(ctx: CanvasRenderingContext2D, plan: AtlasDesignPlan, originX: number, originY: number): void {
  ctx.fillStyle = plan.foreground;
  for (const band of plan.patternBands) {
    const segmentWidth = ATLAS_TILE_SIZE / band.segments;
    for (let s = 0; s < band.segments; s++) {
      if ((s + band.phase) % 2 !== 0) continue;
      ctx.fillRect(
        originX + s * segmentWidth,
        originY + band.y * ATLAS_TILE_SIZE,
        segmentWidth,
        band.height * ATLAS_TILE_SIZE,
      );
    }
  }
}

function drawBrandMark(ctx: CanvasRenderingContext2D, plan: AtlasDesignPlan, originX: number, originY: number): void {
  const centerX = originX + ATLAS_TILE_SIZE / 2;
  const centerY = originY + ATLAS_TILE_SIZE / 2;
  const maxRadius = ATLAS_TILE_SIZE * 0.42;
  ctx.strokeStyle = plan.foreground;
  ctx.lineWidth = ATLAS_TILE_SIZE * 0.06;
  for (let ring = 0; ring < plan.brandRings; ring++) {
    const radius = maxRadius * ((ring + 1) / plan.brandRings);
    ctx.beginPath();
    ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
    ctx.stroke();
  }
}

/**
 * Draws every planned design into its atlas cell on a real
 * `HTMLCanvasElement` and wraps it in a `THREE.CanvasTexture`. Browser-only
 * (needs `document`); never called from a test.
 */
export function rasterizeAtlasTexture(designs: readonly AtlasDesignPlan[]): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = ATLAS_COLS * ATLAS_TILE_SIZE;
  canvas.height = ATLAS_ROWS * ATLAS_TILE_SIZE;
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;

  designs.forEach((plan, i) => {
    const col = i % ATLAS_COLS;
    const row = Math.floor(i / ATLAS_COLS);
    const originX = col * ATLAS_TILE_SIZE;
    const originY = row * ATLAS_TILE_SIZE;

    ctx.fillStyle = plan.background;
    ctx.fillRect(originX, originY, ATLAS_TILE_SIZE, ATLAS_TILE_SIZE);

    if (plan.kind === 'glyphStrip') drawGlyphStrip(ctx, plan, originX, originY);
    else if (plan.kind === 'geometricPattern') drawGeometricPattern(ctx, plan, originX, originY);
    else drawBrandMark(ctx, plan, originX, originY);
  });

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  // No mipmaps: BillboardLayer's fragment shader hand-computes atlas UVs per
  // instance (see its `atlasUv` calc), and a mipmapped/trilinear sample near
  // a tile edge blends texels from the *next* tile over — visible as a
  // faint bleed of the neighboring ad, worst right at the scroll-wrap seam
  // where the sampled UV is already at the tile boundary every cycle.
  // Plain bilinear (no mip chain) never reaches outside the exact texel
  // footprint being sampled, so it can't cross a tile boundary.
  texture.generateMipmaps = false;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}
