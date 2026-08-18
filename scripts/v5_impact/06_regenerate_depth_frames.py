"""
Regenerates the v5 "Flood depth" animation frame PNGs
(client/public/data/flood-mardan-v5/dashboard/<scenario>/frame_###.png) with
a purely per-pixel color ramp - no blur/smoothing pass, no resampling. Each
pixel is colored strictly from its OWN cell's depth value, independent of
its neighbors, at the model's native 30m resolution (2055x2333, 1:1 with
the grid used everywhere else in this pipeline - no upscale/downscale).

Why: building impact classification (04_aggregate_impact.py) already reads
the raw per-cell depth array directly and was never affected by how the
PNG looked - but the PNG itself carried some kind of smoothing that made a
building's rendered position look like it sat outside water the data said
it was standing in. This uses the exact same depth_to_rgba approach as the
original 2D page's process_sfincs_mardan.py (confirmed to have zero
cross-pixel blur - a piecewise-linear ramp applied to each pixel in
isolation), just pointed at v5's own model/grid/frame list instead.

Reuses the color scale and frame list already committed in
dashboard/manifest.json (depthStops, dryThreshold, per-scenario frame
count/timestamps) - only the PNG pixel content changes, manifest.json is
left untouched.
"""
import json
import os

os.environ.pop('PROJ_LIB', None)
os.environ.pop('PROJ_DATA', None)

import numpy as np
import xarray as xr
from PIL import Image

MODEL_DIR = 'C:/NDMA/FLOOD_SIMULATION/mardan_v5_copernicus_30m'
OUT_DIR = 'C:/NDMA/infra_portal/client/public/data/flood-mardan-v5/dashboard'
MANIFEST_PATH = f'{OUT_DIR}/manifest.json'

with open(MANIFEST_PATH) as f:
    manifest = json.load(f)

DRY_THRESHOLD = manifest['dryThreshold']
DEPTH_STOPS = [(s['depth'], tuple(s['rgba'])) for s in manifest['depthStops']]
# Bakes hard cell edges directly into the pixel data via nearest-neighbor
# upscale (each 30m cell becomes an UPSCALE x UPSCALE solid block), instead
# of relying on Mapbox's raster-resampling paint property - confirmed (dev
# server fully restarted, not just browser-refreshed) that setting alone
# does not produce sharp edges for this type:'image' source, so it can't be
# trusted as the only fix.
#
# This was tried, reverted over a misjudged size concern, and is being
# reinstated: what matters isn't the total folder size (all frames sitting
# on disk) but the PER-REQUEST size, since the frontend only ever fetches
# one frame at a time via updateImage(). At UPSCALE=3 the worst-case single
# frame is ~4.6MB vs ~3.4MB at native res - a small difference, not the
# problem the earlier revert treated it as.
UPSCALE = 3


def depth_to_rgba(depth):
    """Vectorized piecewise-linear color ramp with alpha, NaN/dry -> transparent.
    Same function as process_sfincs_mardan.py's - each pixel colored purely
    from its own value, no neighbor averaging anywhere in this."""
    h, w = depth.shape
    rgba = np.zeros((h, w, 4), dtype=np.uint8)
    d = np.nan_to_num(depth, nan=0.0)
    stops = [(0.0, (198, 219, 239, 0))] + DEPTH_STOPS
    for i in range(len(stops) - 1):
        d0, c0 = stops[i]
        d1, c1 = stops[i + 1]
        mask = (d >= d0) & (d < d1)
        if not mask.any():
            continue
        t = ((d[mask] - d0) / (d1 - d0))[:, None]
        c0a = np.array(c0, dtype=np.float32)
        c1a = np.array(c1, dtype=np.float32)
        rgba[mask] = (c0a * (1 - t) + c1a * t).astype(np.uint8)
    rgba[d >= stops[-1][0]] = stops[-1][1]
    return rgba


for scen_info in manifest['scenarios']:
    scen = scen_info['id']
    n_frames = len(scen_info['frames'])
    print(f'=== {scen}: regenerating {n_frames} frames ===', flush=True)

    ds = xr.open_dataset(f'{MODEL_DIR}/scenario_{scen}/sfincs_map.nc')
    msk = ds.msk.values
    active = msk == 1

    scen_dir = f'{OUT_DIR}/{scen}'
    for fi in range(n_frames):
        depth = ds.h.isel(time=fi).values
        depth = np.where(active & (depth >= DRY_THRESHOLD), depth, np.nan)
        rgba = depth_to_rgba(depth)
        # row 0 in h is the SOUTH edge; PNGs are north-up, so flip vertically -
        # same convention as every other raster export in this pipeline.
        img = Image.fromarray(np.flipud(rgba), 'RGBA')
        img = img.resize((img.width * UPSCALE, img.height * UPSCALE), Image.NEAREST)
        fname = f'{scen_dir}/frame_{fi:03d}.png'
        img.save(fname, optimize=True)

    ds.close()
    print(f'  wrote {n_frames} frames to {scen_dir}/', flush=True)

print('DONE - manifest.json unchanged, only frame PNG pixel content replaced', flush=True)
