"""
Reproject every GeoJSON in client/public/floodextent/ to EPSG:4326 (WGS-84
lon/lat), overwriting each file in place.

Most of these files are already in CRS84 (lon/lat), but a couple
(gilgitriver_final, hunza) are stored in EPSG:32643 (UTM 43N, metres) which
Mapbox cannot render directly — those are the ones that actually need
reprojecting. Running this over all files also normalises the CRS member and
emits clean RFC-7946 GeoJSON (no `crs` block, coordinates in lon/lat) so the
frontend and the Python backend can treat every projection file uniformly.

Usage:
    python reproject_floodextent.py

Requires geopandas (already a pybackend dependency).
"""
import os
import sys

# Some files (e.g. gilgitriver_final) contain a single enormous feature that
# exceeds GDAL's default GeoJSON object-size cap. "0" removes the limit. Must
# be set before geopandas/pyogrio import GDAL.
os.environ.setdefault("OGR_GEOJSON_MAX_OBJ_SIZE", "0")

import geopandas as gpd

FLOOD_DIR = os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    "client", "public", "floodextent",
)

TARGET_CRS = "EPSG:4326"


def reproject_file(path):
    name = os.path.basename(path)
    gdf = gpd.read_file(path)
    src_crs = gdf.crs
    # If the source CRS is unknown, assume it is already lon/lat (CRS84).
    if src_crs is None:
        gdf = gdf.set_crs(TARGET_CRS, allow_override=True)
        action = "assumed EPSG:4326 (no CRS)"
    elif src_crs.to_epsg() == 4326:
        action = "already EPSG:4326"
    else:
        gdf = gdf.to_crs(TARGET_CRS)
        action = f"reprojected {src_crs.to_string()} -> EPSG:4326"

    # Write RFC-7946 GeoJSON (lon/lat, no crs member). Using to_json() avoids
    # relying on the GDAL GeoJSON write driver, matching how the backend
    # serialises GeoDataFrames elsewhere.
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(gdf.to_json())

    print(f"  {name:28s} {len(gdf):>7d} features  [{action}]")


def main():
    if not os.path.isdir(FLOOD_DIR):
        sys.exit(f"floodextent directory not found: {FLOOD_DIR}")

    files = sorted(
        f for f in os.listdir(FLOOD_DIR)
        if f.lower().endswith(".geojson")
    )
    if not files:
        sys.exit(f"No .geojson files in {FLOOD_DIR}")

    print(f"Reprojecting {len(files)} file(s) in {FLOOD_DIR} to {TARGET_CRS}\n")
    for f in files:
        try:
            reproject_file(os.path.join(FLOOD_DIR, f))
        except Exception as exc:  # noqa: BLE001 — report and continue
            print(f"  {f:28s} FAILED: {exc}")
    print("\nDone.")


if __name__ == "__main__":
    main()
