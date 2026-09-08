"""
Flood Vulnerability V2 - FINAL (rerun_hmax) - regenerate depth_manifest.json
for DIRECT client-side GeoTIFF rendering.

The rasters/ folder now contains VERBATIM copies of the delivered
rerun_hmax/buildings_flood_depth_classes/rasters/<scenario>_hmax_peak.tif
files (byte-for-byte, no reprocessing). The browser renders them straight
from their embedded georeferencing (geotiff.js reads origin/resolution),
so what the map shows is exactly the delivered dataset - same as opening
the tifs in QGIS. Zero-depth cells (the delivery's dry/inactive convention)
render transparent.

This script only computes the per-scenario 2-98 percentile stretch bounds
(min/max over wet cells) used for color scaling + the on-screen legend,
and writes the manifest.
"""
import json
import os

os.environ.pop('PROJ_LIB', None)
os.environ.pop('PROJ_DATA', None)

import numpy as np
import rasterio

OUT_DIR = 'C:/NDMA/infra_portal/client/public/Data_2/Data_2_final'
RASTER_DIR = f'{OUT_DIR}/rasters'

SCENARIOS = [
    ('event_2006', '5 Aug 2006', 'Historical events'),
    ('event_2010', '2010 event', 'Historical events'),
    ('design_T5', 'T5 design storm', 'Design storms (return period)'),
    ('design_T10', 'T10 design storm', 'Design storms (return period)'),
    ('design_T25', 'T25 design storm', 'Design storms (return period)'),
    ('design_T50', 'T50 design storm', 'Design storms (return period)'),
    ('design_T100', 'T100 design storm', 'Design storms (return period)'),
    ('P50_ordinary', 'P50 (ordinary)', 'Probabilistic'),
    ('P75_notable', 'P75 (notable)', 'Probabilistic'),
    ('P90_moderate', 'P90 (moderate)', 'Probabilistic'),
    ('illustrative_25jul2011', '25 Jul 2011 (illustrative)', 'Illustrative'),
]

manifest = {'source': 'VERBATIM copies of rerun_hmax/buildings_flood_depth_classes/rasters/<id>_hmax_peak.tif; rendered client-side from embedded georeferencing; 0 m = dry/inactive -> transparent', 'scenarios': []}
grids = set()

for scen, label, category in SCENARIOS:
    path = f'{RASTER_DIR}/{scen}_hmax_peak.tif'
    with rasterio.open(path) as src:
        arr = src.read(1)
        grids.add((src.transform.c, src.transform.f, src.transform.a, src.transform.e, *src.shape))
        wet = arr[np.isfinite(arr) & (arr > 0)]
        mn = float(np.percentile(wet, 2)) if wet.size else 0.0
        mx = float(np.percentile(wet, 98)) if wet.size else 0.0
        grid_max = float(arr.max())
    print(f'{scen}: stretch {mn:.3f}-{mx:.3f} m (wet-cell p2-p98), grid max {grid_max:.3f}', flush=True)
    manifest['scenarios'].append({
        'id': scen, 'label': label, 'category': category,
        'file': f'rasters/{scen}_hmax_peak.tif',
        'min': round(mn, 4), 'max': round(mx, 4), 'gridMax': round(grid_max, 3),
    })

assert len(grids) == 1, f'grid mismatch across delivered tifs: {grids}'
with open(f'{OUT_DIR}/depth_manifest.json', 'w') as f:
    json.dump(manifest, f)
print('\nDONE ->', f'{OUT_DIR}/depth_manifest.json')
