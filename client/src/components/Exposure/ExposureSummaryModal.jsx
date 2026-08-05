import React, { useMemo } from 'react';
import ReactDOM from 'react-dom';
import useDrag from '../../hooks/useDrag';
import { aggregateTotals } from './exposureApi';
import './ExposureSummaryModal.css';

function formatCount(n) {
  if (n == null) return '—';
  return Number(n).toLocaleString();
}

function formatDate(iso) {
  if (!iso) return '';
  // iso is YYYY-MM-DD
  try {
    const [y, m, d] = iso.split('-').map(Number);
    const date = new Date(Date.UTC(y, m - 1, d));
    return date.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
  } catch {
    return iso;
  }
}

const INDICATORS = [
  { key: 'schools',         label: 'Schools',         tone: 'edu',   icon: 'school'  },
  { key: 'railwayStations', label: 'Railway stations', tone: 'rail',  icon: 'rail'    },
  { key: 'settlements',     label: 'Settlements',      tone: 'amber', icon: 'house'   },
  { key: 'hospitals',       label: 'Hospitals',        tone: 'rose',  icon: 'cross'   },
  { key: 'bridges',         label: 'Bridges',          tone: 'teal',  icon: 'bridge'  },
  { key: 'airports',        label: 'Airports',         tone: 'pink',  icon: 'plane'   },
];

function IndicatorIcon({ icon }) {
  switch (icon) {
    case 'school':
      return <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M12 3l10 5-10 5L2 8l10-5z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"/><path d="M6 10v5c0 1.5 3 3 6 3s6-1.5 6-3v-5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/></svg>;
    case 'rail':
      return <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><rect x="5" y="3" width="14" height="14" rx="3" stroke="currentColor" strokeWidth="1.6"/><circle cx="9" cy="13" r="1.2" fill="currentColor"/><circle cx="15" cy="13" r="1.2" fill="currentColor"/><path d="M8 20l-1.5 2M16 20l1.5 2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/></svg>;
    case 'house':
      return <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M3 11l9-7 9 7v9a1 1 0 01-1 1h-5v-6h-6v6H4a1 1 0 01-1-1v-9z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"/></svg>;
    case 'cross':
      return <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><rect x="3" y="3" width="18" height="18" rx="3" stroke="currentColor" strokeWidth="1.6"/><path d="M12 8v8M8 12h8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/></svg>;
    case 'bridge':
      return <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M3 16c4 0 4-7 9-7s5 7 9 7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/><path d="M3 20h18M6 16v4M18 16v4M12 9v11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>;
    case 'plane':
      return <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M10 21l2-6 8-6c1-.7 1-2 0-2.5s-2-.4-2.5.2L11 14 5 12l-2 1.5 5 3 2 4.5z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/></svg>;
    case 'people':
      return <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><circle cx="8" cy="9" r="3" stroke="currentColor" strokeWidth="1.6"/><circle cx="16" cy="10" r="2.5" stroke="currentColor" strokeWidth="1.4"/><path d="M2.5 19c0-3 2.5-5 5.5-5s5.5 2 5.5 5M14 19c0-2 1.8-3.5 4-3.5s3.5 1.5 3.5 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>;
    default: return null;
  }
}

export default function ExposureSummaryModal({ date, rows, streamCount, onClose }) {
  const totals = useMemo(() => aggregateTotals(rows || []), [rows]);
  const initialX = typeof window !== 'undefined' ? Math.max(20, window.innerWidth - 380) : 0;
  const initialY = 90;
  const { pos, onMouseDown } = useDrag(initialX, initialY);

  return ReactDOM.createPortal(
    <div
      className="expsum-modal"
      style={{ left: pos.x, top: pos.y }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="expsum-streak expsum-streak--1" />
      <div className="expsum-streak expsum-streak--2" />

      <div className="expsum-header" onMouseDown={onMouseDown} style={{ cursor: 'grab' }}>
        <div className="expsum-header-left">
          <span className="expsum-icon" aria-hidden>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
              <path d="M3 17c2-2 4-2 6 0s4 2 6 0 4-2 6 0" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
              <path d="M3 12c2-2 4-2 6 0s4 2 6 0 4-2 6 0" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" opacity="0.7"/>
            </svg>
          </span>
          <div className="expsum-header-text">
            <span className="expsum-title">Total exposed summary</span>
            <span className="expsum-subtitle">
              {formatDate(date)}{streamCount != null ? ` · ${streamCount} stream${streamCount === 1 ? '' : 's'}` : ''}
            </span>
          </div>
        </div>
        <button className="expsum-close" onClick={onClose} aria-label="Close">
          <svg width="12" height="12" viewBox="0 0 14 14" fill="none">
            <path d="M1 1l12 12M13 1L1 13" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
          </svg>
        </button>
      </div>

      <div className="expsum-body">
        <div className="expsum-grid">
          {INDICATORS.map(({ key, label, tone, icon }) => (
            <div key={key} className={`expsum-card expsum-card--${tone}`}>
              <div className="expsum-card-head">
                <span className="expsum-card-icon"><IndicatorIcon icon={icon} /></span>
                <span className="expsum-card-lbl">{label}</span>
              </div>
              <div className="expsum-card-val">{formatCount(totals[key])}</div>
            </div>
          ))}
        </div>

        <div className="expsum-pop">
          <div className="expsum-pop-head">
            <span className="expsum-pop-icon"><IndicatorIcon icon="people" /></span>
            <span className="expsum-pop-lbl">Total population exposed</span>
          </div>
          <div className="expsum-pop-val">{formatCount(totals.population)}</div>
        </div>

        <div className="expsum-foot">
          Click a stream on the map to see per-segment exposure values.
        </div>
      </div>
    </div>,
    document.body,
  );
}
