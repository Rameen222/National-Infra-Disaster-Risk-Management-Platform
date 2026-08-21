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
  esriImagery: {
    version: 8,
    sources: {
      'esri-world-imagery': {
        type: 'raster',
        tiles: [
          'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
        ],
        tileSize: 256,
        attribution: 'Esri, Maxar, Earthstar Geographics',
        maxzoom: 18,
      },
    },
    layers: [
      {
        id: 'esri-world-imagery',
        type: 'raster',
        source: 'esri-world-imagery',
      },
    ],
  },
  googleSatellite: {
    version: 8,
    sources: {
      'google-satellite': {
        type: 'raster',
        tiles: [
          'https://mt1.google.com/vt/lyrs=s&x={x}&y={y}&z={z}',
        ],
        tileSize: 256,
        attribution: 'Google',
        maxzoom: 20,
      },
    },
    layers: [
      {
        id: 'google-satellite',
        type: 'raster',
        source: 'google-satellite',
      },
    ],
  },
  googleHybrid: {
    version: 8,
    sources: {
      'google-hybrid': {
        type: 'raster',
        tiles: [
          'https://mt1.google.com/vt/lyrs=y&x={x}&y={y}&z={z}',
        ],
        tileSize: 256,
        attribution: 'Google',
        maxzoom: 20,
      },
    },
    layers: [
      {
        id: 'google-hybrid',
        type: 'raster',
        source: 'google-hybrid',
      },
    ],
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
