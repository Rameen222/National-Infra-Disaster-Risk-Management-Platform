"""
Flood Vulnerability V2 - schools_manifest.json

The per-scenario buildings-impact/<scenario>/<cell>.geojson files already
tag school buildings with has_school=1 (plus Schoolname/UCName), but the
client would otherwise have to fetch every one of the ~969 per-cell files
per scenario just to pull out the ~2,982 schools among them - the general
buildings layer gets away with that because it only loads cells inside the
current viewport at zoom >= 11, but a schools layer needs to be visible
watershed-wide at any zoom, so that lazy per-cell loading doesn't apply.

This script scans every cell file, once, and writes ONE compact manifest:
  - schools: static per-building fields (a point centroid of the footprint,
    name, UC, height) that never change across scenarios
  - scenarios[<id>].classDistribution + .byId: the only things that DO
    change per scenario (hmax/ratio/vulnClass), keyed by building id so the
    client can join them onto `schools` without repeating lon/lat 11x.

Building ids are stable across scenarios (same footprints, same ids - only
the flood classification changes), which is what makes this join valid.
Footprints are MultiPolygon; each school's point is the centroid of its
first polygon's exterior ring - good enough for a map marker.
"""
import json
import os

DATA_DIR = 'C:/NDMA/infra_portal/client/public/Data_2_final'
IMPACT_DIR = f'{DATA_DIR}/buildings-impact'

with open(f'{IMPACT_DIR}/manifest.json') as f:
    manifest = json.load(f)
SCENARIOS = [s['id'] for s in manifest['scenarios']]


def footprint_centroid(geometry):
    gtype = geometry['type']
    coords = geometry['coordinates']
    if gtype == 'MultiPolygon':
        ring = coords[0][0]
    elif gtype == 'Polygon':
        ring = coords[0]
    elif gtype == 'Point':
        return coords[0], coords[1]
    else:
        raise ValueError(f'unexpected geometry type: {gtype}')
    xs = [c[0] for c in ring]
    ys = [c[1] for c in ring]
    return sum(xs) / len(xs), sum(ys) / len(ys)


# schools[id] = static fields, filled in on first sighting (same across
# every scenario's cell files since footprints don't move).
schools = {}
# per_scenario[scenario][id] = {hmax, ratio, vulnClass}
per_scenario = {scen: {} for scen in SCENARIOS}

for scen in SCENARIOS:
    scen_dir = f'{IMPACT_DIR}/{scen}'
    cell_files = [f for f in os.listdir(scen_dir) if f.endswith('.geojson')]
    for fname in cell_files:
        with open(f'{scen_dir}/{fname}') as f:
            gj = json.load(f)
        for feat in gj['features']:
            p = feat['properties']
            if int(p.get('has_school') or 0) != 1:
                continue
            bid = p['id']
            if bid not in schools:
                lon, lat = footprint_centroid(feat['geometry'])
                schools[bid] = {
                    'id': bid,
                    'name': (p.get('Schoolname') or '').strip(),
                    'uc': (p.get('UCName') or '').strip(),
                    'height': p.get('height'),
                    'lon': round(lon, 6),
                    'lat': round(lat, 6),
                }
            per_scenario[scen][bid] = {
                'hmax': p.get('hmax'),
                'ratio': p.get('ratio'),
                'vulnClass': p.get('vulnClass'),
            }
    n = len(per_scenario[scen])
    print(f'{scen}: {n} school buildings tagged', flush=True)

class_distribution = {}
for scen in SCENARIOS:
    dist = {}
    for rec in per_scenario[scen].values():
        dist[rec['vulnClass']] = dist.get(rec['vulnClass'], 0) + 1
    class_distribution[scen] = dist

out = {
    'schools': list(schools.values()),
    'scenarios': {
        scen: {
            'classDistribution': class_distribution[scen],
            'byId': per_scenario[scen],
        }
        for scen in SCENARIOS
    },
}

out_path = f'{DATA_DIR}/schools_manifest.json'
with open(out_path, 'w') as f:
    json.dump(out, f)

total_size_kb = os.path.getsize(out_path) / 1024
print(f'\n{len(schools)} unique school buildings across {len(SCENARIOS)} scenarios')
print(f'DONE -> {out_path} ({total_size_kb:.0f} KB)')
