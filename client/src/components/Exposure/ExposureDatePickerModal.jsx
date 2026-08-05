import React, { useState, useEffect } from 'react';
import ReactDOM from 'react-dom';
import useDrag from '../../hooks/useDrag';
import './ExposureDatePickerModal.css';

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export default function ExposureDatePickerModal({ defaultDate, onLoad, onClose }) {
  const [date, setDate] = useState(defaultDate || todayISO());
  const initialX = typeof window !== 'undefined' ? Math.max(20, (window.innerWidth - 360) / 2) : 0;
  const initialY = typeof window !== 'undefined' ? Math.max(40, (window.innerHeight - 280) / 2 - 40) : 80;
  const { pos, onMouseDown } = useDrag(initialX, initialY);

  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const submit = () => {
    if (!date) return;
    onLoad(date);
  };

  return ReactDOM.createPortal(
    <div className="expdp-overlay" onClick={onClose}>
      <div
        className="expdp-modal"
        style={{ left: pos.x, top: pos.y }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="expdp-streak expdp-streak--1" />
        <div className="expdp-streak expdp-streak--2" />

        <div className="expdp-header" onMouseDown={onMouseDown} style={{ cursor: 'grab' }}>
          <div className="expdp-header-left">
            <span className="expdp-icon" aria-hidden>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                <path d="M12 2.5c-3 4-5 6.5-5 9.5a5 5 0 0010 0c0-3-2-5.5-5-9.5z"
                      stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round"/>
                <path d="M9.5 13.5c0 1.3 1 2.4 2.5 2.5" stroke="currentColor"
                      strokeWidth="1.4" strokeLinecap="round" opacity="0.6"/>
              </svg>
            </span>
            <div className="expdp-header-text">
              <span className="expdp-badge">Impact Layer</span>
              <span className="expdp-title">Select date to load exposure features</span>
            </div>
          </div>
          <button className="expdp-close" onClick={onClose} aria-label="Close">
            <svg width="12" height="12" viewBox="0 0 14 14" fill="none">
              <path d="M1 1l12 12M13 1L1 13" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
            </svg>
          </button>
        </div>

        <div className="expdp-body">
          <label className="expdp-label">Date</label>
          <input
            type="date"
            className="expdp-date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />

          <div className="expdp-actions">
            <button className="expdp-btn expdp-btn--primary" onClick={submit} disabled={!date}>
              Load Impact
            </button>
            <button className="expdp-btn expdp-btn--ghost" onClick={onClose}>
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
