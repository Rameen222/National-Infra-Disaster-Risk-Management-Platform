"""
Flood Vulnerability V2 - scenario "extras": volume-over-time + peak velocity/
discharge, computed from the variables added in the most recent rerun_hmax
rerun (storevel/storefluxmax/storezvolume flags).

Why this exists: the user's own variable table named `velmax`, `qx`/`qy`, and
`Volume` as the relevant SFINCS outputs. Checked what's ACTUALLY in the
current sfincs_map.nc files - the real names differ:
  - no `hmean` variable is present in this rerun (storehmean apparently
    didn't produce output, or wasn't actually enabled for these runs)
  - `velmax` -> actually `vmax` (timemax, n, m) - SFINCS's own peak velocity
    MAGNITUDE per 24h band (i.e. already sqrt(u^2+v^2) maxed over time -
    no need to compute it from hourly u/v ourselves)
  - `qx`/`qy` -> actually one combined `qmax` (timemax, n, m) - peak flux
    magnitude, not separate x/y components
  - `Volume` -> actually `subgrid_volume` (time, n, m) - water volume PER
    CELL at every HOURLY timestep (same time axis as `h`) - domain total
    volume is the spatial sum of this, not a variable SFINCS stores directly

Writes:
  - Adds `volume_Mm3` to every frame of each scenario's existing
    Animation/<scenario>/manifest.json (same frame indices/hours as `h`,
    since subgrid_volume shares that exact time axis - no interpolation).
  - Adds top-level `peak_velocity_ms`, `peak_discharge_m2s`,
    `peak_volume_Mm3` to each of those manifests.
  - client/public/Data_2/Data_2_final/Additional/scenario_summary.json -
    one consolidated reference across all 11 scenarios (rainfall category +
    every peak statistic gathered this session, correctly labelled by which
    SFINCS variable and file each came from).
"""
import json
import os

os.environ.pop('PROJ_LIB', None)
os.environ.pop('PROJ_DATA', None)

import numpy as np
import xarray as xr

RERUN_ROOT = 'C:/NDMA/FLOOD_SIMULATION_FINAL/rerun_hmax/scenarios'
ANIM_ROOT = 'C:/NDMA/infra_portal/client/public/Data_2/Data_2_final/Animation'
ADDITIONAL_DIR = 'C:/NDMA/infra_portal/client/public/Data_2/Data_2_final/Additional'
os.makedirs(ADDITIONAL_DIR, exist_ok=True)

SCENARIO_META = {
    'event_2006': ('5 Aug 2006 (validation event)', 'Historical events'),
    'event_2010': ('2010 event', 'Historical events'),
    'design_T5': ('T5 design storm', 'Design storms + illustrative'),
    'design_T10': ('T10 design storm', 'Design storms + illustrative'),
    'design_T25': ('T25 design storm', 'Design storms + illustrative'),
    'design_T50': ('T50 design storm', 'Design storms + illustrative'),
    'design_T100': ('T100 design storm', 'Design storms + illustrative'),
    'illustrative_25jul2011': ('25 Jul 2011 (illustrative)', 'Design storms + illustrative'),
    'P50_ordinary': ('P50 (ordinary)', 'Probabilistic'),
    'P75_notable': ('P75 (notable)', 'Probabilistic'),
    'P90_moderate': ('P90 (moderate)', 'Probabilistic'),
}

# Confirmed against ANIMATION_METADATA.md's scenario table - not derivable
# from sfincs_map.nc itself (rainfall is a model INPUT, not an output).
RAINFALL_MM_24HR = {
    'event_2006': 81.80, 'event_2010': 202.35,
    'design_T5': 82.32, 'design_T10': 95.43, 'design_T25': 112.00,
    'design_T50': 124.29, 'design_T100': 136.50,
    'illustrative_25jul2011': 75.11,
    'P50_ordinary': 7.92, 'P75_notable': 18.24, 'P90_moderate': 33.84,
}

summary = []

for scen, (label, category) in SCENARIO_META.items():
    print(f'=== {scen} ===', flush=True)
    ds = xr.open_dataset(f'{RERUN_ROOT}/{scen}/sfincs_map.nc')
    msk = ds['msk'].values == 1

    # Volume over time: sum subgrid_volume across all active cells per
    # hourly timestep, m3 -> Mm3. Same 'time' axis length/values as 'h'.
    vol = ds['subgrid_volume'].values  # (time, n, m)
    vol_series_m3 = np.array([float(np.nansum(np.where(msk, vol[t], 0.0))) for t in range(vol.shape[0])])
    vol_series_Mm3 = (vol_series_m3 / 1e6).round(4)
    times = ds['time'].values
    t0 = times[0]
    hours = ((times - t0) / np.timedelta64(1, 'h')).astype(float)

    # Peak velocity / discharge magnitude (SFINCS's own timemax-banded max -
    # no need to derive from hourly u/v ourselves). Gated to cells that also
    # have real flooding (hmax >= 0.05 m, same threshold the depth layer
    # uses): checked directly (see 08_generate_velocity_peak_raster.py's
    # docstring) that ungated vmax is dominated by trace runoff on dry
    # mountain slopes - 78% of "hazardous" (>0.3 m/s) cells in design_T100
    # had no meaningful water there at all. Must match that script's gating
    # exactly, or this summary's numbers contradict the velocity map layer.
    hmax = ds['hmax'].max('timemax').values
    flooded = msk & (hmax >= 0.05)
    vmax = np.where(flooded, ds['vmax'].max('timemax').values, np.nan)
    qmax = np.where(flooded, ds['qmax'].max('timemax').values, np.nan)
    peak_velocity_ms = round(float(np.nanmax(vmax)) if np.isfinite(vmax).any() else 0.0, 3)
    peak_discharge_m2s = round(float(np.nanmax(qmax)) if np.isfinite(qmax).any() else 0.0, 3)
    peak_volume_Mm3 = round(float(np.nanmax(vol_series_Mm3)), 3)
    peak_volume_hour = float(hours[int(np.nanargmax(vol_series_Mm3))])
    ds.close()

    # Inject into the existing Animation manifest - same frame count/order,
    # since subgrid_volume and h share one time axis.
    manifest_path = f'{ANIM_ROOT}/{scen}/manifest.json'
    with open(manifest_path) as f:
        manifest = json.load(f)
    n = len(manifest['frames'])
    assert n == len(vol_series_Mm3), f'{scen}: frame count {n} != volume series length {len(vol_series_Mm3)}'
    for i, frame in enumerate(manifest['frames']):
        frame['volume_Mm3'] = float(vol_series_Mm3[i])
    manifest['peak_velocity_ms'] = peak_velocity_ms
    manifest['peak_discharge_m2s'] = peak_discharge_m2s
    manifest['peak_volume_Mm3'] = peak_volume_Mm3
    with open(manifest_path, 'w') as f:
        json.dump(manifest, f)
    print(f'  peak_velocity={peak_velocity_ms} m/s  peak_discharge={peak_discharge_m2s} m2/s  '
          f'peak_volume={peak_volume_Mm3} Mm3 @ T+{peak_volume_hour:.0f}h', flush=True)

    summary.append({
        'id': scen, 'label': label, 'category': category,
        'peak_depth_h_m': manifest.get('global_max_depth_m'),
        'peak_velocity_ms': peak_velocity_ms,
        'peak_discharge_m2s': peak_discharge_m2s,
        'peak_volume_Mm3': peak_volume_Mm3,
        'peak_volume_hour': round(peak_volume_hour, 1),
        'n_frames': n,
    })

with open(f'{ADDITIONAL_DIR}/scenario_summary.json', 'w') as f:
    json.dump({'scenarios': summary}, f, indent=2)
print(f'\nDONE. Wrote {ADDITIONAL_DIR}/scenario_summary.json and updated {len(summary)} animation manifests.')
