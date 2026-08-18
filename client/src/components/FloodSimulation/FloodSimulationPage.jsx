import React from 'react';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import { Link } from 'react-router-dom';
import {
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, ReferenceDot,
  PieChart, Pie, Cell,
} from 'recharts';
import { MAP_CONFIG } from '../../config/mapConfig';
import './FloodSimulationPage.css';

const rgba = ([r, g, b, a]) => `rgba(${r}, ${g}, ${b}, ${(a / 255).toFixed(2)})`;

mapboxgl.accessToken = MAP_CONFIG.accessToken;

const DATA_BASE = '/data/flood-mardan';
const STUDY_AREA_NAME = 'Mardan';

// Same height-based color scheme as the dashboard's own 3D buildings layer
// (see BUILDING_HEIGHT_COLORS in MapContainer.jsx) — kept identical so a
// building reads the same color here as it would on the main map.
const HEIGHT_STOPS = [
  { height: 0, color: '#2196F3', label: '0–3 m' },
  { height: 3, color: '#4CAF50', label: '3–6 m' },
  { height: 6, color: '#FFEB3B', label: '6–10 m' },
  { height: 10, color: '#FF9800', label: '10–15 m' },
  { height: 15, color: '#F44336', label: '15–25 m' },
  { height: 25, color: '#9C27B0', label: '25+ m' },
];

function cellKey(row, col) {
  return `${row}_${col}`;
}

// Manifest lists LULC classes most-to-least area: Cropland, Forest,
// Grassland, Shrubland, Built-up, Bare, Water, Unclassified.
const LULC_COLORS = ['#D4A657', '#2E7D32', '#8BC34A', '#AFB42B', '#78909C', '#BCAAA4', '#4FC3F7', '#B0BEC5'];

const PRECIP_VALUES = [50, 100, 150, 200];
// User-selectable playback speeds — ms between frames, slower = bigger number.
const SPEED_OPTIONS = [
  { label: '0.5×', ms: 900 },
  { label: '1×', ms: 450 },
  { label: '2×', ms: 220 },
  { label: '4×', ms: 100 },
];

export default function FloodSimulationPage() {
  const containerRef = React.useRef(null);
  const mapRef = React.useRef(null);
  const manifestRef = React.useRef(null);
  const loadedCellsRef = React.useRef(new Map()); // cellKey -> features[]
  const fetchingRef = React.useRef(new Set());
  const sfincsManifestRef = React.useRef(null);
  const playTimerRef = React.useRef(null);

  const [leftMinimized, setLeftMinimized] = React.useState(false);
  const [rightMinimized, setRightMinimized] = React.useState(false);
  const [layers, setLayers] = React.useState({
    districts: true, river: true, buildings: true, terrain: true, hillshade: true, lulc: false, flood: true,
  });
  const [buildingCount, setBuildingCount] = React.useState(0);
  const [buildingsLoading, setBuildingsLoading] = React.useState(false);
  const [status, setStatus] = React.useState('Loading basemap…');
  const [zoomedIn, setZoomedIn] = React.useState(false);

  const [precipitation, setPrecipitation] = React.useState(100);
  const [frameIdx, setFrameIdx] = React.useState(0);
  const [playing, setPlaying] = React.useState(false);
  const [speedMs, setSpeedMs] = React.useState(SPEED_OPTIONS[1].ms);
  const [sfincsReady, setSfincsReady] = React.useState(false);

  const toggleLayer = (key) => setLayers((l) => ({ ...l, [key]: !l[key] }));

  const currentScenario = React.useCallback(() => {
    const manifest = sfincsManifestRef.current;
    if (!manifest) return null;
    return manifest.scenarios.find((s) => s.mm === precipitation) || null;
  }, [precipitation]);

  // Fetches any building grid cells intersecting the current viewport that
  // haven't been fetched yet, then rebuilds the source data from only the
  // cells currently relevant (bounded memory — old off-screen cells drop
  // out instead of accumulating forever across a big pan session).
  const refreshBuildingCells = React.useCallback(async () => {
    const map = mapRef.current;
    const manifest = manifestRef.current;
    if (!map || !manifest) return;

    // Buildings only render above the fill-extrusion layer's minzoom (11) —
    // skip fetching cell data at lower zooms too, since it would just be
    // downloaded and thrown away unseen (e.g. while the map is still wide
    // on the establishing shot before the 2-second zoom-in fires).
    if (map.getZoom() < 11) {
      const source = map.getSource('flood-buildings');
      if (source) source.setData({ type: 'FeatureCollection', features: [] });
      setBuildingCount(0);
      return;
    }

    const b = map.getBounds();
    const pad = manifest.cellSize; // one cell of buffer around the viewport
    const view = [b.getWest() - pad, b.getSouth() - pad, b.getEast() + pad, b.getNorth() + pad];

    const visible = manifest.cells.filter((c) => {
      const [x0, y0, x1, y1] = c.bounds;
      return x0 < view[2] && x1 > view[0] && y0 < view[3] && y1 > view[1];
    });

    const toFetch = visible.filter((c) => {
      const key = cellKey(c.row, c.col);
      return !loadedCellsRef.current.has(key) && !fetchingRef.current.has(key);
    });

    if (toFetch.length > 0) {
      setBuildingsLoading(true);
      await Promise.all(toFetch.map(async (c) => {
        const key = cellKey(c.row, c.col);
        fetchingRef.current.add(key);
        try {
          const res = await fetch(`${DATA_BASE}/buildings-grid/${c.file}`);
          const gj = await res.json();
          loadedCellsRef.current.set(key, gj.features);
        } catch (err) {
          console.error('[flood-sim] failed to load building cell', key, err);
        } finally {
          fetchingRef.current.delete(key);
        }
      }));
      setBuildingsLoading(false);
    }

    const merged = [];
    for (const c of visible) {
      const feats = loadedCellsRef.current.get(cellKey(c.row, c.col));
      if (feats) merged.push(...feats);
    }
    const source = map.getSource('flood-buildings');
    if (source) source.setData({ type: 'FeatureCollection', features: merged });
    setBuildingCount(merged.length);
  }, []);

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
      setStatus('Loading district boundaries…');

      const [districtsGeoJSON, riverGeoJSON, aoiGeoJSON, sfincsManifest] = await Promise.all([
        fetch(`${DATA_BASE}/districts_context.geojson`).then((r) => r.json()),
        fetch(`${DATA_BASE}/kalpani.geojson`).then((r) => r.json()),
        fetch(`${DATA_BASE}/aoi.geojson`).then((r) => r.json()),
        fetch(`${DATA_BASE}/sfincs/manifest.json`).then((r) => r.json()),
      ]);
      sfincsManifestRef.current = sfincsManifest;

      // District context — boundary fill/line only here; the name label is
      // added again at the very end of this function so it stays legible
      // on top of the terrain/flood layers instead of sitting under them.
      map.addSource('flood-districts', { type: 'geojson', data: districtsGeoJSON });
      map.addLayer({
        id: 'flood-districts-fill',
        type: 'fill',
        source: 'flood-districts',
        paint: {
          'fill-color': ['case', ['==', ['get', 'name'], STUDY_AREA_NAME], '#F0B429', '#ffffff'],
          'fill-opacity': ['case', ['==', ['get', 'name'], STUDY_AREA_NAME], 0.08, 0.02],
        },
      });
      map.addLayer({
        id: 'flood-districts-line',
        type: 'line',
        source: 'flood-districts',
        paint: {
          'line-color': ['case', ['==', ['get', 'name'], STUDY_AREA_NAME], '#F0B429', 'rgba(255,255,255,0.55)'],
          'line-width': ['case', ['==', ['get', 'name'], STUDY_AREA_NAME], 2.5, 1],
        },
      });

      // ── Requested stacking order: dem-colour, hillshade, flood, river, buildings ──
      map.addSource('flood-terrain-dem', {
        type: 'image',
        url: `${DATA_BASE}/sfincs/terrain_dem.png`,
        coordinates: sfincsManifest.corners,
      });
      map.addLayer({
        id: 'flood-terrain-dem-layer',
        type: 'raster',
        // Bumped from 0.55 — at that opacity the satellite imagery's own
        // texture (roads, field boundaries) showed through and competed
        // visually with the flood layer. A near-opaque flat terrain tint
        // recedes into the background instead.
        source: 'flood-terrain-dem',
        paint: { 'raster-opacity': 0.9 },
      });

      map.addSource('flood-terrain-hillshade', {
        type: 'image',
        url: `${DATA_BASE}/sfincs/terrain_hillshade.png`,
        coordinates: sfincsManifest.corners,
      });
      map.addLayer({
        id: 'flood-terrain-hillshade-layer',
        type: 'raster',
        // Toned down from 0.9 — full-strength relief shading was adding as
        // much visual noise as the satellite texture it replaced.
        source: 'flood-terrain-hillshade',
        paint: { 'raster-opacity': 0.5 },
      });

      if (sfincsManifest.lulcLayer) {
        map.addSource('flood-lulc', {
          type: 'image',
          url: `${DATA_BASE}/sfincs/${sfincsManifest.lulcLayer.file}`,
          coordinates: sfincsManifest.lulcLayer.corners,
        });
        map.addLayer({
          id: 'flood-lulc-layer',
          type: 'raster',
          source: 'flood-lulc',
          paint: { 'raster-opacity': 0.65 },
        });
      }

      const firstScenario = sfincsManifest.scenarios.find((s) => s.mm === 100) || sfincsManifest.scenarios[0];
      map.addSource('flood-depth-img', {
        type: 'image',
        url: `${DATA_BASE}/sfincs/${firstScenario.frames[0].file}`,
        coordinates: sfincsManifest.corners,
      });
      map.addLayer({
        id: 'flood-depth-layer',
        type: 'raster',
        source: 'flood-depth-img',
        paint: { 'raster-opacity': 0.92, 'raster-fade-duration': 0 },
      });
      setSfincsReady(true);

      map.addSource('flood-river', { type: 'geojson', data: riverGeoJSON });
      map.addLayer({
        id: 'flood-river-line',
        type: 'line',
        source: 'flood-river',
        paint: { 'line-color': '#38bdf8', 'line-width': 2.5, 'line-opacity': 0.9 },
      });

      map.addSource('flood-buildings', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addLayer({
        id: 'flood-buildings-3d',
        type: 'fill-extrusion',
        source: 'flood-buildings',
        minzoom: 11,
        paint: {
          // 'step', not 'interpolate' — matches buildColorExpr() in
          // MapContainer.jsx exactly, so a building is the same color here
          // as it would be on the main map.
          'fill-extrusion-color': [
            'step', ['coalesce', ['get', 'height'], 0],
            HEIGHT_STOPS[0].color,
            HEIGHT_STOPS[1].height, HEIGHT_STOPS[1].color,
            HEIGHT_STOPS[2].height, HEIGHT_STOPS[2].color,
            HEIGHT_STOPS[3].height, HEIGHT_STOPS[3].color,
            HEIGHT_STOPS[4].height, HEIGHT_STOPS[4].color,
            HEIGHT_STOPS[5].height, HEIGHT_STOPS[5].color,
          ],
          'fill-extrusion-height': ['get', 'height'],
          'fill-extrusion-base': 0,
          'fill-extrusion-opacity': 0.88,
        },
      });

      // District name label — added last so it renders on top of the
      // terrain/flood/building layers instead of underneath them.
      map.addLayer({
        id: 'flood-districts-label',
        type: 'symbol',
        source: 'flood-districts',
        layout: {
          'text-field': ['get', 'name'],
          'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'],
          'text-size': ['case', ['==', ['get', 'name'], STUDY_AREA_NAME], 16, 12],
        },
        paint: {
          'text-color': ['case', ['==', ['get', 'name'], STUDY_AREA_NAME], '#F0B429', '#ffffff'],
          'text-halo-color': 'rgba(6,10,19,0.85)',
          'text-halo-width': 1.4,
        },
      });

      setStatus('Study area ready');

      // Establishing shot first, then the cinematic zoom into the study
      // area 1 second later.
      window.setTimeout(() => {
        const bboxStr = aoiGeoJSON.features[0]?.properties?.bbox;
        if (!bboxStr) return;
        const [minx, miny, maxx, maxy] = bboxStr.split(',').map(Number);
        map.fitBounds([[minx, miny], [maxx, maxy]], {
          padding: 40,
          pitch: 55,
          bearing: -12,
          duration: 2200,
          essential: true,
        });
        setZoomedIn(true);
      }, 1000);

      const manifestRes = await fetch(`${DATA_BASE}/buildings-grid/manifest.json`);
      manifestRef.current = await manifestRes.json();

      map.on('moveend', refreshBuildingCells);
      // First pass once the fly-to settles near the study area.
      window.setTimeout(refreshBuildingCells, 3400);
    });

    return () => {
      map.off('moveend', refreshBuildingCells);
      map.remove();
    };
  }, [refreshBuildingCells]);

  // Push the current scenario/frame's PNG onto the flood image source. The
  // real SFINCS timesteps already encode exactly the progression that was
  // asked for — depth first appearing where runoff generates on the upper
  // slopes, then accumulating in the low-lying plain near the river as the
  // storm goes on — so playing through them in order needs no extra logic.
  React.useEffect(() => {
    if (!sfincsReady) return;
    const map = mapRef.current;
    const source = map?.getSource('flood-depth-img');
    const scenario = currentScenario();
    if (!map || !source || !scenario) return;
    const frame = scenario.frames[frameIdx] || scenario.frames[scenario.frames.length - 1];
    source.updateImage({ url: `${DATA_BASE}/sfincs/${frame.file}` });
  }, [sfincsReady, precipitation, frameIdx, currentScenario]);

  // Plays through the selected scenario's frames once (at the user-chosen
  // speed), then holds on the settled final frame. Never starts on its
  // own — the user presses Play.
  React.useEffect(() => {
    if (!playing) {
      clearInterval(playTimerRef.current);
      return;
    }
    playTimerRef.current = setInterval(() => {
      setFrameIdx((i) => {
        const scenario = currentScenario();
        const last = (scenario?.frames.length || 1) - 1;
        if (i >= last) {
          setPlaying(false);
          return last;
        }
        return i + 1;
      });
    }, speedMs);
    return () => clearInterval(playTimerRef.current);
  }, [playing, speedMs, currentScenario]);

  // Picking a new precipitation value resets to the start of that
  // scenario's progression, but doesn't auto-play it — the user presses
  // Play or Replay when they're ready to watch it.
  const selectPrecipitation = (mm) => {
    setPrecipitation(mm);
    setFrameIdx(0);
    setPlaying(false);
  };

  // Layer visibility toggles
  React.useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = () => {
      ['flood-districts-fill', 'flood-districts-line', 'flood-districts-label'].forEach((id) => {
        if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', layers.districts ? 'visible' : 'none');
      });
      if (map.getLayer('flood-river-line')) {
        map.setLayoutProperty('flood-river-line', 'visibility', layers.river ? 'visible' : 'none');
      }
      if (map.getLayer('flood-buildings-3d')) {
        map.setLayoutProperty('flood-buildings-3d', 'visibility', layers.buildings ? 'visible' : 'none');
      }
      if (map.getLayer('flood-terrain-dem-layer')) {
        map.setLayoutProperty('flood-terrain-dem-layer', 'visibility', layers.terrain ? 'visible' : 'none');
      }
      if (map.getLayer('flood-terrain-hillshade-layer')) {
        map.setLayoutProperty('flood-terrain-hillshade-layer', 'visibility', layers.hillshade ? 'visible' : 'none');
      }
      if (map.getLayer('flood-lulc-layer')) {
        map.setLayoutProperty('flood-lulc-layer', 'visibility', layers.lulc ? 'visible' : 'none');
      }
      if (map.getLayer('flood-depth-layer')) {
        map.setLayoutProperty('flood-depth-layer', 'visibility', layers.flood ? 'visible' : 'none');
      }
    };
    if (map.isStyleLoaded()) apply(); else map.once('load', apply);
  }, [layers]);

  return (
    <div className="fs-page">
      <div ref={containerRef} className="fs-map" />

      {/* ── Left floating sidebar: general study-area context (layers, ──
          buildings, land cover, soil) — not flood-scenario-specific. */}
      <div className={`fs-sidebar fs-sidebar--left${leftMinimized ? ' fs-sidebar--minimized' : ''}`}>
        <div className="fs-sidebar-header">
          {!leftMinimized && <span className="fs-sidebar-title">Study Area</span>}
          <button
            className="fs-sidebar-toggle"
            onClick={() => setLeftMinimized((v) => !v)}
            title={leftMinimized ? 'Expand panel' : 'Minimize panel'}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
              {leftMinimized ? (
                <path d="M9 5l7 7-7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              ) : (
                <path d="M15 5l-7 7 7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              )}
            </svg>
          </button>
        </div>

        {!leftMinimized && (
          <div className="fs-sidebar-body">
            <div className="fs-status">
              <span className={`fs-status-dot${zoomedIn ? ' fs-status-dot--ready' : ''}`} />
              {zoomedIn ? 'Study area in view' : status}
            </div>

            <div className="fs-sidebar-section">
              <div className="fs-sidebar-section-title">Layers</div>

              <label className="fs-layer-row">
                <input type="checkbox" checked={layers.terrain} onChange={() => toggleLayer('terrain')} />
                <span className="fs-layer-swatch" style={{ background: '#8a9a5b' }} />
                DEM colour
              </label>

              <label className="fs-layer-row">
                <input type="checkbox" checked={layers.hillshade} onChange={() => toggleLayer('hillshade')} />
                <span className="fs-layer-swatch" style={{ background: '#9aa0a6' }} />
                Hillshade
              </label>

              <label className="fs-layer-row">
                <input type="checkbox" checked={layers.lulc} onChange={() => toggleLayer('lulc')} />
                <span className="fs-layer-swatch" style={{ background: '#D4A657' }} />
                Land cover
              </label>

              <label className="fs-layer-row">
                <input type="checkbox" checked={layers.flood} onChange={() => toggleLayer('flood')} />
                <span className="fs-layer-swatch" style={{ background: '#2166a8' }} />
                Flood depth
              </label>

              <label className="fs-layer-row">
                <input type="checkbox" checked={layers.river} onChange={() => toggleLayer('river')} />
                <span className="fs-layer-swatch" style={{ background: '#38bdf8' }} />
                Kalpani River
              </label>

              <label className="fs-layer-row">
                <input type="checkbox" checked={layers.districts} onChange={() => toggleLayer('districts')} />
                <span className="fs-layer-swatch" style={{ background: '#F0B429' }} />
                District boundary
              </label>

              <label className="fs-layer-row">
                <input type="checkbox" checked={layers.buildings} onChange={() => toggleLayer('buildings')} />
                <span className="fs-layer-swatch" style={{ background: '#2dd4bf' }} />
                Buildings (3D)
                {buildingsLoading && <span className="fs-mini-spinner" />}
              </label>
            </div>

            {layers.buildings && (
              <div className="fs-sidebar-section">
                <div className="fs-sidebar-section-title">
                  Buildings in view
                  <span className="fs-sidebar-section-count">{buildingCount.toLocaleString()}</span>
                </div>
                <div className="fs-legend">
                  {HEIGHT_STOPS.map((s) => (
                    <div key={s.label} className="fs-legend-row">
                      <span className="fs-legend-swatch" style={{ background: s.color }} />
                      {s.label}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {sfincsManifestRef.current?.lulc && (
              <div className="fs-sidebar-section">
                <div className="fs-sidebar-section-title">Land cover</div>
                <div className="fs-lulc">
                  <ResponsiveContainer width={92} height={92}>
                    <PieChart>
                      <Pie
                        data={sfincsManifestRef.current.lulc}
                        dataKey="pct"
                        nameKey="class"
                        innerRadius={22}
                        outerRadius={44}
                        strokeWidth={1}
                        stroke="var(--bg-elevated)"
                        isAnimationActive={false}
                      >
                        {sfincsManifestRef.current.lulc.map((entry, i) => (
                          <Cell key={entry.class} fill={LULC_COLORS[i % LULC_COLORS.length]} />
                        ))}
                      </Pie>
                      <Tooltip
                        formatter={(v, n) => [`${v}%`, n]}
                        contentStyle={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-accent)', borderRadius: 6, fontSize: 11 }}
                      />
                    </PieChart>
                  </ResponsiveContainer>
                  <div className="fs-lulc-list">
                    {sfincsManifestRef.current.lulc.map((entry, i) => (
                      <div key={entry.class} className="fs-legend-row">
                        <span className="fs-legend-swatch" style={{ background: LULC_COLORS[i % LULC_COLORS.length] }} />
                        {entry.class} <b>{entry.pct}%</b>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {sfincsManifestRef.current?.soil && (
              <div className="fs-sidebar-section">
                <div className="fs-sidebar-section-title">Dominant soil</div>
                <div className="fs-soil-headline">{sfincsManifestRef.current.soil.dominant}</div>
                <div className="fs-soil-split">
                  <span>HSG B (higher infiltration): {sfincsManifestRef.current.soil.hsgBPct}%</span>
                  <span>HSG D (slower infiltration): {sfincsManifestRef.current.soil.hsgDPct}%</span>
                </div>
                <div className="fs-sidebar-hint">{sfincsManifestRef.current.soil.note}</div>
              </div>
            )}

            <div className="fs-sidebar-hint">
              Buildings load progressively as you pan — only what's on screen is fetched.
            </div>
            <Link to="/flood-simulation-3d" className="fs-try-3d-link">Try 3D terrain version →</Link>
          </div>
        )}
      </div>

      {/* ── Right floating sidebar: flood-scenario-specific detail ──── */}
      <div className={`fs-sidebar fs-sidebar--right${rightMinimized ? ' fs-sidebar--minimized' : ''}`}>
        <div className="fs-sidebar-header">
          {!rightMinimized && <span className="fs-sidebar-title">Flood Scenario</span>}
          <button
            className="fs-sidebar-toggle"
            onClick={() => setRightMinimized((v) => !v)}
            title={rightMinimized ? 'Expand panel' : 'Minimize panel'}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
              {rightMinimized ? (
                <path d="M9 5l7 7-7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              ) : (
                <path d="M15 5l-7 7 7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              )}
            </svg>
          </button>
        </div>

        {!rightMinimized && (
          <div className="fs-sidebar-body">
            {sfincsReady && currentScenario() && (
              <div className="fs-sidebar-section">
                <div className="fs-sidebar-section-title">
                  Precipitation scenario
                  <span className="fs-sidebar-section-count">{precipitation}mm / 24h</span>
                </div>

                <input
                  type="range"
                  className="fs-precip-slider"
                  min={0}
                  max={PRECIP_VALUES.length - 1}
                  step={1}
                  value={PRECIP_VALUES.indexOf(precipitation)}
                  onChange={(e) => selectPrecipitation(PRECIP_VALUES[Number(e.target.value)])}
                />
                <div className="fs-precip-ticks">
                  {PRECIP_VALUES.map((v) => (
                    <span key={v} className={v === precipitation ? 'fs-precip-tick--active' : ''}>{v}</span>
                  ))}
                </div>

                <div className="fs-precip-controls">
                  <button
                    className="fs-precip-btn"
                    onClick={() => setPlaying((p) => !p)}
                    title={playing ? 'Pause' : 'Play flood progression'}
                  >
                    {playing ? (
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><rect x="5" y="4" width="5" height="16" /><rect x="14" y="4" width="5" height="16" /></svg>
                    ) : (
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M6 4l14 8-14 8V4z" /></svg>
                    )}
                    {playing ? 'Pause' : 'Play'}
                  </button>
                  <button
                    className="fs-precip-btn"
                    onClick={() => { setFrameIdx(0); setPlaying(true); }}
                    title="Replay from start"
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M3 12a9 9 0 1 1 3 6.7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /><path d="M3 8v5h5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
                    Replay
                  </button>
                </div>

                <div className="fs-speed-row">
                  <span className="fs-speed-label">Speed</span>
                  {SPEED_OPTIONS.map((opt) => (
                    <button
                      key={opt.label}
                      className={`fs-speed-btn${speedMs === opt.ms ? ' fs-speed-btn--active' : ''}`}
                      onClick={() => setSpeedMs(opt.ms)}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>

                {/* Now on V2 (_FILLED_v2), which corrects V1's DEM-pooling
                    artifact (single cells trapping water with no outflow
                    path). Domain-wide recession is real here but only just
                    starting to show by the end of the 30h window — see the
                    hydrograph's last few hours. */}
                <div className="fs-precip-meta">
                  <span>Storm duration: {currentScenario().durationHours}h</span>
                  <span>Peak depth: {currentScenario().peakDepth.toFixed(2)} m</span>
                </div>

                <div className="fs-precip-readout">
                  <span>T+{currentScenario().frames[frameIdx]?.elapsedHours ?? 0}h of {currentScenario().durationHours}h</span>
                  <span>Depth now: {(currentScenario().frames[frameIdx]?.maxDepth ?? 0).toFixed(2)} m</span>
                </div>

                <div className="fs-hydrograph">
                  <ResponsiveContainer width="100%" height={90}>
                    <AreaChart data={currentScenario().frames} margin={{ top: 6, right: 6, bottom: 0, left: -28 }}>
                      <XAxis
                        dataKey="elapsedHours"
                        tick={{ fill: 'var(--text-dim)', fontSize: 10 }}
                        tickFormatter={(v) => `${v}h`}
                        axisLine={{ stroke: 'rgba(255,255,255,0.12)' }}
                        tickLine={false}
                      />
                      <YAxis
                        tick={{ fill: 'var(--text-dim)', fontSize: 10 }}
                        width={34}
                        axisLine={false}
                        tickLine={false}
                      />
                      <Tooltip
                        formatter={(v) => [`${v.toFixed(2)} m`, 'Depth']}
                        labelFormatter={(v) => `T+${v}h`}
                        contentStyle={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-accent)', borderRadius: 6, fontSize: 11 }}
                      />
                      <Area
                        type="monotone"
                        dataKey="maxDepth"
                        stroke="#42A5F5"
                        fill="rgba(66, 165, 245, 0.25)"
                        strokeWidth={1.5}
                        isAnimationActive={false}
                      />
                      <ReferenceDot
                        x={currentScenario().frames[frameIdx]?.elapsedHours}
                        y={currentScenario().frames[frameIdx]?.maxDepth}
                        r={4}
                        fill="#F0B429"
                        stroke="#0E1B29"
                        strokeWidth={1.5}
                        isFront
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>

                <div className="fs-precip-meta">
                  <span>Peak velocity: {currentScenario().peakVelocity.toFixed(2)} m/s</span>
                  <span>Infiltration (avg): {currentScenario().meanInfiltration} mm</span>
                </div>
                <div className="fs-sidebar-hint">
                  Infiltration shown is the model's final cumulative total per this
                  24h+6h run — no infiltration-rate time series is in this output,
                  so exactly when it tapered off vs. when runoff took over can't be
                  read from this dataset (would need SFINCS's "his" point output).
                </div>
              </div>
            )}

            {sfincsReady && layers.flood && (
              <div className="fs-sidebar-section">
                <div className="fs-sidebar-section-title">Flood depth</div>
                <div className="fs-legend">
                  {sfincsManifestRef.current?.depthStops.map((s, i) => (
                    <div key={s.depth} className="fs-legend-row">
                      <span className="fs-legend-swatch" style={{ background: rgba(s.rgba) }} />
                      {i === 0 ? `< ${s.depth} m` : `${sfincsManifestRef.current.depthStops[i - 1].depth}–${s.depth} m`}
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
