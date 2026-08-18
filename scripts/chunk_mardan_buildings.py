"""
One-time preprocessing: split the 490MB Mardan buildings dataset into a grid
of small GeoJSON chunks so the Flood Simulation page can load only the
buildings actually in view, instead of one huge unparseable file.

No tippecanoe/GDAL CLI is available on this machine, so this is a pure-Python
"poor man's vector tiling" — a fixed spatial grid instead of a real zoom
pyramid. That's fine here because the page only ever shows this one fixed
study area, not a freely-explorable map of all of Pakistan.
"""
import geopandas as gpd
import numpy as np
import json
import os
import time

SRC = 'C:/NDMA/flood_simulation_mardan/app/public/data/buildings/mardan_buildings.geojson'
OUT_DIR = 'C:/NDMA/infra_portal/client/public/data/flood-mardan/buildings-grid'
CELL_SIZE = 0.05  # degrees, ~5.5km x 4.6km cells at this latitude
COORD_PRECISION = 6  # ~0.11m at this latitude, plenty for building footprints
MIN_HEIGHT = 3.0  # floor for extrusion — raw dataset has many near-zero heights

os.makedirs(OUT_DIR, exist_ok=True)

t0 = time.time()
gdf = gpd.read_file(SRC, engine='pyogrio', columns=['height'])
print(f'loaded {len(gdf)} rows in {time.time() - t0:.1f}s')

minx, miny, maxx, maxy = gdf.total_bounds
n_cols = int(np.ceil((maxx - minx) / CELL_SIZE))
n_rows = int(np.ceil((maxy - miny) / CELL_SIZE))
print(f'grid: {n_cols} cols x {n_rows} rows = {n_cols * n_rows} cells')

sindex = gdf.sindex
manifest_cells = []
total_written = 0

for row in range(n_rows):
    y0 = miny + row * CELL_SIZE
    y1 = min(y0 + CELL_SIZE, maxy)
    for col in range(n_cols):
        x0 = minx + col * CELL_SIZE
        x1 = min(x0 + CELL_SIZE, maxx)
        cell = gdf.cx[x0:x1, y0:y1]
        if len(cell) == 0:
            continue
        # Round coordinates and floor heights for visual clarity, drop
        # everything except height — nothing else is needed for extrusion.
        cell = cell.copy()
        cell['height'] = np.maximum(cell['height'].fillna(MIN_HEIGHT), MIN_HEIGHT).round(1)
        cell['geometry'] = cell.geometry.set_precision(10 ** (-COORD_PRECISION))
        fname = f'{row}_{col}.geojson'
        cell[['height', 'geometry']].to_file(os.path.join(OUT_DIR, fname), driver='GeoJSON')
        size = os.path.getsize(os.path.join(OUT_DIR, fname))
        manifest_cells.append({
            'row': row, 'col': col, 'file': fname,
            'count': int(len(cell)), 'bytes': size,
            'bounds': [x0, y0, x1, y1],
        })
        total_written += len(cell)
        print(f'  cell {row}_{col}: {len(cell)} buildings, {size / 1024:.0f}KB')

manifest = {
    'cellSize': CELL_SIZE,
    'bounds': [minx, miny, maxx, maxy],
    'cols': n_cols,
    'rows': n_rows,
    'totalBuildings': total_written,
    'cells': manifest_cells,
}
with open(os.path.join(OUT_DIR, 'manifest.json'), 'w') as f:
    json.dump(manifest, f)

print(f'done: {len(manifest_cells)} non-empty cells, {total_written} buildings written, {time.time() - t0:.1f}s total')
