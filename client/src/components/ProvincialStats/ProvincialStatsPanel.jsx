import React from 'react';
import './ProvincialStatsPanel.css';

const fmtK = (n) => {
  if (n == null) return '—';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(0) + 'K';
  return String(n);
};

// Docked (not a popup) — same fixed right-edge panel the district view uses
// (.ds-dock-right / .ps-panel share the same position/size), so the right
// side of the screen behaves identically whether a province or a district
// is selected.
export default function ProvincialStatsPanel({ provinceData, onClose }) {
  if (!provinceData) return null;
  const { name, population, officialStats: os } = provinceData;

  const kpis = [
    { label: 'Population',    value: fmtK(population.total),  accent: '#66bb6a' },
    { label: 'Male',          value: fmtK(population.male),   accent: '#4fc3f7' },
    { label: 'Female',        value: fmtK(population.female), accent: '#f796b8' },
    { label: 'Area (km²)',    value: fmtK(population.area),   accent: '#ffb74d' },
    { label: 'Density /km²',  value: os?.density != null ? String(os.density) : (population.density != null ? String(population.density) : '—'), accent: '#ff8a65' },
    { label: 'Avg HH Size',   value: os?.avgHHSize != null ? String(os.avgHHSize) : (population.avgHHSize != null ? String(population.avgHHSize) : '—'), accent: '#ffd54f' },
  ];

  return (
    <div className="ps-panel">
      <div className="ps-ph" style={{ background: 'linear-gradient(135deg, #0d1b2a 0%, #1a2e45 100%)', borderBottom: `2px solid rgba(56,189,248,0.35)` }}>
        <div className="ps-ph-left">
          <span className="ps-badge">Administrative Unit</span>
          <span className="ps-title">{name}</span>
        </div>
        <div className="ps-ph-actions">
          <button className="ps-close" onClick={onClose} aria-label="Close">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M1 1l12 12M13 1L1 13" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      </div>

      <div className="ps-scroll">
        <div className="ps-coverage">
          Estimates based on available district-level records
        </div>

        {/* KPI grid */}
        <div className="ps-kpi-grid">
          {kpis.map((k) => (
            <div key={k.label} className="ps-kpi" style={{ '--a': k.accent }}>
              <div className="ps-kpi-val">{k.value}</div>
              <div className="ps-kpi-lbl">{k.label}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
