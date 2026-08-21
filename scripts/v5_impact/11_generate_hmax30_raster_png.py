"""
Server-side PNG generation for the raw hmax band-1 (30h) layer, replacing
the client-side geotiff.js+canvas+data-URI rendering path.

Why: that client-side path was the ONE structurally different, never-
directly-tested piece of the vulnerability page's raster pipeline (every
other layer - DEM colour, hillshade - uses a plain server-generated PNG
file served as a regular URL, and those render correctly). A user-verified
reference point (hmax=13.34m, independently confirmed correct 3 separate
ways) rendered in the wrong screen position on web while QGIS showed it
correctly at the same coordinates - strong evidence the bug is specific to
that client-side image-source path, not the data or its georeferencing
(both were independently verified correct multiple times).

This script reads hmax band 1 straight from each scenario's .nc (same
source as everywhere else this session), colorizes it exactly like the
browser did (same ramp, stretched to that scenario's own min/max), bakes
sharp edges via nearest-neighbor upscale (same proven technique as
DEM/hillshade), and writes a real PNG file - served the same proven way.

Output:
  client/public/data/flood-vulnerability/rasters/<scenario>_hmax30.png
  client/public/data/flood-vulnerability/hmax30_manifest.json
    {corners, scenarios: [{id, mm, file, min, max}]}
"""
import json
import os

os.environ.pop('PROJ_LIB', None)
os.environ.pop('PROJ_DATA', None)

import numpy as np
import xarray as xr
from PIL import Image

FLOOD_ROOT = 'C:/NDMA/FLOOD_SIMULATION/mardan_v5_copernicus_30m'
SCENARIOS = ['050mm', '100mm', '150mm', '200mm']

V5_DASHBOARD_MANIFEST = 'C:/NDMA/infra_portal/client/public/data/flood-mardan-v5/dashboard/manifest.json'
OUT_DIR = 'C:/NDMA/infra_portal/client/public/data/flood-vulnerability'
RASTER_DIR = f'{OUT_DIR}/rasters'
UPSCALE = 3  # same factor already proven necessary for sharp edges on this page's other raster

# same ramp used client-side (HMAX_RAMP_STOPS in FloodVulnerabilityPage.jsx)
RAMP = [(222, 235, 247), (107, 174, 214), (33, 113, 181), (8, 48, 107)]

os.makedirs(RASTER_DIR, exist_ok=True)

with open(V5_DASHBOARD_MANIFEST) as f:
    CORNERS = json.load(f)['corners']


def ramp_color(t):
    t = max(0.0, min(1.0, t))
    n = len(RAMP)
    c = t * (n - 1)
    i = min(n - 2, int(c))
    frac = c - i
    a, b = RAMP[i], RAMP[i + 1]
    return tuple(int(a[k] + (b[k] - a[k]) * frac) for k in range(3))


manifest = {'corners': CORNERS, 'scenarios': []}

for scen in SCENARIOS:
    print(f'=== {scen} ===', flush=True)
    ds = xr.open_dataset(f'{FLOOD_ROOT}/scenario_{scen}/sfincs_map.nc')
    hmax_b1 = ds.hmax.values[0]  # (n, m), NaN where never wetted - matches .tif band1 exactly
    ds.close()

    valid = np.isfinite(hmax_b1)
    has_data = bool(valid.any())
    true_min = float(np.nanmin(hmax_b1)) if has_data else None
    true_max = float(np.nanmax(hmax_b1)) if has_data else None
    # 2-98 percentile stretch, not raw min/max - a handful of extreme-depth
    # channel cells were dominating the whole color range, squeezing the
    # vast majority of actually-flooded cells (which are far shallower)
    # into a near-indistinguishable pale sliver. Values above p98 clip to
    # the darkest color instead of getting their own unique shade.
    if has_data:
        mn, mx = (float(v) for v in np.percentile(hmax_b1[valid], [2, 98]))
    else:
        mn = mx = None
    print(f'  true min/max={true_min}/{true_max}  2-98pct stretch={mn}/{mx}', flush=True)

    h, w = hmax_b1.shape
    rgba = np.zeros((h, w, 4), dtype=np.uint8)
    if has_data:
        rng = max(mx - mn, 1e-6)
        t = np.clip((hmax_b1 - mn) / rng, 0, 1)
        stops = np.array(RAMP, dtype=np.float32)
        n = len(RAMP)
        idx = np.clip((t * (n - 1)).astype(int), 0, n - 2)
        frac = (t * (n - 1)) - idx
        c0 = stops[idx]
        c1 = stops[idx + 1]
        col = c0 + (c1 - c0) * frac[..., None]
        rgba[..., :3] = np.nan_to_num(col, nan=0.0).astype(np.uint8)
    rgba[..., 3] = np.where(valid, 255, 0).astype(np.uint8)

    # SFINCS native row 0 = south -> flip to north-up for the PNG, same
    # convention as every other raster export in this pipeline (matches
    # what sfincs_hmax_to_geotiff.py does for the .tif, and what
    # 08_generate_vulnerability_raster.py already did for running_max).
    img = Image.fromarray(np.flipud(rgba), 'RGBA')
    img = img.resize((img.width * UPSCALE, img.height * UPSCALE), Image.NEAREST)
    fname = f'{scen}_hmax30.png'
    img.save(f'{RASTER_DIR}/{fname}', optimize=True)
    print(f'  wrote {fname}', flush=True)

    manifest['scenarios'].append({
        'id': scen, 'mm': int(scen.replace('mm', '')), 'file': f'rasters/{fname}',
        'min': round(mn, 4) if mn is not None else None,
        'max': round(mx, 4) if mx is not None else None,
    })

with open(f'{OUT_DIR}/hmax30_manifest.json', 'w') as f:
    json.dump(manifest, f)
print('\nDONE. manifest written to', f'{OUT_DIR}/hmax30_manifest.json', flush=True)
