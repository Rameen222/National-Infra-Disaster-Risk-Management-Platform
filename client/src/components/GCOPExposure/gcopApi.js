// GCOP / DEW exposure service client.
//
// Two endpoints fronted by the /gcop-api Vite proxy (configurable via
// GCOP_EXPOSURE_URL in root .env, defaults to http://172.18.1.108:8000):
//
//   GET /get-exposures/                     → [{ id, remarks }, ...]
//   GET /get-exposures/?exposure_id=<id>    → GeoJSON FeatureCollection
//
// Each feature's properties.exposure_feature_assessment is a nested
// { province: { district: ... } } object — we collect every district
// name so the map can highlight matching boundaries.

export async function fetchExposures(signal) {
  const r = await fetch('/gcop-api/get-exposures/', { signal });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const body = await r.json();
  if (!Array.isArray(body)) throw new Error('Expected an array of exposures');
  return body
    .filter((row) => row && row.id != null)
    .map((row) => ({ id: row.id, remarks: row.remarks || '' }));
}

export async function fetchExposureDetails(exposureId, signal) {
  const r = await fetch(`/gcop-api/get-exposures/?exposure_id=${encodeURIComponent(exposureId)}`, { signal });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const body = await r.json();
  const features = Array.isArray(body?.features) ? body.features : [];
  return { type: 'FeatureCollection', features };
}

export function collectExposureDistricts(featureCollection) {
  const set = new Set();
  for (const feature of featureCollection?.features || []) {
    const assessment = feature?.properties?.exposure_feature_assessment;
    if (!assessment || typeof assessment !== 'object') continue;
    for (const province of Object.values(assessment)) {
      if (!province || typeof province !== 'object') continue;
      for (const district of Object.keys(province)) {
        if (district) set.add(district);
      }
    }
  }
  return set;
}
