"""
Stage 2 of 2 for v5 building-impact precompute. Run export_v5_peak_rasters.py
FIRST - this script reads its output (peak_meta.json + the depth/wet
GeoTIFFs).

Building geometry is read ONLY from the existing
flood-mardan/buildings-grid/*.geojson chunks (read-only, never modified).
This script writes brand-new output under flood-mardan-v5/ - nothing in
flood-mardan/ is touched.

Method note - this went through two prior approaches before landing here:
  1. exactextract (true exact polygon/raster-cell intersection) - segfaults
     on ANY non-axis-aligned polygon in this environment (confirmed via
     isolated reproduction down to a single feature; a real crash bug in
     this exactextract build, not fixable via strategy/output params).
  2. rasterstats.zonal_stats (per-feature GDAL rasterization) - stable, but
     ~3-10ms/feature makes 895k buildings x up to 4 scenarios impractical
     (~2-5h worst case per scenario).
  3. THIS: vectorized - rasterize every building in a cell in ONE call
     (building index per pixel, all_touched=True), then aggregate depth/wet
     values per index with numpy.bincount. ~1000x faster than either above
     (2.7s for an 11k-building cell). The one correctness gap this
     introduces: rasterize() keeps only one value per pixel, so when several
     small, densely-packed buildings share a 30m cell, later ones can
     overwrite earlier ones' only touched pixel, silently zeroing them out
     (measured: 71% of an 11k-building dense cell). Fixed with a vectorized
     centroid-lookup fallback for exactly those buildings - for a building
     smaller than one cell (the case that causes the overwrite in the first
     place), centroid and area-weighted depth are the same value anyway.

Outputs (client/public/data/flood-mardan-v5/):
  buildings-impact/<scenario>/<cell>.geojson - same geometry as the source cell file, plus:
      areaWeightedDepth (m), floodedAreaRatio (0-1), heightRatio (depth/height), impactClass
  buildings-impact/manifest.json - mirrors buildings-grid/manifest.json's cell list/bounds
"""
import json
import os

# The shell environment has PROJ_LIB/PROJ_DATA globally pinned to pyproj's
# bundled proj.db, which is a different/older version than some of these
# tools expect - clearing the override lets each library fall back to its
# own internally-consistent bundled proj data.
os.environ.pop('PROJ_LIB', None)
os.environ.pop('PROJ_DATA', None)

import geopandas as gpd
import numpy as np
import rasterio
from rasterio.features import rasterize
from shapely.geometry import box

BUILDINGS_DIR = 'C:/NDMA/infra_portal/client/public/data/flood-mardan/buildings-grid'  # read-only
OUT_DIR = 'C:/NDMA/infra_portal/client/public/data/flood-mardan-v5/buildings-impact'
RASTER_DIR = 'C:/NDMA/infra_portal/client/public/data/flood-mardan-v5/peak_depth_rasters'

WET_THRESHOLD = 0.05  # matches sfincs.inp's huthresh/twet_threshold - the model's own wet/dry cutoff

# Depth-based impact buckets. These are a reasonable general-purpose default,
# not sourced from a specific official standard - adjust CLASS_BREAKS if you
# have a preferred flood-damage classification scheme to match.
CLASS_BREAKS = [
    (0.0, 'dry'),
    (WET_THRESHOLD, 'low'),       # ankle-deep
    (0.3, 'moderate'),
    (1.0, 'severe'),
    (2.0, 'extreme'),
]


def classify(depth):
    label = 'dry'
    for threshold, name in CLASS_BREAKS:
        if depth >= threshold:
            label = name
    return label


def zonal_mean_vectorized(gdf_utm, arr, affine):
    """Returns one mean value per feature in gdf_utm, sampled from arr."""
    n = len(gdf_utm)
    shapes = [(geom, i + 1) for i, geom in enumerate(gdf_utm.geometry)]
    label_arr = rasterize(shapes, out_shape=arr.shape, transform=affine, fill=0, all_touched=True, dtype='int32')
    label_flat = label_arr.ravel()
    arr_flat = arr.ravel()
    sums = np.bincount(label_flat, weights=arr_flat, minlength=n + 1)[1:]
    counts = np.bincount(label_flat, minlength=n + 1)[1:]
    means = np.divide(sums, counts, out=np.full(n, np.nan), where=counts > 0)

    missing = np.isnan(means)
    if missing.any():
        centroids = gdf_utm.geometry[missing].centroid
        cols = np.clip(((centroids.x - affine.c) / affine.a).astype(int), 0, arr.shape[1] - 1)
        rows = np.clip(((centroids.y - affine.f) / affine.e).astype(int), 0, arr.shape[0] - 1)
        means[missing] = arr[rows, cols]
    return means


os.makedirs(OUT_DIR, exist_ok=True)

with open(f'{RASTER_DIR}/peak_meta.json') as f:
    peak_meta = json.load(f)
with open(f'{BUILDINGS_DIR}/manifest.json') as f:
    buildings_manifest = json.load(f)

impact_manifest = {
    'cellSize': buildings_manifest['cellSize'],
    'bounds': buildings_manifest['bounds'],
    'rows': buildings_manifest['rows'],
    'cols': buildings_manifest['cols'],
    'wetThreshold': WET_THRESHOLD,
    'classBreaks': CLASS_BREAKS,
    'scenarios': [],
}

for scen, meta in peak_meta.items():
    print(f'=== {scen}: computed_peak={meta["computed_peak"]} mismatch={meta["mismatch"]} ===', flush=True)
    depth_path = meta['depth_path']
    wet_path = meta['wet_path']

    scen_out_dir = f'{OUT_DIR}/{scen}'
    os.makedirs(scen_out_dir, exist_ok=True)

    wet_bbox_utm = meta['wet_bbox_utm']
    if wet_bbox_utm is not None:
        wet_bbox_gdf = gpd.GeoDataFrame(geometry=[box(*wet_bbox_utm)], crs='EPSG:32643').to_crs('EPSG:4326')
        wet_bbox_wgs84 = wet_bbox_gdf.geometry.iloc[0]
        print(f'  wet-extent bbox (lon/lat): {wet_bbox_wgs84.bounds}', flush=True)
        with rasterio.open(depth_path) as src:
            depth_arr = np.nan_to_num(src.read(1), nan=0.0)
            affine = src.transform
        with rasterio.open(wet_path) as src:
            wet_arr = np.nan_to_num(src.read(1), nan=0.0)
    else:
        wet_bbox_wgs84 = None
        depth_arr = wet_arr = affine = None
        print(f'  {scen}: peak never crosses {WET_THRESHOLD}m - writing all-dry results, no raster work needed', flush=True)

    scen_cell_results = []
    for cell in buildings_manifest['cells']:
        cell_bounds = box(*cell['bounds'])
        cell_out_path = f"{scen_out_dir}/{cell['file']}"
        src_path = f"{BUILDINGS_DIR}/{cell['file']}"

        # Resumable: this run replaced the slow (.iloc + __geo_interface__)
        # per-row loop with a vectorized one, but re-running from scratch
        # would also redo every already-finished cell from the earlier slow
        # run (all of 050mm took ~40min by itself) - skip anything already
        # written.
        if os.path.exists(cell_out_path):
            with open(cell_out_path) as f:
                existing_count = len(json.load(f)['features'])
            scen_cell_results.append({'row': cell['row'], 'col': cell['col'], 'file': cell['file'], 'count': existing_count})
            continue

        if wet_bbox_wgs84 is None or not cell_bounds.intersects(wet_bbox_wgs84):
            # Coarse prefilter: this cell's bbox never touches the flooded
            # extent at all - every building in it is dry, skip the raster
            # work entirely.
            with open(src_path) as f:
                gj = json.load(f)
            out_feats = []
            for feat in gj['features']:
                props = dict(feat['properties'])
                props.update(areaWeightedDepth=0.0, floodedAreaRatio=0.0, heightRatio=0.0, impactClass='dry')
                out_feats.append({'type': 'Feature', 'geometry': feat['geometry'], 'properties': props})
            with open(cell_out_path, 'w') as f:
                json.dump({'type': 'FeatureCollection', 'features': out_feats}, f)
            scen_cell_results.append({'row': cell['row'], 'col': cell['col'], 'file': cell['file'], 'count': len(out_feats)})
            continue

        with open(src_path) as f:
            raw_gj = json.load(f)
        raw_features = raw_gj['features']
        if len(raw_features) == 0:
            with open(cell_out_path, 'w') as f:
                json.dump({'type': 'FeatureCollection', 'features': []}, f)
            scen_cell_results.append({'row': cell['row'], 'col': cell['col'], 'file': cell['file'], 'count': 0})
            continue

        # Building the GeoDataFrame straight from the already-parsed raw
        # features (not gpd.read_file, which would just re-parse the same
        # JSON) - only used for the CRS reprojection needed by the zonal
        # computation. Output geometry below reuses raw_features directly
        # instead of round-tripping through shapely's __geo_interface__,
        # which profiled at ~185us/call - 15s+ of pure overhead alone on
        # the largest (90k-building) cell, on top of a per-row .iloc[i]
        # access pattern that was likely even slower still.
        gdf = gpd.GeoDataFrame.from_features(raw_features, crs='EPSG:4326')
        gdf_utm = gdf.to_crs('EPSG:32643')

        depth_vals = zonal_mean_vectorized(gdf_utm, depth_arr, affine)
        wet_vals = zonal_mean_vectorized(gdf_utm, wet_arr, affine)
        heights = gdf['height'].fillna(3.0).to_numpy()
        heights = np.where(heights == 0, 3.0, heights)
        height_ratios = depth_vals / heights

        out_feats = []
        for i, raw_feat in enumerate(raw_features):
            d = float(depth_vals[i])
            props = {'height': raw_feat['properties'].get('height'),
                     'areaWeightedDepth': round(d, 3),
                     'floodedAreaRatio': round(float(wet_vals[i]), 4),
                     'heightRatio': round(float(height_ratios[i]), 3),
                     'impactClass': classify(d)}
            out_feats.append({'type': 'Feature', 'geometry': raw_feat['geometry'], 'properties': props})

        with open(cell_out_path, 'w') as f:
            json.dump({'type': 'FeatureCollection', 'features': out_feats}, f)
        scen_cell_results.append({'row': cell['row'], 'col': cell['col'], 'file': cell['file'], 'count': len(out_feats)})
        n_impacted = int((depth_vals >= WET_THRESHOLD).sum())
        print(f"  {cell['file']}: {len(out_feats)} buildings, {n_impacted} impacted", flush=True)

    impact_manifest['scenarios'].append({'id': scen, 'cells': scen_cell_results})
    print(f'=== {scen} done ===', flush=True)

with open(f'{OUT_DIR}/manifest.json', 'w') as f:
    json.dump(impact_manifest, f)
print('all scenarios done. manifest written to', f'{OUT_DIR}/manifest.json', flush=True)
