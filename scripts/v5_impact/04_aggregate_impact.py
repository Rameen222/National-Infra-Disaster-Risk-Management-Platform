"""
Step 4 of the v5 building-impact pipeline: combine the overlap table (step
2, scenario-independent) with each scenario's running-max/zs_peak/zb grids
(step 3) into per-building peak-flood impact stats, chunked and written
per scenario.

Per building, per scenario:
  zs_building = area-weighted mean of zs_peak (=zb+running_max) over the
                building's covering cells, weighted by overlap_area_m2
  ground_elev = area-weighted mean of zb over the same cells/weights
  floodDepth  = max(0, zs_building - ground_elev)
  floodedAreaRatio = 100 * (overlap area over cells where running_max >
                     0.05m) / total footprint area - kept as a descriptive
                     stat only, no longer the classification gate (see
                     below - it used to disagree with floodDepth right at
                     the threshold, producing buildings with a HIGHER
                     floodDepth/Rh classified as "dry" while a neighbor
                     with a lower one wasn't, because it's a binary
                     per-cell gate (any cell > 0.05m) while floodDepth is a
                     continuous whole-footprint average - two independent
                     thresholds fighting each other at the boundary)
  heightRatio (Rh) = floodDepth / height - only if height >= 0.5m,
                     otherwise the building is flagged height_unreliable
                     instead of emitting a bogus ratio. Dormant with the
                     current GeoServer-sourced building set (every building
                     is already >= 8ft/2.4384m, anomalies pre-filtered) but
                     kept as a safeguard in case a future source reintroduces
                     unreliable heights.

Classification (thresholds are a design choice, stated here so they're
auditable - not a fixed standard):
  dry           - floodDepth < 0.3m (replaces the old floodedAreaRatio<=0
                     gate - see above)
  height_unreliable - height < 0.5m (or missing/zero) - depth/ratio fields
                     still populated, just not classified by Rh
  wet_shallow   - Rh < 0.25
  partial       - 0.25 <= Rh < 0.75
  substantial   - 0.75 <= Rh < 1.0
  submerged     - Rh >= 1.0

Output: self-contained per-scenario, per-cell GeoJSON chunks (own grid,
built fresh from THIS filtered building set). Written to the same
buildings-impact-v2/ directory the dashboard already reads from - the
caller (run notes / this script's invocation) deletes its old contents
first since this building set's extent differs from the previous one's,
so the chunk grid's row/col numbering isn't compatible with leftover files
from the prior run.
"""
import json
import os
import time

os.environ.pop('PROJ_LIB', None)
os.environ.pop('PROJ_DATA', None)

import geopandas as gpd
import numpy as np
import pandas as pd

WORK_DIR = 'C:/NDMA/infra_portal/scripts/v5_impact/_work'
GRIDS_DIR = 'C:/NDMA/infra_portal/client/public/data/flood-mardan-v5/peak_grids'
OUT_DIR = 'C:/NDMA/infra_portal/client/public/data/flood-mardan-v5/buildings-impact-v2'
SCENARIOS = ['050mm', '100mm', '150mm', '200mm']

WET_THRESHOLD = 0.05  # still used for the descriptive floodedAreaRatio stat
DRY_DEPTH_THRESHOLD = 0.3  # m - the actual classification gate now
HEIGHT_UNRELIABLE_THRESHOLD = 0.5
CHUNK_CELL_SIZE_DEG = 0.015  # ~3.3x finer than the original 0.05deg grid - that
# produced chunks up to 28.5MB / 90k+ features (each feature now carries 5
# impact properties, not just height, so it's heavier than the plain
# building files) - fetching a viewport touching a few of those at once was
# enough to crash the tab. This keeps worst-case single-chunk size in the
# low single-digit MB range.

RH_BREAKS = [
    (0.0, 'wet_shallow'),
    (0.25, 'partial'),
    (0.75, 'substantial'),
    (1.0, 'submerged'),
]
# Non-dry, non-unreliable class names, worst-first - matches the frontend's
# IMPACT_ORDER (FloodSimulationV5Page.jsx) minus 'dry'/'height_unreliable'.
SEVERITY_CLASSES = ['wet_shallow', 'partial', 'substantial', 'submerged']


def classify(flood_depth, rh, height_unreliable):
    if flood_depth < DRY_DEPTH_THRESHOLD:
        return 'dry'
    if height_unreliable:
        return 'height_unreliable'
    label = RH_BREAKS[0][1]
    for threshold, name in RH_BREAKS:
        if rh >= threshold:
            label = name
    return label


os.makedirs(OUT_DIR, exist_ok=True)

t0 = time.time()
overlap = pd.read_parquet(f'{WORK_DIR}/overlap_table.parquet')
footprint = pd.read_parquet(f'{WORK_DIR}/building_footprint_area.parquet')
print(f'loaded overlap table ({len(overlap)} rows) + footprint areas ({len(footprint)} buildings): {time.time()-t0:.1f}s', flush=True)

t0 = time.time()
with open(f'{WORK_DIR}/buildings_filtered_v5.geojson') as f:
    raw_gj = json.load(f)
raw_features_by_id = {feat['properties']['id']: feat for feat in raw_gj['features']}
buildings = gpd.read_file(f'{WORK_DIR}/buildings_filtered_v5.geojson')
buildings = buildings.set_crs('EPSG:4326', allow_override=True)
print(f'loaded building geometries: {time.time()-t0:.1f}s, n={len(buildings)}', flush=True)

# Build the output chunk grid fresh, from this building set's own extent.
# Centroid computed once and reused both for chunking and as the "fly to"
# point for the severity-index browser (approximate is fine for both uses -
# geographic-CRS centroid, not a true planar one, but nothing here needs
# sub-meter precision).
t0 = time.time()
b = buildings.total_bounds  # minx, miny, maxx, maxy
centroid = buildings.geometry.centroid
n_cols = int(np.ceil((b[2] - b[0]) / CHUNK_CELL_SIZE_DEG))
n_rows = int(np.ceil((b[3] - b[1]) / CHUNK_CELL_SIZE_DEG))
chunk_col = np.clip(((centroid.x - b[0]) / CHUNK_CELL_SIZE_DEG).astype(int), 0, n_cols - 1)
chunk_row = np.clip(((centroid.y - b[1]) / CHUNK_CELL_SIZE_DEG).astype(int), 0, n_rows - 1)
buildings = buildings.assign(_chunk_row=chunk_row, _chunk_col=chunk_col, _lon=centroid.x, _lat=centroid.y)
building_lookup = buildings.set_index('id')
print(f'built {n_rows}x{n_cols} output chunk grid: {time.time()-t0:.1f}s', flush=True)

chunk_manifest = {
    'cellSize': CHUNK_CELL_SIZE_DEG,
    'bounds': list(b),
    'rows': n_rows,
    'cols': n_cols,
    'wetThreshold': WET_THRESHOLD,
    'dryDepthThreshold': DRY_DEPTH_THRESHOLD,
    'heightUnreliableThreshold': HEIGHT_UNRELIABLE_THRESHOLD,
    'rhBreaks': RH_BREAKS,
    'scenarios': [],
}

for scen in SCENARIOS:
    print(f'=== {scen} ===', flush=True)
    t0 = time.time()
    running_max = np.load(f'{GRIDS_DIR}/{scen}_running_max.npy')
    zs_peak = np.load(f'{GRIDS_DIR}/{scen}_zs_peak.npy')
    zb = np.load(f'{GRIDS_DIR}/{scen}_zb.npy')
    print(f'  loaded grids: {time.time()-t0:.1f}s', flush=True)

    t0 = time.time()
    rows = overlap['row'].to_numpy()
    cols = overlap['col'].to_numpy()
    zs_vals = zs_peak[rows, cols]
    zb_vals = zb[rows, cols]
    wet_vals = (running_max[rows, cols] > WET_THRESHOLD).astype('float64')
    area = overlap['overlap_area_m2'].to_numpy()

    df = pd.DataFrame({
        'building_id': overlap['building_id'].to_numpy(),
        'w_zs': zs_vals * area,
        'w_zb': zb_vals * area,
        'w_wet_area': wet_vals * area,
        'area': area,
    })
    agg = df.groupby('building_id').agg(
        sum_w_zs=('w_zs', 'sum'), sum_w_zb=('w_zb', 'sum'),
        sum_wet_area=('w_wet_area', 'sum'), sum_area=('area', 'sum'),
    ).reset_index()
    print(f'  sampled + grouped: {time.time()-t0:.1f}s, {len(agg)} buildings', flush=True)

    t0 = time.time()
    agg = agg.merge(footprint, on='building_id', how='left')
    agg['zs_building'] = agg['sum_w_zs'] / agg['sum_area']
    agg['ground_elev'] = agg['sum_w_zb'] / agg['sum_area']
    agg['floodDepth'] = np.maximum(0.0, agg['zs_building'] - agg['ground_elev'])
    agg['floodedAreaRatio'] = 100.0 * agg['sum_wet_area'] / agg['footprint_area_m2']

    heights = agg['building_id'].map(building_lookup['height'])
    heights = pd.to_numeric(heights, errors='coerce')
    agg['height'] = heights.to_numpy()
    agg['height_unreliable'] = ~(agg['height'] >= HEIGHT_UNRELIABLE_THRESHOLD)
    agg['heightRatio'] = np.where(agg['height_unreliable'], np.nan, agg['floodDepth'] / agg['height'])

    agg['impactClass'] = [
        classify(fd, rh, hu) for fd, rh, hu in zip(agg['floodDepth'], agg['heightRatio'], agg['height_unreliable'])
    ]
    print(f'  computed depth/ratios/class: {time.time()-t0:.1f}s', flush=True)

    # validation preview for this scenario
    n_height_unreliable = int(agg['height_unreliable'].sum())
    n_rh_outlier = int((agg['heightRatio'] > 5).sum())
    class_counts = agg['impactClass'].value_counts().to_dict()
    print(f'  height_unreliable: {n_height_unreliable}, Rh>5 outliers: {n_rh_outlier}', flush=True)
    print(f'  class distribution: {class_counts}', flush=True)

    # write chunked output - iterate plain numpy/dict lookups (not
    # gpd geometry.__geo_interface__ per row or .iterrows(), both confirmed
    # painfully slow earlier in this pipeline) and reuse the ORIGINAL raw
    # geometry dicts directly instead of re-deriving them from geopandas.
    t0 = time.time()
    scen_out_dir = f'{OUT_DIR}/{scen}'
    os.makedirs(scen_out_dir, exist_ok=True)
    agg_by_id = agg.set_index('building_id').to_dict('index')

    id_arr = buildings['id'].to_numpy()
    height_arr = buildings['height'].to_numpy()
    chunk_row_arr = buildings['_chunk_row'].to_numpy()
    chunk_col_arr = buildings['_chunk_col'].to_numpy()
    lon_arr = buildings['_lon'].to_numpy()
    lat_arr = buildings['_lat'].to_numpy()

    # One flat list per non-dry class: {id, lon, lat, floodDepth, height,
    # heightRatio}, worst-first. Lets the frontend's legend "browse this
    # class" feature fly straight to each matching building without
    # fetching every chunk to find them - these lists are tiny (a few
    # hundred to low thousands of rows) next to the full building set.
    severity_index = {cls: [] for cls in SEVERITY_CLASSES}

    chunks = {}
    for bid, height, cr, cc, lon, lat in zip(id_arr, height_arr, chunk_row_arr, chunk_col_arr, lon_arr, lat_arr):
        a = agg_by_id.get(bid)
        if a is None:
            continue
        feat = {
            'type': 'Feature',
            'geometry': raw_features_by_id[bid]['geometry'],
            'properties': {
                'id': bid,
                'height': None if pd.isna(height) else float(height),
                'floodDepth': round(float(a['floodDepth']), 3),
                'floodedAreaRatio': round(float(a['floodedAreaRatio']), 2),
                'heightRatio': None if pd.isna(a['heightRatio']) else round(float(a['heightRatio']), 3),
                'impactClass': a['impactClass'],
            },
        }
        chunks.setdefault((int(cr), int(cc)), []).append(feat)

        if a['impactClass'] in severity_index:
            severity_index[a['impactClass']].append({
                'id': bid,
                'lon': round(float(lon), 6),
                'lat': round(float(lat), 6),
                'floodDepth': feat['properties']['floodDepth'],
                'height': feat['properties']['height'],
                'heightRatio': feat['properties']['heightRatio'],
            })

    scen_cell_results = []
    for (cr, cc), feats in chunks.items():
        fname = f'{cr}_{cc}.geojson'
        with open(f'{scen_out_dir}/{fname}', 'w') as f:
            json.dump({'type': 'FeatureCollection', 'features': feats}, f)
        scen_cell_results.append({'row': cr, 'col': cc, 'file': fname, 'count': len(feats)})
    print(f'  wrote {len(scen_cell_results)} chunks: {time.time()-t0:.1f}s', flush=True)

    for cls in severity_index:
        severity_index[cls].sort(key=lambda r: -r['floodDepth'])
    with open(f'{scen_out_dir}/severity_index.json', 'w') as f:
        json.dump(severity_index, f)
    print(f'  wrote severity_index.json: {{{", ".join(f"{k}: {len(v)}" for k, v in severity_index.items())}}}', flush=True)

    chunk_manifest['scenarios'].append({'id': scen, 'cells': scen_cell_results, 'classDistribution': class_counts,
                                         'heightUnreliableCount': n_height_unreliable, 'rhOutlierCount': n_rh_outlier})

with open(f'{OUT_DIR}/manifest.json', 'w') as f:
    json.dump(chunk_manifest, f)
print('ALL SCENARIOS DONE. manifest written to', f'{OUT_DIR}/manifest.json', flush=True)
