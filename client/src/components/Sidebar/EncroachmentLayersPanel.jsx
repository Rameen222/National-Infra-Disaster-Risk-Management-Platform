import React, { useState } from 'react';
import ReactDOM from 'react-dom';
import useDrag from '../../hooks/useDrag';
import './FloodLayersPanel.css';

/* Floating style modal for a single encroachment layer */
function EncroachmentStyleModal({ layer, onUpdate, onClose, onMoveUp, onMoveDown, isFirst, isLast }) {
  const { pos, onMouseDown } = useDrag(Math.round(window.innerWidth / 2 - 140), 120);

  return ReactDOM.createPortal(
    <div className="flood-modal-overlay" onClick={onClose}>
      <div className="flood-modal" style={{ left: pos.x, top: pos.y }} onClick={(e) => e.stopPropagation()}>
        <div className="flood-modal-header" onMouseDown={onMouseDown}>
          <span className="flood-modal-badge">{layer.label}</span>
          <div className="flood-modal-header-actions">
            <button className="flood-modal-order-btn" disabled={isFirst} onClick={() => onMoveUp(layer.id)} title="Move up">▲</button>
            <button className="flood-modal-order-btn" disabled={isLast} onClick={() => onMoveDown(layer.id)} title="Move down">▼</button>
            <button className="flood-modal-close" onClick={onClose}>✕</button>
          </div>
        </div>
        <div className="flood-modal-body">
          <div className="flood-modal-row">
            <span className="flood-modal-label">Fill Color</span>
            <div className="flood-modal-color-wrap">
              <input type="color" value={layer.fillColor} onChange={(e) => onUpdate(layer.id, { fillColor: e.target.value })} />
              <span className="flood-modal-hex">{layer.fillColor}</span>
            </div>
          </div>
          <div className="flood-modal-row">
            <span className="flood-modal-label">Fill Opacity <span className="flood-modal-val">{Math.round(layer.fillOpacity * 100)}%</span></span>
            <input type="range" className="flood-modal-slider" min="0" max="1" step="0.05" value={layer.fillOpacity}
              onChange={(e) => onUpdate(layer.id, { fillOpacity: parseFloat(e.target.value) })} />
          </div>
          <div className="flood-modal-row">
            <span className="flood-modal-label">Stroke Color</span>
            <div className="flood-modal-color-wrap">
              <input type="color" value={layer.strokeColor} onChange={(e) => onUpdate(layer.id, { strokeColor: e.target.value })} />
              <span className="flood-modal-hex">{layer.strokeColor}</span>
            </div>
          </div>
          <div className="flood-modal-row">
            <span className="flood-modal-label">Stroke Opacity <span className="flood-modal-val">{Math.round(layer.strokeOpacity * 100)}%</span></span>
            <input type="range" className="flood-modal-slider" min="0" max="1" step="0.05" value={layer.strokeOpacity}
              onChange={(e) => onUpdate(layer.id, { strokeOpacity: parseFloat(e.target.value) })} />
          </div>
          <div className="flood-modal-row">
            <span className="flood-modal-label">Stroke Width <span className="flood-modal-val">{layer.strokeWidth.toFixed(1)}px</span></span>
            <input type="range" className="flood-modal-slider" min="0" max="5" step="0.1" value={layer.strokeWidth}
              onChange={(e) => onUpdate(layer.id, { strokeWidth: parseFloat(e.target.value) })} />
          </div>
        </div>
        <div className="flood-modal-footer">
          <button className="flood-modal-done" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>,
    document.body
  );
}

function EncroachmentLayerItem({ layer, onUpdate, onMoveUp, onMoveDown, isFirst, isLast }) {
  const [modalOpen, setModalOpen] = useState(false);
  return (
    <>
      <div className={`flood-item${layer.visible ? ' flood-item--active' : ''}`}>
        <input type="checkbox" checked={layer.visible} onChange={() => onUpdate(layer.id, { visible: !layer.visible })} />
        <span className="flood-item-swatch" style={{ background: layer.fillColor, border: '1px solid rgba(255,255,255,0.15)' }} />
        <span className="flood-item-label">{layer.label}</span>
        <button className={`flood-item-gear${modalOpen ? ' flood-item-gear--on' : ''}`} onClick={() => setModalOpen(true)} title="Layer style">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="2"/>
            <path d="M12 1v3M12 20v3M4.22 4.22l2.12 2.12M17.66 17.66l2.12 2.12M1 12h3M20 12h3M4.22 19.78l2.12-2.12M17.66 6.34l2.12-2.12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
          </svg>
        </button>
      </div>
      {modalOpen && (
        <EncroachmentStyleModal
          layer={layer}
          onUpdate={onUpdate}
          onClose={() => setModalOpen(false)}
          onMoveUp={onMoveUp}
          onMoveDown={onMoveDown}
          isFirst={isFirst}
          isLast={isLast}
        />
      )}
    </>
  );
}

export default function EncroachmentLayersPanel({ layers, onUpdate, onReorder }) {
  const moveUp = (id) => {
    const idx = layers.findIndex((l) => l.id === id);
    if (idx <= 0) return;
    const next = [...layers];
    [next[idx - 1], next[idx]] = [next[idx], next[idx - 1]];
    onReorder(next);
  };
  const moveDown = (id) => {
    const idx = layers.findIndex((l) => l.id === id);
    if (idx < 0 || idx >= layers.length - 1) return;
    const next = [...layers];
    [next[idx], next[idx + 1]] = [next[idx + 1], next[idx]];
    onReorder(next);
  };
  return (
    <div className="flood-panel">
      {layers.map((layer, i) => (
        <EncroachmentLayerItem
          key={layer.id}
          layer={layer}
          onUpdate={onUpdate}
          onMoveUp={moveUp}
          onMoveDown={moveDown}
          isFirst={i === 0}
          isLast={i === layers.length - 1}
        />
      ))}
    </div>
  );
}
