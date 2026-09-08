"""
Flood Vulnerability V2 - fix volume_Mm3/peak_volume_Mm3 in every animation
manifest, replacing the whole-domain subgrid_volume sum written by
07_generate_scenario_extras.py with a wet-cells-only sum of that same
variable.

The bug: subgrid_volume (SFINCS's bathymetry-corrected per-cell water
volume, m^3) is only positive and sane in cells that are actually wet.
In DRY cells it carries small negative values (a benign subgrid-model
artifact - the local water level sits slightly below that cell's
subgrid-mean bed reference, not a sign of anything broken). Summing over
the WHOLE active domain - as 07_* did - adds up ~270k dry cells' small
negative nudges against a much smaller number of genuinely wet cells'
large positive values, and the two nearly cancel: verified on
P90_moderate at T+32h, wet cells summed to +1,678,375 m^3 while dry
cells summed to -1,678,804 m^3, netting to essentially zero (-429 m^3)
even though 4,765 cells were still under up to 3.5m of water.

The fix: sum subgrid_volume only over cells where h > 0.05m (the same
dry threshold used everywhere else in this pipeline - see 06_generate_
animation_frames_png.py and 15_add_avg_wet_depth_to_manifests.py).
subgrid_volume itself is untouched/still the physically accurate,
bathymetry-corrected figure - only which cells get summed changes.

Verified against all 11 scenarios before running this for real: 6 of 11
(the design storms T5-T100 + illustrative_25jul2011) show genuine
peak-then-decline recession once correctly summed (e.g. design_T100:
147.5 Mm3 @ T+27h -> 128.7 Mm3 @ T+96h, a real -13%), even while their
own avg_wet_depth keeps climbing over the same window - the shrinking-
wet-set effect made concrete. The other 5 (event_2006, event_2010,
P90_moderate, P50_ordinary, P75_notable) still don't show recession
within their simulated window - consistent with max/avg depth for those
same scenarios, a real simulation-duration limit, not a fixed-by-this
metric issue.

Reads:  C:/NDMA/FLOOD_SIMULATION_FINAL/rerun_hmax/scenarios/<scenario>/sfincs_map.nc
        client/public/Data_2_final/Animation/<scenario>/manifest.json (in place)
Writes: client/public/Data_2_final/Animation/<scenario>/manifest.json (same file,
        volume_Mm3 per frame + peak_volume_Mm3/peak_volume_hour corrected)
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
    # NOT flipped here (unlike 06_*/15_*) - subgrid_volume is summed across
    # the whole domain regardless of row order, so the north-up flip those
    # scripts need for correct PNG/warp alignment is irrelevant to a sum.
    h = ds['h'].values
    vol = ds['subgrid_volume'].values
    msk = ds['msk'].values == 1
    ds.close()

    n_frames = h.shape[0]
    assert n_frames == len(manifest['frames']), \
        f'{scen}: frame count mismatch ({n_frames} vs {len(manifest["frames"])})'

    vol_series = []
    for i in range(n_frames):
        wet = msk & (h[i] > DRY_THRESHOLD_M)
        v_m3 = float(np.sum(vol[i][wet])) if wet.any() else 0.0
        v_Mm3 = round(max(0.0, v_m3) / 1e6, 4)
        manifest['frames'][i]['volume_Mm3'] = v_Mm3
        vol_series.append(v_Mm3)

    peak_idx = int(np.argmax(vol_series))
    manifest['peak_volume_Mm3'] = vol_series[peak_idx]
    manifest['peak_volume_hour'] = manifest['frames'][peak_idx]['hours']
    manifest['volume_note'] = (
        'subgrid_volume summed over cells > {}m depth only - the whole-'
        'domain sum (including dry cells) that 07_generate_scenario_'
        'extras.py originally used cancels to near-zero due to small '
        'negative subgrid_volume values in dry cells swamping the '
        'genuinely wet ones. See 16_fix_volume_wetcells_only.py.'
    ).format(DRY_THRESHOLD_M)

    with open(manifest_path, 'w') as f:
        json.dump(manifest, f)
    print(f'  peak volume = {manifest["peak_volume_Mm3"]:.3f} Mm3 @ T+{manifest["peak_volume_hour"]:.0f}h, '
          f'ends at {vol_series[-1]:.3f} Mm3', flush=True)

print('Done.', flush=True)
