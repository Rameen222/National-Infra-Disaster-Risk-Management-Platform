"""
Infrastructure from the GCOP GeoServer: schools, health facilities, dams,
NHA highways and OSM roads (layer names in .env, INFRA_LAYER_*).

Schools / health facilities / dams are never stored: GeoServer counts them
live (a WFS hits query) for Pakistan, a province, a district, a tehsil or a
SIMEX / GCOP exposure footprint. District outlines are read once from
client/public/pakistan_districts.geojson and province outlines from GeoServer
(INFRA_LAYER_PROVINCES) into memory, simplified, at backend startup; tehsil
and footprint outlines come with the request.

Road km is the only stored result — data/infra_counts.json, for Pakistan,
every province, district and tehsil (not per scenario). It's computed once —
`python infra_counts.py`, or POST /pyapi/infra/rebuild — by pulling the road
layers from GeoServer into memory; nothing else is written. Rebuild it only
when the GeoServer roads change.

Road km = drivable OSM roads + the NHA highways that aren't already in OSM.
GeoServer's osm_roads_ layer has no trunk / tertiary / unclassified / service
/ track roads, so most national highways are only in Roads_NHA_QC; NHA
stretches that run along an OSM motorway / primary / secondary road (within
NHA_OVERLAP_M) are left out so they aren't counted twice.

The map draws roads / NHA highways as GeoServer images (/pyapi/infra/wms) and
loads point layers as GeoJSON (/pyapi/infra/layer/<name>), both live.

A figure that couldn't be computed (GeoServer down, totals not built yet) is
null ("No data" in the UI), never 0.
"""

import io
import json
import os
import re
import threading
import time
import unicodedata
from datetime import datetime, timezone

import geopandas as gpd
import pandas as pd
import requests
from shapely.ops import unary_union

BACKEND_DIR = os.path.dirname(os.path.abspath(__file__))
PUBLIC_DIR = os.path.join(BACKEND_DIR, "..", "client", "public")
DISTRICTS_GEOJSON = os.path.join(PUBLIC_DIR, "pakistan_districts.geojson")
DATA_DIR = os.path.join(BACKEND_DIR, "data")
SUMMARY_JSON = os.path.join(DATA_DIR, "infra_counts.json")

PAGE_SIZE = 50_000
NHA_OVERLAP_M = 30
LIVE_TTL_S = 3600  # live counts are re-asked from GeoServer after an hour


def _load_root_env():
    """Project-root .env → os.environ (app.py does the same; repeated here so
    `python infra_counts.py` works on its own). Real env vars win."""
    path = os.path.join(BACKEND_DIR, "..", ".env")
    if not os.path.isfile(path):
        return
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


_load_root_env()


def geoserver_url():
    return os.environ.get("INFRA_GEOSERVER_URL", "http://172.18.7.35:8080").rstrip("/") + "/geoserver"


def _wfs_url():
    return geoserver_url() + "/ows"


# Point layers, counted live. Key = map layer name (/pyapi/infra/layer/<key>).
POINT_LAYERS = {
    "health_facilities": {
        "type_name": os.environ.get("INFRA_LAYER_HEALTH_FACILITIES", "gcop:Pakistan_Health_Facilities"),
        "props": ["Name", "Category", "Sub_Cat", "Gov_Pvt", "District", "Province"],
    },
    "schools": {
        "type_name": os.environ.get("INFRA_LAYER_SCHOOLS", "gcop:Schools_QC"),
        "props": ["schoolname", "level", "gender", "enrollment", "district", "province"],
    },
    "dams": {
        "type_name": os.environ.get("INFRA_LAYER_DAMS", "gcop:Dams_QC"),
        "props": ["name_of_da", "height", "storage_ca", "province"],
    },
}
# Line layers: drawn as GeoServer images; roads / NHA km stored per area.
LINE_LAYERS = {
    "roads": os.environ.get("INFRA_LAYER_ROADS", "gcop:osm_roads_"),
    "nha_roads": os.environ.get("INFRA_LAYER_NHA_ROADS", "gcop:Roads_NHA_QC"),
    "rivers": os.environ.get("INFRA_LAYER_RIVERS", "gcop:Pak_Rivers"),  # display only
}
TEHSILS_LAYER = os.environ.get("INFRA_LAYER_TEHSILS", "gcop:tehsil_boundary")
PROVINCES_LAYER = os.environ.get("INFRA_LAYER_PROVINCES", "gcop:provincial_boundary")

# GeoServer province names → the names pakistan_districts.geojson (and so the
# rest of the app) uses.
GEOSERVER_PROVINCE_NAMES = {
    "Islamabad": "Federal Capital",
    "Indian Illegally Occupied Jammu & Kashmir": "Indian_Illegally_Occupied_Jammu_Kashmir",
}

ROAD_KEYS = ["nha_roads_km", "roads_km"]  # the stored figures

# pakistan_districts.geojson province names → app labels
# (config/provinceRegistry.js).
PROVINCE_LABELS = {
    "Khyber Pakhtunkhwa": "KP",
    "Azad Kashmir": "AJK",
}

# Not part of the road network: foot/cycle paths and unbuilt roads.
NON_ROAD = {"footway", "path", "steps", "pedestrian", "cycleway", "bridleway",
            "corridor", "platform", "elevator", "proposed", "construction",
            "abandoned", "disused", "razed"}
# OSM classes an NHA highway can coincide with.
NHA_OVERLAP_CLASSES = {"motorway", "motorway_link", "trunk", "trunk_link",
                       "primary", "primary_link", "secondary", "secondary_link"}

# Lengths in a Lambert conformal conic fitted to Pakistan (scale error well
# under 1% nationwide) — vectorised, unlike per-feature geodesic lengths.
LENGTH_CRS = "+proj=lcc +lat_1=27 +lat_2=35 +lat_0=30 +lon_0=70 +datum=WGS84 +units=m +no_defs"


def norm_name(s):
    """'Dera Ghazi Khan' / 'D.G. Khan ' / 'dera_ghazi_khan' → 'deraghazikhan'."""
    s = unicodedata.normalize("NFKD", str(s or "")).lower()
    return re.sub(r"[^a-z0-9]", "", s)


# ── GeoServer requests ──────────────────────────────────────

def _request(params, timeout=300, attempts=4, method="get"):
    """WFS request with retries — GeoServer's database connection drops out
    intermittently ("Connection to …:5432 refused")."""
    err = None
    for i in range(attempts):
        try:
            if method == "post":
                r = requests.post(_wfs_url(), data=params, timeout=timeout)
            else:
                r = requests.get(_wfs_url(), params=params, timeout=timeout)
            if r.ok and "ExceptionReport" not in r.text[:500]:
                return r
            err = RuntimeError(f"HTTP {r.status_code}: {r.text[:300]}")
        except requests.RequestException as exc:
            err = exc
        if i + 1 < attempts:
            time.sleep(3 * (i + 1))
    raise err


def _hits(type_name, cql=None, method="get", attempts=4):
    params = {"service": "WFS", "version": "2.0.0", "request": "GetFeature",
              "typeNames": type_name, "resultType": "hits"}
    if cql:
        params["CQL_FILTER"] = cql
    r = _request(params, timeout=120, method=method, attempts=attempts)
    m = re.search(r'numberMatched="(\d+)"', r.text)
    if not m:
        raise RuntimeError(f"no hit count in response: {r.text[:200]}")
    return int(m.group(1))


def _download(type_name, props):
    """Whole layer as one EPSG:4326 GeoDataFrame, paged, in memory."""
    total = _hits(type_name)
    pages, start = [], 0
    while start < total:
        r = _request({
            "service": "WFS", "version": "2.0.0", "request": "GetFeature",
            "typeNames": type_name, "outputFormat": "application/json",
            "srsName": "EPSG:4326", "propertyName": ",".join(props + ["geom"]),
            "count": PAGE_SIZE, "startIndex": start,
        })
        gdf = gpd.read_file(io.BytesIO(r.content))
        if gdf.empty:
            break
        pages.append(gdf.set_crs(4326, allow_override=True))
        start += PAGE_SIZE
        print(f"[infra] {type_name}: {min(start, total):,}/{total:,}")
    gdf = gpd.GeoDataFrame(pd.concat(pages, ignore_index=True), crs=4326)
    return gdf[gdf.geometry.notna() & ~gdf.geometry.is_empty].reset_index(drop=True)


# ── Live point counts ───────────────────────────────────────

_live_cache = {}  # key → (time, counts)


def _cached(key, fn):
    hit = _live_cache.get(key)
    if hit and time.time() - hit[0] < LIVE_TTL_S:
        return dict(hit[1])
    out = fn()
    if all(v is not None for v in out.values()):  # don't cache a GeoServer outage
        _live_cache[key] = (time.time(), dict(out))
    return out


def counts_live(geom, cache_key=None):
    """{point layer key: count | None} inside a shapely geometry (EPSG:4326),
    counted by GeoServer. geom=None counts the whole layer (Pakistan).
    None for a layer = GeoServer unreachable."""
    def run():
        cql = None
        if geom is not None:
            # Simplify to ~10 m so a detailed outline fits in one request.
            g = geom.simplify(0.0001, preserve_topology=True)
            cql = f"INTERSECTS(geom, SRID=4326;{g.wkt})"
        out = {}
        for key, spec in POINT_LAYERS.items():
            try:
                out[key] = _hits(spec["type_name"], cql, method="post", attempts=2)
            except Exception as exc:
                print(f"[infra] live count {key} failed: {exc}")
                out[key] = None
        return out
    if cache_key is None and geom is not None:
        cache_key = geom.wkb
    return _cached(cache_key or "national", run)


# Province outlines from GeoServer, held in memory (fetched on first use, so
# the map keeps them while GeoServer's DB is down).
_provinces_json = None
_provinces_lock = threading.Lock()


def provinces_geojson():
    """GeoServer's province outlines as GeoJSON bytes, each feature's
    `name` / `province` set to the app's province name."""
    global _provinces_json
    with _provinces_lock:
        if _provinces_json is None:
            r = _request({
                "service": "WFS", "version": "2.0.0", "request": "GetFeature",
                "typeNames": PROVINCES_LAYER, "outputFormat": "application/json",
                "srsName": "EPSG:4326", "propertyName": "name,geom",
            }, timeout=120)
            fc = r.json()
            for f in fc["features"]:
                raw = (f.get("properties") or {}).get("name")
                name = GEOSERVER_PROVINCE_NAMES.get(raw, raw)
                f["properties"] = {"name": name, "province": name}
            _provinces_json = json.dumps(fc, separators=(",", ":")).encode()
        return _provinces_json


# District outlines (local file) and province outlines (GeoServer),
# simplified, held in memory only.
_bounds = None
_bounds_lock = threading.Lock()


def boundaries():
    """{'districts': {name: geom}, 'provinces': {label: geom}} — loaded once.
    Districts from pakistan_districts.geojson, provinces from GeoServer."""
    global _bounds
    with _bounds_lock:
        if _bounds is None:
            t0 = time.time()
            d = gpd.read_file(DISTRICTS_GEOJSON, columns=["name", "province"])
            if d.crs is not None and d.crs.to_epsg() != 4326:
                d = d.to_crs(4326)
            d["geometry"] = d.geometry.buffer(0).simplify(0.001, preserve_topology=True)
            p = gpd.read_file(io.BytesIO(provinces_geojson()))
            _bounds = {
                "districts": dict(zip(d["name"], d.geometry)),
                "provinces": {PROVINCE_LABELS.get(n, n): g.buffer(0).simplify(0.002)
                              for n, g in zip(p["name"], p.geometry)},
            }
            print(f"[infra] boundaries loaded in {time.time() - t0:.0f}s")
        return _bounds


def warm():
    """Startup: load the outlines in the background so the first count is quick."""
    threading.Thread(target=lambda: _safe(boundaries), daemon=True, name="infra-bounds").start()


def area_counts(level, name=None):
    """Live points + stored road km for 'national' / 'province' / 'district'."""
    s = summary() or {}
    if level == "national":
        out = counts_live(None)
        roads = s.get("national")
    elif level == "province":
        geom = boundaries()["provinces"].get(name)
        out = counts_live(geom, f"province|{name}") if geom is not None else {k: None for k in POINT_LAYERS}
        roads = s.get("provinces", {}).get(name)
    elif level == "district":
        geom = boundaries()["districts"].get(name)
        out = counts_live(geom, f"district|{name}") if geom is not None else {k: None for k in POINT_LAYERS}
        roads = s.get("districts", {}).get(name)
    else:
        raise ValueError(level)
    for k in ROAD_KEYS:
        out[k] = (roads or {}).get(k)
    return out


# ── Stored road km ──────────────────────────────────────────

_summary = None
_summary_lock = threading.Lock()


def summary():
    """The stored road km (dict) or None if it hasn't been built yet."""
    global _summary
    with _summary_lock:
        if _summary is None and os.path.isfile(SUMMARY_JSON):
            with open(SUMMARY_JSON, encoding="utf-8") as fh:
                _summary = json.load(fh)
        return _summary


def stored_tehsil(district, tehsil):
    """Stored road km for a tehsil, matched by name (GeoServer's tehsil
    names can be spelt differently from the app's)."""
    s = summary()
    if not s or not tehsil:
        return None
    t = norm_name(tehsil)
    index = s.get("tehsil_index", {})
    hit = index.get(f"{norm_name(district)}|{t}")
    if hit is None:  # district spelt differently — fall back to a unique tehsil name
        matches = [v for k, v in index.items() if k.split("|", 1)[1] == t]
        hit = matches[0] if len(matches) == 1 else None
    return s["tehsils"].get(hit) if hit else None


def _km_inside(lines, geom):
    """km of `lines` (EPSG:4326, with sindex) inside geom."""
    if lines.empty:
        return 0.0
    idx = lines.sindex.query(geom, predicate="intersects")
    inside = set(lines.sindex.query(geom, predicate="contains").tolist())
    crossing = [i for i in idx if i not in inside]
    metres = lines.geometry.iloc[list(inside)].to_crs(LENGTH_CRS).length.sum()
    if crossing:
        metres += lines.geometry.iloc[crossing].intersection(geom).to_crs(LENGTH_CRS).length.sum()
    return float(metres) / 1000


def _nha_not_in_osm(nha, osm):
    """NHA highways minus stretches that run along an OSM road of a class a
    highway could be tagged as (so they aren't counted twice). Each NHA road
    is only compared with the OSM roads near it."""
    nha_m = nha.to_crs(LENGTH_CRS)
    major = osm[osm["highway"].isin(NHA_OVERLAP_CLASSES)].to_crs(LENGTH_CRS).reset_index(drop=True)
    rest = []
    for geom in nha_m.geometry:
        near = major.sindex.query(geom.buffer(NHA_OVERLAP_M), predicate="intersects")
        if len(near):
            geom = geom.difference(unary_union(list(major.geometry.iloc[near].buffer(NHA_OVERLAP_M))))
        if not geom.is_empty:
            rest.append(geom)
    rest = gpd.GeoDataFrame(geometry=rest, crs=LENGTH_CRS)
    print(f"[infra] NHA {nha_m.length.sum() / 1000:,.0f} km, of which "
          f"{rest.length.sum() / 1000:,.0f} km not already in OSM")
    return rest.to_crs(4326).reset_index(drop=True)


def _road_km(geom, osm, nha, nha_extra):
    if not geom.is_valid:
        geom = geom.buffer(0)
    return {"nha_roads_km": round(_km_inside(nha, geom), 1),
            "roads_km": round(_km_inside(osm, geom) + _km_inside(nha_extra, geom), 1)}


def _sum(rows):
    return {k: round(sum(r[k] for r in rows), 1) for k in ROAD_KEYS}


_rebuild_lock = threading.Lock()
_rebuilding = False
_last_error = None


def status():
    s = summary()
    return {"rebuilding": _rebuilding, "last_error": _last_error,
            "source": geoserver_url(), "roads_built_at": s.get("generated_at") if s else None,
            "layers": {**{k: v["type_name"] for k, v in POINT_LAYERS.items()}, **LINE_LAYERS}}


def rebuild():
    """Pull the road layers and tehsil outlines from GeoServer into memory,
    compute road km per area and write SUMMARY_JSON. Returns False if a
    rebuild is already running."""
    global _rebuilding, _last_error, _summary
    if not _rebuild_lock.acquire(blocking=False):
        return False
    _rebuilding, _last_error = True, None
    t0 = time.time()
    try:
        nha = _download(LINE_LAYERS["nha_roads"], [])
        nha.sindex
        osm = _download(LINE_LAYERS["roads"], ["highway"])
        osm = osm[~osm["highway"].isin(NON_ROAD)].reset_index(drop=True)  # drivable only
        osm.sindex
        nha_extra = _nha_not_in_osm(nha, osm)
        nha_extra.sindex

        districts = gpd.read_file(DISTRICTS_GEOJSON, columns=["name", "province"])
        if districts.crs is not None and districts.crs.to_epsg() != 4326:
            districts = districts.to_crs(4326)
        tehsils = _download(TEHSILS_LAYER, ["name", "district", "province"])

        by_district, by_province = {}, {}
        for i, row in districts.iterrows():
            if row.geometry is None or row.geometry.is_empty:
                continue
            c = _road_km(row.geometry, osm, nha, nha_extra)
            by_district[row["name"]] = c
            by_province.setdefault(PROVINCE_LABELS.get(row["province"], row["province"]), []).append(c)
            print(f"  district [{i + 1}/{len(districts)}] {row['name']}: {c}")

        by_tehsil, tehsil_index = {}, {}
        for i, row in tehsils.iterrows():
            key = f"{row['district']}|{row['name']}"
            by_tehsil[key] = _road_km(row.geometry, osm, nha, nha_extra)
            tehsil_index[f"{norm_name(row['district'])}|{norm_name(row['name'])}"] = key
            if i % 50 == 0:
                print(f"  tehsil [{i + 1}/{len(tehsils)}] {key}: {by_tehsil[key]}")

        payload = {
            "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "source": geoserver_url(),
            "layers": {**LINE_LAYERS, "tehsils": TEHSILS_LAYER},
            "notes": ("Road km only (schools / health facilities / dams are counted live). "
                      "roads_km = drivable OSM roads + NHA highways not already in OSM. "
                      "National / province = sum of districts."),
            "national": _sum(list(by_district.values())),
            "provinces": {p: _sum(rows) for p, rows in by_province.items()},
            "districts": by_district,
            "tehsils": by_tehsil,
            "tehsil_index": tehsil_index,
        }
        os.makedirs(DATA_DIR, exist_ok=True)
        tmp = SUMMARY_JSON + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, separators=(",", ":"))
        os.replace(tmp, SUMMARY_JSON)
        with _summary_lock:
            _summary = payload
        print(f"[infra] wrote {SUMMARY_JSON} in {time.time() - t0:.0f}s, national: {payload['national']}")
        return True
    except Exception as exc:
        _last_error = f"{type(exc).__name__}: {str(exc)[:300]}"
        print(f"[infra] rebuild FAILED (previous stored result kept): {_last_error}")
        raise
    finally:
        _rebuilding = False
        _rebuild_lock.release()


def build_if_missing():
    """Startup: compute the stored road km once if it doesn't exist yet."""
    if summary() is None:
        threading.Thread(target=lambda: _safe(rebuild), daemon=True, name="infra-rebuild").start()


def _safe(fn):
    try:
        fn()
    except Exception:
        pass


if __name__ == "__main__":
    rebuild()
