"""
Diagnostic script: understand hmax vs the true running-max vs what's
actually stored/rendered for buildings, with plots.

WHAT THIS DOES AND WHY (read this before running):

1. Opens sfincs_map.nc directly with xarray - prints grid/CRS facts so you
   can see exactly what's being trusted (no QGIS export round-trip).

2. Finds real "problem" buildings automatically: for every building, looks
   up the running-max depth at its own centroid cell AND the max depth in
   the 5x5-cell (150m x 150m) neighborhood around it. A big gap between
   those two numbers is exactly the "building sits right next to visibly
   blue water but reads dry" complaint - this reproduces it as data instead
   of a screenshot.

3. For the worst few such buildings, prints a side-by-side table comparing
   FIVE different numbers that could each be called "the flood depth":
     - hmax band 1 alone (hours 0-30), at the building's own cell
     - hmax band 2 alone (hours 30-48), at the building's own cell
     - hmax combined (max of both bands), at the building's own cell
     - true running max (all 193 timesteps), at the building's own cell
     - the SAME true running max, but area-weighted across every cell the
       building's footprint actually overlaps (this is what the pipeline
       computes and what the Vulnerability page's popup shows)
   Plus, for comparison, what V5's page currently shows (domain-peak
   snapshot, area-weighted) - a genuinely different metric (one shared
   moment in time vs. each cell's own worst moment).

4. Saves two PNGs so you can SEE it, not just read numbers:
   - overview: full domain, running-max heatmap + every sampled building
     plotted on top, colored by whether it's a "gap" case
   - zoom: tight crop around the single worst gap case, raw grid values
     annotated per cell, building outline drawn on top - lets you see
     exactly which cells the building touches and what each one holds

Edit SCENARIO below to switch which of the 4 rainfall scenarios to inspect.
Run: python scripts/v5_impact/inspect_hmax_vs_buildings.py
Outputs written to: scripts/v5_impact/_work/diagnostics/
"""
import os

os.environ.pop('PROJ_LIB', None)
os.environ.pop('PROJ_DATA', None)

import json

import geopandas as gpd
import matplotlib

matplotlib.use('Agg')
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import xarray as xr
from matplotlib.patches import Polygon as MplPolygon
from scipy.ndimage import maximum_filter
from shapely.geometry import shape

SCENARIO = '100mm'  # change to 050mm / 150mm / 200mm and re-run

BASE = 'C:/NDMA/FLOOD_SIMULATION/mardan_v5_copernicus_30m/scenario_' + SCENARIO
NC_PATH = f'{BASE}/sfincs_map.nc'
INP_PATH = f'{BASE}/sfincs.inp'

WORK_DIR = 'C:/NDMA/infra_portal/scripts/v5_impact/_work'
BUILDINGS_PATH = f'{WORK_DIR}/buildings_filtered_v5.geojson'
OVERLAP_PATH = f'{WORK_DIR}/overlap_table.parquet'

RUNNING_MAX_PATH = f'C:/NDMA/infra_portal/client/public/data/flood-vulnerability/worstcase_grids/{SCENARIO}_running_max.npy'
V5_IMPACT_DIR = f'C:/NDMA/infra_portal/client/public/data/flood-mardan-v5/buildings-impact-v2/{SCENARIO}'
VULN_IMPACT_DIR = f'C:/NDMA/infra_portal/client/public/data/flood-vulnerability/buildings-impact/{SCENARIO}'

OUT_DIR = f'{WORK_DIR}/diagnostics'
os.makedirs(OUT_DIR, exist_ok=True)

N_PROBLEM_CASES = 5          # how many "gap" buildings to print/inspect in detail
GAP_NEIGHBORHOOD_CELLS = 5   # 5x5 cells = 150m x 150m window
DRY_THRESHOLD = 0.3


def read_inp(path):
    inp = {}
    with open(path) as f:
        for line in f:
            if '=' in line:
                k, v = line.split('=', 1)
                inp[k.strip()] = v.strip()
    return inp


# ---------------------------------------------------------------------------
# 1. Open the .nc directly, print grid/CRS facts
# ---------------------------------------------------------------------------
print(f'=== SCENARIO: {SCENARIO} ===', flush=True)
ds = xr.open_dataset(NC_PATH)
print('crs var attrs:', dict(ds['crs'].attrs), flush=True)
print('x range:', float(ds.x.min()), float(ds.x.max()), flush=True)
print('y range:', float(ds.y.min()), float(ds.y.max()), flush=True)

hmax = ds.hmax.values  # (2, n, m)
msk = ds.msk.values
active = msk == 1
print('hmax shape:', hmax.shape, flush=True)
print('timemax (band timestamps):', ds.timemax.values, flush=True)
print(f'hmax band1 nanmax over active cells: {np.nanmax(hmax[0][active]):.4f}', flush=True)
print(f'hmax band2 nanmax over active cells: {np.nanmax(hmax[1][active]):.4f}', flush=True)
ds.close()

inp = read_inp(INP_PATH)
x0, y0 = float(inp['x0']), float(inp['y0'])
dx, dy = float(inp['dx']), float(inp['dy'])
nmax, mmax = int(inp['nmax']), int(inp['mmax'])
print(f'grid: x0={x0} y0={y0} dx={dx} dy={dy} nmax={nmax} mmax={mmax}', flush=True)

hmax_b1 = np.nan_to_num(hmax[0], nan=0.0)
hmax_b2 = np.nan_to_num(hmax[1], nan=0.0)
hmax_combined = np.maximum(hmax_b1, hmax_b2)
running_max = np.nan_to_num(np.load(RUNNING_MAX_PATH), nan=0.0)

print(f'running_max nanmax: {running_max[active].max():.4f}', flush=True)
print(f'hmax_combined nanmax: {hmax_combined[active].max():.4f}', flush=True)

# ---------------------------------------------------------------------------
# 2. Load buildings, reproject, find each one's grid cell (vectorized)
# ---------------------------------------------------------------------------
t_gdf = gpd.read_file(BUILDINGS_PATH).set_crs('EPSG:4326', allow_override=True)
gdf_utm = t_gdf.to_crs('EPSG:32643')
centroids = gdf_utm.geometry.centroid
ux = centroids.x.values
uy = centroids.y.values
col = np.clip(((ux - x0) / dx).astype(int), 0, mmax - 1)
row = np.clip(((uy - y0) / dy).astype(int), 0, nmax - 1)

centroid_running_max = running_max[row, col]

# neighborhood max via a maximum filter - fully vectorized, no python loop
neigh_max = maximum_filter(running_max, size=GAP_NEIGHBORHOOD_CELLS)
neighborhood_running_max = neigh_max[row, col]

gap = neighborhood_running_max - centroid_running_max
is_currently_dry = centroid_running_max < DRY_THRESHOLD
is_clearly_wet_nearby = neighborhood_running_max > 1.0

problem_mask = is_currently_dry & is_clearly_wet_nearby
print(f'\nbuildings classified dry at own cell but with >1.0m water within {GAP_NEIGHBORHOOD_CELLS*30}m: '
      f'{problem_mask.sum()} / {len(t_gdf)}', flush=True)

problem_df = pd.DataFrame({
    'id': t_gdf['id'].values,
    'height': t_gdf['height'].values,
    'row': row, 'col': col,
    'centroid_running_max': centroid_running_max,
    'neighborhood_running_max': neighborhood_running_max,
    'gap': gap,
})[problem_mask].sort_values('gap', ascending=False).head(N_PROBLEM_CASES)

print(f'\ntop {N_PROBLEM_CASES} "gap" cases (dry building right next to deep water):', flush=True)
print(problem_df.to_string(index=False), flush=True)

# ---------------------------------------------------------------------------
# 3. Side-by-side comparison table for each problem case
# ---------------------------------------------------------------------------
overlap = pd.read_parquet(OVERLAP_PATH)


def area_weighted(building_id, grid):
    rows_cols = overlap[overlap['building_id'] == building_id]
    if rows_cols.empty:
        return np.nan
    vals = grid[rows_cols['row'].values, rows_cols['col'].values]
    w = rows_cols['overlap_area_m2'].values
    return float(np.average(vals, weights=w))


def load_stored(impact_dir, building_id, depth_key):
    # brute-force scan is fine for a handful of lookups
    import glob
    for f in glob.glob(f'{impact_dir}/*.geojson'):
        d = json.load(open(f))
        for feat in d['features']:
            if feat['properties'].get('id') == building_id:
                return feat['properties'].get(depth_key)
    return None


print('\n=== side-by-side comparison for each problem case ===', flush=True)
rows_for_plot = []
for _, r in problem_df.iterrows():
    bid = r['id']
    b1_aw = area_weighted(bid, hmax_b1)
    b2_aw = area_weighted(bid, hmax_b2)
    combined_aw = area_weighted(bid, hmax_combined)
    running_aw = area_weighted(bid, running_max)
    vuln_stored = load_stored(VULN_IMPACT_DIR, bid, 'worstCaseFloodDepth')
    v5_stored = load_stored(V5_IMPACT_DIR, bid, 'floodDepth')
    print(f'\nbuilding {bid} (height={r["height"]:.2f}m, cell row={r["row"]} col={r["col"]}):', flush=True)
    print(f'  hmax band1   area-weighted: {b1_aw:.3f} m', flush=True)
    print(f'  hmax band2   area-weighted: {b2_aw:.3f} m', flush=True)
    print(f'  hmax combined area-weighted: {combined_aw:.3f} m', flush=True)
    print(f'  true running-max area-weighted: {running_aw:.3f} m', flush=True)
    print(f'  Vulnerability page STORED worstCaseFloodDepth: {vuln_stored}', flush=True)
    print(f'  V5 page STORED floodDepth (domain-peak snapshot): {v5_stored}', flush=True)
    rows_for_plot.append((bid, r['row'], r['col']))

# ---------------------------------------------------------------------------
# 4. Overview plot: running-max heatmap + all sampled buildings
# ---------------------------------------------------------------------------
fig, ax = plt.subplots(figsize=(10, 10))
im = ax.imshow(np.where(active, running_max, np.nan), origin='lower', cmap='Blues', vmax=3)
plt.colorbar(im, ax=ax, label='running-max depth (m)')
for bid, rr, cc in rows_for_plot:
    ax.plot(cc, rr, 'r*', markersize=14, markeredgecolor='black')
ax.set_title(f'{SCENARIO}: running-max depth + problem-case buildings (red stars)')
ax.set_xlabel('col')
ax.set_ylabel('row')
overview_path = f'{OUT_DIR}/overview_{SCENARIO}.png'
fig.savefig(overview_path, dpi=140, bbox_inches='tight')
plt.close(fig)
print(f'\nwrote {overview_path}', flush=True)

# ---------------------------------------------------------------------------
# 5. Zoom plot: worst single case, annotated cell values + building outline
# ---------------------------------------------------------------------------
if len(problem_df):
    worst = problem_df.iloc[0]
    bid, rr, cc = worst['id'], int(worst['row']), int(worst['col'])
    pad = 6
    r0, r1 = max(0, rr - pad), min(nmax, rr + pad + 1)
    c0, c1 = max(0, cc - pad), min(mmax, cc + pad + 1)
    sub = running_max[r0:r1, c0:c1]

    fig, ax = plt.subplots(figsize=(11, 11))
    im = ax.imshow(sub, origin='lower', cmap='Blues', vmax=3,
                    extent=[c0, c1, r0, r1])
    plt.colorbar(im, ax=ax, label='running-max depth (m)')
    for i in range(r0, r1):
        for j in range(c0, c1):
            ax.text(j + 0.5, i + 0.5, f'{running_max[i, j]:.2f}', ha='center', va='center',
                    fontsize=7, color='black' if running_max[i, j] < 1.5 else 'white')

    # draw this building's actual footprint polygon(s), in row/col space
    geom_utm = gdf_utm[t_gdf['id'].values == bid].geometry.iloc[0]
    parts = geom_utm.geoms if geom_utm.geom_type == 'MultiPolygon' else [geom_utm]
    for part in parts:
        poly_rc = [((x - x0) / dx, (y - y0) / dy) for x, y in part.exterior.coords]
        ax.add_patch(MplPolygon(poly_rc, closed=True, edgecolor='red', facecolor='none', linewidth=2.5))

    ax.set_xlim(c0, c1)
    ax.set_ylim(r0, r1)
    ax.set_title(f'{SCENARIO}: zoom on worst gap case {bid}\n'
                 f'red outline = actual building footprint, numbers = raw cell depth (m)')
    ax.set_xlabel('col')
    ax.set_ylabel('row')
    zoom_path = f'{OUT_DIR}/zoom_{SCENARIO}_{bid.replace("+", "_")}.png'
    fig.savefig(zoom_path, dpi=140, bbox_inches='tight')
    plt.close(fig)
    print(f'wrote {zoom_path}', flush=True)

print('\nDONE', flush=True)
