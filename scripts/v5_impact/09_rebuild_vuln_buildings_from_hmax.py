"""
Rebuild buildings-impact-v3 from scratch, sourced directly from hmax band 1
(hours 0-30) read straight out of each scenario's .nc - replacing whatever
produced the current (partially broken) v3 output.

Reuses the already-verified, watershed-filtered building set and exact
overlap-area table from earlier in this pipeline (01/02_*.py) - only the
depth source and classification scheme are new here. Does NOT use
exactextract (confirmed to segfault in this environment earlier this
session) - uses the same shapely/geopandas overlay-based exact-area
weighting already proven correct and independently cross-checked multiple
times.

vulnClass buckets match what the frontend (FloodVulnerabilityPage.jsx)
already expects - ratio = hmax / height:
    no_inundation   : hmax ~ 0 (no overlap with any wet cell)
    shallow         : ratio <= 0.10
    moderate        : 0.10 < ratio <= 0.30
    deep            : 0.30 < ratio <= 1.00
    fully_submerged : ratio > 1.00

Output (overwrites in place, same structure the frontend already reads):
  client/public/data/flood-mardan-v5/buildings-impact-v3/
    manifest.json                          (now includes classDistribution)
    <scenario>/<row>_<col>.geojson         (vulnClass/height/hmax/ratio)
    <scenario>/severity_index.json         (regenerated, valid JSON this time)
"""
import json
import os
import time

os.environ.pop('PROJ_LIB', None)
os.environ.pop('PROJ_DATA', None)

import geopandas as gpd
import numpy as np
import pandas as pd
import xarray as xr

WORK_DIR = 'C:/NDMA/infra_portal/scripts/v5_impact/_work'
BUILDINGS_PATH = f'{WORK_DIR}/buildings_filtered_v5.geojson'
OVERLAP_PATH = f'{WORK_DIR}/overlap_table.parquet'

FLOOD_ROOT = 'C:/NDMA/FLOOD_SIMULATION/mardan_v5_copernicus_30m'
SCENARIOS = ['050mm', '100mm', '150mm', '200mm']

OUT_DIR = 'C:/NDMA/infra_portal/client/public/data/flood-mardan-v5/buildings-impact-v3'

# Same chunk grid as the existing (broken) manifest, so file layout stays
# compatible with the frontend's viewport-culling code - no JSX change
# needed, purely a data fix.
CELL_SIZE = 0.015
BOUNDS = [71.72712617000002, 34.04823869999999, 72.47738431, 34.580531210000004]
ROWS = 36
COLS = 51

METHODOLOGY = (
    "Area-weighted mean of the scenario's peak (30h) hmax band over each "
    "building footprint, exact polygon/raster-cell intersection (shapely "
    "overlay, not exactextract - confirmed to segfault in this environment "
    "- but the same true polygon-clip area weighting). Dry cells counted "
    "as 0. vulnClass buckets are ratio=hmax/height: no_inundation (hmax~0), "
    "shallow (<=10%), moderate (10-30%), deep (30-100%), fully_submerged (>=100%)."
)


def read_inp(path):
    inp = {}
    with open(path) as f:
        for line in f:
            if '=' in line:
                k, v = line.split('=', 1)
                inp[k.strip()] = v.strip()
    return inp


def classify(ratio, hmax):
    if hmax <= 1e-6:
        return 'no_inundation'
    if ratio <= 0.10:
        return 'shallow'
    if ratio <= 0.30:
        return 'moderate'
    if ratio <= 1.00:
        return 'deep'
    return 'fully_submerged'


t0 = time.time()
gdf = gpd.read_file(BUILDINGS_PATH).set_crs('EPSG:4326', allow_override=True)
overlap = pd.read_parquet(OVERLAP_PATH)
ids = gdf['id'].values
heights = gdf['height'].values
lons = gdf.geometry.centroid.x.values
lats = gdf.geometry.centroid.y.values
id_to_idx = {bid: i for i, bid in enumerate(ids)}
print(f'loaded {len(ids)} buildings + {len(overlap)} overlap rows: {time.time()-t0:.1f}s', flush=True)

# overlap_area per (building_id, row, col) - group once, reused per scenario
overlap_by_building = overlap.groupby('building_id')

os.makedirs(OUT_DIR, exist_ok=True)
manifest = {
    'cellSize': CELL_SIZE, 'bounds': BOUNDS, 'rows': ROWS, 'cols': COLS,
    'methodology': METHODOLOGY, 'scenarios': [],
}

for scen in SCENARIOS:
    print(f'\n=== {scen} ===', flush=True)
    t0 = time.time()
    nc_path = f'{FLOOD_ROOT}/scenario_{scen}/sfincs_map.nc'
    inp = read_inp(f'{FLOOD_ROOT}/scenario_{scen}/sfincs.inp')
    x0, y0 = float(inp['x0']), float(inp['y0'])
    dx, dy = float(inp['dx']), float(inp['dy'])

    ds = xr.open_dataset(nc_path)
    hmax_b1 = np.nan_to_num(ds.hmax.values[0], nan=0.0)
    ds.close()
    print(f'  loaded hmax band1: {time.time()-t0:.1f}s', flush=True)

    t0 = time.time()
    overlap_vals = hmax_b1[overlap['row'].values, overlap['col'].values]
    weighted = pd.DataFrame({
        'building_id': overlap['building_id'].values,
        'w': overlap['overlap_area_m2'].values,
        'wv': overlap['overlap_area_m2'].values * overlap_vals,
    })
    grouped = weighted.groupby('building_id').sum()
    grouped['hmax'] = grouped['wv'] / grouped['w']
    hmax_by_id = grouped['hmax'].to_dict()
    print(f'  computed area-weighted hmax for {len(hmax_by_id)} buildings: {time.time()-t0:.1f}s', flush=True)

    t0 = time.time()
    out_hmax = np.zeros(len(ids))
    for bid, i in id_to_idx.items():
        out_hmax[i] = hmax_by_id.get(bid, 0.0)
    ratio = np.divide(out_hmax, heights, out=np.zeros_like(out_hmax), where=heights > 0)
    vuln_class = np.array([classify(r, h) for r, h in zip(ratio, out_hmax)])
    print(f'  classified: {time.time()-t0:.1f}s', flush=True)

    class_dist = {cls: int((vuln_class == cls).sum()) for cls in
                  ['no_inundation', 'shallow', 'moderate', 'deep', 'fully_submerged']}
    print(f'  class distribution: {class_dist}', flush=True)

    # chunk by the same lon/lat grid the frontend expects
    t0 = time.time()
    col_idx = np.clip(((lons - BOUNDS[0]) / CELL_SIZE).astype(int), 0, COLS - 1)
    row_idx = np.clip(((lats - BOUNDS[1]) / CELL_SIZE).astype(int), 0, ROWS - 1)

    scen_dir = f'{OUT_DIR}/{scen}'
    os.makedirs(scen_dir, exist_ok=True)

    chunk_buckets = {}
    for i in range(len(ids)):
        key = (int(row_idx[i]), int(col_idx[i]))
        chunk_buckets.setdefault(key, []).append(i)

    cells_meta = []
    severity = {'shallow': [], 'moderate': [], 'deep': [], 'fully_submerged': []}
    for (r, c), idxs in chunk_buckets.items():
        features = []
        for i in idxs:
            cls = vuln_class[i]
            geom = gdf.geometry.iloc[i]
            features.append({
                'type': 'Feature',
                'geometry': geom.__geo_interface__,
                'properties': {
                    'id': ids[i],
                    'height': float(heights[i]),
                    'hmax': round(float(out_hmax[i]), 3),
                    'ratio': round(float(ratio[i]), 3),
                    'vulnClass': cls,
                },
            })
            if cls in severity:
                severity[cls].append({
                    'id': ids[i], 'lon': round(float(lons[i]), 6), 'lat': round(float(lats[i]), 6),
                    'height': round(float(heights[i]), 2), 'hmax': round(float(out_hmax[i]), 3),
                    'ratio': round(float(ratio[i]), 3),
                })
        fname = f'{r}_{c}.geojson'
        with open(f'{scen_dir}/{fname}', 'w') as f:
            json.dump({'type': 'FeatureCollection', 'features': features}, f)
        cells_meta.append({'row': r, 'col': c, 'file': fname, 'count': len(features)})

    for cls in severity:
        severity[cls].sort(key=lambda e: -e['hmax'])
    with open(f'{scen_dir}/severity_index.json', 'w') as f:
        json.dump(severity, f)

    manifest['scenarios'].append({'id': scen, 'cells': cells_meta, 'classDistribution': class_dist})
    print(f'  wrote {len(cells_meta)} chunks + severity_index.json: {time.time()-t0:.1f}s', flush=True)

with open(f'{OUT_DIR}/manifest.json', 'w') as f:
    json.dump(manifest, f)
print('\nALL SCENARIOS DONE. manifest written to', f'{OUT_DIR}/manifest.json', flush=True)
