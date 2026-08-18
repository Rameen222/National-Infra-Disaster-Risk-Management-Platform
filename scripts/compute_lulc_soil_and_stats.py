"""
Compute LULC composition, dominant soil (HSG), and per-scenario peak
velocity / infiltration totals — all from data that already exists in the
FLOOD_SIMULATION project (nothing fabricated).

mardan_real_cn.tif combines land-cover (ESA WorldCover class) and soil
(Hydrologic Soil Group, from real SoilGrids clay%) into one Curve Number
value per pixel. Per derive_real_cn_from_soil_landcover.py's own lookup
table, every (landcover, soil) combination maps to a numerically distinct
CN value except open water (soil-independent) and one negligible edge case
(<0.2% of the domain, documented in manning_reclass_real.csv) — so the
raster can be decoded back into both breakdowns.
"""
import numpy as np
import rasterio
import xarray as xr
import json

CN_TIF = 'C:/NDMA/FLOOD_SIMULATION/mardan_real_cn.tif'
MODEL_DIR = 'C:/NDMA/FLOOD_SIMULATION/mardan_full_real_model_FILLED_v2'
OUT = 'C:/NDMA/infra_portal/client/public/data/flood-mardan/sfincs/manifest.json'

# code -> (label, CN_B, CN_D) — from derive_real_cn_from_soil_landcover.py
CN_TABLE = {
    10: ('Forest', 60, 79),
    20: ('Shrubland', 56, 77),
    30: ('Grassland / Pasture', 61, 80),
    40: ('Cropland', 78, 89),
    50: ('Built-up', 85, 92),
    60: ('Bare / sparse vegetation', 86, 94),
    80: ('Open water', 98, 98),
    0: ('Unclassified (edge, <0.2% of domain)', 70, 85),
}

with rasterio.open(CN_TIF) as src:
    arr = src.read(1)
    nodata = src.nodata

valid = arr[arr != nodata] if nodata is not None else arr.ravel()
total = valid.size

# value -> (code, soil) reverse lookup. The single genuine collision (85.0
# from both Built-up/B and Unclassified/D) is resolved to Built-up: the
# manning CSV documents Unclassified as <0.2% of the domain overall, while
# 85.0 alone is >5% here, so it is overwhelmingly Built-up/B.
value_to_class = {}
for code, (label, cnb, cnd) in CN_TABLE.items():
    value_to_class.setdefault(float(cnb), (label, 'B'))
    value_to_class.setdefault(float(cnd), (label, 'D'))

lulc_area = {}
hsg_area = {'B': 0, 'D': 0}
for v in np.unique(valid):
    count = int((valid == v).sum())
    label, soil = value_to_class.get(float(v), ('Unclassified', None))
    lulc_area[label] = lulc_area.get(label, 0) + count
    if label != 'Open water' and soil:
        hsg_area[soil] += count

lulc = sorted(
    [{'class': k, 'pct': round(v / total * 100, 1)} for k, v in lulc_area.items()],
    key=lambda d: -d['pct'],
)
hsg_total = hsg_area['B'] + hsg_area['D']
soil = {
    'dominant': 'Loam / Silt Loam (HSG B)' if hsg_area['B'] >= hsg_area['D'] else 'Clay Loam / Silty Clay / Clay (HSG D)',
    'hsgBPct': round(hsg_area['B'] / hsg_total * 100, 1),
    'hsgDPct': round(hsg_area['D'] / hsg_total * 100, 1),
    'note': 'Hydrologic Soil Group derived from real ISRIC SoilGrids clay% '
            '(NRCS texture-HSG correspondence): HSG B = clay < 27% (higher '
            'infiltration capacity), HSG D = clay >= 27% (slower infiltration).',
}

print('LULC:', lulc)
print('Soil:', soil)

scenario_stats = {}
for mm in ['050mm', '100mm', '150mm', '200mm']:
    ds = xr.open_dataset(f'{MODEL_DIR}/scenario_{mm}/sfincs_map.nc')
    peak_velocity = float(np.nanmax(ds.vmax.values))
    cuminf = ds.cuminf.values
    scenario_stats[str(int(mm.replace('mm', '')))] = {
        'peakVelocity': round(peak_velocity, 2),
        'meanInfiltration': round(float(np.nanmean(cuminf)) * 1000, 1),  # m -> mm
        'maxInfiltration': round(float(np.nanmax(cuminf)) * 1000, 1),
    }
    ds.close()
    print(mm, scenario_stats[str(int(mm.replace('mm', '')))])

with open(OUT) as f:
    manifest = json.load(f)
manifest['lulc'] = lulc
manifest['soil'] = soil
for s in manifest['scenarios']:
    key = str(s['mm'])
    s.update(scenario_stats[key])
with open(OUT, 'w') as f:
    json.dump(manifest, f)
print('manifest updated')
