# VoxelCity

A browser-only 3D voxel cyberpunk city. Procedurally generated road grid,
districts, buildings, sky bridges, and street furniture — walk it in
first-person or fly through it and edit voxels by hand. No server: it's a
static site, and a whole city fits in a `.vxc` file you can save and reload.

Everything renders client-side with [Three.js](https://threejs.org/); there
is no backend and no network calls once the page loads.

## Controls

| | Sandbox mode (fly + edit) | Play mode (walk) |
|---|---|---|
| Move | WASD | WASD |
| Vertical / jump | Space up, Shift down | Space to jump |
| Sprint | Ctrl | Shift |
| Look | Mouse (click canvas to lock pointer) | Mouse |
| Remove voxel | Left click | Left click |
| Place voxel | Right click | Right click |
| Select block | Number keys 1-9/0, or mouse wheel | same |
| Switch mode | Tab | Tab |

Play mode adds gravity, collision, and single-voxel auto-stepping (like
climbing stairs); sandbox mode ignores collision entirely so you can fly
anywhere to build.

Toolbar (top-left): seed field + **GENERATE** to (re)build the city from a
seed, 🎲 for a random seed, **⏸ CYCLE** to pause/resume the day-night clock,
**☔ RAIN** to toggle rain, **⤓ EXPORT** / **⤒ IMPORT** for `.vxc` city files.

Press **F3** to toggle a small FPS readout (dev builds only).

## Development

```bash
npm install
npm run dev       # local dev server with HMR
npm run build     # tsc --noEmit + production build to dist/
npm run test      # vitest run (unit tests, node environment, no browser)
npm run preview   # serve the production build locally
```

There is no separate lint step; `tsc --noEmit` runs in strict mode
(`noUnusedLocals`, `noUncheckedIndexedAccess`, etc.) as part of `build` and
is the source of truth for type/dead-code hygiene.

## Architecture

```
src/
  world/    Pure voxel data: BlockRegistry, Chunk (32^3 Uint8Array), World
            (sparse chunk map + bounds-aware get/set), coords math.
            No Three.js dependency — unit-testable in isolation.
  gen/      Procedural generation: deterministic seeded RNG (mulberry32 +
            fork()), 2D city-planning (roads/blocks/parcels/districts),
            building/bridge/walkway/park writers. Pure 2D/3D math that
            writes into World via setBlockRaw, no Three.js.
  engine/   Three.js glue: Engine (renderer/scene/camera/fixed-timestep
            loop), ChunkRenderer + ChunkMesher (greedy-ish per-chunk mesh
            rebuild, budgeted per frame), Materials, Atmosphere (sky/fog/
            day-night), PostFX (bloom), EnvironmentProbe (wet-street
            reflections), Rain, neon animation.
  player/   Sandbox fly controller, first-person walk controller with
            AABB-vs-voxel collision + auto-step, mode switching, look
            controls, voxel raycasting.
  io/       Serializer.ts — the `.vxc` binary export/import format. Pure
            data in/out (ArrayBuffer <-> World), no DOM/Three.js.
  ui/       Plain DOM overlays: Toolbar, Hud, Palette, ErrorToast,
            FpsCounter. No game-logic knowledge; main.ts wires them to the
            engine/world.
  main.ts   Composition root: wires world/engine/gen/player/io/ui together,
            owns the generation and import lifecycles.
```

Key decisions (see the implementation plan for the full rationale):

- **World bounds**: 384 x 384 x 160 voxels, in 32^3 chunks. Sparse: a chunk
  only exists once something writes to it.
- **Determinism**: every generator draws from a seeded `Rng` with `fork()`
  for independent sub-streams, so the same seed always reproduces the same
  city, and forking one sub-generator's stream never perturbs another's.
- **Rendering**: one mesh per chunk per material group (solid / road /
  lit-window / 4 neon channels), rebuilt on a per-frame budget so large
  edits or a fresh generation don't stall a frame — except right after
  `generateCity`/import, where every dirty chunk is flushed synchronously
  behind a loading overlay instead of dribbling in over dozens of frames.
- **Wet streets**: a one-shot `CubeCamera` -> PMREM environment map on the
  road material, refreshed after generation/import and (debounced) after
  edits — not a per-frame reflection technique.

### `.vxc` file format

Custom little-endian binary, RLE-compressed per chunk (~1-3 MB instead of
the ~50 MB a naive JSON dump of the same voxels would be):

```
magic          4 bytes ASCII "VXC1"
formatVersion  u16
metaLength     u32
metaJSON       metaLength bytes, UTF-8 (see below)
chunkCount     u32
chunks (repeated chunkCount times):
  cx, cy, cz   i16 each
  byteLength   u32
  rleData      byteLength bytes: repeated (runLength u16, blockId u8) pairs,
               summing to exactly 32768 (one chunk's worth of voxels)
```

`metaJSON` is `{ app, formatVersion, seed, createdAt, bounds, chunkSize,
palette, timeOfDay, entities }`. `palette` (block id -> block name at
export time) is what makes import resilient to a `BlockRegistry` that's
been reordered or extended since the file was written — ids are remapped by
*name* on import, and an unrecognized name falls back to air with a
warning rather than failing the whole load. `entities` is always `[]` in
phase 1; it's a forward-compatible slot for NPCs/vehicles state in phase 2.

All-air chunks are skipped on export (an imported city starts from an
all-air world, so there's nothing to write). Bad magic, an unsupported
format version, or a truncated/corrupt buffer all raise a typed
`SerializerError` with a clear message instead of crashing; the UI shows it
in a dismissable on-theme toast rather than `window.alert`.

## Phase 2 roadmap (not implemented)

Phase 1 is the core loop: procgen + sandbox editing + first-person play +
export/import. The architecture leaves hooks for phase 2 without committing
to them yet:

- **NPCs / vehicles**: the `.vxc` format's `entities: []` field is reserved
  for this — adding entity state later shouldn't require a format version
  bump for existing saves.
- **Elevators**: `ELEVATOR_SHAFT` blocks and elevator-shaft markers already
  exist in generation as placeholders; no interaction logic yet.
- Everything else (multiplayer, persistence beyond local file export,
  further district/building variety) is deliberately out of scope for now.
