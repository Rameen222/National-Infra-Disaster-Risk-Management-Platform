import React from 'react';
import ReactDOM from 'react-dom';
import useDrag from '../../hooks/useDrag';
import './StreamExposureCard.css';

function formatCount(n) {
  if (n == null) return '—';
  return Number(n).toLocaleString();
}

const ROWS = [
  { key: 'schools',         label: 'Schools',          icon: 'school' },
  { key: 'railwayStations', label: 'Railway stations', icon: 'rail'   },
  { key: 'settlements',     label: 'Settlements',      icon: 'house'  },
  { key: 'hospitals',       label: 'Hospitals',        icon: 'cross'  },
  { key: 'bridges',         label: 'Bridges',          icon: 'bridge' },
  { key: 'airports',        label: 'Airports',         icon: 'plane'  },
  { key: 'population',      label: 'Total population exposed', icon: 'people' },
];

function Icon({ icon }) {
  switch (icon) {
    case 'school':
      return <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M12 3l10 5-10 5L2 8l10-5z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"/><path d="M6 10v5c0 1.5 3 3 6 3s6-1.5 6-3v-5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/></svg>;
    case 'rail':
      return <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><rect x="5" y="3" width="14" height="14" rx="3" stroke="currentColor" strokeWidth="1.6"/><circle cx="9" cy="13" r="1.2" fill="currentColor"/><circle cx="15" cy="13" r="1.2" fill="currentColor"/></svg>;
    case 'house':
      return <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M3 11l9-7 9 7v9a1 1 0 01-1 1h-5v-6h-6v6H4a1 1 0 01-1-1v-9z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"/></svg>;
    case 'cross':
      return <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><rect x="3" y="3" width="18" height="18" rx="3" stroke="currentColor" strokeWidth="1.6"/><path d="M12 8v8M8 12h8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/></svg>;
    case 'bridge':
      return <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M3 16c4 0 4-7 9-7s5 7 9 7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/><path d="M3 20h18M6 16v4M18 16v4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>;
    case 'plane':
      return <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M10 21l2-6 8-6c1-.7 1-2 0-2.5s-2-.4-2.5.2L11 14 5 12l-2 1.5 5 3 2 4.5z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/></svg>;
    case 'people':
      return <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><circle cx="8" cy="9" r="3" stroke="currentColor" strokeWidth="1.6"/><circle cx="16" cy="10" r="2.5" stroke="currentColor" strokeWidth="1.4"/><path d="M2.5 19c0-3 2.5-5 5.5-5s5.5 2 5.5 5M14 19c0-2 1.8-3.5 4-3.5s3.5 1.5 3.5 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>;
    default: return null;
  }
}

export default function StreamExposureCard({ stream, onClose }) {
  const initialX = typeof window !== 'undefined' ? Math.max(20, window.innerWidth - 320) : 0;
  const initialY = typeof window !== 'undefined' ? Math.max(120, window.innerHeight - 380) : 200;
  const { pos, onMouseDown } = useDrag(initialX, initialY);

  if (!stream) return null;

  return ReactDOM.createPortal(
    <div
      className="strexp-card"
      style={{ left: pos.x, top: pos.y }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="strexp-header" onMouseDown={onMouseDown} style={{ cursor: 'grab' }}>
        <div className="strexp-header-left">
          <span className="strexp-title">Exposure details</span>
          <span className="strexp-sub">Exposure indicators{stream.id ? ` · ${stream.id}` : ''}</span>
        </div>
        <button className="strexp-close" onClick={onClose} aria-label="Close">
          <svg width="11" height="11" viewBox="0 0 14 14" fill="none">
            <path d="M1 1l12 12M13 1L1 13" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
          </svg>
        </button>
      </div>

      <ul className="strexp-list">
        {ROWS.map(({ key, label, icon }) => (
          <li key={key} className={`strexp-row${key === 'population' ? ' strexp-row--accent' : ''}`}>
            <span className="strexp-row-icon"><Icon icon={icon} /></span>
            <span className="strexp-row-lbl">{label}</span>
            <span className="strexp-row-val">{formatCount(stream[key])}</span>
          </li>
        ))}
      </ul>
    </div>,
    document.body,
  );
}
