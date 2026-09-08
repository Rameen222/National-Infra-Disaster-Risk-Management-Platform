"""
External validation (never previously done - flagged as an open item in
Kalpani_SFINCS_Checklist.md / handover.md "Known open items"): compare this
model's own simulated peak discharge against independently published,
gauge-calibrated discharge from Ullah et al. (2016), Arabian Journal of
Geosciences, "Flood modeling and simulations using hydrodynamic model and
ASTER DEM - a case study of Kalpani River":
  - Bughdada Bridge, Mardan city (upstream): 1,951 m3/s, event_2006
  - Chowki Bridge, Risalpur (downstream):    2,285 m3/s, event_2006
                                              3,361 m3/s, 2010 flood

No qx/qy discharge fields actually exist in sfincs_map.nc despite
storefluxmax=1 being set (only the scalar per-cell max 'qmax' was written -
same "requested output flag didn't materialize" pattern already found for
'hmean'). So discharge is computed directly and more rigorously from first
principles: Q(t) = sum_over_cross_section( h(t) * v(t) * dx ), using the
hourly 'h' and 'v' fields (both confirmed present and internally consistent
- see 09/10's h-vs-hmax investigation), across the FULL row width at each
candidate cross-section (captures overbank/floodplain flow, not just the
narrow channel - the Manning's QA in the checklist already established the
2010 peak is ~97-98% overbank, not channel flow, so a channel-only
cross-section would badly undercount).

Cross-section location: neither bridge's exact coordinates were available
(only town-center coordinates from public sources), so this locates the
likely cross-section empirically - by testing a small range of rows near
each town and picking the row(s) whose flood-wave timing behaves physically
(downstream peaks later than upstream) and whose magnitude is most stable
across neighboring rows. This is a real limitation: treat the row choice as
a best estimate (+/- a few hundred meters), not a surveyed cross-section.

Output: outlier_diagnostic.json's sibling - a new, separate file, no
existing manifest touched.
  client/public/Data_2/Data_2_final/external_discharge_validation.json
"""
import json
import os

os.environ.pop('PROJ_LIB', None)
os.environ.pop('PROJ_DATA', None)

import numpy as np
import xarray as xr

RERUN_ROOT = 'C:/NDMA/FLOOD_SIMULATION_FINAL/rerun_hmax/scenarios'
OUT_PATH = 'C:/NDMA/infra_portal/client/public/Data_2/Data_2_final/external_discharge_validation.json'

PUBLISHED = {
    'Bughdada Bridge, Mardan (upstream)': {'event_2006': 1951},
    'Chowki Bridge, Risalpur (downstream)': {'event_2006': 2285, 'event_2010': 3361},
}
SOURCE = ('Ullah et al. (2016), "Flood modeling and simulations using hydrodynamic '
          'model and ASTER DEM - a case study of Kalpani River", Arabian Journal of '
          'Geosciences. https://link.springer.com/article/10.1007/s12517-016-2457-z')

CANDIDATE_ROWS = {
    'Bughdada Bridge, Mardan (upstream)': list(range(221, 228)),
    'Chowki Bridge, Risalpur (downstream)': list(range(64, 75)),
}


def load(scen):
    ds = xr.open_dataset(f'{RERUN_ROOT}/{scen}/sfincs_map.nc')
    h = ds['h'].values
    v = ds['v'].values
    msk = ds['msk'].values
    times = ds['time'].values
    ds.close()
    return h, v, msk, times


def peak_discharge(h, v, msk, times, row):
    row_msk = msk[row, :] == 1
    Qt = np.nansum(np.where(row_msk[None, :], h[:, row, :] * v[:, row, :] * 100.0, 0.0), axis=1)
    idx = int(np.argmax(np.abs(Qt)))
    return float(Qt[idx]), str(times[idx])[:19]


results = {'source': SOURCE, 'sites': {}}

for site, rows in CANDIDATE_ROWS.items():
    print(f'=== {site} ===', flush=True)
    site_result = {'candidate_rows': {}, 'published_m3s': PUBLISHED[site]}
    for scen in PUBLISHED[site]:
        h, v, msk, times = load(scen)
        row_results = {}
        for R in rows:
            q, t = peak_discharge(h, v, msk, times, R)
            row_results[R] = {'peak_q_m3s': round(abs(q), 1), 'peak_time': t}
            print(f'  {scen} row={R}: |Q|={abs(q):.1f} m3/s at {t}', flush=True)
        site_result['candidate_rows'][scen] = row_results
        del h, v, msk
    results['sites'][site] = site_result

with open(OUT_PATH, 'w') as f:
    json.dump(results, f, indent=2)
print(f'\nDONE. wrote {OUT_PATH}', flush=True)
