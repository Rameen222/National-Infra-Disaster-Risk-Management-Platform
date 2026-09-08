"""
Flood Vulnerability V2 - peak velocity raster PNG, one per scenario.

Source: `vmax` in each scenario's rerun_hmax sfincs_map.nc - SFINCS's own
peak velocity MAGNITUDE (already max(sqrt(u^2+v^2)) over each ~24h band,
per the 'maximum_flow_velocity' variable - no need to derive it from hourly
u/v ourselves). Domain peak = max over all timemax bands, masked to the
active domain.

Colour scale: a FIXED, physically-meaningful hazard scale, NOT a per-
scenario percentile stretch. Two reasons:
  1. Percentile stretch only makes sense when there's no natural absolute
     threshold to anchor to; velocity hazard has well-established ones
     (pedestrian instability ~1-2 m/s, vehicles swept ~2-3 m/s - see e.g.
     FEMA/USACE flood hazard guidance), so a fixed scale keeps the same
     colour meaning the same danger level in every scenario, comparable
     across all 11 - exactly the "comparable scales" approach already used
     for the animation's depth colours.
  2. A domain max computed fresh this session showed 4 different scenarios
     (design_T25/T50/T100, event_2010) sharing an identical, suspiciously
     round peak velocity (14.142 = 10*sqrt(2)) - almost certainly a single
     unstable grid cell, not real physics (see Additional/README.md). A
     percentile stretch keyed off a contaminated domain max would be wrong
     for every scenario; a fixed scale with an open-ended top class doesn't
     care what the true max is, so this contamination stays contained to
     that one class rather than skewing the whole visible range.

Uses the SAME warp construction as 06_generate_animation_frames_png.py
(verified correct there against the known-good original animation tiffs).

IMPORTANT gating: `vmax` is defined everywhere SFINCS reports ANY water
movement, including cells with only a trace of runoff draining across dry
mountain slopes with no meaningful flooding. Checked directly: of ~193k
cells with vmax > 0.3 m/s in design_T100, 149k (78%) had hmax < 0.05 m
(i.e. no real water there at all) - an unfiltered velocity layer paints
almost every hillslope in the watershed as a hazard, not just actual flood
currents. Every cell is therefore additionally masked to hmax >= 0.05 m
(the same dry threshold the depth layer already uses) before colouring -
this is peak velocity WHERE there is also real floodwater, not peak
velocity anywhere in the domain.

CONFIRMED ARTIFACT FIX (see flood-v2-roadmap/CHECKLIST.md, item 1): the
domain-max 14.142 m/s (=10*sqrt(2)) contamination was traced to the exact
same single grid cell - row=347, col=614 (~34.3366N, 72.3949E) - in all 4
affected scenarios (event_2010, design_T25/T50/T100), where depth is only
8-10cm. A cell that's barely wet showing a velocity faster than any
recorded flood current, at the identical value regardless of how much rain
fell, is a numerical artifact, not a real flow. Fixed two ways:
  1. That specific (row, col) cell is explicitly excluded (set to NaN,
     rendered transparent like a dry cell) in every scenario, not just the
     4 where it happened to exceed the old domain-max.
  2. A general safety net for any other undiscovered instance of the same
     failure mode: any cell with vmax > SHALLOW_SUPERSONIC_VMAX in water
     shallower than SHALLOW_SUPERSONIC_DEPTH is excluded the same way -
     shallow water moving implausibly fast is the actual signature of this
     bug, not a threshold anyone would expect a real flood current to
     cross.

Output:
  client/public/Data_2/Data_2_final/rasters/<scenario>_velocity.png
  client/public/Data_2/Data_2_final/velocity_manifest.json
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

# Fixed hazard scale (m/s). Sources of the break values: ~0.3 m/s = onset of
# noticeable hazard, ~1-2 m/s = pedestrian instability threshold, 2-3 m/s =
# knocks people down / moves light vehicles per the request that prompted
# this feature.
BREAKS = [0.3, 1.0, 2.0, 3.0]
RAMP_RGB = [
    (255, 245, 176),  # 0.3-1.0  pale yellow
    (255, 183, 77),   # 1.0-2.0  amber
    (255, 112, 67),   # 2.0-3.0  orange-red (pedestrian instability)
    (198, 40, 40),     # >3.0    deep red (vehicles swept)
]
DRY_THRESHOLD = BREAKS[0]
DEPTH_GATE_M = 0.05  # same dry threshold the depth layer uses - see module docstring

# Artifact fix (see docstring "CONFIRMED ARTIFACT FIX" above).
ARTIFACT_CELL_ROWCOL = (347, 614)  # exact cell confirmed across 4 scenarios
SHALLOW_SUPERSONIC_VMAX = 5.0   # m/s - above any recorded flood current here
SHALLOW_SUPERSONIC_DEPTH = 0.3  # m - "shallow" for this purpose

UTM43 = 'EPSG:32643'
WGS84 = 'EPSG:4326'
MERC = 'EPSG:3857'
OUT_W = 1600  # matches 03_generate_final_depth_raster_png.py's static-raster width

to_wgs = Transformer.from_crs(UTM43, WGS84, always_xy=True)
to_merc = Transformer.from_crs(WGS84, MERC, always_xy=True)
merc_inv = Transformer.from_crs(MERC, WGS84, always_xy=True)
to_utm = Transformer.from_crs(WGS84, UTM43, always_xy=True)


def colorize(v):
    rgba = np.zeros((*v.shape, 4), dtype=np.uint8)
    ramp = np.array(RAMP_RGB, dtype=np.uint8)
    ok = np.isfinite(v) & (v >= DRY_THRESHOLD)
    vv = v[ok]
    upper = np.array(BREAKS[1:], dtype=np.float32)
    ci = (vv[:, None] >= upper[None, :]).sum(axis=1)
    rgba[ok, :3] = ramp[ci]
    rgba[ok, 3] = 255
    return rgba


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


warp = None
manifest = {'corners': None, 'breaks': BREAKS,
            'colors': ['#%02x%02x%02x' % c for c in RAMP_RGB], 'scenarios': []}

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

    # Artifact fix: exclude the confirmed bad cell explicitly, plus the
    # general "shallow water moving implausibly fast" safety net.
    ar, ac = ARTIFACT_CELL_ROWCOL
    n_masked_specific = int(np.isfinite(vmax[ar, ac]))
    vmax[ar, ac] = np.nan
    shallow_supersonic = (vmax > SHALLOW_SUPERSONIC_VMAX) & (hmax < SHALLOW_SUPERSONIC_DEPTH)
    n_masked_general = int(np.sum(shallow_supersonic & np.isfinite(vmax)))
    vmax[shallow_supersonic] = np.nan
    if n_masked_specific or n_masked_general:
        print(f'  masked {n_masked_specific} known-artifact cell + '
              f'{n_masked_general} shallow-supersonic cell(s)', flush=True)

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

    sampled = np.full((out_h, OUT_W), np.nan, dtype=np.float32)
    sampled[in_bounds] = vmax[row_idx[in_bounds], col_idx[in_bounds]]

    rgba = colorize(sampled)
    fname = f'{scen}_velocity.png'
    Image.fromarray(rgba, 'RGBA').save(f'{RASTER_DIR}/{fname}', optimize=True)

    domain_peak = float(np.nanmax(vmax)) if np.isfinite(vmax).any() else 0.0
    print(f'  domain peak vmax={domain_peak:.3f} m/s, wrote {fname}', flush=True)
    manifest['scenarios'].append({
        'id': scen, 'label': label, 'category': category,
        'file': f'rasters/{fname}', 'domain_peak_ms': round(domain_peak, 3),
        'artifact_cells_masked': n_masked_specific + n_masked_general,
    })

with open(f'{OUT_DIR}/velocity_manifest.json', 'w') as f:
    json.dump(manifest, f)
print('\nDONE. manifest written to', f'{OUT_DIR}/velocity_manifest.json', flush=True)
