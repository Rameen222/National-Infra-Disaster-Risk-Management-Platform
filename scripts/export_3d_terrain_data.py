"""
Export decimated binary heightmap + per-scenario flood-depth grids for the
Three.js 3D terrain page. Same real SFINCS data as the 2D page's PNG
overlays, just spatially decimated (every 3rd cell, ~174x184 instead of
523x552) since a WebGL terrain mesh doesn't need per-150m-cell vertex
density to look good, and it keeps the binary payloads small enough to
fetch progressively per scenario instead of one huge blob.

Outputs (client/public/data/flood-mardan/terrain3d/):
  heightmap.bin       - Float32, decimated elevation grid (metres)
  meta.json           - grid dims, real-world bounds, elevation range
  <scenario>/depth_###.bin - Float32, decimated depth grid per frame (metres, 0 = dry)
"""
import numpy as np
import xarray as xr
import json
import os

MODEL_DIR = 'C:/NDMA/FLOOD_SIMULATION/mardan_full_real_model_FILLED_v2'
OUT_DIR = 'C:/NDMA/infra_portal/client/public/data/flood-mardan/terrain3d'
SCENARIOS = ['050mm', '100mm', '150mm', '200mm']
DECIMATE = 3
FRAME_STRIDE = 3
DRY_THRESHOLD = 0.03

os.makedirs(OUT_DIR, exist_ok=True)

print('opening reference scenario for terrain heightmap...')
ds0 = xr.open_dataset(f'{MODEL_DIR}/scenario_200mm/sfincs_map.nc')
zb = ds0.zb.values[::DECIMATE, ::DECIMATE]  # row 0 = south (same convention as 2D script)
x = ds0.x.values[::DECIMATE, ::DECIMATE]
y = ds0.y.values[::DECIMATE, ::DECIMATE]
n, m = zb.shape
print(f'decimated grid: {n} x {m} (from {ds0.zb.shape})')

zb.astype('<f4').tofile(f'{OUT_DIR}/heightmap.bin')

meta = {
    'rows': n,
    'cols': m,
    'utmBounds': [float(x.min()), float(y.min()), float(x.max()), float(y.max())],
    'cellSizeM': 150.0 * DECIMATE,
    'elevationRange': [float(np.nanmin(zb)), float(np.nanmax(zb))],
    'scenarios': [],
}
ds0.close()

for scen in SCENARIOS:
    ds = xr.open_dataset(f'{MODEL_DIR}/scenario_{scen}/sfincs_map.nc')
    times = ds.time.values
    idxs = list(range(0, len(times), FRAME_STRIDE))
    if idxs[-1] != len(times) - 1:
        idxs.append(len(times) - 1)

    scen_dir = f'{OUT_DIR}/{scen}'
    os.makedirs(scen_dir, exist_ok=True)
    frames = []
    for fi, ti in enumerate(idxs):
        depth = ds.h.isel(time=ti).values[::DECIMATE, ::DECIMATE]
        depth = np.where(depth < DRY_THRESHOLD, 0.0, depth)
        fname = f'depth_{fi:03d}.bin'
        depth.astype('<f4').tofile(f'{scen_dir}/{fname}')
        frames.append({
            'file': f'{scen}/{fname}',
            'time': str(times[ti]),
            'maxDepth': round(float(np.nanmax(depth)), 3),
        })
    meta['scenarios'].append({'id': scen, 'mm': int(scen.replace('mm', '')), 'frames': frames})
    print(f'{scen}: {len(frames)} frames written')
    ds.close()

with open(f'{OUT_DIR}/meta.json', 'w') as f:
    json.dump(meta, f)
print('done')
