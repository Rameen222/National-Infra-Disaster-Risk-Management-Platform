// Streams Exposure API client.
//
// Two endpoints, both fronted by the /impact-api Vite proxy (configurable
// via IMPACT_SERVICE_URL in root .env, defaults to http://172.18.1.45:5009):
//
//   GET /api/impact?date=YYYY-MM-DD             → exposure rows by stream id
//   GET /api/gis/gloric?ids=ID1,ID2,...         → GeoJSON of stream geometries
//
// Row indicator field names vary between deployments; normaliseRow() maps
// the common aliases to a single canonical shape so the UI can rely on
// `schools`, `settlements`, `population`, etc.

const INDICATOR_ALIASES = {
  schools:         ['schools', 'Schools', 'school_count', 'SCHOOLS'],
  settlements:     ['settlements', 'Settlements', 'settlement_count', 'SETTLEMENTS'],
  population:      ['population', 'Population', 'total_population_exposed', 'population_exposed', 'pop', 'POPULATION'],
  hospitals:       ['hospitals', 'Hospitals', 'health_facilities', 'HOSPITALS'],
  bridges:         ['bridges', 'Bridges', 'BRIDGES'],
  airports:        ['airports', 'Airports', 'AIRPORTS'],
  railwayStations: ['railway_stations', 'railwayStations', 'Railway stations', 'RailwayStations', 'RAILWAY_STATIONS', 'railway'],
};

const ID_ALIASES = ['id', 'ID', 'stream_id', 'streamId', 'gloric_id', 'GloRiC_id', 'reach_id', 'Reach_ID'];

export function pickField(obj, aliases, fallback = 0) {
  if (!obj) return fallback;
  for (const k of aliases) {
    if (obj[k] != null) return obj[k];
  }
  return fallback;
}

export function pickId(obj) {
  return pickField(obj, ID_ALIASES, null);
}

export function normaliseRow(row) {
  const out = { id: pickId(row), raw: row };
  for (const [key, aliases] of Object.entries(INDICATOR_ALIASES)) {
    const v = pickField(row, aliases, 0);
    const n = Number(v);
    out[key] = Number.isFinite(n) ? n : 0;
  }
  return out;
}

export async function fetchExposureByDate(dateISO, signal) {
  const url = `/impact-api/api/impact?date=${encodeURIComponent(dateISO)}`;
  const r = await fetch(url, { signal });
  if (!r.ok) throw new Error(`Impact API ${r.status}`);
  const body = await r.json();
  // Service may return either a bare array or { data: [...] } / { rows: [...] }
  const rows = Array.isArray(body) ? body : (body.data || body.rows || body.results || []);
  return rows.map(normaliseRow).filter((r) => r.id != null);
}

export async function fetchStreamGeometries(ids, signal) {
  if (!ids.length) return { type: 'FeatureCollection', features: [] };
  const idParam = ids.join(',');
  const url = `/impact-api/api/gis/gloric?ids=${encodeURIComponent(idParam)}`;
  const r = await fetch(url, { signal });
  if (!r.ok) throw new Error(`GloRiC API ${r.status}`);
  const body = await r.json();
  if (body?.type === 'FeatureCollection') return body;
  // Some services wrap the FeatureCollection — try common nest keys.
  if (body?.features) return { type: 'FeatureCollection', features: body.features };
  if (body?.data?.features) return { type: 'FeatureCollection', features: body.data.features };
  return { type: 'FeatureCollection', features: [] };
}

// Join exposure rows onto stream features by id. The resulting feature
// `properties` exposes both the original GIS properties AND the canonical
// indicator fields, so the map layer can colour by exposure if needed and
// the per-stream card can pull values straight from the clicked feature.
export function joinExposure(featureCollection, rows) {
  const byId = new Map();
  rows.forEach((r) => byId.set(String(r.id), r));
  const features = (featureCollection.features || []).map((f) => {
    const props = f.properties || {};
    const fid = String(pickId(props) ?? f.id ?? '');
    const row = byId.get(fid);
    if (!row) return { ...f, properties: { ...props, _streamId: fid } };
    return {
      ...f,
      properties: {
        ...props,
        _streamId: fid,
        schools:         row.schools,
        settlements:     row.settlements,
        population:      row.population,
        hospitals:       row.hospitals,
        bridges:         row.bridges,
        airports:        row.airports,
        railwayStations: row.railwayStations,
      },
    };
  });
  return { type: 'FeatureCollection', features };
}

export function aggregateTotals(rows) {
  const t = { schools: 0, settlements: 0, population: 0, hospitals: 0, bridges: 0, airports: 0, railwayStations: 0 };
  rows.forEach((r) => {
    t.schools         += r.schools         || 0;
    t.settlements     += r.settlements     || 0;
    t.population      += r.population      || 0;
    t.hospitals       += r.hospitals       || 0;
    t.bridges         += r.bridges         || 0;
    t.airports        += r.airports        || 0;
    t.railwayStations += r.railwayStations || 0;
  });
  return t;
}
