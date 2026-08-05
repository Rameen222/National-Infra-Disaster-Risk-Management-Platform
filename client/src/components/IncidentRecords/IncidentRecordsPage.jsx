import React from 'react';
import { INCIDENT_RECORDS } from './incidentRecordsData';
import { PROVINCE_OPTIONS } from './pakistanLocations';
import IncidentCard from './IncidentCard';
import LocationFilter from './LocationFilter';
import DateRangeFilter from './DateRangeFilter';
import './IncidentRecordsPage.css';

const uniqueSorted = (values) => Array.from(new Set(values.filter(Boolean))).sort();

export default function IncidentRecordsPage() {
  const [location, setLocation] = React.useState({ province: null, district: null });
  const [dateRange, setDateRange] = React.useState(null);
  const [activeType, setActiveType] = React.useState('All');
  const [query, setQuery] = React.useState('');

  const disasterTypes = React.useMemo(
    () => uniqueSorted(INCIDENT_RECORDS.map((r) => r.disasterType)),
    [],
  );

  const provinceName = PROVINCE_OPTIONS.find((p) => p.id === location.province)?.name;

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    return INCIDENT_RECORDS.filter((r) => {
      if (provinceName && r.province !== provinceName) return false;
      if (location.district && r.district !== location.district) return false;
      if (activeType !== 'All' && r.disasterType !== activeType) return false;
      if (dateRange?.start) {
        const d = new Date(`${r.date}T00:00:00`);
        if (d < dateRange.start || d > dateRange.end) return false;
      }
      if (q) {
        const hay = `${r.province} ${r.district} ${r.disasterType} ${r.title}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [provinceName, location.district, activeType, dateRange, query]);

  return (
    <div className="ir-page">
      <div className="ir-page-header">
        <h1 className="ir-page-title">Incident Records</h1>
        <p className="ir-page-desc">
          Browse historical disaster incidents, field assessments, and documented infrastructure damage.
        </p>
        <p className="ir-page-hint">Hover to view details</p>
      </div>

      <div className="ir-toolbar-card">
        <div className="ir-search-wrap">
          <svg className="ir-search-icon" width="16" height="16" viewBox="0 0 20 20" fill="none">
            <circle cx="8.5" cy="8.5" r="6.5" stroke="currentColor" strokeWidth="1.8" />
            <path d="M13.5 13.5L18 18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
          <input
            className="ir-search-input"
            type="text"
            placeholder="Search by province, district, or disaster type…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>

        <LocationFilter
          province={location.province}
          district={location.district}
          onChange={setLocation}
        />

        <DateRangeFilter value={dateRange} onChange={setDateRange} />

        <select
          className="ir-select"
          value={activeType}
          onChange={(e) => setActiveType(e.target.value)}
          aria-label="Filter by disaster type"
        >
          <option value="All">All disaster types</option>
          {disasterTypes.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
      </div>

      {filtered.length === 0 ? (
        <div className="ir-empty">
          <svg width="36" height="36" viewBox="0 0 24 24" fill="none">
            <rect x="3" y="5" width="18" height="14" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
            <path d="M3 15l5-4 4 3 3-2.5 6 4.5" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
          </svg>
          <div className="ir-empty-title">
            {INCIDENT_RECORDS.length === 0 ? 'No incident records yet' : 'No records match these filters'}
          </div>
          <div className="ir-empty-sub">
            {INCIDENT_RECORDS.length === 0
              ? 'Records will appear here once field reports are added.'
              : 'Try clearing a filter or search term.'}
          </div>
        </div>
      ) : (
        <div className="ir-grid">
          {filtered.map((incident) => (
            <IncidentCard key={incident.id} incident={incident} />
          ))}
        </div>
      )}
    </div>
  );
}
