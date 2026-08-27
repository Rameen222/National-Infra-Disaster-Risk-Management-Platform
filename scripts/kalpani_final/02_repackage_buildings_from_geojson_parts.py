"""
Flood Vulnerability V2 (Kalpani/FLOOD_SIMULATION_FINAL) - repackage the
ALREADY-COMPUTED building vulnerability analysis (30 geojson parts, real
area-weighted exactextract results against a 30m FABDEM-downscaled flood
surface - see buildings_flood_vulnerability/README_buildings_flood_vulnerability.md)
into the same chunked structure FloodVulnerabilityV2Page.jsx expects.

Does NOT recompute anything - pure repackage, same principle as
10_repackage_vuln_from_flood_depth_parts.py (use the delivered analysis,
don't redo it). Differences from that script, all confirmed by directly
inspecting this source data before writing this:
  - geometry is in EPSG:32643 (UTM), not already WGS84 - reprojected here.
  - no bbox property - representative point computed from geometry itself.
  - height_m (not height), in_kalpani_domain flag (not a separate polygon
    clip), 11 scenarios (not 4), 5-tier vuln_class scheme (not 4-tier).
  - outside_model_domain buildings (in_kalpani_domain=false, ~0.3%) are
    dropped entirely here, not carried through and filtered client-side.

Output field is written as "height" (renamed from height_m) so the
frontend component's code can stay as close as possible to the original
FloodVulnerabilityPage.jsx.

Output (client/public/data/flood-vulnerability-v2/):
  buildings-impact/manifest.json         (cellSize/bounds/rows/cols/scenarios+classDistribution)
  buildings-impact/<scenario>/<row>_<col>.geojson
  buildings-impact/<scenario>/severity_index.json
  scenario_summary.csv
"""
import csv
import json
import os
import time

from pyproj import Transformer

PARTS_DIR = 'C:/NDMA/FLOOD_SIMULATION_FINAL/buildings_flood_vulnerability/geojson_parts'
N_PARTS = 30
OUT_DIR = 'C:/NDMA/infra_portal/client/public/Data_2'
DEPTH_MANIFEST_PATH = f'{OUT_DIR}/depth_manifest.json'

SCENARIOS = [
    'event_2006', 'event_2010', 'design_T5', 'design_T10', 'design_T25',
    'design_T50', 'design_T100', 'P50_ordinary', 'P75_notable',
    'P90_moderate', 'illustrative_25jul2011',
]
VULN_CLASSES = ['none', 'low', 'moderate', 'high', 'very_high']
CELL_SIZE = 0.015

to_wgs = Transformer.from_crs('EPSG:32643', 'EPSG:4326', always_xy=True)

METHODOLOGY = (
    "Real area-weighted zonal statistics (exactextract) against a 30m "
    "FABDEM-downscaled flood surface, computed and delivered pre-built - "
    "not recomputed here, only repackaged into per-scenario viewport "
    "chunks. vuln_class buckets are ratio=hmax30/height: none (<10%), "
    "low (10-30%), moderate (30-60%), high (60-100%), very_high (>=100%). "
    "Buildings outside the active model domain (~0.3%) are excluded "
    "entirely, not counted. NOTE: the depth raster itself is the native "
    "100m SFINCS computational grid (zsmax-zb), coarser than the 30m "
    "surface this building analysis used - the two will not always "
    "visually agree cell-for-cell; this is a disclosed resolution "
    "mismatch, not a bug."
)


def reproject_geometry(geom):
    t = geom['type']
    coords = geom['coordinates']

    def tx_ring(ring):
        xs = [p[0] for p in ring]
        ys = [p[1] for p in ring]
        lons, lats = to_wgs.transform(xs, ys)
        return [[lon, lat] for lon, lat in zip(lons, lats)]

    if t == 'Polygon':
        new_coords = [tx_ring(ring) for ring in coords]
    elif t == 'MultiPolygon':
        new_coords = [[tx_ring(ring) for ring in poly] for poly in coords]
    else:
        raise ValueError(f'unexpected geometry type {t}')
    return {'type': t, 'coordinates': new_coords}, new_coords


def representative_point_lonlat(geom_type, new_coords):
    # cheap vertex-average of the outer ring (same rough-centroid spirit
    # as the original script's bbox-center - fine for chunk bucketing and
    # popup display, not used for area/geometry math).
    if geom_type == 'Polygon':
        ring = new_coords[0]
    else:
        ring = new_coords[0][0]
    lon = sum(p[0] for p in ring) / len(ring)
    lat = sum(p[1] for p in ring) / len(ring)
    return lon, lat


with open(DEPTH_MANIFEST_PATH) as f:
    depth_manifest = json.load(f)
lons = [c[0] for c in depth_manifest['corners']]
lats = [c[1] for c in depth_manifest['corners']]
BOUNDS = [min(lons), min(lats), max(lons), max(lats)]
ROWS = int((BOUNDS[3] - BOUNDS[1]) / CELL_SIZE) + 1
COLS = int((BOUNDS[2] - BOUNDS[0]) / CELL_SIZE) + 1
print(f'chunk grid: bounds={BOUNDS} rows={ROWS} cols={COLS}', flush=True)

os.makedirs(OUT_DIR, exist_ok=True)

chunk_buckets = {scen: {} for scen in SCENARIOS}
severity = {scen: {cls: [] for cls in ['low', 'moderate', 'high', 'very_high']} for scen in SCENARIOS}
class_counts = {scen: {cls: 0 for cls in VULN_CLASSES} for scen in SCENARIOS}

n_total = 0
n_kept = 0
n_excluded = 0

for i in range(1, N_PARTS + 1):
    t0 = time.time()
    path = f'{PARTS_DIR}/kalpani_buildings_flood_vulnerability_part{i:02d}of30.geojson'
    with open(path) as f:
        data = json.load(f)
    for feat in data['features']:
        n_total += 1
        p = feat['properties']
        if not p.get('in_kalpani_domain'):
            n_excluded += 1
            continue
        n_kept += 1

        geom, new_coords = reproject_geometry(feat['geometry'])
        lon, lat = representative_point_lonlat(geom['type'], new_coords)
        height = p.get('height_m')
        bid = p.get('id')

        col_idx = min(max(int((lon - BOUNDS[0]) / CELL_SIZE), 0), COLS - 1)
        row_idx = min(max(int((lat - BOUNDS[1]) / CELL_SIZE), 0), ROWS - 1)

        for scen in SCENARIOS:
            hmax = p.get(f'hmax30_{scen}_m')
            ratio = p.get(f'ratio_{scen}')
            cls = p.get(f'vuln_class_{scen}') or 'none'
            class_counts[scen][cls] = class_counts[scen].get(cls, 0) + 1

            key = (row_idx, col_idx)
            chunk_buckets[scen].setdefault(key, []).append({
                'type': 'Feature',
                'geometry': geom,
                'properties': {
                    'id': bid,
                    'height': height,
                    'hmax': round(hmax, 3) if hmax is not None else None,
                    'ratio': round(ratio, 3) if ratio is not None else None,
                    'vulnClass': cls,
                },
            })
            if cls in severity[scen]:
                severity[scen][cls].append({
                    'id': bid, 'lon': round(lon, 6), 'lat': round(lat, 6),
                    'height': round(height, 2) if height is not None else None,
                    'hmax': round(hmax, 3) if hmax is not None else None,
                    'ratio': round(ratio, 3) if ratio is not None else None,
                })
    print(f'  part{i:02d}: {time.time()-t0:.1f}s (kept {n_kept}, excluded {n_excluded}, total seen {n_total})', flush=True)

print(f'\n{n_kept} kept / {n_excluded} excluded (outside_model_domain) / {n_total} total '
      f'({100*n_excluded/n_total:.2f}% excluded)', flush=True)

manifest = {
    'cellSize': CELL_SIZE, 'bounds': BOUNDS, 'rows': ROWS, 'cols': COLS,
    'totalBuildings': n_total, 'excludedOutsideDomain': n_excluded,
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

print('\nALL SCENARIOS DONE. manifest written to', f'{OUT_DIR}/buildings-impact/manifest.json', flush=True)
