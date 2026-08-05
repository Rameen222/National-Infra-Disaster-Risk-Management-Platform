import React, { useState, useEffect, useRef, useCallback } from 'react';
import { loadDistrictTehsils, tehsilCacheKey, exposureTehsilCacheKey } from '../../utils/districtTehsils';
import { fetchExposures, fetchExposureDetails } from '../GCOPExposure/gcopApi';
import './TehsilBuildingsModal.css';

const fmt = (n) => (n == null ? '—' : Number(n).toLocaleString());

// localStorage cache of computed counts { cacheKey: count } (plain + scenario)
// so a district whose tehsils were already processed shows counts instantly.
const LS_KEY = 'tehsilBuildingCounts';
const readCountCache = () => {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}'); } catch { return {}; }
};
const writeCount = (key, count) => {
  try {
    const all = readCountCache();
    all[key] = count;
    localStorage.setItem(LS_KEY, JSON.stringify(all));
  } catch { /* ignore quota / private-mode errors */ }
};
const clearCount = (key) => {
  try {
    const all = readCountCache();
    delete all[key];
    localStorage.setItem(LS_KEY, JSON.stringify(all));
  } catch { /* ignore */ }
};

// Small circular-arrow refresh icon.
const RefreshIcon = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
    <path d="M10 6a4 4 0 11-1.17-2.83" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" fill="none" />
    <path d="M10 2v2.5H7.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" fill="none" />
  </svg>
);

// SIMEX scenarios come from the GCOP exposure catalog; fetched once, shared.
const cleanLabel = (remarks, id) => (remarks || `Scenario ${id}`)
  .replace(/simm?ulation/ig, '')
  .replace(/scenario/ig, '')
  .replace(/_/g, ' ')
  .replace(/\s+/g, ' ')
  .trim() || String(id);

let _scenariosPromise = null;
function loadScenarios() {
  if (!_scenariosPromise) {
    _scenariosPromise = fetchExposures()
      .then((rows) => rows.map((r) => ({ id: String(r.id), label: cleanLabel(r.remarks, r.id) })))
      .catch((err) => { _scenariosPromise = null; throw err; });
  }
  return _scenariosPromise;
}

// Static (file-based) projections shown alongside the GCOP scenarios. Their
// footprint lives in the client public folder and is read server-side, so we
// don't upload it — `clipFor` returns null and the backend loads it by id.
const LOCAL_PROJECTIONS = [{ id: 'north_waterways', label: 'GB Flood Projection 2026' }];
const LOCAL_IDS = new Set(LOCAL_PROJECTIONS.map((p) => p.id));

// Scenario flood footprints, cached per scenario so we fetch each once.
const _footprintCache = new Map();
function loadFootprint(id) {
  if (!_footprintCache.has(id)) {
    _footprintCache.set(id, fetchExposureDetails(id).catch((err) => { _footprintCache.delete(id); throw err; }));
  }
  return _footprintCache.get(id);
}

// Clip payload to send the backend: null for static projections (read on disk).
const clipFor = (id) => (LOCAL_IDS.has(id) ? Promise.resolve(null) : loadFootprint(id));

/**
 * Rendered inside the district stats modal. Top: every tehsil in the district
 * with its total building count (click to count + map). Bottom: a SIMEX
 * scenario picker — pick a scenario to clip it to the selected tehsil, showing
 * the buildings-inside-scenario count with a show/hide toggle for the map.
 * All results are cached on the backend (disk) and memoised in localStorage.
 */
export default function TehsilBuildingsPanel({ province, district, districtGeometry, initialTehsil, onBuildingsGeoJSON, onScenarioClipGeoJSON }) {
  const [tehsils, setTehsils] = useState(null);   // [{ name, geometry }] | null while loading
  const [listError, setListError] = useState(null);
  const [counts, setCounts] = useState({});       // name → { status, count, key, progress }
  const [active, setActive] = useState(null);     // selected tehsil

  const [scenarios, setScenarios] = useState([]);
  const [selectedScenario, setSelectedScenario] = useState('');   // scenario id
  const [scenarioData, setScenarioData] = useState({});           // name → { status, count, key, progress }
  const [scenarioShown, setScenarioShown] = useState(false);      // scenario buildings on the map?
  const [clipShown, setClipShown] = useState(false);              // clipped scenario polygon on the map?

  const liveRef = useRef(true);
  const pollsRef = useRef({});
  const scenPollsRef = useRef({});

  const setCount = (name, patch) => setCounts((c) => ({ ...c, [name]: { ...(c[name] || {}), ...patch } }));
  const setScen = (name, patch) => setScenarioData((c) => ({ ...c, [name]: { ...(c[name] || {}), ...patch } }));

  const tehsilByName = (name) => tehsils?.find((t) => t.name === name) || null;

  // ── Load the district's tehsils, pre-filling any cached total counts ──
  useEffect(() => {
    liveRef.current = true;
    setTehsils(null);
    setListError(null);
    setCounts({});
    setActive(null);
    loadDistrictTehsils(province, { districtGeometry, districtName: district })
      .then((list) => {
        if (!liveRef.current) return;
        setTehsils(list);
        const cache = readCountCache();
        const seed = {};
        list.forEach((t) => {
          const k = tehsilCacheKey(province, district, t.name);
          if (cache[k] != null) seed[t.name] = { status: 'done', count: cache[k], cached: true, key: k };
        });
        setCounts(seed);
      })
      .catch((err) => { if (liveRef.current) setListError(err.message); });
    return () => {
      liveRef.current = false;
      Object.values(pollsRef.current).forEach(clearTimeout);
      Object.values(scenPollsRef.current).forEach(clearTimeout);
      pollsRef.current = {};
      scenPollsRef.current = {};
    };
  }, [province, district, districtGeometry]);

  useEffect(() => {
    loadScenarios().then((s) => liveRef.current && setScenarios(s)).catch(() => {});
  }, []);

  // ── Total buildings inside a tehsil (list row click) ────────────────
  const analyze = useCallback((tehsil, { force = false } = {}) => {
    const name = tehsil.name;
    setActive(name);
    // Showing a tehsil's total buildings takes over the overlays.
    setScenarioShown(false);
    setClipShown(false);
    onScenarioClipGeoJSON?.(null);

    const existing = counts[name];
    if (!force && existing?.status === 'done' && existing.key) {
      fetch(`/pyapi/buildings/tehsil/geojson?key=${encodeURIComponent(existing.key)}`)
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error('geojson error'))))
        .then((gj) => liveRef.current && onBuildingsGeoJSON?.(gj))
        .catch(() => {});
      return;
    }
    if (force) clearCount(tehsilCacheKey(province, district, name));

    if (pollsRef.current[name]) { clearTimeout(pollsRef.current[name]); delete pollsRef.current[name]; }
    setCount(name, { status: 'processing', progress: 5, count: null });

    const show = (key, result) => {
      fetch(`/pyapi/buildings/tehsil/geojson?key=${encodeURIComponent(key)}`)
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error('geojson error'))))
        .then((gj) => {
          if (!liveRef.current) return;
          onBuildingsGeoJSON?.(gj);
          setCount(name, { status: 'done', count: result?.count ?? null, key });
          if (result?.count != null) writeCount(key, result.count);
        })
        .catch(() => liveRef.current && setCount(name, { status: 'done', count: result?.count ?? null, key }));
    };

    fetch('/pyapi/buildings/tehsil', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ province, district, tehsil: name, geometry: tehsil.geometry, force }),
    })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`Server ${r.status}`))))
      .then((data) => {
        if (!liveRef.current) return;
        const key = data.key;
        if (data.status === 'done' && data.result) { show(key, data.result); return; }
        const poll = () => {
          fetch(`/pyapi/buildings/tehsil/status?key=${encodeURIComponent(key)}`)
            .then((r) => (r.ok ? r.json() : Promise.reject(new Error('poll error'))))
            .then((s) => {
              if (!liveRef.current) return;
              if (s.status === 'done' && s.result) show(key, s.result);
              else if (s.status === 'error') setCount(name, { status: 'error', error: s.error });
              else { setCount(name, { progress: s.progress || 0 }); pollsRef.current[name] = setTimeout(poll, 800); }
            })
            .catch((err) => liveRef.current && setCount(name, { status: 'error', error: err.message }));
        };
        pollsRef.current[name] = setTimeout(poll, 800);
      })
      .catch((err) => liveRef.current && setCount(name, { status: 'error', error: err.message }));
  }, [counts, province, district, onBuildingsGeoJSON, onScenarioClipGeoJSON]);

  // Auto-analyze the clicked tehsil once the list loads / when it changes.
  const lastAutoRef = useRef(null);
  useEffect(() => {
    if (!tehsils || !initialTehsil || lastAutoRef.current === initialTehsil) return;
    const match = tehsils.find((t) => t.name?.toLowerCase() === initialTehsil.toLowerCase());
    if (match) { lastAutoRef.current = initialTehsil; analyze(match); }
  }, [tehsils, initialTehsil, analyze]);

  // ── Buildings inside the selected scenario, clipped to a tehsil ──────
  const computeScenario = useCallback((tehsil, { force = false } = {}) => {
    if (!selectedScenario || !tehsil) return;
    const name = tehsil.name;
    if (!force && scenarioData[name]?.status === 'done') return; // already computed
    if (force) clearCount(exposureTehsilCacheKey(selectedScenario, province, district, name));
    if (scenPollsRef.current[name]) { clearTimeout(scenPollsRef.current[name]); delete scenPollsRef.current[name]; }
    setScen(name, { status: 'processing', progress: 5, count: null });

    const finish = (key, result) => {
      setScen(name, { status: 'done', count: result?.count ?? null, key });
      if (result?.count != null) writeCount(key, result.count);
    };
    const fail = (msg) => liveRef.current && setScen(name, { status: 'error', error: msg });

    // Fetch the scenario footprint (cached), then clip it to the tehsil.
    clipFor(selectedScenario)
      .then((clip) => fetch('/pyapi/simex/exposure-tehsil', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scenario_id: selectedScenario, province, district, tehsil: name, geometry: tehsil.geometry, clip, force }),
      }))
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`Server ${r.status}`))))
      .then((data) => {
        if (!liveRef.current) return;
        const key = data.key;
        if (data.status === 'done' && data.result) { finish(key, data.result); return; }
        const poll = () => {
          fetch(`/pyapi/simex/exposure-tehsil/status?key=${encodeURIComponent(key)}`)
            .then((r) => (r.ok ? r.json() : Promise.reject(new Error('poll error'))))
            .then((s) => {
              if (!liveRef.current) return;
              if (s.status === 'done' && s.result) finish(key, s.result);
              else if (s.status === 'error') fail(s.error);
              else { setScen(name, { progress: s.progress || 0 }); scenPollsRef.current[name] = setTimeout(poll, 800); }
            })
            .catch((err) => fail(err.message));
        };
        scenPollsRef.current[name] = setTimeout(poll, 800);
      })
      .catch((err) => fail(err.message));
  }, [selectedScenario, scenarioData, province, district]);

  // Reset + prefill scenario results when the scenario changes.
  useEffect(() => {
    setScenarioShown(false);
    setClipShown(false);
    onScenarioClipGeoJSON?.(null);
    if (!selectedScenario || !tehsils) { setScenarioData({}); return; }
    const cache = readCountCache();
    const seed = {};
    tehsils.forEach((t) => {
      const k = exposureTehsilCacheKey(selectedScenario, province, district, t.name);
      if (cache[k] != null) seed[t.name] = { status: 'done', count: cache[k], cached: true, key: k };
    });
    setScenarioData(seed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedScenario, tehsils, province, district]);

  // Compute the scenario clip for the active tehsil whenever either changes.
  useEffect(() => {
    if (!selectedScenario || !active) return;
    const act = tehsilByName(active);
    if (act) computeScenario(act);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, selectedScenario, tehsils]);

  const toggleScenarioBuildings = () => {
    const name = active;
    if (scenarioShown) { onBuildingsGeoJSON?.(null); setScenarioShown(false); return; }
    const sd = scenarioData[name];
    const act = tehsilByName(name);
    if (!sd || sd.status !== 'done' || !act) return;
    // POST first (regenerates a stale/missing GeoJSON), then load it.
    clipFor(selectedScenario)
      .then((clip) => fetch('/pyapi/simex/exposure-tehsil', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scenario_id: selectedScenario, province, district, tehsil: name, geometry: act.geometry, clip }),
      }))
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('scenario error'))))
      .then((data) => fetch(`/pyapi/simex/exposure-tehsil/geojson?key=${encodeURIComponent(data.key)}`))
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('geojson error'))))
      .then((gj) => { if (liveRef.current) { onBuildingsGeoJSON?.(gj); setScenarioShown(true); } })
      .catch(() => {});
  };

  const toggleScenarioClip = () => {
    const name = active;
    if (clipShown) { onScenarioClipGeoJSON?.(null); setClipShown(false); return; }
    const sd = scenarioData[name];
    const act = tehsilByName(name);
    if (!sd || sd.status !== 'done' || !act) return;
    clipFor(selectedScenario)
      .then((clip) => fetch('/pyapi/simex/exposure-tehsil', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scenario_id: selectedScenario, province, district, tehsil: name, geometry: act.geometry, clip }),
      }))
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('scenario error'))))
      .then((data) => fetch(`/pyapi/simex/exposure-tehsil/clip?key=${encodeURIComponent(data.key)}`))
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('clip error'))))
      .then((gj) => { if (liveRef.current) { onScenarioClipGeoJSON?.(gj); setClipShown(true); } })
      .catch(() => {});
  };

  const scen = active ? scenarioData[active] : null;

  // Gilgit-Baltistan only exposes the static file-based projections.
  const visibleScenarios = /gilgit/i.test(province || '')
    ? LOCAL_PROJECTIONS
    : scenarios;

  return (
    <div className="tb-body">
      <div className="tb-subhead">
        <span>Tehsils</span>
        {tehsils && <span className="tb-subhead-count">{tehsils.length}</span>}
      </div>

      <div className="tb-list">
        {tehsils == null && !listError && (
          <div className="tb-loading"><span className="tb-spin" /> Loading tehsils…</div>
        )}
        {listError && <div className="tb-error">Couldn’t load tehsils: {listError}</div>}
        {tehsils && tehsils.length === 0 && (
          <div className="tb-error">No tehsils found for this district.</div>
        )}

        {tehsils && tehsils.map((t) => {
          const c = counts[t.name] || {};
          const isActive = active === t.name;
          return (
            <button
              key={t.name}
              className={`tb-row${isActive ? ' tb-row--active' : ''}`}
              onClick={() => analyze(t)}
              title="Show buildings inside this tehsil"
            >
              <span className="tb-row-name">{t.name}</span>
              <span className="tb-row-right">
                {(c.status === 'done' || c.status === 'error') && (
                  <span
                    className="tb-refresh"
                    role="button"
                    title="Reprocess this tehsil"
                    onClick={(e) => { e.stopPropagation(); analyze(t, { force: true }); }}
                  >
                    <RefreshIcon />
                  </span>
                )}
                {c.status === 'processing' ? (
                  <span className="tb-row-processing"><span className="tb-spin" />{c.progress ? `${Math.round(c.progress)}%` : ''}</span>
                ) : c.status === 'error' ? (
                  <span className="tb-row-badge tb-row-badge--error" title={c.error}>failed</span>
                ) : c.status === 'done' ? (
                  <span className="tb-row-badge">{fmt(c.count)} buildings</span>
                ) : (
                  <span className="tb-row-cta">count ›</span>
                )}
              </span>
            </button>
          );
        })}
      </div>

      {/* ── SIMEX scenario clip ───────────────────────────────── */}
      <div className="tb-scenario">
        <div className="tb-scenario-head">Monsoon Projections 2026</div>
        <select
          className="tb-scenario-select"
          value={selectedScenario}
          onChange={(e) => setSelectedScenario(e.target.value)}
        >
          <option value="">Select a projection…</option>
          {visibleScenarios.map((s) => (
            <option key={s.id} value={s.id}>{s.label}</option>
          ))}
        </select>

        {selectedScenario && (
          !active ? (
            <div className="tb-scenario-hint">Select a tehsil above to see its buildings inside this projection.</div>
          ) : (
            <div className="tb-scenario-card">
              <div className="tb-scenario-info">
                <div className="tb-scenario-tehsil">
                  {active}
                  {scen?.status === 'done' && (
                    <span
                      className="tb-refresh"
                      role="button"
                      title="Reprocess this projection"
                      onClick={() => computeScenario(tehsilByName(active), { force: true })}
                    >
                      <RefreshIcon />
                    </span>
                  )}
                </div>
                <div className="tb-scenario-metric">
                  {scen?.status === 'processing' ? (
                    <span className="tb-row-processing"><span className="tb-spin" />{scen.progress ? `${Math.round(scen.progress)}%` : ''}</span>
                  ) : scen?.status === 'error' ? (
                    <span className="tb-row-badge tb-row-badge--error" title={scen.error}>failed</span>
                  ) : scen?.status === 'done' ? (
                    <><span className="tb-scenario-count">{fmt(scen.count)}</span> buildings in projection</>
                  ) : (
                    <span className="tb-row-processing"><span className="tb-spin" /></span>
                  )}
                </div>
              </div>
              <div className="tb-scenario-actions">
                <button
                  className={`tb-scenario-btn${scenarioShown ? ' tb-scenario-btn--active' : ''}`}
                  onClick={toggleScenarioBuildings}
                  disabled={scen?.status !== 'done'}
                >
                  {scenarioShown ? 'Hide' : 'Show'} buildings
                </button>
                <button
                  className={`tb-scenario-btn${clipShown ? ' tb-scenario-btn--active' : ''}`}
                  onClick={toggleScenarioClip}
                  disabled={scen?.status !== 'done'}
                >
                  {clipShown ? 'Hide' : 'Show'} projection
                </button>
              </div>
            </div>
          )
        )}
      </div>

      <div className="tb-foot">
        Click a tehsil to count &amp; map its buildings, or pick a monsoon
        projection to see the buildings inside it. Results are cached on the
        server and in your browser.
      </div>
    </div>
  );
}
