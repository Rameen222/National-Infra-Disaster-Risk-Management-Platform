"""
Stage 1 of 2 for v5 building-impact precompute (see compute_building_impact_v5.py
for stage 2). Split into two separate script/process invocations deliberately:
rasterio and geopandas each bundle their OWN copy of GDAL, and loading both
into the same Python process on this Windows machine segfaults (confirmed -
crashed immediately on the first geopandas/exactextract call after rasterio
had already been used). Running them as separate processes sidesteps that
entirely - this script uses ONLY xarray/rasterio/numpy.

For each of the 4 mardan_v5_copernicus_30m scenarios, extracts the peak
depth grid directly from that scenario's own sfincs_map.nc `h` variable at
the timestep dashboard_png/manifest.json already established as its peak
frame (NOT the provided QGIS peak .tif exports, since the 100mm one is
flagged as a peak-EXTENT snapshot at t+1:00 rather than true peak-DEPTH at
t+4:15 - reading straight from the .nc for all 4 scenarios keeps them
computed the same consistent way).

Outputs (client/public/data/flood-mardan-v5/):
  peak_depth_rasters/<scenario>_depth.tif - peak depth (m), dry cells=0, out-of-domain=nodata
  peak_depth_rasters/<scenario>_wet.tif   - 1.0 where depth >= WET_THRESHOLD, else 0.0
  peak_depth_rasters/peak_meta.json       - per scenario: peak_idx, computed_peak,
                                             whether it matched the manifest's reported
                                             peakDepth, and the wet-extent UTM bbox
                                             (or null if nothing ever got wet)
"""
import json
import os

# The shell environment has PROJ_LIB/PROJ_DATA globally pinned to pyproj's
# bundled proj.db, which is a different/older version than the one
# rasterio's compiled GDAL/PROJ expects - causing a "DATABASE.LAYOUT
# .VERSION.MINOR" error the moment rasterio does a CRS lookup. Clearing the
# override lets rasterio fall back to its own internally-consistent bundled
# proj data instead of being forced onto a mismatched one.
os.environ.pop('PROJ_LIB', None)
os.environ.pop('PROJ_DATA', None)

import numpy as np
import rasterio
import xarray as xr
from rasterio.transform import Affine

MODEL_DIR = 'C:/NDMA/FLOOD_SIMULATION/mardan_v5_copernicus_30m'
DASHBOARD_MANIFEST = 'C:/NDMA/infra_portal/client/public/data/flood-mardan-v5/dashboard/manifest.json'
RASTER_OUT_DIR = 'C:/NDMA/infra_portal/client/public/data/flood-mardan-v5/peak_depth_rasters'

WET_THRESHOLD = 0.05  # matches sfincs.inp's huthresh/twet_threshold - the model's own wet/dry cutoff
PEAK_MATCH_TOLERANCE = 0.05  # metres - sanity check vs manifest's reported peakDepth


def read_inp(scen):
    inp = {}
    with open(f'{MODEL_DIR}/scenario_{scen}/sfincs.inp') as f:
        for line in f:
            if '=' in line:
                k, v = line.split('=', 1)
                inp[k.strip()] = v.strip()
    return inp


os.makedirs(RASTER_OUT_DIR, exist_ok=True)

with open(DASHBOARD_MANIFEST) as f:
    dash_manifest = json.load(f)

peak_meta = {}

for scen_info in dash_manifest['scenarios']:
    scen = scen_info['id']  # e.g. '050mm'
    peak_idx = len(scen_info['frames']) - 1
    peak_reported = scen_info['peakDepth']
    print(f'=== {scen}: peak_idx={peak_idx}, manifest peakDepth={peak_reported} ===', flush=True)

    ds = xr.open_dataset(f'{MODEL_DIR}/scenario_{scen}/sfincs_map.nc')
    msk = ds.msk.values
    active = msk == 1
    h_peak = ds.h.isel(time=peak_idx).values

    computed_peak = float(np.nanmax(np.where(active, h_peak, np.nan)))
    print(f'  computed peak from h[{peak_idx}]: {computed_peak:.3f}', flush=True)
    mismatch = abs(computed_peak - peak_reported) > PEAK_MATCH_TOLERANCE
    if mismatch:
        print(f'  !! MISMATCH beyond {PEAK_MATCH_TOLERANCE}m - re-check peak_idx assumption for {scen} before trusting this run', flush=True)

    depth = np.where(active, np.where(h_peak >= WET_THRESHOLD, h_peak, 0.0), np.nan).astype('float32')
    wet = np.where(active, (h_peak >= WET_THRESHOLD).astype('float32'), np.nan).astype('float32')
    ds.close()

    inp = read_inp(scen)
    x0, y0 = float(inp['x0']), float(inp['y0'])
    dx, dy = float(inp['dx']), float(inp['dy'])
    nmax, mmax = int(inp['nmax']), int(inp['mmax'])
    # row 0 in h is the SOUTH edge; GeoTIFFs are north-up, so flip vertically
    # and anchor the transform's origin at the NORTH-west corner.
    transform = Affine(dx, 0, x0, 0, -dy, y0 + nmax * dy)

    depth_path = f'{RASTER_OUT_DIR}/{scen}_depth.tif'
    wet_path = f'{RASTER_OUT_DIR}/{scen}_wet.tif'
    # tiled=True is required, not just a performance nicety - exactextract
    # (stage 2) segfaults reading an untiled/row-striped GeoTIFF (confirmed
    # by isolated reproduction: identical data, only the block layout
    # differed between a crashing and a working file).
    profile = dict(driver='GTiff', height=nmax, width=mmax, count=1, dtype='float32',
                    crs='EPSG:32643', transform=transform, nodata=np.nan, compress='deflate',
                    tiled=True, blockxsize=256, blockysize=256)
    with rasterio.open(depth_path, 'w', **profile) as dst:
        dst.write(np.flipud(depth), 1)
    with rasterio.open(wet_path, 'w', **profile) as dst:
        dst.write(np.flipud(wet), 1)
    print(f'  wrote {depth_path}, {wet_path}', flush=True)

    if computed_peak < WET_THRESHOLD:
        wet_bbox_utm = None
    else:
        rows_wet, cols_wet = np.where(wet == 1)
        y_top = y0 + nmax * dy
        ys_utm = y_top - rows_wet * dy
        xs_utm = x0 + cols_wet * dx
        pad = 500  # metres of buffer around the wet extent bbox
        wet_bbox_utm = [float(xs_utm.min() - pad), float(ys_utm.min() - pad),
                         float(xs_utm.max() + pad), float(ys_utm.max() + pad)]
        print(f'  wet-extent bbox (UTM, +{pad}m pad): {wet_bbox_utm}', flush=True)

    peak_meta[scen] = {
        'peak_idx': peak_idx,
        'computed_peak': round(computed_peak, 4),
        'reported_peak': peak_reported,
        'mismatch': mismatch,
        'wet_bbox_utm': wet_bbox_utm,
        'depth_path': depth_path,
        'wet_path': wet_path,
    }

with open(f'{RASTER_OUT_DIR}/peak_meta.json', 'w') as f:
    json.dump(peak_meta, f, indent=2)
print('done. peak_meta.json written to', f'{RASTER_OUT_DIR}/peak_meta.json', flush=True)
