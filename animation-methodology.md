# Flood Animation Playback — Smoothing Methodology

## What This Solves

The flood-vulnerability-v2 animation (`/flood-simulation-vulnerability-v2`, Animation tab)
plays back hourly SFINCS water-depth frames (`h_NNN`, one GeoTIFF per simulated
hour) draped on the basemap. On load it stalled and stuttered during playback,
worst right when several frames finished loading around the same time.

```
BEFORE (stutters/stalls):
  Browser, per frame, every playthrough:
    fetch h_NNN.tif → geotiff.js decode → proj4 UTM→WebMercator warp
    → per-pixel JS colour classification → canvas.toDataURL() [SYNC, blocks UI]
    → mapbox-gl image-source.updateImage()

AFTER (smooth):
  Offline, once, at data-prep time:
    h_NNN.tif → warp + colour classification (Python/numpy) → h_NNN.png

  Browser, per frame, every playthrough:
    fetch h_NNN.png (HTTP-cache warm) → mapbox-gl image-source.updateImage()
```

Scope: `client/src/components/FloodVulnerabilityV2/animationEngine.js`,
`FloodVulnerabilityV2Page.jsx`, and the new
`scripts/kalpani_final/06_generate_animation_frames_png.py`. Three scenarios,
97–169 frames each (P90_moderate, design_T25, event_2010).

---

## Diagnostic process

The engine already had prefetching and an LRU cache, so the first step was
establishing *why* those weren't enough, before changing anything.

1. **Read the render path end to end** (`animationEngine.js`): each frame
   went through GeoTIFF decode → proj4 inverse-warp → a per-pixel JS colour
   loop → `canvas.toDataURL('image/png')`, then into a shared, reused
   `<canvas>` element.
2. **Identified `toDataURL()` as the primary suspect**: it's synchronous —
   the full PNG-deflate-compress-then-base64-encode pass runs on the main
   thread and can't be interrupted. For a ~1280×1000px classified-colour
   raster this is real, measurable work.
3. **Identified a compounding factor**: `prefetch()` fired every
   look-ahead frame (16–26 frames, scaled by playback speed) essentially at
   once. Their network fetches tended to resolve in a cluster, which meant
   several of these synchronous encode passes landed back-to-back in the
   same stretch of main-thread time — the actual mechanism behind the
   visible stalls.
4. **Verified the fix's constraints before writing it**, rather than
   guessing at the API: read mapbox-gl v3.3.0's own type definitions
   (`node_modules/mapbox-gl/dist/mapbox-gl.d.ts`) and confirmed
   `ImageSource.updateImage()` requires a **string** URL — it does not
   accept a raw `Canvas`/`ImageBitmap` in this version. That ruled out
   "just hand mapbox the canvas directly" and set the actual fix's shape:
   keep it a string URL, change how that string gets produced.
5. **Attempted live verification in-browser** before and after each change
   (dev server + browser preview tooling) to catch regressions from hot
   reload / console errors. The Mapbox basemap itself doesn't load in the
   sandboxed preview used for this work (no outbound request to
   `api.mapbox.com` — an environment restriction, not an app bug), so final
   playback confirmation was done by the user locally at each stage.

---

## Phase 1 — Stop blocking the main thread (client-side fix)

Applied first because it's the smallest, lowest-risk change that directly
targets the measured cause, without touching the data pipeline.

- **`canvas.toBlob()` instead of `canvas.toDataURL()`.** `toBlob` encodes
  without blocking the synchronous call stack; the result is wrapped in
  `URL.createObjectURL()`, still a plain string, so mapbox's `updateImage()`
  contract is unchanged.
- **A fresh `<canvas>` per frame, not the shared one.** This was a
  necessary side-effect of the previous change, not a stylistic one: with a
  *synchronous* encode, reusing one canvas was safe because nothing else
  could touch it mid-encode (JS is single-threaded). With an *asynchronous*
  encode and several frames decoding concurrently (prefetch), a shared
  canvas would let a later frame's `putImageData` overwrite the pixels
  before an earlier frame's `toBlob` callback read them back — silently
  mixing frames together. Each render now gets its own canvas; only the
  encode was ever the expensive part.
- **Capped `prefetch()` concurrency to 3 in-flight decodes**, instead of
  firing all look-ahead frames at once, so the CPU-bound decode+colourize
  work is spread out rather than bursting.
- **Explicit object-URL revocation** on LRU cache eviction (`URL.revokeObjectURL`), so the switch to blob URLs doesn't leak memory over a
  long playback session.

This phase reduced stutter but didn't eliminate the underlying cost: every
frame still required a live GeoTIFF decode + reprojection + colour
classification in the browser, at least once. A follow-up question — "why
is it decoding every time, shouldn't results be cached?" — surfaced that
the LRU cache (36 decoded bands / 16 rendered frames) was deliberately
small relative to the full sequence length (97–169 frames), so most of a
full playthrough beyond the first ~16 frames still missed cache and paid
the full cost again. That reframed the problem: the client was repeating
genuinely expensive, **input-invariant** work.

---

## Phase 2 — Move the invariant work offline (architectural fix)

The governing observation: the warp grid is identical across every frame of
every scenario (one SFINCS grid, confirmed in
`ANIMATION_METADATA.md`), and the colour scale is fixed per scenario group
by explicit design (`ANIM_DEPTH_SCALES` — documented as never rescaling
during playback or scrubbing). Neither input ever changes at view time, so
recomputing either one in the browser — repeatedly, per session — was pure
waste. The standard practice for this shape of problem (small, fixed
domain; a browser-side scientific decode/reprojection/classification
pipeline running on every view) is to do that work once, offline, and ship
the browser the cheapest possible asset.

**New script: `scripts/kalpani_final/06_generate_animation_frames_png.py`**

For each scenario, once:
1. Reads each `h_NNN.tif` frame (float32 depth, EPSG:32643).
2. Computes the UTM→WebMercator nearest-neighbour warp **once** (grid is
   shared across all three scenarios) — a direct full-resolution port of
   the same warp math `animationEngine.js` used to run per-frame in the
   browser (the browser version used a quarter-resolution shortcut purely
   for its own performance; running offline removes the need for that
   shortcut entirely).
3. Applies the exact same fixed classified colour scale the browser used
   to compute at runtime (`RAMP_RGB` / `ANIM_DEPTH_SCALES` values, ported
   1:1, with an explicit comment cross-referencing `animationEngine.js` so
   the two can't silently drift apart).
4. Writes a plain colourized PNG per frame, plus an updated `manifest.json`
   carrying the output image's WGS84 corners, render dimensions, and which
   colour-scale group was used.

Run once: generated all 363 frames (97 + 97 + 169) across the three
scenarios in one pass. Verified by opening a generated frame directly
(event_2010, hour 100) and confirming the result matches expected flood
physics — light dry watershed, visible channel network, a darker pooled
area at the downstream confluence.

**`animationEngine.js` rewrite**

With colour and geometry already baked into the shipped PNGs, the entire
client-side pipeline collapses:

- `geotiff.js` and `proj4` are no longer imported — nothing left for them
  to do.
- `getFrame()` is now a plain `fetch(url, {cache:'force-cache'})` against
  the static PNG, purely to warm the HTTP cache; mapbox's own
  `updateImage({url})` performs its own fetch+decode against that
  now-warm cache. There is no JS-side decode, warp, or colour work left on
  this path at all.
- `ensureWarper()` reads `coordinates` straight from the manifest instead
  of computing them from a probe TIFF.
- `prefetch()` no longer needs a concurrency cap — firing more plain
  network fetches costs nothing, unlike firing more CPU-bound colourize
  jobs (Phase 1's cap becomes moot, not wrong).

Net effect: the *first* playthrough of a scenario is now just image
fetches (no decode/warp/colourize cost at all, versus "expensive, but
capped and spread out" after Phase 1), and any *later* pass — replay, loop,
scrub backward past the old 16-frame cache window — costs nothing extra,
because there's no client-side computation left to repeat in the first
place. The cache-window limitation that motivated re-examining Phase 1
stops being a relevant constraint, rather than being solved by enlarging a
cache.

---

## Verification

- Ran the generation script end-to-end; confirmed frame counts on disk
  match each scenario's manifest (97 / 97 / 169) and file sizes are
  consistent with the originals (11–24 KB per frame — small, heavily
  compressible flood-depth rasters).
- Visually inspected a generated PNG directly against known flood
  behaviour for that scenario/hour.
- Confirmed the dev server serves the new manifests and PNGs correctly
  (`200 OK` on direct request).
- Confirmed the JS refactor hot-reloads with zero console/build errors.
- Live in-browser playback smoothness was confirmed by the user locally,
  since the sandboxed preview environment used during development cannot
  load the Mapbox basemap at all (no route to `api.mapbox.com`).

## What was deliberately not done

- **A tile server / COG pipeline** (titiler, GeoServer, WMS-T) — solves a
  scaling problem (many catchments, dynamic pan/zoom across resolutions, a
  shared multi-user backend) this dataset doesn't have at 697×637 px and
  three fixed scenarios.
- **A georeferenced video source** (mp4/webm via mapbox's native `video`
  type) — a legitimate pattern for much longer sequences, but its main
  strength (temporal compression) matters less here, and its main weakness
  (compression artefacts blurring hard classified-colour edges) actively
  fights the fixed classification scheme already in place. Left as a
  possible future experiment, not a needed fix.
- **SFINCS's own plotting/animation tooling** — suited to producing a
  canned GIF/MP4 for a report or briefing slide, not a substitute for an
  interactive, scrubbable, basemap-draped dashboard.
