"""
NIRRP Portal — unified production server.

In development:   python app.py                     (Flask dev server, localhost only)
In production:    NIRRP_MODE=production python app.py (waitress, all interfaces)

Production mode also serves the built React bundle and proxies /geoserver/ and /api/.
"""
import os
import csv
import json
import struct
import pathlib
import threading
import numpy as np
import pandas as pd
import geopandas as gpd
import requests as req_lib
from urllib.parse import urlparse, urlunparse
from flask import Flask, Response, jsonify, request, send_from_directory
from flask_cors import CORS

app = Flask(__name__)
CORS(app)


def _load_root_env():
    """Read GEOSERVER_URL from the project-root .env (one dir above /pybackend).
    Avoids adding python-dotenv as a dependency.
    """
    env_path = os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "..", ".env"
    )
    if not os.path.isfile(env_path):
        return
    with open(env_path, "r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            k, v = k.strip(), v.strip().strip('"').strip("'")
            # Process env vars take precedence so callers can still override.
            os.environ.setdefault(k, v)


_load_root_env()

TEMP_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "temp")
os.makedirs(TEMP_DIR, exist_ok=True)

# Tracker CSV — maps district keys → GeoServer WFS URLs
TRACKER_CSV = os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    "..", "client", "public", "geoserver_upload_tracker.csv",
)

# Path to the flood susceptibility GeoJSON (shared with the client)
SUS_GEOJSON = os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    "..", "client", "public", "flood", "Flood_Sus.geojson",
)

# Path to the encroachment (river polygons) GeoJSON
ENCROACHMENT_GEOJSON = os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    "..", "client", "public", "encroachment_geom.geojson",
)

# Path to Pakistan district boundaries GeoJSON (for clipping)
DISTRICTS_GEOJSON = os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    "..", "client", "public", "pakistan_districts.geojson",
)

# Susceptibility class mapping: GeoJSON "class" value → label
SUS_CLASS_MAP = {1: "low", 2: "medium", 3: "high"}

# Path to pre-computed HPC scenario outputs
SCENARIO_OUTPUTS_DIR = os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    "..", "client", "public", "scenario_outputs",
)

# ── In-memory download state ────────────────────────────────
# { district_key: { status, progress, total, path, error } }
_downloads = {}
_lock = threading.Lock()

# ── In-memory analysis state & cache ────────────────────────
# { district_key: { status, progress, result, error } }
_analysis = {}
_analysis_lock = threading.Lock()

# ── In-memory encroachment state & cache ────────────────────
# { district_key: { status, progress, result, error } }
_encroachment = {}
_encroachment_lock = threading.Lock()
# High-susceptibility building count — computed independently of the buffer
# stats so the modal can show cached encroachment figures instantly while this
# resolves. { district_key: { status, result, error } }
_highsus = {}
_highsus_lock = threading.Lock()
# Lazy-loaded encroachment GeoDataFrame (parsed once, ~48 MB on disk)
_encroachment_gdf_cache = None
_encroachment_gdf_lock = threading.Lock()

# ── In-memory GCOP-count task state ─────────────────────────
# { task_id: { status, progress, stage, district, result, error, request_key } }
# Frontend POSTs to count-in-geometry, polls /status with the returned task_id.
_gcop_tasks = {}
_gcop_tasks_by_key = {}
_gcop_lock = threading.Lock()


# ── SIMEX pre-computed scenario helpers ─────────────────────
_simex_precomputed = None
_simex_precomputed_lock = threading.Lock()


def _count_dbf_records(dbf_path):
    """Read feature count from dBASE III/IV header (4-byte LE int at byte offset 4)."""
    try:
        with open(dbf_path, "rb") as fh:
            fh.read(4)
            return struct.unpack("<I", fh.read(4))[0]
    except Exception:
        return 0


def _scenario_id_from_folder(folder_name):
    """Extract trailing numeric ID: 'ravi_river_307' → '307'."""
    parts = folder_name.rsplit("_", 1)
    if len(parts) == 2 and parts[1].isdigit():
        return parts[1]
    return None


def _scan_precomputed_scenarios():
    result = {}
    if not os.path.isdir(SCENARIO_OUTPUTS_DIR):
        return result
    for folder in os.listdir(SCENARIO_OUTPUTS_DIR):
        folder_path = os.path.join(SCENARIO_OUTPUTS_DIR, folder)
        if not os.path.isdir(folder_path):
            continue
        scenario_id = _scenario_id_from_folder(folder)
        if not scenario_id:
            continue
        districts_dir = os.path.join(folder_path, "districts")
        if not os.path.isdir(districts_dir):
            continue
        districts = {}
        for district in sorted(os.listdir(districts_dir)):
            district_path = os.path.join(districts_dir, district)
            if not os.path.isdir(district_path):
                continue
            dbf = os.path.join(district_path, "buildings_inside_scenario.dbf")
            if os.path.isfile(dbf):
                districts[district] = _count_dbf_records(dbf)
        if districts:
            result[scenario_id] = {
                "folder": folder,
                "districts": districts,
                "total": sum(districts.values()),
            }
    return result


def _get_simex_precomputed():
    global _simex_precomputed
    with _simex_precomputed_lock:
        if _simex_precomputed is None:
            _simex_precomputed = _scan_precomputed_scenarios()
        return _simex_precomputed


def _find_scenario_folder(scenario_id):
    entry = _get_simex_precomputed().get(str(scenario_id))
    return entry["folder"] if entry else None


def _simex_buildings_cache_path(scenario_id, district):
    return os.path.join(TEMP_DIR, f"simex_{scenario_id}_{district}_buildings.geojson")


def _district_key(name):
    """Normalise district name to GeoServer layer key.  e.g. 'Dera Ghazi Khan' → 'Dera_Ghazi_Khan'"""
    return name.strip().replace(" ", "_")


_wfs_index = None
_wfs_index_lock = threading.Lock()


def _rebase_wfs_url(url):
    """Replace the host:port in a CSV-stored WFS URL with the live GEOSERVER_URL.
    This means only .env needs updating when the GeoServer moves to a new IP."""
    geoserver = os.environ.get("GEOSERVER_URL", "").rstrip("/")
    if not geoserver or not url:
        return url
    parsed_csv = urlparse(url)
    parsed_geo = urlparse(geoserver)
    return urlunparse(parsed_csv._replace(scheme=parsed_geo.scheme, netloc=parsed_geo.netloc))


def _load_wfs_index():
    """Build district_key → wfs_url mapping from the tracker CSV."""
    index = {}
    if not os.path.isfile(TRACKER_CSV):
        return index
    with open(TRACKER_CSV, newline="", encoding="utf-8") as fh:
        for row in csv.DictReader(fh):
            shp = (row.get("shapefile_name") or "").strip()
            wfs = (row.get("wfs_url") or "").strip()
            if shp and wfs:
                index[shp.replace("_buildings.shp", "").lower()] = _rebase_wfs_url(wfs)
    return index


def _get_wfs_url(district):
    """Look up the WFS URL for a district, trying name variants so that
    'Gupis-Yasin' / 'Gupis Yasin' / 'Gupis_Yasin' all resolve to the same
    tracker entry. The tracker CSV is keyed by the shapefile stem, which
    uses underscores."""
    global _wfs_index
    with _wfs_index_lock:
        if _wfs_index is None:
            _wfs_index = _load_wfs_index()
    raw = _district_key(district).lower()
    variants = []
    seen = set()
    for v in (raw, raw.replace("-", "_"), raw.replace(" ", "_"),
              raw.replace("-", " "), raw.replace("_", " "),
              raw.replace("-", "").replace("_", "")):
        if v and v not in seen:
            variants.append(v)
            seen.add(v)
    for v in variants:
        if v in _wfs_index:
            return _wfs_index[v]
    # Fallback: build the URL by convention for districts whose building layer
    # exists on GeoServer but was never recorded in the tracker CSV (e.g.
    # Skardu, Shigar). Returns None only if GEOSERVER_URL is unset; a missing
    # layer simply fails later at download time, exactly as before.
    geoserver = os.environ.get("GEOSERVER_URL", "").rstrip("/")
    if geoserver:
        from urllib.parse import quote
        layer = quote(f"infra_portal:{_district_key(district)}_buildings")
        return (f"{geoserver}/geoserver/infra_portal/ows?service=WFS&version=1.0.0"
                f"&request=GetFeature&typeName={layer}"
                f"&outputFormat=application/json&srsName=EPSG:4326")
    return None


def _cached_geojson_path(key):
    return os.path.join(TEMP_DIR, f"{key}_buildings.geojson")


def _analysis_cache_path(key):
    return os.path.join(TEMP_DIR, f"{key}_analysis.json")


def _load_analysis_from_disk(key):
    path = _analysis_cache_path(key)
    if not os.path.isfile(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as fh:
            result = json.load(fh)
        if result.get("stats"):
            return result
    except Exception:
        pass
    return None


_WFS_PAGE_SIZE = 500_000  # fetch in pages to bypass GeoServer's 1 M-feature cap


def _download_worker(district):
    """Fetch district building GeoJSON from GeoServer WFS (paginated) and cache to disk."""
    key = _district_key(district)

    # Reuse existing cached file
    cached = _cached_geojson_path(key)
    if os.path.isfile(cached):
        size = os.path.getsize(cached)
        with _lock:
            _downloads[key] = {"status": "done", "progress": 100, "total": size, "downloaded": size, "path": cached, "error": None}
        return

    wfs_url = _get_wfs_url(district)
    if not wfs_url:
        with _lock:
            _downloads[key] = {"status": "error", "progress": 0, "total": 0, "downloaded": 0, "path": None,
                                "error": f"No WFS URL found for '{district}' in tracker CSV"}
        return

    try:
        with _lock:
            _downloads[key] = {"status": "downloading", "progress": 5, "total": 0, "downloaded": 0, "path": None, "error": None}

        all_features = []
        start_index = 0

        while True:
            page_url = f"{wfs_url}&maxFeatures={_WFS_PAGE_SIZE}&startIndex={start_index}"
            resp = req_lib.get(page_url, timeout=600)
            resp.raise_for_status()
            page = resp.json()
            features = page.get("features", [])
            all_features.extend(features)

            fetched = len(all_features)
            with _lock:
                _downloads[key]["downloaded"] = fetched
                # progress 5→90 while paginating; unknown total so use feature count heuristic
                _downloads[key]["progress"] = min(90, 5 + fetched // 30_000)

            print(f"[download] {district}: page startIndex={start_index}, got {len(features)}, total so far {fetched}")

            if len(features) < _WFS_PAGE_SIZE:
                break  # last page
            start_index += _WFS_PAGE_SIZE

        fc = json.dumps({"type": "FeatureCollection", "features": all_features}).encode("utf-8")
        with open(cached, "wb") as fh:
            fh.write(fc)

        with _lock:
            _downloads[key] = {"status": "done", "progress": 100, "total": len(all_features),
                                "downloaded": len(all_features), "path": cached, "error": None}

    except Exception as exc:
        with _lock:
            _downloads[key] = {"status": "error", "progress": 0, "total": 0, "downloaded": 0, "path": None, "error": str(exc)}


# ── REST endpoints ──────────────────────────────────────────

@app.route("/pyapi/health")
def health():
    return jsonify(status="ok", service="NIRRP Python Backend")


@app.route("/pyapi/buildings/download", methods=["POST"])
def start_download():
    """Kick off a background download for the given district."""
    body = request.get_json(silent=True) or {}
    district = body.get("district", "").strip()
    if not district:
        return jsonify(error="district is required"), 400

    key = _district_key(district)

    with _lock:
        existing = _downloads.get(key)
        if existing and existing["status"] in ("downloading", "done"):
            return jsonify(key=key, status=existing["status"], progress=existing["progress"])

    t = threading.Thread(target=_download_worker, args=(district,), daemon=True)
    t.start()
    return jsonify(key=key, status="downloading", progress=0)


@app.route("/pyapi/buildings/progress")
def progress_sse():
    """SSE stream — since shapefiles are read from disk, download is instant.
    Returns a single done/error event immediately."""
    district = request.args.get("district", "").strip()
    if not district:
        return jsonify(error="district query param required"), 400

    key = _district_key(district)
    with _lock:
        state = _downloads.get(key, {"status": "unknown", "progress": 0, "error": None, "total": 0})

    def generate():
        data = json.dumps({
            "status": state["status"],
            "progress": state.get("progress", 0),
            "total": state.get("total", 0),
            "error": state.get("error"),
        })
        yield f"data: {data}\n\n"

    return Response(generate(), mimetype="text/event-stream", headers={
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
    })


@app.route("/pyapi/buildings/status")
def download_status():
    """Poll endpoint: returns current download status for a district."""
    district = request.args.get("district", "").strip()
    if not district:
        return jsonify(error="district query param required"), 400

    key = _district_key(district)
    with _lock:
        state = _downloads.get(key)

    if not state:
        return jsonify(status="not_started", progress=0, downloaded=0)

    return jsonify(
        status=state["status"],
        progress=state.get("progress", 0),
        total=state.get("total", 0),
        downloaded=state.get("downloaded", 0),
        error=state.get("error"),
    )


@app.route("/pyapi/buildings/cleanup", methods=["POST"])
def cleanup():
    """Delete all downloaded files and reset state."""
    body = request.get_json(silent=True) or {}
    district = body.get("district", "").strip()

    if district:
        # Clean up a specific district
        key = _district_key(district)
        with _lock:
            _downloads.pop(key, None)
        with _analysis_lock:
            _analysis.pop(key, None)
        # Delete all cached files for this district
        for p in (_cached_geojson_path(key), _analysis_cache_path(key)):
            if os.path.isfile(p):
                os.remove(p)
        return jsonify(status="ok", removed=key)
    else:
        # Clean up everything
        with _lock:
            _downloads.clear()
        with _analysis_lock:
            _analysis.clear()
        for f in os.listdir(TEMP_DIR):
            fp = os.path.join(TEMP_DIR, f)
            if os.path.isfile(fp):
                os.remove(fp)
        return jsonify(status="ok", removed="all")


# ── Spatial analysis ────────────────────────────────────────

def _analyze_worker(district):
    """Spatial join between the downloaded building GeoJSON and flood susceptibility zones.
    Deletes the temp building file once results are stored, freeing disk space."""
    key = _district_key(district)

    with _analysis_lock:
        cached = _analysis.get(key)
        if cached and cached["status"] == "done":
            return

    with _analysis_lock:
        _analysis[key] = {"status": "processing", "progress": 10, "result": None, "error": None}

    try:
        # 1. Locate downloaded building GeoJSON
        shp_file = _ensure_buildings_shp(district)

        with _analysis_lock:
            _analysis[key]["progress"] = 40

        # 2. Read buildings
        buildings_gdf = gpd.read_file(shp_file)
        total_buildings = len(buildings_gdf)
        print(f"[analyze] Loaded {total_buildings} buildings, CRS={buildings_gdf.crs}, columns={list(buildings_gdf.columns)}")

        # 3. Compute footprint area in sq ft via a metric CRS
        try:
            metric_crs = buildings_gdf.estimate_utm_crs()
        except Exception:
            metric_crs = "EPSG:32642"
        buildings_metric = buildings_gdf.to_crs(metric_crs)
        buildings_gdf = buildings_gdf.copy()
        buildings_gdf["_area_sqm"] = buildings_metric.geometry.area

        # 4. Detect height column (case-insensitive)
        height_col = None
        for c in buildings_gdf.columns:
            if c.lower() in ("height", "h", "bldg_height", "building_height"):
                height_col = c
                break
        print(f"[analyze] Height column: {height_col}")

        with _analysis_lock:
            _analysis[key]["progress"] = 55

        # 5. Read susceptibility zones
        sus_gdf = gpd.read_file(SUS_GEOJSON)
        if buildings_gdf.crs and sus_gdf.crs and buildings_gdf.crs != sus_gdf.crs:
            sus_gdf = sus_gdf.to_crs(buildings_gdf.crs)

        with _analysis_lock:
            _analysis[key]["progress"] = 65

        # 6. Spatial join: assign each building to a susceptibility zone
        joined = gpd.sjoin(buildings_gdf, sus_gdf, how="left", predicate="within")

        with _analysis_lock:
            _analysis[key]["progress"] = 85

        # 7. Count buildings per zone and accumulate area/height stats
        counts = {"low": 0, "medium": 0, "high": 0, "unclassified": 0}
        stats = {"low": {"area": 0, "height": 0}, "medium": {"area": 0, "height": 0},
                 "high": {"area": 0, "height": 0}, "unclassified": {"area": 0, "height": 0}}

        for _, row in joined.iterrows():
            cls_val = row.get("class")
            is_nan = isinstance(cls_val, float) and np.isnan(cls_val)
            if cls_val is None or is_nan:
                label = "unclassified"
            else:
                label = SUS_CLASS_MAP.get(int(cls_val), "unclassified")
            counts[label] += 1

            area_sqm = row.get("_area_sqm", 0) or 0
            try:
                area_sqft = float(area_sqm) * 10.764
            except (ValueError, TypeError):
                area_sqft = 0

            if height_col:
                h = row.get(height_col)
                try:
                    height = float(h) if h is not None and not (isinstance(h, float) and np.isnan(h)) else 3
                except (ValueError, TypeError):
                    height = 3
            else:
                height = 3

            stats[label]["area"] += area_sqft
            stats[label]["height"] += height

        result_payload = {
            "total_buildings": total_buildings,
            "counts": counts,
            "stats": stats,
        }

        # Persist to disk so all network clients share the same result (survives restarts)
        try:
            with open(_analysis_cache_path(key), "w", encoding="utf-8") as fh:
                json.dump(result_payload, fh)
        except Exception as exc:
            print(f"[analyze] Disk cache write failed: {exc}")

        with _analysis_lock:
            _analysis[key] = {
                "status": "done",
                "progress": 100,
                "result": result_payload,
                "error": None,
            }

        # 8. Delete the temp building file — results are now cached in memory/disk
        cached_path = _cached_geojson_path(key)
        try:
            if os.path.isfile(cached_path):
                os.remove(cached_path)
                with _lock:
                    _downloads.pop(key, None)
                print(f"[analyze] Temp file removed: {cached_path}")
        except Exception as exc:
            print(f"[analyze] Temp cleanup failed: {exc}")

    except Exception as exc:
        with _analysis_lock:
            _analysis[key] = {
                "status": "error",
                "progress": 0,
                "result": None,
                "error": str(exc),
            }


@app.route("/pyapi/buildings/analyze", methods=["POST"])
def start_analysis():
    """Kick off spatial analysis for the given district.
    Returns cached result immediately if available (memory → disk → recompute)."""
    body = request.get_json(silent=True) or {}
    district = body.get("district", "").strip()
    if not district:
        return jsonify(error="district is required"), 400

    key = _district_key(district)

    with _analysis_lock:
        cached = _analysis.get(key)
        # Only reuse memory cache if it has the full stats format
        if cached and cached["status"] == "done" and cached.get("result", {}).get("stats"):
            return jsonify(status="done", progress=100, result=cached["result"], cached=True)
        if cached and cached["status"] == "processing":
            return jsonify(status="processing", progress=cached["progress"])

    # Disk cache — survives backend restarts and is shared across all network clients
    disk_result = _load_analysis_from_disk(key)
    if disk_result:
        with _analysis_lock:
            _analysis[key] = {"status": "done", "progress": 100, "result": disk_result, "error": None}
        return jsonify(status="done", progress=100, result=disk_result, cached=True)

    t = threading.Thread(target=_analyze_worker, args=(district,), daemon=True)
    t.start()
    return jsonify(status="processing", progress=0)


@app.route("/pyapi/buildings/analyze/status")
def analysis_status():
    """Poll endpoint: returns current analysis status for a district."""
    district = request.args.get("district", "").strip()
    if not district:
        return jsonify(error="district query param required"), 400

    key = _district_key(district)
    with _analysis_lock:
        state = _analysis.get(key)

    if not state:
        return jsonify(status="not_started", progress=0)

    resp = {
        "status": state["status"],
        "progress": state.get("progress", 0),
        "error": state.get("error"),
    }
    if state["status"] == "done" and state.get("result"):
        resp["result"] = state["result"]
    return jsonify(resp)


# ── Encroachment analysis ───────────────────────────────────

def _encroachment_cache_path(key):
    return os.path.join(TEMP_DIR, f"{key}_encroachment.json")


def _clipped_encroachment_path(key):
    return os.path.join(TEMP_DIR, f"{key}_encroachment_clipped.geojson")


def _encroached_buildings_path(key):
    return os.path.join(TEMP_DIR, f"{key}_encroached_buildings.geojson")


def _highsus_cache_path(key):
    return os.path.join(TEMP_DIR, f"{key}_highsus.json")


def _count_high_sus(buildings_gdf):
    """Count district buildings intersecting the HIGH (class 3) flood
    susceptibility zone. Returns 0 on any failure/empty input."""
    try:
        if buildings_gdf is None or buildings_gdf.empty:
            return 0
        sus_gdf = gpd.read_file(SUS_GEOJSON)
        if "class" not in sus_gdf.columns:
            return 0
        sus_cls = pd.to_numeric(sus_gdf["class"], errors="coerce")
        high_gdf = sus_gdf[sus_cls == 3]
        if high_gdf.empty:
            return 0
        if buildings_gdf.crs and high_gdf.crs and buildings_gdf.crs != high_gdf.crs:
            high_gdf = high_gdf.to_crs(buildings_gdf.crs)
        joined = gpd.sjoin(buildings_gdf, high_gdf, how="inner", predicate="intersects")
        return int(joined.index.nunique())
    except Exception as exc:
        print(f"[highsus] count failed: {exc}")
        return 0


def _highsus_worker(district):
    """Compute (and cache) the high-susceptibility building count for a district,
    independently of the encroachment buffer pipeline."""
    key = _district_key(district)
    path = _highsus_cache_path(key)

    def _set_progress(p):
        with _highsus_lock:
            if key in _highsus and _highsus[key]["status"] == "processing":
                _highsus[key]["progress"] = p

    # Disk cache hit
    if os.path.isfile(path):
        try:
            with open(path, "r", encoding="utf-8") as fh:
                res = json.load(fh)
            with _highsus_lock:
                _highsus[key] = {"status": "done", "progress": 100, "result": res, "error": None}
            return
        except Exception:
            pass

    with _highsus_lock:
        _highsus[key] = {"status": "processing", "progress": 10, "result": None, "error": None}

    try:
        shp_file = _ensure_buildings_shp(district)   # may download the building file
        _set_progress(55)
        buildings_gdf = gpd.read_file(shp_file)
        total = int(len(buildings_gdf))
        _set_progress(72)
        count = _count_high_sus(buildings_gdf)        # spatial join with class-3 zone
        _set_progress(95)
        pct = round(count / total * 100, 2) if total else 0.0
        res = {"high_sus_count": count, "high_sus_percentage": pct}
        try:
            with open(path, "w", encoding="utf-8") as fh:
                json.dump(res, fh)
        except Exception as exc:
            print(f"[highsus] cache write failed: {exc}")
        with _highsus_lock:
            _highsus[key] = {"status": "done", "progress": 100, "result": res, "error": None}
    except Exception as exc:
        import traceback
        traceback.print_exc()
        with _highsus_lock:
            _highsus[key] = {"status": "error", "progress": 0, "result": None, "error": str(exc)}


def _load_encroachment_gdf():
    """Lazy-load and memo-cache the encroachment polygons GeoDataFrame."""
    global _encroachment_gdf_cache
    with _encroachment_gdf_lock:
        if _encroachment_gdf_cache is None:
            print(f"[encroach] Loading {ENCROACHMENT_GEOJSON}…")
            gdf = gpd.read_file(ENCROACHMENT_GEOJSON)
            print(f"[encroach] Loaded {len(gdf)} encroachment features, CRS={gdf.crs}")
            _encroachment_gdf_cache = gdf
        return _encroachment_gdf_cache


def _cache_is_complete(key):
    """Return (is_valid, cached_result|None).

    A district's cache is considered complete only when:
      • all three temp files exist (summary, encroached buildings, clipped poly)
      • the encroached_buildings GeoJSON has at least as many features as the
        summary's encroachment_count (catches the case where an earlier worker
        run wrote an empty FeatureCollection while the JSON summary recorded a
        non-zero count)
      • the clipped polygon GeoJSON parses as a valid FeatureCollection
    Anything else is treated as a cache miss so the worker re-runs.
    """
    cache_path = _encroachment_cache_path(key)
    encroached_path = _encroached_buildings_path(key)
    clipped_path = _clipped_encroachment_path(key)
    if not (
        os.path.isfile(cache_path)
        and os.path.isfile(encroached_path)
        and os.path.isfile(clipped_path)
    ):
        return False, None
    try:
        with open(cache_path, "r", encoding="utf-8") as fh:
            result = json.load(fh)
        expected = int(result.get("encroachment_count", 0) or 0)
        with open(encroached_path, "r", encoding="utf-8") as fh:
            eb = json.load(fh)
        actual = len(eb.get("features", [])) if isinstance(eb, dict) else 0
        if expected > 0 and actual == 0:
            return False, None  # stale/empty buildings GeoJSON
        with open(clipped_path, "r", encoding="utf-8") as fh:
            cl = json.load(fh)
        if not isinstance(cl, dict) or cl.get("type") != "FeatureCollection":
            return False, None
        return True, result
    except Exception:
        return False, None


def _write_geojson(gdf, path):
    """Write a GeoDataFrame to a GeoJSON file without relying on the GDAL
    GeoJSON write driver (which isn't always built into pyogrio)."""
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(gdf.to_json())


def _load_district_polygon(district_name):
    """Read pakistan_districts.geojson and return the GeoDataFrame for the
    given district (case-insensitive name match)."""
    gdf = gpd.read_file(DISTRICTS_GEOJSON)
    target = district_name.strip().lower()
    if "name" not in gdf.columns:
        raise RuntimeError("pakistan_districts.geojson is missing a 'name' property")
    matched = gdf[gdf["name"].astype(str).str.strip().str.lower() == target]
    if matched.empty:
        raise RuntimeError(f"District '{district_name}' not found in district boundaries")
    return matched


def _ensure_buildings_shp(district):
    """Return path to cached building GeoJSON, downloading synchronously if missing."""
    key = _district_key(district)
    path = _cached_geojson_path(key)
    if not os.path.isfile(path):
        print(f"[ensure] Building file missing for '{district}', downloading…")
        _download_worker(district)
    if not os.path.isfile(path):
        raise RuntimeError(f"Building data for '{district}' could not be downloaded")
    return path


def _encroachment_worker(district):
    """Background thread for the encroachment count.

    Pipeline (each intermediate is persisted, so re-runs skip prior steps):
      1. Clip global encroachment polygons by the district polygon →
         temp/<key>_encroachment_clipped.geojson
      2. Ensure district building shapefile is on disk
      3. Spatial-join buildings with the clipped polygons →
         temp/<key>_encroached_buildings.geojson
      4. Persist count summary → temp/<key>_encroachment.json
    """
    key = _district_key(district)

    # Step 0: full cache hit on disk → return immediately. _cache_is_complete
    # validates that all three temp files exist AND the GeoJSONs aren't stale
    # (e.g. encroached_buildings empty while the summary reports a non-zero
    # count from an earlier buggy run). Anything dodgy → fall through and
    # recompute. Users can also hit Refresh in the UI to force reprocessing.
    valid, cached_result = _cache_is_complete(key)
    if valid:
        with _encroachment_lock:
            _encroachment[key] = {
                "status": "done", "progress": 100, "result": cached_result, "error": None,
            }
        return

    with _encroachment_lock:
        _encroachment[key] = {"status": "processing", "progress": 5, "result": None, "error": None}

    try:
        # ── Step 1: clip encroachment to the district polygon ────────
        clipped_path = _clipped_encroachment_path(key)
        if os.path.isfile(clipped_path):
            print(f"[encroach] Reusing cached clip: {clipped_path}")
            clipped_gdf = gpd.read_file(clipped_path)
            with _encroachment_lock:
                _encroachment[key]["progress"] = 40
        else:
            with _encroachment_lock:
                _encroachment[key]["progress"] = 10
            district_gdf = _load_district_polygon(district)

            with _encroachment_lock:
                _encroachment[key]["progress"] = 20
            encroach_gdf = _load_encroachment_gdf()
            if district_gdf.crs and encroach_gdf.crs and district_gdf.crs != encroach_gdf.crs:
                district_gdf = district_gdf.to_crs(encroach_gdf.crs)

            with _encroachment_lock:
                _encroachment[key]["progress"] = 30
            print(f"[encroach] Clipping {len(encroach_gdf)} polygons by {district}…")
            clipped_gdf = gpd.clip(encroach_gdf, district_gdf)
            print(f"[encroach] Clipped to {len(clipped_gdf)} polygons")

            with _encroachment_lock:
                _encroachment[key]["progress"] = 40
            if not clipped_gdf.empty:
                _write_geojson(clipped_gdf, clipped_path)

        # ── Step 2: ensure building shapefile is local ────────────────
        shp_file = _ensure_buildings_shp(district)
        with _encroachment_lock:
            _encroachment[key]["progress"] = 60

        buildings_gdf = gpd.read_file(shp_file)
        total_buildings = int(len(buildings_gdf))
        with _encroachment_lock:
            _encroachment[key]["progress"] = 70

        # ── Step 3: intersect buildings with the clipped polygons ─────
        if clipped_gdf.empty:
            encroached_gdf = buildings_gdf.iloc[0:0]
            encroachment_count = 0
            area_sqm = 0.0
        else:
            if buildings_gdf.crs and clipped_gdf.crs and buildings_gdf.crs != clipped_gdf.crs:
                clipped_gdf = clipped_gdf.to_crs(buildings_gdf.crs)
            joined = gpd.sjoin(buildings_gdf, clipped_gdf, how="inner", predicate="intersects")
            encroached_idx = joined.index.unique()
            encroached_gdf = buildings_gdf.loc[encroached_idx]
            encroachment_count = int(len(encroached_gdf))

            # Compute footprint area in metric CRS (sum of building polygons)
            try:
                metric_crs = encroached_gdf.estimate_utm_crs()
            except Exception:
                metric_crs = "EPSG:32642"  # UTM 42N (Pakistan)
            try:
                area_sqm = float(encroached_gdf.to_crs(metric_crs).geometry.area.sum())
            except Exception:
                area_sqm = 0.0

        with _encroachment_lock:
            _encroachment[key]["progress"] = 85

        # ── Step 4: persist the matching buildings as GeoJSON ─────────
        encroached_path = _encroached_buildings_path(key)
        if not encroached_gdf.empty:
            # Drop join artifacts before saving
            cols_to_drop = [c for c in encroached_gdf.columns if c.startswith("index_right")]
            if cols_to_drop:
                encroached_gdf = encroached_gdf.drop(columns=cols_to_drop)
            _write_geojson(encroached_gdf, encroached_path)
        else:
            # Write an empty FeatureCollection so the frontend can fetch successfully
            with open(encroached_path, "w", encoding="utf-8") as fh:
                json.dump({"type": "FeatureCollection", "features": []}, fh)

        with _encroachment_lock:
            _encroachment[key]["progress"] = 95

        # ── Step 4a: compute the clipped-zone (river polygon) area ────
        zone_area_sqm = 0.0
        if not clipped_gdf.empty:
            try:
                metric_zone = clipped_gdf.estimate_utm_crs()
            except Exception:
                metric_zone = "EPSG:32642"
            try:
                zone_area_sqm = float(clipped_gdf.to_crs(metric_zone).geometry.area.sum())
            except Exception:
                zone_area_sqm = 0.0

        # ── Step 4b: count buildings within the HIGH susceptibility zone ──
        # Computed from the already-loaded district buildings and cached both in
        # the encroachment summary (cold path) and its own file so the separate
        # /highsus endpoint can serve it. The 200 m-buffer stats are untouched.
        high_sus_count = _count_high_sus(buildings_gdf)
        high_sus_pct = round(high_sus_count / total_buildings * 100, 2) if total_buildings else 0.0
        try:
            with open(_highsus_cache_path(key), "w", encoding="utf-8") as fh:
                json.dump({"high_sus_count": high_sus_count, "high_sus_percentage": high_sus_pct}, fh)
        except Exception as exc:
            print(f"[encroach] high-sus cache write failed: {exc}")

        # ── Step 5: write summary JSON ────────────────────────────────
        pct = round(encroachment_count / total_buildings * 100, 2) if total_buildings else 0.0
        area_sqft = area_sqm * 10.7639  # 1 m² ≈ 10.7639 ft²
        result = {
            "total_buildings": total_buildings,
            "encroachment_count": encroachment_count,
            "percentage": pct,
            "area_sqm": round(area_sqm, 2),
            "area_sqft": round(area_sqft, 2),
            "zone_area_sqm": round(zone_area_sqm, 2),
            "zone_area_sqkm": round(zone_area_sqm / 1_000_000, 4),
            "high_sus_count": high_sus_count,
            "high_sus_percentage": high_sus_pct,
        }
        with open(_encroachment_cache_path(key), "w", encoding="utf-8") as fh:
            json.dump(result, fh)

        with _encroachment_lock:
            _encroachment[key] = {
                "status": "done", "progress": 100, "result": result, "error": None,
            }

    except Exception as exc:
        import traceback
        traceback.print_exc()
        with _encroachment_lock:
            _encroachment[key] = {
                "status": "error", "progress": 0, "result": None, "error": str(exc),
            }


@app.route("/pyapi/buildings/encroachment", methods=["POST"])
def start_encroachment():
    """Kick off encroachment count for the given district.
    Returns cached result immediately if available (memory or disk).

    Pass {"force": true} in the body to invalidate the on-disk cache and
    reprocess the district from scratch (Refresh button in the UI)."""
    body = request.get_json(silent=True) or {}
    district = body.get("district", "").strip()
    force = bool(body.get("force"))
    if not district:
        return jsonify(error="district is required"), 400

    key = _district_key(district)

    # Force refresh: drop the disk + memory cache so the worker recomputes.
    if force:
        for p in (
            _encroachment_cache_path(key),
            _encroached_buildings_path(key),
            _clipped_encroachment_path(key),
        ):
            if os.path.isfile(p):
                try:
                    os.remove(p)
                except OSError:
                    pass
        with _encroachment_lock:
            _encroachment.pop(key, None)

    # Prefer disk cache (survives backend restart). _cache_is_complete checks
    # all three temp files exist AND the GeoJSONs aren't stale (e.g. an empty
    # encroached_buildings file paired with a non-zero summary count). Fall
    # through and recompute if validation fails.
    valid, cached_result = _cache_is_complete(key)
    if valid:
        with _encroachment_lock:
            _encroachment[key] = {
                "status": "done", "progress": 100, "result": cached_result, "error": None,
            }
        return jsonify(status="done", progress=100, result=cached_result, cached=True)

    with _encroachment_lock:
        cached = _encroachment.get(key)
        if cached and cached["status"] == "done":
            return jsonify(status="done", progress=100, result=cached["result"], cached=True)
        if cached and cached["status"] == "processing":
            return jsonify(status="processing", progress=cached["progress"])

    t = threading.Thread(target=_encroachment_worker, args=(district,), daemon=True)
    t.start()
    return jsonify(status="processing", progress=0)


@app.route("/pyapi/buildings/encroachment/status")
def encroachment_status():
    """Poll endpoint for encroachment analysis progress / result."""
    district = request.args.get("district", "").strip()
    if not district:
        return jsonify(error="district query param required"), 400

    key = _district_key(district)
    with _encroachment_lock:
        state = _encroachment.get(key)

    if not state:
        return jsonify(status="not_started", progress=0)

    resp = {
        "status": state["status"],
        "progress": state.get("progress", 0),
        "error": state.get("error"),
    }
    if state["status"] == "done" and state.get("result"):
        resp["result"] = state["result"]
    return jsonify(resp)


@app.route("/pyapi/buildings/highsus", methods=["POST"])
def start_highsus():
    """Kick off (or return cached) high-susceptibility building count for a
    district. Runs independently of the encroachment buffer stats so the modal
    can show those instantly while this computes."""
    body = request.get_json(silent=True) or {}
    district = body.get("district", "").strip()
    if not district:
        return jsonify(error="district is required"), 400

    key = _district_key(district)
    path = _highsus_cache_path(key)

    # Disk cache — survives restarts and is shared across clients
    if os.path.isfile(path):
        try:
            with open(path, "r", encoding="utf-8") as fh:
                res = json.load(fh)
            with _highsus_lock:
                _highsus[key] = {"status": "done", "progress": 100, "result": res, "error": None}
            return jsonify(status="done", progress=100, result=res, cached=True)
        except Exception:
            pass

    with _highsus_lock:
        cur = _highsus.get(key)
        if cur and cur["status"] == "done" and cur.get("result"):
            return jsonify(status="done", progress=100, result=cur["result"], cached=True)
        if cur and cur["status"] == "processing":
            return jsonify(status="processing", progress=cur.get("progress", 0))

    t = threading.Thread(target=_highsus_worker, args=(district,), daemon=True)
    t.start()
    return jsonify(status="processing", progress=0)


@app.route("/pyapi/buildings/highsus/status")
def highsus_status():
    """Poll endpoint for the high-susceptibility building count."""
    district = request.args.get("district", "").strip()
    if not district:
        return jsonify(error="district query param required"), 400

    key = _district_key(district)
    with _highsus_lock:
        state = _highsus.get(key)

    if not state:
        return jsonify(status="not_started", progress=0)
    resp = {
        "status": state["status"],
        "progress": state.get("progress", 0),
        "error": state.get("error"),
    }
    if state["status"] == "done" and state.get("result"):
        resp["result"] = state["result"]
    return jsonify(resp)


@app.route("/pyapi/buildings/encroachment/geojson")
def encroachment_geojson():
    """Serve the per-district GeoJSON of buildings inside the encroachment zone."""
    district = request.args.get("district", "").strip()
    if not district:
        return jsonify(error="district query param required"), 400

    key = _district_key(district)
    path = _encroached_buildings_path(key)
    if not os.path.isfile(path):
        return jsonify(error="not yet computed"), 404

    with open(path, "rb") as fh:
        data = fh.read()
    return Response(data, mimetype="application/geo+json", headers={
        "Cache-Control": "no-cache",
    })


# ── Buildings inside a tehsil ───────────────────────────────
# Clip a district's buildings to a single tehsil polygon (sent by the client
# as GeoJSON geometry), returning the count and the matching buildings. Both
# outputs are cached on disk keyed by province/district/tehsil so repeat
# clicks are instant. Mirrors the encroachment async-job pattern.
# { tehsil_key: { status, progress, result, error } }
_tehsil_jobs = {}
_tehsil_lock = threading.Lock()


def _tehsil_key(province, district, tehsil):
    """Filesystem-safe cache key from province/district/tehsil names."""
    import re

    def clean(s):
        return re.sub(r"[^A-Za-z0-9]+", "_", (s or "").strip()).strip("_")

    parts = [clean(province), clean(district), clean(tehsil)]
    return "tehsil_" + "_".join(p for p in parts if p)


def _tehsil_buildings_path(key):
    return os.path.join(TEMP_DIR, f"{key}_buildings.geojson")


def _tehsil_count_path(key):
    return os.path.join(TEMP_DIR, f"{key}_count.json")


def _tehsil_cache_complete(key):
    """Return (is_valid, cached_result|None). Valid only when both the count
    JSON and the buildings GeoJSON exist and aren't stale (a non-zero count
    paired with an empty FeatureCollection is treated as a miss)."""
    cpath = _tehsil_count_path(key)
    gpath = _tehsil_buildings_path(key)
    if not (os.path.isfile(cpath) and os.path.isfile(gpath)):
        return False, None
    try:
        with open(cpath, "r", encoding="utf-8") as fh:
            result = json.load(fh)
        expected = int(result.get("count", 0) or 0)
        with open(gpath, "r", encoding="utf-8") as fh:
            gj = json.load(fh)
        actual = len(gj.get("features", [])) if isinstance(gj, dict) else 0
        if expected > 0 and actual == 0:
            return False, None
        return True, result
    except Exception:
        return False, None


def _resolve_building_district(tehsil_gdf, fallback):
    """Find the district (from pakistan_districts.geojson) that actually contains
    the tehsil, so we load the right building file. The tehsil layer's DISTRICT
    column can carry legacy combined names (e.g. 'HUNZA NAGAR') that don't match
    the per-district building shapefiles ('Hunza', 'Nagar')."""
    try:
        districts = gpd.read_file(DISTRICTS_GEOJSON)
        if "name" not in districts.columns:
            return fallback
        t = tehsil_gdf
        if districts.crs and str(t.crs) != str(districts.crs):
            t = t.to_crs(districts.crs)
        # representative_point() is guaranteed to lie inside the tehsil polygon.
        pt = t.geometry.iloc[0].representative_point()
        hit = districts[districts.contains(pt)]
        if not hit.empty:
            return str(hit.iloc[0]["name"])
    except Exception as exc:
        print(f"[tehsil] building-district resolve failed: {exc}")
    return fallback


def _tehsil_worker(key, province, district, tehsil, geometry):
    """Background thread: intersect the district's buildings with the tehsil
    polygon, persist the matching buildings GeoJSON + count summary."""
    def _set(p):
        with _tehsil_lock:
            job = _tehsil_jobs.get(key)
            if job and job["status"] == "processing":
                job["progress"] = p

    valid, cached = _tehsil_cache_complete(key)
    if valid:
        with _tehsil_lock:
            _tehsil_jobs[key] = {"status": "done", "progress": 100, "result": cached, "error": None}
        return

    with _tehsil_lock:
        _tehsil_jobs[key] = {"status": "processing", "progress": 5, "result": None, "error": None}

    try:
        from shapely.geometry import shape

        tehsil_gdf = gpd.GeoDataFrame(geometry=[shape(geometry)], crs="EPSG:4326")
        _set(15)

        # The tehsil layer's district name may not match a building shapefile
        # (legacy combined districts), so resolve the containing district first.
        build_district = _resolve_building_district(tehsil_gdf, district)
        if build_district != district:
            print(f"[tehsil] '{district}' → building district '{build_district}'")
        shp_file = _ensure_buildings_shp(build_district)   # downloads on first use
        _set(45)
        buildings_gdf = gpd.read_file(shp_file)
        total = int(len(buildings_gdf))
        _set(65)

        if buildings_gdf.crs and str(tehsil_gdf.crs) != str(buildings_gdf.crs):
            tehsil_gdf = tehsil_gdf.to_crs(buildings_gdf.crs)

        joined = gpd.sjoin(buildings_gdf, tehsil_gdf, how="inner", predicate="intersects")
        inside = buildings_gdf.loc[joined.index.unique()]
        count = int(len(inside))
        _set(85)

        # Persist matching buildings as GeoJSON in WGS84 for the map.
        if inside.crs and str(inside.crs) != "EPSG:4326":
            inside = inside.to_crs("EPSG:4326")
        _write_geojson(inside if not inside.empty else buildings_gdf.iloc[0:0],
                       _tehsil_buildings_path(key))

        result = {
            "count": count,
            "total_buildings": total,
            "province": province,
            "district": district,
            "tehsil": tehsil,
        }
        try:
            with open(_tehsil_count_path(key), "w", encoding="utf-8") as fh:
                json.dump(result, fh)
        except Exception as exc:
            print(f"[tehsil] count cache write failed: {exc}")

        with _tehsil_lock:
            _tehsil_jobs[key] = {"status": "done", "progress": 100, "result": result, "error": None}
    except Exception as exc:
        import traceback
        traceback.print_exc()
        with _tehsil_lock:
            _tehsil_jobs[key] = {"status": "error", "progress": 0, "result": None, "error": str(exc)}


@app.route("/pyapi/buildings/tehsil", methods=["POST"])
def start_tehsil_buildings():
    """Kick off (or return cached) building count for a tehsil polygon.
    Body: { province, district, tehsil, geometry, force }. `geometry` is a
    GeoJSON geometry and is only required on the first (uncached) run."""
    body = request.get_json(silent=True) or {}
    province = (body.get("province") or "").strip()
    district = (body.get("district") or "").strip()
    tehsil = (body.get("tehsil") or "").strip()
    geometry = body.get("geometry")
    force = bool(body.get("force"))
    if not district or not tehsil:
        return jsonify(error="district and tehsil are required"), 400

    key = _tehsil_key(province, district, tehsil)

    if force:
        for p in (_tehsil_count_path(key), _tehsil_buildings_path(key)):
            if os.path.isfile(p):
                try:
                    os.remove(p)
                except OSError:
                    pass
        with _tehsil_lock:
            _tehsil_jobs.pop(key, None)

    valid, cached = _tehsil_cache_complete(key)
    if valid:
        with _tehsil_lock:
            _tehsil_jobs[key] = {"status": "done", "progress": 100, "result": cached, "error": None}
        return jsonify(status="done", progress=100, result=cached, key=key, cached=True)

    with _tehsil_lock:
        cur = _tehsil_jobs.get(key)
        if cur and cur["status"] == "done" and cur.get("result"):
            return jsonify(status="done", progress=100, result=cur["result"], key=key, cached=True)
        if cur and cur["status"] == "processing":
            return jsonify(status="processing", progress=cur["progress"], key=key)

    if not geometry:
        return jsonify(error="geometry is required to compute this tehsil"), 400

    t = threading.Thread(
        target=_tehsil_worker, args=(key, province, district, tehsil, geometry), daemon=True,
    )
    t.start()
    return jsonify(status="processing", progress=0, key=key)


@app.route("/pyapi/buildings/tehsil/status")
def tehsil_buildings_status():
    """Poll endpoint for tehsil building analysis progress / result."""
    key = request.args.get("key", "").strip()
    if not key:
        return jsonify(error="key query param required"), 400
    with _tehsil_lock:
        state = _tehsil_jobs.get(key)
    if not state:
        return jsonify(status="not_started", progress=0)
    resp = {
        "status": state["status"],
        "progress": state.get("progress", 0),
        "error": state.get("error"),
    }
    if state["status"] == "done" and state.get("result"):
        resp["result"] = state["result"]
    return jsonify(resp)


@app.route("/pyapi/buildings/tehsil/geojson")
def tehsil_buildings_geojson():
    """Serve the cached GeoJSON of buildings inside a tehsil."""
    key = request.args.get("key", "").strip()
    if not key:
        return jsonify(error="key query param required"), 400
    path = _tehsil_buildings_path(key)
    if not os.path.isfile(path):
        return jsonify(error="not yet computed"), 404
    with open(path, "rb") as fh:
        data = fh.read()
    return Response(data, mimetype="application/geo+json", headers={
        "Cache-Control": "no-cache",
    })


# ── SIMEX scenario ∩ tehsil buildings ───────────────────────
# Clip a SIMEX scenario's "buildings inside scenario" set to a single tehsil
# polygon, returning the count + the matching buildings. Cached on disk keyed by
# scenario/province/district/tehsil so repeat clicks are instant.
# { key: { status, progress, result, error } }
_simex_tehsil_jobs = {}
_simex_tehsil_lock = threading.Lock()


def _simex_tehsil_key(scenario_id, province, district, tehsil):
    import re

    def clean(s):
        return re.sub(r"[^A-Za-z0-9]+", "_", (s or "").strip()).strip("_")

    parts = [clean(str(scenario_id)), clean(province), clean(district), clean(tehsil)]
    return "simextehsil_" + "_".join(p for p in parts if p)


def _simex_tehsil_buildings_path(key):
    return os.path.join(TEMP_DIR, f"{key}_buildings.geojson")


def _simex_tehsil_count_path(key):
    return os.path.join(TEMP_DIR, f"{key}_count.json")


def _simex_tehsil_cache_complete(key):
    cpath = _simex_tehsil_count_path(key)
    gpath = _simex_tehsil_buildings_path(key)
    if not (os.path.isfile(cpath) and os.path.isfile(gpath)):
        return False, None
    try:
        with open(cpath, "r", encoding="utf-8") as fh:
            result = json.load(fh)
        expected = int(result.get("count", 0) or 0)
        with open(gpath, "r", encoding="utf-8") as fh:
            gj = json.load(fh)
        actual = len(gj.get("features", [])) if isinstance(gj, dict) else 0
        if expected > 0 and actual == 0:
            return False, None
        return True, result
    except Exception:
        return False, None


def _simex_scenario_buildings_shp(scenario_id, district):
    """Path to the scenario's 'buildings inside scenario' shapefile. Prefers the
    per-district file, falling back to the scenario-wide all_buildings file."""
    folder = _find_scenario_folder(scenario_id)
    if not folder:
        return None
    base = os.path.join(SCENARIO_OUTPUTS_DIR, folder)
    per_district = os.path.join(base, "districts", _district_key(district),
                                "buildings_inside_scenario.shp")
    if os.path.isfile(per_district):
        return per_district
    all_shp = os.path.join(base, "all_buildings_inside_scenario.shp")
    if os.path.isfile(all_shp):
        return all_shp
    return None


def _simex_tehsil_worker(key, scenario_id, province, district, tehsil, geometry):
    def _set(p):
        with _simex_tehsil_lock:
            job = _simex_tehsil_jobs.get(key)
            if job and job["status"] == "processing":
                job["progress"] = p

    valid, cached = _simex_tehsil_cache_complete(key)
    if valid:
        with _simex_tehsil_lock:
            _simex_tehsil_jobs[key] = {"status": "done", "progress": 100, "result": cached, "error": None}
        return

    with _simex_tehsil_lock:
        _simex_tehsil_jobs[key] = {"status": "processing", "progress": 5, "result": None, "error": None}

    try:
        from shapely.geometry import shape

        tehsil_gdf = gpd.GeoDataFrame(geometry=[shape(geometry)], crs="EPSG:4326")
        _set(20)

        shp = _simex_scenario_buildings_shp(scenario_id, district)
        if not shp:
            raise RuntimeError(f"Scenario {scenario_id} has no buildings for '{district}'")
        buildings_gdf = gpd.read_file(shp)
        scenario_total = int(len(buildings_gdf))
        _set(55)

        if buildings_gdf.crs and str(tehsil_gdf.crs) != str(buildings_gdf.crs):
            tehsil_gdf = tehsil_gdf.to_crs(buildings_gdf.crs)

        joined = gpd.sjoin(buildings_gdf, tehsil_gdf, how="inner", predicate="intersects")
        inside = buildings_gdf.loc[joined.index.unique()]
        count = int(len(inside))
        _set(85)

        if inside.crs and str(inside.crs) != "EPSG:4326":
            inside = inside.to_crs("EPSG:4326")
        _write_geojson(inside if not inside.empty else buildings_gdf.iloc[0:0],
                       _simex_tehsil_buildings_path(key))

        result = {
            "count": count,
            "scenario_buildings_total": scenario_total,
            "scenario_id": str(scenario_id),
            "province": province,
            "district": district,
            "tehsil": tehsil,
        }
        try:
            with open(_simex_tehsil_count_path(key), "w", encoding="utf-8") as fh:
                json.dump(result, fh)
        except Exception as exc:
            print(f"[simex-tehsil] count cache write failed: {exc}")

        with _simex_tehsil_lock:
            _simex_tehsil_jobs[key] = {"status": "done", "progress": 100, "result": result, "error": None}
    except Exception as exc:
        import traceback
        traceback.print_exc()
        with _simex_tehsil_lock:
            _simex_tehsil_jobs[key] = {"status": "error", "progress": 0, "result": None, "error": str(exc)}


@app.route("/pyapi/simex/tehsil-buildings", methods=["POST"])
def start_simex_tehsil_buildings():
    """Kick off (or return cached) count of scenario buildings inside a tehsil.
    Body: { scenario_id, province, district, tehsil, geometry, force }."""
    body = request.get_json(silent=True) or {}
    scenario_id = str(body.get("scenario_id") or "").strip()
    province = (body.get("province") or "").strip()
    district = (body.get("district") or "").strip()
    tehsil = (body.get("tehsil") or "").strip()
    geometry = body.get("geometry")
    force = bool(body.get("force"))
    if not scenario_id or not district or not tehsil:
        return jsonify(error="scenario_id, district and tehsil are required"), 400

    key = _simex_tehsil_key(scenario_id, province, district, tehsil)

    if force:
        for p in (_simex_tehsil_count_path(key), _simex_tehsil_buildings_path(key)):
            if os.path.isfile(p):
                try:
                    os.remove(p)
                except OSError:
                    pass
        with _simex_tehsil_lock:
            _simex_tehsil_jobs.pop(key, None)

    valid, cached = _simex_tehsil_cache_complete(key)
    if valid:
        with _simex_tehsil_lock:
            _simex_tehsil_jobs[key] = {"status": "done", "progress": 100, "result": cached, "error": None}
        return jsonify(status="done", progress=100, result=cached, key=key, cached=True)

    with _simex_tehsil_lock:
        cur = _simex_tehsil_jobs.get(key)
        if cur and cur["status"] == "done" and cur.get("result"):
            return jsonify(status="done", progress=100, result=cur["result"], key=key, cached=True)
        if cur and cur["status"] == "processing":
            return jsonify(status="processing", progress=cur["progress"], key=key)

    if not geometry:
        return jsonify(error="geometry is required to compute this tehsil"), 400

    t = threading.Thread(
        target=_simex_tehsil_worker,
        args=(key, scenario_id, province, district, tehsil, geometry), daemon=True,
    )
    t.start()
    return jsonify(status="processing", progress=0, key=key)


@app.route("/pyapi/simex/tehsil-buildings/status")
def simex_tehsil_buildings_status():
    key = request.args.get("key", "").strip()
    if not key:
        return jsonify(error="key query param required"), 400
    with _simex_tehsil_lock:
        state = _simex_tehsil_jobs.get(key)
    if not state:
        return jsonify(status="not_started", progress=0)
    resp = {
        "status": state["status"],
        "progress": state.get("progress", 0),
        "error": state.get("error"),
    }
    if state["status"] == "done" and state.get("result"):
        resp["result"] = state["result"]
    return jsonify(resp)


@app.route("/pyapi/simex/tehsil-buildings/geojson")
def simex_tehsil_buildings_geojson():
    key = request.args.get("key", "").strip()
    if not key:
        return jsonify(error="key query param required"), 400
    path = _simex_tehsil_buildings_path(key)
    if not os.path.isfile(path):
        return jsonify(error="not yet computed"), 404
    with open(path, "rb") as fh:
        data = fh.read()
    return Response(data, mimetype="application/geo+json", headers={
        "Cache-Control": "no-cache",
    })


# ── Exposure (GCOP scenario footprint) ∩ tehsil buildings ───
# For GCOP exposure scenarios (which carry a flood footprint but no precomputed
# building set), count the district's buildings that fall inside BOTH the tehsil
# polygon AND the scenario footprint sent by the client. Cached on disk.
# { key: { status, progress, result, error } }
_exp_tehsil_jobs = {}
_exp_tehsil_lock = threading.Lock()


def _exp_tehsil_key(scenario_id, province, district, tehsil):
    import re

    def clean(s):
        return re.sub(r"[^A-Za-z0-9]+", "_", (s or "").strip()).strip("_")

    parts = [clean(str(scenario_id)), clean(province), clean(district), clean(tehsil)]
    return "exptehsil_" + "_".join(p for p in parts if p)


def _exp_tehsil_buildings_path(key):
    return os.path.join(TEMP_DIR, f"{key}_buildings.geojson")


def _exp_tehsil_count_path(key):
    return os.path.join(TEMP_DIR, f"{key}_count.json")


def _exp_tehsil_clip_path(key):
    return os.path.join(TEMP_DIR, f"{key}_clip.geojson")


def _exp_tehsil_cache_complete(key):
    cpath = _exp_tehsil_count_path(key)
    gpath = _exp_tehsil_buildings_path(key)
    clip_path = _exp_tehsil_clip_path(key)
    if not (os.path.isfile(cpath) and os.path.isfile(gpath) and os.path.isfile(clip_path)):
        return False, None
    try:
        with open(cpath, "r", encoding="utf-8") as fh:
            result = json.load(fh)
        expected = int(result.get("count", 0) or 0)
        with open(gpath, "r", encoding="utf-8") as fh:
            gj = json.load(fh)
        actual = len(gj.get("features", [])) if isinstance(gj, dict) else 0
        if expected > 0 and actual == 0:
            return False, None
        return True, result
    except Exception:
        return False, None


# Projections whose footprint is a static GeoJSON in the client public folder,
# read server-side so the (large) geometry isn't uploaded on every request.
_LOCAL_PROJECTION_FILES = {
    "north_waterways": os.path.join(
        os.path.dirname(os.path.abspath(__file__)),
        "..", "client", "public", "north_waterways_only_final.geojson",
    ),
}


def _geoms_from_clip(clip):
    """Extract shapely geometries from a GeoJSON geometry, Feature, or
    FeatureCollection sent by the client."""
    from shapely.geometry import shape
    geoms = []
    if not clip:
        return geoms
    if clip.get("type") == "FeatureCollection":
        for f in clip.get("features", []):
            g = f.get("geometry")
            if g:
                geoms.append(shape(g))
    elif clip.get("type") == "Feature":
        if clip.get("geometry"):
            geoms.append(shape(clip["geometry"]))
    else:
        geoms.append(shape(clip))
    return geoms


def _exp_tehsil_worker(key, scenario_id, province, district, tehsil, geometry, clip):
    def _set(p):
        with _exp_tehsil_lock:
            job = _exp_tehsil_jobs.get(key)
            if job and job["status"] == "processing":
                job["progress"] = p

    valid, cached = _exp_tehsil_cache_complete(key)
    if valid:
        with _exp_tehsil_lock:
            _exp_tehsil_jobs[key] = {"status": "done", "progress": 100, "result": cached, "error": None}
        return

    with _exp_tehsil_lock:
        _exp_tehsil_jobs[key] = {"status": "processing", "progress": 5, "result": None, "error": None}

    try:
        from shapely.geometry import shape

        tehsil_geom = shape(geometry)
        tehsil_gdf = gpd.GeoDataFrame(geometry=[tehsil_geom], crs="EPSG:4326")
        clip_geoms = _geoms_from_clip(clip)
        # Static projections carry no client-sent clip — read the file on disk.
        if not clip_geoms:
            local = _LOCAL_PROJECTION_FILES.get(str(scenario_id))
            if local and os.path.isfile(local):
                with open(local, "r", encoding="utf-8") as fh:
                    clip_geoms = _geoms_from_clip(json.load(fh))
        if not clip_geoms:
            raise RuntimeError("Scenario footprint geometry was empty")
        clip_gdf = gpd.GeoDataFrame(geometry=clip_geoms, crs="EPSG:4326")

        # Clip the scenario footprint to the tehsil (WGS84) and cache it as its
        # own layer for the map.
        from shapely.ops import unary_union
        clipped_poly = tehsil_geom.intersection(unary_union(clip_geoms))
        clip_out = gpd.GeoDataFrame(
            geometry=([] if clipped_poly.is_empty else [clipped_poly]), crs="EPSG:4326")
        _write_geojson(clip_out, _exp_tehsil_clip_path(key))
        _set(20)

        build_district = _resolve_building_district(tehsil_gdf, district)
        shp_file = _ensure_buildings_shp(build_district)
        _set(50)
        buildings_gdf = gpd.read_file(shp_file)
        total = int(len(buildings_gdf))
        _set(65)

        if buildings_gdf.crs:
            if str(tehsil_gdf.crs) != str(buildings_gdf.crs):
                tehsil_gdf = tehsil_gdf.to_crs(buildings_gdf.crs)
            if str(clip_gdf.crs) != str(buildings_gdf.crs):
                clip_gdf = clip_gdf.to_crs(buildings_gdf.crs)

        in_tehsil = set(gpd.sjoin(buildings_gdf, tehsil_gdf, how="inner", predicate="intersects").index)
        in_clip = set(gpd.sjoin(buildings_gdf, clip_gdf, how="inner", predicate="intersects").index)
        inside_idx = list(in_tehsil & in_clip)
        inside = buildings_gdf.loc[inside_idx]
        count = int(len(inside))
        _set(85)

        if inside.crs and str(inside.crs) != "EPSG:4326":
            inside = inside.to_crs("EPSG:4326")
        _write_geojson(inside if not inside.empty else buildings_gdf.iloc[0:0],
                       _exp_tehsil_buildings_path(key))

        result = {
            "count": count,
            "district_buildings_total": total,
            "scenario_id": str(scenario_id),
            "province": province,
            "district": district,
            "tehsil": tehsil,
        }
        try:
            with open(_exp_tehsil_count_path(key), "w", encoding="utf-8") as fh:
                json.dump(result, fh)
        except Exception as exc:
            print(f"[exp-tehsil] count cache write failed: {exc}")

        with _exp_tehsil_lock:
            _exp_tehsil_jobs[key] = {"status": "done", "progress": 100, "result": result, "error": None}
    except Exception as exc:
        import traceback
        traceback.print_exc()
        with _exp_tehsil_lock:
            _exp_tehsil_jobs[key] = {"status": "error", "progress": 0, "result": None, "error": str(exc)}


@app.route("/pyapi/simex/exposure-tehsil", methods=["POST"])
def start_exp_tehsil_buildings():
    """Count district buildings inside (tehsil ∩ scenario footprint).
    Body: { scenario_id, province, district, tehsil, geometry, clip, force }
    where `clip` is the scenario footprint GeoJSON (only needed uncached)."""
    body = request.get_json(silent=True) or {}
    scenario_id = str(body.get("scenario_id") or "").strip()
    province = (body.get("province") or "").strip()
    district = (body.get("district") or "").strip()
    tehsil = (body.get("tehsil") or "").strip()
    geometry = body.get("geometry")
    clip = body.get("clip")
    force = bool(body.get("force"))
    if not scenario_id or not district or not tehsil:
        return jsonify(error="scenario_id, district and tehsil are required"), 400

    key = _exp_tehsil_key(scenario_id, province, district, tehsil)

    if force:
        for p in (_exp_tehsil_count_path(key), _exp_tehsil_buildings_path(key)):
            if os.path.isfile(p):
                try:
                    os.remove(p)
                except OSError:
                    pass
        with _exp_tehsil_lock:
            _exp_tehsil_jobs.pop(key, None)

    valid, cached = _exp_tehsil_cache_complete(key)
    if valid:
        with _exp_tehsil_lock:
            _exp_tehsil_jobs[key] = {"status": "done", "progress": 100, "result": cached, "error": None}
        return jsonify(status="done", progress=100, result=cached, key=key, cached=True)

    with _exp_tehsil_lock:
        cur = _exp_tehsil_jobs.get(key)
        if cur and cur["status"] == "done" and cur.get("result"):
            return jsonify(status="done", progress=100, result=cur["result"], key=key, cached=True)
        if cur and cur["status"] == "processing":
            return jsonify(status="processing", progress=cur["progress"], key=key)

    if geometry is None or (clip is None and str(scenario_id) not in _LOCAL_PROJECTION_FILES):
        return jsonify(error="geometry and clip are required to compute this tehsil"), 400

    t = threading.Thread(
        target=_exp_tehsil_worker,
        args=(key, scenario_id, province, district, tehsil, geometry, clip), daemon=True,
    )
    t.start()
    return jsonify(status="processing", progress=0, key=key)


@app.route("/pyapi/simex/exposure-tehsil/status")
def exp_tehsil_buildings_status():
    key = request.args.get("key", "").strip()
    if not key:
        return jsonify(error="key query param required"), 400
    with _exp_tehsil_lock:
        state = _exp_tehsil_jobs.get(key)
    if not state:
        return jsonify(status="not_started", progress=0)
    resp = {
        "status": state["status"],
        "progress": state.get("progress", 0),
        "error": state.get("error"),
    }
    if state["status"] == "done" and state.get("result"):
        resp["result"] = state["result"]
    return jsonify(resp)


@app.route("/pyapi/simex/exposure-tehsil/geojson")
def exp_tehsil_buildings_geojson():
    key = request.args.get("key", "").strip()
    if not key:
        return jsonify(error="key query param required"), 400
    path = _exp_tehsil_buildings_path(key)
    if not os.path.isfile(path):
        return jsonify(error="not yet computed"), 404
    with open(path, "rb") as fh:
        data = fh.read()
    return Response(data, mimetype="application/geo+json", headers={
        "Cache-Control": "no-cache",
    })


@app.route("/pyapi/simex/exposure-tehsil/clip")
def exp_tehsil_clip_geojson():
    """Serve the scenario footprint clipped to the tehsil (polygon layer)."""
    key = request.args.get("key", "").strip()
    if not key:
        return jsonify(error="key query param required"), 400
    path = _exp_tehsil_clip_path(key)
    if not os.path.isfile(path):
        return jsonify(error="not yet computed"), 404
    with open(path, "rb") as fh:
        data = fh.read()
    return Response(data, mimetype="application/geo+json", headers={
        "Cache-Control": "no-cache",
    })


# ── Building count (per-district) ───────────────────────────
# Lightweight endpoint that returns the total building count for a district.
# Resolution order:
#   1. Disk-memoized count file (<key>_count.json) — instant.
#   2. Existing encroachment / analysis cache — reuse `total_buildings`.
#   3. pyogrio.read_info() on the source shapefile in BUILDINGS_DIR — no
#      geometry parsing required, very fast for large shapefiles.
#   4. As a last resort, count from the cached WFS-downloaded GeoJSON.
def _building_count_cache_path(key):
    return os.path.join(TEMP_DIR, f"{key}_count.json")


def _shp_feature_count(shp_path):
    """Return the number of features in a shapefile without loading geometry."""
    try:
        import pyogrio
        info = pyogrio.read_info(shp_path)
        n = info.get("features")
        if n is None:
            return None
        return int(n)
    except Exception as exc:
        print(f"[count] pyogrio.read_info failed for {shp_path}: {exc}")
        return None


def _extract_wfs_count(resp):
    """Pull a feature count out of a GeoServer WFS response.

    Accepts the GeoServer JSON shape (numberMatched / totalFeatures /
    numberOfFeatures keys) and the XML hits response (same names as
    attributes on the root element). Returns int or None.
    """
    body_text = resp.text or ""
    try:
        data = resp.json()
        for k in ("numberMatched", "totalFeatures", "numberOfFeatures"):
            v = data.get(k)
            if v is None:
                continue
            try:
                return int(v)
            except (TypeError, ValueError):
                continue
    except ValueError:
        pass  # not JSON — fall through to XML parsing
    try:
        import re
        m = re.search(r'\b(numberMatched|numberOfFeatures|totalFeatures)\s*=\s*"(\d+)"', body_text)
        if m:
            return int(m.group(2))
    except Exception:
        pass
    return None


def _wfs_hits_count(district, cql_filter=None):
    """Ask GeoServer for the feature count via WFS resultType=hits — returns
    an int on success or None on any failure. This avoids downloading any
    geometry; the response contains just numberMatched/totalFeatures.

    If `cql_filter` is provided, it is URL-appended as CQL_FILTER so the
    count is restricted to features satisfying the filter (e.g. INTERSECTS
    with a polygon).
    """
    wfs_url = _get_wfs_url(district)
    if not wfs_url:
        return None

    sep = "&" if "?" in wfs_url else "?"
    hits_url = f"{wfs_url}{sep}resultType=hits"
    if cql_filter:
        from urllib.parse import quote
        hits_url += f"&CQL_FILTER={quote(cql_filter)}"

    try:
        resp = req_lib.get(hits_url, timeout=120)
        resp.raise_for_status()
    except Exception as exc:
        print(f"[count] WFS hits request failed for {district}: {exc}")
        return None

    n = _extract_wfs_count(resp)
    if n is None:
        print(f"[count] could not extract count from WFS response for {district}")
    return n


@app.route("/pyapi/buildings/count")
def buildings_count():
    """Return total building count for a district. Cached on disk."""
    district = request.args.get("district", "").strip()
    if not district:
        return jsonify(error="district query param required"), 400

    key = _district_key(district)
    count_path = _building_count_cache_path(key)

    # 1) Disk memoization
    if os.path.isfile(count_path):
        try:
            with open(count_path, "r", encoding="utf-8") as fh:
                return jsonify(**json.load(fh))
        except Exception:
            pass

    # 2) Reuse total_buildings from prior analysis caches
    for path in (_encroachment_cache_path(key), _analysis_cache_path(key)):
        if not os.path.isfile(path):
            continue
        try:
            with open(path, "r", encoding="utf-8") as fh:
                cached = json.load(fh)
            total = int(cached.get("total_buildings", 0) or 0)
            if total > 0:
                payload = {"district": district, "total_buildings": total, "source": "cache"}
                with open(count_path, "w", encoding="utf-8") as fh:
                    json.dump(payload, fh)
                return jsonify(**payload)
        except Exception:
            continue

    # 3) pyogrio.read_info on the source shapefile
    bdir = os.environ.get("BUILDINGS_DIR", "")
    if bdir:
        shp_path = os.path.join(bdir, f"{key}_buildings.shp")
        if os.path.isfile(shp_path):
            n = _shp_feature_count(shp_path)
            if n is not None:
                payload = {"district": district, "total_buildings": n, "source": "shp"}
                with open(count_path, "w", encoding="utf-8") as fh:
                    json.dump(payload, fh)
                return jsonify(**payload)

    # 4) GeoServer WFS — ask for resultType=hits to get the count without
    #    downloading any geometry. Works whenever the district has a wfs_url
    #    in the tracker CSV.
    n = _wfs_hits_count(district)
    if n is not None:
        payload = {"district": district, "total_buildings": n, "source": "wfs"}
        with open(count_path, "w", encoding="utf-8") as fh:
            json.dump(payload, fh)
        return jsonify(**payload)

    # 5) Fallback: count features in the cached WFS GeoJSON if present
    geojson_path = _cached_geojson_path(key)
    if os.path.isfile(geojson_path):
        try:
            with open(geojson_path, "r", encoding="utf-8") as fh:
                fc = json.load(fh)
            n = len(fc.get("features", []))
            payload = {"district": district, "total_buildings": n, "source": "geojson"}
            with open(count_path, "w", encoding="utf-8") as fh:
                json.dump(payload, fh)
            return jsonify(**payload)
        except Exception:
            pass

    return jsonify(district=district, total_buildings=None,
                   error="No building data available for this district"), 404


def _gcop_count_cache_path(key, geom_hash):
    return os.path.join(TEMP_DIR, f"{key}_gcop_count_{geom_hash}.json")


def _gcop_geom_hash(geom_data):
    """Return a stable hash for a GeoJSON geometry/feature/featurecollection."""
    import hashlib
    geom = _geom_payload_to_shapely(geom_data)
    if geom is None or geom.is_empty:
        return None
    return hashlib.sha1(geom.wkb).hexdigest()[:12]


def _geom_payload_to_shapely(geom_data):
    """Turn a GeoJSON Geometry / Feature / FeatureCollection into a single
    valid shapely geometry (unary_union of all member geometries)."""
    from shapely.geometry import shape
    from shapely.ops import unary_union

    geoms = []
    if not geom_data:
        return None

    def _try(g):
        if not g:
            return
        try:
            geoms.append(shape(g))
        except Exception as exc:
            print(f"[gcop] shape() failed: {exc}")

    t = geom_data.get("type")
    if t == "FeatureCollection":
        for f in (geom_data.get("features") or []):
            _try(f.get("geometry"))
    elif t == "Feature":
        _try(geom_data.get("geometry"))
    else:
        _try(geom_data)

    if not geoms:
        return None
    merged = unary_union(geoms) if len(geoms) > 1 else geoms[0]
    if not merged.is_valid:
        merged = merged.buffer(0)
    return merged


def _set_gcop(task_id, **updates):
    """Thread-safe update of a GCOP task's state dict."""
    with _gcop_lock:
        if task_id in _gcop_tasks:
            _gcop_tasks[task_id].update(updates)
            status = updates.get('status')
            if status in {'done', 'error'}:
                request_key = _gcop_tasks[task_id].get('request_key')
                if request_key and _gcop_tasks_by_key.get(request_key) == task_id:
                    del _gcop_tasks_by_key[request_key]


def _strip_wfs_paging(url):
    """Remove any pre-existing maxFeatures / startIndex / BBOX query params
    so we can re-add our own. The tracker CSV stores fully-formed WFS URLs
    that may include defaults from when the layer was registered."""
    import re
    cleaned = re.sub(r'&(maxFeatures|startIndex|count|BBOX)=[^&]*', '', url, flags=re.IGNORECASE)
    cleaned = re.sub(r'\?(maxFeatures|startIndex|count|BBOX)=[^&]*&?', '?', cleaned, flags=re.IGNORECASE)
    return cleaned.rstrip('?&')


def _gcop_worker(task_id, district, geom_dict, geom_hash):
    """Background worker that resolves a SIMEX exposure → count for one
    district. Pipeline:

      1. Convert the supplied GeoJSON geometry to a single shapely polygon
         (unary_union). Compute its bounding box.
      2. Look up the district's WFS URL from the tracker CSV.
      3. Page through WFS with BBOX=<polygon bbox> — only buildings near
         the exposure are downloaded, instead of the entire district.
      4. Read into a GeoDataFrame, run a spatial sjoin against the precise
         polygon, count unique matches.
      5. Persist {district, total_buildings} to temp/<key>_gcop_count_<hash>.json
         so the next request for the same (district, geometry) is instant.
    """
    try:
        _set_gcop(task_id, status="processing", progress=5, stage="preparing geometry")
        print(f"[gcop] task {task_id}: starting — district={district}")

        merged = _geom_payload_to_shapely(geom_dict)
        if merged is None or merged.is_empty:
            _set_gcop(task_id, status="error", error="Invalid or empty geometry")
            print(f"[gcop] task {task_id}: invalid geometry")
            return

        bounds = merged.bounds  # (minx, miny, maxx, maxy) in lon/lat
        # Tiny pad (~100 m at the equator) so polygons that just touch the
        # bbox edge aren't excluded by integer rounding on GeoServer's side.
        pad = 0.001
        bbox = (bounds[0] - pad, bounds[1] - pad, bounds[2] + pad, bounds[3] + pad)
        print(f"[gcop] task {task_id}: bbox={bbox}")

        _set_gcop(task_id, progress=10, stage=f"looking up WFS for {district}")
        wfs_url = _get_wfs_url(district)
        if not wfs_url:
            msg = f"No WFS URL configured for district '{district}'"
            _set_gcop(task_id, status="error", error=msg)
            print(f"[gcop] task {task_id}: {msg}")
            return

        base_url = _strip_wfs_paging(wfs_url)
        sep = "&" if "?" in base_url else "?"
        bbox_str = f"{bbox[0]},{bbox[1]},{bbox[2]},{bbox[3]},EPSG:4326"
        bbox_url = f"{base_url}{sep}BBOX={bbox_str}"

        # Paginate the bbox-filtered download. Page size is modest so
        # individual round-trips stay snappy and progress updates are
        # meaningful even on big districts.
        all_features = []
        start_index = 0
        page_size = 50_000
        page_num = 0
        max_pages = 60  # safety cap (~3 M features) — adjust if you hit it
        while page_num < max_pages:
            page_url = f"{bbox_url}&maxFeatures={page_size}&startIndex={start_index}"
            page_num += 1
            stage_msg = (f"downloading buildings page {page_num} "
                         f"(have {len(all_features):,} so far)")
            _set_gcop(task_id, progress=min(65, 15 + page_num * 4), stage=stage_msg)
            print(f"[gcop] task {task_id}: GET page {page_num}, startIndex={start_index}")
            try:
                resp = req_lib.get(page_url, timeout=300)
                resp.raise_for_status()
            except Exception as exc:
                _set_gcop(task_id, status="error", error=f"WFS request failed: {exc}")
                print(f"[gcop] task {task_id}: WFS error: {exc}")
                return
            page = resp.json() if "json" in resp.headers.get("content-type", "").lower() else json.loads(resp.text)
            features = page.get("features", []) or []
            all_features.extend(features)
            print(f"[gcop] task {task_id}: page {page_num} -> {len(features)} features (total {len(all_features)})")
            if len(features) < page_size:
                break
            start_index += page_size

        _set_gcop(task_id, progress=75,
                  stage=f"intersecting {len(all_features):,} buildings with polygon")

        if not all_features:
            count = 0
        else:
            try:
                fc = {"type": "FeatureCollection", "features": all_features}
                buildings_gdf = gpd.GeoDataFrame.from_features(fc, crs="EPSG:4326")
                # Drop rows with null/empty geometry to avoid sjoin crashes
                buildings_gdf = buildings_gdf[~buildings_gdf.geometry.isna()]
                buildings_gdf = buildings_gdf[~buildings_gdf.geometry.is_empty]
                geom_gdf = gpd.GeoDataFrame(geometry=[merged], crs="EPSG:4326")
                if buildings_gdf.crs != geom_gdf.crs:
                    geom_gdf = geom_gdf.to_crs(buildings_gdf.crs)
                joined = gpd.sjoin(buildings_gdf, geom_gdf, how="inner", predicate="intersects")
                count = int(joined.index.unique().size)
            except Exception as exc:
                import traceback
                traceback.print_exc()
                _set_gcop(task_id, status="error", error=f"Spatial intersect failed: {exc}")
                return

        # Persist
        key = _district_key(district)
        cache_path = _gcop_count_cache_path(key, geom_hash)
        payload = {
            "district": district,
            "total_buildings": count,
            "source": "wfs-bbox+sjoin",
            "geom_hash": geom_hash,
            "downloaded_in_bbox": len(all_features),
        }
        try:
            with open(cache_path, "w", encoding="utf-8") as fh:
                json.dump(payload, fh)
        except Exception:
            pass

        _set_gcop(task_id, status="done", progress=100, result=payload, stage="done")
        print(f"[gcop] task {task_id}: DONE — {count} buildings inside exposure polygon")

    except Exception as exc:
        import traceback
        traceback.print_exc()
        _set_gcop(task_id, status="error", error=str(exc))


@app.route("/pyapi/buildings/count-in-geometry", methods=["POST"])
def buildings_count_in_geometry():
    """Start a background GCOP count task. Returns immediately with either
    {status:'done', result} when a disk cache hit exists, or {status:'processing',
    task_id} when a worker has been spawned — poll the /status route below."""
    body = request.get_json(silent=True) or {}
    district = (body.get("district") or "").strip()
    geom = body.get("geometry")
    if not district or geom is None:
        return jsonify(error="district and geometry are required"), 400

    import uuid
    geom_hash = _gcop_geom_hash(geom)
    if geom_hash is None:
        return jsonify(error="Invalid or empty geometry"), 400

    # Disk cache hit → return immediately
    key = _district_key(district)
    cache_path = _gcop_count_cache_path(key, geom_hash)
    if os.path.isfile(cache_path):
        try:
            with open(cache_path, "r", encoding="utf-8") as fh:
                cached = json.load(fh)
            return jsonify(status="done", result=cached, cached=True)
        except Exception:
            pass

    request_key = f"{key}_{geom_hash}"
    with _gcop_lock:
        existing_task_id = _gcop_tasks_by_key.get(request_key)
        if existing_task_id:
            existing = _gcop_tasks.get(existing_task_id)
            if existing and existing.get("status") == "processing":
                return jsonify(status="processing", task_id=existing_task_id, progress=existing.get("progress", 0))

        task_id = f"{request_key}_{uuid.uuid4().hex[:6]}"
        _gcop_tasks[task_id] = {
            "status": "processing", "progress": 0, "stage": "queued",
            "district": district, "result": None, "error": None,
            "request_key": request_key,
        }
        _gcop_tasks_by_key[request_key] = task_id

    t = threading.Thread(target=_gcop_worker,
                         args=(task_id, district, geom, geom_hash), daemon=True)
    t.start()
    return jsonify(status="processing", task_id=task_id, progress=0)


@app.route("/pyapi/simex/precomputed")
def simex_precomputed():
    """Return pre-computed building counts for all HPC-processed scenarios."""
    return jsonify(_get_simex_precomputed())


@app.route("/pyapi/simex/geometry/<scenario_id>")
def simex_geometry(scenario_id):
    """Serve the scenario flood-footprint GeoJSON for map visualization."""
    folder = _find_scenario_folder(scenario_id)
    if not folder:
        return jsonify(error="Scenario not found"), 404
    geojson_path = os.path.join(SCENARIO_OUTPUTS_DIR, folder, "scenario_geometry.geojson")
    if not os.path.isfile(geojson_path):
        return jsonify(error="Geometry file not found"), 404
    with open(geojson_path, "rb") as fh:
        data = fh.read()
    return Response(data, mimetype="application/geo+json", headers={"Cache-Control": "no-cache"})


@app.route("/pyapi/simex/buildings/<scenario_id>/<district>")
def simex_buildings(scenario_id, district):
    """Serve buildings_inside_scenario.shp as GeoJSON for the given district (disk-cached)."""
    folder = _find_scenario_folder(scenario_id)
    if not folder:
        return jsonify(error="Scenario not found"), 404
    cache_path = _simex_buildings_cache_path(scenario_id, district)
    if os.path.isfile(cache_path):
        with open(cache_path, "rb") as fh:
            return Response(fh.read(), mimetype="application/geo+json",
                            headers={"Cache-Control": "no-cache"})
    shp_path = os.path.join(SCENARIO_OUTPUTS_DIR, folder, "districts", district,
                            "buildings_inside_scenario.shp")
    if not os.path.isfile(shp_path):
        return jsonify(error="District not found"), 404
    try:
        gdf = gpd.read_file(shp_path)
        geojson_str = gdf.to_json()
        with open(cache_path, "w", encoding="utf-8") as fh:
            fh.write(geojson_str)
        return Response(geojson_str.encode("utf-8"), mimetype="application/geo+json",
                        headers={"Cache-Control": "no-cache"})
    except Exception as exc:
        return jsonify(error=str(exc)), 500


@app.route("/pyapi/buildings/count-in-geometry/status")
def buildings_count_in_geometry_status():
    """Poll endpoint for a GCOP count task started by the route above."""
    task_id = (request.args.get("task_id") or "").strip()
    if not task_id:
        return jsonify(error="task_id required"), 400
    with _gcop_lock:
        state = _gcop_tasks.get(task_id)
    if state is None:
        return jsonify(status="not_found"), 404
    # Return a shallow copy to avoid surfacing mutations mid-response
    return jsonify(**state)


@app.route("/pyapi/buildings/encroachment/clipped")
def encroachment_clipped_geojson():
    """Serve the encroachment polygons clipped to the given district."""
    district = request.args.get("district", "").strip()
    if not district:
        return jsonify(error="district query param required"), 400

    key = _district_key(district)
    path = _clipped_encroachment_path(key)
    if not os.path.isfile(path):
        return jsonify(error="not yet computed"), 404

    with open(path, "rb") as fh:
        data = fh.read()
    return Response(data, mimetype="application/geo+json", headers={
        "Cache-Control": "no-cache",
    })


# ── Flood Projections 2026 analysis ─────────────────────────
# Same pipeline shape as the encroachment analysis, but the "zone" is the
# union of the Flood Projections 2026 GeoJSONs in client/public/floodextent,
# clipped to the selected district. Counts the district's buildings that fall
# inside the projected flood extent and sums their footprint area. Runs one
# district at a time; every intermediate is cached on disk so re-opening the
# same district is instant.

FLOODEXTENT_DIR = os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    "..", "client", "public", "floodextent",
)

# ── In-memory flood-projection state & cache ────────────────
# { district_key: { status, progress, result, error } }
_flood_proj = {}
_flood_proj_lock = threading.Lock()
# Lazy-loaded union of all projection polygons (parsed once).
_flood_proj_gdf_cache = None
_flood_proj_gdf_lock = threading.Lock()


def _load_flood_projection_gdf():
    """Lazy-load and memo-cache the union of every GeoJSON in FLOODEXTENT_DIR
    as a single EPSG:4326 GeoDataFrame (geometry only). These files are large
    (~190 MB combined) so this is done once and kept in memory."""
    global _flood_proj_gdf_cache
    with _flood_proj_gdf_lock:
        if _flood_proj_gdf_cache is not None:
            return _flood_proj_gdf_cache
        # gilgitriver_final.geojson holds a single very large feature that
        # exceeds GDAL's default GeoJSON object-size cap; "0" lifts the limit.
        os.environ.setdefault("OGR_GEOJSON_MAX_OBJ_SIZE", "0")
        parts = []
        if os.path.isdir(FLOODEXTENT_DIR):
            for fname in sorted(os.listdir(FLOODEXTENT_DIR)):
                if not fname.lower().endswith(".geojson"):
                    continue
                fpath = os.path.join(FLOODEXTENT_DIR, fname)
                try:
                    g = gpd.read_file(fpath)
                    if g.crs is None:
                        g = g.set_crs("EPSG:4326", allow_override=True)
                    elif g.crs.to_epsg() != 4326:
                        g = g.to_crs("EPSG:4326")
                    parts.append(g[["geometry"]])
                    print(f"[floodproj] Loaded {len(g)} features from {fname}")
                except Exception as exc:
                    print(f"[floodproj] Failed to load {fname}: {exc}")
        if parts:
            merged = gpd.GeoDataFrame(
                pd.concat(parts, ignore_index=True), crs="EPSG:4326"
            )
        else:
            merged = gpd.GeoDataFrame(geometry=[], crs="EPSG:4326")
        print(f"[floodproj] Total {len(merged)} projection polygons in memory")
        _flood_proj_gdf_cache = merged
        return _flood_proj_gdf_cache


def _flood_proj_cache_path(key):
    return os.path.join(TEMP_DIR, f"{key}_flood_proj.json")


def _flood_proj_clipped_path(key):
    return os.path.join(TEMP_DIR, f"{key}_flood_proj_clipped.geojson")


def _flood_proj_buildings_path(key):
    return os.path.join(TEMP_DIR, f"{key}_flood_proj_buildings.geojson")


def _flood_proj_cache_complete(key):
    """Return (is_valid, cached_result|None). The summary JSON must exist and
    parse; when it reports a non-zero building count, the matched-buildings
    GeoJSON must also exist and be non-empty (catches stale/empty writes)."""
    cache_path = _flood_proj_cache_path(key)
    if not os.path.isfile(cache_path):
        return False, None
    try:
        with open(cache_path, "r", encoding="utf-8") as fh:
            result = json.load(fh)
        expected = int(result.get("projection_count", 0) or 0)
        if expected > 0:
            bpath = _flood_proj_buildings_path(key)
            if not os.path.isfile(bpath):
                return False, None
            with open(bpath, "r", encoding="utf-8") as fh:
                eb = json.load(fh)
            if not isinstance(eb, dict) or len(eb.get("features", [])) == 0:
                return False, None
        return True, result
    except Exception:
        return False, None


def _flood_projection_worker(district):
    """Background thread: clip the flood-projection union to the district,
    intersect with the district's buildings, count them and sum footprint
    area. Each intermediate is persisted so re-runs skip prior steps."""
    key = _district_key(district)

    valid, cached_result = _flood_proj_cache_complete(key)
    if valid:
        with _flood_proj_lock:
            _flood_proj[key] = {
                "status": "done", "progress": 100, "result": cached_result, "error": None,
            }
        return

    with _flood_proj_lock:
        _flood_proj[key] = {"status": "processing", "progress": 5, "result": None, "error": None}

    try:
        # ── Step 1: clip projection polygons to the district ─────────
        clipped_path = _flood_proj_clipped_path(key)
        if os.path.isfile(clipped_path):
            print(f"[floodproj] Reusing cached clip: {clipped_path}")
            clipped_gdf = gpd.read_file(clipped_path)
            with _flood_proj_lock:
                _flood_proj[key]["progress"] = 40
        else:
            with _flood_proj_lock:
                _flood_proj[key]["progress"] = 10
            district_gdf = _load_district_polygon(district)

            with _flood_proj_lock:
                _flood_proj[key]["progress"] = 20
            proj_gdf = _load_flood_projection_gdf()
            if district_gdf.crs and proj_gdf.crs and district_gdf.crs != proj_gdf.crs:
                district_gdf = district_gdf.to_crs(proj_gdf.crs)

            with _flood_proj_lock:
                _flood_proj[key]["progress"] = 30
            print(f"[floodproj] Clipping {len(proj_gdf)} polygons by {district}…")
            clipped_gdf = gpd.clip(proj_gdf, district_gdf)
            print(f"[floodproj] Clipped to {len(clipped_gdf)} polygons")

            with _flood_proj_lock:
                _flood_proj[key]["progress"] = 40
            if not clipped_gdf.empty:
                _write_geojson(clipped_gdf, clipped_path)

        # ── Fast path: district doesn't overlap any flood projection ──
        # Most districts fall entirely outside the projected extent, so there
        # is nothing to count. Skip the (expensive) WFS building download
        # entirely and record a zero result. Total-buildings is fetched
        # cheaply via a WFS hits query when available.
        if clipped_gdf.empty:
            print(f"[floodproj] {district} does not overlap any projection — skipping building download")
            total_buildings = _wfs_hits_count(district) or 0
            with open(_flood_proj_buildings_path(key), "w", encoding="utf-8") as fh:
                json.dump({"type": "FeatureCollection", "features": []}, fh)
            result = {
                "total_buildings": int(total_buildings),
                "projection_count": 0,
                "percentage": 0.0,
                "area_sqm": 0.0,
                "area_sqft": 0.0,
                "zone_area_sqm": 0.0,
                "zone_area_sqkm": 0.0,
                "in_projection": False,
            }
            with open(_flood_proj_cache_path(key), "w", encoding="utf-8") as fh:
                json.dump(result, fh)
            with _flood_proj_lock:
                _flood_proj[key] = {
                    "status": "done", "progress": 100, "result": result, "error": None,
                }
            return

        # ── Step 2: ensure building shapefile is local ────────────────
        shp_file = _ensure_buildings_shp(district)
        with _flood_proj_lock:
            _flood_proj[key]["progress"] = 60

        buildings_gdf = gpd.read_file(shp_file)
        total_buildings = int(len(buildings_gdf))
        with _flood_proj_lock:
            _flood_proj[key]["progress"] = 70

        # ── Step 3: intersect buildings with the clipped projection ───
        if buildings_gdf.crs and clipped_gdf.crs and buildings_gdf.crs != clipped_gdf.crs:
            clipped_gdf = clipped_gdf.to_crs(buildings_gdf.crs)
        joined = gpd.sjoin(buildings_gdf, clipped_gdf, how="inner", predicate="intersects")
        matched_idx = joined.index.unique()
        matched_gdf = buildings_gdf.loc[matched_idx]
        projection_count = int(len(matched_gdf))

        try:
            metric_crs = matched_gdf.estimate_utm_crs()
        except Exception:
            metric_crs = "EPSG:32642"  # UTM 42N (Pakistan)
        try:
            area_sqm = float(matched_gdf.to_crs(metric_crs).geometry.area.sum())
        except Exception:
            area_sqm = 0.0

        with _flood_proj_lock:
            _flood_proj[key]["progress"] = 85

        # ── Step 4: persist the matching buildings as GeoJSON ─────────
        buildings_out = _flood_proj_buildings_path(key)
        if not matched_gdf.empty:
            cols_to_drop = [c for c in matched_gdf.columns if c.startswith("index_right")]
            if cols_to_drop:
                matched_gdf = matched_gdf.drop(columns=cols_to_drop)
            _write_geojson(matched_gdf, buildings_out)
        else:
            with open(buildings_out, "w", encoding="utf-8") as fh:
                json.dump({"type": "FeatureCollection", "features": []}, fh)

        with _flood_proj_lock:
            _flood_proj[key]["progress"] = 95

        # ── Step 4a: projected-zone area ──────────────────────────────
        zone_area_sqm = 0.0
        if not clipped_gdf.empty:
            try:
                metric_zone = clipped_gdf.estimate_utm_crs()
            except Exception:
                metric_zone = "EPSG:32642"
            try:
                zone_area_sqm = float(clipped_gdf.to_crs(metric_zone).geometry.area.sum())
            except Exception:
                zone_area_sqm = 0.0

        # ── Step 5: write summary JSON ────────────────────────────────
        pct = round(projection_count / total_buildings * 100, 2) if total_buildings else 0.0
        area_sqft = area_sqm * 10.7639  # 1 m² ≈ 10.7639 ft²
        result = {
            "total_buildings": total_buildings,
            "projection_count": projection_count,
            "percentage": pct,
            "area_sqm": round(area_sqm, 2),
            "area_sqft": round(area_sqft, 2),
            "zone_area_sqm": round(zone_area_sqm, 2),
            "zone_area_sqkm": round(zone_area_sqm / 1_000_000, 4),
        }
        with open(_flood_proj_cache_path(key), "w", encoding="utf-8") as fh:
            json.dump(result, fh)

        with _flood_proj_lock:
            _flood_proj[key] = {
                "status": "done", "progress": 100, "result": result, "error": None,
            }

    except Exception as exc:
        import traceback
        traceback.print_exc()
        with _flood_proj_lock:
            _flood_proj[key] = {
                "status": "error", "progress": 0, "result": None, "error": str(exc),
            }


@app.route("/pyapi/buildings/flood-projection", methods=["POST"])
def start_flood_projection():
    """Kick off the Flood Projections 2026 count/area for a district.
    Returns a cached result immediately when available (disk or memory).

    Pass {"force": true} to invalidate the on-disk cache and reprocess."""
    body = request.get_json(silent=True) or {}
    district = body.get("district", "").strip()
    force = bool(body.get("force"))
    if not district:
        return jsonify(error="district is required"), 400

    key = _district_key(district)

    if force:
        for p in (
            _flood_proj_cache_path(key),
            _flood_proj_buildings_path(key),
            _flood_proj_clipped_path(key),
        ):
            if os.path.isfile(p):
                try:
                    os.remove(p)
                except OSError:
                    pass
        with _flood_proj_lock:
            _flood_proj.pop(key, None)

    # Prefer disk cache (survives restarts, shared across clients).
    valid, cached_result = _flood_proj_cache_complete(key)
    if valid:
        with _flood_proj_lock:
            _flood_proj[key] = {
                "status": "done", "progress": 100, "result": cached_result, "error": None,
            }
        return jsonify(status="done", progress=100, result=cached_result, cached=True)

    with _flood_proj_lock:
        cached = _flood_proj.get(key)
        if cached and cached["status"] == "done":
            return jsonify(status="done", progress=100, result=cached["result"], cached=True)
        if cached and cached["status"] == "processing":
            return jsonify(status="processing", progress=cached["progress"])

    t = threading.Thread(target=_flood_projection_worker, args=(district,), daemon=True)
    t.start()
    return jsonify(status="processing", progress=0)


@app.route("/pyapi/buildings/flood-projection/status")
def flood_projection_status():
    """Poll endpoint for flood-projection analysis progress / result."""
    district = request.args.get("district", "").strip()
    if not district:
        return jsonify(error="district query param required"), 400

    key = _district_key(district)
    with _flood_proj_lock:
        state = _flood_proj.get(key)

    if not state:
        return jsonify(status="not_started", progress=0)

    resp = {
        "status": state["status"],
        "progress": state.get("progress", 0),
        "error": state.get("error"),
    }
    if state["status"] == "done" and state.get("result"):
        resp["result"] = state["result"]
    return jsonify(resp)


@app.route("/pyapi/buildings/flood-projection/geojson")
def flood_projection_geojson():
    """Serve the per-district GeoJSON of buildings inside the flood projection."""
    district = request.args.get("district", "").strip()
    if not district:
        return jsonify(error="district query param required"), 400

    key = _district_key(district)
    path = _flood_proj_buildings_path(key)
    if not os.path.isfile(path):
        return jsonify(error="not yet computed"), 404

    with open(path, "rb") as fh:
        data = fh.read()
    return Response(data, mimetype="application/geo+json", headers={
        "Cache-Control": "no-cache",
    })


# ── Production-only routes (GeoServer proxy, Express proxy, static files) ──
# These are only meaningful when NIRRP_MODE=production, but registering them
# in dev is harmless — the Vite proxy intercepts those paths before Flask.

_CLIENT_DIST = pathlib.Path(__file__).parent.parent / "client" / "dist"

# Hop-by-hop headers that must not be forwarded
_HOP_HEADERS = {"host", "content-length", "transfer-encoding", "connection",
                "keep-alive", "proxy-authenticate", "proxy-authorization",
                "te", "trailers", "upgrade"}


def _proxy(url, timeout=300):
    """Stream-proxy the current Flask request to *url* and return a Response."""
    fwd_headers = {k: v for k, v in request.headers if k.lower() not in _HOP_HEADERS}
    try:
        upstream = req_lib.request(
            method=request.method,
            url=url,
            headers=fwd_headers,
            data=request.get_data(),
            params=request.args,
            stream=True,
            timeout=timeout,
        )
        resp_headers = [(k, v) for k, v in upstream.headers.items()
                        if k.lower() not in _HOP_HEADERS]
        return Response(upstream.iter_content(chunk_size=32768),
                        status=upstream.status_code, headers=resp_headers)
    except req_lib.exceptions.ConnectionError as exc:
        return jsonify(error=f"Upstream unreachable: {exc}"), 502
    except req_lib.exceptions.Timeout:
        return jsonify(error="Upstream timed out"), 504


@app.route("/geoserver/", defaults={"path": ""}, methods=["GET", "POST", "PUT", "DELETE", "HEAD", "OPTIONS", "PATCH"])
@app.route("/geoserver/<path:path>",             methods=["GET", "POST", "PUT", "DELETE", "HEAD", "OPTIONS", "PATCH"])
def geoserver_proxy(path):
    base = os.environ.get("GEOSERVER_URL", "http://172.18.1.151:8080")
    return _proxy(f"{base}/geoserver/{path}")


@app.route("/api/", defaults={"path": ""}, methods=["GET", "POST", "PUT", "DELETE", "HEAD", "OPTIONS", "PATCH"])
@app.route("/api/<path:path>",             methods=["GET", "POST", "PUT", "DELETE", "HEAD", "OPTIONS", "PATCH"])
def express_proxy(path):
    port = int(os.environ.get("SERVER_PORT", 7542))
    return _proxy(f"http://localhost:{port}/api/{path}", timeout=60)


@app.route("/", defaults={"path": ""})
@app.route("/<path:path>")
def serve_static(path):
    if not _CLIENT_DIST.exists():
        return (
            "<h2>Frontend not built.</h2>"
            "<p>Run <code>npm run build</code> inside <code>client/</code> "
            "then restart the server.</p>"
        ), 503
    target = _CLIENT_DIST / path
    if path and target.is_file():
        return send_from_directory(str(_CLIENT_DIST), path)
    # SPA fallback — React Router handles the path client-side
    return send_from_directory(str(_CLIENT_DIST), "index.html")


# ── Entry point ─────────────────────────────────────────────

if __name__ == "__main__":
    port = int(os.environ.get("PYBACKEND_PORT", 7543))
    production = os.environ.get("NIRRP_MODE", "dev").lower() == "production"

    if production:
        try:
            from waitress import serve as _waitress_serve
            print(f"\n  NIRRP Portal (production) -> http://0.0.0.0:{port}")
            print("  Press Ctrl+C to stop.\n")
            _waitress_serve(app, host="0.0.0.0", port=port, threads=8,
                            channel_timeout=600, connection_limit=200)
        except ImportError:
            print("[WARN] waitress not installed -- run: pip install waitress")
            print(f"  Falling back to Flask dev server on port {port}\n")
            app.run(host="0.0.0.0", port=port, debug=False)
    else:
        print(f"  NIRRP Python Backend (dev) -> http://localhost:{port}")
        app.run(host="0.0.0.0", port=port, debug=False)
