// Mardan watershed buildings prototype — map layer wiring.
//
// Self-contained on purpose: this hook adds a GeoJSON source + 2D building
// layers for the Mardan watershed buildings and reports load status up to a
// small sidebar toggle. Everything Mardan-specific lives in this folder
// (src/mardanPrototype), so deleting the prototype = remove this folder,
// remove public/prototype/mardan, and delete the integration lines in
// MapContainer.jsx / Sidebar.jsx / App.jsx.

import { useEffect, useRef } from 'react';

export const MARDAN_SOURCE_ID = 'mardan-buildings-src';
export const MARDAN_BUILDING_LAYER_IDS = ['mardan-buildings-fill', 'mardan-buildings-line'];

// Prototype demo: the portal has no per-building vulnerability/use class data,
// so the GLB shown for each Mardan building is picked manually — the FIRST
// Mardan building you double-click opens the low-poly HOUSE interior, the
// SECOND opens the SCHOOL/classroom interior, then it cycles back to house.
const MARDAN_BUILDING_TYPE_SEQUENCE = ['house', 'classroom'];
let mardanBuildingTypeIndex = 0;
export const nextMardanBuildingType = () => {
  const type = MARDAN_BUILDING_TYPE_SEQUENCE[mardanBuildingTypeIndex % MARDAN_BUILDING_TYPE_SEQUENCE.length];
  mardanBuildingTypeIndex += 1;
  return type;
};
export const resetMardanBuildingType = () => { mardanBuildingTypeIndex = 0; };

// Gzipped to ~16 MB on disk so emailing / serving the prototype is fast; the
// browser decompresses it client-side before handing it to Mapbox.
export const MARDAN_GEODATA_URL = '/prototype/mardan/buildings_mardan_watershed_reduced.geojson.gz';
export const MARDAN_PLAIN_DATA_URL = '/prototype/mardan/buildings_mardan_watershed_reduced.geojson';

const FILL_COLOR = '#14b8a6';

function getBbox(features) {
  let minLng = Infinity;
  let minLat = Infinity;
  let maxLng = -Infinity;
  let maxLat = -Infinity;
  for (const f of features) {
    const g = f.geometry;
    if (!g || !g.coordinates) continue;
    const walk = (coords) => {
      if (typeof coords[0] === 'number') {
        const [lng, lat] = coords;
        if (lng < minLng) minLng = lng;
        if (lat < minLat) minLat = lat;
        if (lng > maxLng) maxLng = lng;
        if (lat > maxLat) maxLat = lat;
      } else {
        coords.forEach(walk);
      }
    };
    walk(g.coordinates);
  }
  return [[minLng, minLat], [maxLng, maxLat]];
}

/** Fetch (and, if needed, gunzip) the Mardan buildings GeoJSON. */
async function loadMardanGeoJSON(signal) {
  const res = await fetch(MARDAN_GEODATA_URL, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());

  // Vite serves .gz files with `Content-Encoding: gzip`, so the browser has
  // ALREADY decoded the body → buf is plain JSON. Plain static servers send
  // the raw gzip bytes instead (gzip magic 1f 8b) → decompress manually here.
  if (buf[0] === 0x1f && buf[1] === 0x8b) {
    if (typeof DecompressionStream === 'undefined') {
      throw new Error('Browser lacks DecompressionStream and the server didn’t send the file gzipped');
    }
    const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
    const reader = stream.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) { out.set(c, offset); offset += c.length; }
    const text = new TextDecoder('utf-8').decode(out);
    return { fc: JSON.parse(text), mb: +(out.length / 1048576).toFixed(1) };
  }

  const text = new TextDecoder('utf-8').decode(buf);
  return { fc: JSON.parse(text), mb: +(buf.length / 1048576).toFixed(1) };
}

/**
 * Adds / removes the Mardan buildings layer set on the Mapbox map.
 *
 * @param {object|null} map         Mapbox map instance (or null until ready)
 * @param {boolean}      mapLoaded   true once the map style has loaded
 * @param {boolean}      enabled     sidebar toggle state
 * @param {(status: object|null) => void} [onStatus] reports load progress
 */
export function useMardanBuildings(map, mapLoaded, enabled, onStatus) {
  const statusRef = useRef(null);
  const notify = (s) => { statusRef.current = s; onStatus?.(s); };

  useEffect(() => {
    if (!map || !mapLoaded) return;

    const SRC = MARDAN_SOURCE_ID;
    const [FILL, LINE] = MARDAN_BUILDING_LAYER_IDS;
    const removeAll = () => {
      [FILL, LINE].forEach((id) => { if (map.getLayer(id)) map.removeLayer(id); });
      if (map.getSource(SRC)) map.removeSource(SRC);
    };

    if (!enabled) {
      removeAll();
      notify(null);
      return;
    }

    const ctrl = new AbortController();
    notify({ loading: true });

    (async () => {
      const { fc, mb } = await loadMardanGeoJSON(ctrl.signal);
      if (enabled !== true) return; // toggled off while loading
      removeAll();

      map.addSource(SRC, { type: 'geojson', data: fc });
      map.addLayer({
        id: FILL,
        type: 'fill',
        source: SRC,
        paint: {
          'fill-color': FILL_COLOR,
          'fill-opacity': ['interpolate', ['linear'], ['zoom'], 8, 0.35, 13, 0.8],
        },
      });
      map.addLayer({
        id: LINE,
        type: 'line',
        source: SRC,
        paint: { 'line-color': '#0f766e', 'line-width': 0.6, 'line-opacity': 0.65 },
      });

      try {
        const bbox = getBbox(fc.features);
        map.fitBounds(bbox, { padding: 70, duration: 1600, maxZoom: 15 });
      } catch (_) { /* bbox degenerate */ }

      notify({
        loading: false,
        count: fc.features?.length ?? 0,
        mb: mb ?? null,
        rawMb: fc.features ? Math.round(JSON.stringify(fc).length / 1048576) : null,
      });
    })().catch((err) => {
      if (err?.name === 'AbortError') return;
      console.error('[mardan prototype] load failed', err);
      notify({ loading: false, error: err?.message || String(err) || 'Unknown error' });
    });

    return () => { ctrl.abort(); removeAll(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, mapLoaded, enabled]);
}