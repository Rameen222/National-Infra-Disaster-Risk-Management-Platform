"""
Flood Vulnerability V2 - combined depth+velocity hazard zones, 3 classes,
ONE fixed scheme applied identically across all 11 scenarios.

Why a fixed formula instead of a percentile stretch per scenario (see
flood-v2-roadmap/CHECKLIST.md, item 2): a percentile of one scenario's own
distribution means something different every time - P90 of a light-rain
scenario and P90 of design_T100 are both "P90" but physically very
different. World practice for "is this location hazardous" is a fixed,
physically-anchored scale applied the same way everywhere, not a per-run
percentile - see the UK Environment Agency / Defra "Flood Risks to People"
hazard-to-people rating (Ramsbottom et al., 2003), used here:

    HR = depth * (velocity + 0.5) + DF

DF (debris factor) defaults to 0.5 here - a standard, simplifying default
for developed/urban areas where floating debris is plausible, not derived
from this watershed specifically. Treat it as a tunable parameter, not a
measured constant.

3 zones (this project's simplified cut of the EA's usual 4-class scheme):
    Low       HR < 0.75   - caution
    Moderate  0.75-1.5    - dangerous for some (children, elderly, vehicles)
    High      >= 1.5      - dangerous for most/all, including able-bodied adults

Inputs: same sfincs_map.nc hmax/vmax as 08_generate_velocity_peak_raster.py,
with the IDENTICAL artifact fix applied (the confirmed bad cell + the
shallow-supersonic safety net) - a hazard layer must not inherit a bug
already fixed in the velocity layer.

Output:
  client/public/Data_2/Data_2_final/rasters/<scenario>_hazard.png
  client/public/Data_2/Data_2_final/hazard_manifest.json
    {breaks, colors, corners, scenarios: [{id, zone_area_km2: {low,moderate,high}}]}

Not yet wired into the frontend - see flood-v2-roadmap/CHECKLIST.md item 2
for the remaining FloodVulnerabilityV2Page.jsx work.
"""
import json
import os

os.environ.pop('PROJ_LIB', None)
os.environ.pop('PROJ_DATA', None)

import numpy as np
import xarray as xr
from PIL import Image
from pyproj import Transformer

RERUN_ROOT = 'C:/NDMA/FLOOD_SIMULATION_FINAL/rerun_hmax/scenarios'
OUT_DIR = 'C:/NDMA/infra_portal/client/public/Data_2/Data_2_final'
RASTER_DIR = f'{OUT_DIR}/rasters'
os.makedirs(RASTER_DIR, exist_ok=True)

SCENARIOS = [
    ('event_2006', '5 Aug 2006 (validation event)', 'Historical events'),
    ('event_2010', '2010 event', 'Historical events'),
    ('design_T5', 'T5 design storm', 'Design storms + illustrative'),
    ('design_T10', 'T10 design storm', 'Design storms + illustrative'),
    ('design_T25', 'T25 design storm', 'Design storms + illustrative'),
    ('design_T50', 'T50 design storm', 'Design storms + illustrative'),
    ('design_T100', 'T100 design storm', 'Design storms + illustrative'),
    ('illustrative_25jul2011', '25 Jul 2011 (illustrative)', 'Design storms + illustrative'),
    ('P50_ordinary', 'P50 (ordinary)', 'Probabilistic'),
    ('P75_notable', 'P75 (notable)', 'Probabilistic'),
    ('P90_moderate', 'P90 (moderate)', 'Probabilistic'),
]

DEPTH_GATE_M = 0.05
DEBRIS_FACTOR = 0.5
HR_BREAKS = [0.75, 1.5]  # -> 3 classes: low, moderate, high
ZONE_LABELS = ['low', 'moderate', 'high']
ZONE_RGB = [(255, 235, 132), (252, 141, 89), (179, 0, 0)]

# Same artifact fix as 08_generate_velocity_peak_raster.py - a hazard layer
# built on contaminated velocity would just relocate the same bug.
ARTIFACT_CELL_ROWCOL = (347, 614)
SHALLOW_SUPERSONIC_VMAX = 5.0
SHALLOW_SUPERSONIC_DEPTH = 0.3

UTM43 = 'EPSG:32643'
WGS84 = 'EPSG:4326'
MERC = 'EPSG:3857'
OUT_W = 1600

to_wgs = Transformer.from_crs(UTM43, WGS84, always_xy=True)
to_merc = Transformer.from_crs(WGS84, MERC, always_xy=True)
merc_inv = Transformer.from_crs(MERC, WGS84, always_xy=True)
to_utm = Transformer.from_crs(WGS84, UTM43, always_xy=True)


def build_warp(x0, y0_top, sx, sy, n_rows, m_cols):
    left, right = x0, x0 + m_cols * sx
    top, bottom = y0_top, y0_top + n_rows * sy
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

    col_idx = np.floor((ux_grid - x0) / sx).astype(int)
    row_idx = np.floor((top - uy_grid) / (-sy)).astype(int)
    in_bounds = (row_idx >= 0) & (row_idx < n_rows) & (col_idx >= 0) & (col_idx < m_cols)

    corners_wgs84 = [
        list(merc_inv.transform(mx1, my2)), list(merc_inv.transform(mx2, my2)),
        list(merc_inv.transform(mx2, my1)), list(merc_inv.transform(mx1, my1)),
    ]
    return col_idx, row_idx, in_bounds, out_h, corners_wgs84


def colorize(zone_idx):
    rgba = np.zeros((*zone_idx.shape, 4), dtype=np.uint8)
    ramp = np.array(ZONE_RGB, dtype=np.uint8)
    ok = zone_idx >= 0
    rgba[ok, :3] = ramp[zone_idx[ok]]
    rgba[ok, 3] = 255
    return rgba


warp = None
manifest = {
    'corners': None, 'hr_breaks': HR_BREAKS, 'debris_factor': DEBRIS_FACTOR,
    'zone_labels': ZONE_LABELS, 'colors': ['#%02x%02x%02x' % c for c in ZONE_RGB],
    'formula': 'HR = depth * (velocity + 0.5) + debris_factor (Ramsbottom et al. 2003, EA hazard-to-people)',
    'scenarios': [],
}

for scen, label, category in SCENARIOS:
    print(f'=== {scen} ===', flush=True)
    ds = xr.open_dataset(f'{RERUN_ROOT}/{scen}/sfincs_map.nc')
    msk = ds['msk'].values == 1
    hmax = ds['hmax'].max('timemax').values
    flooded = msk & (hmax >= DEPTH_GATE_M)
    vmax = np.where(flooded, ds['vmax'].max('timemax').values, np.nan)
    cx = ds['corner_x'].values
    cy = ds['corner_y'].values
    ds.close()

    ar, ac = ARTIFACT_CELL_ROWCOL
    vmax[ar, ac] = np.nan
    shallow_supersonic = (vmax > SHALLOW_SUPERSONIC_VMAX) & (hmax < SHALLOW_SUPERSONIC_DEPTH)
    vmax[shallow_supersonic] = np.nan

    depth = np.where(flooded, hmax, np.nan)
    hr = depth * (np.nan_to_num(vmax, nan=0.0) + 0.5) + DEBRIS_FACTOR
    hr = np.where(flooded, hr, np.nan)

    zone_idx = np.full(hr.shape, -1, dtype=np.int8)
    zone_idx[flooded & (hr < HR_BREAKS[0])] = 0
    zone_idx[flooded & (hr >= HR_BREAKS[0]) & (hr < HR_BREAKS[1])] = 1
    zone_idx[flooded & (hr >= HR_BREAKS[1])] = 2

    cell_area_km2 = (100.0 * 100.0) / 1e6
    zone_areas = {ZONE_LABELS[i]: round(int(np.sum(zone_idx == i)) * cell_area_km2, 3) for i in range(3)}
    print(f'  zone areas (km2): {zone_areas}', flush=True)

    n_rows, m_cols = msk.shape
    x0 = float(cx[0, 0])
    y0_top = float(cy[-1, 0])
    sx = float(cx[0, 1] - cx[0, 0])
    sy = -sx

    if warp is None:
        col_idx, row_idx, in_bounds, out_h, corners_wgs84 = build_warp(x0, y0_top, sx, sy, n_rows, m_cols)
        warp = (col_idx, row_idx, in_bounds, out_h, corners_wgs84)
        manifest['corners'] = corners_wgs84
        manifest['render_width'] = OUT_W
        manifest['render_height'] = out_h
    else:
        col_idx, row_idx, in_bounds, out_h, corners_wgs84 = warp

    sampled = np.full((out_h, OUT_W), -1, dtype=np.int8)
    sampled[in_bounds] = zone_idx[row_idx[in_bounds], col_idx[in_bounds]]

    rgba = colorize(sampled)
    fname = f'{scen}_hazard.png'
    Image.fromarray(rgba, 'RGBA').save(f'{RASTER_DIR}/{fname}', optimize=True)

    manifest['scenarios'].append({
        'id': scen, 'label': label, 'category': category,
        'file': f'rasters/{fname}', 'zone_area_km2': zone_areas,
    })

with open(f'{OUT_DIR}/hazard_manifest.json', 'w') as f:
    json.dump(manifest, f, indent=2)
print('\nDONE. manifest written to', f'{OUT_DIR}/hazard_manifest.json', flush=True)
