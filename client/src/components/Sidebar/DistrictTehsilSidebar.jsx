import React, { useEffect, useMemo, useState } from 'react';
import { PROVINCES } from '../../config/mapConfig';
import { loadDistrictTehsils } from '../../utils/districtTehsils';
import '../TehsilBuildings/TehsilBuildingsModal.css';
import './Sidebar.css';
import './DistrictTehsilSidebar.css';

/**
 * Second sidebar, beside the main Sidebar. Two modes, same panel:
 *  - Province selected, no district yet  -> lists that province's districts
 *  - District selected                    -> lists that district's tehsils
 * Selecting a district here calls the same onDistrictSelect the main
 * Sidebar always used; selecting a tehsil reuses the existing
 * App.handleTehsilSelect flow verbatim — no new selection logic, only a
 * new place for the same lists to render.
 */
function DistrictTehsilSidebar({ selectedProvince, selectedDistrict, districtsGeoJSON, onDistrictSelect, onTehsilSelect, onMapFocus, onBackToDistricts, activeTehsilName, onActiveTehsilChange }) {
  const [collapsed, setCollapsed] = useState(false);
  const [districtQuery, setDistrictQuery] = useState('');
  const [tehsils, setTehsils] = useState(null);
  const [tehsilError, setTehsilError] = useState(null);
  // The active tehsil only marks a row in the list (so a tehsil clicked on the
  // map is highlighted here too) — it never adds an extra navigation depth.
  // Held in App state (activeTehsilName) to keep the map click + this list in
  // sync.

  const province = useMemo(
    () => PROVINCES.find((p) => p.id === selectedProvince) || null,
    [selectedProvince],
  );

  // Full feature objects (not just names) for every district in the
  // province, so "back" from the district level can re-fit the map to the
  // whole province — the same feature set MapContainer's own
  // "fit to selected province" effect uses.
  const districtFeaturesForProvince = useMemo(() => {
    if (!province || !districtsGeoJSON) return [];
    return districtsGeoJSON.features.filter((f) => f.properties?.province === province.geojsonProvince);
  }, [province, districtsGeoJSON]);

  // District mode: every district under the selected province, from the
  // same districtsGeoJSON the map and the rest of the app already use.
  const districtsForProvince = useMemo(
    () => districtFeaturesForProvince.map((f) => f.properties?.name).filter(Boolean).sort(),
    [districtFeaturesForProvince],
  );

  const filteredDistricts = useMemo(() => {
    if (!districtQuery) return districtsForProvince;
    const q = districtQuery.toLowerCase();
    return districtsForProvince.filter((d) => d.toLowerCase().includes(q));
  }, [districtsForProvince, districtQuery]);

  // Tehsil mode: same lookup App.jsx uses for the modal-embedded panel.
  const districtGeometry = useMemo(() => {
    if (!selectedDistrict || !districtsGeoJSON) return null;
    const f = districtsGeoJSON.features.find((x) => x.properties?.name === selectedDistrict);
    return f?.geometry || null;
  }, [selectedDistrict, districtsGeoJSON]);

  // Load the district's tehsils — the hazard profile for the active tehsil
  // renders pinned at the bottom of the right dock (DistrictStatsModal), not here.
  useEffect(() => {
    if (!selectedDistrict || !districtGeometry) {
      setTehsils(null);
      setTehsilError(null);
      return;
    }
    let cancelled = false;
    setTehsils(null);
    setTehsilError(null);
    loadDistrictTehsils(selectedProvince, { districtGeometry, districtName: selectedDistrict })
      .then((list) => { if (!cancelled) setTehsils(list); })
      .catch((err) => { if (!cancelled) setTehsilError(err.message || 'Failed to load tehsils'); });
    return () => { cancelled = true; };
  }, [selectedProvince, selectedDistrict, districtGeometry]);

  // Re-open (and clear any district search) whenever the province or district
  // selection changes, so switching context never leaves the panel collapsed or
  // showing stale search text. The active tehsil is reset by App's own handlers
  // (handleDistrictSelect / handleProvinceSelect / handleTehsilSelect), which
  // know the full ordering — resetting it here would race a map-click that
  // selects a tehsil in a newly-chosen district.
  useEffect(() => {
    setCollapsed(false);
    setDistrictQuery('');
  }, [selectedProvince, selectedDistrict]);

  const handleTehsilRowClick = (t) => {
    onActiveTehsilChange?.(t.name);
    onTehsilSelect?.({ name: t.name }, t.geometry);
    if (t.geometry) onMapFocus?.([{ geometry: t.geometry }]);
  };

  // Back button — one level only: back to the province's district list. The
  // map effects that fire on selectedDistrict/selectedProvince *changing*
  // don't apply here since neither value changes on the way back up — onMapFocus
  // is the explicit re-fit channel for that.
  const handleBack = () => {
    onBackToDistricts?.();
    // Spread into a fresh array — districtFeaturesForProvince is memoized,
    // so passing it directly would be the *same* reference as last time
    // this ran, and App.jsx's setMapFocusFeatures(sameRef) is then a no-op
    // React bails on, silently skipping the re-fit on a repeat "back to
    // province" click (e.g. district -> province -> district -> province
    // again). A new array is always seen as a change.
    if (districtFeaturesForProvince.length) onMapFocus?.([...districtFeaturesForProvince]);
  };

  if (!province) return null;
  const mode = selectedDistrict ? 'tehsils' : 'districts';

  if (collapsed) {
    return (
      <button
        className="tehsil-sidebar tehsil-sidebar--tab"
        onClick={() => setCollapsed(false)}
        title={mode === 'tehsils' ? `Show tehsils for ${selectedDistrict}` : `Show districts for ${province.name}`}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
          <path d="M4 2l4 4-4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
        <span className="tehsil-sidebar-tab-label">{mode === 'tehsils' ? 'Tehsils' : 'Districts'}</span>
      </button>
    );
  }

  return (
    <aside className="tehsil-sidebar">
      <div className="tehsil-sidebar-header">
        <button className="tehsil-sidebar-collapse" onClick={() => setCollapsed(true)} title="Collapse">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M8 2L4 6l4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </button>
        <div className="tehsil-sidebar-title">
          {mode === 'tehsils' ? (
            <button
              className="tehsil-sidebar-back"
              onClick={handleBack}
              title={`Back to ${province.name} districts`}
            >
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                <path d="M6.5 1.5L2.5 5l4 3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
              Back to {province.name}
            </button>
          ) : (
            <span className="tehsil-sidebar-eyebrow">Districts</span>
          )}
          <span className="tehsil-sidebar-district">
            {mode === 'tehsils' ? `${selectedDistrict} District` : province.name}
          </span>
        </div>
      </div>

      {mode === 'districts' ? (
        <>
          <div className="sidebar-district-search">
            <input
              type="text"
              placeholder="Search districts…"
              value={districtQuery}
              onChange={(e) => setDistrictQuery(e.target.value)}
              className="sidebar-district-input"
            />
            {districtQuery && (
              <button className="sidebar-district-clear" onClick={() => setDistrictQuery('')}>✕</button>
            )}
          </div>
          <div className="sidebar-district-items tehsil-sidebar-list">
            {filteredDistricts.map((d) => (
              <div
                key={d}
                className={`sidebar-district-item${selectedDistrict === d ? ' sidebar-district-item--active' : ''}`}
                onClick={() => onDistrictSelect?.(d)}
              >
                {d}
              </div>
            ))}
            {filteredDistricts.length === 0 && districtQuery && (
              <div className="sidebar-district-empty">No districts match "{districtQuery}"</div>
            )}
          </div>
        </>
      ) : (
        <>
          <div className="tehsil-sidebar-subheading">Tehsil:</div>
          <div className="tb-list tehsil-sidebar-list">
            {tehsils == null && !tehsilError && (
              <div className="tb-loading"><span className="tb-spin" /> Loading tehsils…</div>
            )}
            {tehsilError && <div className="tb-error">Couldn’t load tehsils: {tehsilError}</div>}
            {tehsils && tehsils.length === 0 && (
              <div className="tb-error">No tehsils found for this district.</div>
            )}
            {tehsils && tehsils.map((t) => (
              <button
                key={t.name}
                className={`tb-row${activeTehsilName === t.name ? ' tb-row--active' : ''}`}
                onClick={() => handleTehsilRowClick(t)}
                title="Select this tehsil"
              >
                <span className="tb-row-name">{t.name}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </aside>
  );
}

export default DistrictTehsilSidebar;
