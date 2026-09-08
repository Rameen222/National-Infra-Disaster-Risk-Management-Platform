"""
Diagnostic (read-only, writes a NEW file - never touches existing manifests):
does the animation/velocity page's 11-scenario dataset (rerun_hmax) show the
same kind of outlier contamination the Building Exposure team found in the
V5 hmax raster (a handful of extreme-depth cells forcing a 2-98 percentile
color stretch, see 11_generate_hmax30_raster_png.py)?

For each of the 11 scenarios, computes on the SAME 'hmax'/'vmax' variables
already used by 08_generate_velocity_peak_raster.py (hmax: max over
'timemax' bands; vmax: max over 'timemax' bands, masked to msk==1 &
hmax>=0.05 - the same "real floodwater" gate already used everywhere else
in this pipeline):

  - true min/max (what a naive stretch would use)
  - 2nd/98th percentile (what the Building Exposure team's method would give)
  - gap = true_max / p98, as a contamination signal (>1.5-2x is suspicious)
  - count of cells sitting at the known-bad value 14.142136 (10*sqrt(2)),
    found in the earlier velocity investigation, to see which/how many
    scenarios and how many cells it actually touches

Also does the same true-min/max vs p2/p98 check on the ANIMATION page's own
depth variable ('h', hourly, already gated at the same 0.05 m dry threshold
in 06_generate_animation_frames_png.py) at its OWN peak frame per scenario,
since that - not 'hmax' - is what actually gets colored into the animation
PNGs.

Output (new file, does not overwrite depth_manifest.json / velocity_manifest.json):
  client/public/Data_2/Data_2_final/outlier_diagnostic.json
"""
import json
import os

os.environ.pop('PROJ_LIB', None)
os.environ.pop('PROJ_DATA', None)

import numpy as np
import xarray as xr

RERUN_ROOT = 'C:/NDMA/FLOOD_SIMULATION_FINAL/rerun_hmax/scenarios'
OUT_PATH = 'C:/NDMA/infra_portal/client/public/Data_2/Data_2_final/outlier_diagnostic.json'

SCENARIOS = [
    'event_2006', 'event_2010',
    'design_T5', 'design_T10', 'design_T25', 'design_T50', 'design_T100',
    'illustrative_25jul2011',
    'P50_ordinary', 'P75_notable', 'P90_moderate',
]

DEPTH_GATE_M = 0.05
SUSPECT_VALUE = 10 * np.sqrt(2)  # 14.142135...
SUSPECT_TOL = 1e-4


def pct_stats(arr):
    valid = arr[np.isfinite(arr)]
    if valid.size == 0:
        return None
    true_min, true_max = float(valid.min()), float(valid.max())
    p2, p98 = (float(v) for v in np.percentile(valid, [2, 98]))
    gap = (true_max / p98) if p98 > 1e-9 else None
    return {
        'n_cells': int(valid.size),
        'true_min': round(true_min, 4), 'true_max': round(true_max, 4),
        'p2': round(p2, 4), 'p98': round(p98, 4),
        'true_max_over_p98': round(gap, 2) if gap is not None else None,
    }


results = {}

for scen in SCENARIOS:
    print(f'=== {scen} ===', flush=True)
    ds = xr.open_dataset(f'{RERUN_ROOT}/{scen}/sfincs_map.nc')
    msk = ds['msk'].values == 1
    hmax = ds['hmax'].max('timemax').values
    flooded = msk & (hmax >= DEPTH_GATE_M)
    vmax = ds['vmax'].max('timemax').values

    # hmax stats: all wetted-domain cells (matches Building Exposure's own
    # "valid = isfinite" gate, just applied to this dataset's hmax)
    depth_all = np.where(np.isfinite(hmax), hmax, np.nan)
    depth_stats_all = pct_stats(depth_all)
    # hmax stats restricted to the "real floodwater" gate already used
    # everywhere else (depth >= 0.05m) - the more relevant comparison for
    # what a viewer would actually see classified as flooded
    depth_stats_flooded = pct_stats(np.where(flooded, hmax, np.nan))

    # vmax stats, same flooded gate the velocity script already applies
    v_masked = np.where(flooded, vmax, np.nan)
    v_stats = pct_stats(v_masked)
    n_suspect = int(np.sum(flooded & (np.abs(vmax - SUSPECT_VALUE) < SUSPECT_TOL)))

    # animation page's own variable ('h', hourly) - peak frame only, same
    # gate style, to check the actual thing that gets colored into the
    # Animation/<scenario>/h_NNN.png frames
    h = ds['h'].values  # (time, n, m), south-up like hmax/vmax here
    h_peak_per_cell = np.nanmax(h, axis=0)
    h_flooded = msk & (h_peak_per_cell >= DEPTH_GATE_M)
    h_stats = pct_stats(np.where(h_flooded, h_peak_per_cell, np.nan))

    # Does h's per-cell peak (true continuous-time max) actually agree with
    # hmax's own 4-block max (cell_methods: time: maximum)? They're supposed
    # to be the same physical quantity. Compare directly, not just via
    # percentile - a percentile-level match can hide a real per-cell mismatch.
    gap = h_peak_per_cell - hmax
    cmp_valid = flooded & np.isfinite(gap)  # cells hmax itself calls "flooded"
    n_gap_gt50cm = int(np.sum(cmp_valid & (gap > 0.5)))
    n_gap_gt5cm = int(np.sum(cmp_valid & (gap > 0.05)))
    n_reverse = int(np.sum(cmp_valid & (gap < -0.05)))  # hmax > h_peak
    median_gap = float(np.nanmedian(gap[cmp_valid])) if cmp_valid.any() else None
    worst_idx = np.unravel_index(np.nanargmax(np.where(cmp_valid, gap, -np.inf)), gap.shape) \
        if cmp_valid.any() else None
    mismatch = {
        'n_hmax_flooded_cells': int(cmp_valid.sum()),
        'n_cells_h_exceeds_hmax_by_gt_0.5m': n_gap_gt50cm,
        'n_cells_h_exceeds_hmax_by_gt_0.05m': n_gap_gt5cm,
        'n_cells_hmax_exceeds_h_by_gt_0.05m': n_reverse,
        'median_gap_h_minus_hmax_m': round(median_gap, 4) if median_gap is not None else None,
        'worst_cell_rc': [int(worst_idx[0]), int(worst_idx[1])] if worst_idx else None,
        'worst_cell_h_peak_m': round(float(h_peak_per_cell[worst_idx]), 3) if worst_idx else None,
        'worst_cell_hmax_m': round(float(hmax[worst_idx]), 3) if worst_idx else None,
    }

    ds.close()

    results[scen] = {
        'hmax_all_wetted_cells': depth_stats_all,
        'hmax_flooded_gate_0.05m': depth_stats_flooded,
        'vmax_flooded_gate_0.05m': v_stats,
        'vmax_suspect_10sqrt2_cell_count': n_suspect,
        'h_animation_peak_flooded_gate_0.05m': h_stats,
        'h_vs_hmax_mismatch': mismatch,
    }
    print(f'  hmax(flooded) true_max={depth_stats_flooded["true_max"] if depth_stats_flooded else None} '
          f'p98={depth_stats_flooded["p98"] if depth_stats_flooded else None} | '
          f'vmax(flooded) true_max={v_stats["true_max"] if v_stats else None} '
          f'p98={v_stats["p98"] if v_stats else None} | suspect_cells={n_suspect}', flush=True)

with open(OUT_PATH, 'w') as f:
    json.dump(results, f, indent=2)
print(f'\nDONE. wrote {OUT_PATH}', flush=True)
