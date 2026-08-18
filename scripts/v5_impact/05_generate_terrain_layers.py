"""
Generates the DEM-colour-tint and hillshade PNGs for the v5 page, matching
the exact visual treatment (earthy elevation ramp, relief-shading method,
opacity values) used by the original FloodSimulationPage.jsx - that page's
richer terrain look (vs. plain satellite + flood overlay) is what was
requested back after the v5 page's data-focused rebuild.

Reads the already-computed zb (elevation) grid from the streaming
running-max step (peak_grids/100mm_zb.npy - identical across scenarios,
100mm is just as good a source as any) rather than re-reading the .nc.

Outputs (client/public/data/flood-mardan-v5/dashboard/):
  terrain_dem.png       - earthy hypsometric tint
  terrain_hillshade.png - shaded relief overlay
"""
import numpy as np
from PIL import Image
from matplotlib.colors import LightSource

ZB_PATH = 'C:/NDMA/infra_portal/client/public/data/flood-mardan-v5/peak_grids/100mm_zb.npy'
MSK_PATH = 'C:/NDMA/infra_portal/client/public/data/flood-mardan-v5/peak_grids/100mm_msk.npy'
OUT_DIR = 'C:/NDMA/infra_portal/client/public/data/flood-mardan-v5/dashboard'
CELL_SIZE_M = 30.0

# Same earthy hypsometric tint as the original page's fix_dem_and_manifest.py -
# river lowland green -> tan/olive -> brown -> grey peaks.
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


zb = np.load(ZB_PATH)
msk = np.load(MSK_PATH)
active = msk == 1

zmin, zmax = float(np.nanmin(zb[active])), float(np.nanmax(zb[active]))
print(f'elevation range: {zmin:.0f}-{zmax:.0f}m', flush=True)

norm = np.clip((zb - zmin) / (zmax - zmin), 0, 1)
rgb = ramp(norm, ELEV_STOPS)
alpha = np.where(active, 255, 0).astype(np.uint8)
dem_rgba = np.dstack([rgb, alpha])
# row 0 in zb is the SOUTH edge; PNGs are north-up, so flip vertically -
# same convention as every other raster export in this pipeline.
Image.fromarray(np.flipud(dem_rgba), 'RGBA').save(f'{OUT_DIR}/terrain_dem.png')
print(f'wrote terrain_dem.png {dem_rgba.shape[1]}x{dem_rgba.shape[0]}', flush=True)

ls = LightSource(azdeg=315, altdeg=45)
hs = ls.hillshade(np.nan_to_num(zb, nan=zmin), vert_exag=3, dx=CELL_SIZE_M, dy=CELL_SIZE_M)
delta = hs - 0.5
hs_alpha = np.clip(np.abs(delta) * 2.2, 0, 1) * 190
hs_alpha = np.where(active, hs_alpha, 0)
tone = np.where(delta >= 0, 255, 0).astype(np.uint8)
hs_rgba = np.stack([tone, tone, tone, hs_alpha.astype(np.uint8)], axis=-1)
Image.fromarray(np.flipud(hs_rgba), 'RGBA').save(f'{OUT_DIR}/terrain_hillshade.png')
print(f'wrote terrain_hillshade.png {hs_rgba.shape[1]}x{hs_rgba.shape[0]}', flush=True)
print('DONE', flush=True)
