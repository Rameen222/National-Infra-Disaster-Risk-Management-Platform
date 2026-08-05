import React from 'react';
import ReactDOM from 'react-dom';
import useDrag from '../../hooks/useDrag';
import './SusceptibilityStyleModal.css';

const SUS_META = {
  'sus-1': { label: 'Low', accent: '#4caf50' },
  'sus-2': { label: 'Medium', accent: '#ffc107' },
  'sus-3': { label: 'High', accent: '#e53935' },
};

function SusLayerSection({ layer, onUpdate, onMoveUp, onMoveDown, isFirst, isLast }) {
  const meta = SUS_META[layer.year] || { label: layer.label, accent: '#888' };

  return (
    <div className="sus-section" style={{ '--sus-accent': meta.accent }}>
      <div className="sus-section-header">
        <input
          type="checkbox"
          checked={layer.visible}
          onChange={() => onUpdate(layer.year, { visible: !layer.visible })}
        />
        <span className="sus-section-swatch" style={{ background: layer.fillColor }} />
        <span className="sus-section-title">{meta.label}</span>
        <div className="sus-section-order">
          <button className="sus-order-btn" disabled={isFirst} onClick={() => onMoveUp(layer.year)} title="Move up">▲</button>
          <button className="sus-order-btn" disabled={isLast} onClick={() => onMoveDown(layer.year)} title="Move down">▼</button>
        </div>
      </div>
      <div className={`sus-section-body${layer.visible ? '' : ' sus-section--hidden'}`}>
        <div className="sus-row">
          <span className="sus-label">Fill Color</span>
          <div className="sus-color-wrap">
            <input type="color" value={layer.fillColor} onChange={(e) => onUpdate(layer.year, { fillColor: e.target.value })} />
            <span className="sus-hex">{layer.fillColor}</span>
          </div>
        </div>
        <div className="sus-row">
          <span className="sus-label">Fill Opacity <span className="sus-val">{Math.round(layer.fillOpacity * 100)}%</span></span>
          <input type="range" className="sus-slider" min="0" max="1" step="0.05" value={layer.fillOpacity} onChange={(e) => onUpdate(layer.year, { fillOpacity: parseFloat(e.target.value) })} />
        </div>
        <div className="sus-row">
          <span className="sus-label">Stroke Color</span>
          <div className="sus-color-wrap">
            <input type="color" value={layer.strokeColor} onChange={(e) => onUpdate(layer.year, { strokeColor: e.target.value })} />
            <span className="sus-hex">{layer.strokeColor}</span>
          </div>
        </div>
        <div className="sus-row">
          <span className="sus-label">Stroke Opacity <span className="sus-val">{Math.round(layer.strokeOpacity * 100)}%</span></span>
          <input type="range" className="sus-slider" min="0" max="1" step="0.05" value={layer.strokeOpacity} onChange={(e) => onUpdate(layer.year, { strokeOpacity: parseFloat(e.target.value) })} />
        </div>
        <div className="sus-row">
          <span className="sus-label">Stroke Width <span className="sus-val">{layer.strokeWidth.toFixed(1)}px</span></span>
          <input type="range" className="sus-slider" min="0.5" max="5" step="0.1" value={layer.strokeWidth} onChange={(e) => onUpdate(layer.year, { strokeWidth: parseFloat(e.target.value) })} />
        </div>
      </div>
    </div>
  );
}

function SusceptibilityStyleModal({ susLayers, onUpdate, onReorder, onClose }) {
  const { pos, onMouseDown } = useDrag(Math.round(window.innerWidth / 2 - 155), 100);

  const moveUp = (year) => {
    const idx = susLayers.findIndex((l) => l.year === year);
    if (idx <= 0) return;
    const next = [...susLayers];
    [next[idx - 1], next[idx]] = [next[idx], next[idx - 1]];
    onReorder(next);
  };

  const moveDown = (year) => {
    const idx = susLayers.findIndex((l) => l.year === year);
    if (idx < 0 || idx >= susLayers.length - 1) return;
    const next = [...susLayers];
    [next[idx], next[idx + 1]] = [next[idx + 1], next[idx]];
    onReorder(next);
  };

  return ReactDOM.createPortal(
    <div className="sus-modal-overlay" onClick={onClose}>
      <div
        className="sus-modal"
        style={{ left: pos.x, top: pos.y }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sus-modal-header" onMouseDown={onMouseDown}>
          <span className="sus-modal-badge">Susceptibility Styles</span>
          <button className="sus-modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="sus-modal-body">
          {susLayers.map((layer, i) => (
            <SusLayerSection
              key={layer.year}
              layer={layer}
              onUpdate={onUpdate}
              onMoveUp={moveUp}
              onMoveDown={moveDown}
              isFirst={i === 0}
              isLast={i === susLayers.length - 1}
            />
          ))}
        </div>
        <div className="sus-modal-footer">
          <button className="sus-modal-done" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>,
    document.body
  );
}

export default SusceptibilityStyleModal;
