import React, { useEffect, useMemo, useState } from 'react';
import { PROVINCES } from '../../config/mapConfig';
import { loadDistrictTehsils } from '../../utils/districtTehsils';
import { findTehsilHazard } from '../../utils/tehsilHazardData';
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
function DistrictTehsilSidebar({ selectedProvince, selectedDistrict, districtsGeoJSON, onDistrictSelect, onTehsilSelect, onMapFocus, onBackToDistricts, tehsilHazardIndex }) {
  const [collapsed, setCollapsed] = useState(false);
  const [districtQuery, setDistrictQuery] = useState('');
  const [tehsils, setTehsils] = useState(null);
  const [tehsilError, setTehsilError] = useState(null);
  // Which tehsil (if any) the user has zoomed into from this panel — a
  // third navigational depth on top of district/province, purely local to
  // this sidebar's back-button behavior (the right dock's own "active
  // tehsil" for building counts is separate state in TehsilBuildingsPanel).
  const [activeTehsilName, setActiveTehsilName] = useState(null);

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

  // Hazard/terrain profile for the active tehsil only — the panel never
  // shows this for a district or province, per spec.
  const hazardProfile = useMemo(() => {
    if (!activeTehsilName || !tehsilHazardIndex) return null;
    return findTehsilHazard(tehsilHazardIndex, activeTehsilName, selectedDistrict);
  }, [activeTehsilName, selectedDistrict, tehsilHazardIndex]);

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

  // Re-open (and clear any district search / active tehsil) whenever the
  // province or district selection changes, so switching context never
  // leaves the panel collapsed or showing stale state.
  useEffect(() => {
    setCollapsed(false);
    setDistrictQuery('');
    setActiveTehsilName(null);
  }, [selectedProvince, selectedDistrict]);

  const handleTehsilRowClick = (t) => {
    setActiveTehsilName(t.name);
    onTehsilSelect?.({ name: t.name }, t.geometry);
    if (t.geometry) onMapFocus?.([{ geometry: t.geometry }]);
  };

  // Back button, tehsil depth -> district (re-fit to the district, keep
  // the tehsil list open) or district depth -> province (re-fit to the
  // whole province, return to the district list). The map effects that
  // fire on selectedDistrict/selectedProvince *changing* don't apply here
  // since neither value changes on the way back up — onMapFocus is the
  // explicit re-fit channel for that.
  const handleBack = () => {
    if (activeTehsilName) {
      setActiveTehsilName(null);
      if (districtGeometry) onMapFocus?.([{ geometry: districtGeometry }]);
      return;
    }
    onBackToDistricts?.();
    // Spread into a fresh array — districtFeaturesForProvince is memoized,
    // so passing it directly would be the *same* reference as last time
    // this branch ran, and App.jsx's setMapFocusFeatures(sameRef) is then
    // a no-op React bails on, silently skipping the re-fit on a repeat
    // "back to province" click (e.g. district -> province -> district ->
    // province again). A new array is always seen as a change.
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
              title={activeTehsilName ? `Back to ${selectedDistrict}` : `Back to ${province.name} districts`}
            >
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                <path d="M6.5 1.5L2.5 5l4 3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
              Back to {activeTehsilName ? selectedDistrict : province.name}
            </button>
          ) : (
            <span className="tehsil-sidebar-eyebrow">Districts</span>
          )}
          <span className="tehsil-sidebar-district">
            {mode === 'tehsils' ? (activeTehsilName || selectedDistrict) : province.name}
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
      )}

      {/* Hazard/terrain profile — only while a specific tehsil is active. */}
      {activeTehsilName && hazardProfile && (hazardProfile.hazards || hazardProfile.terrain) && (
        <div className="tehsil-hazard-card">
          <div className="tehsil-hazard-eyebrow">Hazard Profile</div>
          {hazardProfile.hazards && (
            <div className="tehsil-hazard-row">
              <span className="tehsil-hazard-label">Prominent Hazards</span>
              <span className="tehsil-hazard-value">{hazardProfile.hazards}</span>
            </div>
          )}
          {hazardProfile.terrain && (
            <div className="tehsil-hazard-row">
              <span className="tehsil-hazard-label">Terrain &amp; Demography</span>
              <span className="tehsil-hazard-value">{hazardProfile.terrain}</span>
            </div>
          )}
        </div>
      )}
    </aside>
  );
}

export default DistrictTehsilSidebar;
