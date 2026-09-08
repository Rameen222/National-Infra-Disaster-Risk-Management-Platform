"""
Flood Vulnerability V2 - Animation frames, pre-colorized PNG, ALL 11 scenarios.

Supersedes the first version of this script (which only covered
P90_moderate / design_T25 / event_2010, reading pre-existing h_NNN.tif
files of unknown origin). This version reads the 'h' (water depth, hourly)
variable directly from each scenario's own rerun_hmax sfincs_map.nc -
verified present, on an identical 697x637 @ 100m EPSG:32643 grid, across
all 11 scenarios - and does the warp + colour classification once, offline,
exactly like the first version did, so nothing changes in
animationEngine.js's runtime contract (still: fetch a static PNG, no
decode/warp/colour work left to do in the browser).

Colour scale design (see also animationEngine.js's ANIM_DEPTH_SCALES,
which MUST mirror SCENARIO_SCALES below exactly - the colours are baked
into these PNGs, not computed at view time):

  Depths < 0.05 m render fully transparent (the reporting/"dry" threshold -
  matches the Building Exposure legend's own dry cutoff). This is a change
  from the first version, which coloured every value down to 0.0.

  Scenarios are grouped by category, and EVERY scenario in a group uses the
  SAME breaks/colours for its "normal" range, so the same colour means the
  same depth everywhere in that group - genuinely comparable, not just
  visually similar:
    - Historical events   (event_2006, event_2010)
    - Design storms + illustrative (design_T5/T10/T25/T50/T100, illustrative_25jul2011)
    - Probabilistic        (P50_ordinary, P75_notable, P90_moderate)

  Within a group, if one member's peak is drastically larger than the
  others (checked against the group's base 5-class range), it gets EXTRA
  classes appended past the base scale's top break, continuing in a second
  hue (purple) rather than restarting the ramp - so e.g. event_2010's cells
  under 11.4 m read identically to event_2006's, and only the cells beyond
  what event_2006 ever reaches get the new (purple) colours. This applied
  to: event_2010 (vs. event_2006) and P90_moderate (vs. P75_notable/P50_ordinary).
  design_T5..T100 + illustrative span only a ~2x range (9.0-17.6 m) - not
  drastic - so that whole group shares one flat 5-class scale.

  P50_ordinary's peak (0.01 m) never exceeds the 0.05 m dry threshold at
  all - every frame of its animation will render fully transparent. That is
  the correct, expected result for an "ordinary/frequent" rainfall
  scenario, not a bug.

Reads:  C:/NDMA/FLOOD_SIMULATION_FINAL/rerun_hmax/scenarios/<scenario>/sfincs_map.nc
Writes: client/public/Data_2/Data_2_final/Animation/<scenario>/h_NNN.png
        client/public/Data_2/Data_2_final/Animation/<scenario>/manifest.json
        client/public/Data_2/Data_2_final/Animation/index.json
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
OUT_ROOT = 'C:/NDMA/infra_portal/client/public/Data_2/Data_2_final/Animation'

DRY_THRESHOLD_M = 0.05  # matches animationEngine.js - below this, fully transparent

# Must match animationEngine.js's BASE_RAMP_RGB / EXTENSION_RAMP_RGB exactly.
BASE_RAMP_RGB = [
    (198, 219, 239),
    (107, 174, 214),
    (49, 130, 189),
    (8, 81, 156),
    (8, 48, 107),
]
EXTENSION_RAMP_RGB = [
    (106, 81, 163),
    (63, 0, 125),
]

# Must match animationEngine.js's ANIM_DEPTH_SCALES exactly (breaks only -
# colours are always BASE_RAMP_RGB, extended with EXTENSION_RAMP_RGB when a
# scenario needs more classes than the group's base 5).
#
# IMPORTANT calibration rule: a scale's LAST break is the floor of its
# final, open-ended ">=" class - not a ceiling/rounded max. It must sit
# CLEARLY BELOW the relevant scenario's actual peak, or that peak will
# never actually reach the scale's darkest colour (found the hard way: an
# earlier version set top breaks ~AT each group's measured max, so several
# scenarios' own peaks fell just short of their own scale's top class and
# the darkest shade never appeared anywhere in their frames).
SCENARIO_BREAKS = {
    # Historical events - event_2006 is the base (5 classes, its own range,
    # peak 11.37 m lands with margin above the top break); event_2010
    # (peak 26.59 m) shares those same 5 breaks/colours then extends.
    'event_2006':             [0.05, 0.5, 2, 4, 9],
    'event_2010':             [0.05, 0.5, 2, 4, 9, 15, 22],
    # Design storms + illustrative - one flat shared scale (peaks 9.0-17.6 m,
    # not drastic enough across the group to need extension); top break (14)
    # sits below T50/T100's peaks so they actually reach the darkest class.
    'design_T5':               [0.05, 2, 6, 10, 14],
    'design_T10':              [0.05, 2, 6, 10, 14],
    'design_T25':              [0.05, 2, 6, 10, 14],
    'design_T50':              [0.05, 2, 6, 10, 14],
    'design_T100':             [0.05, 2, 6, 10, 14],
    'illustrative_25jul2011':  [0.05, 2, 6, 10, 14],
    # Probabilistic - P50/P75 share the base 5 classes (top break 0.5 sits
    # below P75's 0.6119 m peak); P90 (peak 4.36 m) shares those breaks then
    # extends. P50's own peak (0.01 m) never exceeds the 0.05 m dry
    # threshold - its whole animation is expected to render fully
    # transparent, not a bug.
    'P50_ordinary':            [0.05, 0.1, 0.2, 0.35, 0.5],
    'P75_notable':             [0.05, 0.1, 0.2, 0.35, 0.5],
    'P90_moderate':            [0.05, 0.1, 0.2, 0.35, 0.5, 1.0, 2.5],
}
# Restrict a re-run to specific scenarios (e.g. after tweaking their breaks)
# without regenerating all 11 - leave empty to run everything.
ONLY_SCENARIOS = []
SCENARIO_LABEL = {
    'event_2006': '5 Aug 2006',
    'event_2010': '2010 event',
    'design_T5': 'T5 design storm',
    'design_T10': 'T10 design storm',
    'design_T25': 'T25 design storm',
    'design_T50': 'T50 design storm',
    'design_T100': 'T100 design storm',
    'illustrative_25jul2011': '25 Jul 2011 (illustrative)',
    'P50_ordinary': 'P50 (ordinary)',
    'P75_notable': 'P75 (notable)',
    'P90_moderate': 'P90 (moderate)',
}
SCENARIO_GROUP = {
    'event_2006': 'Historical events', 'event_2010': 'Historical events',
    'design_T5': 'Design storms + illustrative', 'design_T10': 'Design storms + illustrative',
    'design_T25': 'Design storms + illustrative', 'design_T50': 'Design storms + illustrative',
    'design_T100': 'Design storms + illustrative', 'illustrative_25jul2011': 'Design storms + illustrative',
    'P50_ordinary': 'Probabilistic', 'P75_notable': 'Probabilistic', 'P90_moderate': 'Probabilistic',
}

UTM43 = 'EPSG:32643'
WGS84 = 'EPSG:4326'
MERC = 'EPSG:3857'
OUT_W = 1280  # matches animationEngine.js's old RENDER_W

to_wgs = Transformer.from_crs(UTM43, WGS84, always_xy=True)
to_merc = Transformer.from_crs(WGS84, MERC, always_xy=True)
merc_inv = Transformer.from_crs(MERC, WGS84, always_xy=True)
to_utm = Transformer.from_crs(WGS84, UTM43, always_xy=True)


def ramp_for(breaks):
    n = len(breaks)
    if n == 5:
        return BASE_RAMP_RGB
    if n == 7:
        return BASE_RAMP_RGB + EXTENSION_RAMP_RGB
    raise ValueError(f'no ramp defined for {n} breaks')


def colorize(depth, breaks):
    """depth: float32 array, NaN outside the active/warped domain. Cells
    below DRY_THRESHOLD_M (breaks[0]) are transparent; everything else is
    classified into one of len(breaks) classes using this scenario's ramp."""
    ramp = np.array(ramp_for(breaks), dtype=np.uint8)
    rgba = np.zeros((*depth.shape, 4), dtype=np.uint8)
    ok = np.isfinite(depth) & (depth >= breaks[0])
    v = depth[ok]
    upper = np.array(breaks[1:], dtype=np.float32)
    ci = (v[:, None] >= upper[None, :]).sum(axis=1)  # 0..len(breaks)-1
    rgba[ok, :3] = ramp[ci]
    rgba[ok, 3] = 255
    return rgba


def build_warp(x0, y0_top, sx, sy, n_rows, m_cols):
    """Nearest-neighbour Mercator<->UTM inverse warp, full resolution
    (offline, not per-frame in a browser)."""
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


warp = None  # identical grid across all 11 scenarios (verified) - built once, reused
index_entries = []
scenarios_to_run = {k: v for k, v in SCENARIO_BREAKS.items() if not ONLY_SCENARIOS or k in ONLY_SCENARIOS}

for scen, breaks in scenarios_to_run.items():
    print(f'=== {scen} (group={SCENARIO_GROUP[scen]}, {len(breaks)} classes) ===', flush=True)
    scen_dir = f'{OUT_ROOT}/{scen}'
    os.makedirs(scen_dir, exist_ok=True)

    ds = xr.open_dataset(f'{RERUN_ROOT}/{scen}/sfincs_map.nc')
    # 'h'/'msk' are stored SOUTH-up (row index increases northward - cy[1,0]
    # > cy[0,0]), but build_warp()/the rest of this pipeline assumes normal
    # NORTH-up raster order (row 0 = north), same as the original, known-good
    # P90_moderate/design_T25/event_2010 h_NNN.tif files. Flip both here so
    # everything downstream can assume north-up like a normal raster.
    # Verified directly against those original tif files: flipud(h) matches
    # them exactly (within float32 rounding); un-flipped h does not - an
    # earlier version of this script skipped this flip and silently produced
    # north-south-flipped, mis-warped output for all 11 scenarios (most
    # visible on P75_notable, whose small flood extent made the resulting
    # misalignment obvious; the effect was there in every scenario).
    h = ds['h'].values[:, ::-1, :]  # (time, n, m) float32, now north-up
    msk = (ds['msk'].values[::-1, :] == 1)
    cx = ds['corner_x'].values  # (n+1, m+1) CELL-CORNER coordinates
    cy = ds['corner_y'].values
    times = ds['time'].values
    ds.close()

    n_rows, m_cols = msk.shape
    x0 = float(cx[0, 0])       # west edge
    # cx/cy are (n+1, m+1) corner arrays (one more than the n_rows x m_cols
    # cell grid), so index -1 is exactly one past the last cell = the true
    # north edge - no manual offset needed.
    y0_top = float(cy[-1, 0])  # north edge
    sx = float(cx[0, 1] - cx[0, 0])
    sy = -sx  # north-up: y decreases as row index increases

    if warp is None:
        # Hard-check against the known-good original tif's transform - if
        # this ever fails, something about the source data/orientation
        # logic has changed and must be re-verified before trusting output.
        assert (round(x0), round(y0_top), round(sx)) == (198900, 3831500, 100), \
            f'{scen}: unexpected grid origin ({x0}, {y0_top}, {sx}) - re-verify orientation before proceeding'
        col_idx, row_idx, in_bounds, out_h, corners_wgs84 = build_warp(x0, y0_top, sx, sy, n_rows, m_cols)
        warp = (col_idx, row_idx, in_bounds, out_h, corners_wgs84)
    else:
        col_idx, row_idx, in_bounds, out_h, corners_wgs84 = warp

    t0 = times[0]
    n_frames = len(times)
    global_max = 0.0
    frames_meta = []
    for i in range(n_frames):
        depth = np.where(msk, h[i].astype(np.float32), np.nan)
        frame_max = float(np.nanmax(depth)) if np.isfinite(depth).any() else 0.0
        global_max = max(global_max, frame_max)

        sampled = np.full((out_h, OUT_W), np.nan, dtype=np.float32)
        sampled[in_bounds] = depth[row_idx[in_bounds], col_idx[in_bounds]]

        rgba = colorize(sampled, breaks)
        fname = f'h_{i:03d}.png'
        Image.fromarray(rgba, 'RGBA').save(f'{scen_dir}/{fname}', optimize=True)

        hours = float((times[i] - t0) / np.timedelta64(1, 'h'))
        frames_meta.append({
            'file': fname, 'index': i, 'hours': hours,
            'time_iso': str(times[i])[:19], 'max_depth_m': round(frame_max, 4),
        })
        if (i + 1) % 25 == 0 or i == n_frames - 1:
            print(f'  {i + 1}/{n_frames} frames done', flush=True)

    dt_hours = float((times[1] - times[0]) / np.timedelta64(1, 'h')) if n_frames > 1 else 1.0
    manifest = {
        'scenario': scen,
        'label': SCENARIO_LABEL[scen],
        'category': SCENARIO_GROUP[scen],
        'source_file': 'sfincs_map.nc',
        'variable': 'h',
        'description': 'SFINCS simulated flood water depth through simulation time',
        'units': 'm',
        'crs': 'EPSG:32643',
        'epsg': 32643,
        'grid': {
            'width': m_cols, 'height': n_rows, 'dx_m': sx, 'dy_m': -sy,
            'transform': [sx, 0.0, x0, 0.0, sy, y0_top],
        },
        'nodata': -9999.0,
        'dry_threshold_m': DRY_THRESHOLD_M,
        'n_frames': n_frames,
        't_start': str(times[0])[:19],
        't_end': str(times[-1])[:19],
        'dt_hours': dt_hours,
        'global_max_depth_m': round(global_max, 4),
        'color_scale_group': SCENARIO_GROUP[scen],
        'color_scale_breaks': breaks,
        'corners': corners_wgs84,
        'render_width': OUT_W,
        'render_height': out_h,
        'frames': frames_meta,
    }
    with open(f'{scen_dir}/manifest.json', 'w') as f:
        json.dump(manifest, f)
    print(f'  global_max_depth_m={global_max:.4f}  manifest written', flush=True)

    index_entries.append({
        'scenario': scen, 'n_frames': n_frames, 'dt_hours': dt_hours,
        'max_depth_m': round(global_max, 4), 'category': SCENARIO_GROUP[scen],
        'manifest': f'Animation/{scen}/manifest.json',
    })

index_path = f'{OUT_ROOT}/index.json'
existing = {}
if os.path.exists(index_path):
    with open(index_path) as f:
        existing = {e['scenario']: e for e in json.load(f).get('scenarios', [])}
for e in index_entries:
    existing[e['scenario']] = e
with open(index_path, 'w') as f:
    json.dump({'animation_root': 'Animation', 'scenarios': list(existing.values())}, f, indent=2)

print('\nDONE.', flush=True)
