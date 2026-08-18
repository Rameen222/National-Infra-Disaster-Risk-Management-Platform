"""
Step 3 of the v5 building-impact pipeline: compute the TRUE per-cell peak
depth over the full run, for each of the 4 scenarios.

SFINCS's own `hmax` is NOT a reliable full-run peak grid for this dataset -
confirmed directly: the 100mm run's hmax has only 2 snapshots (interval0:
817,761 non-NaN cells, interval1: 85,862), so a cell that peaked in one
interval and a cell that peaked in the other can't both be captured
correctly by either single snapshot. Streaming a running max over every
native 15-min timestep of `h` instead gives the real per-cell peak,
regardless of when each cell individually peaked.

Memory-safe: never loads the full h array (each scenario's is ~3.7GB) -
reads one 2D timestep slice at a time and keeps only the running 2D max.

Outputs (per scenario, client/public/data/flood-mardan-v5/peak_grids/):
  <scenario>_running_max.npy - float32 (nmax, mmax), true per-cell peak depth (m)
  <scenario>_zs_peak.npy     - float32 (nmax, mmax), zb + running_max (peak water surface elevation, m)
  <scenario>_zb.npy          - float32 (nmax, mmax), terrain elevation (m) - same across scenarios, saved per-scenario for simplicity
  <scenario>_msk.npy         - float32 (nmax, mmax), SFINCS active-cell mask
"""
import os
import time

os.environ.pop('PROJ_LIB', None)
os.environ.pop('PROJ_DATA', None)

import numpy as np
import xarray as xr

MODEL_DIR = 'C:/NDMA/FLOOD_SIMULATION/mardan_v5_copernicus_30m'
SCENARIOS = ['050mm', '100mm', '150mm', '200mm']
OUT_DIR = 'C:/NDMA/infra_portal/client/public/data/flood-mardan-v5/peak_grids'

os.makedirs(OUT_DIR, exist_ok=True)

for scen in SCENARIOS:
    print(f'=== {scen} ===', flush=True)
    t0 = time.time()
    ds = xr.open_dataset(f'{MODEL_DIR}/scenario_{scen}/sfincs_map.nc')
    n_time = ds.sizes['time']
    nmax, mmax = ds.sizes['n'], ds.sizes['m']
    zb = ds.zb.values.astype('float32')
    msk = ds.msk.values.astype('float32')
    print(f'  opened: {time.time()-t0:.1f}s, grid=({nmax},{mmax}), n_time={n_time}', flush=True)

    t0 = time.time()
    running_max = np.zeros((nmax, mmax), dtype='float32')
    for i in range(n_time):
        h_t = ds.h.isel(time=i).values.astype('float32')
        np.maximum(running_max, h_t, out=running_max)
        if (i + 1) % 50 == 0 or i == n_time - 1:
            print(f'  timestep {i+1}/{n_time}, running max so far={running_max.max():.3f} ({time.time()-t0:.1f}s elapsed)', flush=True)
    ds.close()
    print(f'  streaming running-max done: {time.time()-t0:.1f}s, final peak={running_max.max():.4f}', flush=True)

    zs_peak = zb + running_max

    np.save(f'{OUT_DIR}/{scen}_running_max.npy', running_max)
    np.save(f'{OUT_DIR}/{scen}_zs_peak.npy', zs_peak)
    np.save(f'{OUT_DIR}/{scen}_zb.npy', zb)
    np.save(f'{OUT_DIR}/{scen}_msk.npy', msk)
    print(f'  wrote outputs for {scen}', flush=True)

print('ALL SCENARIOS DONE', flush=True)
