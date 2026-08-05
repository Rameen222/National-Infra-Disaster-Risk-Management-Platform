"""Smoke tests for the Flask backend.

Covers one route (via the Flask test client) and one pure spatial helper
(`_count_dbf_records`, which reads a shapefile attribute count straight from
the dBASE header). Importing `app` runs only module-level setup — the server
itself is guarded behind `if __name__ == "__main__"`, so no port is opened.
"""
import struct

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
