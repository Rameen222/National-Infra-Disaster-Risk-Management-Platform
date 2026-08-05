import React, { useState, useEffect, useRef } from 'react';
import ReactDOM from 'react-dom';
import useDrag from '../../hooks/useDrag';
import './EncroachmentModal.css';

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

// Minimum time the cache-search and "records found" animations stay on
// screen so users perceive the steps clearly.
const SEARCH_MIN_MS = 600;
const FOUND_FLASH_MS = 700;

export default function EncroachmentModal({ district, onClose, onResultReady }) {
  // searching → found → done   (cached path)
  // searching → processing → done   (cold path)
  // … → error on failure
  const [status, setStatus] = useState('searching');
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [fromCache, setFromCache] = useState(false);
  const [minimized, setMinimized] = useState(false);
  const [maximized, setMaximized] = useState(false);
  // High-susceptibility count resolves independently: 'idle' | 'processing' | 'done' | 'error'
  const [highSusStatus, setHighSusStatus] = useState('idle');
  const [highSusData, setHighSusData] = useState(null);
  const [highSusProgress, setHighSusProgress] = useState(0);
  const pollRef = useRef(null);
  const hsPollRef = useRef(null);
  // Track every setTimeout we schedule so unmount / re-run can cancel them.
  // Otherwise rapid open/close cycles can fire onResultReady multiple times
  // for stale runs and stack effect re-runs in MapContainer.
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
  // Position the panel near the top-right by default; user can drag it.
  const initialX = typeof window !== 'undefined' ? Math.max(20, window.innerWidth - 380) : 0;
  const initialY = 96;
  const { pos, onMouseDown } = useDrag(initialX, initialY);

  // Independent drag state for the docked pill (free-floating; default
  // position is below the District Stats pill so they don't overlap).
  const PILL_W = 220;
  const PILL_MARGIN = 18;
  const pillInitX = typeof window !== 'undefined' ? window.innerWidth - PILL_W - PILL_MARGIN : 0;
  const pillInitY = typeof window !== 'undefined' ? window.innerHeight - 52 - PILL_MARGIN : 0;
  const { pos: pillPos, onMouseDown: onPillMouseDown, didMoveRef: pillDidMoveRef } = useDrag(pillInitX, pillInitY);

  // Single-pass analysis. The backend is the source of truth — we ask it
  // whether the district has cached temp files, and animate the UI through
  // the appropriate states based on its response.
  //   force=false: respect on-disk cache (default flow on modal open)
  //   force=true:  delete temp files server-side and reprocess (Refresh btn)
  const runAnalysis = (force = false) => {
    if (!district) return;
    // Cancel any in-flight timers from a previous run so stale callbacks
    // don't fire onResultReady (which would bump the map reload key).
    timersRef.current.forEach(clearTimeout);
    timersRef.current = [];
    if (pollRef.current) { clearTimeout(pollRef.current); pollRef.current = null; }
    if (hsPollRef.current) { clearTimeout(hsPollRef.current); hsPollRef.current = null; }

    setError(null);
    setResult(null);
    setProgress(0);
    setFromCache(false);
    setStatus('searching');
    setHighSusStatus('idle');
    setHighSusData(null);
    setHighSusProgress(0);
    const startedAt = Date.now();

    // Resolve the high-susceptibility count. If the main result already carries
    // it (fresh compute), use it directly; otherwise (older cached buffer stats)
    // fetch it from the dedicated endpoint and poll, showing an inline spinner.
    const resolveHighSus = (mainResult) => {
      if (mainResult && mainResult.high_sus_count != null) {
        setHighSusData({
          high_sus_count: mainResult.high_sus_count,
          high_sus_percentage: mainResult.high_sus_percentage ?? 0,
        });
        setHighSusStatus('done');
        return;
      }
      setHighSusStatus('processing');
      setHighSusProgress(5);
      const bumpProgress = (p) => setHighSusProgress((prev) => Math.max(prev, p || 0));
      fetch('/pyapi/buildings/highsus', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ district }),
      })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error('highsus error'))))
        .then((d) => {
          if (!liveRef.current) return;
          if (d.status === 'done' && d.result) {
            setHighSusData(d.result);
            setHighSusProgress(100);
            setHighSusStatus('done');
            return;
          }
          bumpProgress(d.progress);
          const pollHs = () => {
            fetch(`/pyapi/buildings/highsus/status?district=${encodeURIComponent(district)}`)
              .then((r) => (r.ok ? r.json() : Promise.reject(new Error('highsus poll error'))))
              .then((s) => {
                if (!liveRef.current) return;
                bumpProgress(s.progress);
                if (s.status === 'done' && s.result) {
                  setHighSusData(s.result);
                  setHighSusProgress(100);
                  setHighSusStatus('done');
                } else if (s.status === 'error') {
                  setHighSusStatus('error');
                } else {
                  hsPollRef.current = setTimeout(pollHs, 800);
                }
              })
              .catch(() => { if (liveRef.current) setHighSusStatus('error'); });
          };
          hsPollRef.current = setTimeout(pollHs, 800);
        })
        .catch(() => { if (liveRef.current) setHighSusStatus('error'); });
    };

    const finishCached = (data) => {
      setFromCache(true);
      setStatus('found');
      // Brief "Records found" flash so the user sees the cache hit, then
      // reveal the stats. Map layers start loading at the same time so the
      // map populates while the modal animates.
      onResultReady?.(data.result);
      schedule(() => {
        setResult(data.result);
        setProgress(100);
        setStatus('done');
        resolveHighSus(data.result);
      }, FOUND_FLASH_MS);
    };

    const startProcessing = () => {
      setStatus('processing');
      setProgress(5);
    };

    fetch('/pyapi/buildings/encroachment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ district, force }),
    })
      .then((r) => { if (!r.ok) throw new Error(`Server error ${r.status}`); return r.json(); })
      .then((data) => {
        if (!liveRef.current) return;
        console.log('[encroach] POST returned', { district, status: data.status, cached: data.cached, hasResult: !!data.result });
        // Hold the searching animation for at least SEARCH_MIN_MS so it's
        // visible to the user (otherwise a cache hit would flash by).
        const elapsed = Date.now() - startedAt;
        const wait = Math.max(0, SEARCH_MIN_MS - elapsed);

        schedule(() => {
          if (data.status === 'done' && data.result) {
            finishCached(data);
            return;
          }
          // No cache hit → kick into the multi-step processing animation
          startProcessing();
          const poll = () => {
            fetch(`/pyapi/buildings/encroachment/status?district=${encodeURIComponent(district)}`)
              .then((r) => { if (!r.ok) throw new Error('poll error'); return r.json(); })
              .then((s) => {
                if (!liveRef.current) return;
                setProgress(s.progress || 0);
                if (s.status === 'done' && s.result) {
                  setResult(s.result);
                  setStatus('done');
                  setProgress(100);
                  onResultReady?.(s.result);
                  resolveHighSus(s.result);
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
      // Mark the run as dead so any in-flight setTimeout/fetch callbacks
      // become no-ops, and clear every timer we scheduled.
      liveRef.current = false;
      if (pollRef.current) { clearTimeout(pollRef.current); pollRef.current = null; }
      if (hsPollRef.current) { clearTimeout(hsPollRef.current); hsPollRef.current = null; }
      timersRef.current.forEach(clearTimeout);
      timersRef.current = [];
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [district]);

  const total = result?.total_buildings ?? 0;
  const inZone = result?.encroachment_count ?? 0;
  const safe = Math.max(0, total - inZone);
  const pct = result?.percentage ?? 0;
  const areaSqm = result?.area_sqm ?? 0;
  const zoneAreaSqm = result?.zone_area_sqm ?? 0;
  const highSus = highSusData?.high_sus_count ?? 0;
  const highSusPct = highSusData?.high_sus_percentage ?? 0;

  const modalClass = `enc-modal${minimized ? ' enc-modal--minimized' : ''}${maximized ? ' enc-modal--maximized' : ''}`;

  const positionStyle = minimized
    ? { left: pillPos.x, top: pillPos.y, width: PILL_W }
    : { left: pos.x, top: pos.y };

  // Header drag/click. When minimized, drag the pill itself; click (without
  // movement) restores. When normal, drag the panel; no click action.
  const handleHeaderMouseDown = (e) => {
    if (minimized) onPillMouseDown(e);
    else onMouseDown(e);
  };
  const handleHeaderClick = () => {
    if (!minimized) return;
    if (pillDidMoveRef.current) return; // it was a drag, not a click
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
              <path d="M3 17c2-2 4-2 6 0s4 2 6 0 4-2 6 0" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
              <path d="M3 12c2-2 4-2 6 0s4 2 6 0 4-2 6 0" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" opacity="0.65"/>
              <path d="M3 7c2-2 4-2 6 0s4 2 6 0 4-2 6 0" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" opacity="0.4"/>
            </svg>
          </span>
          <div className="enc-header-text">
            <span className="enc-badge">Encroachment</span>
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
        {/* ── Searching cache (initial state) ───────────── */}
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

        {/* ── Records found (cache hit, brief flash) ────── */}
        {status === 'found' && (
          <div className="enc-loading">
            <ul className="enc-steps">
              <li className="enc-step enc-step--done">
                <span className="enc-step-icon" aria-hidden>
                  <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
                    <path d="M2 6.5l2.5 2.5L10 3.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
                  </svg>
                </span>
                <span className="enc-step-label">Records found — loading layers…</span>
              </li>
            </ul>
          </div>
        )}

        {/* ── Processing (cold path, multi-step pipeline) ── */}
        {status === 'processing' && (
          <div className="enc-loading">
            <ul className="enc-steps">
              {[
                ['Clipping encroachment to district', 40],
                ['Fetching building shapefile', 60],
                ['Reading buildings', 75],
                ['Intersecting buildings with encroachment', 90],
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
              <div className="enc-headline-lbl">Buildings in encroachment zone</div>
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
                <div className="enc-stat-lbl">In encroachment zone</div>
              </div>
              <div className="enc-stat enc-stat--safe">
                <div className="enc-stat-val">{formatCount(safe)}</div>
                <div className="enc-stat-lbl">Outside zone</div>
              </div>
            </div>

            <div className="enc-highsus">
              <div className="enc-highsus-text">
                {highSusStatus === 'done' ? (
                  <div className="enc-highsus-val">{formatCount(highSus)}</div>
                ) : highSusStatus === 'error' ? (
                  <div className="enc-highsus-val">—</div>
                ) : (
                  <div className="enc-highsus-loading">
                    <span className="enc-step-spin" />
                    <span className="enc-highsus-loading-txt">Analyzing… {Math.round(highSusProgress)}%</span>
                  </div>
                )}
                <div className="enc-highsus-lbl">In high susceptibility zone</div>
              </div>
              {highSusStatus === 'done' && (
                <div className="enc-highsus-pct">{highSusPct.toFixed(2)}%</div>
              )}
            </div>

            <div className="enc-area">
              <div className="enc-area-row">
                <span className="enc-area-lbl">Encroachment zone</span>
                <span className="enc-area-val">{formatArea(zoneAreaSqm)}</span>
              </div>
              <div className="enc-area-row enc-area-row--sub">
                <span className="enc-area-lbl">Building footprint</span>
                <span className="enc-area-val enc-area-val--sub">{formatArea(areaSqm)}</span>
              </div>
            </div>

            <div className="enc-foot">
              Buildings highlighted in red on the map. Results cached on disk
              and in your browser for instant re-open.
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
