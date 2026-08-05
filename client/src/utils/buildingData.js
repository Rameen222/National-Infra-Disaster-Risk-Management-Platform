// Per-district building tile URLs served by tileserver-gl.
// URL pattern: http://HOST:8081/data/<District>_buildings/{z}/{x}/{y}.pbf

const TILE_SERVER = import.meta.env.VITE_TILE_SERVER_URL || 'http://172.18.1.151:8081';

export function buildingTileUrl(districtKey) {
  // Spaces → underscores so "Dera Ghazi Khan" → "Dera_Ghazi_Khan_buildings"
  const stem = districtKey.replace(/\s+/g, '_');
  return `${TILE_SERVER}/data/${stem}_buildings/{z}/{x}/{y}.pbf`;
}

let _buildingIndex = null;

export async function loadBuildingIndex() {
  if (_buildingIndex) return _buildingIndex;
  const res  = await fetch('/geoserver_upload_tracker.csv');
  const text = await res.text();
  const lines  = text.trim().split('\n');
  const header = lines[0].split(',');
  const sfIdx  = header.indexOf('shapefile_name');

  const index = {};
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    const shp  = (cols[sfIdx] || '').trim();
    if (!shp) continue;
    // "Dera_Ghazi_Khan_buildings.shp" → "Dera Ghazi Khan"
    const districtKey = shp.replace(/_buildings\.shp$/i, '').replace(/_/g, ' ');
    index[districtKey.toLowerCase()] = { districtKey };
  }
  _buildingIndex = index;
  return index;
}

export function findBuildingEntry(buildingIndex, districtName) {
  if (!buildingIndex || !districtName) return null;
  return buildingIndex[districtName.toLowerCase().trim()] || null;
}
