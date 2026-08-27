import React from 'react';
import { Routes, Route, useLocation, Navigate } from 'react-router-dom';
import Header from './components/Header/Header';
import IncidentRecordsPage from './components/IncidentRecords/IncidentRecordsPage';
import IncidentDetailPage from './components/IncidentRecords/IncidentDetailPage';
import FloodSimulationPage from './components/FloodSimulation/FloodSimulationPage';
import FloodSimulation3DPage from './components/FloodSimulation3D/FloodSimulation3DPage';
import FloodSimulationV5Page from './components/FloodSimulationV5/FloodSimulationV5Page';
import FloodVulnerabilityPage from './components/FloodVulnerability/FloodVulnerabilityPage';
import FloodVulnerabilityV2Page from './components/FloodVulnerabilityV2/FloodVulnerabilityV2Page';
import Sidebar from './components/Sidebar/Sidebar';
import DistrictTehsilSidebar from './components/Sidebar/DistrictTehsilSidebar';
import MapContainer from './components/Map/MapContainer';
import DistrictStatsModal from './components/DistrictStats/DistrictStatsModal';
import TehsilBuildingsPanel from './components/TehsilBuildings/TehsilBuildingsPanel';
import EncroachmentModal from './components/Encroachment/EncroachmentModal';
import FloodProjectionModal from './components/FloodProjection/FloodProjectionModal';
import NationalStatsPanel from './components/NationalStats/NationalStatsPanel';
import ProvincialStatsPanel from './components/ProvincialStats/ProvincialStatsPanel';
import ExposureDatePickerModal from './components/Exposure/ExposureDatePickerModal';
import ExposureSummaryModal from './components/Exposure/ExposureSummaryModal';
import StreamExposureCard from './components/Exposure/StreamExposureCard';
import { fetchExposureByDate, fetchStreamGeometries, joinExposure } from './components/Exposure/exposureApi';
import GCOPExposureModal from './components/GCOPExposure/GCOPExposureModal';
import SimexRiskCalculatorModal from './components/RiskCalculator/SimexRiskCalculatorModal';
import { loadBalochistanDistricts, loadKPDistricts, loadSindhDistricts, loadPunjabDistricts, loadAJKDistricts, loadGBDistricts, loadNationalStatsCSV, findDistrict } from './utils/provincialIntake';
import { resolveDistrict, provinceLabel } from './config/provinceRegistry';
import { aggregateProvince, buildNationalStats } from './utils/aggregateStats';
import { loadBuildingIndex, findBuildingEntry } from './utils/buildingData';
import { loadNullahsCSV, matchNullahDistricts } from './utils/nullahsData';
import { loadInfrastructureCSV, findInfrastructure } from './utils/infrastructureData';
import { loadTehsilHousingCSV, findTehsil } from './utils/tehsilData';
import { loadTehsilHazardCSV, findTehsilHazard } from './utils/tehsilHazardData';
import { findDistrictForGeometry } from './utils/geometry';
import { INFRA_LAYERS } from './config/infraLayers';
import './App.css';

function App() {
  const location = useLocation();
  // The dashboard tree below is never unmounted when navigating to other
  // routes — only hidden via CSS (see .dashboard-body / --hidden in
  // App.css). This keeps the Mapbox instance alive and every piece of
  // dashboard state (province/district/tehsil, layers, camera, collapsed
  // sidebars) intact when the user comes back from another page, with no
  // state-lifting or persistence code needed.
  const isDashboardRoute = location.pathname === '/';

  const [selectedProvince, setSelectedProvince] = React.useState(null);
  const [selectedDistrict, setSelectedDistrict] = React.useState(null);
  const [sidebarCollapsed, setSidebarCollapsed] = React.useState(false);
  const [districtsGeoJSON, setDistrictsGeoJSON] = React.useState(null);
  const [isNationalView, setIsNationalView] = React.useState(false);
  // Imperative "zoom to this" requests from the second sidebar's back
  // navigation (tehsil -> district -> province) — an array of {geometry}
  // or null. See MapContainer's mapFocusFeatures effect.
  const [mapFocusFeatures, setMapFocusFeatures] = React.useState(null);

  // District statistics data
  const [balochistanData, setBalochistanData] = React.useState(null);
  const [kpData, setKPData] = React.useState(null);
  const [sindhData, setSindhData] = React.useState(null);
  const [punjabData, setPunjabData] = React.useState(null);
  const [ajkData, setAJKData] = React.useState(null);
  const [gbData, setGBData] = React.useState(null);
  const [nationalCSVData, setNationalCSVData] = React.useState(null);
  const [nullahsData, setNullahsData] = React.useState(null);
  const [infraData, setInfraData] = React.useState(null);
  const [tehsilIndex, setTehsilIndex] = React.useState(null);
  // Per-tehsil prominent hazards + terrain/demography notes, shown in the
  // second sidebar only while a specific tehsil is active.
  const [tehsilHazardIndex, setTehsilHazardIndex] = React.useState(null);
  // Tehsil currently selected/analyzed anywhere (left sidebar, map click, or
  // the right dock's tehsil list). Drives the tehsil-specific hazard profile
  // pinned at the bottom of the right dock.
  const [selectedTehsil, setSelectedTehsil] = React.useState(null);
  // Tehsil the user has drilled into in the second sidebar (DistrictTehsilSidebar).
  // Lifted here so a tehsil clicked on the map also lights up its row in that
  // sidebar (and vice-versa). null = no active tehsil.
  const [activeTehsilName, setActiveTehsilName] = React.useState(null);
  // Tehsil polygon the user clicked, to auto-analyze inside the district modal's
  // tehsils section: { district, name } | null
  const [pendingTehsil, setPendingTehsil] = React.useState(null);
  const [statsModalData, setStatsModalData] = React.useState(null);
  const [statsModalProvince, setStatsModalProvince] = React.useState(null);
  const [showDistrictStats, setShowDistrictStats] = React.useState(false);
  const [showNationalStats, setShowNationalStats] = React.useState(false);
  const [showBuildings, setShowBuildings] = React.useState(false);
  const [buildingIndex, setBuildingIndex] = React.useState(null);
  const [activeBuildingDistrict, setActiveBuildingDistrict] = React.useState(null); // { districtKey }
  const [buildingsLoading, setBuildingsLoading] = React.useState(false);
  // GeoJSON of buildings inside the tehsil the user is viewing — drives the
  // map overlay. The TehsilBuildingsModal computes/caches it and sets this.
  const [tehsilBuildingsGeoJSON, setTehsilBuildingsGeoJSON] = React.useState(null);
  // GeoJSON of the SIMEX scenario footprint clipped to the tehsil (polygon layer).
  const [tehsilScenarioClipGeoJSON, setTehsilScenarioClipGeoJSON] = React.useState(null);
  const [encroachmentDistrict, setEncroachmentDistrict] = React.useState(null);
  // District for which the Flood Projections 2026 count/area modal is open.
  const [floodProjectionDistrict, setFloodProjectionDistrict] = React.useState(null);
  // District name whose encroached-buildings GeoJSON should be displayed on the map.
  // Set when an analysis completes; cleared when the user changes district.
  const [encroachedMapDistrict, setEncroachedMapDistrict] = React.useState(null);
  // Reload counter — bumped every time the modal confirms a result so the
  // map fetch effect re-runs even when the district hasn't changed.
  const [encroachReloadKey, setEncroachReloadKey] = React.useState(0);

  // Geocoding / location search
  const [searchResult, setSearchResult] = React.useState(null);
  const [pendingDistrict, setPendingDistrict] = React.useState(null);

  // Streams Exposure (Impact Layer)
  const [exposureDate, setExposureDate] = React.useState(null);
  const [exposureRows, setExposureRows] = React.useState(null);          // normalised rows
  const [exposureGeoJSON, setExposureGeoJSON] = React.useState(null);     // joined FeatureCollection
  const [exposureLoading, setExposureLoading] = React.useState(false);
  const [exposureError, setExposureError] = React.useState(null);
  const [exposureDatePickerOpen, setExposureDatePickerOpen] = React.useState(false);
  const [exposureSummaryOpen, setExposureSummaryOpen] = React.useState(false);
  const [selectedStream, setSelectedStream] = React.useState(null);       // { id, schools, ... }
  const exposureAbortRef = React.useRef(null);

  const handleLoadExposure = async (dateISO) => {
    if (exposureAbortRef.current) exposureAbortRef.current.abort();
    exposureAbortRef.current = new AbortController();
    const { signal } = exposureAbortRef.current;
    setExposureDatePickerOpen(false);
    setExposureLoading(true);
    setExposureError(null);
    setExposureDate(dateISO);
    setSelectedStream(null);
    try {
      const rows = await fetchExposureByDate(dateISO, signal);
      const ids = rows.map((r) => r.id).filter(Boolean);
      const fc = await fetchStreamGeometries(ids, signal);
      const joined = joinExposure(fc, rows);
      setExposureRows(rows);
      setExposureGeoJSON(joined);
      setExposureSummaryOpen(true);
    } catch (err) {
      if (err.name !== 'AbortError') {
        console.error('[exposure] load failed', err);
        setExposureError(err.message || 'Failed to load exposure data');
      }
    } finally {
      setExposureLoading(false);
    }
  };

  const handleClearExposure = () => {
    if (exposureAbortRef.current) exposureAbortRef.current.abort();
    setExposureRows(null);
    setExposureGeoJSON(null);
    setExposureSummaryOpen(false);
    setSelectedStream(null);
    setExposureDate(null);
    setExposureError(null);
  };

  // GCOP / DEW exposure — only the red polygon footprint goes on the map.
  // Per-district building counts are rendered inside the modal.
  const [gcopModalOpen, setGcopModalOpen] = React.useState(false);
  const [gcopGeoJSON, setGcopGeoJSON] = React.useState(null);
  // Pre-computed SIMEX scenario buildings for a single district shown on map.
  const [simexBuildingsData, setSimexBuildingsData] = React.useState(null);
  // { scenarioId, district, geojson } | null

  const handleGCOPLoaded = (fc) => setGcopGeoJSON(fc);
  const handleGCOPCleared = () => { setGcopGeoJSON(null); setSimexBuildingsData(null); };

  // SIMEX Risk Calculator state
  const [simexRiskData, setSimexRiskData] = React.useState(null);
  // { scenarioId, scenarioLabel, district, buildingCount, districtData, province }

  const handleOpenSimexRisk = (scenarioId, district, buildingCount) => {
    const displayDistrict = district.replace(/_/g, ' ');
    let districtData = null;
    let province = null;
    // Search loaded province datasets for this district
    const datasets = [
      [balochistanData, 'balochistan'],
      [kpData, 'kpk'],
      [sindhData, 'sindh'],
      [punjabData, 'punjab'],
      [gbData, 'gilgit-baltistan'],
      [ajkData, 'ajk'],
    ];
    for (const [data, prov] of datasets) {
      if (!data) continue;
      const rec = findDistrict(data, displayDistrict);
      if (rec) { districtData = rec; province = prov; break; }
    }
    setSimexRiskData({ scenarioId, scenarioLabel: `Scenario ${scenarioId}`, district: displayDistrict, buildingCount, districtData, province });
  };

  const handleToggleSimexBuildings = (scenarioId, district) => {
    if (simexBuildingsData?.scenarioId === scenarioId && simexBuildingsData?.district === district) {
      setSimexBuildingsData(null);
      return;
    }
    fetch(`/pyapi/simex/buildings/${encodeURIComponent(scenarioId)}/${encodeURIComponent(district)}`)
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then((geojson) => setSimexBuildingsData({ scenarioId, district, geojson }))
      .catch((err) => console.error('[simex buildings]', err));
  };

  const handleStreamClick = (props) => {
    if (!props) { setSelectedStream(null); return; }
    setSelectedStream({
      id: props._streamId,
      schools:         Number(props.schools         || 0),
      settlements:     Number(props.settlements     || 0),
      population:      Number(props.population      || 0),
      hospitals:       Number(props.hospitals       || 0),
      bridges:         Number(props.bridges         || 0),
      airports:        Number(props.airports        || 0),
      railwayStations: Number(props.railwayStations || 0),
    });
  };

  // Encroachment overlay layer styles. Order = render order (first = bottom).
  const DEFAULT_ENCROACHMENT_LAYERS = [
    { id: 'enc-river',     label: 'Encroachment Zone',   visible: true, fillColor: '#ffffff', fillOpacity: 0.45, strokeColor: '#ffffff', strokeOpacity: 0.85, strokeWidth: 1.4 },
    { id: 'enc-buildings', label: 'Encroached Buildings', visible: true, fillColor: '#ef4444', fillOpacity: 0.85, strokeColor: '#7f1d1d', strokeOpacity: 1.0,  strokeWidth: 0.5 },
  ];
  const [encroachmentLayers, setEncroachmentLayers] = React.useState(DEFAULT_ENCROACHMENT_LAYERS);

  const handleEncroachmentLayerUpdate = (id, updates) => {
    setEncroachmentLayers((prev) => prev.map((l) => l.id === id ? { ...l, ...updates } : l));
  };
  const handleEncroachmentLayerReorder = (newOrder) => setEncroachmentLayers(newOrder);

  const DEFAULT_FLOOD_LAYERS = [
    { year: '2010', label: 'Flood 2010', visible: false, fillColor: '#e53935', fillOpacity: 0.35, strokeColor: '#e53935', strokeOpacity: 0.8, strokeWidth: 1.2 },
    { year: '2022', label: 'Flood 2022', visible: false, fillColor: '#e53935', fillOpacity: 0.35, strokeColor: '#e53935', strokeOpacity: 0.8, strokeWidth: 1.2 },
    { year: '2025', label: 'Flood 2025', visible: false, fillColor: '#e53935', fillOpacity: 0.35, strokeColor: '#e53935', strokeOpacity: 0.8, strokeWidth: 1.2 },
    { year: 'gb-proj-2026', label: 'GB Flood Projection 2026', visible: false, fillColor: '#1e88e5', fillOpacity: 0.35, strokeColor: '#1e88e5', strokeOpacity: 0.9, strokeWidth: 1.5 },
    { year: 'sus-1', label: 'Susceptibility – Low', visible: false, fillColor: '#4caf50', fillOpacity: 0.5, strokeColor: '#333333', strokeOpacity: 0.8, strokeWidth: 0.8 },
    { year: 'sus-2', label: 'Susceptibility – Medium', visible: false, fillColor: '#ffc107', fillOpacity: 0.5, strokeColor: '#333333', strokeOpacity: 0.8, strokeWidth: 0.8 },
    { year: 'sus-3', label: 'Susceptibility – High', visible: false, fillColor: '#e53935', fillOpacity: 0.5, strokeColor: '#333333', strokeOpacity: 0.8, strokeWidth: 0.8 },
  ];
  const [floodLayers, setFloodLayers] = React.useState(DEFAULT_FLOOD_LAYERS);

  const handleFloodLayerUpdate = (year, updates) => {
    setFloodLayers((prev) => prev.map((l) => l.year === year ? { ...l, ...updates } : l));
  };

  const handleFloodLayerReorder = (newOrder) => {
    setFloodLayers(newOrder);
  };

  // Infrastructure overlay layers (Rivers, Roads, Hospitals, Schools, Dams).
  // Only visibility is lifted to App state — style/source/type live in the
  // static config/infraLayers.js registry, same split MapContainer already
  // uses for reading FLOOD_SOURCES vs the editable floodLayers array.
  const [infraLayers, setInfraLayers] = React.useState(
    () => INFRA_LAYERS.map((l) => ({ id: l.id, visible: l.defaultVisible })),
  );
  const handleInfraLayerToggle = (id) => {
    setInfraLayers((prev) => prev.map((l) => (l.id === id ? { ...l, visible: !l.visible } : l)));
  };

  // Maps national_stats.csv province names → our display names
  const NATIONAL_CSV_NAME_MAP = {
    'KHYBER PAKHTUNKHWA': 'KP',
    'PUNJAB': 'Punjab',
    'SINDH': 'Sindh',
    'BALOCHISTAN': 'Balochistan',
  };

  // Aggregate national stats whenever province data loads
  const nationalStats = React.useMemo(() => {
    const aggs = [];
    if (balochistanData) aggs.push(aggregateProvince(balochistanData, 'Balochistan', '#b39ddb'));
    if (kpData)          aggs.push(aggregateProvince(kpData, 'KP', '#80cbc4'));
    if (sindhData)       aggs.push(aggregateProvince(sindhData, 'Sindh', '#ffb74d'));
    if (punjabData)      aggs.push(aggregateProvince(punjabData, 'Punjab', '#ef9a9a'));
    if (ajkData)         aggs.push(aggregateProvince(ajkData, 'AJK', '#80deea'));
    if (gbData)          aggs.push(aggregateProvince(gbData, 'Gilgit Baltistan', '#a5d6a7'));

    // Override population & structures with official national_stats.csv numbers
    if (nationalCSVData) {
      for (const [csvName, displayName] of Object.entries(NATIONAL_CSV_NAME_MAP)) {
        const official = nationalCSVData.get(csvName);
        const agg = aggs.find((a) => a.name === displayName);
        if (official && agg) {
          if (official.total != null) {
            agg.population.total   = official.total;
            agg.population.male    = official.male;
            agg.population.female  = official.female;
            agg.population.area    = official.area;
            agg.population.density = official.density;
            agg.population.avgHHSize = official.avgHHSize;
          }
          if (official.totalStructures != null) {
            agg.structures = official.totalStructures;
            if (agg.housing) agg.housing.totalStructures = official.totalStructures;
          }
          // Attach full official row so the provincial panel can show all breakdown fields
          agg.officialStats = official;
        }
      }

      // Add Islamabad from national CSV (no district breakdown available)
      const ict = nationalCSVData.get('ISLAMABAD');
      if (ict) {
        aggs.push({
          name: 'Federal Capital', color: '#7986cb', districts: 1,
          population: { total: ict.total, male: ict.male, female: ict.female, area: ict.area, density: ict.density, avgHHSize: ict.avgHHSize },
          structures: ict.totalStructures,
          housing: null,
          education: { total: 0 },
          health: null,
          roads: null,
          officialStats: ict,
        });
      }
    }

    if (aggs.length === 0) return null;
    const result = buildNationalStats(aggs);
    // Attach raw PAKISTAN row so the panel can display male/female and structure breakdown
    if (nationalCSVData) result.national = nationalCSVData.get('PAKISTAN') ?? null;
    return result;
  }, [balochistanData, kpData, sindhData, punjabData, ajkData, gbData, nationalCSVData]);

  // Dashboard-only data (province CSVs + the 286MB district boundary
  // GeoJSON) used to load unconditionally on app boot. The dashboard tree
  // stays mounted (hidden, not unmounted) when navigating to other routes
  // so its state survives, but that also meant this effect fired regardless
  // of which route was actually being viewed — so visiting e.g. Incident
  // Records directly still triggered the 286MB fetch + JSON-parse in the
  // background, blocking the main thread for everything else on the page.
  // Deferring all of it until the dashboard route is genuinely visited —
  // and only ever fetching once — fixes that without changing what's
  // fetched or how the dashboard consumes it.
  const dashboardDataFetchedRef = React.useRef(false);
  React.useEffect(() => {
    if (!isDashboardRoute || dashboardDataFetchedRef.current) return;
    dashboardDataFetchedRef.current = true;
    fetch('/pakistan_districts.geojson')
      .then((r) => r.json())
      .then(setDistrictsGeoJSON);
    loadBalochistanDistricts().then(setBalochistanData).catch(console.error);
    loadKPDistricts().then(setKPData).catch(console.error);
    loadSindhDistricts().then(setSindhData).catch(console.error);
    loadPunjabDistricts().then(setPunjabData).catch(console.error);
    loadAJKDistricts().then(setAJKData).catch(console.error);
    loadGBDistricts().then(setGBData).catch(console.error);
    loadNationalStatsCSV().then(setNationalCSVData).catch(console.error);
    loadBuildingIndex().then(setBuildingIndex).catch(console.error);
    loadNullahsCSV().then(setNullahsData).catch(console.error);
    loadInfrastructureCSV().then(setInfraData).catch(console.error);
    loadTehsilHousingCSV().then(setTehsilIndex).catch(console.error);
    loadTehsilHazardCSV().then(setTehsilHazardIndex).catch(console.error);
  }, [isDashboardRoute]);

  // Open the tehsil-buildings browser when a tehsil polygon is clicked. props
  // are the GeoServer feature properties. Most layers expose lowercase
  // { name, district, province }; the corrected GB layer uses { TEHSIL,
  // DISTRICT, PROVINCE }, so accept either casing.
  // Clicking a tehsil polygon opens (or focuses) that tehsil's district stats
  // modal and auto-analyzes the clicked tehsil in its Tehsils section.
  const handleTehsilSelect = (props, geometry) => {
    const name = props?.name || props?.TEHSIL;
    if (!name) return;
    // Switching tehsils invalidates any buildings overlay from the previous one.
    setTehsilBuildingsGeoJSON(null);
    // Resolve the real district that contains this tehsil — the layer's DISTRICT
    // column can use legacy combined names (e.g. "HUNZA NAGAR").
    const resolved = geometry ? findDistrictForGeometry(districtsGeoJSON, geometry) : null;
    const districtName = resolved?.name || props?.district || props?.DISTRICT || null;
    if (!districtName) return;
    setPendingTehsil({ district: districtName, name });
    handleDistrictSelect(districtName);
    setSelectedTehsil(name);
    setActiveTehsilName(name);
    // Fit the camera to the tehsil itself — the same zoom the second sidebar's
    // drill-in performs (onMapFocus). Without this, a tehsil clicked straight
    // on the map only ever gets the district-level fit, not the tehsil-level one.
    if (geometry) setMapFocusFeatures([{ geometry }]);
  };

  // Per-district construction-type / structure-age counts, matched (fuzzy) to
  // the district whose stats modal is open.
  const infraForDistrict = React.useMemo(
    () => findInfrastructure(infraData, statsModalData?.name),
    [infraData, statsModalData],
  );

  // Boundary geometry of the open district, used to spatially list its tehsils.
  const selectedDistrictGeometry = React.useMemo(() => {
    const nm = statsModalData?.name;
    if (!nm || !districtsGeoJSON) return null;
    const f = districtsGeoJSON.features.find((x) => x.properties?.name === nm);
    return f?.geometry || null;
  }, [statsModalData, districtsGeoJSON]);

  // Fuzzy-match nullah CSV districts onto the loaded AJK district names.
  // Memoized so the modal receives a stable reference per data load.
  const nullahsForAJK = React.useMemo(() => {
    if (!nullahsData || !ajkData) return null;
    const canonical = Array.from(ajkData.keys());
    const { matched, unmatched } = matchNullahDistricts(nullahsData.districts, canonical);
    // matchedByCanonical: canonicalName -> { csvName, nullahs, exposedFamilies }
    const matchedByCanonical = new Map();
    for (const [canonicalName, csvName] of matched.entries()) {
      const entry = nullahsData.byDistrict.get(csvName);
      if (entry) matchedByCanonical.set(canonicalName, { csvName, ...entry });
    }
    // unmatchedEntries: array of full entries for districts that didn't map
    const unmatchedEntries = unmatched
      .map((d) => nullahsData.byDistrict.get(d))
      .filter(Boolean);
    return { matchedByCanonical, unmatchedEntries };
  }, [nullahsData, ajkData]);

  // Derive province-level stats from precomputed nationalStats
  const selectedProvinceStats = React.useMemo(() => {
    if (!selectedProvince || !nationalStats) return null;
    const dispName = provinceLabel(selectedProvince);
    return nationalStats.provinces.find((p) => p.name === dispName) || null;
  }, [selectedProvince, nationalStats]);

  const handleNationalSelect = () => {
    setIsNationalView(true);
    setSelectedProvince(null);
    setSelectedDistrict(null);
    setSelectedTehsil(null);
    setActiveTehsilName(null);
    setStatsModalData(null);
    setStatsModalProvince(null);
    setShowDistrictStats(false);
    setShowNationalStats(true);
    setSidebarCollapsed(false);
  };

  const handleProvinceSelect = (provinceId) => {
    // No-op when the user is already on this province — avoids wiping
    // selected district / building / encroachment overlays just because the
    // user clicked somewhere inside the same province's borders.
    if (provinceId === selectedProvince && !isNationalView) return;
    setIsNationalView(false);
    setSelectedProvince(provinceId);
    setSelectedDistrict(null);
    setSelectedTehsil(null);
    setActiveTehsilName(null);
    setStatsModalData(null);
    setStatsModalProvince(null);
    setShowDistrictStats(false);
    setShowNationalStats(false);
    setSidebarCollapsed(false);
    setActiveBuildingDistrict(null);
    setShowBuildings(false);
    setEncroachedMapDistrict(null);
  };

  const handleDistrictSelect = (districtName) => {
    setSelectedDistrict(districtName);
    setSelectedTehsil(null);
    setActiveTehsilName(null);
    // Turn off buildings when switching districts
    if (activeBuildingDistrict && activeBuildingDistrict.districtKey.toLowerCase() !== districtName.toLowerCase()) {
      setActiveBuildingDistrict(null);
      setShowBuildings(false);
    }
    // Clear encroachment overlay when switching districts
    if (encroachedMapDistrict && encroachedMapDistrict.toLowerCase() !== districtName.toLowerCase()) {
      setEncroachedMapDistrict(null);
    }
    const resolved = resolveDistrict(selectedProvince, districtName, {
      balochistan: balochistanData,
      kpk: kpData,
      sindh: sindhData,
      punjab: punjabData,
      ajk: ajkData,
      'gilgit-baltistan': gbData,
      nationalCSVData,
    });
    if (resolved) {
      setStatsModalData(resolved.record);
      setStatsModalProvince(resolved.label);
      setShowDistrictStats(true);
    } else {
      // No housing record (e.g. Gupis Yasin) — still open the modal so the
      // tehsils + building analysis are available; housing sections show empty.
      setStatsModalData({ name: districtName, population: {} });
      setStatsModalProvince(provinceLabel(selectedProvince));
      setShowDistrictStats(true);
    }
  };

  const handleSearch = (result) => {
    setSearchResult(result);
    if (result.provinceId) {
      handleProvinceSelect(result.provinceId);
      if (result.districtName) {
        setPendingDistrict({ name: result.districtName, provinceId: result.provinceId });
      }
    }
  };

  // Fire district select once the province state has settled
  React.useEffect(() => {
    if (!pendingDistrict || selectedProvince !== pendingDistrict.provinceId) return;
    handleDistrictSelect(pendingDistrict.name);
    setPendingDistrict(null);
  }, [selectedProvince, pendingDistrict]);

  // Hazard/terrain profile for the tehsil currently selected anywhere in the
  // app (map click, left sidebar, or right-dock tehsil list). Rendered at the
  // bottom of the right dock by DistrictStatsModal.
  const tehsilHazardProfile = React.useMemo(() => {
    if (!selectedTehsil) return null;
    return findTehsilHazard(tehsilHazardIndex, selectedTehsil, selectedDistrict);
  }, [selectedTehsil, selectedDistrict, tehsilHazardIndex]);

  const handleToggleDistrictBuildings = (districtName) => {
    // If already showing buildings for this district, turn off
    if (showBuildings && activeBuildingDistrict?.districtKey?.toLowerCase() === districtName?.toLowerCase()) {
      setActiveBuildingDistrict(null);
      setShowBuildings(false);
      return;
    }
    const entry = findBuildingEntry(buildingIndex, districtName);
    if (entry) {
      setActiveBuildingDistrict(entry);
      setShowBuildings(true);
    }
  };


  // Also support clicking a district on the map when province data is already loaded
  React.useEffect(() => {
    if (!selectedDistrict) return;
    const resolved = resolveDistrict(selectedProvince, selectedDistrict, {
      balochistan: balochistanData,
      kpk: kpData,
      sindh: sindhData,
      punjab: punjabData,
      ajk: ajkData,
      'gilgit-baltistan': gbData,
      nationalCSVData,
    });
    if (resolved) {
      setStatsModalData(resolved.record);
      setStatsModalProvince(resolved.label);
      setShowDistrictStats(true);
    }
  }, [selectedDistrict, balochistanData, kpData, sindhData, punjabData, ajkData, gbData, nationalCSVData, selectedProvince]);

  return (
    <div className="app-container">
      <Header onSearch={handleSearch} />
      <div className={`dashboard-body${isDashboardRoute ? '' : ' dashboard-body--hidden'}`}>
      <div className="main-layout">
        <Sidebar
          selectedProvince={selectedProvince}
          selectedDistrict={selectedDistrict}
          onProvinceSelect={handleProvinceSelect}
          collapsed={sidebarCollapsed}
          onToggleCollapse={() => setSidebarCollapsed((c) => !c)}
          isNationalView={isNationalView}
          onNationalSelect={handleNationalSelect}
          floodLayers={floodLayers}
          onFloodLayerUpdate={handleFloodLayerUpdate}
          onFloodLayerReorder={handleFloodLayerReorder}
          districtData={statsModalData}
          encroachmentLayers={encroachmentLayers}
          onEncroachmentLayerUpdate={handleEncroachmentLayerUpdate}
          onEncroachmentLayerReorder={handleEncroachmentLayerReorder}
          onOpenEncroachment={() => {
            if (selectedDistrict) setEncroachmentDistrict(selectedDistrict);
          }}
          encroachmentEnabled={!!selectedDistrict}
          onOpenExposure={() => setExposureDatePickerOpen(true)}
          exposureActive={!!exposureGeoJSON}
          onOpenGCOPExposure={() => setGcopModalOpen(true)}
          gcopExposureActive={!!gcopGeoJSON}
          onOpenFloodProjection={() => {
            if (selectedDistrict) setFloodProjectionDistrict(selectedDistrict);
          }}
        />
        {selectedProvince && !isNationalView && (
          <DistrictTehsilSidebar
            selectedProvince={selectedProvince}
            selectedDistrict={selectedDistrict}
            districtsGeoJSON={districtsGeoJSON}
            onDistrictSelect={handleDistrictSelect}
            onTehsilSelect={handleTehsilSelect}
            onMapFocus={setMapFocusFeatures}
            activeTehsilName={activeTehsilName}
            onActiveTehsilChange={setActiveTehsilName}
            onBackToDistricts={() => {
              setSelectedDistrict(null);
              setShowDistrictStats(false);
              setSelectedTehsil(null);
              setActiveTehsilName(null);
              setTehsilBuildingsGeoJSON(null);
              setTehsilScenarioClipGeoJSON(null);
              setPendingTehsil(null);
            }}
          />
        )}
        <MapContainer
          selectedProvince={selectedProvince}
          selectedDistrict={selectedDistrict}
          sidebarCollapsed={sidebarCollapsed}
          onToggleSidebar={() => setSidebarCollapsed(false)}
          districtsGeoJSON={districtsGeoJSON}
          onProvinceSelect={handleProvinceSelect}
          onDistrictSelect={handleDistrictSelect}
          isNationalView={isNationalView}
          mapFocusFeatures={mapFocusFeatures}
          floodLayers={floodLayers}
          showBuildings={showBuildings}
          activeBuildingDistrict={activeBuildingDistrict}
          onBuildingsLoading={setBuildingsLoading}
          encroachedMapDistrict={encroachedMapDistrict}
          encroachmentLayers={encroachmentLayers}
          encroachReloadKey={encroachReloadKey}
          searchResult={searchResult}
          exposureGeoJSON={exposureGeoJSON}
          onStreamClick={handleStreamClick}
          gcopGeoJSON={gcopGeoJSON}
          simexBuildingsGeoJSON={simexBuildingsData?.geojson}
          tehsilBuildingsGeoJSON={tehsilBuildingsGeoJSON}
          tehsilScenarioClipGeoJSON={tehsilScenarioClipGeoJSON}
          onTehsilSelect={handleTehsilSelect}
          infraLayers={infraLayers}
          onInfraLayerToggle={handleInfraLayerToggle}
        />
      </div>

      {showDistrictStats && statsModalData && (
        <DistrictStatsModal
          data={statsModalData}
          province={statsModalProvince}
          onClose={() => { setShowDistrictStats(false); setSelectedTehsil(null); setActiveTehsilName(null); setTehsilBuildingsGeoJSON(null); setTehsilScenarioClipGeoJSON(null); setPendingTehsil(null); }}
          hasBuildingData={!!findBuildingEntry(buildingIndex, statsModalData?.name)}
          onToggleBuildings={() => handleToggleDistrictBuildings(statsModalData?.name)}
          buildingsActive={showBuildings && activeBuildingDistrict?.districtKey?.toLowerCase() === statsModalData?.name?.toLowerCase()}
          buildingsLoading={buildingsLoading}
          onOpenEncroachment={() => setEncroachmentDistrict(statsModalData?.name)}
          nullahsForDistrict={statsModalProvince === 'AJK' ? nullahsForAJK?.matchedByCanonical?.get(statsModalData?.name) : null}
          unmatchedNullahDistricts={statsModalProvince === 'AJK' ? nullahsForAJK?.unmatchedEntries : null}
          infrastructure={infraForDistrict}
          activeTehsil={selectedTehsil}
          hazardProfile={tehsilHazardProfile}
          tehsilsSection={selectedDistrictGeometry && (
            <TehsilBuildingsPanel
              key={`tb-${statsModalProvince}-${statsModalData?.name}`}
              province={statsModalProvince}
              district={statsModalData?.name}
              districtGeometry={selectedDistrictGeometry}
              initialTehsil={pendingTehsil?.district === statsModalData?.name ? pendingTehsil?.name : undefined}
              onBuildingsGeoJSON={setTehsilBuildingsGeoJSON}
              onScenarioClipGeoJSON={setTehsilScenarioClipGeoJSON}
              onTehsilActive={setSelectedTehsil}
            />
          )}
        />
      )}

      {encroachmentDistrict && (
        <EncroachmentModal
          district={encroachmentDistrict}
          onClose={() => setEncroachmentDistrict(null)}
          onResultReady={() => {
            console.log('[encroach] modal onResultReady fired for', encroachmentDistrict);
            setEncroachedMapDistrict(encroachmentDistrict);
            // Bump even if the district hasn't changed — this forces the map
            // fetch effect to re-run and reload the cached GeoJSON layers.
            setEncroachReloadKey((k) => k + 1);
          }}
        />
      )}

      {floodProjectionDistrict && (
        <FloodProjectionModal
          district={floodProjectionDistrict}
          onClose={() => setFloodProjectionDistrict(null)}
        />
      )}

      {showNationalStats && !showDistrictStats && nationalStats && (
        <NationalStatsPanel
          stats={nationalStats}
          onClose={() => setShowNationalStats(false)}
        />
      )}

      {!showNationalStats && !showDistrictStats && selectedProvinceStats && (
        <ProvincialStatsPanel
          provinceData={selectedProvinceStats}
          onClose={() => setSelectedProvince(null)}
        />
      )}

      {exposureDatePickerOpen && (
        <ExposureDatePickerModal
          defaultDate={exposureDate}
          onLoad={handleLoadExposure}
          onClose={() => setExposureDatePickerOpen(false)}
        />
      )}

      {exposureLoading && (
        <div className="exposure-toast" role="status">
          <span className="exposure-toast__spin" />
          <span>Loading exposure for {exposureDate}…</span>
        </div>
      )}

      {exposureError && !exposureLoading && (
        <div className="exposure-toast exposure-toast--error" role="alert" onClick={() => setExposureError(null)}>
          <span>Exposure load failed: {exposureError}</span>
          <span className="exposure-toast__hint">(click to dismiss)</span>
        </div>
      )}

      {exposureSummaryOpen && exposureRows && (
        <ExposureSummaryModal
          date={exposureDate}
          rows={exposureRows}
          streamCount={exposureGeoJSON?.features?.length}
          onClose={handleClearExposure}
        />
      )}

      {selectedStream && (
        <StreamExposureCard
          stream={selectedStream}
          onClose={() => setSelectedStream(null)}
        />
      )}

      {gcopModalOpen && (
        <GCOPExposureModal
          hasExposure={!!gcopGeoJSON}
          onExposureLoaded={handleGCOPLoaded}
          onExposureCleared={handleGCOPCleared}
          onClose={() => setGcopModalOpen(false)}
          buildingIndex={buildingIndex}
          showBuildings={showBuildings}
          activeBuildingDistrict={activeBuildingDistrict}
          onToggleBuildings={handleToggleDistrictBuildings}
          onToggleSimexBuildings={handleToggleSimexBuildings}
          simexActiveDistrict={simexBuildingsData?.district}
          onOpenSimexRisk={handleOpenSimexRisk}
        />
      )}
      {simexRiskData && (
        <SimexRiskCalculatorModal
          {...simexRiskData}
          onClose={() => setSimexRiskData(null)}
        />
      )}
      </div>

      {!isDashboardRoute && (
        <Routes>
          <Route path="/incident-records" element={<IncidentRecordsPage />} />
          <Route path="/incident-records/:id" element={<IncidentDetailPage />} />
          <Route path="/flood-simulation" element={<FloodSimulationPage />} />
          <Route path="/flood-simulation-3d" element={<FloodSimulation3DPage />} />
          <Route path="/flood-simulation-v5" element={<FloodSimulationV5Page />} />
          <Route path="/flood-simulation-vulnerability" element={<FloodVulnerabilityPage />} />
          <Route path="/flood-simulation-vulnerability-v2" element={<FloodVulnerabilityV2Page />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      )}
    </div>
  );
}

export default App;
