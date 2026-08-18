"""
One-time preprocessing: convert the SFINCS Mardan flood model output into
web-renderable PNG overlays for the Flood Simulation page.

The SFINCS grid is a regular, non-rotated 150m raster in EPSG:32643 (523 x
552 cells) - so instead of reprojecting/resampling with GDAL, we just
compute the 4 corner coordinates in WGS84 and hand Mapbox GL's `image`
source the raw pixel grid directly as a georeferenced quad. Zero resampling,
pixel-accurate.

Outputs (client/public/data/flood-mardan/sfincs/):
  terrain_dem.png       - hypsometric elevation tint (static, shared)
  terrain_hillshade.png - shaded relief overlay (static, shared)
  <scenario>/frame_###.png - depth-colored, transparent where dry
  manifest.json          - corner coords + scenario/frame list + color scale
"""
import numpy as np
import xarray as xr
from PIL import Image
from pyproj import Transformer
from matplotlib.colors import LightSource
import matplotlib.cm as cm
import json
import os

MODEL_DIR = 'C:/NDMA/FLOOD_SIMULATION/mardan_full_real_model_FILLED_v2'
SCENARIOS = ['050mm', '100mm', '150mm', '200mm']
OUT_DIR = 'C:/NDMA/infra_portal/client/public/data/flood-mardan/sfincs'
FRAME_STRIDE = 3  # every 3rd of the 121 timesteps -> ~41 frames/scenario
DRY_THRESHOLD = 0.03  # metres - below this, treat as dry/transparent

# Fixed absolute depth scale shared across all 4 scenarios/frames so
# severity is visually comparable as the precipitation slider moves —
# auto-scaling per-scenario would make a 50mm puddle look as "severe" as a
# 200mm flood.
DEPTH_STOPS = [
    (0.03, (198, 219, 239, 0)),
    (0.10, (198, 219, 239, 120)),
    (0.30, (158, 202, 225, 170)),
    (1.00, (66, 146, 198, 200)),
    (3.00, (33, 94, 168, 220)),
    (8.00, (8, 48, 107, 235)),
    (20.0, (30, 10, 60, 245)),
]

os.makedirs(OUT_DIR, exist_ok=True)


def depth_to_rgba(depth):
    """Vectorized piecewise-linear color ramp with alpha, NaN/dry -> transparent."""
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


def corner_quad(x, y):
    """4 corners of the pixel grid (cell-center coords -> outer edge), UTM -> WGS84."""
    cell = 150.0
    xmin, xmax = float(x.min()) - cell / 2, float(x.max()) + cell / 2
    ymin, ymax = float(y.min()) - cell / 2, float(y.max()) + cell / 2
    tf = Transformer.from_crs('EPSG:32643', 'EPSG:4326', always_xy=True)
    nw = tf.transform(xmin, ymax)
    ne = tf.transform(xmax, ymax)
    se = tf.transform(xmax, ymin)
    sw = tf.transform(xmin, ymin)
    return [[nw[0], nw[1]], [ne[0], ne[1]], [se[0], se[1]], [sw[0], sw[1]]]


print('opening reference scenario for static terrain layers...')
ds0 = xr.open_dataset(f'{MODEL_DIR}/scenario_200mm/sfincs_map.nc')
zb = ds0.zb.values  # (n, m), row 0 = south
quad = corner_quad(ds0.x.values, ds0.y.values)
print('corner quad (WGS84):', quad)

# ── Static DEM color (hypsometric tint) ──────────────────────────────────
zmin, zmax = float(np.nanmin(zb)), float(np.nanmax(zb))
norm = np.clip((zb - zmin) / (zmax - zmin), 0, 1)
terrain_cmap = cm.get_cmap('terrain')
dem_rgba = (terrain_cmap(norm) * 255).astype(np.uint8)
dem_img = Image.fromarray(np.flipud(dem_rgba), 'RGBA')
dem_img.save(f'{OUT_DIR}/terrain_dem.png')
print('wrote terrain_dem.png', dem_img.size)

# ── Static hillshade (alpha-composited relief, no true blend modes in GL) ─
ls = LightSource(azdeg=315, altdeg=45)
hs = ls.hillshade(zb, vert_exag=3, dx=150, dy=150)  # 0..1
delta = hs - 0.5
alpha = np.clip(np.abs(delta) * 2.2, 0, 1) * 190
tone = np.where(delta >= 0, 255, 0).astype(np.uint8)
hs_rgba = np.stack([tone, tone, tone, alpha.astype(np.uint8)], axis=-1)
hs_img = Image.fromarray(np.flipud(hs_rgba), 'RGBA')
hs_img.save(f'{OUT_DIR}/terrain_hillshade.png')
print('wrote terrain_hillshade.png', hs_img.size)
ds0.close()

# ── Per-scenario, time-animated flood depth frames ───────────────────────
manifest = {
    'corners': quad,
    'depthStops': [{'depth': d, 'rgba': list(c)} for d, c in DEPTH_STOPS],
    'dryThreshold': DRY_THRESHOLD,
    'scenarios': [],
}

for scen in SCENARIOS:
    path = f'{MODEL_DIR}/scenario_{scen}/sfincs_map.nc'
    ds = xr.open_dataset(path)
    times = ds.time.values
    idxs = list(range(0, len(times), FRAME_STRIDE))
    if idxs[-1] != len(times) - 1:
        idxs.append(len(times) - 1)  # always include the final frame

    scen_dir = f'{OUT_DIR}/{scen}'
    os.makedirs(scen_dir, exist_ok=True)
    frames = []
    for fi, ti in enumerate(idxs):
        depth = ds.h.isel(time=ti).values
        depth = np.where(depth < DRY_THRESHOLD, np.nan, depth)
        rgba = depth_to_rgba(depth)
        img = Image.fromarray(np.flipud(rgba), 'RGBA')
        fname = f'frame_{fi:03d}.png'
        img.save(f'{scen_dir}/{fname}')
        max_depth = float(np.nanmax(depth)) if np.any(~np.isnan(depth)) else 0.0
        frames.append({
            'file': f'{scen}/{fname}',
            'time': str(times[ti]),
            'maxDepth': round(max_depth, 3),
        })
        print(f'  {scen} frame {fi}/{len(idxs)-1} (t={ti}) maxDepth={max_depth:.2f}m')

    manifest['scenarios'].append({
        'id': scen,
        'mm': int(scen.replace('mm', '')),
        'frames': frames,
    })
    ds.close()

with open(f'{OUT_DIR}/manifest.json', 'w') as f:
    json.dump(manifest, f)
print('done. manifest written to', f'{OUT_DIR}/manifest.json')
