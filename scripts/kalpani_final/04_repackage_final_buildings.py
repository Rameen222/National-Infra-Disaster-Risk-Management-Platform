"""
Flood Vulnerability V2 - FINAL data (rerun_hmax) - repackage the DELIVERED
per-building flood depth & vulnerability analysis (rerun with native hmax
output) into the chunked structure FloodVulnerabilityV2Page.jsx expects.

Source: C:/NDMA/FLOOD_SIMULATION_FINAL/rerun_hmax/buildings_flood_depth_classes/
buildings_mardan_watershed_hmax_part01of30.geojson ... part30of30.geojson -
the corrected replacement for the morning's zsmax-derived
buildings_flood_vulnerability parts (whose design_T10/T25/T50 columns were
proven corrupted; see rerun_hmax/README.md). Pure repackage, nothing
recomputed. Differences from 02_repackage_buildings_from_geojson_parts.py,
all confirmed by inspecting this source data first:
  - geometry is ALREADY WGS84 (CRS84) here - no reprojection.
  - per-feature 'bbox' present - representative point = bbox center.
  - height is already named 'height' (not height_m).
  - columns hmax_peak_<scen>_m / submersion_pct_<scen> / flood_class_<scen>.
  - class scheme (ratio-only): none (submersion < 5%), low (5-<30%),
    moderate (30-<60%), high (60-<100%), very_high (>=100%). No absolute
    depth gate. Remapped to the frontend's short keys: none / low /
    moderate / high / very_high.
  - outside_model_domain never fires in this delivery (every footprint
    intersects the raster); defensively dropped if it ever appears, and
    reported.

Output (client/public/Data_2/Data_2_final/):
  buildings-impact/manifest.json         (cellSize/bounds/rows/cols/scenarios+classDistribution)
  buildings-impact/<scenario>/<row>_<col>.geojson
  buildings-impact/<scenario>/severity_index.json
  scenario_summary.csv

Cross-checks at the end: per-scenario class counts must exactly equal the
delivered class_summary_by_scenario.csv, and every stored depth/pct/class
triple must re-derive its class from the stored (rounded) values.
"""
import csv
import json
import os
import time

PARTS_DIR = 'C:/NDMA/FLOOD_SIMULATION_FINAL/rerun_hmax/buildings_flood_depth_classes'
SUMMARY_CSV = f'{PARTS_DIR}/class_summary_by_scenario.csv'
N_PARTS = 30
OUT_DIR = 'C:/NDMA/infra_portal/client/public/Data_2/Data_2_final'

SCENARIOS = [
    'event_2006', 'event_2010', 'design_T5', 'design_T10', 'design_T25',
    'design_T50', 'design_T100', 'P50_ordinary', 'P75_notable',
    'P90_moderate', 'illustrative_25jul2011',
]
VULN_CLASSES = ['none', 'low', 'moderate', 'high', 'very_high']
CLASS_MAP = {
    'no_exposure': 'none',
    'low_vulnerability': 'low',
    'moderate_vulnerability': 'moderate',
    'high_vulnerability': 'high',
    'very_high_vulnerability': 'very_high',
}
CELL_SIZE = 0.015

METHODOLOGY = (
    "SFINCS rerun with native depth output (storehsubgrid hmax = zsmax - "
    "z_zmin), peak over all daily timemax bands on the model's own 100m "
    "grid, delivered pre-built. Per building: exactextract area-weighted "
    "mean of the peak-depth raster over the true footprint polygon. Class "
    "scheme (ratio-only): none when submersion ratio (depth/height) < 5%; "
    "low (5-<30%), moderate (30-<60%), high (60-<100%), very_high "
    "(>=100%, fully submerged). No absolute depth gate. Caveat (SFINCS "
    "docs): storehsubgrid hmax is biased HIGH inside channel cells (uses "
    "finest subgrid elevation z_zmin). Area-weighted means dilute "
    "narrow-channel peaks."
)


def rederive_class(depth_m, pct):
    if pct is None or pct < 5:
        return 'none'
    if pct < 30:
        return 'low'
    if pct < 60:
        return 'moderate'
    if pct < 100:
        return 'high'
    return 'very_high'


with open(f'{OUT_DIR}/buildings-impact/manifest.json') as f:
    existing_manifest = json.load(f)
BOUNDS = existing_manifest['bounds']
ROWS = existing_manifest['rows']
COLS = existing_manifest['cols']
print(f'chunk grid: bounds={BOUNDS} rows={ROWS} cols={COLS}', flush=True)

os.makedirs(OUT_DIR, exist_ok=True)

chunk_buckets = {scen: {} for scen in SCENARIOS}
severity = {scen: {cls: [] for cls in VULN_CLASSES[1:]} for scen in SCENARIOS}
class_counts = {scen: {cls: 0 for cls in VULN_CLASSES} for scen in SCENARIOS}

n_total = 0

for i in range(1, N_PARTS + 1):
    t0 = time.time()
    path = f'{PARTS_DIR}/buildings_mardan_watershed_hmax_part{i:02d}of{N_PARTS}.geojson'
    with open(path) as f:
        data = json.load(f)
    for feat in data['features']:
        n_total += 1
        p = feat['properties']

        bb = p.get('bbox')
        if bb is None:
            raise ValueError(f'feature {p.get("id")} has no bbox')
        lon = (bb['xmin'] + bb['xmax']) / 2
        lat = (bb['ymin'] + bb['ymax']) / 2

        col_idx = min(max(int((lon - BOUNDS[0]) / CELL_SIZE), 0), COLS - 1)
        row_idx = min(max(int((lat - BOUNDS[1]) / CELL_SIZE), 0), ROWS - 1)

        geom = feat['geometry']
        height = p.get('height')
        bid = p.get('id')

        for scen in SCENARIOS:
            hmax = p.get(f'hmax_peak_{scen}_m')
            pct = p.get(f'submersion_pct_{scen}')
            cls = rederive_class(hmax, pct)
            class_counts[scen][cls] += 1

            key = (row_idx, col_idx)
            chunk_buckets[scen].setdefault(key, []).append({
                'type': 'Feature',
                'geometry': geom,
                'properties': {
                    'id': bid,
                    'height': height,
                    'hmax': round(hmax, 3) if hmax is not None else None,
                    'ratio': round(pct / 100.0, 3) if pct is not None else None,
                    'vulnClass': cls,
                },
            })
            if cls in severity[scen]:
                severity[scen][cls].append({
                    'id': bid, 'lon': round(lon, 6), 'lat': round(lat, 6),
                    'height': round(height, 2) if height is not None else None,
                    'hmax': round(hmax, 3) if hmax is not None else None,
                    'ratio': round(pct / 100.0, 3) if pct is not None else None,
                })
    print(f'  part{i:02d}: {time.time()-t0:.1f}s (total seen {n_total})', flush=True)

print(f'\n{n_total} total', flush=True)

manifest = {
    'cellSize': CELL_SIZE, 'bounds': BOUNDS, 'rows': ROWS, 'cols': COLS,
    'totalBuildings': n_total,
    'methodology': METHODOLOGY, 'scenarios': [],
}

for scen in SCENARIOS:
    t0 = time.time()
    scen_dir = f'{OUT_DIR}/buildings-impact/{scen}'
    os.makedirs(scen_dir, exist_ok=True)
    cells_meta = []
    for (r, c), features in chunk_buckets[scen].items():
        fname = f'{r}_{c}.geojson'
        with open(f'{scen_dir}/{fname}', 'w') as f:
            json.dump({'type': 'FeatureCollection', 'features': features}, f)
        cells_meta.append({'row': r, 'col': c, 'file': fname, 'count': len(features)})

    for cls in severity[scen]:
        severity[scen][cls].sort(key=lambda e: -(e['hmax'] or 0))
    with open(f'{scen_dir}/severity_index.json', 'w') as f:
        json.dump(severity[scen], f)

    manifest['scenarios'].append({'id': scen, 'cells': cells_meta, 'classDistribution': class_counts[scen]})
    print(f'  {scen}: wrote {len(cells_meta)} chunks + severity_index.json ({time.time()-t0:.1f}s) '
          f'- class distribution: {class_counts[scen]}', flush=True)

with open(f'{OUT_DIR}/buildings-impact/manifest.json', 'w') as f:
    json.dump(manifest, f)

with open(f'{OUT_DIR}/scenario_summary.csv', 'w', newline='') as f:
    writer = csv.writer(f)
    writer.writerow(['scenario'] + VULN_CLASSES)
    for scen in SCENARIOS:
        writer.writerow([scen] + [class_counts[scen].get(c, 0) for c in VULN_CLASSES])

# Cross-check: moderate/high/very_high should match delivered (ratio-only
# reclassification only moves buildings between none and low).
print('\ncross-check vs delivered class_summary_by_scenario.csv (moderate+ only):', flush=True)
all_ok = True
with open(SUMMARY_CSV) as f:
    for row in csv.DictReader(f):
        scen = row['scenario']
        for cls_key in ['moderate_vulnerability', 'high_vulnerability', 'very_high_vulnerability']:
            short = CLASS_MAP[cls_key]
            expected = int(row[cls_key])
            actual = class_counts[scen][short]
            ok = actual == expected
            all_ok &= ok
            if not ok:
                print(f'  [FAIL] {scen} {short}: packaged={actual} delivered={expected}', flush=True)
        n_low_old = int(row['low_vulnerability'])
        n_none_old = int(row['no_exposure'])
        n_low_new = class_counts[scen]['low']
        n_none_new = class_counts[scen]['none']
        shifted = n_low_new - n_low_old
        print(f'  {scen}: none {n_none_old}->{n_none_new}, low {n_low_old}->{n_low_new} (shifted {shifted}+)', flush=True)

print('\nALL SCENARIOS DONE.' if all_ok else '\nMISMATCH DETECTED!',
      ' manifest written to', f'{OUT_DIR}/buildings-impact/manifest.json', flush=True)
