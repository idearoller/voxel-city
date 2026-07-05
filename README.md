# VoxelCity

A browser-only 3D voxel cyberpunk city. Procedurally generated road grid,
districts, buildings, sky bridges, walkways, shop interiors, and street
furniture — walk it in first-person or fly through it and edit voxels by
hand. No server: it's a static site, and a whole city fits in a `.vxc` file
you can save and reload.

Everything renders client-side with [Three.js](https://threejs.org/); there
is no backend and no network calls once the page loads.

**Live**: https://idearoller.github.io/voxel-city/

## Features

- **Procedural city generation**: deterministic, seeded — road grid,
  districts, towers, shops, parks, multi-level sky bridges, and walkways,
  all derived from a single seed string (see
  [Deterministic seeds](#deterministic-seeds)).
- **Play mode**: first-person walking with gravity, AABB-vs-voxel collision,
  single-voxel auto-step (climb stairs without jumping), and functional
  elevators.
- **Sandbox mode**: free-fly camera with no collision, for building and
  editing voxels anywhere in the world.
- **NPCs and traffic**: pedestrians on sidewalks, park paths, and elevated
  walkway/skybridge decks (taking stairs between street level and deck
  level); ground vehicles with lane-following traffic flow; flying
  hover-car traffic in dedicated sky lanes above major avenues.
- **Atmosphere**: bloom post-processing, distance fog, rain, a day-night
  cycle, wet-street reflections, animated neon materials, and scrolling
  procedurally-generated billboard ads.
- **Export/import**: save or load an entire city as a compact `.vxc` binary
  file (see [`.vxc` file format](#vxc-file-format)).

## Controls

| Action | Sandbox mode (fly + edit) | Play mode (walk) |
|---|---|---|
| Move | WASD | WASD |
| Vertical / jump | Space up, Shift down | Space to jump |
| Sprint | Ctrl | Shift |
| Look | Mouse (click canvas to lock pointer) | Mouse |
| Remove voxel | Left click | Left click |
| Place voxel | Right click | Right click |
| Select block | Number keys 1-9/0, or mouse wheel | same |
| Elevator up / down | — | E / Q (while standing in a shaft) |
| Switch mode | Tab | Tab |
| Mute / unmute ambient audio | M | M |

Play mode adds gravity, collision, and single-voxel auto-stepping (like
climbing stairs); sandbox mode ignores collision entirely so you can fly
anywhere to build.

Toolbar (top-left): seed field + **GENERATE** to (re)build the city from a
seed, 🎲 for a random seed, **⏸ CYCLE** to pause/resume the day-night clock,
**☔ RAIN** to toggle rain (the slider next to it dials how heavy the rain
falls, and is remembered between sessions), **🔊 SOUND** to mute/unmute ambient audio (rain,
neon hum, distant traffic, and positional hover-car whooshes when you fly
near a sky lane — all synthesized via WebAudio, no audio files),
**⤓ EXPORT** / **⤒ IMPORT** for `.vxc` city files.

### Touch controls

On a touch-capable device (detected by capability — `ontouchstart`/
`maxTouchPoints`, not by sniffing the user agent — so it also covers
touchscreen laptops), an on-screen control overlay appears automatically
(on a hybrid touch+mouse laptop with no touchscreen signal up front, it
appears the moment you actually touch the screen):

| Action | Touch |
|---|---|
| Move | Left half of the screen: touch down anywhere to spawn a floating joystick there, drag to move |
| Look | Right half of the screen: drag to rotate the camera |
| Edit voxel | Right half: a short tap (not a drag) edits the block under the crosshair — remove or place, per the −/+ button |
| Jump (play mode) | ⏶ button |
| Fly up / down (sandbox mode) | ▲ / ▼ buttons |
| Switch mode | ⇄ button |
| Place/remove toggle | −/+ button |
| Mute / unmute | 🔊 button |
| Select block | Tap a palette swatch |

Touch look/edit always aims at the screen-center crosshair — the same point
used for the target-block highlight and desktop mouse aiming — rather than
the raw tap coordinate, so aiming behaves identically regardless of input
device. There is no pointer lock on touch: look comes entirely from
dragging, and the desktop mouse/keyboard/pointer-lock path is unaffected by
any of this — touch only ever adds `touchstart`/`touchmove`/`touchend`
listeners and on-screen buttons alongside it.

Press **F3** to toggle a small FPS readout (dev builds only).

## Development

```bash
npm install
npm run dev       # local dev server with HMR
npm run build     # tsc --noEmit + production build to dist/
npm run test      # vitest run (unit/integration tests, node environment, no browser)
npm run preview   # serve the production build locally
```

There is no separate lint step; `tsc --noEmit` runs in strict mode
(`noUnusedLocals`, `noUncheckedIndexedAccess`, etc.) as part of `build` and
is the source of truth for type/dead-code hygiene.

## Deployment

Every push to `main` (and manual `workflow_dispatch`) runs
`.github/workflows/deploy.yml`: `npm ci`, `npm test`, `npm run build`, then
publishes `dist/` to GitHub Pages via `actions/deploy-pages`. No manual
deploy step.

## Architecture

```
src/
  world/      Pure voxel data: BlockRegistry, Chunk (32^3 Uint8Array), World
              (sparse chunk map + bounds-aware get/set), coords math.
              No Three.js dependency — unit-testable in isolation.
  gen/        Procedural generation: deterministic seeded RNG (mulberry32 +
              fork()), 2D city-planning (roads/blocks/parcels/districts),
              building/bridge/walkway/park/shop-interior writers. Pure
              2D/3D math that writes into World, no Three.js.
  engine/     Three.js glue: Engine (renderer/scene/camera/fixed-timestep
              loop), ChunkRenderer + worker-pool ChunkMesher (budgeted per
              frame, sync fallback), Materials, Atmosphere (sky/fog/
              day-night), PostFX (bloom), EnvironmentProbe (wet-street
              reflections), Rain, neon animation, billboard atlas/layer.
  player/     Sandbox fly controller, first-person walk controller with
              AABB-vs-voxel collision + auto-step, mode switching, look
              controls, voxel raycasting.
  input/      Touch input: capability detection, floating-joystick math,
              tap-vs-drag gesture classification, and the DOM-free
              multi-touch controller (TouchInputController) that maps touch
              gestures onto the same WASD/look/click intent the keyboard and
              mouse paths already produce — player/ui/ controllers never
              know input came from touch. Pure logic + a thin real-DOM
              adapter (attachTouchInput), Three-free.
  entities/   NPC/vehicle simulation: pedestrian pathing (sidewalks, park
              paths, elevated walkway/skybridge decks with stair
              transitions), ground-vehicle lane flow, flying hover-car
              traffic in sky lanes, navigation grid, spawning.
  elevators/  Elevator-shaft scanning, car simulation, and the E/Q call
              interaction while a player stands in a shaft.
  audio/      Procedural ambient audio (rain bed, neon hum, distant traffic)
              synthesized entirely via WebAudio — no audio files. Mix curve
              (day-night + rain -> per-bus gain) and mute persistence are
              pure/unit-testable; graph-building takes an injected
              AudioContext-like port so it's testable without a real
              AudioContext. Autoplay-unlocked from the first click/keydown.
  io/         Serializer.ts — the `.vxc` binary export/import format. Pure
              data in/out (ArrayBuffer <-> World), no DOM/Three.js.
  ui/         Plain DOM overlays: Toolbar, Hud, Palette, ErrorToast,
              FpsCounter, TouchControlsUI (joystick visual + button bar). No
              game-logic knowledge; main.ts wires them to the engine/world.
  main.ts     Composition root: wires world/engine/gen/player/entities/
              elevators/io/ui/input together, owns the generation and
              import lifecycles.
```

See `PERF.md` for the chunk-meshing performance decisions (why there's no
greedy meshing, and how the worker pool is budgeted).

### Deterministic seeds

Every generator draws from a seeded `Rng` with `fork()` for independent
sub-streams, so the same seed always reproduces the same city — buildings,
bridges, shop interiors, NPC/vehicle spawns, billboard ad content — and
forking one sub-generator's stream never perturbs another's.

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
warning rather than failing the whole load.

All-air chunks are skipped on export (an imported city starts from an
all-air world, so there's nothing to write). Bad magic, an unsupported
format version, or a truncated/corrupt buffer all raise a typed
`SerializerError` with a clear message instead of crashing; the UI shows it
in a dismissable on-theme toast rather than `window.alert`.

## Key world decisions

- **World bounds**: 384 x 384 x 160 voxels, in 32^3 chunks. Sparse: a chunk
  only exists once something writes to it.
- **Rendering**: one mesh per chunk per material group (solid / road /
  lit-window / 4 neon channels), rebuilt on a per-frame budget through a
  worker pool so large edits or a fresh generation don't stall a frame —
  except right after `generateCity`/import, where every dirty chunk is
  flushed synchronously behind a loading overlay instead of dribbling in
  over dozens of frames.
- **Wet streets**: a one-shot `CubeCamera` -> PMREM environment map on the
  road material, refreshed after generation/import and (debounced) after
  edits — not a per-frame reflection technique.
