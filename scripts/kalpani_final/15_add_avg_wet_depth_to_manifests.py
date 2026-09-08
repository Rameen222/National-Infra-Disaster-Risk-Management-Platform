"""
Flood Vulnerability V2 - add a per-frame "average wet-cell depth" field to
each scenario's existing animation manifest.json, alongside the max_depth_m
already written by 06_generate_animation_frames_png.py.

Why a separate script rather than editing/re-running 06_*: that script's
job is regenerating the (expensive) pre-colorized PNG frames; this only
needs one extra scalar per frame, computed from data 06_* already reads,
so re-deriving it from the same source is cheap and doesn't touch the PNGs
or anything else already in each manifest.

Metric: mean depth over WET cells only (depth > dry_threshold_m, the same
0.05 m "dry" cutoff already used everywhere else in this pipeline - the
Building Exposure legend's dry bucket, the animation colour scale's
transparent-below-0.05m rule). Averaging over the WHOLE active domain
instead would be dominated by the ~95%+ of this ~2,750 km^2 watershed that
never floods even at peak, producing a curve that hugs zero throughout and
tells you nothing - restricting to wet cells answers "how deep is it,
on average, where there's actually water right now" instead.

Reads:  C:/NDMA/FLOOD_SIMULATION_FINAL/rerun_hmax/scenarios/<scenario>/sfincs_map.nc
        client/public/Data_2_final/Animation/<scenario>/manifest.json (in place)
Writes: client/public/Data_2_final/Animation/<scenario>/manifest.json (same file,
        each frame gets 'avg_wet_depth_m'; manifest gets 'global_avg_wet_depth_m')
"""
import json

import numpy as np
import xarray as xr

RERUN_ROOT = 'C:/NDMA/FLOOD_SIMULATION_FINAL/rerun_hmax/scenarios'
MANIFEST_ROOT = 'C:/NDMA/infra_portal/client/public/Data_2_final/Animation'
DRY_THRESHOLD_M = 0.05

SCENARIOS = [
    'event_2006', 'event_2010',
    'design_T5', 'design_T10', 'design_T25', 'design_T50', 'design_T100',
    'illustrative_25jul2011',
    'P50_ordinary', 'P75_notable', 'P90_moderate',
]

for scen in SCENARIOS:
    print(f'=== {scen} ===', flush=True)
    manifest_path = f'{MANIFEST_ROOT}/{scen}/manifest.json'
    with open(manifest_path) as f:
        manifest = json.load(f)

    ds = xr.open_dataset(f'{RERUN_ROOT}/{scen}/sfincs_map.nc')
    # Same north-up flip as 06_generate_animation_frames_png.py - see that
    # script's comment for why (h/msk are stored south-up in the raw file).
    h = ds['h'].values[:, ::-1, :]
    msk = (ds['msk'].values[::-1, :] == 1)
    ds.close()

    n_frames = h.shape[0]
    assert n_frames == len(manifest['frames']), \
        f'{scen}: frame count mismatch ({n_frames} vs {len(manifest["frames"])})'

    avg_series = []
    for i in range(n_frames):
        depth = np.where(msk, h[i].astype(np.float32), np.nan)
        wet = depth[depth > DRY_THRESHOLD_M]
        avg = float(np.mean(wet)) if wet.size > 0 else 0.0
        manifest['frames'][i]['avg_wet_depth_m'] = round(avg, 4)
        avg_series.append(avg)

    manifest['global_avg_wet_depth_m'] = round(max(avg_series), 4)
    manifest['avg_wet_depth_note'] = (
        f'mean depth over cells > {DRY_THRESHOLD_M}m at each frame - '
        'excludes dry/near-dry cells, not a whole-domain average'
    )

    with open(manifest_path, 'w') as f:
        json.dump(manifest, f)
    print(f'  peak avg wet depth = {manifest["global_avg_wet_depth_m"]:.4f} m  '
          f'(peak max depth = {manifest.get("global_max_depth_m")} m)', flush=True)

print('Done.', flush=True)
