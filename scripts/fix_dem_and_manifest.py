"""
Follow-up fixes to the SFINCS web assets:
1. Re-render terrain_dem.png with an earthy hypsometric ramp instead of
   matplotlib's 'terrain' colormap (its bottom ~30% is ocean-blue, which
   was washing out this all-inland 276-2770m terrain and making the flood
   layer hard to distinguish from it).
2. Augment manifest.json with per-scenario duration/peak-depth and
   per-frame elapsed-hours, computed from data already in the manifest
   (no need to re-read the 100+MB NetCDF files for this).
"""
import numpy as np
import xarray as xr
from PIL import Image
import json
from datetime import datetime

MODEL_DIR = 'C:/NDMA/FLOOD_SIMULATION/mardan_full_real_model_FILLED_v2'
OUT_DIR = 'C:/NDMA/infra_portal/client/public/data/flood-mardan/sfincs'

# Earthy hypsometric tint: river lowland green -> tan/olive -> brown -> grey peaks.
ELEV_STOPS = [
    (0.00, (86, 120, 66)),
    (0.20, (140, 148, 82)),
    (0.42, (176, 152, 96)),
    (0.65, (148, 112, 78)),
    (0.85, (128, 100, 88)),
    (1.00, (207, 201, 190)),
]


def ramp(norm, stops):
    h, w = norm.shape
    rgb = np.zeros((h, w, 3), dtype=np.float32)
    for i in range(len(stops) - 1):
        t0, c0 = stops[i]
        t1, c1 = stops[i + 1]
        mask = (norm >= t0) & (norm <= t1)
        if not mask.any():
            continue
        t = ((norm[mask] - t0) / (t1 - t0))[:, None]
        rgb[mask] = np.array(c0, dtype=np.float32) * (1 - t) + np.array(c1, dtype=np.float32) * t
    return rgb.astype(np.uint8)


print('reopening scenario for zb...')
ds0 = xr.open_dataset(f'{MODEL_DIR}/scenario_200mm/sfincs_map.nc')
zb = ds0.zb.values
zmin, zmax = float(np.nanmin(zb)), float(np.nanmax(zb))
norm = np.clip((zb - zmin) / (zmax - zmin), 0, 1)
rgb = ramp(norm, ELEV_STOPS)
alpha = np.full(zb.shape, 255, dtype=np.uint8)
dem_rgba = np.dstack([rgb, alpha])
Image.fromarray(np.flipud(dem_rgba), 'RGBA').save(f'{OUT_DIR}/terrain_dem.png')
print(f'wrote earthy terrain_dem.png (elevation {zmin:.0f}-{zmax:.0f}m)')
ds0.close()

print('augmenting manifest.json with time/peak-depth info...')
with open(f'{OUT_DIR}/manifest.json') as f:
    manifest = json.load(f)

manifest['elevationRange'] = [zmin, zmax]

for scen in manifest['scenarios']:
    frames = scen['frames']
    t0 = datetime.fromisoformat(frames[0]['time'])
    peak = 0.0
    for fr in frames:
        t = datetime.fromisoformat(fr['time'])
        fr['elapsedHours'] = round((t - t0).total_seconds() / 3600, 2)
        peak = max(peak, fr['maxDepth'])
    scen['peakDepth'] = round(peak, 3)
    scen['durationHours'] = frames[-1]['elapsedHours']

with open(f'{OUT_DIR}/manifest.json', 'w') as f:
    json.dump(manifest, f)
print('done')
