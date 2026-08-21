"""
Self-serve explorer: inspect hmax directly from each scenario's .nc file
with xarray, alongside the building footprints, for ALL 4 scenarios.

This is meant for YOU to run and look at, not just me. Edit the config
block below, then run:

    python scripts/v5_impact/xarray_hmax_explorer.py

Two kinds of output, per scenario (all under _work/diagnostics/):

1. domain_<scenario>.png
   The WHOLE domain: hmax (band1+band2 combined) as a background heatmap,
   with every building's centroid plotted on top as a dot - red if hmax
   at that building's own cell is >= WET_THRESHOLD, blue if not. This is
   the "zoom out and look at the whole watershed at once" view - lets you
   spot whether red/blue looks spatially sane (red should cluster along
   the river/low ground) across the ENTIRE building set, not a handful of
   picked examples.

2. building_<id>_<scenario>.png
   Zoomed in on ONE building, ONE scenario: a 2x2 grid of small heatmaps
   (hmax band1 alone / hmax band2 alone / hmax combined / true running-max
   for reference) covering a small neighborhood of cells around the
   building, every cell's raw numeric value printed on it, and the
   building's actual footprint polygon drawn in red on top of all four.
   This is the "why does THIS building show THIS number" view.

   BUILDING_IDS below controls which buildings get this treatment. Leave
   it empty and the script will auto-pick the worst "dry building right
   next to deep water" case per scenario (same method used earlier this
   session) - or paste in specific building ids (from a popup, or from
   severity_index.json) to check exactly the ones you're suspicious of.
   The SAME building list is used for all 4 scenarios, so you can compare
   one building across rainfall intensities side by side.

Nothing here writes to or changes any pipeline output - purely read-only
inspection.
"""
import os

os.environ.pop('PROJ_LIB', None)
os.environ.pop('PROJ_DATA', None)

import geopandas as gpd
import matplotlib

matplotlib.use('Agg')
import matplotlib.pyplot as plt
import numpy as np
import xarray as xr
from matplotlib.patches import Polygon as MplPolygon
from scipy.ndimage import maximum_filter

# ---------------------------------------------------------------------------
# CONFIG - edit this block
# ---------------------------------------------------------------------------
SCENARIOS = ['050mm', '100mm', '150mm', '200mm']

# Paste specific building ids here to always inspect them, e.g.:
# BUILDING_IDS = ['Pakistan_123102132_6890', '8J6H9Q2R+4Q97']
# Leave empty to auto-pick the worst "dry but next to deep water" case
# per scenario instead.
BUILDING_IDS = []
N_AUTO_PER_SCENARIO = 2       # only used when BUILDING_IDS is empty
ZOOM_PAD_CELLS = 6            # how many cells around the building to show
WET_THRESHOLD = 0.3           # matches the pipeline's DRY_DEPTH_THRESHOLD
NEIGHBORHOOD_CELLS = 5         # 5 cells = 150m, for the auto-pick "gap" search

FLOOD_ROOT = 'C:/NDMA/FLOOD_SIMULATION/mardan_v5_copernicus_30m'
WORK_DIR = 'C:/NDMA/infra_portal/scripts/v5_impact/_work'
BUILDINGS_PATH = f'{WORK_DIR}/buildings_filtered_v5.geojson'
OUT_DIR = f'{WORK_DIR}/diagnostics'
os.makedirs(OUT_DIR, exist_ok=True)


def read_inp(path):
    inp = {}
    with open(path) as f:
        for line in f:
            if '=' in line:
                k, v = line.split('=', 1)
                inp[k.strip()] = v.strip()
    return inp


def safe_name(bid):
    return bid.replace('+', '_').replace('/', '_')


# ---------------------------------------------------------------------------
# Load buildings ONCE (scenario-independent geometry), reproject, get every
# building's own grid cell. Vectorized - fast even for 365k buildings.
# ---------------------------------------------------------------------------
print('loading buildings...', flush=True)
gdf = gpd.read_file(BUILDINGS_PATH).set_crs('EPSG:4326', allow_override=True)
gdf_utm = gdf.to_crs('EPSG:32643')
ids = gdf['id'].values
heights = gdf['height'].values
centroids = gdf_utm.geometry.centroid
ux, uy = centroids.x.values, centroids.y.values
id_to_index = {bid: i for i, bid in enumerate(ids)}

# ---------------------------------------------------------------------------
# Per scenario
# ---------------------------------------------------------------------------
for scen in SCENARIOS:
    print(f'\n=== {scen} ===', flush=True)
    base = f'{FLOOD_ROOT}/scenario_{scen}'
    ds = xr.open_dataset(f'{base}/sfincs_map.nc')
    msk = ds.msk.values
    active = msk == 1
    hmax_b1 = np.nan_to_num(ds.hmax.values[0], nan=0.0)
    hmax_b2 = np.nan_to_num(ds.hmax.values[1], nan=0.0)
    ds.close()
    hmax_combined = np.maximum(hmax_b1, hmax_b2)

    running_max_path = f'C:/NDMA/infra_portal/client/public/data/flood-vulnerability/worstcase_grids/{scen}_running_max.npy'
    running_max = np.nan_to_num(np.load(running_max_path), nan=0.0)

    inp = read_inp(f'{base}/sfincs.inp')
    x0, y0 = float(inp['x0']), float(inp['y0'])
    dx, dy = float(inp['dx']), float(inp['dy'])
    nmax, mmax = int(inp['nmax']), int(inp['mmax'])

    col = np.clip(((ux - x0) / dx).astype(int), 0, mmax - 1)
    row = np.clip(((uy - y0) / dy).astype(int), 0, nmax - 1)
    hmax_at_building = hmax_combined[row, col]
    wet = hmax_at_building >= WET_THRESHOLD
    print(f'  hmax combined nanmax (active cells): {hmax_combined[active].max():.3f} m', flush=True)
    print(f'  buildings classified WET by hmax @ own cell (>= {WET_THRESHOLD}m): {wet.sum()} / {len(ids)}', flush=True)

    # --- domain-wide overview: hmax background + ALL buildings colored ---
    fig, ax = plt.subplots(figsize=(11, 11))
    ax.imshow(np.where(active, hmax_combined, np.nan), origin='lower', cmap='Blues', vmax=3)
    ax.scatter(col[~wet], row[~wet], s=2, c='#4477aa', alpha=0.25, rasterized=True, label='dry (by hmax)')
    ax.scatter(col[wet], row[wet], s=3, c='red', alpha=0.7, rasterized=True, label='wet (by hmax)')
    ax.legend(loc='upper right', markerscale=4)
    ax.set_title(f'{scen}: hmax combined (band1+band2 max) + every building, colored by hmax classification')
    ax.set_xlabel('col')
    ax.set_ylabel('row')
    domain_path = f'{OUT_DIR}/domain_{scen}.png'
    fig.savefig(domain_path, dpi=140, bbox_inches='tight')
    plt.close(fig)
    print(f'  wrote {domain_path}', flush=True)

    # --- pick target buildings for the zoomed 2x2 plots ---
    targets = list(BUILDING_IDS)
    if not targets:
        neigh_max = maximum_filter(hmax_combined, size=NEIGHBORHOOD_CELLS)
        gap = neigh_max[row, col] - hmax_at_building
        candidate_mask = (~wet) & (neigh_max[row, col] >= 1.0)
        order = np.argsort(-np.where(candidate_mask, gap, -1))[:N_AUTO_PER_SCENARIO]
        targets = [ids[i] for i in order]
        print(f'  auto-picked target buildings: {list(targets)}', flush=True)

    for bid in targets:
        if bid not in id_to_index:
            print(f'  !! building id {bid} not found in buildings_filtered_v5.geojson, skipping', flush=True)
            continue
        i = id_to_index[bid]
        rr, cc = row[i], col[i]
        r0, r1 = max(0, rr - ZOOM_PAD_CELLS), min(nmax, rr + ZOOM_PAD_CELLS + 1)
        c0, c1 = max(0, cc - ZOOM_PAD_CELLS), min(mmax, cc + ZOOM_PAD_CELLS + 1)

        geom_utm = gdf_utm.geometry.iloc[i]
        parts = geom_utm.geoms if geom_utm.geom_type == 'MultiPolygon' else [geom_utm]

        fig, axes = plt.subplots(2, 2, figsize=(16, 16))
        panels = [
            ('hmax band 1 (hours 0-30)', hmax_b1),
            ('hmax band 2 (hours 30-48)', hmax_b2),
            ('hmax combined (max of both bands)', hmax_combined),
            ('true running max (all 193 timesteps)', running_max),
        ]
        for ax, (title, grid) in zip(axes.flat, panels):
            sub = grid[r0:r1, c0:c1]
            ax.imshow(sub, origin='lower', cmap='Blues', vmax=max(2.0, sub.max()), extent=[c0, c1, r0, r1])
            for irow in range(r0, r1):
                for jcol in range(c0, c1):
                    v = grid[irow, jcol]
                    ax.text(jcol + 0.5, irow + 0.5, f'{v:.2f}', ha='center', va='center',
                            fontsize=6.5, color='black' if v < 1.5 else 'white')
            for part in parts:
                poly_rc = [((x - x0) / dx, (y - y0) / dy) for x, y in part.exterior.coords]
                ax.add_patch(MplPolygon(poly_rc, closed=True, edgecolor='red', facecolor='none', linewidth=2))
            ax.set_xlim(c0, c1)
            ax.set_ylim(r0, r1)
            ax.set_title(title, fontsize=11)

        fig.suptitle(f'{scen}: building {bid} (height={heights[i]:.2f}m, row={rr}, col={cc})\n'
                      f'red outline = actual footprint, numbers = raw cell depth (m)', fontsize=13)
        fig.tight_layout()
        b_path = f'{OUT_DIR}/building_{safe_name(bid)}_{scen}.png'
        fig.savefig(b_path, dpi=130, bbox_inches='tight')
        plt.close(fig)
        print(f'  wrote {b_path}', flush=True)

print('\nDONE. All PNGs are in', OUT_DIR, flush=True)
