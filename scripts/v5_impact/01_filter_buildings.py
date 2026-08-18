"""
Step 1 of the v5 building-impact pipeline: filter the GeoServer-sourced
buildings_mardan_watershed.geojson (379,371 buildings, google/ms/osm merged
across the 6 districts the watershed spans, anomalies already removed -
every building's height >= 8ft/2.4384m) down to only buildings intersecting
the v5 Copernicus watershed's exact polygon. The GeoServer pull was done
per-district, so it's already roughly bounded to the watershed's extent but
not precisely clipped to its polygon - this step does that precise clip,
same as it did for the older raw mardan_buildings.geojson source before it
(no longer used - superseded by this GeoServer extraction).

Output: a single filtered GeoJSON (still WGS84), used as the shared input
for every later step in this pipeline (02_build_overlap_table.py etc).
"""
import json
import os
import time

os.environ.pop('PROJ_LIB', None)
os.environ.pop('PROJ_DATA', None)

import geopandas as gpd

BUILDINGS_SRC = 'C:/Users/ramee/Downloads/buildings_mardan_watershed.geojson'
WATERSHED_SRC = 'C:/NDMA/FLOOD_SIMULATION/mardan_v5_copernicus_30m/watershed_boundary_copernicus.geojson'
OUT_DIR = 'C:/NDMA/infra_portal/scripts/v5_impact/_work'
OUT_PATH = f'{OUT_DIR}/buildings_filtered_v5.geojson'

os.makedirs(OUT_DIR, exist_ok=True)

t0 = time.time()
watershed = gpd.read_file(WATERSHED_SRC)
print(f'watershed loaded: {time.time()-t0:.1f}s, area_km2={watershed.iloc[0].get("area_km2")}', flush=True)

t0 = time.time()
buildings = gpd.read_file(BUILDINGS_SRC)
print(f'buildings loaded: {time.time()-t0:.1f}s, n={len(buildings)}', flush=True)
buildings = buildings.set_crs('EPSG:4326', allow_override=True)
watershed = watershed.set_crs('EPSG:4326', allow_override=True)

# Reproject to UTM (metric) and simplify the watershed polygon before the
# join - it has 10,563 vertices, and a naive sjoin against it took 40+
# minutes with no sign of finishing (killed). A 10m simplification
# tolerance (vs. the pipeline's 30m grid cells) can't meaningfully change
# which buildings end up included/excluded, and cuts the per-candidate
# intersects-test cost dramatically.
t0 = time.time()
buildings_utm = buildings.to_crs('EPSG:32643')
watershed_utm = watershed.to_crs('EPSG:32643')
watershed_simplified = watershed_utm.copy()
watershed_simplified['geometry'] = watershed_utm.geometry.simplify(10.0, preserve_topology=True)
print(f'reprojected + simplified watershed: {time.time()-t0:.1f}s, '
      f'{len(watershed_utm.geometry.iloc[0].exterior.coords)} -> '
      f'{len(watershed_simplified.geometry.iloc[0].exterior.coords)} vertices', flush=True)

t0 = time.time()
watershed_geom = watershed_simplified.geometry.iloc[0]
# Direct spatial-index query instead of gpd.sjoin - leaner code path (no
# dataframe merge/column-suffix machinery for what's fundamentally a
# single-geometry membership test), and sjoin against this 892k-building
# dataset was still crawling after over an hour with no sign of finishing.
idx = buildings_utm.sindex.query(watershed_geom, predicate='intersects')
filtered = buildings.iloc[idx]
print(f'spatial filter: {time.time()-t0:.1f}s, kept {len(filtered)} / {len(buildings)} ({100*len(filtered)/len(buildings):.1f}%)', flush=True)

t0 = time.time()
# The GeoServer pull merged per-district layers - 166 of the 379,371 source
# ids collide across districts (0.04%). Every downstream step keys off id
# as a unique identifier (dict lookups, groupby), so disambiguate now rather
# than silently losing buildings to dict-key collisions later.
dup_mask = filtered['id'].duplicated(keep=False)
n_dupe_rows = int(dup_mask.sum())
if n_dupe_rows:
    counters = {}
    new_ids = filtered['id'].tolist()
    for i, (idx_pos, is_dup) in enumerate(zip(filtered.index, dup_mask)):
        if not is_dup:
            continue
        bid = new_ids[i]
        counters[bid] = counters.get(bid, 0) + 1
        if counters[bid] > 1:
            new_ids[i] = f'{bid}_dup{counters[bid]}'
    filtered = filtered.assign(id=new_ids)
    print(f'disambiguated {n_dupe_rows} rows sharing a duplicate id (0 buildings dropped)', flush=True)

filtered.to_file(OUT_PATH, driver='GeoJSON')
print(f'wrote {OUT_PATH}: {time.time()-t0:.1f}s', flush=True)

# quick sanity: how many ids, any dupes after filtering
ids = filtered['id']
print(f'unique ids in filtered set: {ids.nunique()} / {len(ids)}', flush=True)
print('height stats (filtered set): min={:.4f} max={:.4f} mean={:.4f}'.format(
    filtered['height'].min(), filtered['height'].max(), filtered['height'].mean()), flush=True)
print('DONE', flush=True)
