"""
Flood Vulnerability V2 (Kalpani/FLOOD_SIMULATION_FINAL) - depth raster PNG,
one per scenario.

This dataset's sfincs_map.nc has no hmax/h variable at all (a different
SFINCS build than the Mardan v5 project) - only zsmax (peak WATER SURFACE
ELEVATION, timemax=4 daily running-max snapshots) and zb (bed elevation).
Depth = max_over_timemax(zsmax) - zb, clipped >=0, masked by msk==1.

Georeferencing: same real per-pixel UTM->WGS84->Web-Mercator inverse warp
FloodVulnerabilityPage.jsx's renderHmaxTiff() already does client-side (a
naive 4-corner quad was measured to drift up to 66m on a same-sized grid -
this dataset's domain is a similar size, so the same risk applies). Done
here once, server-side, so the frontend can just swap a pre-baked PNG per
scenario instead of fetching+decoding+warping a GeoTIFF live.

Output:
  client/public/data/flood-vulnerability-v2/rasters/<scenario>_depth.png
  client/public/data/flood-vulnerability-v2/depth_manifest.json
"""
import json
import os

os.environ.pop('PROJ_LIB', None)
os.environ.pop('PROJ_DATA', None)

import numpy as np
import xarray as xr
from PIL import Image
from pyproj import Transformer

FLOOD_ROOT = 'C:/NDMA/FLOOD_SIMULATION_FINAL'
OUT_DIR = 'C:/NDMA/infra_portal/client/public/Data_2'
RASTER_DIR = f'{OUT_DIR}/rasters'
os.makedirs(RASTER_DIR, exist_ok=True)

SCENARIOS = [
    ('event_2006', '5 Aug 2006 (validation event)', 'Historical events'),
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

# Same ramp as FloodVulnerabilityPage.jsx's HMAX_RAMP_STOPS
RAMP = [(222, 235, 247), (107, 174, 214), (33, 113, 181), (8, 48, 107)]

UTM43 = 'EPSG:32643'
WGS84 = 'EPSG:4326'
MERC = 'EPSG:3857'
OUT_W = 1600  # matches renderHmaxTiff's HMAX_RENDER_WIDTH_PX


def ramp_color(t):
    t = np.clip(t, 0.0, 1.0)
    n = len(RAMP)
    stops = np.array(RAMP, dtype=np.float32)
    c = t * (n - 1)
    idx = np.clip(c.astype(int), 0, n - 2)
    frac = (c - idx)[..., None]
    c0 = stops[idx]
    c1 = stops[idx + 1]
    return (c0 + (c1 - c0) * frac).astype(np.uint8)


to_wgs = Transformer.from_crs(UTM43, WGS84, always_xy=True)
to_merc = Transformer.from_crs(WGS84, MERC, always_xy=True)
merc_inv = Transformer.from_crs(MERC, WGS84, always_xy=True)
to_utm = Transformer.from_crs(WGS84, UTM43, always_xy=True)

manifest = {'corners': None, 'scenarios': []}
shared_bounds = None

for scen, label, category in SCENARIOS:
    print(f'=== {scen} ===', flush=True)
    nc_path = f'{FLOOD_ROOT}/scenarios/{scen}/sfincs_map.nc'
    ds = xr.open_dataset(nc_path)
    zb = ds.zb.values
    zsmax = ds.zsmax.values  # (timemax, n, m)
    msk = ds.msk.values
    cx = ds.corner_x.values
    cy = ds.corner_y.values
    ds.close()

    depth = np.nanmax(zsmax, axis=0) - zb
    depth = np.clip(depth, 0, None)
    depth = np.where(msk == 1, depth, np.nan)

    valid = np.isfinite(depth)
    has_data = bool(valid.any())
    if has_data:
        mn, mx = (float(v) for v in np.percentile(depth[valid], [2, 98]))
    else:
        mn = mx = None
    print(f'  depth valid cells: {int(valid.sum())}, 2-98pct stretch: {mn}/{mx}', flush=True)

    # Grid transform - plain axis-aligned UTM grid (confirmed via corner_x/
    # corner_y being flat/identical across rows/cols).
    x0, y0 = float(cx[0, 0]), float(cy[0, 0])
    sx = float(cx[0, 1] - cx[0, 0])
    sy = float(cy[1, 0] - cy[0, 0])
    n_rows, m_cols = depth.shape

    bounds_utm = (x0, y0, x0 + m_cols * sx, y0 + n_rows * sy)
    if shared_bounds is None:
        shared_bounds = bounds_utm
    else:
        drift = max(abs(a - b) for a, b in zip(bounds_utm, shared_bounds))
        if drift > 1.0:
            print(f'  WARNING: grid bounds differ from first scenario by {drift:.2f}m', flush=True)

    if manifest['corners'] is None:
        left, bottom, right, top = min(x0, x0 + m_cols * sx), min(y0, y0 + n_rows * sy), \
            max(x0, x0 + m_cols * sx), max(y0, y0 + n_rows * sy)
        corners_utm = [(left, top), (right, top), (right, bottom), (left, bottom)]
        merc_pts = [to_merc.transform(*to_wgs.transform(x, y)) for x, y in corners_utm]
        mx1 = min(p[0] for p in merc_pts)
        mx2 = max(p[0] for p in merc_pts)
        my1 = min(p[1] for p in merc_pts)
        my2 = max(p[1] for p in merc_pts)
        out_h = max(1, round(OUT_W * (my2 - my1) / (mx2 - mx1)))

        col_x = mx1 + (np.arange(OUT_W) + 0.5) / OUT_W * (mx2 - mx1)
        row_y = my2 - (np.arange(out_h) + 0.5) / out_h * (my2 - my1)
        col_lon, _ = merc_inv.transform(col_x, np.zeros_like(col_x))
        _, row_lat = merc_inv.transform(np.zeros_like(row_y), row_y)

        lon_grid, lat_grid = np.meshgrid(col_lon, row_lat)
        ux_grid, uy_grid = to_utm.transform(lon_grid, lat_grid)

        manifest['corners'] = [list(merc_inv.transform(mx1, my2)), list(merc_inv.transform(mx2, my2)),
                                list(merc_inv.transform(mx2, my1)), list(merc_inv.transform(mx1, my1))]
        print(f'  computed shared output grid: {OUT_W}x{out_h}, corners={manifest["corners"]}', flush=True)

    # Sample source depth at each output pixel's UTM position (nearest).
    col_idx = np.floor((ux_grid - x0) / sx).astype(int)
    row_idx = np.floor((uy_grid - y0) / sy).astype(int)
    in_bounds = (row_idx >= 0) & (row_idx < n_rows) & (col_idx >= 0) & (col_idx < m_cols)
    sampled = np.full(ux_grid.shape, np.nan, dtype=np.float32)
    sampled[in_bounds] = depth[row_idx[in_bounds], col_idx[in_bounds]]

    rgba = np.zeros((*sampled.shape, 4), dtype=np.uint8)
    ok = np.isfinite(sampled)
    if has_data and ok.any():
        t = (sampled[ok] - mn) / max(mx - mn, 1e-6)
        rgba[ok, :3] = ramp_color(t)
    rgba[..., 3] = np.where(ok, 255, 0).astype(np.uint8)

    img = Image.fromarray(rgba, 'RGBA')
    fname = f'{scen}_depth.png'
    img.save(f'{RASTER_DIR}/{fname}', optimize=True)
    print(f'  wrote {fname}', flush=True)

    manifest['scenarios'].append({
        'id': scen, 'label': label, 'category': category, 'file': f'rasters/{fname}',
        'min': round(mn, 3) if mn is not None else None,
        'max': round(mx, 3) if mx is not None else None,
    })

with open(f'{OUT_DIR}/depth_manifest.json', 'w') as f:
    json.dump(manifest, f)
print('\nDONE. manifest written to', f'{OUT_DIR}/depth_manifest.json', flush=True)
