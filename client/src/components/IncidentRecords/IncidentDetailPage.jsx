import React from 'react';
import { useParams, Link } from 'react-router-dom';
import { findIncidentById } from './incidentRecordsData';
import './IncidentRecordsPage.css';

const fmtDate = (iso) => {
  if (!iso) return null;
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
};

const fmtStat = (n) => (n == null ? '—' : Number(n).toLocaleString());

export default function IncidentDetailPage() {
  const { id } = useParams();
  const incident = findIncidentById(id);

  return (
    <div className="ir-page ir-detail-page">
      <Link to="/incident-records" className="ir-back-link">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
          <path d="M15 5l-7 7 7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        Back to Incident Records
      </Link>

      {!incident ? (
        <div className="ir-empty">
          <div className="ir-empty-title">Incident not found</div>
          <div className="ir-empty-sub">This record doesn't exist or hasn't been added yet.</div>
        </div>
      ) : (
        <>
          <div className="ir-detail-media">
            {incident.thumbnailUrl ? (
              <img src={incident.thumbnailUrl} alt={incident.title} className="ir-detail-img" />
            ) : (
              <div className="ir-detail-img ir-detail-img--placeholder" aria-hidden="true" />
            )}
          </div>

          <div className="ir-detail-header">
            <span className="ir-card-type-chip ir-detail-type-chip">{incident.disasterType}</span>
            <h1 className="ir-detail-title">{incident.title}</h1>
            <div className="ir-detail-meta">
              {incident.province} · {incident.district}{incident.tehsil ? ` · ${incident.tehsil}` : ''} · {fmtDate(incident.date)}
            </div>
          </div>

          <div className="ir-detail-grid">
            <section className="ir-detail-section">
              <h2 className="ir-detail-section-title">Overview</h2>
              <p className="ir-detail-text">{incident.fullDescription}</p>
              {incident.reportSource && (
                <div className="ir-detail-source">
                  <div className="ir-detail-source-lbl">Report source</div>
                  <div className="ir-detail-source-text">
                    {incident.reportSource.split('\n').map((line, i) => <div key={i}>{line}</div>)}
                  </div>
                </div>
              )}
            </section>

            <section className="ir-detail-section">
              <h2 className="ir-detail-section-title">Impact</h2>
              <div className="ir-detail-stats">
                <div className="ir-detail-stat">
                  <span className="ir-detail-stat-val">{fmtStat(incident.buildingsAffected)}</span>
                  <span className="ir-detail-stat-lbl">Buildings affected</span>
                </div>
                <div className="ir-detail-stat">
                  <span className="ir-detail-stat-val">{fmtStat(incident.roadDamageKm)}</span>
                  <span className="ir-detail-stat-lbl">Road damage (km)</span>
                </div>
                <div className="ir-detail-stat">
                  <span className="ir-detail-stat-val">{fmtStat(incident.hospitalsAffected)}</span>
                  <span className="ir-detail-stat-lbl">Hospitals affected</span>
                </div>
                <div className="ir-detail-stat">
                  <span className="ir-detail-stat-val">{fmtStat(incident.casualties)}</span>
                  <span className="ir-detail-stat-lbl">Casualties</span>
                </div>
                <div className="ir-detail-stat">
                  <span className="ir-detail-stat-val">{fmtStat(incident.injuries)}</span>
                  <span className="ir-detail-stat-lbl">Injuries</span>
                </div>
              </div>
            </section>
          </div>
        </>
      )}
    </div>
  );
}
