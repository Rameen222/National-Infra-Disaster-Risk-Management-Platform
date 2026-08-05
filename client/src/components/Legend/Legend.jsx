import React, { useState } from 'react';
import './Legend.css';

function Legend() {
  const [collapsed, setCollapsed] = useState(false);

  const items = [
    {
      color: '#e53935',
      label: 'HIGH EXPOSURE',
      subLabel: 'High structure density\nin high-intensity hazards',
    },
    {
      color: '#ffb300',
      label: 'MEDIUM EXPOSURE',
      subLabel: null,
    },
    {
      color: '#4caf50',
      label: 'LOW EXPOSURE',
      subLabel: null,
    },
  ];

  return (
    <div className={`legend ${collapsed ? 'collapsed' : ''}`}>
      <div className="legend-header" onClick={() => setCollapsed((c) => !c)}>
        <span className="legend-title">LEGEND</span>
        <button className="legend-toggle">
          {collapsed ? '+' : '−'}
        </button>
      </div>
      {!collapsed && (
        <div className="legend-items">
          {items.map((item) => (
            <div key={item.label} className="legend-item">
              <div className="legend-swatch" style={{ background: item.color }} />
              <div className="legend-text">
                <span className="legend-label">{item.label}</span>
                {item.subLabel && (
                  <span className="legend-sublabel">{item.subLabel}</span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default Legend;
