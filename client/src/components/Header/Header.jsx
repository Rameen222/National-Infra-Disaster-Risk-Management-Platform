import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { searchLocations, getPlaceDetails, getTypeLabel } from '../../utils/geocoding';
import './Header.css';

function useDebounce(value, delay) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}

function LocationSearch({ onSelect }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(-1);
  const wrapperRef = useRef(null);
  const inputRef = useRef(null);
  const debouncedQuery = useDebounce(query, 300);

  useEffect(() => {
    if (!debouncedQuery.trim()) { setResults([]); setOpen(false); return; }
    let cancelled = false;
    setLoading(true);
    searchLocations(debouncedQuery).then((res) => {
      if (cancelled) return;
      setResults(res);
      setOpen(res.length > 0);
      setActiveIdx(-1);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [debouncedQuery]);

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleSelect = useCallback(async (result) => {
    setQuery(result.shortName);
    setOpen(false);
    setResults([]);

    if (result.needsDetails) {
      setLoading(true);
      const details = await getPlaceDetails(result.id);
      setLoading(false);
      onSelect?.({ ...result, ...(details || {}) });
    } else {
      onSelect?.(result);
    }

    inputRef.current?.blur();
  }, [onSelect]);

  const handleKeyDown = (e) => {
    if (!open) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIdx((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter' && activeIdx >= 0) {
      e.preventDefault();
      handleSelect(results[activeIdx]);
    } else if (e.key === 'Escape') {
      setOpen(false);
      inputRef.current?.blur();
    }
  };

  const handleClear = () => {
    setQuery('');
    setResults([]);
    setOpen(false);
    inputRef.current?.focus();
  };

  return (
    <div className="geo-search" ref={wrapperRef}>
      <div className={`geo-search__input-wrap ${open ? 'geo-search__input-wrap--open' : ''}`}>
        <svg className="geo-search__icon" width="14" height="14" viewBox="0 0 20 20" fill="none">
          <circle cx="8.5" cy="8.5" r="6.5" stroke="currentColor" strokeWidth="1.8" />
          <path d="M13.5 13.5L18 18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
        <input
          ref={inputRef}
          className="geo-search__input"
          type="text"
          placeholder="Search location in Pakistan…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => results.length > 0 && setOpen(true)}
          onKeyDown={handleKeyDown}
          autoComplete="off"
          spellCheck={false}
        />
        {loading && (
          <span className="geo-search__spinner" aria-hidden="true" />
        )}
        {!loading && query && (
          <button className="geo-search__clear" onClick={handleClear} tabIndex={-1} title="Clear">
            ×
          </button>
        )}
      </div>

      {open && results.length > 0 && (
        <ul className="geo-search__dropdown" role="listbox">
          {results.map((r, i) => (
            <li
              key={r.id}
              className={`geo-search__item${i === activeIdx ? ' geo-search__item--active' : ''}`}
              role="option"
              aria-selected={i === activeIdx}
              onMouseDown={(e) => { e.preventDefault(); handleSelect(r); }}
              onMouseEnter={() => setActiveIdx(i)}
            >
              <span className="geo-search__item-icon">
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                  <path d="M8 1a5 5 0 0 1 5 5c0 3.5-5 9-5 9S3 9.5 3 6a5 5 0 0 1 5-5z" stroke="currentColor" strokeWidth="1.4" fill="none" />
                  <circle cx="8" cy="6" r="1.5" fill="currentColor" />
                </svg>
              </span>
              <span className="geo-search__item-text">
                <span className="geo-search__item-name">{r.shortName}</span>
                <span className="geo-search__item-place">{r.placeName}</span>
              </span>
              <span className="geo-search__item-badge">{getTypeLabel(r.placeType)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Header({ onSearch }) {
  const location = useLocation();
  const onIncidentRecords = location.pathname.startsWith('/incident-records');

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
        <LocationSearch onSelect={onSearch} />
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
