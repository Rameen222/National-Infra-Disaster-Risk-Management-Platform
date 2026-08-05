/**
 * Loads the list of tehsils (name + geometry) that make up a district, pulled
 * from the same GeoServer WFS layers the map uses. Results are cached per
 * layer in-memory so opening the tehsil-buildings modal repeatedly for the
 * same province only hits GeoServer once.
 */
import { PROVINCES } from '../config/mapConfig';
import { representativePoint, geomContainsPoint } from './geometry';

const _layerCache = new Map(); // layerName → Promise<FeatureCollection>

const norm = (s) => (s || '').toString().toLowerCase().replace(/[^a-z0-9]/g, '');

// Pick the GeoServer layer that holds a province's tehsils. Gilgit-Baltistan
// uses the dedicated corrected `tehsil_gb` layer; other provinces use their
// province_<Name> layer; anything unresolved falls back to the country layer.
function layerForProvince(provinceLabel) {
  if (/gilgit/i.test(provinceLabel || '')) return 'infra_portal:tehsil_gb';
  const p = PROVINCES.find(
    (x) => x.geojsonProvince === provinceLabel || x.name === provinceLabel || x.id === provinceLabel,
  );
  if (p && p.id === 'gilgit-baltistan') return 'infra_portal:tehsil_gb';
  if (p) return `infra_portal:province_${p.geojsonProvince}`;
  return 'infra_portal:pak_tehsils';
}

function fetchLayer(layerName) {
  if (_layerCache.has(layerName)) return _layerCache.get(layerName);
  const url =
    '/geoserver/infra_portal/ows?service=WFS&version=2.0.0&request=GetFeature' +
    `&typeNames=${encodeURIComponent(layerName)}` +
    '&outputFormat=application/json&srsName=EPSG:4326';
  const promise = fetch(url)
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`WFS ${r.status}`))))
    .catch((err) => {
      _layerCache.delete(layerName); // let a later attempt retry
      throw err;
    });
  _layerCache.set(layerName, promise);
  return promise;
}

const TEHSIL_NAME_KEYS = ['TEHSIL', 'tehsil', 'Tehsil', 'name', 'NAME', 'Name'];
const DISTRICT_KEYS = ['DISTRICT', 'district', 'District'];

const firstProp = (props, keys) => {
  for (const k of keys) if (props && props[k] != null && props[k] !== '') return props[k];
  return null;
};

/**
 * Return the tehsils inside a district for `provinceLabel` as
 * [{ name, geometry }], sorted by name.
 *
 * Prefers a spatial test — tehsils whose representative point falls inside the
 * given `districtGeometry` — because the tehsil layer's DISTRICT column can use
 * legacy combined names (e.g. "HUNZA NAGAR") that don't match a real district.
 * Falls back to matching that column against `districtName` when no geometry is
 * supplied.
 */
export async function loadDistrictTehsils(provinceLabel, { districtGeometry, districtName } = {}) {
  const layerName = layerForProvince(provinceLabel);
  const fc = await fetchLayer(layerName);

  let matcher;
  if (districtGeometry) {
    matcher = (f) => {
      const pt = representativePoint(f.geometry);
      return pt && geomContainsPoint(districtGeometry, pt[0], pt[1]);
    };
  } else {
    const target = norm(districtName);
    matcher = (f) => !target || norm(firstProp(f.properties, DISTRICT_KEYS)) === target;
  }

  return (fc.features || [])
    .filter(matcher)
    .map((f) => ({ name: firstProp(f.properties, TEHSIL_NAME_KEYS), geometry: f.geometry }))
    .filter((t) => t.name && t.geometry)
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Filesystem-safe cache keys mirroring the backend `_tehsil_key` /
// `_simex_tehsil_key`, so the client can look up a previously computed count
// without a round-trip.
const clean = (s) => (s || '').toString().trim().replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

export function tehsilCacheKey(province, district, tehsil) {
  return 'tehsil_' + [clean(province), clean(district), clean(tehsil)].filter(Boolean).join('_');
}

export function simexTehsilCacheKey(scenarioId, province, district, tehsil) {
  return 'simextehsil_' + [clean(scenarioId), clean(province), clean(district), clean(tehsil)].filter(Boolean).join('_');
}

export function exposureTehsilCacheKey(scenarioId, province, district, tehsil) {
  return 'exptehsil_' + [clean(scenarioId), clean(province), clean(district), clean(tehsil)].filter(Boolean).join('_');
}
