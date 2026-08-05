import React, { useEffect, useMemo, useRef, useState } from 'react';
import ReactDOM from 'react-dom';
import useDrag from '../../hooks/useDrag';
import { fetchExposures, fetchExposureDetails, collectExposureDistricts } from './gcopApi';
import { findBuildingEntry } from '../../utils/buildingData';
import './GCOPExposureModal.css';

// Exposure IDs pinned to the top of the dropdown, in the order shown.
// Stringified so we can match regardless of whether the API returns
// numbers or strings.
const PINNED_EXPOSURE_IDS = ['342', '343', '345', '347', '348', '349', '350', '351', '352'];
const PINNED_RANK = new Map(PINNED_EXPOSURE_IDS.map((id, i) => [id, i]));

const POLL_INTERVAL_MS = 1200;

// Start a GCOP count task on the backend and poll its status endpoint until
// it resolves. The backend pipeline: bbox-filtered WFS download → spatial
// sjoin in geopandas → cached count. `onProgress(percent, stage)` is invoked
// with each poll so the modal can show what the worker is doing live.
//
// Resolves to a number on success, null when no WFS layer exists for the
// district, and throws on any HTTP/transport error.
async function fetchBuildingCountInGeometry(district, geometry, onProgress, signal) {
  const startResp = await fetch('/pyapi/buildings/count-in-geometry', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ district, geometry }),
    signal,
  });
  if (!startResp.ok) throw new Error(`HTTP ${startResp.status}`);
  const startBody = await startResp.json();

  // Disk-cache hit — backend returns the result immediately.
  if (startBody.status === 'done' && startBody.result) {
    onProgress?.(100, 'cached');
    const n = startBody.result.total_buildings;
    return typeof n === 'number' ? n : null;
  }

  const taskId = startBody.task_id;
  if (!taskId) throw new Error('Backend did not return a task_id');

  // Poll status until done / error / aborted.
  while (true) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    const s = await fetch(
      `/pyapi/buildings/count-in-geometry/status?task_id=${encodeURIComponent(taskId)}`,
      { signal },
    );
    if (!s.ok) throw new Error(`Status ${s.status}`);
    const ss = await s.json();
    onProgress?.(ss.progress || 0, ss.stage || '');

    if (ss.status === 'error') {
      // A "no WFS URL" error is a soft miss — surface as "missing" not "error".
      if (typeof ss.error === 'string' && /no wfs url/i.test(ss.error)) return null;
      throw new Error(ss.error || 'GCOP count failed');
    }
    if (ss.status === 'done' && ss.result) {
      const n = ss.result.total_buildings;
      return typeof n === 'number' ? n : null;
    }
  }
}

function formatCount(n) {
  if (n == null) return '—';
  return Number(n).toLocaleString();
}

export default function GCOPExposureModal({
  onExposureLoaded,         // (geojson, districts: Set, exposureId) => void
  onExposureCleared,        // () => void
  hasExposure,
  onClose,
  buildingIndex,
  showBuildings,
  activeBuildingDistrict,
  onToggleBuildings,
  onToggleSimexBuildings,   // (scenarioId, district) => void — for pre-computed scenarios
  simexActiveDistrict,      // district name whose simex buildings are currently shown
  onOpenSimexRisk,          // (scenarioId, district, buildingCount) => void
}) {
  const [exposures, setExposures] = useState([]);
  const [loadingList, setLoadingList] = useState(false);
  const [listError, setListError] = useState(null);
  const [selectedId, setSelectedId] = useState('');
  const [query, setQuery] = useState('');   // filter text for the scenario list
  const [loadingDetails, setLoadingDetails] = useState(false);
  const [detailsError, setDetailsError] = useState(null);
  const [districts, setDistricts] = useState([]);     // array of district names
  const [exposureGeoJSON, setExposureGeoJSON] = useState(null);
  // Map of district name → { status: 'loading' | 'ok' | 'missing' | 'error', count?, error? }
  const [counts, setCounts] = useState({});
  // Pre-computed HPC scenario data: { [scenarioId]: { folder, districts: {name: count}, total } }
  const [precomputed, setPrecomputed] = useState(null);
  const [isPrecomputed, setIsPrecomputed] = useState(false);
  const abortRef = useRef(null);
  const countsAbortRef = useRef(null);

  // Sort pinned IDs to the top (in PINNED_EXPOSURE_IDS order), preserve
  // service order for the rest.
  const sortedExposures = useMemo(() => {
    const pinned = [];
    const rest = [];
    for (const row of exposures) {
      if (PINNED_RANK.has(String(row.id))) pinned.push(row);
      else rest.push(row);
    }
    pinned.sort((a, b) => PINNED_RANK.get(String(a.id)) - PINNED_RANK.get(String(b.id)));
    return [...pinned, ...rest];
  }, [exposures]);

  // Apply the search filter (matches scenario id or remarks, case-insensitive).
  // Pinned order is preserved within the filtered result.
  const filteredExposures = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sortedExposures;
    return sortedExposures.filter(({ id, remarks }) =>
      String(id).toLowerCase().includes(q) ||
      (remarks || '').toLowerCase().includes(q)
    );
  }, [sortedExposures, query]);

  const initialX = typeof window !== 'undefined' ? Math.max(20, window.innerWidth - 380) : 0;
  const initialY = 96;
  const { pos, onMouseDown } = useDrag(initialX, initialY);

  // Load exposure list and pre-computed scenario data once when modal opens.
  useEffect(() => {
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoadingList(true);
    setListError(null);
    fetchExposures(ctrl.signal)
      .then((rows) => setExposures(rows))
      .catch((err) => {
        if (err.name !== 'AbortError') setListError(err.message || 'Failed to load exposures');
      })
      .finally(() => setLoadingList(false));

    fetch('/pyapi/simex/precomputed', { signal: ctrl.signal })
      .then((r) => r.ok ? r.json() : {})
      .then((data) => setPrecomputed(data))
      .catch(() => setPrecomputed({}));

    return () => ctrl.abort();
  }, []);

  // Once we know which districts the exposure touches, fetch building counts
  // for each sequentially via WFS. Skipped for pre-computed scenarios where
  // counts are already set from the local shapefile DBF headers.
  useEffect(() => {
    if (countsAbortRef.current) countsAbortRef.current.abort();
    if (isPrecomputed) return; // counts pre-filled in handleSelect
    if (!districts.length || !exposureGeoJSON) { setCounts({}); return; }
    const ctrl = new AbortController();
    countsAbortRef.current = ctrl;

    const initial = {};
    districts.forEach((d) => { initial[d] = { status: 'loading' }; });
    setCounts(initial);

    (async () => {
      for (const d of districts) {
        if (ctrl.signal.aborted) return;

        const onProgress = (percent, stage) => {
          if (ctrl.signal.aborted) return;
          setCounts((prev) => {
            const existing = prev[d];
            if (!existing || existing.status !== 'loading') return prev;
            if (existing.progress === percent && existing.stage === stage) return prev;
            return { ...prev, [d]: { status: 'loading', progress: percent, stage } };
          });
        };

        try {
          const n = await fetchBuildingCountInGeometry(d, exposureGeoJSON, onProgress, ctrl.signal);
          if (ctrl.signal.aborted) return;
          setCounts((prev) => ({
            ...prev,
            [d]: n == null ? { status: 'missing' } : { status: 'ok', count: n },
          }));
        } catch (err) {
          if (err.name === 'AbortError') return;
          setCounts((prev) => ({ ...prev, [d]: { status: 'error', error: err.message } }));
        }
      }
    })();

    return () => ctrl.abort();
  }, [districts, exposureGeoJSON, isPrecomputed]);

  // Sort the displayed list: known counts (desc) → missing → errors. Within a
  // tie, alphabetical so the list is stable as new counts arrive.
  const sortedDistricts = useMemo(() => {
    const rank = { ok: 0, loading: 1, missing: 2, error: 3 };
    return [...districts].sort((a, b) => {
      const ra = rank[counts[a]?.status ?? 'loading'];
      const rb = rank[counts[b]?.status ?? 'loading'];
      if (ra !== rb) return ra - rb;
      const ca = counts[a]?.count ?? -1;
      const cb = counts[b]?.count ?? -1;
      if (ca !== cb) return cb - ca;
      return a.localeCompare(b);
    });
  }, [districts, counts]);

  const totalBuildings = useMemo(() => {
    let sum = 0;
    for (const d of districts) {
      const c = counts[d];
      if (c?.status === 'ok') sum += c.count || 0;
    }
    return sum;
  }, [districts, counts]);

  const resolvedCount = districts.filter((d) => {
    const s = counts[d]?.status;
    return s && s !== 'loading';
  }).length;
  const allResolved = districts.length > 0 && resolvedCount === districts.length;
  const counting = districts.length > 0 && !allResolved;

  const handleSelect = async (id) => {
    setSelectedId(id);
    setDetailsError(null);
    setDistricts([]);
    setExposureGeoJSON(null);
    setCounts({});
    if (!id) return;

    const pc = precomputed?.[String(id)];

    if (pc) {
      // Pre-computed path: geometry from backend, counts from DBF headers (instant).
      setIsPrecomputed(true);
      setLoadingDetails(true);
      try {
        const resp = await fetch(`/pyapi/simex/geometry/${encodeURIComponent(id)}`);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const fc = await resp.json();
        const districtNames = Object.keys(pc.districts);
        const initialCounts = {};
        districtNames.forEach((d) => { initialCounts[d] = { status: 'ok', count: pc.districts[d] }; });
        setExposureGeoJSON(fc);
        setDistricts(districtNames);
        setCounts(initialCounts);
        onExposureLoaded?.(fc, new Set(districtNames), id);
      } catch (err) {
        setDetailsError(err.message || 'Failed to load scenario geometry');
      } finally {
        setLoadingDetails(false);
      }
    } else {
      // Standard WFS path: fetch geometry from external GCOP API, then count via WFS.
      setIsPrecomputed(false);
      setLoadingDetails(true);
      try {
        const ctrl = new AbortController();
        const fc = await fetchExposureDetails(id, ctrl.signal);
        const set = collectExposureDistricts(fc);
        const list = Array.from(set);
        setExposureGeoJSON(fc);
        setDistricts(list);
        onExposureLoaded?.(fc, set, id);
      } catch (err) {
        setDetailsError(err.message || 'Failed to load exposure details');
      } finally {
        setLoadingDetails(false);
      }
    }
  };

  const handleRemove = () => {
    setSelectedId('');
    setDistricts([]);
    setExposureGeoJSON(null);
    setCounts({});
    setIsPrecomputed(false);
    onExposureCleared?.();
  };

  return ReactDOM.createPortal(
    <div className="gcop-modal" style={{ left: pos.x, top: pos.y }} onClick={(e) => e.stopPropagation()}>
      <div className="gcop-streak gcop-streak--1" />
      <div className="gcop-streak gcop-streak--2" />

      <div className="gcop-header" onMouseDown={onMouseDown} style={{ cursor: 'grab' }}>
        <div className="gcop-header-left">
          <span className="gcop-icon" aria-hidden>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
              <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2 2M16.4 16.4l2 2M5.6 18.4l2-2M16.4 7.6l2-2"
                    stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/>
              <circle cx="12" cy="12" r="4" stroke="currentColor" strokeWidth="1.6"/>
            </svg>
          </span>
          <div className="gcop-header-text">
            <span className="gcop-badge">SIMEX</span>
            <span className="gcop-title">Scenarios</span>
          </div>
        </div>
        <button className="gcop-close" onClick={onClose} aria-label="Close">
          <svg width="11" height="11" viewBox="0 0 14 14" fill="none">
            <path d="M1 1l12 12M13 1L1 13" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
          </svg>
        </button>
      </div>

      <div className="gcop-body">
        <label className="gcop-label">Select a scenario</label>
        <input
          type="text"
          className="gcop-search"
          placeholder="Search scenarios…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          disabled={loadingList || !!listError}
        />
        <select
          className="gcop-select"
          value={selectedId}
          onChange={(e) => handleSelect(e.target.value)}
          disabled={loadingList || !!listError}
        >
          {loadingList && <option value="">Loading exposures…</option>}
          {listError && <option value="">Exposure service unavailable</option>}
          {!loadingList && !listError && (
            <>
              <option value="">Select a scenario</option>
              {filteredExposures.length === 0 && (
                <option value="" disabled>
                  {query.trim() ? 'No scenarios match your search' : 'No exposures available'}
                </option>
              )}
              {filteredExposures.map(({ id, remarks }) => {
                const pinned = PINNED_RANK.has(String(id));
                return (
                  <option key={id} value={id}>
                    {pinned ? '★ ' : ''}{id} — {remarks || 'No remarks'}
                  </option>
                );
              })}
            </>
          )}
        </select>

        {loadingDetails && (
          <div className="gcop-status gcop-status--loading">
            <span className="gcop-spin" /> Loading exposure features…
          </div>
        )}
        {detailsError && (
          <div className="gcop-status gcop-status--error">{detailsError}</div>
        )}

        {hasExposure && districts.length > 0 && (
          <div className={`gcop-counts${counting ? ' gcop-counts--counting' : ''}`}>
            {/* Big visible loader while WFS counts are still resolving. */}
            {counting && (
              <div className="gcop-counts-loader" role="status" aria-live="polite">
                <span className="gcop-counts-loader__spin" aria-hidden />
                <div className="gcop-counts-loader__text">
                  <div className="gcop-counts-loader__title">Counting buildings…</div>
                  <div className="gcop-counts-loader__sub">
                    {resolvedCount} of {districts.length} district{districts.length === 1 ? '' : 's'} done
                  </div>
                </div>
                <div className="gcop-counts-loader__bar">
                  <div
                    className="gcop-counts-loader__bar-fill"
                    style={{ width: `${(resolvedCount / districts.length) * 100}%` }}
                  />
                </div>
              </div>
            )}

            <div className="gcop-counts-summary">
              <div className="gcop-counts-summary__lbl">
                Buildings inside exposure footprint
                <span className="gcop-counts-summary__sub">
                  across {districts.length} district{districts.length === 1 ? '' : 's'}
                </span>
              </div>
              <div className="gcop-counts-summary__val">
                {allResolved
                  ? formatCount(totalBuildings)
                  : <><span className="gcop-spin" /> {formatCount(totalBuildings)}</>}
              </div>
            </div>

            <ul className="gcop-counts-list">
              {sortedDistricts.map((d) => {
                const c = counts[d] || { status: 'loading' };
                const buildingEntry = findBuildingEntry(buildingIndex, d);
                const simexActive = simexActiveDistrict === d;
                const wfsActive = showBuildings && activeBuildingDistrict?.districtKey?.toLowerCase() === d.toLowerCase();
                const active = isPrecomputed ? simexActive : wfsActive;
                const showViewBtn = c.status === 'ok' && (isPrecomputed || buildingEntry);
                return (
                  <li key={d} className={`gcop-counts-row gcop-counts-row--${c.status}`}>
                    <div className="gcop-counts-row__main">
                      <span className="gcop-counts-row__name" title={d}>{d.replace(/_/g, ' ')}</span>
                      <span className="gcop-counts-row__val">
                        {c.status === 'ok'      && formatCount(c.count)}
                        {c.status === 'loading' && <span className="gcop-spin gcop-spin--sm" />}
                        {c.status === 'missing' && <span title="No WFS layer configured">n/a</span>}
                        {c.status === 'error'   && <span title={c.error}>error</span>}
                      </span>
                    </div>
                    <div className="gcop-counts-row__actions">
                      {showViewBtn && (
                        <button
                          type="button"
                          className={`gcop-counts-row__btn${active ? ' gcop-counts-row__btn--active' : ''}`}
                          onClick={() => isPrecomputed
                            ? onToggleSimexBuildings?.(selectedId, d)
                            : onToggleBuildings?.(d)}
                        >
                          {active ? 'Hide buildings' : 'View buildings'}
                        </button>
                      )}
                      {isPrecomputed && c.status === 'ok' && (
                        <button
                          type="button"
                          className="gcop-counts-row__btn gcop-counts-row__btn--risk"
                          onClick={() => onOpenSimexRisk?.(selectedId, d, c.count)}
                          title="Open SIMEX Risk Calculator for this district"
                        >
                          Risk Calc
                        </button>
                      )}
                    </div>
                    {c.status === 'loading' && (c.stage || c.progress != null) && (
                      <div className="gcop-counts-row__stage">
                        {c.stage || 'working…'}
                        {typeof c.progress === 'number' && c.progress > 0 ? ` · ${c.progress}%` : ''}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        <div className="gcop-actions">
          <button
            className="gcop-btn gcop-btn--ghost"
            onClick={handleRemove}
            disabled={!hasExposure}
            title="Remove the exposure overlay"
          >
            <svg width="12" height="12" viewBox="0 0 14 14" fill="none">
              <path d="M3 4h8M5.5 4V2.5h3V4M4.5 4l.6 8.5h3.8l.6-8.5"
                    stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            Remove Layer
          </button>
        </div>

        <div className="gcop-foot">
          Exposure footprint is drawn in red on the map. Each row shows the
          number of buildings whose footprint falls inside the exposure
          polygon, restricted to that district's WFS layer.
        </div>
      </div>
    </div>,
    document.body,
  );
}
