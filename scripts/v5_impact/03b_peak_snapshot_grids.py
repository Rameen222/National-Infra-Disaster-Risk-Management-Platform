"""
Replaces 03_streaming_running_max.py's output with a SINGLE-TIMESTEP
snapshot at each scenario's domain-wide peak time, instead of a true
per-cell running max over the full 48h.

Why the change: the running-max version let individual buildings show a
depth from whenever THEIR cell happened to peak (sometimes 10+ hours after
the domain-wide peak), while the flood-depth animation only ever renders
frames up to the domain-wide peak time. That mismatch made buildings look
"wrong" - deeper in the impact stats than anything visible in the
animation. Scope is now: building inundation AT the domain-wide peak
moment only, for consistency with what's actually shown on screen.

peak_idx per scenario comes directly from dashboard/manifest.json's
frames[-1] (each scenario's frames already run t=0 -> domain peak, so the
last frame IS the domain peak timestep) - same value already
cross-validated against the manifest's own peakDepth for all 4 scenarios.

Outputs (same paths/shape as before, just single-frame content):
  <scenario>_running_max.npy -> now h at the single peak timestep (m)
  <scenario>_zs_peak.npy     -> zb + that single-timestep depth (m)
  (zb/msk unchanged - already static, left as-is)
"""
import json
import os

os.environ.pop('PROJ_LIB', None)
os.environ.pop('PROJ_DATA', None)

import numpy as np
import xarray as xr

MODEL_DIR = 'C:/NDMA/FLOOD_SIMULATION/mardan_v5_copernicus_30m'
DASHBOARD_MANIFEST = 'C:/NDMA/infra_portal/client/public/data/flood-mardan-v5/dashboard/manifest.json'
OUT_DIR = 'C:/NDMA/infra_portal/client/public/data/flood-mardan-v5/peak_grids'

with open(DASHBOARD_MANIFEST) as f:
    dash_manifest = json.load(f)

for scen_info in dash_manifest['scenarios']:
    scen = scen_info['id']
    peak_idx = len(scen_info['frames']) - 1
    print(f'=== {scen}: peak_idx={peak_idx}, manifest peakDepth={scen_info["peakDepth"]} ===', flush=True)

    ds = xr.open_dataset(f'{MODEL_DIR}/scenario_{scen}/sfincs_map.nc')
    zb = np.load(f'{OUT_DIR}/{scen}_zb.npy')
    msk = np.load(f'{OUT_DIR}/{scen}_msk.npy')
    active = msk == 1

    h_peak = ds.h.isel(time=peak_idx).values.astype('float32')
    ds.close()

    computed_peak = float(np.nanmax(np.where(active, h_peak, np.nan)))
    print(f'  computed peak from single-frame h[{peak_idx}]: {computed_peak:.4f}', flush=True)

    zs_peak = zb + h_peak

    np.save(f'{OUT_DIR}/{scen}_running_max.npy', h_peak)  # keep filename for 04's compatibility
    np.save(f'{OUT_DIR}/{scen}_zs_peak.npy', zs_peak)
    print(f'  wrote single-timestep depth/zs grids for {scen}', flush=True)

print('DONE', flush=True)
