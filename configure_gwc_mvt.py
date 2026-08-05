"""
configure_gwc_mvt.py
--------------------
Reads geoserver_upload_tracker.csv and enables Mapbox Vector Tile (MVT)
caching on every uploaded layer via the GeoServer GeoWebCache REST API.

Run once from the project root:
    python configure_gwc_mvt.py

Reads GEOSERVER_URL, GEOSERVER_USER, GEOSERVER_PASS from the project .env
(falls back to sensible defaults if not set).
"""

import csv
import os
import sys
import xml.etree.ElementTree as ET
import requests
from requests.auth import HTTPBasicAuth

# ── Config from .env ────────────────────────────────────────────────────────
def load_env(path=".env"):
    env = {}
    if not os.path.isfile(path):
        return env
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, _, v = line.partition("=")
            env[k.strip()] = v.strip().strip('"').strip("'")
    return env

env = load_env()
_gs_base       = env.get("GEOSERVER_URL", "http://172.18.1.151:8080").rstrip("/")
# .env stores the bare host:port for the Vite proxy; GeoServer itself lives at /geoserver
GEOSERVER_URL  = _gs_base if _gs_base.endswith("/geoserver") else _gs_base + "/geoserver"
GEOSERVER_USER = env.get("GEOSERVER_USER", "admin")
GEOSERVER_PASS = env.get("GEOSERVER_PASS", "geoserver")
TRACKER_CSV    = os.path.join("client", "public", "geoserver_upload_tracker.csv")

AUTH = HTTPBasicAuth(GEOSERVER_USER, GEOSERVER_PASS)
GWC_BASE = f"{GEOSERVER_URL}/gwc/rest"

MVT_MIME   = "application/vnd.mapbox-vector-tile"
GRIDSETS   = ["EPSG:900913", "EPSG:4326"]

# ── Helpers ──────────────────────────────────────────────────────────────────
def build_new_layer_xml(qualified_name: str) -> str:
    """Build a full GWC tile layer XML for a layer that doesn't exist in GWC yet."""
    return f"""<GeoServerLayer>
  <enabled>true</enabled>
  <name>{qualified_name}</name>
  <mimeFormats>
    <string>image/png</string>
    <string>image/jpeg</string>
    <string>application/vnd.mapbox-vector-tile</string>
  </mimeFormats>
  <gridSubsets>
    <gridSubset><gridSetName>EPSG:900913</gridSetName></gridSubset>
    <gridSubset><gridSetName>EPSG:4326</gridSetName></gridSubset>
  </gridSubsets>
  <metaWidthHeight><int>4</int><int>4</int></metaWidthHeight>
  <expireCache>0</expireCache>
  <expireClients>0</expireClients>
  <gutter>0</gutter>
</GeoServerLayer>"""


def get_layer_config(qualified_name: str):
    url = f"{GWC_BASE}/layers/{qualified_name}.xml"
    r = requests.get(url, auth=AUTH, timeout=15)
    if r.status_code == 404:
        return None
    r.raise_for_status()
    return ET.fromstring(r.text)


def put_layer_config(qualified_name: str, body: str):
    url = f"{GWC_BASE}/layers/{qualified_name}.xml"
    r = requests.put(url, data=body, auth=AUTH,
                     headers={"Content-Type": "application/xml"}, timeout=15)
    r.raise_for_status()


def ensure_gridset(root: ET.Element, gridset_name: str):
    subsets = root.find("gridSubsets")
    if subsets is None:
        subsets = ET.SubElement(root, "gridSubsets")
    for gs in subsets.findall("gridSubset"):
        name_el = gs.find("gridSetName")
        if name_el is not None and name_el.text == gridset_name:
            return
    gs = ET.SubElement(subsets, "gridSubset")
    ET.SubElement(gs, "gridSetName").text = gridset_name


def ensure_mime(root: ET.Element, mime: str):
    formats = root.find("mimeFormats")
    if formats is None:
        formats = ET.SubElement(root, "mimeFormats")
    for m in formats.findall("string"):
        if m.text == mime:
            return
    ET.SubElement(formats, "string").text = mime


# ── Main ─────────────────────────────────────────────────────────────────────
def main():
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--only", help="Configure only this layer name (e.g. Nowshera_buildings)")
    args = parser.parse_args()

    if not os.path.isfile(TRACKER_CSV):
        print(f"ERROR: tracker CSV not found at {TRACKER_CSV}", file=sys.stderr)
        sys.exit(1)

    with open(TRACKER_CSV, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        rows = [r for r in reader if r.get("status", "").lower() == "uploaded"]

    if args.only:
        rows = [r for r in rows if args.only.lower() in r.get("qualified_name", "").lower()]
        if not rows:
            print(f"No layer matching '{args.only}' found in tracker.")
            sys.exit(1)

    print(f"Configuring {len(rows)} layer(s).\n")

    ok = failed = 0
    for row in rows:
        qname = row.get("qualified_name", "").strip()
        if not qname:
            continue

        try:
            existing = get_layer_config(qname)
            if existing is None:
                # Layer not in GWC yet — create it from scratch
                body = build_new_layer_xml(qname)
                put_layer_config(qname, body)
                print(f"  CREATED  {qname}")
            else:
                # Layer already in GWC — just add the gridsets/MIME if missing
                for gs in GRIDSETS:
                    ensure_gridset(existing, gs)
                ensure_mime(existing, MVT_MIME)
                body = ET.tostring(existing, encoding="unicode")
                put_layer_config(qname, body)
                print(f"  UPDATED  {qname}")
            ok += 1

        except requests.HTTPError as e:
            print(f"  FAIL  {qname} — HTTP {e.response.status_code}: {e.response.text[:200]}")
            failed += 1
        except Exception as e:
            print(f"  FAIL  {qname} — {e}")
            failed += 1

    print(f"\nDone. {ok} configured, {failed} failed.")
    if failed:
        sys.exit(1)


if __name__ == "__main__":
    main()
