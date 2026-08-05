import React, { useState, useEffect, useRef } from 'react';
import ReactDOM from 'react-dom';
import useDrag from '../../hooks/useDrag';
// Reuse the encroachment modal's visual language (enc-* classes) — this panel
// shows the same shape of result (count + footprint area) for the selected
// district against the Flood Projections 2026 extent.
import '../Encroachment/EncroachmentModal.css';

/* ── helpers ─────────────────────────────────────────────── */
function formatCount(n) {
  if (n == null) return '—';
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}

function formatArea(sqm) {
  if (sqm == null || sqm <= 0) return '—';
  if (sqm >= 1e6) return (sqm / 1e6).toFixed(2) + ' km²';
  if (sqm >= 1e4) return (sqm / 1e4).toFixed(2) + ' ha';
  return Math.round(sqm).toLocaleString() + ' m²';
}

const SEARCH_MIN_MS = 600;
const FOUND_FLASH_MS = 700;

export default function FloodProjectionModal({ district, onClose, onResultReady }) {
  const [status, setStatus] = useState('searching');
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [fromCache, setFromCache] = useState(false);
  const [minimized, setMinimized] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const pollRef = useRef(null);
  const timersRef = useRef([]);
  const liveRef = useRef(true);
  const schedule = (fn, ms) => {
    const t = setTimeout(() => {
      timersRef.current = timersRef.current.filter((x) => x !== t);
      if (!liveRef.current) return;
      fn();
    }, ms);
    timersRef.current.push(t);
    return t;
  };
  const initialX = typeof window !== 'undefined' ? Math.max(20, window.innerWidth - 380) : 0;
  const initialY = 96;
  const { pos, onMouseDown } = useDrag(initialX, initialY);

  const PILL_W = 220;
  const PILL_MARGIN = 18;
  const pillInitX = typeof window !== 'undefined' ? window.innerWidth - PILL_W - PILL_MARGIN : 0;
  const pillInitY = typeof window !== 'undefined' ? window.innerHeight - 52 - PILL_MARGIN : 0;
  const { pos: pillPos, onMouseDown: onPillMouseDown, didMoveRef: pillDidMoveRef } = useDrag(pillInitX, pillInitY);

  const runAnalysis = (force = false) => {
    if (!district) return;
    timersRef.current.forEach(clearTimeout);
    timersRef.current = [];
    if (pollRef.current) { clearTimeout(pollRef.current); pollRef.current = null; }

    setError(null);
    setResult(null);
    setProgress(0);
    setFromCache(false);
    setStatus('searching');
    const startedAt = Date.now();

    const finishCached = (data) => {
      setFromCache(true);
      setStatus('found');
      onResultReady?.(data.result);
      schedule(() => {
        setResult(data.result);
        setProgress(100);
        setStatus('done');
      }, FOUND_FLASH_MS);
    };

    const startProcessing = () => {
      setStatus('processing');
      setProgress(5);
    };

    fetch('/pyapi/buildings/flood-projection', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ district, force }),
    })
      .then((r) => { if (!r.ok) throw new Error(`Server error ${r.status}`); return r.json(); })
      .then((data) => {
        if (!liveRef.current) return;
        const elapsed = Date.now() - startedAt;
        const wait = Math.max(0, SEARCH_MIN_MS - elapsed);

        schedule(() => {
          if (data.status === 'done' && data.result) {
            finishCached(data);
            return;
          }
          startProcessing();
          const poll = () => {
            fetch(`/pyapi/buildings/flood-projection/status?district=${encodeURIComponent(district)}`)
              .then((r) => { if (!r.ok) throw new Error('poll error'); return r.json(); })
              .then((s) => {
                if (!liveRef.current) return;
                setProgress(s.progress || 0);
                if (s.status === 'done' && s.result) {
                  setResult(s.result);
                  setStatus('done');
                  setProgress(100);
                  onResultReady?.(s.result);
                } else if (s.status === 'error') {
                  setStatus('error');
                  setError(s.error || 'Analysis failed');
                } else {
                  pollRef.current = setTimeout(poll, 700);
                }
              })
              .catch((err) => {
                if (!liveRef.current) return;
                setStatus('error');
                setError(err.message);
              });
          };
          pollRef.current = setTimeout(poll, 700);
        }, wait);
      })
      .catch((err) => {
        if (!liveRef.current) return;
        setStatus('error');
        setError(err.message);
      });
  };

  useEffect(() => {
    liveRef.current = true;
    if (!district) return;
    runAnalysis(false);
    return () => {
      liveRef.current = false;
      if (pollRef.current) { clearTimeout(pollRef.current); pollRef.current = null; }
      timersRef.current.forEach(clearTimeout);
      timersRef.current = [];
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [district]);

  const total = result?.total_buildings ?? 0;
  const inZone = result?.projection_count ?? 0;
  const safe = Math.max(0, total - inZone);
  const pct = result?.percentage ?? 0;
  const areaSqm = result?.area_sqm ?? 0;
  const zoneAreaSqm = result?.zone_area_sqm ?? 0;

  const modalClass = `enc-modal${minimized ? ' enc-modal--minimized' : ''}${maximized ? ' enc-modal--maximized' : ''}`;
  const positionStyle = minimized
    ? { left: pillPos.x, top: pillPos.y, width: PILL_W }
    : { left: pos.x, top: pos.y };

  const handleHeaderMouseDown = (e) => {
    if (minimized) onPillMouseDown(e);
    else onMouseDown(e);
  };
  const handleHeaderClick = () => {
    if (!minimized) return;
    if (pillDidMoveRef.current) return;
    setMinimized(false);
  };

  return ReactDOM.createPortal(
    <div
      className={modalClass}
      style={positionStyle}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="enc-streak enc-streak--1" />
      <div className="enc-streak enc-streak--2" />

      <div
        className="enc-header"
        onMouseDown={handleHeaderMouseDown}
        onClick={handleHeaderClick}
        style={{ cursor: 'grab' }}
        title={minimized ? 'Drag to move · click to restore' : undefined}
      >
        <div className="enc-header-left">
          <span className="enc-icon" aria-hidden>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
              <path d="M3 15c2-2 4-2 6 0s4 2 6 0 4-2 6 0" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
              <path d="M3 19c2-2 4-2 6 0s4 2 6 0 4-2 6 0" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" opacity="0.65"/>
              <path d="M12 3c2.5 3 4 5.3 4 7.5A4 4 0 018 10.5C8 8.3 9.5 6 12 3z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"/>
            </svg>
          </span>
          <div className="enc-header-text">
            <span className="enc-badge">Flood Projections 2026</span>
            <span className="enc-district">{district || '—'}</span>
          </div>
        </div>
        <div className="enc-header-actions">
          {!minimized && (
            <button
              className="enc-iconbtn"
              onClick={(e) => { e.stopPropagation(); runAnalysis(true); }}
              aria-label="Refresh analysis"
              title="Re-run analysis (ignore cache)"
              disabled={status !== 'done' && status !== 'error'}
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                <path d="M10 6a4 4 0 11-1.17-2.83" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" fill="none"/>
                <path d="M10 2v2.5H7.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
              </svg>
            </button>
          )}
          {!minimized && (
            <button
              className="enc-iconbtn"
              onClick={(e) => { e.stopPropagation(); setMaximized((m) => !m); }}
              aria-label={maximized ? 'Restore' : 'Maximize'}
              title={maximized ? 'Restore' : 'Maximize'}
            >
              {maximized ? (
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><rect x="3" y="3" width="6" height="6" rx="1" stroke="currentColor" strokeWidth="1.6" fill="none"/></svg>
              ) : (
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><rect x="2" y="2" width="8" height="8" rx="1" stroke="currentColor" strokeWidth="1.6" fill="none"/></svg>
              )}
            </button>
          )}
          <button
            className="enc-iconbtn"
            onClick={(e) => {
              e.stopPropagation();
              setMinimized((m) => !m);
              if (!minimized) setMaximized(false);
            }}
            aria-label={minimized ? 'Restore' : 'Minimize'}
            title={minimized ? 'Restore' : 'Minimize'}
          >
            {minimized ? (
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                <path d="M3 7l3 3 3-3M3 3l3 3 3-3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" transform="rotate(180 6 6)"/>
              </svg>
            ) : (
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 6h8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/></svg>
            )}
          </button>
          <button
            className="enc-close"
            onClick={(e) => { e.stopPropagation(); onClose(); }}
            aria-label="Close"
          >
            <svg width="12" height="12" viewBox="0 0 14 14" fill="none">
              <path d="M1 1l12 12M13 1L1 13" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
            </svg>
          </button>
        </div>
      </div>

      <div className="enc-body">
        {status === 'searching' && (
          <div className="enc-loading">
            <ul className="enc-steps">
              <li className="enc-step enc-step--running">
                <span className="enc-step-icon" aria-hidden>
                  <span className="enc-step-spin" />
                </span>
                <span className="enc-step-label">Searching cache for {district}…</span>
              </li>
            </ul>
          </div>
        )}

        {status === 'found' && (
          <div className="enc-loading">
            <ul className="enc-steps">
              <li className="enc-step enc-step--done">
                <span className="enc-step-icon" aria-hidden>
                  <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
                    <path d="M2 6.5l2.5 2.5L10 3.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
                  </svg>
                </span>
                <span className="enc-step-label">Records found — loading results…</span>
              </li>
            </ul>
          </div>
        )}

        {status === 'processing' && (
          <div className="enc-loading">
            <ul className="enc-steps">
              {[
                ['Clipping flood projection to district', 40],
                ['Fetching building shapefile', 60],
                ['Reading buildings', 75],
                ['Intersecting buildings with projection', 90],
                ['Saving results', 100],
              ].map(([label, threshold], i, arr) => {
                const prevThreshold = i === 0 ? 0 : arr[i - 1][1];
                let stepStatus;
                if (progress >= threshold) stepStatus = 'done';
                else if (progress >= prevThreshold) stepStatus = 'running';
                else stepStatus = 'pending';
                return (
                  <li key={label} className={`enc-step enc-step--${stepStatus}`}>
                    <span className="enc-step-icon" aria-hidden>
                      {stepStatus === 'done' ? (
                        <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
                          <path d="M2 6.5l2.5 2.5L10 3.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
                        </svg>
                      ) : stepStatus === 'running' ? (
                        <span className="enc-step-spin" />
                      ) : (
                        <span className="enc-step-pip" />
                      )}
                    </span>
                    <span className="enc-step-label">{label}</span>
                  </li>
                );
              })}
            </ul>
            <div className="enc-progress-track">
              <div className="enc-progress-fill" style={{ width: `${progress}%` }} />
            </div>
            <div className="enc-progress-pct">{Math.round(progress)}%</div>
          </div>
        )}

        {status === 'error' && (
          <div className="enc-error">
            <div className="enc-error-title">Analysis failed</div>
            <div className="enc-error-msg">{error}</div>
          </div>
        )}

        {status === 'done' && result && (
          <>
            <div className="enc-headline">
              <div className="enc-headline-val">{formatCount(inZone)}</div>
              <div className="enc-headline-lbl">Structures in flood projection</div>
              {fromCache && <span className="enc-cache-pill">cached</span>}
            </div>

            <div className="enc-pct-row">
              <div className="enc-pct-track">
                <div className="enc-pct-fill" style={{ width: `${Math.min(100, pct)}%` }} />
              </div>
              <div className="enc-pct-val">{pct.toFixed(2)}%</div>
            </div>

            <div className="enc-grid">
              <div className="enc-stat enc-stat--total">
                <div className="enc-stat-val">{formatCount(total)}</div>
                <div className="enc-stat-lbl">Total buildings</div>
              </div>
              <div className="enc-stat enc-stat--zone">
                <div className="enc-stat-val">{formatCount(inZone)}</div>
                <div className="enc-stat-lbl">In projection</div>
              </div>
              <div className="enc-stat enc-stat--safe">
                <div className="enc-stat-val">{formatCount(safe)}</div>
                <div className="enc-stat-lbl">Outside projection</div>
              </div>
            </div>

            <div className="enc-area">
              <div className="enc-area-row">
                <span className="enc-area-lbl">Projected flood area</span>
                <span className="enc-area-val">{formatArea(zoneAreaSqm)}</span>
              </div>
              <div className="enc-area-row enc-area-row--sub">
                <span className="enc-area-lbl">Structure footprint</span>
                <span className="enc-area-val enc-area-val--sub">{formatArea(areaSqm)}</span>
              </div>
            </div>

            <div className="enc-foot">
              Count and footprint area of structures inside the Flood
              Projections 2026 extent for {district}. Results cached on disk
              for instant re-open.
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
