import React from 'react';
import { Link } from 'react-router-dom';

const fmtDate = (iso) => {
  if (!iso) return null;
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
};

const fmtStat = (n) => (n == null ? '—' : Number(n).toLocaleString());

export default function IncidentCard({ incident }) {
  const {
    id, title, province, district, date, disasterType,
    thumbnailUrl, shortDescription,
    buildingsAffected, roadDamageKm, hospitalsAffected,
  } = incident;

  return (
    <Link to={`/incident-records/${id}`} className="ir-card">
      <div className="ir-card-media">
        {thumbnailUrl ? (
          <img src={thumbnailUrl} alt={title} className="ir-card-img" loading="lazy" />
        ) : (
          <div className="ir-card-img ir-card-img--placeholder" aria-hidden="true">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none">
              <rect x="3" y="5" width="18" height="14" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
              <circle cx="8.5" cy="10" r="1.5" stroke="currentColor" strokeWidth="1.4" />
              <path d="M4 16l5-4 4 3 3-2.5 4 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
            </svg>
          </div>
        )}
        <span className="ir-card-type-chip">{disasterType}</span>

        {/* ── Hover overlay: everything except date/province lives here,
            since the card's resting state only shows the image + a thin
            date/province footer strip. ─────────────────────────────── */}
        <div className="ir-card-overlay">
          <div className="ir-card-overlay-type">{disasterType}</div>
          <div className="ir-card-overlay-sub">Infrastructure Damage</div>
          <div className="ir-card-overlay-title">{title}</div>
          <div className="ir-card-overlay-meta">{province} · {district} · {fmtDate(date)}</div>
          <div className="ir-card-overlay-desc">{shortDescription}</div>
          <div className="ir-card-overlay-stats">
            <div className="ir-card-overlay-stat">
              <span className="ir-card-overlay-stat-lbl">Buildings affected</span>
              <span className="ir-card-overlay-stat-val">{fmtStat(buildingsAffected)}</span>
            </div>
            <div className="ir-card-overlay-stat">
              <span className="ir-card-overlay-stat-lbl">Road damage (km)</span>
              <span className="ir-card-overlay-stat-val">{fmtStat(roadDamageKm)}</span>
            </div>
            <div className="ir-card-overlay-stat">
              <span className="ir-card-overlay-stat-lbl">Hospitals affected</span>
              <span className="ir-card-overlay-stat-val">{fmtStat(hospitalsAffected)}</span>
            </div>
          </div>
        </div>
      </div>

      <div className="ir-card-footer">
        <span className="ir-card-footer-date">{fmtDate(date)}</span>
        <span className="ir-card-footer-province">{province}</span>
      </div>
    </Link>
  );
}
