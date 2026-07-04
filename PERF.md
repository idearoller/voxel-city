# Meshing perf: measurement + the greedy-meshing decision

Phase 2 Task 6 asked for a perf measurement pass and an explicit decision on
whether greedy meshing (merging coplanar same-color faces into fewer, larger
quads) is warranted, or whether the existing naive culled mesher
(`src/engine/ChunkMesher.ts`) is good enough. This documents both.

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
Three.js's default per-mesh frustum culling (see the phase-1 plan's
performance posture note) already drops every chunk mesh outside the
camera's view volume before rasterization — the relevant number for 60fps
render throughput is the triangle count still *inside* the frustum on a
typical frame, not the city total.

Estimating that slice, from real engine constants:
- `Atmosphere`'s night fog (`FogExp2` density 0.012, the default/common
  case per `dayNight.ts`) visually flattens detail past roughly
  `sqrt(3) / density ≈ 144` world units — well inside the camera's 600-unit
  far plane (`Engine.ts`), so effective *useful* view radius is fog-bound,
  not far-plane-bound.
- Camera FOV is 70° (`Engine.ts`); treating the visible ground footprint as
  a ~70°-wide sector of radius 144 gives an area of
  `π · 144² · (70/360) ≈ 12,650` square units.
- The full city plan is 384×384 = 147,456 square units, so that sector is
  about **8.6%** of the city footprint.
- Applying that fraction to the 274 allocated chunks (a rough proxy, since
  chunks stack vertically over a given footprint too — this likely
  *overstates* true in-frustum chunk count, since it ignores that a lot of
  footprint area is empty street/sidewalk with far fewer stacked chunks
  than a dense downtown block) gives **~24 chunks**, or
  `24 × 18,053 ≈ 433,000` triangles in frustum on a representative frame —
  before any further culling from buildings occluding each other (this
  engine has no occlusion culling, so this is if anything an over-count).

**Desktop GPU throughput vs. that slice:** even a modest integrated GPU
sustains vertex throughput in the hundreds of millions to low billions of
triangles/second; a dedicated desktop GPU is another order of magnitude up.
Rendering ~433K triangles at 60fps needs ~26M triangles/sec of sustained
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
