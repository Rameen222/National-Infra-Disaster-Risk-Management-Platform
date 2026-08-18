"""
Exploratory comparison, NOT part of the production pipeline - doesn't touch
04_aggregate_impact.py, doesn't write anything under client/public/, doesn't
change what the live site serves. Answers: would centroid-sampling or
max-of-overlapping-cells assign meaningfully different flood depths (and
therefore different severity classes) than the current area-weighted mean?

Three methods, same underlying overlap_table.parquet + peak depth grid:
  A) area-weighted mean (CURRENT/production) - depth averaged across every
     cell the footprint overlaps, weighted by how many m2 sit in each cell.
  B) max-of-cells - the single deepest cell the footprint touches.
  C) centroid - the one cell containing the building's centroid point,
     ignoring the rest of its footprint entirely.

Run for one scenario (150mm - the one under discussion) against the real,
current building set. Reports class-distribution shift and concrete
examples of buildings that reclassify between methods.
"""
import json
import time

import geopandas as gpd
import numpy as np
import pandas as pd

WORK_DIR = 'C:/NDMA/infra_portal/scripts/v5_impact/_work'
GRIDS_DIR = 'C:/NDMA/infra_portal/client/public/data/flood-mardan-v5/peak_grids'
SCEN = '150mm'
DRY_DEPTH_THRESHOLD = 0.3
HEIGHT_UNRELIABLE_THRESHOLD = 0.5
RH_BREAKS = [(0.0, 'wet_shallow'), (0.25, 'partial'), (0.75, 'substantial'), (1.0, 'submerged')]


def classify(depth, height):
    if pd.isna(height) or height < HEIGHT_UNRELIABLE_THRESHOLD:
        return 'height_unreliable'
    if depth < DRY_DEPTH_THRESHOLD:
        return 'dry'
    rh = depth / height
    label = RH_BREAKS[0][1]
    for threshold, name in RH_BREAKS:
        if rh >= threshold:
            label = name
    return label


t0 = time.time()
overlap = pd.read_parquet(f'{WORK_DIR}/overlap_table.parquet')
buildings = gpd.read_file(f'{WORK_DIR}/buildings_filtered_v5.geojson').set_crs('EPSG:4326', allow_override=True)
buildings_utm = buildings.to_crs('EPSG:32643')
print(f'loaded {len(buildings)} buildings + {len(overlap)} overlap rows: {time.time()-t0:.1f}s', flush=True)

running_max = np.load(f'{GRIDS_DIR}/{SCEN}_running_max.npy')
x0, y0, dx, dy = 198735.827, 3769934.653, 30.0, 30.0
nrows, ncols = running_max.shape

# ── Method A: area-weighted mean (reuses the overlap table exactly as
# 04_aggregate_impact.py does) ────────────────────────────────────────────
rows_arr = overlap['row'].to_numpy()
cols_arr = overlap['col'].to_numpy()
depth_at_cell = running_max[rows_arr, cols_arr]
area = overlap['overlap_area_m2'].to_numpy()
df = pd.DataFrame({'building_id': overlap['building_id'].to_numpy(), 'w_depth': depth_at_cell * area, 'area': area})
agg_a = df.groupby('building_id').agg(sum_w=('w_depth', 'sum'), sum_area=('area', 'sum')).reset_index()
agg_a['depth_A'] = agg_a['sum_w'] / agg_a['sum_area']

# ── Method B: max of whichever cells the footprint overlaps ──────────────
df_max = pd.DataFrame({'building_id': overlap['building_id'].to_numpy(), 'depth': depth_at_cell})
agg_b = df_max.groupby('building_id')['depth'].max().reset_index().rename(columns={'depth': 'depth_B'})

# ── Method C: single cell at the building's own centroid ─────────────────
t0 = time.time()
cx = buildings_utm.geometry.centroid.x.to_numpy()
cy = buildings_utm.geometry.centroid.y.to_numpy()
col_c = np.clip(((cx - x0) / dx).astype(int), 0, ncols - 1)
row_c = np.clip(((cy - y0) / dy).astype(int), 0, nrows - 1)
depth_c = running_max[row_c, col_c]
agg_c = pd.DataFrame({'building_id': buildings_utm['id'].to_numpy(), 'depth_C': depth_c})
print(f'computed all 3 methods: {time.time()-t0:.1f}s', flush=True)

merged = agg_a[['building_id', 'depth_A']].merge(agg_b, on='building_id', how='outer').merge(agg_c, on='building_id', how='outer')
merged = merged.merge(buildings_utm[['id', 'height']].rename(columns={'id': 'building_id'}), on='building_id', how='left')
merged[['depth_A', 'depth_B', 'depth_C']] = merged[['depth_A', 'depth_B', 'depth_C']].fillna(0.0)

for col in ['A', 'B', 'C']:
    merged[f'class_{col}'] = [classify(d, h) for d, h in zip(merged[f'depth_{col}'], merged['height'])]

print(f'\n=== {SCEN}: class distribution per method ===')
for col in ['A', 'B', 'C']:
    print(f'  Method {col}:', merged[f'class_{col}'].value_counts().to_dict())

sev_rank = {'dry': 0, 'height_unreliable': 0, 'wet_shallow': 1, 'partial': 2, 'substantial': 3, 'submerged': 4}
merged['rank_A'] = merged['class_A'].map(sev_rank)
merged['rank_B'] = merged['class_B'].map(sev_rank)
merged['rank_C'] = merged['class_C'].map(sev_rank)

n_b_reclass = int((merged['rank_B'] != merged['rank_A']).sum())
n_c_reclass = int((merged['rank_C'] != merged['rank_A']).sum())
print(f'\nbuildings whose class changes A->B (max): {n_b_reclass} / {len(merged)} ({100*n_b_reclass/len(merged):.2f}%)')
print(f'buildings whose class changes A->C (centroid): {n_c_reclass} / {len(merged)} ({100*n_c_reclass/len(merged):.2f}%)')

print('\n--- sample: buildings A says dry, B (max) says notably worse ---')
sample = merged[(merged['class_A'] == 'dry') & (merged['rank_B'] >= 2)].sort_values('depth_B', ascending=False).head(8)
print(sample[['building_id', 'height', 'depth_A', 'class_A', 'depth_B', 'class_B', 'depth_C', 'class_C']].to_string(index=False))

print('\n--- sample: buildings A and C (centroid) disagree by >=2 severity ranks ---')
sample2 = merged[(merged['rank_C'] - merged['rank_A']).abs() >= 2].head(8)
print(sample2[['building_id', 'height', 'depth_A', 'class_A', 'depth_C', 'class_C']].to_string(index=False))
