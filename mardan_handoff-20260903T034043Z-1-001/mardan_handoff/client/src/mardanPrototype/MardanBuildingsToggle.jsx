// Mardan watershed buildings prototype — sidebar toggle.
//
// Lives in src/mardanPrototype so the whole feature is easy to delete.

import React from 'react';
import './MardanBuildingsToggle.css';

function fmt(n) {
  if (n == null) return '';
  return Number(n).toLocaleString('en-US');
}

/**
 * A single switch that turns the Mardan watershed buildings layer on/off.
 * Status (loading / error / feature count) comes from the map layer hook via
 * App → Sidebar props.
 */
export default function MardanBuildingsToggle({ show, onToggle, status, disabled }) {
  const loading = !!status?.loading;
  const error = !!status?.error;
  const count = status?.count ?? null;

  return (
    <div className={`mb-toggle${show ? ' mb-toggle--on' : ''}`}>
      <label className="mb-toggle-row">
        <input
          type="checkbox"
          checked={!!show}
          disabled={disabled || loading}
          onChange={onToggle}
        />
        <span className="mb-toggle-swatch" style={{ background: '#14b8a6' }} />
        <span className="mb-toggle-label">Mardan watershed buildings</span>
        {loading && <span className="mb-toggle-spin" title="Loading buildings…" />}
      </label>
      {error && (
        <div className="mb-toggle-msg mb-toggle-msg--error">
          Couldn’t load Mardan buildings: {String(error)}
        </div>
      )}
      {show && !loading && count != null && (
        <div className="mb-toggle-msg">
          {fmt(count)} buildings · double-click one to open the 3D interior
          viewer {status?.mb ? `· ${status.mb} MB transfer` : ''}
          <br />1st click → house, 2nd → school, then it cycles.
        </div>
      )}
      {show && !loading && count == null && !error && (
        <div className="mb-toggle-msg">
          Double-click a building to open the 3D interior viewer.
        </div>
      )}
    </div>
  );
}