/**
 * Small point-in-polygon helpers used to associate tehsils with the district
 * whose boundary actually contains them — the tehsil layer's DISTRICT column
 * can carry legacy combined names (e.g. "HUNZA NAGAR") that don't line up with
 * the real districts (Hunza, Nagar).
 */

export function ringContains(ring, x, y) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    const intersect = ((yi > y) !== (yj > y)) &&
      (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

// A polygon is [outerRing, ...holes]; inside means within the outer ring and
// not within any hole.
export function polygonContains(rings, x, y) {
  if (!rings?.length || !ringContains(rings[0], x, y)) return false;
  for (let k = 1; k < rings.length; k++) {
    if (ringContains(rings[k], x, y)) return false;
  }
  return true;
}

export function geomContainsPoint(geom, x, y) {
  if (!geom) return false;
  if (geom.type === 'Polygon') return polygonContains(geom.coordinates, x, y);
  if (geom.type === 'MultiPolygon') return geom.coordinates.some((poly) => polygonContains(poly, x, y));
  return false;
}

// Average of the largest ring's vertices — a cheap representative point that
// reliably lands inside its own (much larger) district polygon.
export function representativePoint(geom) {
  if (!geom) return null;
  let ring;
  if (geom.type === 'Polygon') ring = geom.coordinates[0];
  else if (geom.type === 'MultiPolygon') {
    ring = geom.coordinates.map((p) => p[0]).sort((a, b) => b.length - a.length)[0];
  }
  if (!ring || !ring.length) return null;
  let x = 0, y = 0;
  for (const [px, py] of ring) { x += px; y += py; }
  return [x / ring.length, y / ring.length];
}

/**
 * Return { name, geometry } of the district in `districtsGeoJSON` that contains
 * the given geometry (by its representative point), or null.
 */
export function findDistrictForGeometry(districtsGeoJSON, geometry) {
  const pt = representativePoint(geometry);
  if (!pt) return null;
  const f = (districtsGeoJSON?.features || []).find((d) => geomContainsPoint(d.geometry, pt[0], pt[1]));
  return f ? { name: f.properties?.name, geometry: f.geometry } : null;
}
