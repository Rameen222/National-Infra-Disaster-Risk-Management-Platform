# Kalpani buildings — per-building flood depth & vulnerability classes (rerun hmax, all 11 scenarios)

Generated 24 Aug 2026 from `rerun_hmax\scenarios\` — the SFINCS rerun that wrote **native
depth output** (`hmax`, `storehsubgrid=1`). This replaces the morning's
`..\..\buildings_flood_vulnerability\` output, which was built on `zsmax`-derived depths;
**no zsmax-derived column (`hmax30_*_m`, `ratio_*`, `vuln_class_*`) is carried over here.**

Source buildings: `C:\Users\ramee\Downloads\buildings_mardan_watershed_original.geojson`
(read-only, untouched — same size/mtime as before the run). This folder is the copy with
values added; all 379,371 buildings are included.

## Method (mardan_v5_copernicus_30m recipe)

1. Per scenario, peak depth = `nanmax(hmax)` over **all** `timemax` bands of
   `sfincs_map.nc` (bands are daily maxima; event runs have more bands than design runs).
2. Written as GeoTIFF exactly like v5's `sfincs_hmax_to_geotiff.py`: affine transform
   derived from the `corner_x/corner_y` node coordinates, flipped north-up, native 100 m
   grid, EPSG:32643 (identical grid across all 11 scenarios — verified).
3. Dry/inactive cells (NaN) set to **0**, so they count as zero depth inside a footprint
   (v5 convention: "dry cells counted as 0"). Kept as provenance in `rasters\`.
4. Each building's depth = **exactextract area-weighted mean** of the raster over its
   actual footprint polygon (true polygon/pixel intersection coverage weighting, not a
   centroid lookup). Verified independently by recomputing sample buildings with a pure
   shapely-overlay clip straight from the .nc — exact match to stored precision.

## Class scheme (user-specified)

`flood_class_<scenario>` uses the weighted mean depth (`hmax_peak_<scenario>_m`) and its
ratio to building height (`submersion_pct_<scenario>` = depth ÷ `height` × 100):

| class | rule |
|---|---|
| `no_exposure` | depth < 0.7 m |
| `low_vulnerability` | depth ≥ 0.7 m and submersion < 30 % |
| `moderate_vulnerability` | submersion 30–<60 % |
| `high_vulnerability` | submersion 60–<100 % |
| `very_high_vulnerability` | submersion ≥ 100 % (fully submerged) |

Stored values are self-consistent: classes/pct derive from the *rounded* stored depth,
so re-deriving them from the files reproduces every row exactly (asserted for all 11
scenarios).

## Columns

Original columns kept as-is: `source`, `id`, `height`, `var`, `region`, `bbox`, `name`.

Per scenario (11×): `hmax_peak_<scen>_m`, `submersion_pct_<scen>`,
`flood_class_<scen>`, where `<scen>` ∈ event_2006, event_2010, illustrative_25jul2011,
P50_ordinary, P75_notable, P90_moderate, design_T5/T10/T25/T50/T100.

## Files

- `buildings_mardan_watershed_hmax_part01of30.geojson … part30of30.geojson` — the full
  multi-scenario FeatureCollection split purely for file size (~22 MB each); concatenate
  parts to reassemble.
- `buildings_mardan_watershed_hmax_part01of3.geoparquet … part03of3.geoparquet` — same
  data, compact/fast (`geopandas.read_parquet`, QGIS 3.28+, DuckDB). Recommended.
- `rasters\<scenario>_hmax_peak.tif` — per-scenario peak-hmax GeoTIFFs (provenance).
- `class_summary_by_scenario.csv` — class counts + depth stats per scenario.
- `..\build_building_flood_classes.py` — the script that produced everything above.

## Notes / caveats

- Depths come from `storehsubgrid` hmax, which SFINCS docs note is biased HIGH inside
  channel cells (uses finest subgrid elevation z_zmin). The `hmean` variant also present
  in the rerun .nc files was not used.
- Every footprint intersects the raster extent, so `outside_model_domain` never fires;
  buildings over inactive model cells get depth exactly 0 → `no_exposure`.
- Area-weighted means dilute narrow-channel peaks: a building mostly on high ground gets
  a low mean even if one corner touches deep water.
- P50_ordinary / P75_notable / P90_moderate produce no building ≥ 0.7 m anywhere
  (grid maxima 0.00/0.16/1.02 m) — all 379,371 classify `no_exposure`. Design storms
  increase strictly monotonically T5→T100 in every class (verified).
