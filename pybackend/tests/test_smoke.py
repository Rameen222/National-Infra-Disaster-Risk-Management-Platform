"""Smoke tests for the Flask backend.

Covers one route (via the Flask test client) and a few pure spatial helpers
(`_count_dbf_records`, which reads a shapefile attribute count straight from
the dBASE header; `_assign_building_id` / `_attach_centroids`, which power
the encroached-buildings attribute table). Importing `app` runs only
module-level setup — the server itself is guarded behind
`if __name__ == "__main__"`, so no port is opened.
"""
import struct

import geopandas as gpd
import pandas as pd
from shapely.geometry import Polygon

import app as nirrp


def test_health_route_reports_ok():
    client = nirrp.app.test_client()
    res = client.get("/pyapi/health")
    assert res.status_code == 200
    body = res.get_json()
    assert body["status"] == "ok"
    assert body["service"] == "NIRRP Python Backend"


def test_count_dbf_records_reads_header_count(tmp_path):
    # A dBASE file stores its record count as a little-endian uint32 at byte 4.
    dbf = tmp_path / "buildings.dbf"
    header = bytearray(32)
    header[0] = 0x03  # dBASE III version byte
    struct.pack_into("<I", header, 4, 1234)  # 1234 records
    dbf.write_bytes(bytes(header))

    assert nirrp._count_dbf_records(str(dbf)) == 1234


def test_count_dbf_records_returns_zero_on_bad_path():
    # The helper swallows IO errors and returns 0 rather than raising.
    assert nirrp._count_dbf_records("does/not/exist.dbf") == 0


def _square(lon, lat, size=0.001):
    return Polygon([
        (lon, lat), (lon + size, lat), (lon + size, lat + size), (lon, lat + size),
    ])


def test_assign_building_id_prefers_existing_unique_id_column():
    gdf = gpd.GeoDataFrame(
        {"id": ["AAA111", "BBB222"], "geometry": [_square(73.0, 34.0), _square(74.0, 35.0)]},
        crs="EPSG:4326",
    )
    out = nirrp._assign_building_id(gdf, "Test_District")
    assert out["bldg_id"].tolist() == ["AAA111", "BBB222"]


def test_assign_building_id_falls_back_when_no_id_column():
    gdf = gpd.GeoDataFrame(
        {"height": [1.0, 2.0], "geometry": [_square(73.0, 34.0), _square(74.0, 35.0)]},
        crs="EPSG:4326",
    )
    out = nirrp._assign_building_id(gdf, "Test_District")
    assert out["bldg_id"].tolist() == ["Test_District-0", "Test_District-1"]


def test_assign_building_id_falls_back_when_id_column_has_duplicates():
    # A non-unique 'id' column (or nulls) can't be trusted as a stable key —
    # the synthetic district-scoped id keeps every row unique instead.
    gdf = gpd.GeoDataFrame(
        {"id": ["DUPE", "DUPE"], "geometry": [_square(73.0, 34.0), _square(74.0, 35.0)]},
        crs="EPSG:4326",
    )
    out = nirrp._assign_building_id(gdf, "Test_District")
    assert out["bldg_id"].tolist() == ["Test_District-0", "Test_District-1"]
    assert out["bldg_id"].is_unique


def test_attach_centroids_returns_point_within_polygon_bounds():
    poly = _square(73.0, 34.0, size=0.002)  # bounds: lon [73.0, 73.002], lat [34.0, 34.002]
    gdf = gpd.GeoDataFrame({"geometry": [poly]}, crs="EPSG:4326")
    out = nirrp._attach_centroids(gdf)
    assert "centroid_lat" in out.columns and "centroid_lon" in out.columns
    lat, lon = out.iloc[0]["centroid_lat"], out.iloc[0]["centroid_lon"]
    # True centroid of this square is (73.001, 34.001); allow a small
    # tolerance for the UTM round-trip used to compute it.
    assert abs(lat - 34.001) < 1e-4
    assert abs(lon - 73.001) < 1e-4
