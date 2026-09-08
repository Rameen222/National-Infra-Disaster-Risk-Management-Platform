import React from 'react';
import { Link, useLocation } from 'react-router-dom';
import './Header.css';

function Header({ onSearch }) {
  const location = useLocation();
  const onIncidentRecords = location.pathname.startsWith('/incident-records');
  const onFloodSimulation = location.pathname.startsWith('/flood-simulation');

  return (
    <header className="header">
      <div className="header-logo">
        <a href="/" onClick={() => window.location.reload()} className="header-logo-link" title="Refresh">
          <img src="/ndma.png" alt="NDMA Logo" className="header-logo-img" />
        </a>
      </div>
      <div className="header-left">
        <div className="header-title">
          <h1>National Infra Disaster Risk Management Platform</h1>
        </div>
      </div>
      <div className="header-right">
        <Link
          to="/incident-records"
          className={`header-nav-btn${onIncidentRecords ? ' header-nav-btn--active' : ''}`}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
            <path d="M6 3h9l5 5v13a1 1 0 01-1 1H6a1 1 0 01-1-1V4a1 1 0 011-1z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
            <path d="M15 3v5h5" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
            <path d="M8 13h8M8 17h8M8 9h3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          Incident Records
        </Link>
        <Link
          to="/flood-simulation-vulnerability-v2"
          className={`header-nav-btn${onFloodSimulation ? ' header-nav-btn--active' : ''}`}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
            <path d="M2 15c1.8-1.6 3.6-1.6 5.4 0s3.6 1.6 5.4 0 3.6-1.6 5.4 0 3.6 1.6 5.4 0" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            <path d="M2 19c1.8-1.6 3.6-1.6 5.4 0s3.6 1.6 5.4 0 3.6-1.6 5.4 0 3.6 1.6 5.4 0" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" opacity="0.6" />
            <path d="M12 3v7M9 7l3 3 3-3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Flood Simulation
        </Link>
        <button className="header-btn" title="Help">
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
            <circle cx="9" cy="9" r="8" stroke="#aaa" strokeWidth="1.5" />
            <text x="9" y="13" textAnchor="middle" fill="#aaa" fontSize="10" fontWeight="bold">?</text>
          </svg>
        </button>
      </div>
    </header>
  );
}

export default Header;
