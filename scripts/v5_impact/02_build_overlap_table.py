"""
Step 2 of the v5 building-impact pipeline: compute the exact building/cell
overlap-area table. This is scenario-independent (building footprints and
the 30m grid don't change between the 4 rainfall scenarios), so it's
computed ONCE here and reused by 04_aggregate_impact.py for all 4.

Not using exactextract - confirmed earlier this session to segfault
reliably on non-axis-aligned polygons in this environment (reproduced down
to a single real building feature, independent of raster settings/size/
strategy). Using shapely intersection via geopandas.overlay instead, which
is genuinely exact (true polygon-clip area, not a rasterized/sampled
approximation) and avoids per-feature Python loops (the other proven-slow
pattern from this session) by using overlay's vectorized/indexed GEOS
operations.

Output:
  overlap_table.parquet - columns: building_id, row, col, overlap_area_m2
  building_footprint_area.parquet - columns: building_id, footprint_area_m2
    (independently computed from the ORIGINAL polygon, not summed from the
    overlap table, so it doubles as an intersection-bug check downstream)
"""
import os
import time

os.environ.pop('PROJ_LIB', None)
os.environ.pop('PROJ_DATA', None)

import geopandas as gpd
import numpy as np
import pandas as pd
import shapely
from shapely.geometry import box

BUILDINGS_PATH = 'C:/NDMA/infra_portal/scripts/v5_impact/_work/buildings_filtered_v5.geojson'
INP_PATH = 'C:/NDMA/FLOOD_SIMULATION/mardan_v5_copernicus_30m/scenario_100mm/sfincs.inp'  # grid params, same for all 4 scenarios
OUT_DIR = 'C:/NDMA/infra_portal/scripts/v5_impact/_work'


def read_inp(path):
    inp = {}
    with open(path) as f:
        for line in f:
            if '=' in line:
                k, v = line.split('=', 1)
                inp[k.strip()] = v.strip()
    return inp


t0 = time.time()
gdf = gpd.read_file(BUILDINGS_PATH)
gdf = gdf.set_crs('EPSG:4326', allow_override=True)
print(f'loaded {len(gdf)} filtered buildings: {time.time()-t0:.1f}s', flush=True)

t0 = time.time()
gdf_utm = gdf.to_crs('EPSG:32643')
print(f'reprojected to UTM: {time.time()-t0:.1f}s', flush=True)

inp = read_inp(INP_PATH)
x0, y0 = float(inp['x0']), float(inp['y0'])
dx, dy = float(inp['dx']), float(inp['dy'])
nmax, mmax = int(inp['nmax']), int(inp['mmax'])
print(f'grid: x0={x0} y0={y0} dx={dx} dy={dy} nmax={nmax} mmax={mmax}', flush=True)
# SFINCS bottom-left convention: row 0 sits at y0 (south edge), row increases
# northward; col 0 sits at x0 (west edge), col increases eastward. This
# matches how h/zb/msk are indexed directly - no flip needed here (the flip
# in earlier scripts was only for writing north-up GeoTIFFs/PNGs).

t0 = time.time()
bounds = gdf_utm.geometry.bounds  # minx, miny, maxx, maxy per building
col_min = np.clip(np.floor((bounds['minx'] - x0) / dx).astype(int), 0, mmax - 1)
col_max = np.clip(np.floor((bounds['maxx'] - x0) / dx).astype(int), 0, mmax - 1)
row_min = np.clip(np.floor((bounds['miny'] - y0) / dy).astype(int), 0, nmax - 1)
row_max = np.clip(np.floor((bounds['maxy'] - y0) / dy).astype(int), 0, nmax - 1)

needed_cells = set()
for cmn, cmx, rmn, rmx in zip(col_min, col_max, row_min, row_max):
    for r in range(rmn, rmx + 1):
        for c in range(cmn, cmx + 1):
            needed_cells.add((r, c))
print(f'needed cells (bbox-based candidate set): {len(needed_cells)}: {time.time()-t0:.1f}s', flush=True)

t0 = time.time()
needed_cells = sorted(needed_cells)
cell_rows = np.array([r for r, c in needed_cells])
cell_cols = np.array([c for r, c in needed_cells])
cell_geoms = shapely.box(
    x0 + cell_cols * dx, y0 + cell_rows * dy,
    x0 + (cell_cols + 1) * dx, y0 + (cell_rows + 1) * dy,
)
print(f'built {len(cell_geoms)} cell geometries: {time.time()-t0:.1f}s', flush=True)

# Bulk STRtree query (one vectorized call, not gpd.overlay or a per-feature
# loop - both were confirmed catastrophically slow for this dataset earlier
# in this pipeline, same as gpd.sjoin was in step 1) - returns every
# (building_index, cell_index) candidate PAIR whose bounding boxes and
# actual geometries intersect, in one shot.
t0 = time.time()
building_geoms = gdf_utm.geometry.values
tree = shapely.STRtree(cell_geoms)
building_idx, cell_idx = tree.query(building_geoms, predicate='intersects')
print(f'bulk STRtree query: {time.time()-t0:.1f}s, {len(building_idx)} candidate pairs', flush=True)

t0 = time.time()
# Vectorized intersection + area over the whole candidate-pair array at
# once (shapely 2.x ufunc-style operations on numpy geometry arrays, not
# a Python loop per pair).
inter_geoms = shapely.intersection(building_geoms[building_idx], cell_geoms[cell_idx])
areas = shapely.area(inter_geoms)
print(f'vectorized intersection + area: {time.time()-t0:.1f}s', flush=True)

overlap_table = pd.DataFrame({
    'building_id': gdf_utm['id'].values[building_idx],
    'row': cell_rows[cell_idx],
    'col': cell_cols[cell_idx],
    'overlap_area_m2': areas,
})
overlap_table = overlap_table[overlap_table['overlap_area_m2'] > 0]
print(f'{len(overlap_table)} positive-area rows', flush=True)

overlap_table.to_parquet(f'{OUT_DIR}/overlap_table.parquet', index=False)
print(f'wrote overlap_table.parquet', flush=True)

t0 = time.time()
footprint_area = pd.DataFrame({
    'building_id': gdf_utm['id'].values,
    'footprint_area_m2': gdf_utm.geometry.area.values,
})
footprint_area.to_parquet(f'{OUT_DIR}/building_footprint_area.parquet', index=False)
print(f'wrote building_footprint_area.parquet: {time.time()-t0:.1f}s', flush=True)

# quick validation preview
check = overlap_table.groupby('building_id')['overlap_area_m2'].sum().reset_index()
check = check.merge(footprint_area, on='building_id', how='right')
check['overlap_sum'] = check['overlap_area_m2'].fillna(0.0)
check['diff_pct'] = np.where(
    check['footprint_area_m2'] > 0,
    100 * (check['overlap_sum'] - check['footprint_area_m2']) / check['footprint_area_m2'],
    np.nan,
)
n_no_overlap = int((check['overlap_sum'] == 0).sum())
n_bad_match = int((check['diff_pct'].abs() > 1).sum())
print(f'buildings with ZERO overlap area (outside active grid or bug): {n_no_overlap} / {len(check)}', flush=True)
print(f'buildings where overlap_sum vs footprint_area differ >1%: {n_bad_match} / {len(check)}', flush=True)
print(check['diff_pct'].describe(), flush=True)
print('DONE', flush=True)
