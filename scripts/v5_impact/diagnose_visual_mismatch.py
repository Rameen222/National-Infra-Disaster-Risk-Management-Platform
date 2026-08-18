"""
Three independent checks, each bypassing the others, to isolate which stage
(if any) is actually wrong for the recurring "building sits in the blue
flood raster but reports 0.05m/dry" report:

  STAGE 1 - RAW DATA: does floodDepth, recomputed fresh directly from
    overlap_table.parquet + the raw peak depth grid (no cached agg, no
    04_aggregate_impact.py internals reused), match what's actually
    SAVED in the live geojson chunk files? If these disagree, the bug is
    in the geojson-writing step. If they agree, saving is NOT the problem
    and the true depth value itself is whatever both independently show.

  STAGE 2 - PHYSICAL PLAUSIBILITY: for buildings sitting at the classification
    boundary (0.03m - 0.29m - the "dry but near the edge" band the
    screenishots keep landing on), print the raw depth grid in a 5x5 cell
    neighborhood around them. A real flood edge is not a sharp step in the
    model's own output - SFINCS's wetting/drying scheme means depth tapers
    over a handful of cells near any margin. If these buildings sit in a
    genuine smooth-taper zone, the "soft-looking edge" is physically real,
    not a rendering defect - the raster is not lying by looking soft there.

  STAGE 3 - RENDERING: can't screenshot the live browser from here, so this
    stage is argued from what's independently checkable: the regenerated
    PNGs are colored directly and only from this same raw grid (no
    resampling/reprojection step in between - confirmed by reading
    06_regenerate_depth_frames.py), and raster-resampling:'nearest' is now
    set so the GPU can't add further blur on top. What's printed at the end
    is what informs whether any residual visual softness is explainable by
    stage 2 alone.
"""
import json
import glob
import random

import numpy as np
import pandas as pd

WORK_DIR = 'C:/NDMA/infra_portal/scripts/v5_impact/_work'
GRIDS_DIR = 'C:/NDMA/infra_portal/client/public/data/flood-mardan-v5/peak_grids'
IMPACT_DIR = 'C:/NDMA/infra_portal/client/public/data/flood-mardan-v5/buildings-impact-v2'
SCEN = '150mm'

overlap = pd.read_parquet(f'{WORK_DIR}/overlap_table.parquet')
running_max = np.load(f'{GRIDS_DIR}/{SCEN}_running_max.npy')
msk = np.load(f'{GRIDS_DIR}/{SCEN}_msk.npy')

# ── STAGE 1: independently recompute floodDepth straight from overlap
# table + raw grid, then diff against what's actually saved on disk ────────
rows_a = overlap['row'].to_numpy()
cols_a = overlap['col'].to_numpy()
depth_at_cell = running_max[rows_a, cols_a]
area = overlap['overlap_area_m2'].to_numpy()
df = pd.DataFrame({'building_id': overlap['building_id'].to_numpy(), 'w': depth_at_cell * area, 'area': area})
recomputed = df.groupby('building_id').agg(w=('w', 'sum'), area=('area', 'sum')).reset_index()
recomputed['depth_recomputed'] = recomputed['w'] / recomputed['area']
recomputed = recomputed.set_index('building_id')['depth_recomputed'].to_dict()

files = glob.glob(f'{IMPACT_DIR}/{SCEN}/*.geojson')
n_checked = 0
n_diff = 0
max_diff = 0.0
diff_examples = []
for fp in files:
    d = json.load(open(fp))
    for feat in d['features']:
        p = feat['properties']
        bid = p['id']
        if bid not in recomputed:
            continue
        n_checked += 1
        saved = p['floodDepth']
        fresh = recomputed[bid]
        diff = abs(saved - fresh)
        if diff > 0.005:  # more than rounding noise
            n_diff += 1
            if diff > max_diff:
                max_diff = diff
            if len(diff_examples) < 5:
                diff_examples.append((bid, saved, fresh, diff))

print('=== STAGE 1: geojson-saved value vs fresh independent recompute ===')
print(f'buildings checked: {n_checked}')
print(f'buildings where saved != fresh recompute (>0.005m): {n_diff}')
print(f'max discrepancy found: {max_diff:.4f}m')
for row in diff_examples:
    print('  MISMATCH:', row)
if n_diff == 0:
    print('  -> geojson saving step is NOT the problem; saved values are exactly reproducible from raw inputs.')

# ── STAGE 2: physical plausibility of the "dry but near threshold" band ───
print()
print('=== STAGE 2: 5x5 neighborhood around dry, near-threshold buildings ===')
buildings = pd.DataFrame({
    'building_id': list(recomputed.keys()),
    'depth': list(recomputed.values()),
})
band = buildings[(buildings['depth'] >= 0.03) & (buildings['depth'] < 0.3)]
print(f'{len(band)} buildings in the 0.03-0.3m "dry but near edge" band (out of {len(buildings)} total)')

id_to_cell = overlap.drop_duplicates('building_id').set_index('building_id')[['row', 'col']]
random.seed(1)
sample_ids = random.sample(list(band['building_id']), min(3, len(band)))
for bid in sample_ids:
    r, c = int(id_to_cell.loc[bid, 'row']), int(id_to_cell.loc[bid, 'col'])
    depth_here = recomputed[bid]
    print(f'\n  building {bid}: recomputed depth={depth_here:.3f}m, primary cell (row={r},col={c})')
    print('  5x5 raw depth grid around it (rows = north at bottom, since row increases north):')
    for dr in range(2, -3, -1):
        line = []
        for dc in range(-2, 3):
            rr, cc = r + dr, c + dc
            if 0 <= rr < running_max.shape[0] and 0 <= cc < running_max.shape[1] and msk[rr, cc] == 1:
                line.append(f'{running_max[rr, cc]:6.3f}')
            else:
                line.append('  N/A ')
        print('   ', ' '.join(line))

print()
print('=== STAGE 3: rendering ===')
print('Not directly testable from here (no live browser access). What IS verified:')
print('- 06_regenerate_depth_frames.py colors each pixel ONLY from this same running_max array,')
print('  no intermediate resampling/reprojection step exists between the two.')
print("- raster-resampling:'nearest' is set on fsv5-depth-layer, so the GPU display step adds no")
print('  further blending on top of whatever the source PNG already contains.')
print('- Any remaining visual softness at a flood edge should therefore be explained by Stage 2')
print('  (a real, gradual depth taper in the model output itself), not a rendering defect -')
print('  see the printed neighborhoods above for whether that holds.')
