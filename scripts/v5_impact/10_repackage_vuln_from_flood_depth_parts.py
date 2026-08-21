"""
Repackage the ALREADY-COMPLETED building vulnerability analysis (delivered
as flood_depth_parts/buildings_mardan_watershed_flood_depth_part[1-6]of6,
one exactextract-based hmax30_<tag>_m / ratio_<tag> / vuln_class_<tag> set
per building, per scenario, already computed and verified) into the
chunked structure the frontend (FloodVulnerabilityPage.jsx) reads.

Does NOT recompute anything - this is a pure repackage/fix of the existing
analysis. It exists because the previous buildings-impact-v3 output (built
from the same source data by a different process) had two bugs:
  1. manifest.json never got a classDistribution field, so every severity
     legend button rendered permanently disabled.
  2. The 100mm and 150mm severity_index.json files were truncated
     mid-write (invalid JSON).

Uses ONLY flood_depth_parts - no cross-referencing against
buildings_mardan_watershed.geojson or any other file for filtering. Every
building in the 6 parts is included as-is (domain_coverage_frac in this
source is ~1 for essentially all features - it reflects coverage against
the SFINCS grid's bounding box, not true watershed-polygon membership, so
it isn't a usable filter and none is applied here).

Output (overwrites in place, same structure the frontend already reads):
  client/public/data/flood-mardan-v5/buildings-impact-v3/
    manifest.json                    (now includes classDistribution)
    <scenario>/<row>_<col>.geojson   (vulnClass/height/hmax/ratio)
    <scenario>/severity_index.json   (regenerated, valid JSON)
"""
import json
import os
import time

PARTS_DIR = 'C:/NDMA/FLOOD_SIMULATION/mardan_v5_copernicus_30m/flood_depth_parts'
PARTS = [f'buildings_mardan_watershed_flood_depth_part{i}of6' for i in range(1, 7)]

OUT_DIR = 'C:/NDMA/infra_portal/client/public/data/flood-mardan-v5/buildings-impact-v3'
SCENARIOS = ['050mm', '100mm', '150mm', '200mm']
VULN_CLASSES = ['no_inundation', 'shallow', 'moderate', 'deep', 'fully_submerged']

CELL_SIZE = 0.015
BOUNDS = [71.72712617000002, 34.04823869999999, 72.47738431, 34.580531210000004]
ROWS = 36
COLS = 51

METHODOLOGY = (
    "Area-weighted mean of the scenario's peak (30h) hmax band over each "
    "building footprint (exactextract polygon/flood-cell intersection, "
    "dry cells counted as 0) - the completed, verified analysis delivered "
    "as flood_depth_parts/, repackaged here into per-scenario chunks for "
    "the frontend's viewport-driven loading. vulnClass buckets are "
    "ratio=hmax/height: no_inundation (hmax~0), shallow (<=10%), "
    "moderate (10-30%), deep (30-100%), fully_submerged (>=100%)."
)

os.makedirs(OUT_DIR, exist_ok=True)

# bucket by (scenario -> chunk key -> list of features), built incrementally
# while streaming the 6 source parts once, to avoid holding all scenarios'
# full feature lists in memory redundantly.
chunk_buckets = {scen: {} for scen in SCENARIOS}
severity = {scen: {cls: [] for cls in ['shallow', 'moderate', 'deep', 'fully_submerged']} for scen in SCENARIOS}
class_counts = {scen: {cls: 0 for cls in VULN_CLASSES} for scen in SCENARIOS}

n_seen = 0
n_kept = 0
for part in PARTS:
    t0 = time.time()
    path = f'{PARTS_DIR}/{part}/{part}.geojson'
    with open(path) as f:
        data = json.load(f)
    for feat in data['features']:
        n_seen += 1
        p = feat['properties']
        bid = p['id']
        n_kept += 1
        geom = feat['geometry']
        bbox = p.get('bbox', {})
        lon = (bbox.get('xmin', 0) + bbox.get('xmax', 0)) / 2
        lat = (bbox.get('ymin', 0) + bbox.get('ymax', 0)) / 2
        height = p.get('height')

        col_idx = min(max(int((lon - BOUNDS[0]) / CELL_SIZE), 0), COLS - 1)
        row_idx = min(max(int((lat - BOUNDS[1]) / CELL_SIZE), 0), ROWS - 1)

        for scen in SCENARIOS:
            hmax = p.get(f'hmax30_{scen}_m', 0.0) or 0.0
            ratio = p.get(f'ratio_{scen}', 0.0) or 0.0
            cls = p.get(f'vuln_class_{scen}', 'no_inundation')
            class_counts[scen][cls] = class_counts[scen].get(cls, 0) + 1

            key = (row_idx, col_idx)
            chunk_buckets[scen].setdefault(key, []).append({
                'type': 'Feature',
                'geometry': geom,
                'properties': {
                    'id': bid,
                    'height': height,
                    'hmax': round(hmax, 3),
                    'ratio': round(ratio, 3),
                    'vulnClass': cls,
                },
            })
            if cls in severity[scen]:
                severity[scen][cls].append({
                    'id': bid, 'lon': round(lon, 6), 'lat': round(lat, 6),
                    'height': round(height, 2) if height is not None else None,
                    'hmax': round(hmax, 3), 'ratio': round(ratio, 3),
                })
    print(f'  {part}: {time.time()-t0:.1f}s (running total: {n_kept})', flush=True)

print(f'\n{n_kept} buildings total (all of flood_depth_parts, no external filtering)', flush=True)

manifest = {
    'cellSize': CELL_SIZE, 'bounds': BOUNDS, 'rows': ROWS, 'cols': COLS,
    'methodology': METHODOLOGY, 'scenarios': [],
}

for scen in SCENARIOS:
    t0 = time.time()
    scen_dir = f'{OUT_DIR}/{scen}'
    os.makedirs(scen_dir, exist_ok=True)
    cells_meta = []
    for (r, c), features in chunk_buckets[scen].items():
        fname = f'{r}_{c}.geojson'
        with open(f'{scen_dir}/{fname}', 'w') as f:
            json.dump({'type': 'FeatureCollection', 'features': features}, f)
        cells_meta.append({'row': r, 'col': c, 'file': fname, 'count': len(features)})

    for cls in severity[scen]:
        severity[scen][cls].sort(key=lambda e: -e['hmax'])
    with open(f'{scen_dir}/severity_index.json', 'w') as f:
        json.dump(severity[scen], f)

    manifest['scenarios'].append({'id': scen, 'cells': cells_meta, 'classDistribution': class_counts[scen]})
    print(f'  {scen}: wrote {len(cells_meta)} chunks + severity_index.json ({time.time()-t0:.1f}s) '
          f'- class distribution: {class_counts[scen]}', flush=True)

with open(f'{OUT_DIR}/manifest.json', 'w') as f:
    json.dump(manifest, f)
print('\nALL SCENARIOS DONE. manifest written to', f'{OUT_DIR}/manifest.json', flush=True)
