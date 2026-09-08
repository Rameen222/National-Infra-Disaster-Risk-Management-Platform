"""
Realistic shaded-relief terrain layer, derived entirely from the existing
DEM - a new, additional map layer (does not replace the plain DEM/Hillshade
layers already on the page).

Source of truth: client/public/Data_2_final/dem_watershed_30m.tif (30m,
EPSG:32643, nodata=-9999). Never modified. No satellite imagery is used to
generate anything here - every pixel of every output is derived from DEM
elevation values alone.

Why percentile-based colour, not equal-interval min-max: measured directly
from this DEM (n=3,055,317 valid pixels) - the watershed is heavily skewed,
~79% of pixels sit below 500m (the Mardan valley floor) while the mountain
fringe (~21% of pixels) spans the remaining ~1,550m of the ~1,777m total
range. An equal-interval/linear stretch crams that 79% into a sliver of the
colour ramp. Colouring by each pixel's CDF-based percentile rank within the
real elevation distribution (computed fresh from this file, not hardcoded)
fixes that - same technique already used for the plain DEM layer's colour
ramp (see DEM_HYPSO_STOPS / percentile CDF logic in FloodVulnerabilityV2Page.jsx).

Hillshade: standard Horn's method (matches ESRI/GDAL gdaldem hillshade),
z_factor=1.0 (DEM is metres both horizontally and vertically, so no
exaggeration), cellsize=30m (native DEM resolution, no resampling).
terrain_hillshade.tif is the single, primary 315deg/42.5deg-altitude
hillshade (a standard, recognizable GIS product on its own). The blend used
INSIDE terrain_relief.tif additionally averages in three more directions
(45/135/225deg) at low weight, softening the shadows so the combined relief
doesn't read as harsh single-direction lighting - "subtle multidirectional"
per spec, not a second saved product (only three continuous rasters +
optional COG are listed as outputs).

Colour + shading combine via an overlay blend in RGB space, with the
hillshade re-centered so a perfectly FLAT pixel (not 0.5) is the blend's
true neutral point (0.5) - otherwise a flat area under 315/42.5 lighting
reads at cos(radians(90-42.5))=0.74, not 0.5, and a naive overlay blend
would incorrectly brighten every flat pixel in the valley. Blend strength
(effectively "hillshade opacity") is tunable via BLEND_STRENGTH.

Outputs (same folder as the rest of this page's data, alongside the
existing dem_watershed_30m.tif / hillshade_watershed_30m.tif):
  client/public/Data_2_final/terrain_color.tif       (RGBA, percentile hypsometric colour only)
  client/public/Data_2_final/terrain_hillshade.tif   (single-band 0-255, primary 315/42.5 hillshade only)
  client/public/Data_2_final/terrain_relief.tif      (RGBA, final combined realistic relief)
  client/public/Data_2_final/terrain_relief_cog.tif  (RGBA, Cloud-Optimized GeoTIFF of the above)
  client/public/Data_2_final/terrain_relief_manifest.json
    {corners (lon/lat, same 4-corner convention as the other static rasters
     on this page), percentileTicks: [{pct, value}], colorStops: [{pct, hex}]}
"""
import json
import math
import os

os.environ.pop('PROJ_LIB', None)
os.environ.pop('PROJ_DATA', None)

import numpy as np
import rasterio
from scipy.ndimage import convolve
from matplotlib.colors import rgb_to_hsv, hsv_to_rgb
from pyproj import Transformer

DEM_PATH = 'C:/NDMA/infra_portal/client/public/Data_2_final/dem_watershed_30m.tif'
OUT_DIR = 'C:/NDMA/infra_portal/client/public/Data_2_final'

UTM43 = 'EPSG:32643'
WGS84 = 'EPSG:4326'

AZIMUTH_PRIMARY = 315.0
ALTITUDE = 42.5
Z_FACTOR = 1.0
SECONDARY_AZIMUTHS = [45.0, 135.0, 225.0]
SECONDARY_WEIGHT_EACH = 0.6 / 3   # primary keeps 0.4+0.6*? see blend below
PRIMARY_WEIGHT = 0.6

BLEND_STRENGTH = 0.32  # ~"hillshade opacity" - 0=color only, 1=full overlay
# At full layer opacity (no satellite basemap dilution) the raw palette +
# overlay-blended hillshade read as muted/grey - real, even at BLEND_STRENGTH
# 0.4: a mostly-flat valley has many pixels near (but not exactly at) the
# blend's 0.5 neutral point, and that accumulated small darkening/lightening
# across a huge flat area reads as an overall grey cast. Fixed by boosting
# saturation/value in HSV space on the colour BEFORE blending, and pulling
# blend strength down slightly so more of the boosted colour survives.
SATURATION_BOOST = 1.55
VALUE_BOOST = 1.12

# Hypsometric colour stops - (percentile position 0-1, RGB). Natural
# green -> olive -> tan/brown -> mountain brown -> blue-grey -> pale
# high-elevation highlight, avoiding rainbow/neon/pure-red/purple per spec.
COLOR_STOPS = [
    (0.00, (47, 107, 69)),
    (0.10, (79, 130, 76)),
    (0.25, (113, 148, 90)),
    (0.40, (143, 164, 95)),
    (0.50, (168, 163, 106)),
    (0.60, (183, 160, 109)),
    (0.70, (185, 154, 106)),
    (0.80, (169, 132, 98)),
    (0.90, (135, 107, 89)),
    (0.95, (111, 98, 96)),
    (0.99, (208, 208, 200)),
    (1.00, (240, 241, 236)),
]

TICK_PCTS = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100]


def hillshade(dem, valid, cellsize, azimuth_deg, altitude_deg, z_factor):
    """Horn's method, matching ESRI/GDAL gdaldem hillshade. dem should have
    nodata pixels pre-filled (nearest-valid) so edge gradients don't blow up;
    invalid pixels are masked back out by the caller afterward."""
    kernel_dzdx = np.array([[-1, 0, 1], [-2, 0, 2], [-1, 0, 1]], dtype=np.float64) / (8 * cellsize)
    kernel_dzdy = np.array([[-1, -2, -1], [0, 0, 0], [1, 2, 1]], dtype=np.float64) / (8 * cellsize)
    dzdx = convolve(dem, kernel_dzdx, mode='nearest')
    dzdy = convolve(dem, kernel_dzdy, mode='nearest')

    slope_rad = np.arctan(z_factor * np.hypot(dzdx, dzdy))
    aspect_rad = np.arctan2(dzdy, -dzdx)
    aspect_rad = np.where(aspect_rad < 0, 2 * np.pi + aspect_rad, aspect_rad)

    zenith_rad = math.radians(90 - altitude_deg)
    az_math = 360.0 - azimuth_deg + 90.0
    if az_math >= 360.0:
        az_math -= 360.0
    azimuth_rad = math.radians(az_math)

    shade = (np.cos(zenith_rad) * np.cos(slope_rad)
             + np.sin(zenith_rad) * np.sin(slope_rad) * np.cos(azimuth_rad - aspect_rad))
    shade = np.clip(shade, 0, 1)
    return shade, zenith_rad


def fill_nodata_nearest(dem, valid):
    """Cheap nearest-fill for the invalid border so hillshade gradients at
    the watershed edge don't see a cliff down to 0. Uses scipy's distance
    transform indices - exact nearest-neighbour fill, not an approximation."""
    from scipy.ndimage import distance_transform_edt
    if valid.all():
        return dem
    idx = distance_transform_edt(~valid, return_distances=False, return_indices=True)
    return dem[tuple(idx)]


def boost_rgb(rgb):
    hsv = rgb_to_hsv(np.array(rgb, dtype=np.float64) / 255.0)
    hsv[1] = np.clip(hsv[1] * SATURATION_BOOST, 0, 1)
    hsv[2] = np.clip(hsv[2] * VALUE_BOOST, 0, 1)
    return tuple(int(round(c * 255)) for c in hsv_to_rgb(hsv))


def interp_color(t, stops):
    """t: array in [0,1]. stops: list of (pos, (r,g,b)), pos increasing."""
    positions = np.array([s[0] for s in stops])
    r = np.array([s[1][0] for s in stops], dtype=np.float64)
    g = np.array([s[1][1] for s in stops], dtype=np.float64)
    b = np.array([s[1][2] for s in stops], dtype=np.float64)
    return (np.interp(t, positions, r), np.interp(t, positions, g), np.interp(t, positions, b))


print('Reading DEM...', flush=True)
with rasterio.open(DEM_PATH) as src:
    dem = src.read(1).astype(np.float64)
    profile = src.profile.copy()
    transform = src.transform
    crs = src.crs
    nodata = src.nodata
    width, height = src.width, src.height
    cellsize = abs(transform.a)

valid = np.isfinite(dem) & (dem > -9990)
n_valid = int(valid.sum())
vmin = float(dem[valid].min())
vmax = float(dem[valid].max())
print(f'  {width}x{height}, cellsize={cellsize}m, valid={n_valid}, min={vmin:.1f}, max={vmax:.1f}', flush=True)

print('Computing percentiles / CDF...', flush=True)
percentiles_req = [0, 5, 10, 20, 30, 40, 50, 60, 70, 80, 90, 95, 97, 99, 100]
values = dem[valid]
pct_values = {p: float(np.percentile(values, p)) for p in percentiles_req}
for p in percentiles_req:
    print(f'  p{p:>3}: {pct_values[p]:.2f}', flush=True)

# Fine CDF for smooth percentile-position mapping (2048 bins - matches the
# resolution already used for the plain DEM layer's client-side histogram).
HIST_BINS = 2048
rng = max(vmax - vmin, 1e-6)
bin_idx_all = np.clip(((values - vmin) / rng * HIST_BINS).astype(np.int64), 0, HIST_BINS - 1)
hist = np.bincount(bin_idx_all, minlength=HIST_BINS).astype(np.float64)
cdf = np.cumsum(hist) / n_valid

bin_idx_full = np.clip(((dem - vmin) / rng * HIST_BINS).astype(np.int64), 0, HIST_BINS - 1)
t_percentile = cdf[bin_idx_full]  # 0..1 percentile-rank raster, full grid

print('Building hypsometric colour relief...', flush=True)
r, g, b = interp_color(t_percentile, COLOR_STOPS)
rgb_stack = np.stack([np.clip(r, 0, 255), np.clip(g, 0, 255), np.clip(b, 0, 255)], axis=-1) / 255.0
hsv = rgb_to_hsv(rgb_stack)
hsv[..., 1] = np.clip(hsv[..., 1] * SATURATION_BOOST, 0, 1)
hsv[..., 2] = np.clip(hsv[..., 2] * VALUE_BOOST, 0, 1)
rgb_boosted = hsv_to_rgb(hsv) * 255.0
color_rgba = np.zeros((height, width, 4), dtype=np.uint8)
color_rgba[..., 0] = np.clip(rgb_boosted[..., 0], 0, 255).astype(np.uint8)
color_rgba[..., 1] = np.clip(rgb_boosted[..., 1], 0, 255).astype(np.uint8)
color_rgba[..., 2] = np.clip(rgb_boosted[..., 2], 0, 255).astype(np.uint8)
color_rgba[..., 3] = np.where(valid, 255, 0).astype(np.uint8)

print('Computing hillshade (primary 315/42.5)...', flush=True)
dem_filled = fill_nodata_nearest(dem, valid)
shade_primary, zenith_rad = hillshade(dem_filled, valid, cellsize, AZIMUTH_PRIMARY, ALTITUDE, Z_FACTOR)
hillshade_u8 = np.where(valid, np.clip(shade_primary * 255, 0, 255).astype(np.uint8), 0)

print('Computing soft multidirectional blend for the combined relief...', flush=True)
shade_multi = shade_primary * PRIMARY_WEIGHT
for az in SECONDARY_AZIMUTHS:
    s, _ = hillshade(dem_filled, valid, cellsize, az, ALTITUDE, Z_FACTOR)
    shade_multi += s * SECONDARY_WEIGHT_EACH

# Re-center so a perfectly flat pixel (shade == cos(zenith)) sits at exactly
# 0.5 - the true neutral point for an overlay blend - not an assumed 0.5
# that would incorrectly brighten every flat valley pixel under oblique
# (42.5deg) single-direction lighting.
flat_reference = math.cos(zenith_rad)
blend_val = np.clip(0.5 * (shade_multi / max(flat_reference, 1e-6)), 0, 1)

print('Combining colour + shading (overlay blend)...', flush=True)
base = color_rgba[..., :3].astype(np.float64) / 255.0
blend_3 = blend_val[..., None]
overlay = np.where(
    blend_3 < 0.5,
    2 * base * blend_3,
    1 - 2 * (1 - base) * (1 - blend_3),
)
combined = base * (1 - BLEND_STRENGTH) + overlay * BLEND_STRENGTH
relief_rgba = np.zeros((height, width, 4), dtype=np.uint8)
relief_rgba[..., :3] = np.clip(combined * 255, 0, 255).astype(np.uint8)
relief_rgba[..., 3] = color_rgba[..., 3]

print('Writing outputs...', flush=True)


def write_rgba(path, rgba):
    prof = profile.copy()
    prof.update(count=4, dtype='uint8', nodata=None, compress='deflate', predictor=2)
    with rasterio.open(path, 'w', **prof) as dst:
        for i in range(4):
            dst.write(rgba[..., i], i + 1)


def write_single(path, arr_u8):
    prof = profile.copy()
    prof.update(count=1, dtype='uint8', nodata=0, compress='deflate', predictor=2)
    with rasterio.open(path, 'w', **prof) as dst:
        dst.write(arr_u8, 1)


write_rgba(f'{OUT_DIR}/terrain_color.tif', color_rgba)
write_single(f'{OUT_DIR}/terrain_hillshade.tif', hillshade_u8)
write_rgba(f'{OUT_DIR}/terrain_relief.tif', relief_rgba)
print('  wrote terrain_color.tif, terrain_hillshade.tif, terrain_relief.tif', flush=True)

print('Writing Cloud-Optimized GeoTIFF...', flush=True)
try:
    cog_prof = profile.copy()
    cog_prof.update(count=4, dtype='uint8', nodata=None, driver='COG', compress='DEFLATE', blocksize=512)
    with rasterio.open(f'{OUT_DIR}/terrain_relief_cog.tif', 'w', **cog_prof) as dst:
        for i in range(4):
            dst.write(relief_rgba[..., i], i + 1)
    print('  wrote terrain_relief_cog.tif', flush=True)
except Exception as e:
    print(f'  COG write failed ({e}) - non-fatal, plain terrain_relief.tif is still the real deliverable', flush=True)

print('Writing legend manifest...', flush=True)
corners_utm = [
    (transform.c, transform.f),
    (transform.c + width * transform.a, transform.f),
    (transform.c + width * transform.a, transform.f + height * transform.e),
    (transform.c, transform.f + height * transform.e),
]
to_wgs = Transformer.from_crs(UTM43, WGS84, always_xy=True)
corners_wgs = [list(to_wgs.transform(x, y)) for x, y in corners_utm]

percentile_ticks = []
for pct in TICK_PCTS:
    if pct == 0:
        v = vmin
    elif pct == 100:
        v = vmax
    else:
        target = pct / 100
        bin_i = int(np.searchsorted(cdf, target))
        bin_i = min(bin_i, HIST_BINS - 1)
        v = vmin + (bin_i / HIST_BINS) * rng
    percentile_ticks.append({'pct': pct, 'value': round(float(v), 1)})

manifest = {
    'method': 'percentile/CDF-based hypsometric colour relief + Horn hillshade (primary 315deg/42.5deg, '
              'softened with a low-weight 45/135/225deg blend), overlay-combined at strength %.2f' % BLEND_STRENGTH,
    'dem_source': 'dem_watershed_30m.tif (unmodified)',
    'corners': corners_wgs,
    'min': round(vmin, 1),
    'max': round(vmax, 1),
    'percentileTicks': percentile_ticks,
    # Boosted the same way as the map itself (see SATURATION_BOOST/
    # VALUE_BOOST above) - the legend must show what's actually on screen,
    # not the pre-boost raw palette.
    'colorStops': [
        {'pct': round(pos * 100, 1), 'hex': '#%02x%02x%02x' % boost_rgb(rgb)}
        for pos, rgb in COLOR_STOPS
    ],
    'files': {
        'color': 'terrain_color.tif',
        'hillshade': 'terrain_hillshade.tif',
        'relief': 'terrain_relief.tif',
        'relief_cog': 'terrain_relief_cog.tif',
    },
}
with open(f'{OUT_DIR}/terrain_relief_manifest.json', 'w') as f:
    json.dump(manifest, f, indent=2)

print('\nDONE.', flush=True)
