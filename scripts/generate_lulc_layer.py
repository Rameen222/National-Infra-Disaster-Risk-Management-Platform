"""
Render the same mardan_real_cn.tif used for the LULC pie chart as a
colorized map overlay (land-cover class only, soil group dropped since it's
not visually meaningful on its own). Written at the raster's own real
extent/CRS (EPSG:4326) so it needs its own corner quad, separate from the
SFINCS grid's.
"""
import numpy as np
import rasterio
from PIL import Image
import json

CN_TIF = 'C:/NDMA/FLOOD_SIMULATION/mardan_real_cn.tif'
OUT_DIR = 'C:/NDMA/infra_portal/client/public/data/flood-mardan/sfincs'
MANIFEST = f'{OUT_DIR}/manifest.json'

# Same table as compute_lulc_soil_and_stats.py / LULC_COLORS in the JS —
# code -> (label, CN_B, CN_D)
CN_TABLE = {
    10: ('Forest', 60, 79),
    20: ('Shrubland', 56, 77),
    30: ('Grassland / Pasture', 61, 80),
    40: ('Cropland', 78, 89),
    50: ('Built-up', 85, 92),
    60: ('Bare / sparse vegetation', 86, 94),
    80: ('Open water', 98, 98),
    0: ('Unclassified', 70, 85),
}
# Matches LULC_COLORS order in FloodSimulationPage.jsx
LABEL_COLOR = {
    'Cropland': (212, 166, 87),
    'Forest': (46, 125, 50),
    'Grassland / Pasture': (139, 195, 74),
    'Shrubland': (175, 180, 43),
    'Built-up': (120, 144, 156),
    'Bare / sparse vegetation': (188, 170, 164),
    'Open water': (79, 195, 247),
    'Unclassified': (176, 190, 197),
}

value_to_label = {}
for code, (label, cnb, cnd) in CN_TABLE.items():
    value_to_label.setdefault(float(cnb), label)
    value_to_label.setdefault(float(cnd), label)

with rasterio.open(CN_TIF) as src:
    arr = src.read(1)
    nodata = src.nodata
    bounds = src.bounds

h, w = arr.shape
rgba = np.zeros((h, w, 4), dtype=np.uint8)
for value, label in value_to_label.items():
    mask = arr == value
    if not mask.any():
        continue
    color = LABEL_COLOR.get(label, (150, 150, 150))
    rgba[mask] = (*color, 165)  # semi-transparent so it reads as an overlay
if nodata is not None:
    rgba[arr == nodata] = (0, 0, 0, 0)

img = Image.fromarray(rgba, 'RGBA')
img.save(f'{OUT_DIR}/lulc.png')
print('wrote lulc.png', img.size)

# rasterio bounds are already the true pixel-edge extent (not cell-center),
# and row 0 of the array is the NORTH edge (rasterio convention) — opposite
# of the SFINCS grid, so no flipud needed here, and corners are a plain
# axis-aligned box in WGS84 already.
corners = [
    [bounds.left, bounds.top],
    [bounds.right, bounds.top],
    [bounds.right, bounds.bottom],
    [bounds.left, bounds.bottom],
]
print('lulc corners:', corners)

with open(MANIFEST) as f:
    manifest = json.load(f)
manifest['lulcLayer'] = {'file': 'lulc.png', 'corners': corners}
with open(MANIFEST, 'w') as f:
    json.dump(manifest, f)
print('manifest updated with lulcLayer')
