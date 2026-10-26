import React from 'react';
import { INFRA_LAYERS } from '../../config/infraLayers';
import { useInfraCounts } from '../../utils/infraCounts';
import './DistrictStatsModal.css';

// Card accents reuse each layer's map colour so a card reads as "the dots
// of that colour on the map".
const layerColor = (id) => {
  const s = INFRA_LAYERS.find((l) => l.id === id)?.style || {};
  return s.circleColor || s.iconColor || s.lineColor;
};

const ITEMS = [
  { key: 'health_facilities', label: 'Health Facilities', color: layerColor('health_facilities') },
  { key: 'schools',           label: 'Schools',           color: layerColor('schools') },
  { key: 'dams',              label: 'Dams',              color: layerColor('dams') },
  { key: 'nha_roads_km',      label: 'NHA Highways (km)', color: layerColor('nha_roads') },
  // OSM roads + NHA highways not already in OSM (pybackend/infra_counts.py).
  { key: 'roads_km',          label: 'Road Network (km)', color: layerColor('roads') },
];

/**
 * Facility counts nationally or inside the selected province / district /
 * tehsil — shown in the right dock below the Age of Structures chart, and in
 * the province and national panels. Props are the scope passed to
 * useInfraCounts.
 */
export default function InfraFacilitiesSection({ national, province, district, tehsil, tehsilGeometry }) {
  const { status, counts } = useInfraCounts({ national, province, district, tehsil, tehsilGeometry });
  if (status === 'idle') return null;

  const scopeName = (tehsil && tehsilGeometry ? tehsil : district || province) || (national ? 'Pakistan' : '');

  return (
    <section className="ds-sec-3 ds-facilities">
      <div className="ds-sechead ds-sechead--facilities">
        <span className="ds-sechead-label">INFRASTRUCTURE FACILITIES</span>
        {scopeName && <span className="ds-sechead-right">{scopeName}</span>}
      </div>
      {status === 'error' ? (
        <div className="ds-no-data">Facility counts unavailable</div>
      ) : (
        <div className="ds-facility-grid">
          {ITEMS.map((it) => {
            const v = counts?.[it.key];
            return (
              <div key={it.key} className="ds-infra-card" style={{ '--ic': it.color }}>
                <div className={`ds-infra-val${v == null ? ' ds-infra-val--empty' : ''}`}>
                  {status === 'loading' ? '…' : v == null ? 'No data' : Math.round(v).toLocaleString()}
                </div>
                <div className="ds-infra-lbl">{it.label}</div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
