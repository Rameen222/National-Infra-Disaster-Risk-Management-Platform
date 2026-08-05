import React, { useState } from 'react';
import useDrag from '../../hooks/useDrag';
import './StyleModal.css';

function BoundarySection({ label, style, onChange, defaultOpen }) {
  const emit = (patch) => onChange({ ...style, ...patch });
  const [open, setOpen] = useState(defaultOpen ?? false);

  return (
    <div className="boundary-section">
      <div className="boundary-section-header" onClick={() => setOpen((v) => !v)}>
        <svg className={`bs-chevron${open ? ' bs-chevron--open' : ''}`} width="10" height="10" viewBox="0 0 10 10" fill="none">
          <path d="M3 2l4 3-4 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
        <span className="boundary-section-title">{label}</span>
        <button
          className={`boundary-toggle${style.visible ? ' boundary-toggle--on' : ''}`}
          onClick={(e) => { e.stopPropagation(); emit({ visible: !style.visible }); }}
          title={style.visible ? 'Hide' : 'Show'}
        >
          {style.visible ? (
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M1 8s2.5-5 7-5 7 5 7 5-2.5 5-7 5-7-5-7-5z" stroke="currentColor" strokeWidth="1.4"/><circle cx="8" cy="8" r="2.5" stroke="currentColor" strokeWidth="1.3"/></svg>
          ) : (
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M1 8s2.5-5 7-5 7 5 7 5-2.5 5-7 5-7-5-7-5z" stroke="currentColor" strokeWidth="1.4"/><circle cx="8" cy="8" r="2.5" stroke="currentColor" strokeWidth="1.3"/><line x1="2" y1="14" x2="14" y2="2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
          )}
        </button>
      </div>

      {open && (
        <div className={`boundary-section-body${style.visible ? '' : ' boundary-section--hidden'}`}>
          <div className="modal-row-inline">
            <label>Fill</label>
            <input type="color" value={style.fillColor} onChange={(e) => emit({ fillColor: e.target.value })} className="inline-color" />
            <input type="range" min="0" max="1" step="0.01" value={style.fillOpacity} onChange={(e) => emit({ fillOpacity: parseFloat(e.target.value) })} className="opacity-slider inline-slider" />
            <span className="opacity-val">{Math.round(style.fillOpacity * 100)}%</span>
          </div>
          <div className="modal-row-inline">
            <label>Stroke</label>
            <input type="color" value={style.strokeColor} onChange={(e) => emit({ strokeColor: e.target.value })} className="inline-color" />
            <input type="range" min="0" max="1" step="0.01" value={style.strokeOpacity} onChange={(e) => emit({ strokeOpacity: parseFloat(e.target.value) })} className="opacity-slider inline-slider" />
            <span className="opacity-val">{Math.round(style.strokeOpacity * 100)}%</span>
          </div>
          <div className="modal-row-inline">
            <label>Width</label>
            <input type="range" min="0.5" max="8" step="0.1" value={style.strokeWidth} onChange={(e) => emit({ strokeWidth: parseFloat(e.target.value) })} className="opacity-slider inline-slider-wide" />
            <span className="opacity-val">{style.strokeWidth}px</span>
          </div>
        </div>
      )}
    </div>
  );
}

function StyleModal({ isOpen, onClose, nationalStyle, onNationalChange, provincialStyle, onProvincialChange, districtStyle, onDistrictChange }) {
  const { pos, onMouseDown } = useDrag(350, 100);
  if (!isOpen) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-panel" style={{ left: pos.x, top: pos.y }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header" onMouseDown={onMouseDown} style={{ cursor: 'grab' }}>
          <span className="modal-badge">Layer Style</span>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>

        <div className="modal-body">
          <BoundarySection label="National Boundary" style={nationalStyle} onChange={onNationalChange} />
          <BoundarySection label="Provincial Boundary" style={provincialStyle} onChange={onProvincialChange} />
          <BoundarySection label="District Highlight" style={districtStyle} onChange={onDistrictChange} />
        </div>

        <div className="modal-footer">
          <button className="btn-close-done" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}

export default StyleModal;
