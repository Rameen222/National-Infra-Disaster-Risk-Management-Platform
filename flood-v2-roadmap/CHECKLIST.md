# Flood Vulnerability V2 — Improvement Checklist

Living doc for the ISTECH/portal side of this work — mirrors the style of
`Kalpani_SFINCS_Checklist.md` on the modeling side (`C:\NDMA\FLOOD_SIMULATION_FINAL`),
but tracks a different scope: what the **portal** (this repo) does with the
model's output, not the model itself. Update this file as work happens —
mark items done, add evidence, don't rewrite history.

Status legend: `[x]` done · `[~]` in progress · `[ ]` planned

## Background — established facts, don't re-derive these

- **Depth (`hmax`) vs the model's own hourly output (`h`) disagree** on
  ~5% of ordinary cells but ~74% of currently-*exposed* buildings (>0.5m
  gap). `h` (and `zsmax − zb`, which matches `h` to within centimeters) now
  has real external validation (see below); native `hmax` has none, and its
  documented rationale ("biased HIGH from `z_zmin`") contradicts the
  direction actually observed everywhere. **Decision: keep native `hmax`
  for building-exposure classification for now** (switching to `zsmax−zb`
  would undo a deliberate fix for whole-cell overstatement made on the
  modeling side — see `Kalpani_SFINCS_Checklist.md` Stage 11) — but this
  is a live tension, not a closed question. The real fix is area-weighted
  footprint sampling on a *validated* depth variable, not picking between
  two coarse whole-cell options.
- **External validation done (never done before — closed a documented open
  item):** this model's own simulated discharge, computed from first
  principles (`Q = Σ(h·v·dx)` across a cross-section — SFINCS's promised
  `qx`/`qy` fields don't actually exist in the output despite
  `storefluxmax=1` being set, same "flag didn't materialize" pattern as
  `hmean`), lands within ~1–5% of Ullah et al. (2016)'s published gauge
  discharge at Chowki Bridge, Risalpur, for **both** historic events
  (2,173 vs 2,285 m³/s in 2006; 3,335 vs 3,361 m³/s in 2010). Upstream at
  Bughdada Bridge, Mardan, the model runs consistently 25–50% low against
  the one published 2006 figure (1,951 m³/s) — a real, open gap, location
  uncertainty aside. See `scripts/kalpani_final/11_external_discharge_validation.py`
  → `client/public/Data_2/Data_2_final/external_discharge_validation.json`.
- **Velocity had a confirmed data artifact**, now fixed (item 1 below).
- **Feature backlog and judgment on 7 colleague ideas + 4 added ones**:
  published assessment — [The Kalpani Bridge](https://claude.ai/code/artifact/1a96fbbd-c967-48ad-9fb7-9b2c83264b53).
  Items 1 and 6 (hazard zones, velocity fix) from that doc are items 1–2
  here. Item 5 (hypothetical building) is item 3 here.

---

## Item 1 — Fix the vmax data artifact `[x] done`

**Problem:** four scenarios (event_2010, design_T25/T50/T100) shared an
identical, suspiciously exact peak velocity of 14.142 m/s (=10√2).

**Root cause, confirmed:** the exact same grid cell — **row=347, col=614**
(≈34.3366°N, 72.3949°E) — in all four scenarios, where depth is only
8–10cm. A barely-wet cell reading faster than any real flood current,
at an identical value regardless of how much rain fell, is a numerical
artifact in the hydraulic solver at that specific mesh cell, not real flow.

**Fix applied** in `scripts/kalpani_final/08_generate_velocity_peak_raster.py`:
1. That exact cell is explicitly excluded (rendered transparent) in every
   scenario, not just the 4 where it happened to exceed the old max.
2. General safety net: any cell with vmax > 5 m/s in water shallower than
   0.3m is excluded the same way — that combination is the actual
   signature of this failure mode, not a threshold a real flood current
   would be expected to cross. Caught 7–227 additional cells per scenario
   (more in the more severe storms, as expected).

**Result:** domain peaks dropped from the corrupted 14.142 m/s to
4.7–8.1 m/s across scenarios — still allows genuinely fast, deep channel
flow through, only removes the shallow-and-impossible combination.

**Verify:** rerun 2026-08-30, all 11 scenarios, `velocity_manifest.json`
regenerated with a new `artifact_cells_masked` count per scenario.

---

## Item 2 — Combined depth+velocity hazard zones, 3 classes `[x] pipeline done` `[ ]` frontend wiring

**Formula:** UK Environment Agency / Defra "Flood Risks to People" hazard
rating (Ramsbottom et al., 2003) — `HR = depth × (velocity + 0.5) + DF`,
debris factor DF=0.5 (standard simplifying default, not measured for this
watershed — tune later if there's a real basis to).

**Why a fixed formula, not a per-scenario percentile:** a percentile of one
scenario's own distribution means something different every time (P90 of a
drizzle scenario ≠ P90 of T100 in real danger) — world practice for hazard
zoning is a fixed, physically-anchored scale applied identically everywhere.
See the "If you only sequence one way" section of the Kalpani Bridge doc.

**3 zones** (this project's simplified cut of the EA's usual 4-class scheme):

| Zone | HR | Meaning |
|---|---|---|
| Low | < 0.75 | caution |
| Moderate | 0.75–1.5 | dangerous for some (children, elderly, vehicles) |
| High | ≥ 1.5 | dangerous for most/all |

**Built on the corrected velocity** (item 1's artifact fix applied
identically here — a hazard layer built on the old contaminated vmax would
just relocate the same bug into a new layer).

**Output:** `scripts/kalpani_final/12_generate_hazard_zones.py` →
`client/public/Data_2/Data_2_final/rasters/<scenario>_hazard.png` +
`hazard_manifest.json` (zone area in km² per scenario). Zone areas scale
sensibly with storm severity (T5 → T100 low/mod/high: 197/59/35 →
337/151/85 km²) and are ~0 for P50/P75, as expected.

**Not yet done — next session:**
- [ ] Add a `hazard` layer toggle to `FloodVulnerabilityV2Page.jsx`
      (same image-source pattern as the existing depth/velocity layers).
- [ ] Building count per zone (ties into item 7 from the Kalpani Bridge
      doc — the draw-a-polygon feature already has the backend pattern in
      `pybackend/app.py`'s `/pyapi/buildings/count-in-geometry`).
- [ ] Decide whether DF=0.5 should vary (e.g. lower in open fields, higher
      in dense built-up areas using the LULC layer already loaded).

---

## Item 3 — Hypothetical building interior popup `[x]` built, prototyped and wired

**The ask:** double-click any real building on the map (any scenario, any
vulnerability category) → a large modal opens center-screen (closable) →
shows a cutaway/interior view of a representative building for that
category, with water rising to the depth that building's own `hmax` would
put it at, and a handful of visible assets that flip to "affected" once
the water reaches them.

**Feasibility: yes, and quickly — no 3D needed.** This reads as a big ask
but it's actually a 2D illustration problem, not a game-engine one:
- A flat/isometric SVG cross-section of a generic building interior
  (floor, a few racks/shelves/furniture, a door) — hand-authored, maybe
  2–4 hours for a decent one, since the composition is simple and reused
  across every building (only the water level and which assets are
  "affected" change per building/scenario).
- Water level = a single animated `<rect>` or clip-path rising to
  `(hmax at that building) / (a representative building height, e.g. 3m
  per floor)`, capped at the illustration's own height for anything
  taller than what's drawn.
- Each asset gets a `submergedAt` height; compare against current water
  level to swap its state (dry → wet → likely damaged icon/tint).
- Modal = a standard centered overlay, closable — no new library needed,
  a few dozen lines of CSS.

**No pre-built library does this specific thing** — "flood cutaway
building diagram" isn't a category anyone ships as a drop-in component.
What *does* exist and is worth reusing instead of drawing from scratch:
- Free flat-icon sets for the individual assets (racking, pallets, a
  generator, office furniture, machinery) — e.g. game-icons.net (CC-BY,
  free, huge selection) or Flaticon (free tier, check attribution terms
  per icon) — pull a handful of matching-style SVGs rather than drawing
  each asset by hand.
- No 3D asset needed and none recommended — a flat cutaway reads faster
  and takes a fraction of the build time.

**Recommended build order:**
1. [x] Picked warehouse as the representative building type; authored the
       interior SVG-icon asset list (racking, generator, desk, panel).
2. [x] Built `BuildingInteriorModal.jsx` + `.css` — water-level animation,
       per-asset dry/wet/submerged state, scaled to the building's own real
       `height` and `hmax` (not a fixed warehouse height).
3. [x] Wired the double-click handler on `fv2-buildings-fill` in
       `FloodVulnerabilityV2Page.jsx` — opens with that building's real
       properties for the active scenario; default double-click-zoom is
       disabled so it doesn't fire alongside the modal; closes automatically
       on scenario change (would otherwise show a stale depth).
4. [ ] (Later) more building types per category, once this one is validated
       against how it actually looks/feels in the app.

**Verify:** build passes clean. Not yet click-tested live in-browser (local
dev hit an unrelated React StrictMode double-map-instance quirk that made
automated clicking unreliable) — check by double-clicking a building in the
running portal.

---

## Item 4 — Realistic shaded-relief terrain layer `[x]` built and wired

**Originally added as a new, additional layer alongside the plain DEM and
Hillshade layers; those two were removed shortly after** (per direct
request, once terrain relief covers the same ground better) - terrain
relief is now this page's only terrain-context layer, on by default.
Derived entirely from `dem_watershed_30m.tif` (unmodified) - no satellite
imagery used to generate anything.

**Same root problem as the plain DEM layer, fixed the same way:** measured
from the real DEM (n=3,055,317 valid pixels) — 79% of pixels sit below
500m (the Mardan valley floor), the mountain fringe (~21% of pixels) spans
the remaining ~1,550m of the ~1,777m range. A linear stretch crams the
whole valley into a sliver of the ramp. Fixed with a percentile/CDF-based
hypsometric colour mapping (2048-bin histogram, computed fresh from the
file every run — never hardcoded), not equal-interval classification.

**Pipeline:** `scripts/kalpani_final/13_generate_terrain_relief.py`
1. Reads the DEM, computes percentiles (p0–p100) and a fine CDF.
2. Colours each pixel by its percentile RANK (not raw elevation) against a
   12-stop natural green→olive→tan→mountain-brown→blue-grey→pale-highlight
   ramp.
3. Hillshade via Horn's method (ESRI/GDAL-standard), primary 315°/42.5°,
   z-factor 1.0 (DEM is metres both axes, no exaggeration), native 30m
   cellsize, no resampling.
4. Combined relief additionally blends in 45°/135°/225° at low weight for a
   softer multidirectional look (per spec) — saved only in the combined
   product, not as its own file (the primary 315° hillshade is the file
   that gets saved standalone).
5. Colour + shading combined via an overlay blend, RE-CENTERED so a
   perfectly flat pixel (not an assumed 0.5) is the blend's true neutral
   point — otherwise the whole valley would incorrectly brighten under
   42.5°-altitude oblique lighting. Blend strength 0.4 (~40% "hillshade
   opacity").
6. NoData preserved exactly (alpha=0), same grid/extent/CRS as the source
   DEM throughout — no reprojection.

**Quality-checked visually** (color-only vs. hillshade-only vs. combined,
full-res crop of a mountain region + downsampled full-watershed preview)
before wiring in: fine drainage-channel texture visible in the valley
(the percentile fix working as intended), clear ridge/valley definition
and highlight/shadow in the mountains, natural tones throughout — not a
rainbow DEM, not a flat satellite look.

**Outputs** (same folder as the rest of this page's data):
`client/public/Data_2_final/terrain_color.tif` (colour only),
`terrain_hillshade.tif` (primary hillshade only),
`terrain_relief.tif` (final combined, RGBA — this is what the page loads),
`terrain_relief_cog.tif` (Cloud-Optimized GeoTIFF, not currently consumed
by the client but available if a tile-server path is ever wanted),
`terrain_relief_manifest.json` (corners, min/max, percentile ticks, colour
stops — feeds the legend).

**Frontend wiring** in `FloodVulnerabilityV2Page.jsx`:
- New `renderRgbaRaster()` — unlike the plain DEM path, this file arrives
  pre-coloured server-side, so this just warps/resamples the existing RGBA
  bytes, no per-pixel colour computation client-side.
- `terrainRelief` layer toggle, **on by default** since it's now the only
  terrain-context layer (the plain DEM/Hillshade layers it superseded have
  been removed), sitting below watershed/river/depth/buildings, at 100%
  opacity (raised from an initial 0.55 per direct request) — still matches
  the requested visual hierarchy (context layer, must not compete with flood
  depth).
- Legend (shown only when the layer is toggled on): reuses the same
  `.fv2-dem-legend`/`.fv2-dem-legend-ticks` styling as the plain DEM
  legend, but sourced from `terrain_relief_manifest.json`'s real
  percentile ticks and colour stops — not equally-spaced elevation values.

**Verify:** build passes clean. Not yet checked live in-browser (same
StrictMode double-map quirk as item 3) — toggle "Terrain relief" on in the
Layers panel to check.

**Follow-up tuning (same day):** DEM/Hillshade layers removed entirely per
direct request (terrain relief covers the same ground, better) - see
`layers` default state and the map-init effect. Palette also boosted in
saturation (×1.55) and value (×1.12) in HSV space, and hillshade blend
strength eased 0.4→0.32: at 100% layer opacity with no satellite basemap
diluting it, the original muted palette + grey hillshade overlay were
compounding into a visible grey cast across the (mostly flat) valley -
confirmed visually before/after with a downsampled full-watershed render.
Legend colours regenerated from the same boosted values, not the pre-boost
palette.

---

## Item 5 — Exposure dock redesign: gated on category, tabbed, gauges `[x]` built

**New component:** `ExposureDock.jsx` + `.css`, replacing the always-visible
bottom "Scenario comparison" dock. Per direct request:

- **Only renders when a vulnerability category is selected** (clicking
  Low/Moderate/High/Very High in the left sidebar's building legend, the
  same `browseClass` state that already drove the severity-browse
  "clicker" widget) - previously always visible in Building Exposure mode
  regardless of any selection.
- **Tab bar at the bottom** of the panel (not the top) with two tabs:
  - **"Exposure summary"** (default): a big number coloured to the
    selected category, showing that category's building count for the
    active scenario ("X of Y total buildings"); below it, two semicircle
    gauges - one segmented by ALL 5 categories (a semicircular version of
    the existing stacked impact bar), one showing flooded area (km²,
    summed from `hazard_manifest.json`'s per-scenario zone areas - the
    hazard-zone pipeline from item 2, only now actually wired into the
    frontend) against the watershed's total catchment area (2,765.9 km²,
    already documented on the modeling side).
  - **"Compare scenarios"**: the original bar chart + scenario cards,
    unchanged except the "Source: rerun_hmax delivery..." footnote line
    was removed per direct request.

**Real bug found and fixed before wiring in:** the segmented gauge's
stroke-dasharray/dashoffset math initially reused the same formula as the
single-value gauge (`dashoffset = half - cursor`, `gap = half`) - that
formula only happens to work when dash length equals the full path length
(the single-value case). With segments of genuinely different lengths, the
gap wasn't large enough to prevent the dash pattern from wrapping around
within one traversal of the path, silently misplacing every segment after
the first two. Caught by rendering a standalone static SVG test (real
values, no React) via the dev server before trusting it in the actual
component - fixed by using a gap several times larger than the path length
(`period = segLen + GAP`, `offset = period - cursor`), verified correct
against the same test before applying the fix for real.

**Verify:** build passes clean; gauge geometry independently verified via a
standalone static-SVG render (both the single-value and segmented formulas),
not just by reading the code. Not yet checked inside the actual running app
(same StrictMode double-map quirk as items 3/4) - click a vulnerability
category in the left sidebar to check the real thing.

---

## Item 6 — School–building spatial join `[x]` done `[ ]` frontend wiring

**Goal:** every building in `buildings-impact/` (379,371 features across all
11 scenarios) carries a `has_school` flag and, when a school is nearby, the
school's `Sno`, `Schoolname`, and `UCName`.

**Source schools:** `public/infra/schools.geojson` (all Pakistan) → cropped to
the Kalpani watershed → **3,626** schools total. Of these:
- 882 are empty coordinate-only rows (no Sno/name/UC) → blank join columns.
- 507 fall outside all building coverage → not joined.
- **3,119** are within building tile coverage → joined to buildings.

**Assignment rule:**
1. If school point falls inside a building polygon → that building.
2. Otherwise → nearest building centroid within the same tile (projected to
   EPSG:3857 for distance).

**Columns added** (to every building, all 11 scenario folders):

| Column | Value |
|---|---|
| `Sno` | school serial number(s), `;`-separated if multiple, blank if none |
| `Schoolname` | school name(s), `;`-separated, blank if none |
| `UCName` | union council name(s), `;`-separated, blank if none |
| `has_school` | `1` if any school assigned, `0` otherwise |

**Display convention (frontend):** blank `Sno`/`Schoolname`/`UCName` → display
as `-` (dash), never as empty.

**Cross-validated:** independent shapely-based re-implementation on 15 random
tiles (13,899 buildings) confirmed 0 mismatches in the geometry assignment.
`has_school` consistent with `Sno != ""` across all 292,160 buildings in a
60-file sample.

**Verified:** 0 mismatches in `has_school` vs `Sno != ""` across all tested
buildings. Geometries preserved, identical across all 11 scenarios.

**Next:**
- [ ] Wire `has_school` into the GLB picker: `1` → classroom, `0` → house
      (replaces click-counter alternation; see `HANDOFF_MARDAN.md` §4 item 7).
- [ ] Show `Schoolname` / `Sno` / `UCName` in the viewer info panel when a
      school building is clicked (see `HANDOFF_MARDAN.md` §4 item 8).
