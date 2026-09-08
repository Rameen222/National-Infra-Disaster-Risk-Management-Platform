"""
Flood Vulnerability V2 - FINAL data (rerun_hmax) - depth raster PNG, one per
scenario.

Source: C:/NDMA/FLOOD_SIMULATION_FINAL/rerun_hmax/buildings_flood_depth_classes/
rasters/<scenario>_hmax_peak.tif - the DELIVERED peak-depth GeoTIFFs of the
SFINCS rerun with native depth output (storehsubgrid hmax = zsmax - z_zmin,
nanmax over all timemax bands). Reading these tifs (instead of recomputing
from sfincs_map.nc like 01_generate_depth_raster_png.py did for the old
zsmax-derived dataset) guarantees the rendered raster is pixel-identical to
the surface the per-building analysis actually used.

Grid: native 100m SFINCS computational grid, EPSG:32643, identical across all
11 scenarios (asserted). Active-domain mask comes from each scenario's own
sfincs_map.nc 'msk' variable (inactive cells -> transparent PNG), verified to
sit on the exact same grid as the tifs.

Georeferencing: same real per-pixel UTM->WGS84->Web-Mercator inverse warp as
01_generate_depth_raster_png.py (naive 4-corner quad drifts up to ~66m).

Output:
  client/public/Data_2/Data_2_final/rasters/<scenario>_depth.png
  client/public/Data_2/Data_2_final/depth_manifest.json
"""
import json
import os

os.environ.pop('PROJ_LIB', None)
os.environ.pop('PROJ_DATA', None)

import numpy as np
import rasterio
import xarray as xr
from PIL import Image
from pyproj import Transformer

RERUN_ROOT = 'C:/NDMA/FLOOD_SIMULATION_FINAL/rerun_hmax'
TIF_DIR = f'{RERUN_ROOT}/buildings_flood_depth_classes/rasters'
OUT_DIR = 'C:/NDMA/infra_portal/client/public/Data_2/Data_2_final'
RASTER_DIR = f'{OUT_DIR}/rasters'
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

# Same ramp as FloodVulnerabilityPage.jsx's HMAX_RAMP_STOPS / the v2 page's
# DEPTH_RAMP_STOPS.
RAMP = [(222, 235, 247), (107, 174, 214), (33, 113, 181), (8, 48, 107)]

UTM43 = 'EPSG:32643'
WGS84 = 'EPSG:4326'
MERC = 'EPSG:3857'
OUT_W = 1600


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
shared_grid = None
shared_msk = None

for scen, label, category in SCENARIOS:
    print(f'=== {scen} ===', flush=True)
    tif_path = f'{TIF_DIR}/{scen}_hmax_peak.tif'
    with rasterio.open(tif_path) as src:
        assert src.crs.to_epsg() == 32643, f'unexpected CRS for {tif_path}'
        depth_tif = src.read(1).astype(np.float32)
        a = src.transform
        x0, y0_top = a.c, a.f
        sx, sy = a.a, a.e  # sy negative (north-up)
        n_rows, m_cols = src.shape

    grid = (x0, y0_top + n_rows * sy, sx, -sy, n_rows, m_cols)
    if shared_grid is None:
        shared_grid = grid
    else:
        assert grid == shared_grid, f'{scen}: tif grid {grid} != {shared_grid}'

    ds = xr.open_dataset(f'{RERUN_ROOT}/scenarios/{scen}/sfincs_map.nc')
    cx = ds.corner_x.values
    cy = ds.corner_y.values
    nc_grid = (float(cx[0, 0]), float(cy[0, 0]),
               float(cx[0, 1] - cx[0, 0]), float(cy[1, 0] - cy[0, 0]),
               int(ds.msk.shape[0]), int(ds.msk.shape[1]))
    assert nc_grid == grid, f'{scen}: nc grid {nc_grid} != tif grid {grid}'
    msk = (ds.msk.values == 1)
    ds.close()
    if shared_msk is None:
        shared_msk = msk
    else:
        assert np.array_equal(msk, shared_msk), f'{scen}: active mask differs between scenarios'

    depth = np.where(shared_msk, depth_tif, np.nan)
    valid = np.isfinite(depth)
    mn, mx = (float(v) for v in np.percentile(depth[valid], [2, 98]))
    print(f'  active cells: {int(valid.sum())}, 2-98pct stretch: {mn:.3f}/{mx:.3f}, '
          f'grid max: {float(np.nanmax(depth)):.3f}', flush=True)

    # Shared mercator output grid from the first scenario's UTM bounds.
    left, bottom = x0, y0_top + n_rows * sy
    right, top = x0 + m_cols * sx, y0_top
    if manifest['corners'] is None:
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
        print(f'  computed shared output grid: {OUT_W}x{out_h}', flush=True)

    col_idx = np.floor((ux_grid - x0) / sx).astype(int)
    row_idx = np.floor((top - uy_grid) / (-sy)).astype(int)
    in_bounds = (row_idx >= 0) & (row_idx < n_rows) & (col_idx >= 0) & (col_idx < m_cols)
    sampled = np.full(ux_grid.shape, np.nan, dtype=np.float32)
    sampled[in_bounds] = depth[row_idx[in_bounds], col_idx[in_bounds]]

    # NOTE: this script does NOT pre-colorize a display PNG (an earlier
    # version did, writing '<scen>_depth.png' - that PNG was never actually
    # used: FloodVulnerabilityV2Page.jsx's renderFinalRaster() fetches
    # `file` as a raw GeoTIFF via GeoTIFF.fromArrayBuffer() and does its own
    # client-side warp + colour classification using the scale built from
    # min/max below. Pointing `file` at the PNG instead of the .tif broke
    # the Building Exposure page entirely ("Invalid byte order value" -
    # geotiff.js choking on a PNG). `file` MUST stay the .tif; min/max are
    # the only things this script should be correcting.
    manifest['scenarios'].append({
        'id': scen, 'label': label, 'category': category, 'file': f'rasters/{scen}_hmax_peak.tif',
        'min': round(mn, 3),
        'max': round(mx, 3),
    })

with open(f'{OUT_DIR}/depth_manifest.json', 'w') as f:
    json.dump(manifest, f)
print('\nDONE. manifest written to', f'{OUT_DIR}/depth_manifest.json', flush=True)
