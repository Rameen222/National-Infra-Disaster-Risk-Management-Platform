# Flood Animation Metadata

Static raster-frame animation assets for the Kalpani River flood simulation,
consumed by the `/flood-simulation-vulnerability-v2` page (Animation mode).
Covers all 11 scenarios (matches Building Exposure mode's scenario list).

## Architecture chain

```
SFINCS model run (rerun_hmax)
  └─ sfincs_map.nc  (variable h, hourly time steps, UTM 43N grid,
                      one file per scenario)
       └─ scripts/kalpani_final/06_generate_animation_frames_png.py
            (run OFFLINE, once, per scenario): reads 'h' directly from the
            .nc, does the UTM->WebMercator nearest-neighbour warp + the
            scenario's fixed classified colour mapping, writes one plain
            PNG per frame (h_NNN.png) + manifest.json (grid, corners,
            render size, colour-scale breaks, per-frame time/depth stats).
                └─ Static files served from client/public/Data_2/Data_2_final/Animation/
                     └─ Front-end engine (animationEngine.js):
                          fetch (HTTP-cache warm only, no decode/warp/colour
                          work left to do) -> mapbox-gl image-source
                          updateImage -> timeline UI
```

No backend, database, or tile server is involved at runtime: the browser
fetches the static, pre-rendered PNGs directly. **Until 26 Aug 2026** this
last step instead shipped raw per-frame GeoTIFFs and did the warp + colour
classification live in the browser with geotiff.js + proj4 (once per frame,
every playthrough) - real, avoidable CPU cost on the main thread (visible as
playback stalling/stuttering). Moving it into this offline script removed
that cost entirely. The original 3-scenario version of this script read
from pre-existing `h_NNN.tif` files of unknown origin; the current version
reads directly from each scenario's own `rerun_hmax/scenarios/<scenario>/sfincs_map.nc`,
which is both simpler (one source of truth, no intermediate TIFF export
step) and how the 8 scenarios added on 27 Aug 2026 were done - so the .nc
files are the canonical source, not any TIFFs in this folder.

**hmax is NOT used for the animation.** The animation plays the hourly `h`
(water depth) frames. The per-scenario `<scenario>_hmax_peak.tif` files are
a *different, non-comparable* depth product, used only by the *static*
peak-depth layer in Building Exposure mode - do not compare their numbers
against this document's global peak depths.

## Scenarios

| Scenario                | Category                     | Frames | dt  | Global peak depth (h) |
|--------------------------|-------------------------------|-------:|-----|-----------------------:|
| event_2006               | Historical events              | 145    | 1 h | 11.371 m |
| event_2010               | Historical events              | 169    | 1 h | 26.590 m |
| design_T5                | Design storms + illustrative   | 97     | 1 h | 10.105 m |
| design_T10               | Design storms + illustrative   | 97     | 1 h | 11.324 m |
| design_T25               | Design storms + illustrative   | 97     | 1 h | 13.881 m |
| design_T50               | Design storms + illustrative   | 97     | 1 h | 16.027 m |
| design_T100              | Design storms + illustrative   | 97     | 1 h | 17.568 m |
| illustrative_25jul2011   | Design storms + illustrative   | 97     | 1 h | 9.015 m  |
| P50_ordinary             | Probabilistic                  | 97     | 1 h | 0.010 m  |
| P75_notable              | Probabilistic                  | 97     | 1 h | 0.612 m  |
| P90_moderate             | Probabilistic                  | 97     | 1 h | 4.362 m  |

- Grid (identical for every frame of every scenario, verified): width 697 x
  height 637, cell size 100 m, EPSG:32643 (UTM zone 43N).
- Geographic bbox (WGS84): `[71.717617, 34.007664, 72.493813, 34.599274]`.
- NoData: cells outside the SFINCS active-domain mask (`msk != 1`).
  Separately, depths below the 0.05 m **dry threshold** render transparent
  regardless of mask (see colour-scale policy below) - this is a display
  threshold, not the model's own nodata value.
- Frame naming: `h_%03d.png`, zero-based (`h_000.png` = first SFINCS output).
- Time axis comes **exclusively from the manifests**: frame N corresponds to
  SFINCS time step N (`hours` computed from the actual `time` coordinate,
  `time_iso` ISO-8601). Filenames are never used as a time source.

## Colour-scale policy (MUST remain fixed PER SCENARIO)

> The colour scale is FIXED per scenario and NEVER rescales between frames,
> during playback, or on scrubbing. Per-frame auto-stretching is
> intentionally not implemented anywhere in the rendering path.

**Updated 27 Aug 2026**: scales are now assigned per scenario, not per a
flat 2-group split, following this rule: every scenario in the same
category shares one **base** 5-class scale, sized to fit the smaller
members of that category. A scenario whose own peak is drastically larger
than its category-mates does not get an unrelated scale - it reuses the
exact same base breaks/colours for its lower range (so it stays genuinely
comparable to its group-mates at every depth they both reach), then
**extends forward** past the base scale's top break with 2 additional
classes in a second hue (purple), covering its own higher range. This
supersedes the 25 Aug 2026 two-group ("Group A" / "Group B") design.

Base ramp (5 classes, light -> dark blue):
`#c6dbef` `#6baed6` `#3182bd` `#08519c` `#08306b`

Extension ramp (appended only for scenarios that need it):
`#6a51a3` `#3f007d`

Every class renders at full opacity; only depths **below 0.05 m** are
transparent (no more reduced-opacity "very light" class - simplified from
the previous two-scale design).

**Calibration rule (learned the hard way - 27 Aug 2026):** a scale's last
break is the *floor* of its final, open-ended `>=` class, not a rounded
ceiling on the group's measured max. An earlier pass in this same update
set several top breaks essentially *at* each scenario's actual peak (e.g.
event_2010's top break at 26.6 against a measured peak of 26.59 m) - which
meant that peak fell 0.01 m short of ever qualifying for the class it was
supposed to represent, so the darkest colour silently never appeared
anywhere in that scenario's frames. Caught by checking actual pixel colour
counts in each scenario's own peak frame, not just by eyeballing the map.
Every top break below is now set with deliberate headroom below the
relevant peak(s).

**Historical events** - event_2006 is the base (fits its own 0-11.4 m
range, peak 11.37 m lands ~26% above the top break); event_2010 (2.3x
larger) shares those same 5 classes for any depth up to 9 m, then extends
with 2 more (peak 26.59 m lands ~21% above the top extension break):

| Class | Range (m)   | Colour     | Scenarios |
|-------|-------------|------------|-----------|
| dry   | < 0.05      | transparent | both |
| 1     | 0.05–0.5    | `#c6dbef` | both |
| 2     | 0.5–2       | `#6baed6` | both |
| 3     | 2–4         | `#3182bd` | both |
| 4     | 4–9         | `#08519c` | both |
| 5     | 9–15        | `#08306b` | both (event_2006 peak reaches here) |
| 6     | 15–22       | `#6a51a3` | event_2010 |
| 7     | >= 22       | `#3f007d` | event_2010 (peak reaches here) |

**Design storms + illustrative** - design_T5/T10/T25/T50/T100 and
illustrative_25jul2011 span only a ~2x range (9.0-17.6 m) as a group - not
drastic enough to need extension, so all six share one flat scale (top
break sits below T50/T100's peaks so they - and only they - reach the
darkest class):

| Class | Range (m) | Colour     |
|-------|-----------|------------|
| dry   | < 0.05    | transparent |
| 1     | 0.05–2    | `#c6dbef` |
| 2     | 2–6       | `#6baed6` |
| 3     | 6–10      | `#3182bd` |
| 4     | 10–14     | `#08519c` |
| 5     | >= 14     | `#08306b` (only design_T50/T100 reach this) |

**Probabilistic** - P50_ordinary and P75_notable share the base 5 classes
(top break sits below P75's own 0.6119 m peak); P90_moderate (7-436x
larger) extends with 2 more (peak 4.36 m lands well inside the final
class, ~74% above its floor):

| Class | Range (m)     | Colour     | Scenarios |
|-------|---------------|------------|-----------|
| dry   | < 0.05        | transparent | all |
| 1     | 0.05–0.1      | `#c6dbef` | all |
| 2     | 0.1–0.2       | `#6baed6` | all |
| 3     | 0.2–0.35      | `#3182bd` | all |
| 4     | 0.35–0.5      | `#08519c` | all |
| 5     | 0.5–1.0       | `#6a51a3` | P90_moderate |
| 6     | >= 1.0        | `#3f007d` | P90_moderate (peak reaches here) |

**P50_ordinary's own peak is 0.010 m** - below the 0.05 m dry threshold
everywhere, every frame. Its animation is expected to render fully
transparent throughout; this is the correct result for an "ordinary,
frequent" rainfall scenario, not a bug.

Verified post-generation by checking actual pixel colour counts in every
scenario's own peak frame (not just event_2010/P90_moderate): each
scenario's darkest reachable class has a non-zero pixel count in its peak
frame, except design_T5/T10/illustrative_25jul2011, whose own peaks
correctly fall short of the design-storm group's shared top break (they
are the smaller members of that group and are not meant to reach it).

See `animationEngine.js`'s `ANIM_DEPTH_SCALES` for the canonical values
(this file documents them, it is not the source of truth for the numbers -
the code, and `06_generate_animation_frames_png.py`'s `SCENARIO_BREAKS`
which must match it exactly, are).

## Runtime behaviour

- Each manifest carries its own `corners` (WGS84, TL/TR/BR/BL) computed by
  the generation script - identical across scenarios since they share one
  SFINCS grid, but no client-side proj4 warp is needed any more.
- `getFrame()` is a plain `fetch(url, {cache: 'force-cache'})` against the
  static PNG to warm the HTTP cache; there is no decode or colour work left
  to do in JS. Mapbox's own `source.updateImage({url})` does its own
  fetch+decode against that now-warm cache.
- Lookahead prefetch (scaled by playback speed) just fires more of those
  fetches - no concurrency cap is needed since none of it is CPU-bound.
- Scrubbing is token-guarded: only the newest requested frame is applied.
- The GL map instance is never recreated; frames swap through
  `source.updateImage({url})` on a single image source layered below the
  building extrusions.
- The scenario dropdown groups all 11 scenarios into the same three
  categories as the colour-scale policy (`ANIM_SCENARIO_GROUPS` in
  `animationEngine.js`), not the four-category grouping Building Exposure's
  own dropdown uses (which keeps "Illustrative" separate) - the two modes'
  groupings are allowed to differ since they're solving different problems
  (colour comparability vs. Building Exposure's per-scenario category
  scales).
- Building Exposure's flood-depth layer and building footprints are hidden
  from both the map and the right sidebar while Animation mode is active -
  the two modes' depth data (peak-per-scenario vs. hourly time series) are
  different quantities and are not meant to be viewed overlaid together.

## Known limitations

- Playback rate is a visual approximation of model time (600 ms/frame at 1x);
  use the timeline readout for exact simulation times.
- If `ANIM_DEPTH_SCALES` (breaks) or the base/extension ramp colours in
  `animationEngine.js` ever change, `06_generate_animation_frames_png.py`'s
  matching `SCENARIO_BREAKS` / `BASE_RAMP_RGB` / `EXTENSION_RAMP_RGB` must be
  updated and the script re-run for every affected scenario - the colours
  are baked into the PNGs, not computed at view time.
- event_2006 and event_2010 use real historical calendar dates for their
  time axis (2006-08-03, 2010-07-27); illustrative_25jul2011 uses
  2011-07-25; all design-storm and probabilistic scenarios use a synthetic
  2025-01-01 start (they aren't tied to a real event date).
