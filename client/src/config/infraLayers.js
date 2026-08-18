/**
 * Registry of optional infrastructure overlay layers (Rivers, Roads,
 * Hospitals, Schools, Dams, …). Each entry is self-contained: point it at a
 * GeoJSON file (or, later, a GeoServer WFS typeName — MapContainer's loader
 * treats `source` as a plain URL either way) and it gets a toggle chip in
 * the map's top toolbar with no other code changes.
 *
 * To add a real dataset later:
 *   1. Drop a GeoJSON file at client/public/infra/<id>.geojson matching the
 *      geometry type below (or swap `source` for a GeoServer WFS URL).
 *   2. That's it — MapContainer reads this list generically, so no
 *      component code needs to change.
 *
 * Until real data exists, `source` points at an empty placeholder
 * FeatureCollection so the toggle is fully wired and testable.
 */

export const INFRA_LAYERS = [
  {
    id: 'rivers',
    label: 'Rivers',
    type: 'line', // LineString / MultiLineString — required property: `name`
    source: '/infra/rivers.geojson',
    defaultVisible: false,
    style: { lineColor: '#38bdf8', lineWidth: 1.5, lineOpacity: 0.9 },
  },
  {
    id: 'roads',
    label: 'Roads',
    type: 'line', // LineString / MultiLineString — required properties: `name`, `road_class`
    source: '/infra/roads.geojson',
    defaultVisible: false,
    style: { lineColor: '#d4a017', lineWidth: 1.2, lineOpacity: 0.85 },
  },
  {
    id: 'health_facilities',
    label: 'Health Facilities',
    type: 'circle', // Point — required properties: `name`, `type`
    source: '/infra/health_facilities.geojson',
    defaultVisible: false,
    style: { circleColor: '#ef4444', circleRadius: 4, circleOpacity: 0.9 },
  },
  {
    id: 'schools',
    label: 'Schools',
    type: 'circle', // Point — required properties: `name`, `level`
    source: '/infra/schools.geojson',
    defaultVisible: false,
    style: { circleColor: '#3b82f6', circleRadius: 4, circleOpacity: 0.9 },
  },
  {
    id: 'dams',
    label: 'Dams',
    type: 'circle', // Point (or Polygon, see note) — required property: `name`
    source: '/infra/dams.geojson',
    defaultVisible: false,
    style: { circleColor: '#a855f7', circleRadius: 5, circleOpacity: 0.9 },
  },
  {
    id: 'affected_houses',
    label: 'Affected Houses',
    // Point — required properties: `moza`, `affectees` (array), `photos` (array),
    // `lat_dms`, `lon_dms`. Furori flash-flood field data (Aug 2026), pre-grouped
    // one feature per house — see scripts/prep_affected_houses_geojson.py.
    type: 'symbol',
    source: '/infra/affected_houses.geojson',
    defaultVisible: false,
    style: {
      // Mapbox's loadImage/addImage only decodes raster formats — SVG fetches
      // fine but silently fails to decode, so this must be a PNG (see
      // scripts/generate_affected_house_pin_png.py for how it was made).
      iconUrl: '/infra/affected-house-pin.png',
      // Larger when zoomed out, smaller when zoomed in — inverse of the usual
      // convention, by explicit request (points are tightly clustered in one
      // village, so a bigger pin reads better from far out; up close a smaller
      // pin sits more precisely on the actual house).
      iconSizeStops: [[6, 1.3], [10, 1.05], [13, 0.85], [16, 0.65], [18, 0.5]],
    },
  },
];
