"""
Flood Vulnerability V2 - CORRECTED depth raster, computed as zsmax - zb
instead of the delivered hmax_peak.tif.

Why: the delivered hmax_peak.tif (used by 03_generate_final_depth_raster_png.py,
the current Building Exposure page) reads a 'hmax' variable that was proven to
disagree with the model's own water-surface tracking. Directly verified:
  - h (hourly output) == zs - zb EXACTLY (bit-identical) at every wet cell,
    every timestep, every scenario checked.
  - zsmax.max('timemax') - zb matches h's true peak to within ~0.1-0.5m
    (normal discretization noise between 4 daily zsmax snapshots and hourly
    h output) - i.e. zs/zsmax/h are all mutually self-consistent.
  - The file's own 'hmax' variable does NOT match zsmax - zb: off by up to
    23.6m at individual cells (event_2010), one-directionally low, on ~a
    third of all "flooded" cells across every scenario tested.

This script recomputes depth the way the model's own zs/zsmax variables
(which DO agree with h) already say it should be: zsmax - zb, clipped >=0,
masked to the same msk==1 domain as everything else in this pipeline. Same
source file as before (sfincs_map.nc), same grid, no new external data.

Deliberately does NOT touch depth_manifest.json, the rasters/ directory, or
the delivered hmax_peak.tif files - writes a separate, parallel output set
so the two can be compared before deciding whether to switch the live page.

Output:
  client/public/Data_2/Data_2_final/rasters_corrected/<scenario>_depth_zsmax.tif
  client/public/Data_2/Data_2_final/depth_manifest_corrected.json
"""
import json
import os

os.environ.pop('PROJ_LIB', None)
os.environ.pop('PROJ_DATA', None)

import numpy as np
import rasterio
import xarray as xr

NC_ROOT = 'C:/NDMA/FLOOD_SIMULATION_FINAL/rerun_hmax/scenarios'
OLD_TIF_DIR = 'C:/NDMA/FLOOD_SIMULATION_FINAL/rerun_hmax/buildings_flood_depth_classes/rasters'
OUT_DIR = 'C:/NDMA/infra_portal/client/public/Data_2/Data_2_final'
RASTER_DIR = f'{OUT_DIR}/rasters_corrected'
os.makedirs(RASTER_DIR, exist_ok=True)

SCENARIOS = [
    ('event_2006', '5 Aug 2006', 'Historical events'),
    ('event_2010', '2010 event', 'Historical events'),
    ('design_T5', 'T5 design storm', 'Design storms (return period)'),
    ('design_T10', 'T10 design storm', 'Design storms (return period)'),
    ('design_T25', 'T25 design storm', 'Design storms (return period)'),
    ('design_T50', 'T50 design storm', 'Design storms (return period)'),
    ('design_T100', 'T100 design storm', 'Design storms (return period)'),
    ('P50_ordinary', 'P50 (ordinary)', 'Probabilistic'),
    ('P75_notable', 'P75 (notable)', 'Probabilistic'),
    ('P90_moderate', 'P90 (moderate)', 'Probabilistic'),
    ('illustrative_25jul2011', '25 Jul 2011 (illustrative)', 'Illustrative'),
]

DEPTH_GATE_M = 0.05

manifest = {'source': 'zsmax.max(timemax) - zb, from sfincs_map.nc (NOT the delivered hmax_peak.tif)',
            'scenarios': []}

for scen, label, category in SCENARIOS:
    print(f'=== {scen} ===', flush=True)

    # Reuse the delivered tif purely for its georeferencing (profile) - same
    # grid as 03_generate_final_depth_raster_png.py already asserts.
    old_tif_path = f'{OLD_TIF_DIR}/{scen}_hmax_peak.tif'
    with rasterio.open(old_tif_path) as src:
        profile = src.profile.copy()
        old_depth = src.read(1).astype(np.float32)

    ds = xr.open_dataset(f'{NC_ROOT}/{scen}/sfincs_map.nc')
    zb = ds['zb'].values
    zsmax_block = ds['zsmax'].max('timemax').values
    msk = ds['msk'].values == 1
    h = ds['h'].values
    h_peak = np.nanmax(h, axis=0)
    ds.close()

    corrected = np.clip(zsmax_block - zb, 0, None)
    corrected = np.where(msk, corrected, np.nan).astype(np.float32)

    profile.update(dtype='float32', nodata=np.nan, count=1)
    out_path = f'{RASTER_DIR}/{scen}_depth_zsmax.tif'
    with rasterio.open(out_path, 'w', **profile) as dst:
        dst.write(corrected, 1)

    # Comparison stats: old delivered hmax_peak.tif vs new zsmax-zb vs h's
    # own true peak (the independent cross-check).
    old_valid = np.isfinite(old_depth) & msk & (old_depth >= DEPTH_GATE_M)
    new_valid = np.isfinite(corrected) & msk & (corrected >= DEPTH_GATE_M)
    h_valid = msk & (h_peak >= DEPTH_GATE_M)

    old_max = float(np.nanmax(old_depth[old_valid])) if old_valid.any() else 0.0
    new_max = float(np.nanmax(corrected[new_valid])) if new_valid.any() else 0.0
    h_max = float(np.nanmax(h_peak[h_valid])) if h_valid.any() else 0.0

    resid = np.abs(corrected - h_peak)
    both_valid = new_valid & h_valid
    max_resid = float(np.nanmax(resid[both_valid])) if both_valid.any() else 0.0

    print(f'  old(hmax_peak.tif) max={old_max:.3f}  new(zsmax-zb) max={new_max:.3f}  '
          f'h max={h_max:.3f}  |  max residual new-vs-h={max_resid:.4f}', flush=True)

    manifest['scenarios'].append({
        'id': scen, 'label': label, 'category': category,
        'file': f'rasters_corrected/{scen}_depth_zsmax.tif',
        'old_hmax_peak_max': round(old_max, 3),
        'new_zsmax_zb_max': round(new_max, 3),
        'h_true_peak_max': round(h_max, 3),
        'max_residual_vs_h': round(max_resid, 4),
    })

with open(f'{OUT_DIR}/depth_manifest_corrected.json', 'w') as f:
    json.dump(manifest, f, indent=2)
print(f'\nDONE. wrote {OUT_DIR}/depth_manifest_corrected.json', flush=True)
