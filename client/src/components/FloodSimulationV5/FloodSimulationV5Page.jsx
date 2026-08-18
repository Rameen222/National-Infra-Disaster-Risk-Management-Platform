import React from 'react';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import { Link } from 'react-router-dom';
import {
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, ReferenceDot,
} from 'recharts';
import { MAP_CONFIG } from '../../config/mapConfig';
import './FloodSimulationV5Page.css';

// NEW, isolated page - reads only from flood-mardan-v5/ (its own data dir)
// plus two READ-ONLY references into the existing flood-mardan/ dir
// (kalpani.geojson, buildings-grid/) that are unrelated to which SFINCS
// run produced the flood layer. Nothing in flood-mardan/ or the existing
// FloodSimulationPage/FloodSimulation3DPage is modified by this file.
const DATA_BASE = '/data/flood-mardan-v5';
const LEGACY_DATA_BASE = '/data/flood-mardan'; // river + building geometry only
// Appended to the depth-frame PNG URLs so the browser (or any intermediate
// cache) can never keep serving a pre-regeneration copy at the same path -
// fixed per page load, not per request, so normal within-session caching
// still works.
const ASSET_VERSION = Date.now();

const rgba = ([r, g, b, a]) => `rgba(${r}, ${g}, ${b}, ${(a / 255).toFixed(2)})`;

mapboxgl.accessToken = MAP_CONFIG.accessToken;

const PRECIP_VALUES = [50, 100, 150, 200];
const SPEED_OPTIONS = [
  { label: '0.5×', ms: 900 },
  { label: '1×', ms: 450 },
  { label: '2×', ms: 220 },
  { label: '4×', ms: 100 },
];

// Building impact classification -> color, matches classify()/RH_BREAKS in
// scripts/v5_impact/04_aggregate_impact.py (dry/wet_shallow/partial/
// substantial/submerged/height_unreliable - Rh = floodDepth/height
// buckets). height_unreliable buildings render the same as dry and are
// excluded from the legend/counts on purpose - their height field can't
// be trusted, so no severity claim is shown for them at all rather than
// risk a fabricated-looking number.
const IMPACT_COLORS = {
  dry: '#3a4a5c',
  wet_shallow: '#8BC34A',
  partial: '#FFEB3B',
  substantial: '#FF9800',
  submerged: '#F44336',
  height_unreliable: '#3a4a5c',
};
// Plain-language labels for a non-technical audience - no "Rh" notation.
const IMPACT_ORDER = ['dry', 'wet_shallow', 'partial', 'substantial', 'submerged'];
const IMPACT_LABELS = {
  dry: 'No inundation',
  wet_shallow: 'Shallow inundation (<25%)',
  partial: 'Moderate inundation (25–75%)',
  substantial: 'Deep inundation (75–100%)',
  submerged: 'Fully submerged (100%+)',
};

// Shared by the map-click popup and the severity-browse popup so both ever
// show the same markup for the same underlying numbers.
function buildingPopupHtml(impactClass, height, floodDepth, heightRatio) {
  const unreliable = impactClass === 'height_unreliable';
  const heightHtml = unreliable
    ? '<span class="fsv5-popup-na">Not reliable</span>'
    : `${Number(height).toFixed(1)} m`;
  const ratioHtml = unreliable || heightRatio == null
    ? '<span class="fsv5-popup-na">Not available (height data unreliable)</span>'
    : `${Math.round(heightRatio * 100)}% of building height`;
  const label = unreliable ? 'Height data unreliable' : (IMPACT_LABELS[impactClass] || impactClass);
  const swatch = IMPACT_COLORS[impactClass] || IMPACT_COLORS.dry;
  return `
    <div class="fsv5-popup">
      <div class="fsv5-popup-title"><span class="fsv5-popup-dot" style="background:${swatch}"></span>${label}</div>
      <div class="fsv5-popup-row"><span>Building height</span><b>${heightHtml}</b></div>
      <div class="fsv5-popup-row"><span>Flood depth here</span><b>${Number(floodDepth).toFixed(2)} m</b></div>
      <div class="fsv5-popup-row"><span>Depth vs. height</span><b>${ratioHtml}</b></div>
    </div>
  `;
}

function cellKey(row, col) {
  return `${row}_${col}`;
}

export default function FloodSimulationV5Page() {
  const containerRef = React.useRef(null);
  const mapRef = React.useRef(null);
  const mapMoveEndHandlerRef = React.useRef(null); // so the mount-effect's cleanup can map.off() it
  const dashboardManifestRef = React.useRef(null);
  const impactManifestRef = React.useRef(null);
  const loadedImpactCellsRef = React.useRef(new Map()); // `${scenario}:${cellKey}` -> features[]
  const fetchingImpactRef = React.useRef(new Set());
  const playTimerRef = React.useRef(null);
  // `${scenario}` -> { wet_shallow: [{id,lon,lat,floodDepth,height,heightRatio}, ...], ... }
  // Lazily fetched per scenario (see startSeverityBrowse) - a small dedicated
  // index so "zoom through every Deep/Fully submerged building" doesn't
  // require fetching all ~960 chunks to find them.
  const severityIndexRef = React.useRef(new Map());
  const browseMarkerRef = React.useRef(null); // the pulsing highlight on the currently-browsed building
  const browsePopupRef = React.useRef(null); // its auto-opened info popup

  const [leftMinimized, setLeftMinimized] = React.useState(false);
  const [rightMinimized, setRightMinimized] = React.useState(false);
  const [layers, setLayers] = React.useState({
    watershed: true, terrain: true, hillshade: true, river: true, flood: true, buildings: true,
  });
  const [status, setStatus] = React.useState('Loading basemap…');
  const [zoomedIn, setZoomedIn] = React.useState(false);
  const [dashboardReady, setDashboardReady] = React.useState(false);

  const [precipitation, setPrecipitation] = React.useState(100);
  const [frameIdx, setFrameIdx] = React.useState(0);
  const [playing, setPlaying] = React.useState(false);
  const [speedMs, setSpeedMs] = React.useState(SPEED_OPTIONS[1].ms);

  const [buildingImpactSummary, setBuildingImpactSummary] = React.useState(null);
  const [buildingsLoading, setBuildingsLoading] = React.useState(false);
  const [buildingsExpanded, setBuildingsExpanded] = React.useState(true);

  // "Browse this severity class" state - set when a legend row is clicked.
  // browseList is the current scenario+class's severity-index entries;
  // browseIndex is which one the camera is currently on.
  const [browseClass, setBrowseClass] = React.useState(null);
  const [browseList, setBrowseList] = React.useState([]);
  const [browseIndex, setBrowseIndex] = React.useState(0);
  const [browseLoading, setBrowseLoading] = React.useState(false);

  const toggleLayer = (key) => setLayers((l) => ({ ...l, [key]: !l[key] }));

  const currentScenario = React.useCallback(() => {
    const manifest = dashboardManifestRef.current;
    if (!manifest) return null;
    return manifest.scenarios.find((s) => s.mm === precipitation) || null;
  }, [precipitation]);

  const atPeak = React.useCallback(() => {
    const scenario = currentScenario();
    return !!scenario && frameIdx === scenario.frames.length - 1;
  }, [currentScenario, frameIdx]);

  // Fetches building-impact cells (geometry + precomputed peak-time impact
  // stats, self-contained per scenario) intersecting the viewport, mirrors
  // FloodSimulationPage.jsx's refreshBuildingCells but keyed by scenario
  // too since impact stats are scenario-specific.
  //
  // Guarded against a real race: this fires on every 'moveend', and a
  // smooth zoom/drag gesture can fire several in quick succession. Each
  // call awaits its own fetches before rendering, so if an OLDER call's
  // fetches happen to resolve after a NEWER call already rendered, the
  // older one would overwrite the map with its own (now stale, wrong-
  // viewport) data - exactly the "colours vanish/revert after zooming"
  // symptom. refreshTokenRef makes each call check it's still the latest
  // before touching the map.
  const refreshTokenRef = React.useRef(0);
  const refreshBuildingCells = React.useCallback(async () => {
    const myToken = ++refreshTokenRef.current;
    const map = mapRef.current;
    const impactManifest = impactManifestRef.current;
    if (!map || !impactManifest) return;

    if (map.getZoom() < 11) {
      if (myToken !== refreshTokenRef.current) return;
      const source = map.getSource('fsv5-buildings');
      if (source) source.setData({ type: 'FeatureCollection', features: [] });
      setBuildingImpactSummary(null);
      return;
    }

    const scenKey = `${String(precipitation).padStart(3, '0')}mm`;
    const impactScenario = impactManifest.scenarios.find((s) => s.id === scenKey);
    if (!impactScenario) return;

    const b = map.getBounds();
    const pad = impactManifest.cellSize;
    const view = [b.getWest() - pad, b.getSouth() - pad, b.getEast() + pad, b.getNorth() + pad];

    // impact-v2's own chunk grid (0.015deg) - NOT the legacy buildings-grid
    // manifest's 0.05deg one. Those two grids don't correspond to the same
    // cells at all; using the wrong one here was requesting filenames that
    // don't exist in buildings-impact-v2, which is what actually caused the
    // 404s (an HTML error page failing JSON.parse, not a crash from load
    // size - the earlier chunk-size fix was real but didn't address this).
    // Cell bounds aren't stored per-entry, so they're derived from the
    // manifest's global bounds/cellSize + this cell's row/col.
    const [gMinLon, gMinLat] = impactManifest.bounds;
    const visible = impactScenario.cells.filter((c) => {
      const x0 = gMinLon + c.col * impactManifest.cellSize;
      const y0 = gMinLat + c.row * impactManifest.cellSize;
      const x1 = x0 + impactManifest.cellSize;
      const y1 = y0 + impactManifest.cellSize;
      return x0 < view[2] && x1 > view[0] && y0 < view[3] && y1 > view[1];
    });

    const toFetch = visible.filter((c) => {
      const key = `${scenKey}:${cellKey(c.row, c.col)}`;
      return !loadedImpactCellsRef.current.has(key) && !fetchingImpactRef.current.has(key);
    });

    if (toFetch.length > 0) {
      setBuildingsLoading(true);
      await Promise.all(toFetch.map(async (c) => {
        const key = `${scenKey}:${cellKey(c.row, c.col)}`;
        fetchingImpactRef.current.add(key);
        try {
          const res = await fetch(`${DATA_BASE}/buildings-impact-v2/${scenKey}/${c.file}`);
          const gj = await res.json();
          loadedImpactCellsRef.current.set(key, gj.features);
        } catch (err) {
          console.error('[flood-sim-v5] failed to load building-impact cell', key, err);
        } finally {
          fetchingImpactRef.current.delete(key);
        }
      }));
      if (myToken === refreshTokenRef.current) setBuildingsLoading(false);
    }

    // A newer call already landed while this one was fetching - drop this
    // one entirely instead of rendering stale data over it.
    if (myToken !== refreshTokenRef.current) return;

    const merged = [];
    for (const c of visible) {
      const feats = loadedImpactCellsRef.current.get(`${scenKey}:${cellKey(c.row, c.col)}`);
      // height_unreliable buildings aren't rendered at all - their height
      // can't be trusted, so there's no honest way to show a severity for
      // them, and showing them as "dry" would misrepresent buildings that
      // are actually wet.
      if (feats) merged.push(...feats.filter((f) => f.properties.impactClass !== 'height_unreliable'));
    }
    const source = map.getSource('fsv5-buildings');
    if (source) source.setData({ type: 'FeatureCollection', features: merged });

    // Evict anything no longer visible (including other scenarios' cached
    // cells) - each chunk still carries real weight even at the smaller
    // grid size, and letting this accumulate across every pan/zoom/
    // scenario-switch is how a session-long "buildings load then crash"
    // report happens - not any single fetch, just unbounded growth.
    const visibleKeys = new Set(visible.map((c) => `${scenKey}:${cellKey(c.row, c.col)}`));
    for (const key of loadedImpactCellsRef.current.keys()) {
      if (!visibleKeys.has(key)) loadedImpactCellsRef.current.delete(key);
    }

    const counts = Object.fromEntries(IMPACT_ORDER.map((k) => [k, 0]));
    merged.forEach((f) => { counts[f.properties.impactClass] = (counts[f.properties.impactClass] || 0) + 1; });
    setBuildingImpactSummary({ total: merged.length, counts });
  }, [precipitation]);

  // The map's 'moveend' listener (below) is attached exactly once, in the
  // mount-only map-init effect - it can't be re-attached every time
  // refreshBuildingCells changes (a new instance is created on every
  // precipitation change) without tearing down and rebuilding the whole
  // map. This ref lets that one-time listener always call the CURRENT
  // callback instead of staying bound to whatever scenario was active when
  // the map first loaded - without it, every pan/zoom/flyTo after
  // switching scenarios silently re-renders using the ORIGINAL scenario's
  // classification, which is exactly the "building color doesn't match the
  // popup" bug.
  const refreshBuildingCellsRef = React.useRef(refreshBuildingCells);
  React.useEffect(() => { refreshBuildingCellsRef.current = refreshBuildingCells; }, [refreshBuildingCells]);

  const scenarioKey = React.useCallback(() => `${String(precipitation).padStart(3, '0')}mm`, [precipitation]);

  // Flies the camera to `entry` and drops/moves a pulsing marker on it so
  // the one building being browsed is obvious among a cluster of others -
  // a plain flyTo with no highlight left it ambiguous which building was
  // "the" one when several sat close together.
  const flyToBrowseEntry = React.useCallback((entry, cls) => {
    const map = mapRef.current;
    if (!map) return;
    // No pitch override - keep whatever tilt the user already has. The
    // popup below is built from the index entry's own precomputed data,
    // not from querying whatever the user clicks, so it no longer matters
    // whether a tilted view makes screen-adjacent buildings ambiguous.
    map.flyTo({ center: [entry.lon, entry.lat], zoom: 18.5, duration: 900 });

    if (browseMarkerRef.current) browseMarkerRef.current.remove();
    const el = document.createElement('div');
    el.className = 'fsv5-browse-marker';
    el.style.setProperty('--marker-color', IMPACT_COLORS[cls] || IMPACT_COLORS.dry);
    browseMarkerRef.current = new mapboxgl.Marker({ element: el })
      .setLngLat([entry.lon, entry.lat])
      .addTo(map);

    // Auto-open the popup from the index entry's OWN precomputed numbers -
    // not from querying whatever the user clicks - so it can never disagree
    // with the navigator card next to it.
    if (browsePopupRef.current) browsePopupRef.current.remove();
    browsePopupRef.current = new mapboxgl.Popup({ closeButton: true, maxWidth: '230px', offset: 12 })
      .setLngLat([entry.lon, entry.lat])
      .setHTML(buildingPopupHtml(cls, entry.height, entry.floodDepth, entry.heightRatio))
      .addTo(map);
  }, []);

  // Click a legend row ("Deep inundation", etc.) to fly through every
  // building in that class for the current scenario, one at a time -
  // fetches the small severity_index.json for this scenario once (cached
  // per scenario in severityIndexRef) rather than every chunk.
  const startSeverityBrowse = React.useCallback(async (cls) => {
    if (browseClass === cls) { setBrowseClass(null); return; } // click active row again to close
    const scenKey = scenarioKey();
    let byClass = severityIndexRef.current.get(scenKey);
    if (!byClass) {
      setBrowseLoading(true);
      try {
        const res = await fetch(`${DATA_BASE}/buildings-impact-v2/${scenKey}/severity_index.json`);
        byClass = await res.json();
        severityIndexRef.current.set(scenKey, byClass);
      } catch (err) {
        console.error('[flood-sim-v5] failed to load severity index', scenKey, err);
        setBrowseLoading(false);
        return;
      }
      setBrowseLoading(false);
    }
    const list = byClass[cls] || [];
    if (list.length === 0) return;
    setBrowseClass(cls);
    setBrowseList(list);
    setBrowseIndex(0);
    flyToBrowseEntry(list[0], cls);
  }, [browseClass, scenarioKey, flyToBrowseEntry]);

  const browseStep = React.useCallback((delta) => {
    setBrowseIndex((i) => {
      if (browseList.length === 0) return i;
      const next = (i + delta + browseList.length) % browseList.length;
      flyToBrowseEntry(browseList[next], browseClass);
      return next;
    });
  }, [browseList, browseClass, flyToBrowseEntry]);

  // Switching scenarios invalidates the current browse - the class
  // distribution (and every building's depth/ratio) is scenario-specific.
  React.useEffect(() => {
    setBrowseClass(null);
  }, [precipitation]);

  // Remove the highlight marker whenever browsing stops (close button,
  // scenario change, or clicking the active row again).
  React.useEffect(() => {
    if (!browseClass) {
      if (browseMarkerRef.current) { browseMarkerRef.current.remove(); browseMarkerRef.current = null; }
      if (browsePopupRef.current) { browsePopupRef.current.remove(); browsePopupRef.current = null; }
    }
  }, [browseClass]);

  React.useEffect(() => {
    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: MAP_CONFIG.styles.satellite,
      center: MAP_CONFIG.defaultCenter,
      zoom: MAP_CONFIG.defaultZoom,
      pitch: 0,
      minZoom: MAP_CONFIG.minZoom,
      maxZoom: MAP_CONFIG.maxZoom,
    });
    mapRef.current = map;
    map.addControl(new mapboxgl.NavigationControl({ visualizePitch: true }), 'bottom-right');

    map.on('load', async () => {
      setStatus('Loading watershed boundary…');

      const [watershedGeoJSON, riverGeoJSON, dashboardManifest, impactManifest] = await Promise.all([
        fetch(`${DATA_BASE}/watershed.geojson`).then((r) => r.json()),
        fetch(`${LEGACY_DATA_BASE}/kalpani.geojson`).then((r) => r.json()),
        fetch(`${DATA_BASE}/dashboard/manifest.json`).then((r) => r.json()),
        fetch(`${DATA_BASE}/buildings-impact-v2/manifest.json`).then((r) => r.json()).catch(() => null),
      ]);
      dashboardManifestRef.current = dashboardManifest;
      impactManifestRef.current = impactManifest;

      // Watershed boundary - a real delineated catchment (2,254 km²), shown
      // as an actual visible layer (unlike the older pages, where the AOI
      // file was only ever used to compute the zoom target).
      map.addSource('fsv5-watershed', { type: 'geojson', data: watershedGeoJSON });
      map.addLayer({
        id: 'fsv5-watershed-fill',
        type: 'fill',
        source: 'fsv5-watershed',
        paint: { 'fill-color': '#F0B429', 'fill-opacity': 0.06 },
      });
      map.addLayer({
        id: 'fsv5-watershed-line',
        type: 'line',
        source: 'fsv5-watershed',
        paint: { 'line-color': '#F0B429', 'line-width': 2.5 },
      });

      // Terrain — real 30m Copernicus elevation, same earthy tint + relief-
      // shading treatment as the original 2D page, stacked dem -> hillshade
      // -> flood so the flood layer still reads clearly on top.
      map.addSource('fsv5-terrain-dem', {
        type: 'image',
        url: `${DATA_BASE}/dashboard/terrain_dem.png`,
        coordinates: dashboardManifest.corners,
      });
      map.addLayer({
        id: 'fsv5-terrain-dem-layer',
        type: 'raster',
        source: 'fsv5-terrain-dem',
        paint: { 'raster-opacity': 0.9 },
      });

      map.addSource('fsv5-terrain-hillshade', {
        type: 'image',
        url: `${DATA_BASE}/dashboard/terrain_hillshade.png`,
        coordinates: dashboardManifest.corners,
      });
      map.addLayer({
        id: 'fsv5-terrain-hillshade-layer',
        type: 'raster',
        source: 'fsv5-terrain-hillshade',
        paint: { 'raster-opacity': 0.5 },
      });

      const firstScenario = dashboardManifest.scenarios.find((s) => s.mm === 100) || dashboardManifest.scenarios[0];
      map.addSource('fsv5-depth-img', {
        type: 'image',
        url: `${DATA_BASE}/dashboard/${firstScenario.frames[0].file}?v=${ASSET_VERSION}`,
        coordinates: dashboardManifest.corners,
      });
      map.addLayer({
        id: 'fsv5-depth-layer',
        type: 'raster',
        source: 'fsv5-depth-img',
        // 'nearest' disables Mapbox's default bilinear texture filtering,
        // which otherwise blends neighboring pixels together on the GPU at
        // render time - a render-side blur completely separate from the
        // source PNG (already confirmed pixel-sharp) or the underlying grid
        // data (confirmed exact against every building's own classification,
        // zero mismatches checked). This is what was making the flood edge
        // look softened/extended on screen beyond the true 30m cell it's
        // actually built from.
        paint: { 'raster-opacity': 0.92, 'raster-fade-duration': 0, 'raster-resampling': 'nearest' },
      });
      setDashboardReady(true);

      map.addSource('fsv5-river', { type: 'geojson', data: riverGeoJSON });
      map.addLayer({
        id: 'fsv5-river-line',
        type: 'line',
        source: 'fsv5-river',
        paint: { 'line-color': '#38bdf8', 'line-width': 2.5, 'line-opacity': 0.9 },
      });

      map.addSource('fsv5-buildings', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addLayer({
        id: 'fsv5-buildings-fill',
        type: 'fill-extrusion',
        source: 'fsv5-buildings',
        minzoom: 11,
        paint: {
          'fill-extrusion-color': [
            'match', ['get', 'impactClass'],
            'dry', IMPACT_COLORS.dry,
            'wet_shallow', IMPACT_COLORS.wet_shallow,
            'partial', IMPACT_COLORS.partial,
            'substantial', IMPACT_COLORS.substantial,
            'submerged', IMPACT_COLORS.submerged,
            'height_unreliable', IMPACT_COLORS.height_unreliable,
            IMPACT_COLORS.dry,
          ],
          'fill-extrusion-height': ['max', ['coalesce', ['get', 'height'], 3], 3],
          'fill-extrusion-base': 0,
          'fill-extrusion-opacity': 0.9,
        },
      });

      map.on('mouseenter', 'fsv5-buildings-fill', () => { map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', 'fsv5-buildings-fill', () => { map.getCanvas().style.cursor = ''; });
      map.on('click', 'fsv5-buildings-fill', (e) => {
        const p = e.features[0]?.properties;
        if (!p) return;
        new mapboxgl.Popup({ closeButton: true, maxWidth: '230px', offset: 12 })
          .setLngLat(e.lngLat)
          .setHTML(buildingPopupHtml(p.impactClass, p.height, p.floodDepth, p.heightRatio))
          .addTo(map);
      });

      setStatus('Study area ready');

      window.setTimeout(() => {
        const ring = watershedGeoJSON.features[0]?.geometry?.coordinates?.[0];
        if (!ring) return;
        let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
        for (const [lon, lat] of ring) {
          if (lon < minx) minx = lon;
          if (lon > maxx) maxx = lon;
          if (lat < miny) miny = lat;
          if (lat > maxy) maxy = lat;
        }
        map.fitBounds([[minx, miny], [maxx, maxy]], {
          padding: 40, pitch: 55, bearing: -12, duration: 2200, essential: true,
        });
        setZoomedIn(true);
      }, 1000);

      // Always call the LATEST refreshBuildingCells (via the ref), not the
      // one captured when this mount-only effect ran - see
      // refreshBuildingCellsRef's comment for why that distinction matters.
      const handleMoveEnd = () => refreshBuildingCellsRef.current();
      map.on('moveend', handleMoveEnd);
      window.setTimeout(handleMoveEnd, 3400);

      mapMoveEndHandlerRef.current = handleMoveEnd;
    });

    return () => {
      if (mapMoveEndHandlerRef.current) map.off('moveend', mapMoveEndHandlerRef.current);
      map.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Push the current scenario/frame's PNG onto the flood image source.
  React.useEffect(() => {
    if (!dashboardReady) return;
    const map = mapRef.current;
    const source = map?.getSource('fsv5-depth-img');
    const scenario = currentScenario();
    if (!map || !source || !scenario) return;
    const frame = scenario.frames[frameIdx] || scenario.frames[scenario.frames.length - 1];
    source.updateImage({ url: `${DATA_BASE}/dashboard/${frame.file}?v=${ASSET_VERSION}` });
  }, [dashboardReady, precipitation, frameIdx, currentScenario]);

  // Re-fetch building-impact cells whenever the selected scenario changes
  // (impact stats are scenario-specific, unlike geometry).
  React.useEffect(() => {
    refreshBuildingCells();
  }, [precipitation, refreshBuildingCells]);

  // Plays t=0 -> peak once, then holds - never starts on its own.
  React.useEffect(() => {
    if (!playing) { clearInterval(playTimerRef.current); return; }
    playTimerRef.current = setInterval(() => {
      setFrameIdx((i) => {
        const scenario = currentScenario();
        const last = (scenario?.frames.length || 1) - 1;
        if (i >= last) { setPlaying(false); return last; }
        return i + 1;
      });
    }, speedMs);
    return () => clearInterval(playTimerRef.current);
  }, [playing, speedMs, currentScenario]);

  const selectPrecipitation = (mm) => {
    setPrecipitation(mm);
    setFrameIdx(0);
    setPlaying(false);
  };

  React.useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = () => {
      ['fsv5-watershed-fill', 'fsv5-watershed-line'].forEach((id) => {
        if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', layers.watershed ? 'visible' : 'none');
      });
      if (map.getLayer('fsv5-terrain-dem-layer')) {
        map.setLayoutProperty('fsv5-terrain-dem-layer', 'visibility', layers.terrain ? 'visible' : 'none');
      }
      if (map.getLayer('fsv5-terrain-hillshade-layer')) {
        map.setLayoutProperty('fsv5-terrain-hillshade-layer', 'visibility', layers.hillshade ? 'visible' : 'none');
      }
      if (map.getLayer('fsv5-river-line')) {
        map.setLayoutProperty('fsv5-river-line', 'visibility', layers.river ? 'visible' : 'none');
      }
      if (map.getLayer('fsv5-depth-layer')) {
        map.setLayoutProperty('fsv5-depth-layer', 'visibility', layers.flood ? 'visible' : 'none');
      }
      if (map.getLayer('fsv5-buildings-fill')) {
        map.setLayoutProperty('fsv5-buildings-fill', 'visibility', layers.buildings ? 'visible' : 'none');
      }
    };
    if (map.isStyleLoaded()) apply(); else map.once('load', apply);
  }, [layers]);

  const scenario = currentScenario();

  return (
    <div className="fsv5-page">
      <div ref={containerRef} className="fsv5-map" />

      <div className={`fsv5-sidebar fsv5-sidebar--left${leftMinimized ? ' fsv5-sidebar--minimized' : ''}`}>
        <div className="fsv5-sidebar-header">
          {!leftMinimized && <span className="fsv5-sidebar-title">Study Area (v5)</span>}
          <button className="fsv5-sidebar-toggle" onClick={() => setLeftMinimized((v) => !v)}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
              {leftMinimized
                ? <path d="M9 5l7 7-7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                : <path d="M15 5l-7 7 7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />}
            </svg>
          </button>
        </div>

        {!leftMinimized && (
          <div className="fsv5-sidebar-body">
            <div className="fsv5-status">
              <span className={`fsv5-status-dot${zoomedIn ? ' fsv5-status-dot--ready' : ''}`} />
              {zoomedIn ? 'Study area in view' : status}
            </div>

            <div className="fsv5-sidebar-section">
              <div className="fsv5-sidebar-section-title">Layers</div>
              <label className="fsv5-layer-row">
                <input type="checkbox" checked={layers.watershed} onChange={() => toggleLayer('watershed')} />
                <span className="fsv5-layer-swatch" style={{ background: '#F0B429' }} />
                Watershed boundary
              </label>
              <label className="fsv5-layer-row">
                <input type="checkbox" checked={layers.terrain} onChange={() => toggleLayer('terrain')} />
                <span className="fsv5-layer-swatch" style={{ background: '#8a9a5b' }} />
                DEM colour
              </label>
              <label className="fsv5-layer-row">
                <input type="checkbox" checked={layers.hillshade} onChange={() => toggleLayer('hillshade')} />
                <span className="fsv5-layer-swatch" style={{ background: '#9aa0a6' }} />
                Hillshade
              </label>
              <label className="fsv5-layer-row">
                <input type="checkbox" checked={layers.flood} onChange={() => toggleLayer('flood')} />
                <span className="fsv5-layer-swatch" style={{ background: '#2166a8' }} />
                Flood depth
              </label>
              <label className="fsv5-layer-row">
                <input type="checkbox" checked={layers.river} onChange={() => toggleLayer('river')} />
                <span className="fsv5-layer-swatch" style={{ background: '#38bdf8' }} />
                Kalpani River
              </label>
            </div>

            <div className="fsv5-sidebar-section fsv5-buildings-section">
              <div className="fsv5-sidebar-section-title fsv5-buildings-header">
                <label className="fsv5-layer-row" onClick={(e) => e.stopPropagation()}>
                  <input type="checkbox" checked={layers.buildings} onChange={() => toggleLayer('buildings')} />
                  <span className="fsv5-layer-swatch" style={{ background: '#8BC34A' }} />
                  Buildings
                  {buildingsLoading && <span className="fsv5-mini-spinner" />}
                </label>
                <button
                  className="fsv5-sidebar-toggle"
                  onClick={() => setBuildingsExpanded((v) => !v)}
                  title={buildingsExpanded ? 'Collapse' : 'Expand'}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
                    {buildingsExpanded
                      ? <path d="M6 15l6-6 6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                      : <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />}
                  </svg>
                </button>
              </div>

              {buildingsExpanded && (
                <>
                  <div className="fsv5-sidebar-section-title">
                    Buildings in view
                    <span className="fsv5-sidebar-section-count">{(buildingImpactSummary?.total ?? 0).toLocaleString()}</span>
                  </div>
                  {buildingImpactSummary && buildingImpactSummary.total > 0 && (
                    <div className="fsv5-impact-bar">
                      {IMPACT_ORDER.map((cls) => {
                        const pct = (buildingImpactSummary.counts[cls] || 0) / buildingImpactSummary.total * 100;
                        return pct > 0 ? (
                          <div key={cls} className="fsv5-impact-bar-seg" style={{ width: `${pct}%`, background: IMPACT_COLORS[cls] }} />
                        ) : null;
                      })}
                    </div>
                  )}
                  <div className="fsv5-legend">
                    {IMPACT_ORDER.map((cls) => {
                      const count = buildingImpactSummary?.counts[cls] ?? 0;
                      if (cls === 'dry') {
                        // Not browsable - there's no severity-index entry for
                        // "dry" (it's the vast majority of buildings, and
                        // there's nothing severity-specific to zoom through).
                        return (
                          <div key={cls} className="fsv5-legend-row">
                            <span className="fsv5-legend-swatch" style={{ background: IMPACT_COLORS[cls] }} />
                            {IMPACT_LABELS[cls]}
                            <b>{count.toLocaleString()}</b>
                          </div>
                        );
                      }
                      const scen = impactManifestRef.current?.scenarios.find((s) => s.id === scenarioKey());
                      const globalCount = scen?.classDistribution?.[cls] ?? 0;
                      const isActive = browseClass === cls;
                      return (
                        <button
                          key={cls}
                          className={`fsv5-legend-row fsv5-legend-row--clickable${isActive ? ' fsv5-legend-row--active' : ''}${globalCount === 0 ? ' fsv5-legend-row--disabled' : ''}`}
                          onClick={() => startSeverityBrowse(cls)}
                          disabled={globalCount === 0}
                          title={globalCount === 0 ? 'No buildings in this category for this scenario' : `Zoom through all ${globalCount.toLocaleString()} buildings in this category`}
                        >
                          <span className="fsv5-legend-swatch" style={{ background: IMPACT_COLORS[cls] }} />
                          {IMPACT_LABELS[cls]}
                          <b>{count.toLocaleString()}</b>
                        </button>
                      );
                    })}
                  </div>
                  {browseClass && (
                    <div className="fsv5-severity-nav">
                      <div className="fsv5-severity-nav-top">
                        <span className="fsv5-severity-nav-dot" style={{ background: IMPACT_COLORS[browseClass] }} />
                        <span>{IMPACT_LABELS[browseClass]}</span>
                        <button className="fsv5-severity-nav-close" onClick={() => setBrowseClass(null)} title="Stop browsing">×</button>
                      </div>
                      <div className="fsv5-severity-nav-controls">
                        <button onClick={() => browseStep(-1)} disabled={browseList.length < 2} title="Previous">◀</button>
                        <span className="fsv5-severity-nav-count">
                          {browseLoading ? 'Loading…' : `Building ${browseIndex + 1} of ${browseList.length} (whole watershed)`}
                        </span>
                        <button onClick={() => browseStep(1)} disabled={browseList.length < 2} title="Next">▶</button>
                      </div>
                      {browseList[browseIndex] && (
                        <div className="fsv5-severity-nav-stat">
                          {browseList[browseIndex].height.toFixed(1)} m building ·{' '}
                          {browseList[browseIndex].floodDepth.toFixed(2)} m depth
                          {browseList[browseIndex].heightRatio != null && ` · ${Math.round(browseList[browseIndex].heightRatio * 100)}%`}
                        </div>
                      )}
                    </div>
                  )}
                  <div className="fsv5-sidebar-hint">
                    Impact classification is computed at each scenario's PEAK depth
                    only (exact building-footprint/flood-cell intersection, area-
                    weighted) - it does not change as you scrub the animation below.
                    Buildings with unreliable height data aren't shown - their
                    flood severity can't be honestly calculated. Click a building
                    on the map for its details, or click a category above to zoom
                    through every building in it.
                  </div>
                </>
              )}
            </div>

            <div className="fsv5-sidebar-hint">
              Real 30m Copernicus DEM, real delineated watershed (2,254 km²).
              Animation runs t=0 → peak depth only for each scenario - no
              recession is shown.
            </div>
            <Link to="/flood-simulation" className="fsv5-sidebar-hint" style={{ color: 'var(--primary)', fontStyle: 'normal', fontWeight: 600 }}>
              ← Back to original 2D version
            </Link>
          </div>
        )}
      </div>

      <div className={`fsv5-sidebar fsv5-sidebar--right${rightMinimized ? ' fsv5-sidebar--minimized' : ''}`}>
        <div className="fsv5-sidebar-header">
          {!rightMinimized && <span className="fsv5-sidebar-title">Flood Scenario</span>}
          <button className="fsv5-sidebar-toggle" onClick={() => setRightMinimized((v) => !v)}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
              {rightMinimized
                ? <path d="M9 5l7 7-7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                : <path d="M15 5l-7 7 7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />}
            </svg>
          </button>
        </div>

        {!rightMinimized && (
          <div className="fsv5-sidebar-body">
            {dashboardReady && scenario && (
              <div className="fsv5-sidebar-section">
                <div className="fsv5-sidebar-section-title">
                  Precipitation scenario
                  <span className="fsv5-sidebar-section-count">{precipitation}mm / 1h</span>
                </div>

                <input
                  type="range"
                  className="fsv5-precip-slider"
                  min={0} max={PRECIP_VALUES.length - 1} step={1}
                  value={PRECIP_VALUES.indexOf(precipitation)}
                  onChange={(e) => selectPrecipitation(PRECIP_VALUES[Number(e.target.value)])}
                />
                <div className="fsv5-precip-ticks">
                  {PRECIP_VALUES.map((v) => (
                    <span key={v} className={v === precipitation ? 'fsv5-precip-tick--active' : ''}>{v}</span>
                  ))}
                </div>

                <div className="fsv5-precip-controls">
                  <button className="fsv5-precip-btn" onClick={() => setPlaying((p) => !p)}>
                    {playing ? 'Pause' : 'Play'}
                  </button>
                  <button className="fsv5-precip-btn" onClick={() => { setFrameIdx(0); setPlaying(true); }}>
                    Replay
                  </button>
                  <button className="fsv5-precip-btn" onClick={() => { setPlaying(false); setFrameIdx(scenario.frames.length - 1); }}>
                    Jump to peak
                  </button>
                </div>

                <div className="fsv5-speed-row">
                  <span className="fsv5-speed-label">Speed</span>
                  {SPEED_OPTIONS.map((opt) => (
                    <button
                      key={opt.label}
                      className={`fsv5-speed-btn${speedMs === opt.ms ? ' fsv5-speed-btn--active' : ''}`}
                      onClick={() => setSpeedMs(opt.ms)}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>

                <div className="fsv5-precip-meta">
                  <span>Peak depth: {scenario.peakDepth.toFixed(2)} m</span>
                  <span>Peak velocity: {scenario.peakVelocity.toFixed(2)} m/s</span>
                </div>
                <div className="fsv5-precip-meta">
                  <span>Flooded area: {scenario.peakFloodedAreaKm2.toFixed(1)} km²</span>
                  <span>Volume: {scenario.peakVolumeMm3.toFixed(1)} Mm³</span>
                </div>

                <div className="fsv5-precip-readout">
                  <span>
                    T+{scenario.frames[frameIdx]?.elapsedHours ?? 0}h of {scenario.timeToPeakDepthH}h
                    {atPeak() && <span className="fsv5-at-peak"> · AT PEAK</span>}
                  </span>
                  <span>Depth now: {(scenario.frames[frameIdx]?.maxDepth ?? 0).toFixed(2)} m</span>
                </div>

                <div className="fsv5-hydrograph">
                  <ResponsiveContainer width="100%" height={90}>
                    <AreaChart data={scenario.frames} margin={{ top: 6, right: 6, bottom: 0, left: -28 }}>
                      <XAxis
                        dataKey="elapsedHours"
                        tick={{ fill: 'var(--text-dim)', fontSize: 10 }}
                        tickFormatter={(v) => `${v}h`}
                        axisLine={{ stroke: 'rgba(255,255,255,0.12)' }}
                        tickLine={false}
                      />
                      <YAxis tick={{ fill: 'var(--text-dim)', fontSize: 10 }} width={34} axisLine={false} tickLine={false} />
                      <Tooltip
                        formatter={(v) => [`${v.toFixed(2)} m`, 'Depth']}
                        labelFormatter={(v) => `T+${v}h`}
                        contentStyle={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-accent)', borderRadius: 6, fontSize: 11 }}
                      />
                      <Area
                        type="monotone" dataKey="maxDepth" stroke="#42A5F5" fill="rgba(66, 165, 245, 0.25)"
                        strokeWidth={1.5} isAnimationActive={false}
                      />
                      <ReferenceDot
                        x={scenario.frames[frameIdx]?.elapsedHours}
                        y={scenario.frames[frameIdx]?.maxDepth}
                        r={4} fill="#F0B429" stroke="#0E1B29" strokeWidth={1.5} isFront
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>

                {scenario.note && <div className="fsv5-sidebar-hint">{scenario.note}</div>}
              </div>
            )}

            {dashboardReady && layers.flood && (
              <div className="fsv5-sidebar-section">
                <div className="fsv5-sidebar-section-title">Flood depth</div>
                <div className="fsv5-legend">
                  {dashboardManifestRef.current?.depthStops.map((s, i) => (
                    <div key={s.depth} className="fsv5-legend-row">
                      <span className="fsv5-legend-swatch" style={{ background: rgba(s.rgba) }} />
                      {i === 0 ? `< ${s.depth} m` : `${dashboardManifestRef.current.depthStops[i - 1].depth}–${s.depth} m`}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
