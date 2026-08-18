import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import { MAP_CONFIG, PROVINCES } from '../../config/mapConfig';
import { INFRA_LAYERS } from '../../config/infraLayers';
import { buildingTileUrl } from '../../utils/buildingData';
import StyleModal from './StyleModal';
import useDrag from '../../hooks/useDrag';
import './MapContainer.css';

mapboxgl.accessToken = MAP_CONFIG.accessToken;

const FLOOD_SOURCES = [
  { year: '2010', url: '/flood/Flood_2010.geojson' },
  { year: '2022', url: '/flood/Flood_2022.geojson' },
  { year: '2025', url: '/flood/Flood_2025.geojson' },
  // GB Flood Projection 2026 — the north waterways footprint.
  { year: 'gb-proj-2026', url: '/north_waterways_only_final.geojson' },
  { year: 'sus-1', url: '/flood/Flood_Sus.geojson', filterClass: 1 },
  { year: 'sus-2', url: '/flood/Flood_Sus.geojson', filterClass: 2 },
  { year: 'sus-3', url: '/flood/Flood_Sus.geojson', filterClass: 3 },
];

// "Flood Projections 2026" — a single legend entry backed by multiple GeoJSONs
// (all rendered together). Files live in /public/floodextent.
const FLOOD_PROJECTION_2026_FILES = [
  'DG khan HT.geojson',
  'astore1984.geojson',
  'gilgitriver_final.geojson',
  'hunza.geojson',
  'khfex.geojson',
  'limflex.geojson',
  'swat_HFEx.geojson',
  'uimfex.geojson',
];

// Map a legend layer's `year` to its map layer id pairs. Most years map to a
// single fill/line pair; the 2026 projection fans out across all its GeoJSONs.
function floodLayerIds(year) {
  if (year === 'proj-2026') {
    return FLOOD_PROJECTION_2026_FILES.map((_, i) => ({
      fillId: `flood-proj-2026-${i}-fill`,
      lineId: `flood-proj-2026-${i}-line`,
    }));
  }
  return [{ fillId: `flood-${year}-fill`, lineId: `flood-${year}-line` }];
}

// Compute a [[minLng, minLat], [maxLng, maxLat]] bounding box from an array of GeoJSON features
function getBbox(features) {
  let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
  const visit = (coord) => {
    if (typeof coord[0] === 'number') {
      if (coord[0] < minLng) minLng = coord[0];
      if (coord[1] < minLat) minLat = coord[1];
      if (coord[0] > maxLng) maxLng = coord[0];
      if (coord[1] > maxLat) maxLat = coord[1];
    } else {
      coord.forEach(visit);
    }
  };
  features.forEach((f) => visit(f.geometry.coordinates));
  return [[minLng, minLat], [maxLng, maxLat]];
}

// ── Point-in-polygon helpers ─────────────────────────────────────────
// Used to slice the province-wide GB tehsil layer down to the tehsils that
// fall inside a selected district, without relying on attribute spelling.
function ringContains(ring, x, y) {
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
function polygonContains(rings, x, y) {
  if (!ringContains(rings[0], x, y)) return false;
  for (let k = 1; k < rings.length; k++) {
    if (ringContains(rings[k], x, y)) return false;
  }
  return true;
}

function geomContainsPoint(geom, x, y) {
  if (!geom) return false;
  if (geom.type === 'Polygon') return polygonContains(geom.coordinates, x, y);
  if (geom.type === 'MultiPolygon') return geom.coordinates.some((poly) => polygonContains(poly, x, y));
  return false;
}

// Average of the largest ring's vertices — a cheap representative point that
// reliably lands inside its own (much larger) district polygon.
function representativePoint(geom) {
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

function MapContainer({ selectedProvince, selectedDistrict, sidebarCollapsed, onToggleSidebar, districtsGeoJSON, onProvinceSelect, onDistrictSelect, isNationalView, floodLayers, showBuildings, activeBuildingDistrict, onBuildingsLoading, encroachedMapDistrict, encroachmentLayers, encroachReloadKey, searchResult, exposureGeoJSON, onStreamClick, gcopGeoJSON, simexBuildingsGeoJSON, tehsilBuildingsGeoJSON, tehsilScenarioClipGeoJSON, onTehsilSelect, infraLayers, onInfraLayerToggle, mapFocusFeatures }) {

  const mapContainerRef = useRef(null);
  const mapRef = useRef(null);
  // Keep latest callbacks accessible inside map event handlers without re-registering
  const onProvinceSelectRef = useRef(onProvinceSelect);
  useEffect(() => { onProvinceSelectRef.current = onProvinceSelect; }, [onProvinceSelect]);
  const onDistrictSelectRef = useRef(onDistrictSelect);
  useEffect(() => { onDistrictSelectRef.current = onDistrictSelect; }, [onDistrictSelect]);
  const onTehsilSelectRef = useRef(onTehsilSelect);
  useEffect(() => { onTehsilSelectRef.current = onTehsilSelect; }, [onTehsilSelect]);
  const tehsilClickRef = useRef({}); // fillLayerId → { onClick, onEnter, onLeave }
  const selectedProvinceRef = useRef(selectedProvince);
  useEffect(() => { selectedProvinceRef.current = selectedProvince; }, [selectedProvince]);
  const [activeStyle, setActiveStyle] = useState(MAP_CONFIG.defaultStyle);
  const [mapLoaded, setMapLoaded] = useState(false);
  const [showLabels, setShowLabels] = useState(false);
  const [showProvinceLabels, setShowProvinceLabels] = useState(false);
  const [showDistrictLabels, setShowDistrictLabels] = useState(true);
  // Tehsil overlays are pulled from GeoServer as WFS vector GeoJSON (one layer
  // per country/province/district) so features are interactive (hover tooltip).
  const [showCountryTehsils, setShowCountryTehsils] = useState(false);
  const [showProvinceTehsils, setShowProvinceTehsils] = useState(false);
  // District tehsils default ON so the moment a district is selected its
  // tehsil names and boundaries are visible (and clickable) without the user
  // opening the Tehsils panel first.
  const [showDistrictTehsils, setShowDistrictTehsils] = useState(true);
  const [tehsilsPanelOpen, setTehsilsPanelOpen] = useState(false);
  const [tehsilsLoading, setTehsilsLoading] = useState(false);
  // key ('country'|'province'|'district') → error message, so a failed WFS
  // fetch is visible in the Tehsils panel instead of only logging to console.
  const [tehsilErrors, setTehsilErrors] = useState({});
  const tehsilAbortRef = useRef({});   // key → in-flight AbortController
  const [modalOpen, setModalOpen] = useState(false);
  const [stylePanelOpen, setStylePanelOpen] = useState(false);
  const [labelsPanelOpen, setLabelsPanelOpen] = useState(false);
  const [isFetchingBuildings, setIsFetchingBuildings] = useState(false);
  // URL of the affected-house photo currently shown full-size, or null.
  // Set by the raw-HTML popup's onclick (see attachAffectedHousesPopup)
  // via the window.__openAffecteePhoto bridge below.
  const [enlargedPhoto, setEnlargedPhoto] = useState(null);
  const [infraLayersMenuOpen, setInfraLayersMenuOpen] = useState(false);
  // { top, right } in viewport px — computed from the trigger button's own
  // position when opened, since the dropdown is portaled straight to
  // document.body (see render) and can no longer rely on being positioned
  // relative to its trigger in the DOM.
  const [infraLayersMenuPos, setInfraLayersMenuPos] = useState({ top: 0, right: 0 });
  const infraLayersMenuRef = useRef(null);
  const infraLayersDropdownRef = useRef(null);
  const { pos: stylePanelPos, onMouseDown: onStylePanelDrag, setPos: setStylePanelPos } = useDrag(270, 100);
  const { pos: labelsPanelPos, onMouseDown: onLabelsPanelDrag, setPos: setLabelsPanelPos } = useDrag(310, 100);
  // Anchor a popup under whichever button just opened it — the toolbar
  // shifts right as the sidebars open/close, so a fixed initial position
  // (the useDrag defaults above) would drift out from under the button and
  // end up overlapping the sidebars instead. Still fully draggable after.
  const anchorPanelBelow = (e, setPos) => {
    const r = e.currentTarget.getBoundingClientRect();
    setPos({ x: Math.round(r.left), y: Math.round(r.bottom + 8) });
  };
  const provinceLabelsGeoJSONRef = useRef(null);
  const [layerStyle, setLayerStyle] = useState({
    visible: true,
    fillColor: '#00e1ff',
    strokeColor: '#f4e04d',
    fillOpacity: 0,
    strokeOpacity: 1,
    strokeWidth: 2,
  });
  const [provBoundaryStyle, setProvBoundaryStyle] = useState({
    visible: true,
    fillColor: '#ff9800',
    strokeColor: '#ff6bdf',
    fillOpacity: 0,
    strokeOpacity: 1,
    strokeWidth: 2.5,
  });
  const [districtSelectedStyle, setDistrictSelectedStyle] = useState({
    visible: true,
    fillColor: '#ffd700',
    strokeColor: '#ffd700',
    fillOpacity: 0,   // no fill — solid outline only
    strokeOpacity: 1,
    strokeWidth: 4,
  });

  // Compute province centroid points from districts GeoJSON for the province label layer
  const provinceLabelsGeoJSON = useMemo(() => {
    if (!districtsGeoJSON) return null;
    const provinceFeatures = {};
    districtsGeoJSON.features.forEach((f) => {
      const prov = f.properties.province;
      if (!provinceFeatures[prov]) provinceFeatures[prov] = [];
      provinceFeatures[prov].push(f);
    });
    return {
      type: 'FeatureCollection',
      features: Object.entries(provinceFeatures).map(([name, features]) => {
        const [[minLng, minLat], [maxLng, maxLat]] = getBbox(features);
        return {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [(minLng + maxLng) / 2, (minLat + maxLat) / 2] },
          properties: { name },
        };
      }),
    };
  }, [districtsGeoJSON]);

  // Keep ref in sync for access inside style.load callbacks
  useEffect(() => { provinceLabelsGeoJSONRef.current = provinceLabelsGeoJSON; }, [provinceLabelsGeoJSON]);

  const activeFloodLayersRef = useRef(floodLayers);
  useEffect(() => { activeFloodLayersRef.current = floodLayers; }, [floodLayers]);
  const layerStyleRef = useRef(layerStyle);
  useEffect(() => { layerStyleRef.current = layerStyle; }, [layerStyle]);
  const provBoundaryStyleRef = useRef(provBoundaryStyle);
  useEffect(() => { provBoundaryStyleRef.current = provBoundaryStyle; }, [provBoundaryStyle]);
  const districtSelectedStyleRef = useRef(districtSelectedStyle);
  useEffect(() => { districtSelectedStyleRef.current = districtSelectedStyle; }, [districtSelectedStyle]);

  // Resize map after sidebar transition (0.25s) completes
  useEffect(() => {
    if (!mapRef.current) return;
    const timer = setTimeout(() => mapRef.current.resize(), 300);
    return () => clearTimeout(timer);
  }, [sidebarCollapsed]);

  // Resize map when the second sidebar (province/district/tehsil context
  // panel) mounts or unmounts — it's a real flex sibling that changes
  // .map-wrapper's width, not an overlay, so Mapbox's canvas must be told
  // its container changed. This has no CSS transition to wait out (the
  // panel mounts instantly), so resize immediately rather than on a
  // timer — must run before the fitBounds effects below, which is
  // guaranteed by effects firing in declaration order.
  useEffect(() => {
    if (!mapRef.current) return;
    mapRef.current.resize();
  }, [selectedProvince, isNationalView]);

  // Initialize map
  useEffect(() => {
    if (mapRef.current) return;

    const map = new mapboxgl.Map({
      container: mapContainerRef.current,
      style: MAP_CONFIG.styles[MAP_CONFIG.defaultStyle],
      center: MAP_CONFIG.defaultCenter,
      zoom: MAP_CONFIG.defaultZoom,
      minZoom: MAP_CONFIG.minZoom,
      maxZoom: MAP_CONFIG.maxZoom,
    });

    map.addControl(new mapboxgl.NavigationControl({ showCompass: true }), 'top-right');
    map.addControl(new mapboxgl.ScaleControl({ unit: 'metric' }), 'bottom-right');
    map.addControl(new mapboxgl.FullscreenControl(), 'top-right');

    map.on('load', () => {
      setMapLoaded(true);
      hideLabels(map);
      addDarkOverlay(map);
      loadPakistanBoundary(map);
      loadDistrictsLayer(map);
      loadFloodLayers(map);
      loadInfraLayers(map);
    });

    mapRef.current = map;

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // Fit map to selected province
  useEffect(() => {
    if (!mapRef.current || !districtsGeoJSON || !selectedProvince) return;
    const province = PROVINCES.find((p) => p.id === selectedProvince);
    if (!province) return;
    const features = districtsGeoJSON.features.filter(
      (f) => f.properties.province === province.geojsonProvince
    );
    if (!features.length) return;
    mapRef.current.fitBounds(getBbox(features), { padding: 40, duration: 1500 });
  }, [selectedProvince, districtsGeoJSON]);

  // Fit map to selected district
  useEffect(() => {
    if (!mapRef.current || !districtsGeoJSON || !selectedDistrict) return;
    const features = districtsGeoJSON.features.filter(
      (f) => f.properties.name === selectedDistrict
    );
    if (!features.length) return;
    mapRef.current.fitBounds(getBbox(features), { padding: 60, duration: 1500 });
  }, [selectedDistrict, districtsGeoJSON]);

  // Imperative re-focus requested by the second sidebar's back navigation
  // (tehsil -> district -> province zoom-out) — the province/district
  // effects above only fire when that *value* changes, which doesn't
  // happen when re-fitting to the same district/province you're already
  // on, so this is a separate channel: any array of {geometry} features,
  // fit to it every time a new one is passed (a fresh array is always
  // !== the previous one, so this fires on every call, including repeats).
  useEffect(() => {
    if (!mapRef.current || !mapFocusFeatures || !mapFocusFeatures.length) return;
    mapRef.current.fitBounds(getBbox(mapFocusFeatures), { padding: 60, duration: 1200 });
  }, [mapFocusFeatures]);

  // Fly to geocoded search result
  useEffect(() => {
    if (!searchResult || !mapRef.current || !mapLoaded) return;
    const map = mapRef.current;
    if (searchResult.bbox) {
      map.fitBounds(searchResult.bbox, { padding: 60, duration: 1400 });
    } else {
      const zoom = searchResult.placeType === 'region' ? 7
        : searchResult.placeType === 'district' ? 9
        : searchResult.placeType === 'place' ? 11
        : 13;
      map.flyTo({ center: searchResult.center, zoom, duration: 1400 });
    }
  }, [searchResult, mapLoaded]);

  // Hide all symbol (label) layers from the basemap style
  const hideLabels = (map) => {
    map.getStyle().layers.forEach((layer) => {
      if (layer.type === 'symbol') {
        map.setLayoutProperty(layer.id, 'visibility', 'none');
      }
    });
  };

  // Show all symbol (label) layers
  const showAllLabels = (map) => {
    map.getStyle().layers.forEach((layer) => {
      if (layer.type === 'symbol') {
        map.setLayoutProperty(layer.id, 'visibility', 'visible');
      }
    });
  };

  // Toggle labels on/off
  const toggleLabels = () => {
    const map = mapRef.current;
    if (!map) return;
    const next = !showLabels;
    setShowLabels(next);
    if (next) showAllLabels(map); else hideLabels(map);
  };

  // Add a semi-transparent dark fill over the whole world to slightly darken the basemap
  const addDarkOverlay = (map) => {
    map.addSource('dark-overlay-src', {
      type: 'geojson',
      data: {
        type: 'Feature',
        geometry: {
          type: 'Polygon',
          coordinates: [[[-180, -90], [180, -90], [180, 90], [-180, 90], [-180, -90]]],
        },
      },
    });
    map.addLayer({
      id: 'dark-overlay',
      type: 'fill',
      source: 'dark-overlay-src',
      paint: {
        'fill-color': '#000000',
        'fill-opacity': 0.28,
      },
    });
  };

  // Add province name label layer using computed centroid points
  const loadProvinceLabelsLayer = (map, geojson) => {
    if (!map.isStyleLoaded()) return;
    if (map.getSource('province-labels-src')) return;
    map.addSource('province-labels-src', { type: 'geojson', data: geojson });
    map.addLayer({
      id: 'province-labels',
      type: 'symbol',
      source: 'province-labels-src',
      layout: {
        visibility: 'none',
        'text-field': ['get', 'name'],
        'text-size': 14,
        'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'],
        'text-anchor': 'center',
        'text-max-width': 10,
      },
      paint: {
        'text-color': '#ffffff',
        'text-halo-color': '#1a1a2e',
        'text-halo-width': 2,
      },
    });
  };

  // Load Pakistan boundary GeoJSON
  const loadPakistanBoundary = (map) => {
    const s = layerStyleRef.current;
    const vis = s.visible ? 'visible' : 'none';
    map.addSource('pakistan-boundary', {
      type: 'geojson',
      data: '/pakistan_boundary_official.geojson',
    });

    map.addLayer({
      id: 'pakistan-boundary-fill',
      type: 'fill',
      source: 'pakistan-boundary',
      layout: { visibility: vis },
      paint: {
        'fill-color': s.fillColor,
        'fill-opacity': s.fillOpacity,
      },
    });

    map.addLayer({
      id: 'pakistan-boundary-line',
      type: 'line',
      source: 'pakistan-boundary',
      layout: { visibility: vis },
      paint: {
        'line-color': s.strokeColor,
        'line-width': s.strokeWidth,
        'line-opacity': s.strokeOpacity,
      },
    });
  };

  const applyLayerStyle = (style) => {
    setLayerStyle(style);
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;
    const vis = style.visible ? 'visible' : 'none';
    if (map.getLayer('pakistan-boundary-fill')) {
      map.setLayoutProperty('pakistan-boundary-fill', 'visibility', vis);
      map.setPaintProperty('pakistan-boundary-fill', 'fill-color', style.fillColor);
      map.setPaintProperty('pakistan-boundary-fill', 'fill-opacity', style.fillOpacity);
    }
    if (map.getLayer('pakistan-boundary-line')) {
      map.setLayoutProperty('pakistan-boundary-line', 'visibility', vis);
      map.setPaintProperty('pakistan-boundary-line', 'line-color', style.strokeColor);
      map.setPaintProperty('pakistan-boundary-line', 'line-opacity', style.strokeOpacity);
      map.setPaintProperty('pakistan-boundary-line', 'line-width', style.strokeWidth);
    }
  };

  const applyProvBoundaryStyle = (style) => {
    setProvBoundaryStyle(style);
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;
    // Only show province district outlines when a province is selected AND
    // the layer is set to visible.
    const vis = (style.visible && selectedProvince) ? 'visible' : 'none';
    if (map.getLayer('pakistan-districts-fill')) {
      map.setLayoutProperty('pakistan-districts-fill', 'visibility', vis);
      map.setPaintProperty('pakistan-districts-fill', 'fill-opacity', style.fillOpacity);
    }
    if (map.getLayer('pakistan-districts-line')) {
      map.setLayoutProperty('pakistan-districts-line', 'visibility', vis);
      map.setPaintProperty('pakistan-districts-line', 'line-opacity', style.strokeOpacity);
      map.setPaintProperty('pakistan-districts-line', 'line-width', style.strokeWidth);
    }
    if (map.getLayer('pakistan-districts-labels')) {
      // While a district's tehsils are focused the district's own name label is
      // suppressed (the tehsil labels replace it) — even here.
      map.setLayoutProperty('pakistan-districts-labels', 'visibility',
        (style.visible && selectedProvince && showDistrictLabels && !(showDistrictTehsils && selectedDistrict)) ? 'visible' : 'none');
    }
  };

  const applyDistrictSelectedStyle = (style) => {
    setDistrictSelectedStyle(style);
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;
    // Only show the highlight when both: layer is set to visible AND a district
    // is actually selected. Hide otherwise.
    const vis = (style.visible && selectedDistrict) ? 'visible' : 'none';
    if (map.getLayer('pakistan-district-selected-fill')) {
      map.setLayoutProperty('pakistan-district-selected-fill', 'visibility', vis);
      map.setPaintProperty('pakistan-district-selected-fill', 'fill-color', style.fillColor);
      map.setPaintProperty('pakistan-district-selected-fill', 'fill-opacity', style.fillOpacity);
    }
    if (map.getLayer('pakistan-district-selected-line')) {
      map.setLayoutProperty('pakistan-district-selected-line', 'visibility', vis);
      map.setPaintProperty('pakistan-district-selected-line', 'line-color', style.strokeColor);
      map.setPaintProperty('pakistan-district-selected-line', 'line-opacity', style.strokeOpacity);
      map.setPaintProperty('pakistan-district-selected-line', 'line-width', style.strokeWidth);
    }
  };

  // Load flood GeoJSON sources and layers (hidden by default, red)
  const loadFloodLayers = (map) => {
    FLOOD_SOURCES.forEach(({ year, url, filterClass }) => {
      const srcId = `flood-${year}-src`;
      const fillId = `flood-${year}-fill`;
      const lineId = `flood-${year}-line`;
      if (map.getSource(srcId)) return;
      map.addSource(srcId, { type: 'geojson', data: url });

      const isSus = filterClass != null;
      const filter = isSus ? ['==', ['get', 'class'], filterClass] : undefined;

      map.addLayer({
        id: fillId,
        type: 'fill',
        source: srcId,
        ...(filter && { filter }),
        layout: { visibility: 'none' },
        paint: { 'fill-color': '#e53935', 'fill-opacity': 0.35 },
      });
      map.addLayer({
        id: lineId,
        type: 'line',
        source: srcId,
        ...(filter && { filter }),
        layout: { visibility: 'none' },
        paint: { 'line-color': '#e53935', 'line-width': 1.2, 'line-opacity': 0.8 },
      });
    });

    // Flood Projections 2026 — one source/fill/line per GeoJSON, all toggled
    // together via the single `proj-2026` legend entry.
    FLOOD_PROJECTION_2026_FILES.forEach((file, i) => {
      const srcId = `flood-proj-2026-${i}-src`;
      const fillId = `flood-proj-2026-${i}-fill`;
      const lineId = `flood-proj-2026-${i}-line`;
      if (map.getSource(srcId)) return;
      map.addSource(srcId, { type: 'geojson', data: `/floodextent/${encodeURIComponent(file)}` });
      map.addLayer({
        id: fillId,
        type: 'fill',
        source: srcId,
        layout: { visibility: 'none' },
        paint: { 'fill-color': '#1e88e5', 'fill-opacity': 0.35 },
      });
      map.addLayer({
        id: lineId,
        type: 'line',
        source: srcId,
        layout: { visibility: 'none' },
        paint: { 'line-color': '#1e88e5', 'line-width': 1.2, 'line-opacity': 0.8 },
      });
    });
  };

  // Load the optional infrastructure overlay layers (Rivers, Roads,
  // Hospitals, Schools, Dams, …) from config/infraLayers.js. Hidden by
  // default; visibility/order is applied by the effect below, mirroring
  // loadFloodLayers/the flood visibility effect exactly.
  const iconAvailable = (map, name) => map.hasImage(name);

  // Click/hover wiring specific to the Affected Houses layer — a photo
  // popup isn't something any other infra layer needs, so this is kept
  // targeted rather than built into the generic loader below.
  const attachAffectedHousesPopup = (map, layerId) => {
    map.on('mouseenter', layerId, () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', layerId, () => { map.getCanvas().style.cursor = ''; });
    map.on('click', layerId, (e) => {
      const p = e.features[0]?.properties;
      if (!p) return;
      let affectees = [];
      let photos = [];
      try { affectees = JSON.parse(p.affectees); } catch { /* malformed/absent */ }
      try { photos = JSON.parse(p.photos); } catch { /* malformed/absent */ }

      // One "Affectee Name: X s/o Y" line per affectee — inline label:value,
      // matching the rest of the app's normal body text rather than tiny
      // uppercase micro-labels.
      const affecteesHtml = affectees.map((a) => `
        <div class="affected-popup-line">
          <span class="affected-popup-label">Affectee Name:</span>
          ${a.affectee} <span class="affected-popup-father">s/o ${a.father_name}</span>
        </div>
      `).join('');
      const photosHtml = photos.map(({ photo }) => `
        <img class="affected-popup-photo" src="${photo}" loading="lazy" decoding="async"
             onerror="this.style.display='none'"
             onclick="window.__openAffecteePhoto && window.__openAffecteePhoto('${photo}')" />
      `).join('');
      const heading = [p.event || 'Flash Flood', p.event_date].filter(Boolean).join(' ');
      const subtitle = [p.moza ? `Village ${p.moza}` : null, p.district ? `District ${p.district}, GB` : null]
        .filter(Boolean).join(' ');
      const coords = [p.lat_dms, p.lon_dms].filter(Boolean).join(', ');

      new mapboxgl.Popup({ closeButton: true, maxWidth: '315px', offset: 14 })
        .setLngLat(e.lngLat)
        .setHTML(`
          <div class="affected-popup">
            <div class="affected-popup-title">${heading}</div>
            <div class="affected-popup-subtitle">${subtitle}</div>
            <div class="affected-popup-divider"></div>
            ${affecteesHtml}
            ${coords ? `<div class="affected-popup-line"><span class="affected-popup-label">Coordinates:</span> ${coords}</div>` : ''}
            ${photos.length ? `<div class="affected-popup-photos">${photosHtml}</div><div class="affected-popup-hint">Click a photo to enlarge</div>` : ''}
          </div>
        `)
        .addTo(map);
    });
  };

  const loadInfraLayers = (map) => {
    const getFallbackIcon = (name) => iconAvailable(map, name) ? name : 'marker-15';

    INFRA_LAYERS.forEach((layer) => {
      const srcId = `infra-${layer.id}-src`;
      if (map.getSource(srcId)) return;
      map.addSource(srcId, { type: 'geojson', data: layer.source });

      if (layer.type === 'line') {
        map.addLayer({
          id: `infra-${layer.id}-line`,
          type: 'line',
          source: srcId,
          layout: { visibility: 'none' },
          paint: {
            'line-color': layer.style.lineColor,
            'line-width': layer.style.lineWidth,
            'line-opacity': layer.style.lineOpacity,
          },
        });
      } else if (layer.type === 'circle') {
        map.addLayer({
          id: `infra-${layer.id}-circle`,
          type: 'circle',
          source: srcId,
          layout: { visibility: 'none' },
          paint: {
            'circle-color': layer.style.circleColor,
            'circle-radius': layer.style.circleRadius,
            'circle-opacity': layer.style.circleOpacity,
            'circle-stroke-color': '#0b0f0e',
            'circle-stroke-width': 1,
          },
        });
      } else if (layer.type === 'symbol') {
        const customIconName = layer.style.iconUrl ? `infra-icon-${layer.id}` : null;

        // customIconLoaded reflects whether the custom image actually made it
        // into the style (map.addImage succeeded) — if it didn't (bad URL,
        // undecodable format, ...), fall back to the maki-sprite marker with
        // icon-color tinting instead of silently rendering nothing, which is
        // exactly what happened here once already (SVG fetched fine but
        // Mapbox's loadImage/addImage can't decode SVG, only raster formats).
        const addSymbolLayer = (customIconLoaded) => {
          if (map.getLayer(`infra-${layer.id}-symbol`)) return;
          const useCustom = customIconName && customIconLoaded;
          const iconName = useCustom ? customIconName : getFallbackIcon(layer.style.iconImage);
          map.addLayer({
            id: `infra-${layer.id}-symbol`,
            type: 'symbol',
            source: srcId,
            layout: {
              visibility: 'none',
              'icon-image': iconName,
              'icon-size': layer.style.iconSizeStops
                // Larger when zoomed out, smaller when zoomed in — see the
                // registry entry for why (not the usual convention).
                ? ['interpolate', ['linear'], ['zoom'], ...layer.style.iconSizeStops.flat()]
                : (layer.style.iconSize ?? 1.1),
              'icon-anchor': useCustom ? 'bottom' : 'center',
              'icon-allow-overlap': true,
              'icon-ignore-placement': true,
            },
            // Custom icons bake their color into the raster image and aren't
            // loaded as SDF, so icon-color would be a no-op for them — only
            // apply it to the maki-sprite fallback.
            paint: useCustom ? {
              'icon-opacity': layer.style.iconOpacity ?? 1,
            } : {
              'icon-color': layer.style.iconColor,
              'icon-opacity': layer.style.iconOpacity ?? 1,
            },
          });
          if (layer.id === 'affected_houses') attachAffectedHousesPopup(map, `infra-${layer.id}-symbol`);
        };

        if (customIconName && !map.hasImage(customIconName)) {
          map.loadImage(layer.style.iconUrl, (err, image) => {
            let loaded = false;
            if (!err && image) {
              if (!map.hasImage(customIconName)) map.addImage(customIconName, image);
              loaded = true;
            } else {
              console.warn(`[infra layer "${layer.id}"] custom icon failed to load (${layer.style.iconUrl}), falling back to default marker`, err);
            }
            addSymbolLayer(loaded);
          });
        } else {
          addSymbolLayer(!!customIconName);
        }
      } else if (layer.type === 'fill') {
        map.addLayer({
          id: `infra-${layer.id}-fill`,
          type: 'fill',
          source: srcId,
          layout: { visibility: 'none' },
          paint: {
            'fill-color': layer.style.fillColor,
            'fill-opacity': layer.style.fillOpacity ?? 0.4,
          },
        });
        map.addLayer({
          id: `infra-${layer.id}-line`,
          type: 'line',
          source: srcId,
          layout: { visibility: 'none' },
          paint: {
            'line-color': layer.style.strokeColor || layer.style.fillColor,
            'line-width': layer.style.strokeWidth || 1,
          },
        });
      }
    });
  };

  // Height-based color scheme for buildings (6 classes)
  const BUILDING_HEIGHT_COLORS = [
    [0,  '#2196F3', '0–3 m'],
    [3,  '#4CAF50', '3–6 m'],
    [6,  '#FFEB3B', '6–10 m'],
    [10, '#FF9800', '10–15 m'],
    [15, '#F44336', '15–25 m'],
    [25, '#9C27B0', '25+ m'],
  ];
  const HEIGHT_SCALE = 8;
  const BUILDING_3D_ZOOM = 13;

  const buildColorExpr = () => {
    const expr = ['step', ['coalesce', ['get', 'height'], 0]];
    BUILDING_HEIGHT_COLORS.forEach(([t, c], i) => { if (i === 0) expr.push(c); else expr.push(t, c); });
    return expr;
  };

  const activeBuildingDistrictRef = useRef(activeBuildingDistrict);
  useEffect(() => { activeBuildingDistrictRef.current = activeBuildingDistrict; }, [activeBuildingDistrict]);
  const isAutoAnimatingRef = useRef(false);

  // Load district buildings as a vector tile source from tileserver-gl
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoaded) return;

    ['district-buildings-3d', 'district-buildings-line', 'district-buildings-fill'].forEach((id) => {
      if (map.getLayer(id)) map.removeLayer(id);
    });
    if (map.getSource('district-buildings-src')) map.removeSource('district-buildings-src');

    if (!activeBuildingDistrict?.districtKey || !showBuildings) {
      if (map.getPitch() > 0) map.easeTo({ pitch: 0, bearing: 0, duration: 800 });
      return;
    }

    const { districtKey } = activeBuildingDistrict;

    map.addSource('district-buildings-src', {
      type: 'vector',
      tiles: [buildingTileUrl(districtKey)],
      minzoom: 4,
      maxzoom: 16,
    });

    const colorExpr = buildColorExpr();
    const zoom = map.getZoom();

    if (zoom >= BUILDING_3D_ZOOM) {
      map.addLayer({
        id: 'district-buildings-3d',
        type: 'fill-extrusion',
        source: 'district-buildings-src',
        'source-layer': 'buildings',
        paint: {
          'fill-extrusion-color':   colorExpr,
          'fill-extrusion-height':  ['coalesce', ['get', 'height'], 3],
          'fill-extrusion-base':    ['coalesce', ['get', 'base_height'], 0],
          'fill-extrusion-opacity': 0.85,
        },
      });
      if (map.getPitch() < 40) {
        isAutoAnimatingRef.current = true;
        map.once('moveend', () => { isAutoAnimatingRef.current = false; });
        map.easeTo({ pitch: 55, bearing: -15, duration: 800 });
      }
    } else {
      map.addLayer({
        id: 'district-buildings-fill',
        type: 'fill',
        source: 'district-buildings-src',
        'source-layer': 'buildings',
        paint: { 'fill-color': colorExpr, 'fill-opacity': 0.75 },
      });
      map.addLayer({
        id: 'district-buildings-line',
        type: 'line',
        source: 'district-buildings-src',
        'source-layer': 'buildings',
        paint: { 'line-color': 'rgba(0,0,0,0.3)', 'line-width': 0.3 },
      });
    }

    ['enc-river-fill', 'enc-river-line', 'enc-buildings-fill', 'enc-buildings-line', 'enc-buildings-3d'].forEach((id) => {
      if (map.getLayer(id)) map.moveLayer(id);
    });
    // Ensure any optional infra overlays stay above the building layers.
    moveInfraAboveBuildings(map);

    // Zoom to district; fitBounds decides the final zoom so the initial 2D/3D
    if (districtsGeoJSON) {
      const feat = districtsGeoJSON.features.find(
        (f) => f.properties.name?.toLowerCase() === districtKey.toLowerCase()
      );
      if (feat) {
        const bbox = getBbox([feat]);
        map.fitBounds(bbox, { padding: 60, duration: 800 });
      }
    }
  }, [activeBuildingDistrict, showBuildings, mapLoaded]);

  // ── Encroachment overlay (river polygon + encroached buildings) ──────
  // Two GeoJSON sources fetched from the Python backend; the layer styles
  // and rendering order are driven by the `encroachmentLayers` config so
  // the user can toggle/reorder/recolor each layer from the sidebar.
  const ENCROACH_SOURCES = {
    'enc-river':     { url: 'clipped',   srcId: 'enc-river-src' },
    'enc-buildings': { url: 'geojson',   srcId: 'enc-buildings-src' },
  };

  const encroachFetchRef = useRef(null);
  const encroachLayersRef = useRef(encroachmentLayers);
  useEffect(() => { encroachLayersRef.current = encroachmentLayers; }, [encroachmentLayers]);

  useEffect(() => {
    const map = mapRef.current;
    console.log('[encroach] effect run', { encroachedMapDistrict, mapLoaded, encroachReloadKey, hasMap: !!map, styleLoaded: map?.isStyleLoaded() });
    if (!map || !mapLoaded || !map.isStyleLoaded()) {
      console.log('[encroach] effect early exit — map/style not ready');
      return;
    }

    const removeAll = () => {
      if (encroachFetchRef.current) encroachFetchRef.current.abort();
      Object.keys(ENCROACH_SOURCES).forEach((id) => {
        [`${id}-3d`, `${id}-line`, `${id}-fill`].forEach((layerId) => {
          if (map.getLayer(layerId)) map.removeLayer(layerId);
        });
        const { srcId } = ENCROACH_SOURCES[id];
        if (map.getSource(srcId)) map.removeSource(srcId);
      });
    };

    if (!encroachedMapDistrict) { removeAll(); return; }

    removeAll();
    encroachFetchRef.current = new AbortController();
    const signal = encroachFetchRef.current.signal;
    const district = encroachedMapDistrict;
    console.log(`[encroach] fetching layers for ${district}…`);

    // Fetch both layers in parallel; add them atomically only after BOTH
    // resolve. This avoids the race where one .then ran before the other,
    // leading to inconsistent ordering / partial visibility.
    const fetchOne = (id) => {
      const { url, srcId } = ENCROACH_SOURCES[id];
      const fetchUrl = `/pyapi/buildings/encroachment/${url}?district=${encodeURIComponent(district)}`;
      return fetch(fetchUrl, { signal })
        .then((r) => {
          if (r.ok) return r.json();
          // 404 → trigger backend processing then retry once
          if (r.status === 404) {
            return fetch('/pyapi/buildings/encroachment', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ district }),
              signal,
            })
              .then((p) => p.ok ? p.json() : Promise.reject(new Error(`POST ${p.status}`)))
              .then((data) => {
                if (data.status !== 'done') {
                  return Promise.reject(new Error('processing-not-ready'));
                }
                return fetch(fetchUrl, { signal })
                  .then((r2) => r2.ok ? r2.json() : Promise.reject(new Error(`retry ${r2.status}`)));
              });
          }
          return Promise.reject(new Error(`${r.status}`));
        })
        .then((geojson) => ({ id, srcId, geojson }));
    };

    const tasks = Object.keys(ENCROACH_SOURCES).map(fetchOne);

    // allSettled so a failure in one layer still lets the other render
    Promise.allSettled(tasks)
      .then((settled) => {
        const m = mapRef.current;
        if (!m || !m.isStyleLoaded()) {
          console.warn('[encroach] add skipped — map/style not ready at resolve');
          return;
        }
        // The effect cleanup may have already wiped sources/layers if the
        // effect re-ran between fetch start and resolve. Skip in that case;
        // the new effect run will add the fresh layers.
        if (signal.aborted) {
          console.log('[encroach] add skipped — signal aborted');
          return;
        }

        const results = [];
        settled.forEach((s) => {
          if (s.status === 'fulfilled') results.push(s.value);
          else if (s.reason?.name !== 'AbortError') console.error('[encroach] one layer failed:', s.reason?.message);
        });

        const layersNow = encroachLayersRef.current || [];

        results.forEach(({ id, srcId, geojson }) => {
          console.log(`[encroach] ${id} fetched`, { features: geojson?.features?.length ?? 0 });
          if (!geojson?.features?.length) {
            console.warn(`[encroach] ${id} 0 features — skipping layer add`);
            return;
          }
          const cfg = layersNow.find((l) => l.id === id) || {
            visible: true, fillColor: '#ffffff', fillOpacity: 0.4,
            strokeColor: '#ffffff', strokeOpacity: 0.7, strokeWidth: 0.6,
          };
          const isBuildings = id === 'enc-buildings';
          const fillColorPaint = isBuildings ? buildColorExpr() : cfg.fillColor;
          const visTok = cfg.visible ? 'visible' : 'none';

          // Defensive: drop any stale layers/source before re-adding
          [`${id}-3d`, `${id}-line`, `${id}-fill`].forEach((layerId) => {
            if (m.getLayer(layerId)) m.removeLayer(layerId);
          });
          if (m.getSource(srcId)) m.removeSource(srcId);

          try {
            m.addSource(srcId, { type: 'geojson', data: geojson });
            const useExtrusion = isBuildings && m.getZoom() >= BUILDING_3D_ZOOM;
            if (useExtrusion) {
              m.addLayer({
                id: `${id}-3d`, type: 'fill-extrusion', source: srcId,
                layout: { visibility: visTok },
                paint: {
                  'fill-extrusion-color': buildColorExpr(),
                  'fill-extrusion-height': ['*', ['coalesce', ['to-number', ['get', 'height']], 3], HEIGHT_SCALE],
                  'fill-extrusion-base': 0,
                  'fill-extrusion-opacity': Math.max(0.6, cfg.fillOpacity),
                },
              });
            } else {
              m.addLayer({
                id: `${id}-fill`, type: 'fill', source: srcId,
                layout: { visibility: visTok },
                paint: { 'fill-color': fillColorPaint, 'fill-opacity': cfg.fillOpacity },
              });
              m.addLayer({
                id: `${id}-line`, type: 'line', source: srcId,
                layout: { visibility: visTok },
                paint: {
                  'line-color': cfg.strokeColor,
                  'line-opacity': cfg.strokeOpacity,
                  'line-width': cfg.strokeWidth,
                },
              });
            }
          } catch (e) {
            console.error(`[encroach] addLayer failed for ${id}:`, e);
          }
        });

        // Final ordering pass — last entry in encroachmentLayers ends up on top
        layersNow.forEach((layer) => {
          ['fill', 'line', '3d'].forEach((kind) => {
            const layerId = `${layer.id}-${kind}`;
            if (m.getLayer(layerId)) m.moveLayer(layerId);
          });
        });

        console.log('[encroach] all layers added', {
          present: ['enc-river-fill', 'enc-river-line', 'enc-buildings-fill', 'enc-buildings-line', 'enc-buildings-3d']
            .filter((id) => m.getLayer(id)),
        });
      })
      .catch((err) => {
        if (err.name === 'AbortError') { console.log('[encroach] aborted'); return; }
        console.error('[encroach] fetch error:', err.message);
      });

    return removeAll;
  }, [encroachedMapDistrict, mapLoaded, encroachReloadKey]);

  // ── Streams Exposure overlay ─────────────────────────────────────────
  // exposureGeoJSON is a joined FeatureCollection: each feature is a stream
  // geometry with the per-stream indicator counts merged onto its properties.
  // Clicking a feature emits its props back to the parent via onStreamClick.
  const onStreamClickRef = useRef(onStreamClick);
  useEffect(() => { onStreamClickRef.current = onStreamClick; }, [onStreamClick]);
  const exposureClickHandlerRef = useRef(null);
  const exposureMouseEnterRef = useRef(null);
  const exposureMouseLeaveRef = useRef(null);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoaded) return;

    const SRC = 'exposure-streams-src';
    const HALO_LAYER = 'exposure-streams-halo';
    const LINE_LAYER = 'exposure-streams-line';
    const HIT_LAYER = 'exposure-streams-hit';

    const cleanupListeners = () => {
      if (exposureClickHandlerRef.current) {
        map.off('click', HIT_LAYER, exposureClickHandlerRef.current);
        exposureClickHandlerRef.current = null;
      }
      if (exposureMouseEnterRef.current) {
        map.off('mouseenter', HIT_LAYER, exposureMouseEnterRef.current);
        exposureMouseEnterRef.current = null;
      }
      if (exposureMouseLeaveRef.current) {
        map.off('mouseleave', HIT_LAYER, exposureMouseLeaveRef.current);
        exposureMouseLeaveRef.current = null;
      }
    };

    const removeAll = () => {
      cleanupListeners();
      [HIT_LAYER, LINE_LAYER, HALO_LAYER].forEach((id) => {
        if (map.getLayer(id)) map.removeLayer(id);
      });
      if (map.getSource(SRC)) map.removeSource(SRC);
    };

    if (!exposureGeoJSON || !exposureGeoJSON.features?.length) {
      removeAll();
      return;
    }

    removeAll();

    map.addSource(SRC, { type: 'geojson', data: exposureGeoJSON });

    // Soft halo for visibility on busy basemaps
    map.addLayer({
      id: HALO_LAYER,
      type: 'line',
      source: SRC,
      paint: {
        'line-color': '#fde047',
        'line-width': 6,
        'line-opacity': 0.25,
        'line-blur': 2,
      },
    });

    // Main stream line — colour ramps with total population at the stream
    map.addLayer({
      id: LINE_LAYER,
      type: 'line',
      source: SRC,
      paint: {
        'line-color': [
          'interpolate', ['linear'],
          ['coalesce', ['to-number', ['get', 'population']], 0],
          0, '#fef08a',
          100, '#fb923c',
          1000, '#ef4444',
          10000, '#b91c1c',
        ],
        'line-width': 2.4,
        'line-opacity': 0.95,
      },
    });

    // Wide invisible hit layer makes clicking easier
    map.addLayer({
      id: HIT_LAYER,
      type: 'line',
      source: SRC,
      paint: { 'line-color': '#000', 'line-opacity': 0, 'line-width': 14 },
    });

    const onClick = (e) => {
      const feat = e.features?.[0];
      if (!feat) return;
      e.originalEvent?.stopPropagation?.();
      onStreamClickRef.current?.(feat.properties || {});
    };
    const onEnter = () => { map.getCanvas().style.cursor = 'pointer'; };
    const onLeave = () => { map.getCanvas().style.cursor = ''; };
    map.on('click', HIT_LAYER, onClick);
    map.on('mouseenter', HIT_LAYER, onEnter);
    map.on('mouseleave', HIT_LAYER, onLeave);
    exposureClickHandlerRef.current = onClick;
    exposureMouseEnterRef.current = onEnter;
    exposureMouseLeaveRef.current = onLeave;

    // Fit map to exposed streams so the user immediately sees what's loaded.
    try {
      const bbox = getBbox(exposureGeoJSON.features);
      map.fitBounds(bbox, { padding: 80, duration: 1200, maxZoom: 9 });
    } catch (err) {
      console.warn('[exposure] could not fit bounds:', err);
    }

    return removeAll;
  }, [exposureGeoJSON, mapLoaded]);

  // ── GCOP / DEW exposure overlay ──────────────────────────────────────
  // A polygon FeatureCollection (red fill + outline) plus an extra district
  // highlight that filters the existing pakistan-districts source to the
  // names mentioned in feature.properties.exposure_feature_assessment.
  // The blink behaviour pulses the highlight's fill-opacity 0↔1 every 500ms.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoaded) return;

    const FILL = 'gcop-exposure-fill';
    const LINE = 'gcop-exposure-line';
    const SRC = 'gcop-exposure-src';

    const remove = () => {
      [FILL, LINE].forEach((id) => { if (map.getLayer(id)) map.removeLayer(id); });
      if (map.getSource(SRC)) map.removeSource(SRC);
    };

    if (!gcopGeoJSON || !gcopGeoJSON.features?.length) {
      remove();
      return;
    }

    remove();
    map.addSource(SRC, { type: 'geojson', data: gcopGeoJSON });
    map.addLayer({
      id: FILL,
      type: 'fill',
      source: SRC,
      paint: {
        'fill-color': '#ef4444',
        'fill-opacity': 0.30,
        'fill-outline-color': '#ef4444',
      },
    });
    map.addLayer({
      id: LINE,
      type: 'line',
      source: SRC,
      paint: { 'line-color': '#ef4444', 'line-opacity': 1, 'line-width': 1.5 },
    });

    try {
      const bbox = getBbox(gcopGeoJSON.features);
      map.fitBounds(bbox, { padding: 60, duration: 1200, maxZoom: 9 });
    } catch (err) {
      console.warn('[gcop] fit bounds skipped:', err);
    }

    return remove;
  }, [gcopGeoJSON, mapLoaded]);

  // ── SIMEX pre-computed buildings overlay ────────────────────────────
  // Orange fill for buildings_inside_scenario from the HPC-processed shapefiles.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoaded) return;

    const SRC  = 'simex-buildings-src';
    const EXT  = 'simex-buildings-3d';
    const LINE = 'simex-buildings-line';

    const remove = () => {
      [EXT, LINE].forEach((id) => { if (map.getLayer(id)) map.removeLayer(id); });
      if (map.getSource(SRC)) map.removeSource(SRC);
    };

    if (!simexBuildingsGeoJSON || !simexBuildingsGeoJSON.features?.length) {
      remove();
      return;
    }

    remove();
    map.addSource(SRC, { type: 'geojson', data: simexBuildingsGeoJSON });

    map.addLayer({
      id: EXT,
      type: 'fill-extrusion',
      source: SRC,
      paint: {
        'fill-extrusion-color':   buildColorExpr(),
        // max(..., 3) ensures buildings with height=0 still show as 3 m extruded
        'fill-extrusion-height':  ['*', ['max', ['coalesce', ['to-number', ['get', 'height']], 3], 3], HEIGHT_SCALE],
        'fill-extrusion-base':    0,
        'fill-extrusion-opacity': 0.88,
      },
    });
    map.addLayer({
      id: LINE,
      type: 'line',
      source: SRC,
      paint: { 'line-color': '#ea580c', 'line-width': 0.5, 'line-opacity': 0.7 },
    });

    try {
      const bbox = getBbox(simexBuildingsGeoJSON.features);
      // Pass pitch + bearing directly into fitBounds so they aren't reset
      map.fitBounds(bbox, {
        padding: 60,
        duration: 1400,
        maxZoom: 16,
        pitch: 55,
        bearing: -15,
      });
      isAutoAnimatingRef.current = true;
      map.once('moveend', () => { isAutoAnimatingRef.current = false; });
    } catch (err) {
      console.warn('[simex buildings] fit bounds skipped:', err);
    }

    return remove;
  }, [simexBuildingsGeoJSON, mapLoaded]);

  // ── Tehsil buildings overlay ────────────────────────────────────────
  // Buildings clipped to a clicked tehsil polygon (fetched from the backend
  // cache). Rendered with the same height-based palette as district buildings.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoaded) return;

    const SRC  = 'tehsil-buildings-src';
    const EXT  = 'tehsil-buildings-3d';
    const LINE = 'tehsil-buildings-line';

    const remove = () => {
      [EXT, LINE].forEach((id) => { if (map.getLayer(id)) map.removeLayer(id); });
      if (map.getSource(SRC)) map.removeSource(SRC);
    };

    if (!tehsilBuildingsGeoJSON || !tehsilBuildingsGeoJSON.features?.length) {
      remove();
      return;
    }

    remove();
    map.addSource(SRC, { type: 'geojson', data: tehsilBuildingsGeoJSON });
    map.addLayer({
      id: EXT,
      type: 'fill-extrusion',
      source: SRC,
      paint: {
        'fill-extrusion-color':   buildColorExpr(),
        'fill-extrusion-height':  ['*', ['max', ['coalesce', ['to-number', ['get', 'height']], 3], 3], HEIGHT_SCALE],
        'fill-extrusion-base':    0,
        'fill-extrusion-opacity': 0.88,
      },
    });
    map.addLayer({
      id: LINE,
      type: 'line',
      source: SRC,
      paint: { 'line-color': '#38bdf8', 'line-width': 0.5, 'line-opacity': 0.7 },
    });

    try {
      const bbox = getBbox(tehsilBuildingsGeoJSON.features);
      map.fitBounds(bbox, { padding: 60, duration: 1400, maxZoom: 16, pitch: 55, bearing: -15 });
      isAutoAnimatingRef.current = true;
      map.once('moveend', () => { isAutoAnimatingRef.current = false; });
    } catch (err) {
      console.warn('[tehsil buildings] fit bounds skipped:', err);
    }

    return remove;
  }, [tehsilBuildingsGeoJSON, mapLoaded]);

  // ── Clipped SIMEX scenario footprint (polygon) overlay ──────────────
  // The scenario flood footprint clipped to a tehsil, shown as a translucent
  // orange polygon beneath the buildings.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoaded) return;

    const SRC  = 'tehsil-scenario-clip-src';
    const FILL = 'tehsil-scenario-clip-fill';
    const LINE = 'tehsil-scenario-clip-line';

    const remove = () => {
      [FILL, LINE].forEach((id) => { if (map.getLayer(id)) map.removeLayer(id); });
      if (map.getSource(SRC)) map.removeSource(SRC);
    };

    if (!tehsilScenarioClipGeoJSON || !tehsilScenarioClipGeoJSON.features?.length) {
      remove();
      return;
    }

    remove();
    map.addSource(SRC, { type: 'geojson', data: tehsilScenarioClipGeoJSON });
    // Insert beneath the tehsil buildings so footprints stay on top when both show.
    const beforeId = map.getLayer('tehsil-buildings-3d') ? 'tehsil-buildings-3d' : undefined;
    map.addLayer({
      id: FILL, type: 'fill', source: SRC,
      paint: { 'fill-color': '#fb923c', 'fill-opacity': 0.22 },
    }, beforeId);
    map.addLayer({
      id: LINE, type: 'line', source: SRC,
      paint: { 'line-color': '#fb923c', 'line-width': 1.5, 'line-opacity': 0.9 },
    }, beforeId);

    return remove;
  }, [tehsilScenarioClipGeoJSON, mapLoaded]);

  // Sync encroachment layer styles + ordering when the config changes
  useEffect(() => {
    const m = mapRef.current;
    if (!m || !mapLoaded || !encroachmentLayers) return;
    encroachmentLayers.forEach((layer) => {
      const fillId = `${layer.id}-fill`;
      const lineId = `${layer.id}-line`;
      const extId  = `${layer.id}-3d`;
      const isBuildings = layer.id === 'enc-buildings';
      const vis = layer.visible ? 'visible' : 'none';

      if (m.getLayer(fillId)) {
        m.setLayoutProperty(fillId, 'visibility', vis);
        // Buildings keep the height-based palette; only override for non-buildings
        if (!isBuildings) m.setPaintProperty(fillId, 'fill-color', layer.fillColor);
        m.setPaintProperty(fillId, 'fill-opacity', layer.fillOpacity);
      }
      if (m.getLayer(lineId)) {
        m.setLayoutProperty(lineId, 'visibility', vis);
        m.setPaintProperty(lineId, 'line-color', layer.strokeColor);
        m.setPaintProperty(lineId, 'line-opacity', layer.strokeOpacity);
        m.setPaintProperty(lineId, 'line-width', layer.strokeWidth);
      }
      if (m.getLayer(extId)) {
        m.setLayoutProperty(extId, 'visibility', vis);
        m.setPaintProperty(extId, 'fill-extrusion-opacity', Math.max(0.6, layer.fillOpacity));
      }
    });
    // Re-apply ordering: iterate in array order, moving each to top so the
    // last entry ends up topmost.
    encroachmentLayers.forEach((layer) => {
      ['fill', 'line', '3d'].forEach((kind) => {
        const layerId = `${layer.id}-${kind}`;
        if (m.getLayer(layerId)) m.moveLayer(layerId);
      });
    });
  }, [encroachmentLayers, mapLoaded]);

  // Swap an encroached-buildings source between 2D fill and 3D extrusion
  // based on current zoom. Mirrors the regular-buildings behaviour.
  const syncEncBuildings3D = (map) => {
    if (!map.getSource('enc-buildings-src')) return;
    const cfg = (encroachLayersRef.current || []).find((l) => l.id === 'enc-buildings');
    const visible = cfg?.visible !== false;
    const fillOpacity = cfg?.fillOpacity ?? 0.85;
    const strokeColor = cfg?.strokeColor ?? '#7f1d1d';
    const strokeOpacity = cfg?.strokeOpacity ?? 1;
    const strokeWidth = cfg?.strokeWidth ?? 0.5;
    const zoom = map.getZoom();
    const has3D = !!map.getLayer('enc-buildings-3d');
    const has2D = !!map.getLayer('enc-buildings-fill');
    const colorExpr = buildColorExpr();
    const visTok = visible ? 'visible' : 'none';

    if (zoom >= BUILDING_3D_ZOOM && !has3D) {
      if (has2D) map.removeLayer('enc-buildings-fill');
      if (map.getLayer('enc-buildings-line')) map.removeLayer('enc-buildings-line');
      map.addLayer({
        id: 'enc-buildings-3d', type: 'fill-extrusion', source: 'enc-buildings-src',
        layout: { visibility: visTok },
        paint: {
          'fill-extrusion-color': colorExpr,
          'fill-extrusion-height': ['*', ['coalesce', ['to-number', ['get', 'height']], 3], HEIGHT_SCALE],
          'fill-extrusion-base': 0,
          'fill-extrusion-opacity': Math.max(0.6, fillOpacity),
        },
      });
    } else if (zoom < BUILDING_3D_ZOOM && !has2D) {
      if (has3D) map.removeLayer('enc-buildings-3d');
      map.addLayer({
        id: 'enc-buildings-fill', type: 'fill', source: 'enc-buildings-src',
        layout: { visibility: visTok },
        paint: { 'fill-color': colorExpr, 'fill-opacity': fillOpacity },
      });
      map.addLayer({
        id: 'enc-buildings-line', type: 'line', source: 'enc-buildings-src',
        layout: { visibility: visTok },
        paint: { 'line-color': strokeColor, 'line-opacity': strokeOpacity, 'line-width': strokeWidth },
      });
    }
  };

  // Auto 2D↔3D based on zoom (regular district buildings + encroached buildings)
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoaded) return;

    const onMoveEnd = () => {
      if (!map.isStyleLoaded()) return;
      if (isAutoAnimatingRef.current) return;
      const zoom = map.getZoom();

      // ── Regular district buildings ─────────────────────────
      if (map.getSource('district-buildings-src')) {
        const has3D = !!map.getLayer('district-buildings-3d');
        const has2D = !!map.getLayer('district-buildings-fill');
        const colorExpr = buildColorExpr();
        if (zoom >= BUILDING_3D_ZOOM && !has3D) {
          if (has2D) map.removeLayer('district-buildings-fill');
          if (map.getLayer('district-buildings-line')) map.removeLayer('district-buildings-line');
          map.addLayer({
            id: 'district-buildings-3d', type: 'fill-extrusion',
            source: 'district-buildings-src', 'source-layer': 'buildings',
            paint: {
              'fill-extrusion-color':   colorExpr,
              'fill-extrusion-height':  ['coalesce', ['get', 'height'], 3],
              'fill-extrusion-base':    ['coalesce', ['get', 'base_height'], 0],
              'fill-extrusion-opacity': 0.85,
            },
          });
          if (map.getPitch() < 40) {
            isAutoAnimatingRef.current = true;
            map.once('moveend', () => { isAutoAnimatingRef.current = false; });
            map.easeTo({ pitch: 55, bearing: -15, duration: 800 });
          }
        } else if (zoom < BUILDING_3D_ZOOM && !has2D) {
          if (has3D) map.removeLayer('district-buildings-3d');
          map.addLayer({
            id: 'district-buildings-fill', type: 'fill',
            source: 'district-buildings-src', 'source-layer': 'buildings',
            paint: { 'fill-color': colorExpr, 'fill-opacity': 0.75 },
          });
          map.addLayer({
            id: 'district-buildings-line', type: 'line',
            source: 'district-buildings-src', 'source-layer': 'buildings',
            paint: { 'line-color': 'rgba(0,0,0,0.3)', 'line-width': 0.3 },
          });
          if (map.getPitch() > 0) {
            isAutoAnimatingRef.current = true;
            map.once('moveend', () => { isAutoAnimatingRef.current = false; });
            map.easeTo({ pitch: 0, bearing: 0, duration: 800 });
          }
        }
      }

      // ── Encroached buildings ───────────────────────────────
      syncEncBuildings3D(map);

      // Make sure the encroachment overlay always renders on top
      ['enc-river-fill', 'enc-river-line', 'enc-buildings-fill', 'enc-buildings-line', 'enc-buildings-3d'].forEach((id) => {
        if (map.getLayer(id)) map.moveLayer(id);
      });
    };

    map.on('moveend', onMoveEnd);
    return () => map.off('moveend', onMoveEnd);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapLoaded]);

  // Load Pakistan districts GeoJSON layer (hidden by default)
  const loadDistrictsLayer = (map) => {
    const ps = provBoundaryStyleRef.current;
    map.addSource('pakistan-districts', {
      type: 'geojson',
      data: '/pakistan_districts.geojson',
    });

    // Province districts fill — shown when a province is selected
    map.addLayer({
      id: 'pakistan-districts-fill',
      type: 'fill',
      source: 'pakistan-districts',
      layout: { visibility: 'none' },
      paint: {
        'fill-color': [
          'match', ['get', 'province'],
          'Punjab', '#FF6B6B',
          'Sindh', '#4ECDC4',
          'Khyber Pakhtunkhwa', '#FFD93D',
          'Balochistan', '#6C5CE7',
          'Gilgit Baltistan', '#00B894',
          'Azad Kashmir', '#FD79A8',
          'Federal Capital', '#7986cb',
          '#888888',
        ],
        'fill-opacity': ps.fillOpacity,
      },
    });

    map.addLayer({
      id: 'pakistan-districts-line',
      type: 'line',
      source: 'pakistan-districts',
      layout: { visibility: 'none' },
      paint: {
        'line-color': [
          'match', ['get', 'province'],
          'Punjab', '#FF6B6B',
          'Sindh', '#4ECDC4',
          'Khyber Pakhtunkhwa', '#FFD93D',
          'Balochistan', '#6C5CE7',
          // High-contrast orange — the old teal blended into the basemap
          'Gilgit Baltistan', '#FF8C00',
          'Azad Kashmir', '#FD79A8',
          'Federal Capital', '#7986cb',
          '#ffffff',
        ],
        'line-width': ps.strokeWidth,
        'line-opacity': ps.strokeOpacity,
      },
    });

    // Selected district highlight — gold
    const ds = districtSelectedStyleRef.current;
    map.addLayer({
      id: 'pakistan-district-selected-fill',
      type: 'fill',
      source: 'pakistan-districts',
      layout: { visibility: 'none' },
      paint: {
        'fill-color': ds.fillColor,
        'fill-opacity': ds.fillOpacity,
      },
    });

    map.addLayer({
      id: 'pakistan-district-selected-line',
      type: 'line',
      source: 'pakistan-districts',
      layout: { visibility: 'none' },
      paint: {
        'line-color': ds.strokeColor,
        'line-width': ds.strokeWidth,
        'line-opacity': ds.strokeOpacity,
      },
    });

    // District name labels — shown when a province is selected
    map.addLayer({
      id: 'pakistan-districts-labels',
      type: 'symbol',
      source: 'pakistan-districts',
      layout: {
        visibility: 'none',
        'text-field': ['get', 'name'],
        'text-size': 11,
        'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'],
        'text-anchor': 'center',
        'text-max-width': 8,
      },
      paint: {
        'text-color': '#ffffff',
        'text-halo-color': '#000000',
        'text-halo-width': 1,
      },
    });

    // Transparent click-target layer — always on, covers all districts
    map.addLayer({
      id: 'pakistan-districts-clicktarget',
      type: 'fill',
      source: 'pakistan-districts',
      paint: { 'fill-color': '#000000', 'fill-opacity': 0 },
    });

    // National view — all provinces colored distinctly (hidden by default)
    map.addLayer({
      id: 'national-provinces-fill',
      type: 'fill',
      source: 'pakistan-districts',
      layout: { visibility: 'none' },
      paint: {
        'fill-color': [
          'match', ['get', 'province'],
          'Punjab', '#FF6B6B',
          'Sindh', '#4ECDC4',
          'Khyber Pakhtunkhwa', '#FFD93D',
          'Balochistan', '#6C5CE7',
          'Gilgit Baltistan', '#00B894',
          'Azad Kashmir', '#FD79A8',
          'Federal Capital', '#7986cb',
          '#888888',
        ],
        'fill-opacity': 0.08,
      },
    });

    map.addLayer({
      id: 'national-provinces-line',
      type: 'line',
      source: 'pakistan-districts',
      layout: { visibility: 'none' },
      paint: {
        'line-color': [
          'match', ['get', 'province'],
          'Punjab', '#FF6B6B',
          'Sindh', '#4ECDC4',
          'Khyber Pakhtunkhwa', '#FFD93D',
          'Balochistan', '#6C5CE7',
          'Gilgit Baltistan', '#00B894',
          'Azad Kashmir', '#FD79A8',
          'Federal Capital', '#7986cb',
          '#ffffff',
        ],
        'line-width': 1.2,
      },
    });

    map.on('click', 'pakistan-districts-clicktarget', (e) => {
      // If a tehsil polygon is under the click, let its handler take over —
      // don't also re-select the district.
      const tehsilFills = ['tehsils-country-fill', 'tehsils-province-fill', 'tehsils-district-fill']
        .filter((id) => map.getLayer(id));
      if (tehsilFills.length && map.queryRenderedFeatures(e.point, { layers: tehsilFills }).length) return;
      // Same for an affected-house pin — clicking one shouldn't also
      // re-select/zoom to the district underneath it (was the cause of the
      // map zooming out whenever a pin was clicked).
      if (map.getLayer('infra-affected_houses-symbol')
        && map.queryRenderedFeatures(e.point, { layers: ['infra-affected_houses-symbol'] }).length) return;
      const feat = e.features?.[0];
      if (!feat) return;
      const province = PROVINCES.find((p) => p.geojsonProvince === feat.properties.province);
      if (!province) return;
      const alreadySelected = selectedProvinceRef.current === province.id;
      onProvinceSelectRef.current?.(province.id);
      const districtName = feat.properties.name;
      if (districtName && alreadySelected) onDistrictSelectRef.current?.(districtName);
    });

    map.on('mouseenter', 'pakistan-districts-clicktarget', () => {
      map.getCanvas().style.cursor = 'pointer';
    });
    map.on('mouseleave', 'pakistan-districts-clicktarget', () => {
      map.getCanvas().style.cursor = '';
    });
  };

  // ── Tehsil overlays via GeoServer WFS (vector GeoJSON) ───────────────
  // Each country/province/district is its own GeoServer layer, so we request
  // the whole layer as GeoJSON (no client-side filtering) and render it as a
  // vector fill + line. Vector features let us show a hover tooltip.
  const buildTehsilWfsUrl = (geoserverLayer) =>
    '/geoserver/infra_portal/ows?service=WFS&version=2.0.0&request=GetFeature' +
    `&typeNames=${encodeURIComponent(geoserverLayer)}` +
    '&outputFormat=application/json&srsName=EPSG:4326';

  // Distinct colours per context so an overlapping province/district reads clearly.
  const TEHSIL_STYLES = {
    country:  { fill: '#00e1ff', line: '#7fffd4', fillOpacity: 0.12 },
    province: { fill: '#ffd166', line: '#ffd166', fillOpacity: 0.12 },
    // District tehsils read as a bold white dashed boundary (no fill) inside
    // the focused district.
    district: { fill: '#ffffff', line: '#ffffff', fillOpacity: 0, dash: [2, 2] },
  };

  // A stretchable rounded dark box used as the background behind each tehsil
  // label (light text on a dark pill). Added once, reused by all label layers.
  const TEHSIL_LABEL_BG = 'tehsil-label-bg';
  const ensureLabelBgImage = (map) => {
    if (map.hasImage(TEHSIL_LABEL_BG)) return;
    const size = 24, r = 8;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = 'rgba(17, 24, 39, 0.92)';
    ctx.beginPath();
    ctx.moveTo(r, 0);
    ctx.arcTo(size, 0, size, size, r);
    ctx.arcTo(size, size, 0, size, r);
    ctx.arcTo(0, size, 0, 0, r);
    ctx.arcTo(0, 0, size, 0, r);
    ctx.closePath();
    ctx.fill();
    map.addImage(TEHSIL_LABEL_BG, ctx.getImageData(0, 0, size, size), {
      // Only the centre stretches, keeping the rounded corners crisp.
      stretchX: [[r, size - r]],
      stretchY: [[r, size - r]],
      content: [4, 4, size - 4, size - 4],
      pixelRatio: 1,
    });
  };

  // Clicking a tehsil polygon opens its stats modal. Attached per fill layer
  // (idempotent) and torn down when the layer is removed.
  const attachTehsilClick = (map, fillId) => {
    if (tehsilClickRef.current[fillId]) return;
    const onClick = (e) => {
      // Don't let an affected-house pin sitting on top of this tehsil also
      // trigger a tehsil-level zoom/select.
      if (map.getLayer('infra-affected_houses-symbol')
        && map.queryRenderedFeatures(e.point, { layers: ['infra-affected_houses-symbol'] }).length) return;
      const f = e.features?.[0];
      if (!f) return;
      onTehsilSelectRef.current?.(f.properties || {}, f.geometry || null);
    };
    const onEnter = () => { map.getCanvas().style.cursor = 'pointer'; };
    const onLeave = () => { map.getCanvas().style.cursor = ''; };
    map.on('click', fillId, onClick);
    map.on('mouseenter', fillId, onEnter);
    map.on('mouseleave', fillId, onLeave);
    tehsilClickRef.current[fillId] = { onClick, onEnter, onLeave };
  };

  const detachTehsilClick = (map, fillId) => {
    const h = tehsilClickRef.current[fillId];
    if (!h) return;
    map.off('click', fillId, h.onClick);
    map.off('mouseenter', fillId, h.onEnter);
    map.off('mouseleave', fillId, h.onLeave);
    delete tehsilClickRef.current[fillId];
  };

  // Fetch a GeoServer WFS layer and render it as a vector fill + line + name
  // labels, or remove it when hidden. Cancels any in-flight request for the key.
  // `labelField` is the feature property to label with — most layers expose
  // `name`, but some (e.g. the GB tehsil layer) use `TEHSIL`. `filterFn`, when
  // given, keeps only the features it returns truthy for (used to slice the
  // province-wide GB layer down to a single district).
  const syncTehsilWfs = (map, key, geoserverLayer, show, labelField = 'name', filterFn = null) => {
    const srcId = `tehsils-${key}-src`;
    const fillId = `tehsils-${key}-fill`;
    const lineId = `tehsils-${key}-line`;
    const labelId = `tehsils-${key}-label`;
    const style = TEHSIL_STYLES[key];

    if (tehsilAbortRef.current[key]) {
      tehsilAbortRef.current[key].abort();
      tehsilAbortRef.current[key] = null;
    }

    const remove = () => {
      detachTehsilClick(map, fillId);
      [labelId, lineId, fillId].forEach((id) => { if (map.getLayer(id)) map.removeLayer(id); });
      if (map.getSource(srcId)) map.removeSource(srcId);
    };

    if (!show || !geoserverLayer) {
      remove();
      setTehsilErrors((prev) => (prev[key] ? { ...prev, [key]: null } : prev));
      return;
    }

    remove();
    const controller = new AbortController();
    tehsilAbortRef.current[key] = controller;
    setTehsilsLoading(true);
    setTehsilErrors((prev) => (prev[key] ? { ...prev, [key]: null } : prev));

    fetch(buildTehsilWfsUrl(geoserverLayer), { signal: controller.signal })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`WFS ${r.status}`))))
      .then((geojson) => {
        if (map.getSource(srcId)) return;
        const data = filterFn
          ? { ...geojson, features: (geojson.features || []).filter(filterFn) }
          : geojson;
        ensureLabelBgImage(map);
        map.addSource(srcId, { type: 'geojson', data });
        map.addLayer({
          id: fillId, type: 'fill', source: srcId,
          // A transparent fill (opacity 0) still receives clicks for the stats modal.
          paint: { 'fill-color': style.fill, 'fill-opacity': style.fillOpacity ?? 0.12 },
        });
        map.addLayer({
          id: lineId, type: 'line', source: srcId,
          paint: {
            'line-color': style.line,
            'line-width': style.dash ? 3 : 1,
            'line-opacity': 0.95,
            ...(style.dash ? { 'line-dasharray': style.dash } : {}),
          },
        });
        // Tehsil name as a dark pill with light text.
        map.addLayer({
          id: labelId, type: 'symbol', source: srcId,
          layout: {
            'text-field': ['get', labelField],
            'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'],
            'text-size': 11,
            'text-max-width': 10,
            'icon-image': TEHSIL_LABEL_BG,
            'icon-text-fit': 'both',
            'icon-text-fit-padding': [3, 7, 3, 7],
            'icon-allow-overlap': false,
            'text-allow-overlap': false,
          },
          paint: { 'text-color': '#f1f5f9' },
        });
        attachTehsilClick(map, fillId);
      })
      .catch((err) => {
        if (err.name !== 'AbortError') {
          console.error(`[tehsils:${key}] WFS failed:`, err.message);
          setTehsilErrors((prev) => ({ ...prev, [key]: err.message || 'request failed' }));
        }
      })
      .finally(() => {
        if (tehsilAbortRef.current[key] === controller) tehsilAbortRef.current[key] = null;
        // Clear the loading flag once no context still has a pending request.
        if (!Object.values(tehsilAbortRef.current).some(Boolean)) setTehsilsLoading(false);
      });
  };

  // Show/filter districts when a province is selected
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoaded) return;
    if (!map.getLayer('pakistan-districts-fill')) return;

    // When District Tehsils is on for a selected district, focus the view on
    // just that district: hide the sibling district outlines so only the
    // selected-district boundary (gold highlight) and its red-dashed tehsils
    // remain.
    const focusDistrict = showDistrictTehsils && selectedDistrict;

    if (selectedProvince && provBoundaryStyle.visible && !focusDistrict) {
      const province = PROVINCES.find((p) => p.id === selectedProvince);
      const geojsonName = province?.geojsonProvince;
      if (geojsonName) {
        const filter = ['==', ['get', 'province'], geojsonName];
        map.setFilter('pakistan-districts-fill', filter);
        map.setFilter('pakistan-districts-line', filter);
        if (map.getLayer('pakistan-districts-labels')) map.setFilter('pakistan-districts-labels', filter);
        map.setLayoutProperty('pakistan-districts-fill', 'visibility', 'visible');
        map.setLayoutProperty('pakistan-districts-line', 'visibility', 'visible');
        if (map.getLayer('pakistan-districts-labels')) {
          map.setLayoutProperty('pakistan-districts-labels', 'visibility', showDistrictLabels ? 'visible' : 'none');
        }
      }
    } else if (focusDistrict) {
      // Keep only the focused district's boundary (siblings filtered out); its
      // outline stays, with the white dashed tehsils drawn inside.
      const districtFilter = ['==', ['get', 'name'], selectedDistrict];
      map.setFilter('pakistan-districts-fill', districtFilter);
      map.setFilter('pakistan-districts-line', districtFilter);
      if (map.getLayer('pakistan-districts-labels')) map.setFilter('pakistan-districts-labels', districtFilter);
      map.setLayoutProperty('pakistan-districts-fill', 'visibility', 'visible');
      map.setLayoutProperty('pakistan-districts-line', 'visibility', 'visible');
      if (map.getLayer('pakistan-districts-labels')) {
        // The tehsil name labels are now on the map — drop the district's own
        // name label so it doesn't sit on top of (or duplicate) them. The
        // district is still identifiable by its gold highlight + boundary.
        map.setLayoutProperty('pakistan-districts-labels', 'visibility', 'none');
      }
    } else {
      map.setLayoutProperty('pakistan-districts-fill', 'visibility', 'none');
      map.setLayoutProperty('pakistan-districts-line', 'visibility', 'none');
      if (map.getLayer('pakistan-districts-labels')) {
        map.setLayoutProperty('pakistan-districts-labels', 'visibility', 'none');
      }
      if (map.getLayer('pakistan-district-selected-fill')) {
        map.setLayoutProperty('pakistan-district-selected-fill', 'visibility', 'none');
        map.setLayoutProperty('pakistan-district-selected-line', 'visibility', 'none');
      }
    }
  }, [selectedProvince, mapLoaded, showDistrictLabels, provBoundaryStyle.visible, showDistrictTehsils, selectedDistrict]);

  // Highlight selected district in gold
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoaded) return;
    if (!map.getLayer('pakistan-district-selected-fill')) return;
    const show = selectedDistrict && districtSelectedStyle.visible;
    if (show) {
      const filter = ['==', ['get', 'name'], selectedDistrict];
      map.setFilter('pakistan-district-selected-fill', filter);
      map.setFilter('pakistan-district-selected-line', filter);
      map.setLayoutProperty('pakistan-district-selected-fill', 'visibility', 'visible');
      map.setLayoutProperty('pakistan-district-selected-line', 'visibility', 'visible');
    } else {
      map.setLayoutProperty('pakistan-district-selected-fill', 'visibility', 'none');
      map.setLayoutProperty('pakistan-district-selected-line', 'visibility', 'none');
    }
  }, [selectedDistrict, mapLoaded, districtSelectedStyle.visible]);

  // Country tehsils (national view) — WFS of infra_portal:pak_tehsils.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoaded) return;
    syncTehsilWfs(map, 'country', 'infra_portal:pak_tehsils', showCountryTehsils && isNationalView);
  }, [showCountryTehsils, isNationalView, mapLoaded]);

  // Province tehsils — WFS of infra_portal:province_<Name>.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoaded) return;
    const province = PROVINCES.find((p) => p.id === selectedProvince);
    // Gilgit-Baltistan tehsils live in a dedicated corrected layer whose name
    // field is `TEHSIL`; every other province uses the generic province_<Name>
    // layer with a `name` field.
    const isGB = selectedProvince === 'gilgit-baltistan';
    const layerName = isGB
      ? 'infra_portal:tehsil_gb'
      : (province ? `infra_portal:province_${province.geojsonProvince}` : null);
    const labelField = isGB ? 'TEHSIL' : 'name';
    syncTehsilWfs(map, 'province', layerName, showProvinceTehsils && !!layerName, labelField);
  }, [showProvinceTehsils, selectedProvince, mapLoaded]);

  // District tehsils — WFS of infra_portal:district_<Name>. Gilgit-Baltistan has
  // no correct per-district layer, so we slice the province-wide corrected
  // `tehsil_gb` layer down to the selected district via its `DISTRICT` column.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoaded) return;
    const isGB = selectedProvince === 'gilgit-baltistan';
    if (isGB && selectedDistrict) {
      const norm = (s) => (s || '').toString().toLowerCase().replace(/[^a-z0-9]/g, '');
      const target = norm(selectedDistrict);
      // Prefer a spatial test (tehsil centroid inside the district polygon),
      // falling back to the layer's DISTRICT attribute if the boundary geometry
      // isn't available.
      const districtGeom = districtsGeoJSON?.features?.find(
        (f) => norm(f.properties?.name) === target,
      )?.geometry;
      const filterFn = (f) => {
        const pt = representativePoint(f.geometry);
        if (districtGeom && pt) return geomContainsPoint(districtGeom, pt[0], pt[1]);
        return norm(f.properties?.DISTRICT) === target;
      };
      syncTehsilWfs(map, 'district', 'infra_portal:tehsil_gb', showDistrictTehsils, 'TEHSIL', filterFn);
      return;
    }
    const layerName = selectedDistrict ? `infra_portal:district_${selectedDistrict}` : null;
    syncTehsilWfs(map, 'district', layerName, showDistrictTehsils && !!layerName);
  }, [showDistrictTehsils, selectedDistrict, selectedProvince, mapLoaded, districtsGeoJSON]);

  // Show/hide national provinces view
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoaded) return;
    if (!map.getLayer('national-provinces-fill')) return;
    if (isNationalView) {
      map.setLayoutProperty('national-provinces-fill', 'visibility', 'visible');
      map.setLayoutProperty('national-provinces-line', 'visibility', 'visible');
      if (districtsGeoJSON) {
        map.fitBounds(getBbox(districtsGeoJSON.features), { padding: 30, duration: 1500 });
      }
    } else {
      map.setLayoutProperty('national-provinces-fill', 'visibility', 'none');
      map.setLayoutProperty('national-provinces-line', 'visibility', 'none');
    }
  }, [isNationalView, mapLoaded, districtsGeoJSON]);

  // Load province labels layer once both the map and GeoJSON are ready
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoaded || !provinceLabelsGeoJSON) return;
    if (!map.getSource('province-labels-src')) {
      loadProvinceLabelsLayer(map, provinceLabelsGeoJSON);
    }
  }, [mapLoaded, provinceLabelsGeoJSON]);

  // Toggle province labels visibility
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoaded || !map.getLayer('province-labels')) return;
    map.setLayoutProperty('province-labels', 'visibility', showProvinceLabels ? 'visible' : 'none');
  }, [showProvinceLabels, mapLoaded]);

  // Apply flood layer visibility, styles, and ordering
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoaded) return;
    // Apply each layer's style and visibility in order
    floodLayers.forEach((layer) => {
      const vis = layer.visible ? 'visible' : 'none';
      floodLayerIds(layer.year).forEach(({ fillId, lineId }) => {
        if (!map.getLayer(fillId)) return;
        map.setLayoutProperty(fillId, 'visibility', vis);
        map.setLayoutProperty(lineId, 'visibility', vis);
        map.setPaintProperty(fillId, 'fill-color', layer.fillColor);
        map.setPaintProperty(fillId, 'fill-opacity', layer.fillOpacity);
        map.setPaintProperty(lineId, 'line-color', layer.strokeColor);
        map.setPaintProperty(lineId, 'line-opacity', layer.strokeOpacity);
        map.setPaintProperty(lineId, 'line-width', layer.strokeWidth);
      });
    });
    // Reorder: last in array renders on top, but keep all flood/sus layers
    // below the district boundary so districts always render above them.
    const anchor = map.getLayer('pakistan-districts-fill') ? 'pakistan-districts-fill' : undefined;
    floodLayers.forEach((layer) => {
      floodLayerIds(layer.year).forEach(({ fillId, lineId }) => {
        if (map.getLayer(fillId)) map.moveLayer(fillId, anchor);
        if (map.getLayer(lineId)) map.moveLayer(lineId, anchor);
      });
    });
  }, [floodLayers, mapLoaded]);

  const moveInfraAboveBuildings = (map) => {
    INFRA_LAYERS.forEach((layer) => {
      const ids = layer.type === 'fill'
        ? [`infra-${layer.id}-fill`, `infra-${layer.id}-line`]
        : [`infra-${layer.id}-${layer.type}`];
      ids.forEach((id) => {
        if (map.getLayer(id)) map.moveLayer(id);
      });
    });
  };

  // Apply infrastructure overlay visibility (Rivers, Roads, Hospitals,
  // Schools, Dams, …) — same pattern as the flood layer visibility effect
  // above, just toggling visibility since these layers aren't user-styled.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoaded || !infraLayers) return;
    INFRA_LAYERS.forEach((layer) => {
      const entry = infraLayers.find((l) => l.id === layer.id);
      const vis = entry?.visible ? 'visible' : 'none';
      const ids = layer.type === 'fill'
        ? [`infra-${layer.id}-fill`, `infra-${layer.id}-line`]
        : [`infra-${layer.id}-${layer.type}`];
      ids.forEach((id) => {
        if (!map.getLayer(id)) return;
        map.setLayoutProperty(id, 'visibility', vis);
        if (vis === 'visible') map.moveLayer(id);
      });
    });
  }, [infraLayers, mapLoaded]);

  // Apply buildings layer visibility — handled by the activeBuildingDistrict effect above

  // Change map style
  const changeStyle = (styleKey) => {
    if (!mapRef.current || styleKey === activeStyle) return;
    setActiveStyle(styleKey);
    setMapLoaded(false);
    mapRef.current.setStyle(MAP_CONFIG.styles[styleKey]);
    mapRef.current.once('style.load', () => {
      if (!showLabels) hideLabels(mapRef.current);
      addDarkOverlay(mapRef.current);
      loadPakistanBoundary(mapRef.current);
      loadDistrictsLayer(mapRef.current);
      loadFloodLayers(mapRef.current);
      loadInfraLayers(mapRef.current);
      if (provinceLabelsGeoJSONRef.current) {
        loadProvinceLabelsLayer(mapRef.current, provinceLabelsGeoJSONRef.current);
        if (!showProvinceLabels) {
          mapRef.current.setLayoutProperty('province-labels', 'visibility', 'none');
        }
      }
      // Restore boundary styles after style change
      const bs = layerStyleRef.current;
      const bsVis = bs.visible ? 'visible' : 'none';
      if (mapRef.current.getLayer('pakistan-boundary-fill')) {
        mapRef.current.setLayoutProperty('pakistan-boundary-fill', 'visibility', bsVis);
        mapRef.current.setPaintProperty('pakistan-boundary-fill', 'fill-color', bs.fillColor);
        mapRef.current.setPaintProperty('pakistan-boundary-fill', 'fill-opacity', bs.fillOpacity);
      }
      if (mapRef.current.getLayer('pakistan-boundary-line')) {
        mapRef.current.setLayoutProperty('pakistan-boundary-line', 'visibility', bsVis);
        mapRef.current.setPaintProperty('pakistan-boundary-line', 'line-color', bs.strokeColor);
        mapRef.current.setPaintProperty('pakistan-boundary-line', 'line-opacity', bs.strokeOpacity);
        mapRef.current.setPaintProperty('pakistan-boundary-line', 'line-width', bs.strokeWidth);
      }
      // Restore provincial boundary styles
      const ps = provBoundaryStyleRef.current;
      if (mapRef.current.getLayer('pakistan-districts-fill')) {
        mapRef.current.setPaintProperty('pakistan-districts-fill', 'fill-opacity', ps.fillOpacity);
      }
      if (mapRef.current.getLayer('pakistan-districts-line')) {
        mapRef.current.setPaintProperty('pakistan-districts-line', 'line-opacity', ps.strokeOpacity);
        mapRef.current.setPaintProperty('pakistan-districts-line', 'line-width', ps.strokeWidth);
      }
      // Restore district selected highlight styles
      const ds = districtSelectedStyleRef.current;
      if (mapRef.current.getLayer('pakistan-district-selected-fill')) {
        mapRef.current.setPaintProperty('pakistan-district-selected-fill', 'fill-color', ds.fillColor);
        mapRef.current.setPaintProperty('pakistan-district-selected-fill', 'fill-opacity', ds.fillOpacity);
      }
      if (mapRef.current.getLayer('pakistan-district-selected-line')) {
        mapRef.current.setPaintProperty('pakistan-district-selected-line', 'line-color', ds.strokeColor);
        mapRef.current.setPaintProperty('pakistan-district-selected-line', 'line-opacity', ds.strokeOpacity);
        mapRef.current.setPaintProperty('pakistan-district-selected-line', 'line-width', ds.strokeWidth);
      }
      // Restore flood layers with current styles after style change
      const currentFlood = activeFloodLayersRef.current;
      currentFlood.forEach((layer) => {
        const vis = layer.visible ? 'visible' : 'none';
        floodLayerIds(layer.year).forEach(({ fillId, lineId }) => {
          if (!mapRef.current.getLayer(fillId)) return;
          mapRef.current.setLayoutProperty(fillId, 'visibility', vis);
          mapRef.current.setLayoutProperty(lineId, 'visibility', vis);
          mapRef.current.setPaintProperty(fillId, 'fill-color', layer.fillColor);
          mapRef.current.setPaintProperty(fillId, 'fill-opacity', layer.fillOpacity);
          mapRef.current.setPaintProperty(lineId, 'line-color', layer.strokeColor);
          mapRef.current.setPaintProperty(lineId, 'line-opacity', layer.strokeOpacity);
          mapRef.current.setPaintProperty(lineId, 'line-width', layer.strokeWidth);
        });
      });
      // Reorder flood layers below district boundary
      const anchor2 = mapRef.current.getLayer('pakistan-districts-fill') ? 'pakistan-districts-fill' : undefined;
      currentFlood.forEach((layer) => {
        floodLayerIds(layer.year).forEach(({ fillId, lineId }) => {
          if (mapRef.current.getLayer(fillId)) mapRef.current.moveLayer(fillId, anchor2);
          if (mapRef.current.getLayer(lineId)) mapRef.current.moveLayer(lineId, anchor2);
        });
      });
      setMapLoaded(true);
    });
  };

  // Raw mapboxgl.Popup content is plain HTML, not React — this exposes a
  // plain function on window so a photo thumbnail's onclick can reach back
  // into React state to open the lightbox (same technique the popup HTML
  // itself has no other way to trigger a React re-render).
  useEffect(() => {
    window.__openAffecteePhoto = (url) => setEnlargedPhoto(url);
    return () => { delete window.__openAffecteePhoto; };
  }, []);

  useEffect(() => {
    if (!enlargedPhoto) return;
    const onKey = (e) => { if (e.key === 'Escape') setEnlargedPhoto(null); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [enlargedPhoto]);

  // Close the infra-layers dropdown on outside click, same pattern as
  // Header.jsx's LocationSearch — checks both the trigger button and the
  // portaled dropdown panel, since the panel is no longer a DOM descendant
  // of the trigger's wrapper once portaled to document.body.
  useEffect(() => {
    if (!infraLayersMenuOpen) return;
    const handleClickOutside = (e) => {
      if (infraLayersMenuRef.current?.contains(e.target)) return;
      if (infraLayersDropdownRef.current?.contains(e.target)) return;
      setInfraLayersMenuOpen(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [infraLayersMenuOpen]);

  return (
    <div className="map-wrapper">
      <div className="map-title-bar">
        {sidebarCollapsed && (
          <button
            className="map-hamburger-btn"
            onClick={onToggleSidebar}
            title="Open sidebar"
            aria-label="Open sidebar"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path d="M3 5.5l5 5 5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>
        )}
        <button
          className={`style-panel-trigger${stylePanelOpen ? ' style-panel-trigger--active' : ''}`}
          onClick={(e) => { if (!stylePanelOpen) anchorPanelBelow(e, setStylePanelPos); setStylePanelOpen((v) => !v); }}
          title="Map Style"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
            <path d="M12 3L2 8l10 5 10-5-10-5z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" fill="rgba(167,139,250,0.15)"/>
            <path d="M2 12l10 5 10-5" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"/>
            <path d="M2 16l10 5 10-5" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"/>
          </svg>
          <span>Basemap: {activeStyle.charAt(0).toUpperCase() + activeStyle.slice(1)}</span>
        </button>
        {stylePanelOpen && (
          <div className="style-panel-overlay" onClick={() => setStylePanelOpen(false)}>
            <div
              className="style-panel"
              style={{ left: stylePanelPos.x, top: stylePanelPos.y }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="style-panel-header" onMouseDown={onStylePanelDrag} style={{ cursor: 'grab' }}>
                <span className="style-panel-badge">Map Style</span>
                <button className="style-panel-close" onClick={() => setStylePanelOpen(false)}>✕</button>
              </div>
              <div className="style-panel-body">
                {Object.keys(MAP_CONFIG.styles).map((key, i) => {
                  const colors = ['#38bdf8', '#a78bfa', '#fbbf24', '#34d399', '#fb7185'];
                  const icons = [
                    <svg key="sat" width="14" height="14" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="8" stroke="currentColor" strokeWidth="1.5"/><path d="M12 4v16M4 12h16M6.3 6.3l11.4 11.4M17.7 6.3L6.3 17.7" stroke="currentColor" strokeWidth="1" opacity="0.5"/></svg>,
                    <svg key="dark" width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/></svg>,
                    <svg key="light" width="14" height="14" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="5" stroke="currentColor" strokeWidth="1.5"/><path d="M12 1v3M12 20v3M4.22 4.22l2.12 2.12M17.66 17.66l2.12 2.12M1 12h3M20 12h3M4.22 19.78l2.12-2.12M17.66 6.34l2.12-2.12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>,
                    <svg key="streets" width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M3 12h4l3-9 4 18 3-9h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>,
                    <svg key="outdoors" width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M8 21l4-10 4 10M3 21l5-14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/><path d="M13.5 7l4.5 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/><circle cx="16" cy="5" r="2" stroke="currentColor" strokeWidth="1.5"/></svg>,
                  ];
                  return (
                    <button
                      key={key}
                      className={`style-panel-item${activeStyle === key ? ' style-panel-item--active' : ''}`}
                      onClick={() => { changeStyle(key); setStylePanelOpen(false); }}
                      style={{ '--item-color': colors[i % colors.length] }}
                    >
                      <span className="style-panel-icon">{icons[i % icons.length]}</span>
                      {key.charAt(0).toUpperCase() + key.slice(1)}
                    </button>
                  );
                })}
              </div>
              <div className="style-panel-divider" />
              <label className="style-panel-checkbox">
                <input type="checkbox" checked={showLabels} onChange={toggleLabels} />
                <span>Show Basemap Labels</span>
              </label>
            </div>
          </div>
        )}
        {selectedProvince && (
          <button
            key={selectedProvince}
            className={`labels-panel-trigger labels-panel-trigger--enter${labelsPanelOpen ? ' labels-panel-trigger--active' : ''}`}
            onClick={(e) => { if (!labelsPanelOpen) anchorPanelBelow(e, setLabelsPanelPos); setLabelsPanelOpen((v) => !v); }}
            title="Data Labels"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
              <rect x="3" y="5" width="18" height="14" rx="2" stroke="currentColor" strokeWidth="1.6"/>
              <path d="M7 10h10M7 14h6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
            <span>Labels</span>
          </button>
        )}
        {labelsPanelOpen && selectedProvince && (
          <div className="style-panel-overlay" onClick={() => setLabelsPanelOpen(false)}>
            <div
              className="labels-panel"
              style={{ left: labelsPanelPos.x, top: labelsPanelPos.y }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="labels-panel-header" onMouseDown={onLabelsPanelDrag} style={{ cursor: 'grab' }}>
                <span className="labels-panel-badge">Data Labels</span>
                <button className="style-panel-close" onClick={() => setLabelsPanelOpen(false)}>✕</button>
              </div>
              <div className="labels-panel-body">
                <label className="labels-panel-checkbox">
                  <input type="checkbox" checked={showProvinceLabels} onChange={() => setShowProvinceLabels((v) => !v)} />
                  <span>Province Labels</span>
                </label>
                <label className="labels-panel-checkbox">
                  <input type="checkbox" checked={showDistrictLabels} onChange={() => setShowDistrictLabels((v) => !v)} />
                  <span>District Labels</span>
                </label>
              </div>
            </div>
          </div>
        )}
        {(isNationalView || selectedProvince || selectedDistrict) && (
          <button
            className={`labels-panel-trigger${tehsilsPanelOpen ? ' labels-panel-trigger--active' : ''}`}
            onClick={(e) => { if (!tehsilsPanelOpen) anchorPanelBelow(e, setLabelsPanelPos); setTehsilsPanelOpen((v) => !v); }}
            title="Tehsils"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
              <path d="M4 6l5-2 6 2 5-2v14l-5 2-6-2-5 2V6z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
              <path d="M9 4v14M15 6v14" stroke="currentColor" strokeWidth="1.2"/>
            </svg>
            <span>Tehsils</span>
          </button>
        )}
        {tehsilsPanelOpen && (isNationalView || selectedProvince || selectedDistrict) && (
          <div className="style-panel-overlay" onClick={() => setTehsilsPanelOpen(false)}>
            <div
              className="labels-panel"
              style={{ left: labelsPanelPos.x, top: labelsPanelPos.y }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="labels-panel-header" onMouseDown={onLabelsPanelDrag} style={{ cursor: 'grab' }}>
                <span className="labels-panel-badge">Tehsils</span>
                <button className="style-panel-close" onClick={() => setTehsilsPanelOpen(false)}>✕</button>
              </div>
              <div className="labels-panel-body">
                {isNationalView && (
                  <label className="labels-panel-checkbox">
                    <input type="checkbox" checked={showCountryTehsils} onChange={() => setShowCountryTehsils((v) => !v)} />
                    <span>Country Tehsils</span>
                  </label>
                )}
                {selectedProvince && (
                  <label className="labels-panel-checkbox">
                    <input type="checkbox" checked={showProvinceTehsils} onChange={() => setShowProvinceTehsils((v) => !v)} />
                    <span>Province Tehsils</span>
                  </label>
                )}
                {selectedDistrict && (
                  <label className="labels-panel-checkbox">
                    <input type="checkbox" checked={showDistrictTehsils} onChange={() => setShowDistrictTehsils((v) => !v)} />
                    <span>District Tehsils</span>
                  </label>
                )}
                {(tehsilErrors.country || tehsilErrors.province || tehsilErrors.district) && (
                  <div className="tehsil-panel-error">
                    Couldn’t load tehsils: {tehsilErrors.country || tehsilErrors.province || tehsilErrors.district}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
        <button className="layer-style-trigger" onClick={() => setModalOpen(true)} title="Edit layer style">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
            <path d="M12 2a10 10 0 100 20 10 10 0 000-20z" stroke="currentColor" strokeWidth="1.5" fill="rgba(251,191,36,0.1)"/>
            <path d="M12 6v2M12 16v2M6 12h2M16 12h2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.5"/>
          </svg>
          Layer Style
        </button>

        <div className="infra-layers-menu" ref={infraLayersMenuRef}>
          <button
            className={`infra-layers-trigger${infraLayersMenuOpen ? ' infra-layers-trigger--open' : ''}`}
            onClick={(e) => {
              if (!infraLayersMenuOpen) {
                const r = e.currentTarget.getBoundingClientRect();
                setInfraLayersMenuPos({ top: r.bottom + 8, right: window.innerWidth - r.right });
              }
              setInfraLayersMenuOpen((v) => !v);
            }}
            title="Toggle infrastructure layers"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
              <path d="M12 2l9 5-9 5-9-5 9-5z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
              <path d="M3 12l9 5 9-5M3 17l9 5 9-5" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
            </svg>
            Layers{infraLayers?.some((l) => l.visible) ? ` (${infraLayers.filter((l) => l.visible).length})` : ''}
            <span className="infra-layers-trigger-caret">▾</span>
          </button>
          {/* Portaled straight to document.body so no ancestor's stacking
              context (e.g. the fixed-position district stats dock) can ever
              trap it underneath — z-index alone wasn't reliably winning
              that fight from inside MapContainer's own DOM tree. */}
          {infraLayersMenuOpen && createPortal(
            <div
              className="infra-layers-dropdown"
              ref={infraLayersDropdownRef}
              style={{ top: infraLayersMenuPos.top, right: infraLayersMenuPos.right }}
            >
              {INFRA_LAYERS.map((layer) => {
                const active = !!infraLayers?.find((l) => l.id === layer.id)?.visible;
                const chipColor = layer.style.lineColor || layer.style.circleColor || layer.style.fillColor || layer.style.iconColor || '#f97316';
                return (
                  <button
                    key={layer.id}
                    className={`infra-layers-row${active ? ' infra-layers-row--active' : ''}`}
                    onClick={() => onInfraLayerToggle?.(layer.id)}
                    title={`Toggle ${layer.label}`}
                    style={{ '--chip-color': chipColor }}
                  >
                    <span className="infra-toggle-switch"><span className="infra-toggle-knob" /></span>
                    <span>{layer.label}</span>
                  </button>
                );
              })}
            </div>,
            document.body,
          )}
        </div>
      </div>

      <div className="map-container-inner">
        {(isFetchingBuildings || tehsilsLoading) && (
          <div className="building-load-strip" role="progressbar" aria-label="Loading data">
            <div className="building-load-strip__bar" />
          </div>
        )}
        <div ref={mapContainerRef} className="mapbox-map" />
        {!mapLoaded && (
          <div className="map-loading">
            <div className="loading-spinner" />
            <span>Loading map...</span>
          </div>
        )}

        {/* Building height legend — shown for regular, encroached, or SIMEX buildings */}
        {((showBuildings && activeBuildingDistrict) || encroachedMapDistrict || simexBuildingsGeoJSON?.features?.length > 0 || tehsilBuildingsGeoJSON?.features?.length > 0) && (
          <div className="building-legend">
            <div className="building-legend-title">
              {simexBuildingsGeoJSON?.features?.length > 0
                ? 'Buildings Inside Scenario'
                : tehsilBuildingsGeoJSON?.features?.length > 0
                  ? 'Buildings in Tehsil'
                  : 'Building Height'}
            </div>
            {BUILDING_HEIGHT_COLORS.map(([, color, label]) => (
              <div key={label} className="building-legend-item">
                <span className="building-legend-swatch" style={{ background: color }} />
                <span className="building-legend-label">{label}</span>
              </div>
            ))}
          </div>
        )}

        {/* Portal target for the district demographics bar (DistrictStatsModal) —
            rendering it as a child of the map area (not a viewport-fixed overlay)
            guarantees it only ever spans the map's own width, so it can never be
            covered by or overlap the sidebars regardless of their widths/collapse
            state. */}
        <div id="ds-dock-bottom-slot" className="ds-dock-bottom-slot" />
      </div>

      {enlargedPhoto && (
        <div
          className="affectee-lightbox"
          role="dialog"
          aria-modal="true"
          onClick={() => setEnlargedPhoto(null)}
        >
          <button
            className="affectee-lightbox-close"
            onClick={() => setEnlargedPhoto(null)}
            title="Close"
            aria-label="Close"
          >
            ×
          </button>
          <img
            className="affectee-lightbox-img"
            src={enlargedPhoto}
            alt="Affected house"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}

      <StyleModal
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
        nationalStyle={layerStyle}
        onNationalChange={applyLayerStyle}
        provincialStyle={provBoundaryStyle}
        onProvincialChange={applyProvBoundaryStyle}
        districtStyle={districtSelectedStyle}
        onDistrictChange={applyDistrictSelectedStyle}
      />
    </div>
  );
}

export default MapContainer;
