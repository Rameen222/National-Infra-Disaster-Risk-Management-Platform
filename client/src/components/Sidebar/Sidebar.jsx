import React, { useState } from 'react';
import { PROVINCES } from '../../config/mapConfig';
import FloodLayersPanel from './FloodLayersPanel';
import EncroachmentLayersPanel from './EncroachmentLayersPanel';
import SusceptibilityStyleModal from './SusceptibilityStyleModal';
import RiskCalculatorModal from '../RiskCalculator/RiskCalculatorModal';
import './Sidebar.css';

function Sidebar({ selectedProvince, selectedDistrict, onProvinceSelect, collapsed, onToggleCollapse, isNationalView, onNationalSelect, floodLayers, onFloodLayerUpdate, onFloodLayerReorder, districtData, encroachmentLayers, onEncroachmentLayerUpdate, onEncroachmentLayerReorder, onOpenEncroachment, encroachmentEnabled, onOpenExposure, exposureActive, onOpenGCOPExposure, gcopExposureActive, onOpenFloodProjection }) {
  // Flood Projections 2026 is "enabled" when its layer is toggled on.
  const floodProjectionEnabled = floodLayers.some((l) => l.year === 'proj-2026' && l.visible);
  const [floodOpen, setFloodOpen] = useState(false);
  const [encroachOpen, setEncroachOpen] = useState(false);
  const [susOpen, setSusOpen] = useState(false);
  const [susStyleOpen, setSusStyleOpen] = useState(false);
  const [riskCalcOpen, setRiskCalcOpen] = useState(false);

  return (
    <aside className={`sidebar${collapsed ? ' sidebar--collapsed' : ''}`}>
      {/* Sidebar light streaks */}
      <div className="dm-streak dm-streak--1" />
      <div className="dm-streak dm-streak--2" />
      <div className="dm-streak dm-streak--3" />

      <div className="sidebar-header">
        <button
          className={`hamburger-btn${collapsed ? '' : ' is-open'}`}
          onClick={onToggleCollapse}
          title={collapsed ? 'Open sidebar' : 'Close sidebar'}
          aria-label="Toggle sidebar"
        >
          <span />
          <span />
          <span />
        </button>
      </div>

      {!collapsed && (
        <div
          className={`national-row${isNationalView ? ' selected' : ''}`}
          onClick={onNationalSelect}
        >
          <span className="national-icon">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2z" stroke="currentColor" strokeWidth="1.5" fill="none"/>
              <path d="M9.5 6C7.01 7.5 5.5 10.1 5.5 13c0 2.9 1.51 5.5 4 7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" fill="none"/>
              <path d="M15.5 8.5l.6 1.2 1.3.2-1 .9.2 1.3-1.1-.6-1.1.6.2-1.3-1-.9 1.3-.2.6-1.2z" fill="currentColor"/>
            </svg>
          </span>
          <span className="national-name">National</span>
        </div>
      )}

      {!collapsed && (
        <div className="sidebar-divider sidebar-divider--top">
          <span className="sidebar-divider-label">Administrative Units</span>
        </div>
      )}

      <div className="province-list" style={{ display: collapsed ? 'none' : '' }}>
        {/* Selecting a province opens the second sidebar with its district
            list (DistrictTehsilSidebar) — this sidebar is navigation only. */}
        {PROVINCES.map((province) => {
          const isSelected = selectedProvince === province.id;
          return (
            <div key={province.id} className="province-item">
              <div
                className={`province-row ${isSelected ? 'selected' : ''}`}
                onClick={() => onProvinceSelect(province.id)}
                style={{ '--prov-color': province.color }}
              >
                <span className={`tree-icon${isSelected ? ' tree-icon--open' : ''}`}>
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                    <path d="M3.5 2L6.5 5L3.5 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                  </svg>
                </span>
                <span className="province-name">{province.name}</span>
              </div>
            </div>
          );
        })}

        {/* ── Layer accordions ──────────────────────────── */}
        <div className="sidebar-divider">
          <span className="sidebar-divider-label">Hazard &amp; Risk Analysis</span>
        </div>
        <button
          className="sidebar-accordion-header sidebar-accordion-header--flood"
          onClick={() => setFloodOpen((v) => !v)}
        >
          <svg
            className={`accordion-chevron${floodOpen ? ' accordion-chevron--open' : ''}`}
            width="12" height="12" viewBox="0 0 12 12" fill="none"
          >
            <path d="M3 4.5l3 3 3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          <span>Flood Layers</span>
        </button>
        {floodOpen && (
          <>
            <FloodLayersPanel
              floodLayers={floodLayers.filter((l) => !l.year.startsWith('sus-'))}
              onFloodLayerUpdate={onFloodLayerUpdate}
              onFloodLayerReorder={(reordered) => {
                const susLayers = floodLayers.filter((l) => l.year.startsWith('sus-'));
                onFloodLayerReorder([...reordered, ...susLayers]);
              }}
            />
            {/* Per-district structure count/area against the Flood
                Projections 2026 extent — only when projections are on. */}
            {floodProjectionEnabled && (
              <button
                className="risk-calc-btn risk-calc-btn--flood"
                onClick={() => { if (selectedDistrict) onOpenFloodProjection?.(); }}
                disabled={!selectedDistrict}
                title={selectedDistrict
                  ? 'Count and area of structures inside the flood projection for this district'
                  : 'Select a district first'}
                style={!selectedDistrict ? { opacity: 0.5, cursor: 'not-allowed' } : undefined}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                  <path d="M3 16c2-2 4-2 6 0s4 2 6 0 4-2 6 0" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
                  <path d="M3 20c2-2 4-2 6 0s4 2 6 0 4-2 6 0" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" opacity="0.6"/>
                  <path d="M12 3c2.5 3 4 5.3 4 7.5A4 4 0 018 10.5C8 8.3 9.5 6 12 3z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"/>
                </svg>
                {selectedDistrict
                  ? `Generate Count & Area · ${selectedDistrict}`
                  : 'Generate Count & Area of Structures'}
              </button>
            )}
          </>
        )}

        <button
          className="sidebar-accordion-header sidebar-accordion-header--encroach"
          onClick={() => setEncroachOpen((v) => !v)}
        >
          <svg
            className={`accordion-chevron${encroachOpen ? ' accordion-chevron--open' : ''}`}
            width="12" height="12" viewBox="0 0 12 12" fill="none"
          >
            <path d="M3 4.5l3 3 3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          <span>Encroachment</span>
        </button>
        {encroachOpen && (
          <>
            <button
              className="risk-calc-btn risk-calc-btn--encroach"
              onClick={onOpenEncroachment}
              disabled={!encroachmentEnabled}
              title={encroachmentEnabled ? 'Run encroachment analysis for the selected district' : 'Select a district first'}
              style={!encroachmentEnabled ? { opacity: 0.5, cursor: 'not-allowed' } : undefined}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                <path d="M3 17c2-2 4-2 6 0s4 2 6 0 4-2 6 0" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
                <path d="M3 12c2-2 4-2 6 0s4 2 6 0 4-2 6 0" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" opacity="0.7"/>
                <path d="M3 7c2-2 4-2 6 0s4 2 6 0 4-2 6 0" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" opacity="0.45"/>
              </svg>
              {selectedDistrict ? `Run on ${selectedDistrict}` : 'Run Analysis'}
            </button>
            {encroachmentLayers && (
              <EncroachmentLayersPanel
                layers={encroachmentLayers}
                onUpdate={onEncroachmentLayerUpdate}
                onReorder={onEncroachmentLayerReorder}
              />
            )}
          </>
        )}

        <button
          className="sidebar-accordion-header sidebar-accordion-header--sus"
          onClick={() => setSusOpen((v) => !v)}
        >
          <svg
            className={`accordion-chevron${susOpen ? ' accordion-chevron--open' : ''}`}
            width="12" height="12" viewBox="0 0 12 12" fill="none"
          >
            <path d="M3 4.5l3 3 3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          <span>Susceptibility Layers</span>
        </button>
        {susOpen && (
          <div className="sus-panel">
            {floodLayers.filter((l) => l.year.startsWith('sus-')).map((layer) => (
              <div key={layer.year} className={`sus-item${layer.visible ? ' sus-item--active' : ''}`}>
                <input
                  type="checkbox"
                  checked={layer.visible}
                  onChange={() => onFloodLayerUpdate(layer.year, { visible: !layer.visible })}
                />
                <span className="sus-item-swatch" style={{ background: layer.fillColor }} />
                <span className="sus-item-label">{layer.label}</span>
              </div>
            ))}
            <button className="sus-customize-btn" onClick={() => setSusStyleOpen(true)}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="2"/>
                <path d="M12 1v3M12 20v3M4.22 4.22l2.12 2.12M17.66 17.66l2.12 2.12M1 12h3M20 12h3M4.22 19.78l2.12-2.12M17.66 6.34l2.12-2.12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
              </svg>
              Customize Styles
            </button>
          </div>
        )}

        {/* Risk Calculator — below Susceptibility */}
        <button
          className="risk-calc-btn risk-calc-btn--risk"
          onClick={() => setRiskCalcOpen(true)}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
            <path d="M12 2L2 7l10 5 10-5-10-5z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round"/>
            <path d="M2 17l10 5 10-5" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round"/>
            <path d="M2 12l10 5 10-5" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round"/>
          </svg>
          Risk Calculator
        </button>

        {/* Divider */}
        <div className="sidebar-divider">
          <span className="sidebar-divider-label">Exposure Tools</span>
        </div>

        {/* GCOP / DEW Exposure Button */}
        <button
          className={`risk-calc-btn risk-calc-btn--simex${gcopExposureActive ? ' risk-calc-btn--active' : ''}`}
          onClick={onOpenGCOPExposure}
          title="Load a GCOP / DEW exposure footprint"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
            <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2 2M16.4 16.4l2 2M5.6 18.4l2-2M16.4 7.6l2-2"
                  stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/>
            <circle cx="12" cy="12" r="4" stroke="currentColor" strokeWidth="1.6"/>
          </svg>
          {gcopExposureActive ? 'GCOP Active' : 'SIMEX'}
        </button>

        {/* Streams Exposure Button */}
        <button
          className={`risk-calc-btn risk-calc-btn--exposure${exposureActive ? ' risk-calc-btn--active' : ''}`}
          onClick={onOpenExposure}
          title="Load stream exposure for a date"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
            <path d="M3 17c2-2 4-2 6 0s4 2 6 0 4-2 6 0" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
            <path d="M3 12c2-2 4-2 6 0s4 2 6 0 4-2 6 0" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" opacity="0.7"/>
            <path d="M3 7c2-2 4-2 6 0s4 2 6 0 4-2 6 0" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" opacity="0.45"/>
          </svg>
          {exposureActive ? 'Exposure Loaded' : 'Exposure'}
        </button>

      </div>

      {riskCalcOpen && (
        <RiskCalculatorModal
          district={selectedDistrict}
          districtData={districtData}
          province={selectedProvince}
          onClose={() => setRiskCalcOpen(false)}
        />
      )}

      {susStyleOpen && (
        <SusceptibilityStyleModal
          susLayers={floodLayers.filter((l) => l.year.startsWith('sus-'))}
          onUpdate={onFloodLayerUpdate}
          onReorder={(reorderedSus) => {
            const nonSus = floodLayers.filter((l) => !l.year.startsWith('sus-'));
            onFloodLayerReorder([...nonSus, ...reorderedSus]);
          }}
          onClose={() => setSusStyleOpen(false)}
        />
      )}
    </aside>
  );
}

export default Sidebar;
