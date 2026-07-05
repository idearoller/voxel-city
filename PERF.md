# Meshing perf: measurement + the greedy-meshing decision

Phase 2 Task 6 asked for a perf measurement pass and an explicit decision on
whether greedy meshing (merging coplanar same-color faces into fewer, larger
quads) is warranted, or whether the existing naive culled mesher
(`src/engine/ChunkMesher.ts`) is good enough. This documents both.

**Correction #2 (Task 30, post-incident):** the "in-frustum triangles" section
below assumed Three.js's per-mesh frustum culling was already limiting what
got rendered to roughly the fog-visible radius. That's wrong: frustum culling
only checks a mesh's bounding sphere against the camera's view *volume* — fog
tints pixels in the fragment shader, it never removes a mesh from the frustum
test. Looking across the 384×384 city (diagonal ≈543, comfortably inside the
600-unit far plane) put essentially all ~274 allocated chunk meshes in the
frustum simultaneously: ~4.95M non-indexed triangles, ~530MB of vertex
buffers, every frame. That's what caused the reported real-world symptom —
sustained 100% GPU / thermal throttling within about a minute on an
integrated-GPU MacBook — and it's why the ~24-chunk/~433K-triangle estimate
below was never actually true in practice; it was a description of what
*should* be visible, not what the renderer was culling.

**Note (Task 33):** "non-indexed" and "~530MB" above describe the mesher as
it stood at Task 30. Task 33 (see the section near the end of this file)
switched to indexed geometry, cutting that resident figure by roughly a
quarter to a third depending on index width — the number is left as
originally measured here since it's what caused and characterizes the Task
30 incident being documented, not a claim about current memory use.

The fix (`src/engine/ChunkVisibility.ts` + `ChunkRenderer.update()`) adds an
explicit, fog-aware distance cull: every allocated chunk's nearest point to
the camera is checked each frame against `CULL_RADIUS`, and chunks beyond it
get every one of their material-group meshes (solid/road/windowLit/neon) set
`.visible = false`. This is what makes the estimate below (roughly) true now,
rather than aspirational.

`CULL_RADIUS` is derived, not guessed: solving Three.js's `FogExp2` term
(`fogFactor = 1 - exp(-(density·distance)²)`) for the distance where
`density·distance = √3` (fogFactor ≈ 0.95, the same "visually flattened"
threshold used below) at `MIN_FOG_DENSITY` — the *thinner* of the day/night
fog presets (`dayNight.ts`'s `DAY`, 0.009, not `NIGHT`'s 0.012) because
thinner fog is the case where something stays visible longest, and the cull
has to stay safe there too — gives `CULL_RADIUS = √3 / 0.009 ≈ 192u`. Tying
the constant directly to `MIN_FOG_DENSITY` (rather than hardcoding ~192)
means the two can't silently drift apart if the fog presets change later.

`EnvironmentProbe`'s wet-street reflection capture renders from its own fixed
position near the city center, not the player's camera, so player-distance
culling could wrongly hide a chunk that belongs in that reflection;
`ChunkRenderer.setAllChunksVisible()` forces everything visible for that one
capture (`main.ts`'s `refreshEnvironmentProbe`), and the next regular
`update()` call restores normal culling before the next real frame draws —
the probe capture is comparatively rare (debounced/edit-count-gated), so this
costs nothing meaningful.

Pixel ratio is also now clamped to 1.5 instead of 2 (`Engine.ts`) — on a
retina display that's ~2.25x the CSS pixel count through the full
`EffectComposer` chain instead of ~4x, a further ~44% fill-rate cut on the
same integrated-GPU hardware. Bloom (`PostFX.ts`) already dominates the final
look and masks aliasing, so the lower render resolution isn't perceptible.

**Correction (post-review):** an earlier version of this document rebutted
greedy meshing on mesh *build* time and draw-call count. Both are true facts
but the wrong axis — build time is a one-time, off-main-thread cost
regardless of mesher; draw calls are already flat (one shared material per
group) regardless of triangle count. What greedy meshing actually buys is
fewer triangles *rendered per frame* — a render-throughput question. That's
the analysis below.

## Measurement

`test/MesherPerf.test.ts` generates a full representative city
(`generateCity(world, 'perf-harness-01')`, the same pipeline `main.ts` runs)
and meshes every chunk it allocates with the exact same
`buildChunkSnapshot` + `buildChunkMeshDataFromSnapshot` pair the worker pool
runs per chunk in production (see `MesherScheduler.buildRequest` /
`mesherWorker.ts`). Run via `npm test -- test/MesherPerf.test.ts`.

```
chunks=274 totalTriangles=4,946,490 totalMs=6957.1 (single-threaded)
avgMs/chunk=25.4 avgTriangles/chunk=18,053
```

(`totalTriangles` is the confirmed-exact number for this seed; `totalMs` is
this test's own single-threaded worst case, not a production figure — see
"build time" below.)

## What actually matters for greedy meshing: in-frustum triangles per frame

274 chunks is the *whole allocated city*, not what's on screen at once.
Three.js's default per-mesh frustum culling drops chunk meshes outside the
camera's view *volume*, but that alone is not enough — a 384×384 city (diagonal
≈543) fits almost entirely inside the 600-unit far plane, so frustum culling
alone leaves nearly everything in view when looking across town. The
distance cull described above (Task 30, `ChunkVisibility.ts`) is what
actually bounds the *fog-visible* subset described next; without it, this
section's "~24 chunks" estimate was aspirational, not real (see Correction #2
above).

Estimating that slice, from real engine constants:
- `CULL_RADIUS` (`ChunkVisibility.ts`, derived from `MIN_FOG_DENSITY` —
  `dayNight.ts`'s `DAY` preset, 0.009, the thinner of the two fog presets)
  is ≈192 world units — well inside the camera's 600-unit far plane
  (`Engine.ts`).
- Camera FOV is 70° (`Engine.ts`); treating the visible ground footprint as
  a ~70°-wide sector of radius 192 gives an area of
  `π · 192² · (70/360) ≈ 22,500` square units.
- The full city plan is 384×384 = 147,456 square units, so that sector is
  about **15.3%** of the city footprint.
- Applying that fraction to the 274 allocated chunks (a rough proxy, since
  chunks stack vertically over a given footprint too — this likely
  *overstates* true in-frustum chunk count, since it ignores that a lot of
  footprint area is empty street/sidewalk with far fewer stacked chunks
  than a dense downtown block) gives **~42 chunks**, or
  `42 × 18,053 ≈ 758,000` triangles in frustum on a representative frame —
  before any further culling from buildings occluding each other (this
  engine has no occlusion culling, so this is if anything an over-count).
  Unlike the estimate this superseded, this figure is now actually enforced
  at render time by the distance cull, not just a hoped-for consequence of
  frustum culling.

**Desktop GPU throughput vs. that slice:** even a modest integrated GPU
sustains vertex throughput in the hundreds of millions to low billions of
triangles/second; a dedicated desktop GPU is another order of magnitude up.
Rendering ~758K triangles at 60fps needs ~45M triangles/sec of sustained
throughput — roughly 1-2 orders of magnitude under what any GPU from the
last decade provides, leaving enormous headroom for the half-res
`UnrealBloomPass` (`PostFX.ts`), which competes for pixel fill-rate and
bandwidth, not vertex/triangle throughput, so it doesn't erode this margin.
Greedy meshing's entire value proposition is cutting that in-frustum
triangle count further; there's no throughput problem here for it to solve.

**Build time, for completeness (a different axis, not why greedy is
skipped):** the ~7s single-threaded total above is *not* what ships —
`PooledMesherScheduler` already streams every job through up to 4
concurrent `Worker`s, once, during `runGeneration`/`importCity`, behind the
"GENERATING SECTOR…" loading overlay. Steady-state 60fps gameplay never
re-meshes anything except the handful of chunks bordering an actual edit
(`APPLY_BUDGET_PER_FRAME` = 4/frame). This was the prior version's
argument; it's true, but it defends build time, not frame throughput, so it
doesn't actually settle whether greedy is warranted on its own.

## Decision: greedy meshing is NOT warranted

1. **Per-frame triangle throughput has a wide margin** (above): the
   in-frustum slice is a small fraction of the desktop GPU budget even
   before greedy meshing's reduction, so there's no rendering bottleneck
   for it to fix.
2. **Greedy meshing would complicate exactly the things phase 1 chose
   naive meshing to keep simple**: per-vertex baked AO and per-voxel vertex
   color (road wet-tint, window lit/dark) both assume one quad = one voxel
   face; merging faces means either giving up per-voxel color/AO fidelity
   or carrying extra per-merged-quad attribute bookkeeping to preserve it —
   real implementation cost to buy back headroom the desktop target doesn't
   need.

`meshChunk`'s signature was kept greedy-ready from M1 (`gen/CityGenerator`
plan doc: "Greedy = drop-in later behind the same `meshChunk()` signature")
specifically so this remains a cheap decision to revisit — e.g. if a future
mobile/low-end-GPU target changes the throughput margin above, or if a
denser building style pushes the frustum estimate up materially. Desktop,
today, it doesn't.

## Task 31: capping fixed-timestep catch-up steps per frame

Task 30 fixed the steady-state GPU load that was thermal-throttling the
reporter's MacBook. That throttling had a second-order effect on the sim
side that hadn't been addressed: `Engine.tick`'s fixed-timestep accumulator
loop (`while (accumulator >= FIXED_TIMESTEP) update(...)`) had no cap on how
many catch-up steps it would run in a single rendered frame, only a clamp on
the raw per-frame delta fed into the accumulator (`MAX_FRAME_DELTA = 0.25s`,
i.e. up to `0.25 / (1/60) = 15` steps). Once rendering itself slows down —
from thermal throttling, a GC pause, or the tab regaining focus after being
backgrounded — the sim starts paying that backlog back at up to 15×
`update()` calls per frame (elevator sim, collision, atmosphere, rain, full
entity simulation including spawner scans, audio mix). That extra CPU work
compounds the very slowdown that created the backlog: steady state under
throttle was 15 steps every frame at ~4fps, CPU pegged alongside the GPU,
machine effectively seized.

**Decision: cap catch-up at `MAX_STEPS_PER_FRAME = 4` steps/frame, and drop
any backlog beyond the cap instead of carrying it.** Bounding steps directly
bounds worst-case sim CPU per frame (4x steady-state cost, not 15x)
regardless of how large a single frame's elapsed time gets, which makes the
separate `MAX_FRAME_DELTA` delta-clamp redundant — it's been removed in
favor of the step cap so there's exactly one mechanism controlling catch-up
work, not two that could silently drift out of sync. When the cap is hit,
the accumulator resets to 0 rather than keeping the true (much larger)
remainder: carrying it would just defer the same 4-step catch-up burst,
forever, to every subsequent frame for as long as the overload lasts. Under
sustained overload the game clock falls behind wall-clock time — the world
runs in slow motion — rather than CPU usage spiraling. For a single-player
sandbox game, a slower clock is the correct tradeoff against a seized
machine; there's no multiplayer lockstep or replay-determinism requirement
here that a lagging clock would break.

The accumulator arithmetic was extracted into a pure function,
`computeFixedSteps` (`src/engine/FixedTimestep.ts`), specifically so it's
unit-testable — `Engine.ts` itself has no tests because it needs a real
`window`/WebGL context (see its class doc comment), so this was the way to
put real coverage on the cap: `test/FixedTimestep.test.ts` covers dt smaller
than one step (0 steps, full carry), an exact multiple of steps, a
sub-step remainder alongside whole steps, accumulating leftover across
frames, hitting the cap exactly (no drop), and exceeding it (steps clamped
to the cap, accumulator dropped to 0 and not carried into the next frame's
computation).

## Task 32: cutting steady-state per-tick CPU/GC churn

With tasks 30/31 gone, what was left was smaller, everywhere costs rather
than one dominant one: a citywide scan and a stream of small per-tick
allocations and no-op WebAudio automation events, all running forever at
the fixed tick rate regardless of what's actually changed.

**Spawner elevated-cell scan (`Spawner.ts`'s `pickElevatedSpawnCell`).**
Every pedestrian spawn attempt (while under the 120-pedestrian cap) used to
filter *every* elevated deck cell citywide against the current spawn
annulus — up to 20,000+ cells for a single tower's lobby flood alone (see
`NavGrid.MAX_LOBBY_FLOOD_CELLS_PER_TOWER`) — building a fresh filtered array
per level, every tick. Worse, this ran *before* the 30% elevated-share roll,
so ~70% of attempts computed the whole scan and threw it away unused. Fixed
two ways: (1) the share roll now runs first, so a miss skips the scan
entirely; (2) the scan itself no longer touches every cell — `Spawner.ts`
lazily builds and caches (per `NavGrid` instance, via `WeakMap`) a coarse
spatial index over each elevated level's cells (32-unit buckets), and
`elevatedCellsNear` (newly exported) queries only the handful of buckets
overlapping the spawn radius. Query cost now scales with the query radius,
not city size. `test/Spawner.test.ts`'s `elevatedCellsNear` suite builds a
~40,000-cell synthetic citywide level and asserts the query returns a small
bounded subset (not the whole list) while still finding genuinely nearby
cells — a revert back to a full `.filter()` over `level.cells` would fail
the boundedness assertion.

**Per-frame scratch allocations.** Three small, high-frequency allocations
hoisted to reused scratch fields/module state, each previously allocated
fresh every call:
- `EntityRenderer.updateVehicles` allocated a `THREE.Vector3` per ground
  vehicle per render frame (~2400 allocs/s at the 40-vehicle cap, 60fps) —
  now a single reused `vehicleForwardScratch` instance field.
- `LookControls.applyDelta` allocated a `THREE.Euler` per mousemove event —
  now a reused `eulerScratch` instance field.
- `Atmosphere` called `interpolateAtmosphere` (a fresh 10-field object) up
  to 3x/tick: once internally (`applyTimeOfDay`) and twice more via the
  `nightFactor` getter (`main.ts`'s rain and billboard-layer update calls).
  `nightFactor` now reads `starOpacity` off the result `applyTimeOfDay`
  already cached, cutting 3 allocations/tick to 1. `test/Atmosphere.test.ts`
  spies on `dayNight.interpolateAtmosphere` and asserts reading `nightFactor`
  repeatedly issues no further calls beyond the one `setTimeOfDay` made.
- `Vehicle.ts`'s `laneKey`/`applyVehicleFollowSpacing` (string lane keys,
  rebuilt into a fresh array every tick) was reviewed but left as-is: at
  ≤40 vehicles this is a few dozen small string concats and one short-lived
  array per tick, well below the threshold where restructuring
  `LaneMember`/`computeFollowOrder` away from string keys would be worth the
  readability cost.

**Audio param ramp spam (`AudioSystem.update`, `FlybyGraph.update`).** Both
issued `setTargetAtTime` every tick regardless of whether the target value
had actually changed — ~900 automation events/s combined once several
flyby voices are active, forever. `setTargetAtTime` is an exponential
*approach*, so re-issuing the same target is an inaudible no-op; the fix
(`src/audio/rampCache.ts`'s `RampTargetCache`) tracks the last target each
param was actually *issued* (not its current, possibly-still-ramping
value) and skips re-issuing within a small epsilon, per param, so a target
that's genuinely still changing is never frozen mid-ramp — only true
repeats are elided. Used by both `AudioSystem.update` (3 bus gains) and
`FlybyVoicePool.update` (gain/pan/filter per voice). Covered by
`test/audio/rampCache.test.ts` (the cache in isolation, including the
"compares against last-issued, not a running current value" invariant) and
revert-probe tests in `AudioSystem.test.ts`/`FlybyGraph.test.ts` that drive
identical state across several ticks and assert no additional
`setTargetAtTimeCalls` are recorded on the fake context, then confirm a
genuine change still issues one.

## Task 33: indexed chunk geometry

Tasks 30-32 addressed steady-state GPU/CPU load; this task cuts resident
vertex memory instead — the ~530MB figure from Task 30's incident writeup
(above) came from `ChunkGeometryBuilder` never calling `setIndex`: every
quad face emitted 6 flat (non-indexed) vertices for its 2 triangles, with no
reuse even between the 2 triangles of the *same* quad, which share 2 of
their 3 vertices by construction.

**Change:** `ChunkMesher.buildChunkMeshDataFromSnapshot` now emits 4 unique
vertices per exposed face plus 6 indices (`[0,1,2, 0,2,3]`, relative to that
face's own 4-vertex block) describing its 2 triangles, per material group.
Vertices are still never shared *across* faces — each face bakes its own
AO levels and flat normal, so a shared vertex would average/overwrite one
face's shading with its neighbor's — only the 2 co-planar triangles of one
quad share vertices. `ChunkGeometryBuilder.buffersToGeometry` now calls
`geometry.setIndex(...)`; disposal is unaffected (`THREE.BufferGeometry
.dispose()` already tears down the index attribute alongside position/
normal/color — `ChunkRenderer.disposeChunk` was never disposing attributes
individually, so no change was needed there).

**Index type: `Uint16Array` or `Uint32Array`, chosen per material-group
buffer from its actual vertex count** (`ChunkMesher.groupToBuffers`, see
`MAX_UINT16_VERTEX_COUNT`'s doc comment). A chunk is 32^3 = 32,768 voxels;
the worst case for a *single* material group is every voxel solid, arranged
so every one of its 6 faces is exposed (a 3D-checkerboard fill where every
solid voxel's axis-neighbors are all air) — half the chunk's voxels
(16,384) x 6 faces x 4 unique vertices = 393,216 vertices in one group, over
6x past `Uint16Array`'s 65,535-index ceiling. That's an unlikely shape for
real generated-city content but a legitimate reachable state of this data
structure — nothing upstream rules it out — so picking `Uint16Array`
unconditionally would silently corrupt rendering on a dense-enough chunk
(indices wrapping mod 65,536, i.e. some triangles pointing at the wrong
vertex data entirely). Picking `Uint32Array` unconditionally would instead
give up half the index-buffer memory saving on every ordinary chunk, for a
case that in practice essentially never happens. `test/ChunkMesher.test.ts`
covers both sides of the cutover: a synthetic checkerboard-filled chunk
(393,216 vertices) asserts `Uint32Array` and checks every index still
resolves to a real vertex; an ordinary single-voxel chunk asserts
`Uint16Array`.

**Proving rendering is unchanged.** A vertex-count drop alone doesn't prove
equivalence — it would pass even if winding flipped, an AO level landed on
the wrong corner, or a face were silently dropped along with its now-unused
vertices. `test/ChunkMesherIndexingEquivalence.test.ts` keeps a frozen,
test-only copy of the pre-Task-33 non-indexed emission (verbatim `FACES`
table, corner-AO math, shading — duplicated rather than re-imported, so it's
immune to any future edit to the real mesher) and, for a representative
sample of chunks from a real `generateCity` output plus the pathological
checkerboard chunk, de-indexes the current mesher's output back into
triangles and asserts the two triangle *sets* are identical: same count,
same members, each triangle's own winding order and per-vertex position/
normal/color preserved exactly (no epsilon), compared order-independently
across the group (chunk/group iteration order was never semantically
meaningful). `test/MesherScheduler.test.ts`'s existing worker/sync parity
test and `test/ChunkMesher.test.ts`'s face-culling/AO suites were updated
for the new 4-verts-per-face/index-buffer shape rather than left asserting
the old 6-verts-per-face layout.

**Memory math**, using this seed's measured `totalTriangles=4,946,998`
(`MesherPerf.test.ts`; faces = triangles / 2, since every face is exactly 2
triangles):

- Per-vertex attribute cost is unchanged: position + normal + color = 3+3+3
  floats x 4 bytes = 36 bytes/vertex, whichever mesher emits it.
- **Before:** 6 non-indexed vertices/face, no index buffer.
  `4,946,998 x 3 vertices x 36 bytes ≈ 534.3MB` (matches the ~530MB Task 30
  figure).
- **After:** 4 unique vertices/face + 6 indices/face.
  Vertex buffers: `(4,946,998 / 2) x 4 vertices x 36 bytes ≈ 356.2MB` — a
  33.3% cut, exactly the 6-to-4 vertex-count ratio, as expected since
  per-vertex cost didn't change.
  Index buffers (typical real-city case, `Uint16Array`):
  `4,946,998 x 3 indices x 2 bytes ≈ 29.7MB`.
  **Total ≈ 386MB, down from ≈534MB — a ~27.7% cut** in resident chunk
  geometry memory citywide. (The worst-case all-`Uint32Array` city would
  still total `356.2MB + 59.4MB ≈ 415.6MB`, a ~22% cut — still a net win
  even if every chunk happened to hit the checkerboard-pathological case,
  which real generated cities don't.)

This is a pure memory/bandwidth win, not a triangle-throughput one — the
"Decision: greedy meshing is NOT warranted" analysis above is about
in-frustum *triangle* count, which indexing doesn't change (same 2
triangles per face either way), so that decision stands unaffected.
