// Map Configuration
// The Mapbox token comes from MAPBOX_TOKEN in the project-root .env;
// vite.config.js injects it via `define` so the client bundle can read it
// from import.meta.env.VITE_MAPBOX_TOKEN at runtime.
const MAPBOX_TOKEN = import.meta.env?.VITE_MAPBOX_TOKEN || '';
if (!MAPBOX_TOKEN) {
  // eslint-disable-next-line no-console
  console.warn(
    '[mapConfig] MAPBOX_TOKEN is missing — set it in the project-root .env. ' +
    'Get one at https://account.mapbox.com/access-tokens/'
  );
}

export const MAP_CONFIG = {
  accessToken: MAPBOX_TOKEN,
  defaultCenter: [69.3451, 30.3753],
  defaultZoom: 4.5,
  minZoom: 3,
  maxZoom: 18,
  styles: {
    satellite: 'mapbox://styles/mapbox/satellite-streets-v12',
    dark: 'mapbox://styles/mapbox/dark-v11',
    light: 'mapbox://styles/mapbox/light-v11',
    streets: 'mapbox://styles/mapbox/streets-v12',
    outdoors: 'mapbox://styles/mapbox/outdoors-v12',
  },
  defaultStyle: 'satellite',
};

// Pakistan Provinces — coordinates are derived at runtime from the districts GeoJSON
export const PROVINCES = [
  { id: 'punjab',           name: 'Punjab',           geojsonProvince: 'Punjab',                    color: '#ffffff' },
  { id: 'sindh',            name: 'Sindh',            geojsonProvince: 'Sindh',                     color: '#ffffff' },
  { id: 'kpk',              name: 'KPK',              geojsonProvince: 'Khyber Pakhtunkhwa',        color: '#ffffff' },
  { id: 'balochistan',      name: 'Balochistan',      geojsonProvince: 'Balochistan',               color: '#ffffff' },
  { id: 'gilgit-baltistan', name: 'Gilgit-Baltistan', geojsonProvince: 'Gilgit Baltistan',          color: '#ffffff' },
  { id: 'ajk',              name: 'AJK',              geojsonProvince: 'Azad Kashmir',              color: '#ffffff' },
  { id: 'islamabad',        name: 'Federal Capital',  geojsonProvince: 'Federal Capital',           color: '#ffffff' },
];
