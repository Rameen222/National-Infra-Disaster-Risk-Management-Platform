import React from 'react';
import useDrag from '../../hooks/useDrag';
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis,
  CartesianGrid, Tooltip, Cell,
} from 'recharts';
import './NationalStatsPanel.css';

const fmtK = (n) => {
  if (n == null) return '—';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000)     return (n / 1_000).toFixed(0)     + 'K';
  return String(n);
};

const Tooltip_ = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="ns-tt">
      <div className="ns-tt-label">{label || payload[0]?.payload?.name}</div>
      {payload.map((p, i) => (
        <div key={i} style={{ color: p.fill || p.color }}>
          {p.name}: <b>{Number(p.value).toLocaleString()}{p.unit || ''}</b>
        </div>
      ))}
    </div>
  );
};

function SecHead({ label, right }) {
  return (
    <div className="ns-sechead">
      <span className="ns-sechead-label">{label}</span>
      {right && <span className="ns-sechead-right">{right}</span>}
    </div>
  );
}

export default function NationalStatsPanel({ stats, onClose }) {
  const { pos, onMouseDown } = useDrag(0, 0);
  const [maximized, setMaximized] = React.useState(false);
  if (!stats) return null;
  const { totals, provinces, national } = stats;

  // Province comparison datasets
  const popData = provinces.map((p) => ({
    name: p.name, value: p.population.total, fill: p.color,
  }));

  // Use official PAKISTAN-row numbers when available, else fall back to aggregated
  const natPop   = national?.total           ?? totals.population;
  const natMale  = national?.male            ?? null;
  const natFem   = national?.female          ?? null;
  const natArea  = national?.area            ?? totals.area;
  const natStr   = national?.totalStructures ?? totals.structures;

  const kpiCards = [
    { label: 'Total Population', value: fmtK(natPop),   accent: '#66bb6a' },
    { label: 'Male',             value: natMale ? fmtK(natMale) : '—', accent: '#4fc3f7' },
    { label: 'Female',           value: natFem  ? fmtK(natFem)  : '—', accent: '#f796b8' },
    { label: 'Area (km²)',       value: fmtK(natArea),  accent: '#ffb74d' },
    { label: 'Housing Units', value: fmtK(natStr),   accent: '#ab47bc' },
    { label: 'Avg HH Size',      value: national?.avgHHSize != null ? String(national.avgHHSize) : '—', accent: '#ffd54f' },
  ];

  return (
    <div className={`ns-panel${maximized ? ' ns-maximized' : ''}`} style={maximized ? undefined : { transform: `translate(${pos.x}px, ${pos.y}px)` }}>
      {/* Light streaks */}
      <div style={{ opacity: 0.5 }}>
        <div className="dm-streak dm-streak--1" />
        <div className="dm-streak dm-streak--2" />
        <div className="dm-streak dm-streak--3" />
      </div>

      {/* Header */}
      <div className="ns-ph" onMouseDown={maximized ? undefined : onMouseDown}>
        <div className="ns-ph-left">
          <span className="ns-badge">National Stats</span>
          <span className="ns-title">Pakistan Overview</span>
        </div>
        <div className="ns-ph-actions">
          <button className="ns-maxbtn" onClick={() => setMaximized((m) => !m)} aria-label={maximized ? 'Restore' : 'Maximize'}>
            {maximized ? (
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><rect x="4" y="1" width="9" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.5" fill="none"/><rect x="1" y="4" width="9" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.5" fill="none"/></svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><rect x="1" y="1" width="12" height="12" rx="1.5" stroke="currentColor" strokeWidth="1.5" fill="none"/></svg>
            )}
          </button>
          <button className="ns-close" onClick={onClose} aria-label="Close">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M1 1l12 12M13 1L1 13" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
            </svg>
          </button>
        </div>
      </div>

      <div className="ns-scroll">

        {/* KPI grid */}
        <div className="ns-kpi-grid ns-sec-1">
          {kpiCards.map((k) => (
            <div key={k.label} className="ns-kpi" style={{ '--a': k.accent }}>
              <div className="ns-kpi-val">{k.value}</div>
              <div className="ns-kpi-lbl">{k.label}</div>
            </div>
          ))}
        </div>

        {/* Population by province */}
        <section className="ns-sec-2">
          <SecHead label="POPULATION BY PROVINCE" right="census" />
          <div className="ns-chart-wrap">
            <ResponsiveContainer width="100%" height={provinces.length * 38 + 20}>
              <BarChart data={popData} layout="vertical" margin={{ left: 4, right: 48, top: 2, bottom: 2 }}>
                <CartesianGrid strokeDasharray="3 2" stroke="rgba(255,255,255,0.05)" horizontal={false} />
                <XAxis type="number" tick={{ fill: '#6b7f90', fontSize: 10 }} axisLine={false} tickLine={false} tickFormatter={fmtK} />
                <YAxis type="category" dataKey="name" width={86} tick={{ fill: '#b0c4d0', fontSize: 11 }} axisLine={false} tickLine={false} />
                <Tooltip content={<Tooltip_ />} cursor={{ fill: 'rgba(255,255,255,0.03)' }} />
                <Bar dataKey="value" name="Population" radius={[0, 3, 3, 0]}
                  label={{ position: 'right', fill: '#7a8f9f', fontSize: 10, formatter: fmtK }}>
                  {popData.map((d, i) => <Cell key={i} fill={d.fill} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
          {/* Province stat cards */}
          <div className="ns-province-cards">
            {provinces.map((p) => (
              <div key={p.name} className="ns-pcard" style={{ '--pc': p.color }}>
                <div className="ns-pcard-name">{p.name}</div>
                <div className="ns-pcard-row">
                  <span className="ns-pcard-lbl">Area km²</span>
                  <span className="ns-pcard-val">{fmtK(p.population.area)}</span>
                </div>
                <div className="ns-pcard-row">
                  <span className="ns-pcard-lbl">Population</span>
                  <span className="ns-pcard-val">{fmtK(p.population.total)}</span>
                </div>
                <div className="ns-pcard-row">
                  <span className="ns-pcard-lbl">Structures</span>
                  <span className="ns-pcard-val">{fmtK(p.structures)}</span>
                </div>
              </div>
            ))}
          </div>
        </section>

      </div>
    </div>
  );
}
