/**
 * `.vxc` binary export/import format: a compact RLE-encoded voxel dump plus
 * a JSON metadata header. Pure data in/out — no DOM, no Three.js — so
 * encode/decode/apply are unit-testable without a browser. DOM glue (Blob,
 * `<a download>`, `<input type=file>`) lives in ui/main, mirroring the
 * world/gen boundary rule documented on `World.ts` / `CityGenerator.ts`.
 *
 * Layout (little-endian throughout):
 *
 *   magic         4 bytes ASCII "VXC1"
 *   formatVersion u16
 *   metaLength    u32           byte length of the following UTF-8 JSON
 *   metaJSON      metaLength bytes, UTF-8 (see `WorldMeta`)
 *   chunkCount    u32
 *   chunks (repeated chunkCount times):
 *     cx, cy, cz  i16 each
 *     byteLength  u32           byte length of the following rleData
 *     rleData     byteLength bytes: repeated (runLength u16, blockId u8)
 *                 pairs, run lengths summing to exactly CHUNK_VOXEL_COUNT
 *                 (32768) — one run per maximal span of equal-id voxels in
 *                 the chunk's flat local-index order (`coords.localIndex`,
 *                 the same order `Chunk.voxels` is already stored in).
 *
 * All-air chunks are skipped entirely (not written): importing into a fresh
 * `World` already treats every unallocated cell as air, so there's nothing
 * to encode.
 *
 * `WorldMeta.palette` (block id -> block name, as of export) is what makes
 * import resilient to a `BlockRegistry` that has been reordered or extended
 * since the file was written: ids are remapped by *name*, not reused
 * verbatim. A name with no current match falls back to AIR with a
 * console.warn rather than failing the whole import.
 */

import { AIR, BLOCK_DEFS } from '../world/BlockRegistry';
import { CHUNK_VOXEL_COUNT } from '../world/coords';
import type { World } from '../world/World';

export const FORMAT_VERSION = 1;
const MAGIC = 'VXC1';

/** Raised for any structurally invalid `.vxc` input — bad magic, unsupported version, or truncated/corrupt bytes. */
export class SerializerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SerializerError';
  }
}

export interface WorldMeta {
  app: 'voxelcity';
  formatVersion: number;
  seed: string;
  createdAt: string;
  bounds: { x: number; y: number; z: number };
  chunkSize: number;
  /** Block id -> block name, as of export. Import remaps ids by name. */
  palette: Record<number, string>;
  timeOfDay: number;
  /** Phase-2 valve: always empty in phase 1, preserved for forward compat. */
  entities: unknown[];
}

export interface SerializeOptions {
  seed: string;
  timeOfDay: number;
  bounds: { x: number; y: number; z: number };
  chunkSize: number;
  /** Defaults to `new Date().toISOString()`; overridable for deterministic tests. */
  createdAt?: string;
}

interface DecodedChunk {
  cx: number;
  cy: number;
  cz: number;
  /** Full CHUNK_VOXEL_COUNT-length flat voxel array, ids as stored in the file (not yet remapped). */
  voxels: Uint8Array;
}

export interface DecodedWorld {
  meta: WorldMeta;
  chunks: DecodedChunk[];
}

function currentPalette(): Record<number, string> {
  const palette: Record<number, string> = {};
  for (const block of BLOCK_DEFS) palette[block.id] = block.name;
  return palette;
}

// ---------------------------------------------------------------------------
// Encode: World -> ArrayBuffer
// ---------------------------------------------------------------------------

/** Run-length-encodes one chunk's flat voxel array; null if the chunk is all-air (caller skips it). */
function encodeChunkRle(voxels: Uint8Array): Uint8Array | null {
  if (voxels.every((id) => id === AIR)) return null;

  const runLengths: number[] = [];
  const runIds: number[] = [];
  let runStart = 0;
  for (let i = 1; i <= voxels.length; i++) {
    if (i < voxels.length && voxels[i] === voxels[runStart]) continue;
    runLengths.push(i - runStart);
    runIds.push(voxels[runStart] as number);
    runStart = i;
  }

  const bytes = new Uint8Array(runLengths.length * 3);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < runLengths.length; i++) {
    view.setUint16(i * 3, runLengths[i] as number, true);
    view.setUint8(i * 3 + 2, runIds[i] as number);
  }
  return bytes;
}

/** Serializes `world` (plus export-time metadata) into a `.vxc` byte buffer. */
export function serializeWorld(world: World, options: SerializeOptions): ArrayBuffer {
  const meta: WorldMeta = {
    app: 'voxelcity',
    formatVersion: FORMAT_VERSION,
    seed: options.seed,
    createdAt: options.createdAt ?? new Date().toISOString(),
    bounds: options.bounds,
    chunkSize: options.chunkSize,
    palette: currentPalette(),
    timeOfDay: options.timeOfDay,
    entities: [],
  };
  const metaBytes = new TextEncoder().encode(JSON.stringify(meta));

  const chunkPayloads: { cx: number; cy: number; cz: number; rle: Uint8Array }[] = [];
  for (const { cx, cy, cz, chunk } of world.allocatedChunkEntries()) {
    const rle = encodeChunkRle(chunk.voxels);
    if (rle) chunkPayloads.push({ cx, cy, cz, rle });
  }

  const headerSize = MAGIC.length + 2 + 4 + metaBytes.length + 4;
  const chunksSize = chunkPayloads.reduce((sum, c) => sum + 3 * 2 + 4 + c.rle.length, 0);
  const buffer = new ArrayBuffer(headerSize + chunksSize);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  let offset = 0;

  for (let i = 0; i < MAGIC.length; i++) bytes[offset++] = MAGIC.charCodeAt(i);
  view.setUint16(offset, FORMAT_VERSION, true);
  offset += 2;
  view.setUint32(offset, metaBytes.length, true);
  offset += 4;
  bytes.set(metaBytes, offset);
  offset += metaBytes.length;
  view.setUint32(offset, chunkPayloads.length, true);
  offset += 4;

  for (const { cx, cy, cz, rle } of chunkPayloads) {
    view.setInt16(offset, cx, true);
    offset += 2;
    view.setInt16(offset, cy, true);
    offset += 2;
    view.setInt16(offset, cz, true);
    offset += 2;
    view.setUint32(offset, rle.length, true);
    offset += 4;
    bytes.set(rle, offset);
    offset += rle.length;
  }

  return buffer;
}

// ---------------------------------------------------------------------------
// Decode: ArrayBuffer -> plain data (no World mutation)
// ---------------------------------------------------------------------------

/** Bounds-checked little-endian cursor over a DataView; throws `SerializerError` instead of a raw RangeError on truncated input. */
class ByteReader {
  private offset = 0;

  constructor(private readonly view: DataView) {}

  private ensure(length: number): void {
    if (this.offset + length > this.view.byteLength) {
      throw new SerializerError('Truncated .vxc file.');
    }
  }

  readInt16(): number {
    this.ensure(2);
    const value = this.view.getInt16(this.offset, true);
    this.offset += 2;
    return value;
  }

  readUint16(): number {
    this.ensure(2);
    const value = this.view.getUint16(this.offset, true);
    this.offset += 2;
    return value;
  }

  readUint32(): number {
    this.ensure(4);
    const value = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return value;
  }

  readBytes(length: number): Uint8Array {
    this.ensure(length);
    const bytes = new Uint8Array(this.view.buffer, this.view.byteOffset + this.offset, length);
    this.offset += length;
    return bytes;
  }
}

function parseMeta(bytes: Uint8Array): WorldMeta {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new SerializerError('Corrupt .vxc metadata (invalid JSON).');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new SerializerError('Corrupt .vxc metadata (expected an object).');
  }
  return parsed as WorldMeta;
}

function decodeChunkRle(rle: Uint8Array): Uint8Array {
  const voxels = new Uint8Array(CHUNK_VOXEL_COUNT);
  const view = new DataView(rle.buffer, rle.byteOffset, rle.byteLength);
  let cursor = 0;
  let writeIndex = 0;

  while (cursor < rle.byteLength) {
    if (cursor + 3 > rle.byteLength) {
      throw new SerializerError('Corrupt .vxc chunk data (truncated run).');
    }
    const runLength = view.getUint16(cursor, true);
    const id = view.getUint8(cursor + 2);
    cursor += 3;

    if (writeIndex + runLength > CHUNK_VOXEL_COUNT) {
      throw new SerializerError('Corrupt .vxc chunk data (run overflows chunk).');
    }
    voxels.fill(id, writeIndex, writeIndex + runLength);
    writeIndex += runLength;
  }

  if (writeIndex !== CHUNK_VOXEL_COUNT) {
    throw new SerializerError('Corrupt .vxc chunk data (short chunk).');
  }
  return voxels;
}

/** Parses a `.vxc` byte buffer into plain data. Throws `SerializerError` on bad magic, unsupported version, or truncated/corrupt bytes. */
export function decodeWorld(buffer: ArrayBuffer): DecodedWorld {
  const reader = new ByteReader(new DataView(buffer));

  const magicBytes = reader.readBytes(MAGIC.length);
  let magic = '';
  for (const byte of magicBytes) magic += String.fromCharCode(byte);
  if (magic !== MAGIC) {
    throw new SerializerError(`Not a .vxc file (bad magic "${magic}").`);
  }

  const formatVersion = reader.readUint16();
  if (formatVersion !== FORMAT_VERSION) {
    throw new SerializerError(
      `Unsupported .vxc format version ${formatVersion} (expected ${FORMAT_VERSION}).`,
    );
  }

  const metaLength = reader.readUint32();
  const meta = parseMeta(reader.readBytes(metaLength));

  const chunkCount = reader.readUint32();
  const chunks: DecodedChunk[] = [];
  for (let i = 0; i < chunkCount; i++) {
    const cx = reader.readInt16();
    const cy = reader.readInt16();
    const cz = reader.readInt16();
    const byteLength = reader.readUint32();
    const voxels = decodeChunkRle(reader.readBytes(byteLength));
    chunks.push({ cx, cy, cz, voxels });
  }

  return { meta, chunks };
}

// ---------------------------------------------------------------------------
// Apply: decoded data -> World mutation (id remap, clear, load, remesh)
// ---------------------------------------------------------------------------

/** Builds an old-id -> current-id lookup table by matching block *names*, so a reordered/extended registry still round-trips. Unmapped names fall back to AIR (0) and log one console.warn each. */
function buildIdRemapTable(palette: Record<number, string>): Uint8Array {
  const nameToCurrentId = new Map(BLOCK_DEFS.map((block) => [block.name, block.id]));
  const table = new Uint8Array(256).fill(AIR);
  const warnedNames = new Set<string>();

  for (const [idText, name] of Object.entries(palette)) {
    const oldId = Number(idText);
    const currentId = nameToCurrentId.get(name);
    if (currentId === undefined) {
      if (!warnedNames.has(name)) {
        console.warn(`.vxc import: unknown block "${name}" (id ${oldId}) -> AIR`);
        warnedNames.add(name);
      }
      continue;
    }
    if (oldId >= 0 && oldId < table.length) {
      table[oldId] = currentId;
    }
  }
  return table;
}

function remapVoxels(voxels: Uint8Array, remap: Uint8Array): Uint8Array {
  const out = new Uint8Array(voxels.length);
  for (let i = 0; i < voxels.length; i++) {
    out[i] = remap[voxels[i] as number] ?? AIR;
  }
  return out;
}

/**
 * Applies a decoded `.vxc` payload onto `world`: clears every existing
 * chunk, remaps block ids by name against the *current* `BlockRegistry`,
 * loads every chunk, and finishes with a single `remeshAll()` — the same
 * bulk-write convention `CityGenerator.generateCity` follows. Returns the
 * decoded meta for the caller (seed, timeOfDay, etc). Callers still need to
 * flush the renderer (`ChunkRenderer.rebuildAllDirty`) and refresh the wet-
 * street env probe themselves, same as after `generateCity`.
 */
export function applyDecodedWorld(world: World, decoded: DecodedWorld): WorldMeta {
  const remap = buildIdRemapTable(decoded.meta.palette ?? {});

  world.clear();
  for (const { cx, cy, cz, voxels } of decoded.chunks) {
    world.loadChunkRaw(cx, cy, cz, remapVoxels(voxels, remap));
  }
  world.remeshAll();

  return decoded.meta;
}

/** Decodes and applies a `.vxc` buffer onto `world` in one step. Throws `SerializerError` on invalid input. */
export function importWorld(world: World, buffer: ArrayBuffer): WorldMeta {
  return applyDecodedWorld(world, decodeWorld(buffer));
}
