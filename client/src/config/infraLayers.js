/**
 * Registry of optional infrastructure overlay layers (Rivers, Roads,
 * Hospitals, Schools, Dams, …). Rivers, roads, NHA highways, health facilities,
 * schools and dams come live from the GCOP GeoServer through the Python
 * backend (/pyapi/infra/…, see pybackend/infra_counts.py): roads as
 * GeoServer-drawn image tiles, points as GeoJSON.
 *
 * Each entry is self-contained: point it at a
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
    // GeoServer gcop:Pak_Rivers, drawn by GeoServer as image tiles.
    type: 'raster',
    tiles: { url: '/pyapi/infra/wms?layer=rivers&bbox={bbox-epsg-3857}', minzoom: 0 },
    defaultVisible: false,
    style: { lineColor: '#38bdf8', rasterOpacity: 1 },
  },
  {
    id: 'roads',
    label: 'Roads',
    // OSM roads (GeoServer gcop:osm_roads_), drawn by GeoServer as image
    // tiles in the portal's colour (pybackend /pyapi/infra/wms) — nothing is
    // downloaded. Minor roads appear from ~zoom 12.
    type: 'raster',
    tiles: { url: '/pyapi/infra/wms?layer=roads&bbox={bbox-epsg-3857}', minzoom: 5 },
    defaultVisible: false,
    // Near-white — outside the building-height palette. lineColor = chip colour.
    style: { lineColor: '#f1f5f9', rasterOpacity: 0.9 },
  },
  {
    id: 'nha_roads',
    label: 'NHA Highways',
    // GeoServer gcop:Roads_NHA_QC (motorways, national highways), image tiles.
    type: 'raster',
    tiles: { url: '/pyapi/infra/wms?layer=nha_roads&bbox={bbox-epsg-3857}', minzoom: 4 },
    defaultVisible: false,
    // Magenta, wider than OSM roads — outside the building-height palette.
    style: { lineColor: '#ff4fd8', rasterOpacity: 1 },
  },
  {
    id: 'health_facilities',
    label: 'Health Facilities',
    // GeoServer gcop:Pakistan_Health_Facilities — public and private
    // (properties: `Name`, `Category`, `Sub_Cat`, `Gov_Pvt`).
    type: 'symbol',
    source: '/pyapi/infra/layer/health_facilities',
    defaultVisible: false,
    // Icon badge drawn at runtime (utils/infraIcons.js) so it can't be
    // mistaken for a building-height colour.
    style: { iconGlyph: 'hospital', iconColor: '#dc2626', iconSizeStops: [[11, 0.7], [14, 1]] },
  },
  {
    id: 'schools',
    label: 'Schools',
    type: 'symbol', // GeoServer gcop:Schools_QC — properties: `schoolname`, `level`, `gender`
    source: '/pyapi/infra/layer/schools',
    defaultVisible: false,
    style: { iconGlyph: 'school', iconColor: '#2563eb', iconSizeStops: [[11, 0.7], [14, 1]] },
  },
  {
    id: 'dams',
    label: 'Dams',
    type: 'circle', // GeoServer gcop:Dams_QC — properties: `name_of_da`, `height`
    source: '/pyapi/infra/layer/dams',
    defaultVisible: false,
    // Cyan — outside the building-height palette (blue/green/yellow/orange/red/purple).
    style: { circleColor: '#00e5ff', circleRadius: 5, circleOpacity: 0.95 },
  },
  {
    id: 'affected_houses',
    label: 'Affected Houses',
    // Point — required properties: `moza`, `affectees` (array), `photos` (array),
    // `lat_dms`, `lon_dms`. Furori flash-flood field data (Aug 2026), pre-grouped
    // one feature per house.
    type: 'symbol',
    source: '/infra/affected_houses.geojson',
    defaultVisible: false,
    style: {
      // Mapbox's loadImage/addImage only decodes raster formats — SVG fetches
      // fine but silently fails to decode, so this must be a PNG.
      iconUrl: '/infra/affected-house-pin.png',
      // Larger when zoomed out, smaller when zoomed in — inverse of the usual
      // convention, by explicit request (points are tightly clustered in one
      // village, so a bigger pin reads better from far out; up close a smaller
      // pin sits more precisely on the actual house).
      iconSizeStops: [[6, 1.3], [10, 1.05], [13, 0.85], [16, 0.65], [18, 0.5]],
    },
  },
];
