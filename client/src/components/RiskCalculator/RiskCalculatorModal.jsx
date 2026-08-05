import React, { useState, useEffect, useRef } from 'react';
import ReactDOM from 'react-dom';
import './RiskCalculatorModal.css';

/* ── district results cache (persists to localStorage) ──── */
const CACHE_KEY = 'rc_district_cache';
function _loadCache() {
  try { return JSON.parse(localStorage.getItem(CACHE_KEY)) || {}; } catch { return {}; }
}
function _saveToCache(district, result) {
  try {
    const cache = _loadCache();
    cache[district] = result;
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
  } catch { /* quota exceeded – ignore */ }
}
function _getFromCache(district) {
  return _loadCache()[district] || null;
}

const STRUCTURE_TYPES = [
  { key: 'brickMasonry', label: 'Brick Masonry', color: '#e57373', costPerSqft: 7000 },
  { key: 'blockMasonry', label: 'Block Masonry', color: '#ff8a65', costPerSqft: 6000 },
  { key: 'stoneMasonry', label: 'Stone Masonry', color: '#ffb74d', costPerSqft: 5000 },
  { key: 'timber',       label: 'Timber',        color: '#aed581', costPerSqft: 6000 },
  { key: 'adobe',        label: 'Adobe',         color: '#4dd0e1', costPerSqft: 2000 },
];

const VULNERABILITY_CLASSES = [
  { key: 'low',    label: 'Low',    color: '#66bb6a' },
  { key: 'medium', label: 'Medium', color: '#ffa726' },
  { key: 'high',   label: 'High',   color: '#ef5350' },
];

/* ── helpers ─────────────────────────────────────────────── */
function formatBytes(b) {
  if (!b) return '';
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
  return `${(b / (1024 * 1024)).toFixed(1)} MB`;
}

function formatPKR(n) {
  if (n == null) return '';
  if (n >= 1e9) return `PKR ${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `PKR ${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `PKR ${(n / 1e3).toFixed(0)}K`;
  return `PKR ${n.toLocaleString()}`;
}



// Calculate per-structure-type cost breakdown using housing distribution to proportion area/height
function calculateCostBreakdown(analysisResult, selectedZones, housing, totalStructures) {
  if (!analysisResult || !analysisResult.stats || !housing || !totalStructures) return {};
  const breakdown = {};
  const stats = analysisResult.stats;
  const counts = analysisResult.counts || {};
  const totalArea = selectedZones.reduce((sum, z) => sum + (stats[z]?.area || 0), 0);
  const totalHeight = selectedZones.reduce((sum, z) => sum + (stats[z]?.height || 0), 0);
  const totalZoneBuildings = selectedZones.reduce((sum, z) => sum + (counts[z] || 0), 0);

  for (const st of STRUCTURE_TYPES) {
    const stCount = housing[st.key] || 0;
    const proportion = totalStructures > 0 ? stCount / totalStructures : 0;
    const areaForType = totalArea * proportion;
    const heightForType = totalHeight * proportion;
    const stories = heightForType > 0 ? Math.max(1, Math.ceil(heightForType / 10)) : 0;
    const cost = areaForType * st.costPerSqft * stories;

    // Buildings per zone proportioned to this structure type
    const zoneBuildings = {};
    for (const z of selectedZones) {
      zoneBuildings[z] = Math.round((counts[z] || 0) * proportion);
    }
    const totalForType = Math.round(totalZoneBuildings * proportion);

    breakdown[st.key] = {
      stCount,
      totalStructures,
      area: areaForType,
      height: heightForType,
      stories,
      costPerSqft: st.costPerSqft,
      proportion,
      cost,
      zoneBuildings,
      totalForType,
      totalZoneArea: totalArea,
      totalZoneHeight: totalHeight,
    };
  }
  return breakdown;
}

const DEFAULT_LOCATION_FACTORS = {
  punjab:           1.0,
  kpk:              1.0,
  balochistan:      1.2,
  sindh:            1.1,
  'gilgit-baltistan': 1.0,
  ajk:              1.0,
};

const PROVINCE_LABELS = {
  punjab: 'Punjab', kpk: 'KP', balochistan: 'Balochistan',
  sindh: 'Sindh', 'gilgit-baltistan': 'Gilgit-Baltistan', ajk: 'AJK',
};

const FLOOD_VULN_CLASSES = ['A', 'B', 'C', 'D', 'E'];

/* Flood zones from GeoJSON (3 levels for building counts) */
const FLOOD_ZONE_LEVELS  = ['high', 'medium', 'low'];
const FLOOD_ZONE_LABELS  = { high: 'High', medium: 'Medium', low: 'Low' };
const FLOOD_ZONE_COLORS  = { high: '#ef5350', medium: '#ffa726', low: '#66bb6a' };

/* Damage severity levels (4 levels for damage factor matrix — separate from zones) */
const DAMAGE_SEVERITY_LEVELS  = ['very_high', 'high', 'medium', 'low'];
const DAMAGE_SEVERITY_LABELS  = { very_high: 'Very High', high: 'High', medium: 'Medium', low: 'Low' };
const DAMAGE_SEVERITY_COLORS  = { very_high: '#b71c1c', high: '#ef5350', medium: '#ffa726', low: '#66bb6a' };

const DEFAULT_STRUCT_VULN_CLASS = {
  brickMasonry: 'A',
  blockMasonry: 'A',
  stoneMasonry: 'C',
  timber:       'B',
  adobe:        'D',
};

const DEFAULT_DAMAGE_FACTORS = {
  very_high: { A: 0.80, B: 0.82, C: 0.88, D: 0.92, E: 0.95 },
  high:      { A: 0.55, B: 0.60, C: 0.70, D: 0.75, E: 0.80 },
  medium:    { A: 0.30, B: 0.40, C: 0.45, D: 0.55, E: 0.60 },
  low:       { A: 0.15, B: 0.20, C: 0.25, D: 0.30, E: 0.35 },
};

function cloneMatrix(m) {
  return Object.fromEntries(
    Object.entries(m).map(([k, v]) => [k, { ...v }])
  );
}

/* ── Scroll-triggered section wrapper ────────────────────── */
function InView({ children, className = '', delay = 0 }) {
  const ref = useRef(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) { setTimeout(() => setVisible(true), delay); obs.disconnect(); } },
      { threshold: 0.15 }
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [delay]);
  return <div ref={ref} className={`${className} rc-inview${visible ? ' rc-inview--visible' : ''}`}>{children}</div>;
}

/* ── Animated counter component ─────────────────────────── */
function AnimCount({ value, duration = 900 }) {
  const [display, setDisplay] = useState(0);
  const ref = useRef(null);
  const prevValue = useRef(value);
  const animating = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const end = typeof value === 'number' ? value : 0;

    const runAnim = (from) => {
      animating.current = true;
      const start = performance.now();
      const step = (now) => {
        const t = Math.min((now - start) / duration, 1);
        const ease = 1 - Math.pow(1 - t, 3);
        setDisplay(Math.round(from + ease * (end - from)));
        if (t < 1) requestAnimationFrame(step);
        else animating.current = false;
      };
      requestAnimationFrame(step);
    };

    // If value changed while already visible, animate from old to new
    if (prevValue.current !== value && animating.current === false) {
      runAnim(prevValue.current);
      prevValue.current = value;
      return;
    }
    prevValue.current = value;

    // First appearance: wait until in view
    const obs = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        obs.disconnect();
        runAnim(0);
      }
    }, { threshold: 0.1 });
    obs.observe(el);
    return () => obs.disconnect();
  }, [value, duration]);
  return <span ref={ref}>{display.toLocaleString()}</span>;
}

/* ── Main Component ──────────────────────────────────────── */

function RiskCalculatorModal({ district, districtData, province, onClose }) {
  const housing = districtData?.housing;
  const totalStructures = housing?.totalStructures || 0;

  /* ── flood zone threshold (radio): pick a level → includes that + all above ── */
  const [floodZoneThreshold, setFloodZoneThreshold] = useState('low'); // default = all
  // Derive which zones are active from the threshold (memoized to avoid re-renders)
  const selectedZones = React.useMemo(() => {
    return floodZoneThreshold === 'high'
      ? ['high']
      : floodZoneThreshold === 'medium'
      ? ['medium', 'high']
      : ['low', 'medium', 'high'];
  }, [floodZoneThreshold]);

  /* ── editable unit costs (computed from analysis when available) ── */
  const [unitCosts, setUnitCosts] = useState(Object.fromEntries(STRUCTURE_TYPES.map(st => [st.key, 0])));
  const updateCost = (key, value) => {
    const num = value === '' ? 0 : Number(value.replace(/[^0-9]/g, ''));
    setUnitCosts(prev => ({ ...prev, [key]: num }));
  };

  /* ── editable location factor ─────────────────────────── */
  const defaultLF = DEFAULT_LOCATION_FACTORS[province] ?? 1.0;
  const [locationFactor, setLocationFactor] = useState(defaultLF);
  useEffect(() => {
    setLocationFactor(DEFAULT_LOCATION_FACTORS[province] ?? 1.0);
  }, [province]);

  /* ── structure → flood vulnerability class mapping (fixed) */
  const structVulnClass = DEFAULT_STRUCT_VULN_CLASS;

  /* ── editable damage factor matrix ─────────────────────── */
  const [damageFactors, setDamageFactors] = useState(cloneMatrix(DEFAULT_DAMAGE_FACTORS));
  const [damageSeverity, setDamageSeverity] = useState('high');
  const updateDamageFactor = (risk, cls, value) => {
    if (value === '' || /^[01]?\.?\d*$/.test(value)) {
      setDamageFactors(prev => {
        const next = cloneMatrix(prev);
        next[risk][cls] = value;
        return next;
      });
    }
  };
  const blurDamageFactor = (risk, cls) => {
    setDamageFactors(prev => {
      const next = cloneMatrix(prev);
      const n = parseFloat(next[risk][cls]);
      next[risk][cls] = isNaN(n) ? DEFAULT_DAMAGE_FACTORS[risk][cls] : Math.min(1, Math.max(0, n));
      return next;
    });
  };

  /* ── editable resilience & debris percentages ──────────── */
  const [resiliencePct, setResiliencePct] = useState(10);
  const [debrisPct, setDebrisPct] = useState(5);

  /* ── Final DC reveal animation ─────────────────────────── */
  const [finalDCRevealed, setFinalDCRevealed] = useState(false);
  const prevDC1Ref = useRef(null);

  /* ── building download state ───────────────────────────── */
  const [dl, setDl] = useState({ status: 'idle', progress: 0, downloaded: 0, total: 0, error: null });
  const [refreshing, setRefreshing] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const pollRef = useRef(null);
  const prevDistrictRef = useRef(null);

  /* ── spatial analysis state ────────────────────────────── */
  const [analysis, setAnalysis] = useState({ status: 'idle', progress: 0, result: null, error: null });
  const analysisPollRef = useRef(null);

  // Compute per-structure breakdown (area, height, stories, cost) when analysis is ready
  const costBreakdown = React.useMemo(() => {
    if (analysis.status !== 'done' || !analysis.result) return {};
    return calculateCostBreakdown(analysis.result, selectedZones, housing, totalStructures);
  }, [analysis.status, analysis.result, selectedZones, housing, totalStructures]);

  // Sync unitCosts with the computed breakdown
  useEffect(() => {
    if (Object.keys(costBreakdown).length > 0) {
      const costs = Object.fromEntries(
        Object.entries(costBreakdown).map(([k, v]) => [k, Math.round(v.cost)])
      );
      setUnitCosts(costs);
    }
  }, [costBreakdown]);

  /* ── pipeline log steps ─────────────────────────────────── */
  const [pipelineSteps, setPipelineSteps] = useState([]);
  const addStep = (msg, status = 'running') => {
    setPipelineSteps(prev => {
      const exists = prev.find(s => s.msg === msg);
      if (exists) return prev.map(s => s.msg === msg ? { ...s, status } : s);
      return [...prev, { msg, status, ts: Date.now() }];
    });
  };
  const completeStep = (msg) => addStep(msg, 'done');

  /* Kick off spatial analysis once download completes */
  useEffect(() => {
    if (dl.status !== 'done' || !district) return;
    if (analysis.status === 'done' || analysis.status === 'processing') return;

    addStep('Intersecting flood susceptibility zones…');
    setAnalysis({ status: 'starting', progress: 0, result: null, error: null });

    fetch('/pyapi/buildings/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ district }),
    })
      .then(r => { if (!r.ok) throw new Error(`Server error ${r.status}`); return r.json(); })
      .then(data => {
        if (data.status === 'done') {
          completeStep('Intersecting flood susceptibility zones…');
          addStep('Stratifying vulnerability exposure…');
          setTimeout(() => {
            completeStep('Stratifying vulnerability exposure…');
            addStep('Synthesizing risk parameters…');
            setTimeout(() => {
              completeStep('Synthesizing risk parameters…');
              setAnalysis({ status: 'done', progress: 100, result: data.result, error: null });
              _saveToCache(district, data.result);
            }, 500);
          }, 400);
          return;
        }
        const poll = () => {
          fetch(`/pyapi/buildings/analyze/status?district=${encodeURIComponent(district)}`)
            .then(r => { if (!r.ok) throw new Error('poll error'); return r.json(); })
            .then(s => {
              setAnalysis({ status: s.status, progress: s.progress || 0, result: s.result || null, error: s.error || null });
              if (s.status === 'processing') {
                analysisPollRef.current = setTimeout(poll, 800);
              } else if (s.status === 'done') {
                completeStep('Intersecting flood susceptibility zones…');
                completeStep('Stratifying vulnerability exposure…');
                completeStep('Synthesizing risk parameters…');
                if (s.result) _saveToCache(district, s.result);
              }
            })
            .catch(() => {});
        };
        analysisPollRef.current = setTimeout(poll, 800);
      })
      .catch(err => {
        addStep('Spatial analysis failed', 'error');
        setAnalysis({ status: 'error', progress: 0, result: null, error: err.message });
      });

    return () => { if (analysisPollRef.current) clearTimeout(analysisPollRef.current); };
  }, [dl.status, district]);

  useEffect(() => {
    if (!district) return;
    const runKey = `${district}-${refreshKey}`;
    if (prevDistrictRef.current === runKey) return;
    prevDistrictRef.current = runKey;

    setPipelineSteps([]);
    setDl({ status: 'idle', progress: 0, downloaded: 0, total: 0, error: null });
    setAnalysis({ status: 'idle', progress: 0, result: null, error: null });

    /* Cache hit — show the loader briefly so it feels polished */
    const cached = _getFromCache(district);
    if (cached && cached.stats) {
      addStep('Rehydrating analysis from cache…');
      setDl({ status: 'starting', progress: 0, downloaded: 0, total: 0, error: null });
      setAnalysis({ status: 'starting', progress: 0, result: null, error: null });
      setTimeout(() => {
        completeStep('Rehydrating analysis from cache…');
        setDl({ status: 'done', progress: 100, downloaded: 0, total: 0, error: null });
        setAnalysis({ status: 'done', progress: 100, result: cached, error: null });
      }, 900);
      return;
    }

    addStep('Initializing geospatial pipeline…');
    setDl({ status: 'starting', progress: 0, downloaded: 0, total: 0, error: null });
    setAnalysis({ status: 'idle', progress: 0, result: null, error: null });

    fetch('/pyapi/buildings/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ district }),
    })
      .then(r => { if (!r.ok) throw new Error(`Server error ${r.status}`); return r.json(); })
      .then(data => {
        completeStep('Initializing geospatial pipeline…');
        if (data.status === 'done') {
          addStep('Streaming building inventory…');
          setTimeout(() => {
            completeStep('Streaming building inventory…');
            addStep('Decompressing vector geometry…');
            setTimeout(() => {
              completeStep('Decompressing vector geometry…');
              setDl({ status: 'done', progress: 100, downloaded: data.total || 0, total: data.total || 0, error: null });
            }, 400);
          }, 300);
          return;
        }
        addStep('Streaming building inventory…');
        const poll = () => {
          fetch(`/pyapi/buildings/status?district=${encodeURIComponent(district)}`)
            .then(r => { if (!r.ok) throw new Error('poll error'); return r.json(); })
            .then(s => {
              setDl({ status: s.status, progress: s.progress || 0, downloaded: s.downloaded || 0, total: s.total || 0, error: s.error || null });
              if (s.status === 'downloading') {
                pollRef.current = setTimeout(poll, 600);
              } else if (s.status === 'done') {
                completeStep('Streaming building inventory…');
                addStep('Decompressing vector geometry…');
                setTimeout(() => { completeStep('Decompressing vector geometry…'); }, 400);
              }
            })
            .catch(() => {});
        };
        pollRef.current = setTimeout(poll, 600);
      })
      .catch(err => {
        addStep('Pipeline initialisation failed', 'error');
        setDl({ status: 'error', progress: 0, downloaded: 0, total: 0, error: err.message });
      });

    return () => { if (pollRef.current) clearTimeout(pollRef.current); };
  }, [district, refreshKey]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (pollRef.current) clearTimeout(pollRef.current);
      if (analysisPollRef.current) clearTimeout(analysisPollRef.current);
    };
  }, []);

  /* ── Flood coverage check ───────────────────────────────── */
  const noFloodCoverage = React.useMemo(() => {
    if (!analysis.result) return false;
    const { counts } = analysis.result;
    const zoneTotal = (counts.low || 0) + (counts.medium || 0) + (counts.high || 0);
    return zoneTotal === 0 && (counts.unclassified || 0) > 0;
  }, [analysis.result]);

  /* ── DC-1 calculation ──────────────────────────────────── */
  const dc1 = React.useMemo(() => {
    if (!housing || totalStructures === 0 || !analysis.result) return null;
    if (noFloodCoverage) return null;
    if (selectedZones.length === 0) return null;
    const counts = analysis.result.counts;
    const lf = typeof locationFactor === 'number' && locationFactor > 0 ? locationFactor : 1;

    // Aggregate building count from selected flood zones
    const aggregatedZoneCount = selectedZones.reduce((sum, z) => sum + (counts[z] || 0), 0);

    // Selected damage severity row
    const severityRow = damageFactors[damageSeverity] || {};

    const rows = [];
    let grandTotal = 0;

    for (const st of STRUCTURE_TYPES) {
      const stCount = housing[st.key] || 0;
      if (stCount === 0) continue;
      const vulnCls = structVulnClass[st.key];

      // Step 2 cost is already total for this structure type (area × rate × stories × proportion)
      const cost = unitCosts[st.key] || 0;
      // × damage factor (from selected severity & structure's vuln class)
      const df = parseFloat(severityRow[vulnCls]) || 0;
      // × location factor
      const dc = cost * df * lf;

      grandTotal += dc;
      rows.push({
        key: st.key, label: st.label, color: st.color, vulnCls,
        cost, df, lf, dc,
      });
    }

    return { rows, grandTotal, aggregatedZoneCount };
  }, [housing, totalStructures, analysis.result, unitCosts, damageFactors, damageSeverity, structVulnClass, locationFactor, selectedZones]);

  /* ── Final DC (DC-1 + resilience + debris) ──────────────── */
  const resilienceCost = dc1 ? dc1.grandTotal * (resiliencePct / 100) : 0;
  const debrisCost     = dc1 ? dc1.grandTotal * (debrisPct / 100) : 0;
  const finalDC        = dc1 ? dc1.grandTotal + resilienceCost + debrisCost : 0;

  /* trigger reveal animation when dc1 first appears or changes */
  useEffect(() => {
    if (!dc1) { setFinalDCRevealed(false); prevDC1Ref.current = null; return; }
    if (prevDC1Ref.current !== dc1.grandTotal) {
      setFinalDCRevealed(false);
      const t = setTimeout(() => setFinalDCRevealed(true), 1200);
      prevDC1Ref.current = dc1.grandTotal;
      return () => clearTimeout(t);
    }
  }, [dc1]);

  const handleRefresh = async () => {
    if (!district || refreshing) return;
    if (pollRef.current) clearTimeout(pollRef.current);
    if (analysisPollRef.current) clearTimeout(analysisPollRef.current);
    setRefreshing(true);
    try {
      const cache = JSON.parse(localStorage.getItem(CACHE_KEY)) || {};
      delete cache[district];
      localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
    } catch { /* ignore */ }
    try {
      await fetch('/pyapi/buildings/cleanup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ district }),
      });
    } catch { /* ignore */ }
    setRefreshing(false);
    setRefreshKey(k => k + 1);
  };

  return ReactDOM.createPortal(
    <div className="rc-overlay" onClick={onClose}>
      <div className="rc-modal" onClick={e => e.stopPropagation()}>

        {/* ── Header ─────────────────────────────────── */}
        <div className="rc-header">
          <div className="rc-header-left">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
              <path d="M12 2L2 7l10 5 10-5-10-5z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round"/>
              <path d="M2 17l10 5 10-5M2 12l10 5 10-5" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round"/>
            </svg>
            Risk Calculator
          </div>
          <div className="rc-header-actions">
            {district && (
              <button
                className="rc-refresh-btn"
                onClick={handleRefresh}
                disabled={refreshing || dl.status === 'downloading' || dl.status === 'starting' || analysis.status === 'processing'}
                title="Re-download building data"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" style={{ transform: refreshing ? 'rotate(360deg)' : 'none', transition: refreshing ? 'transform 0.6s linear' : 'none' }}>
                  <path d="M23 4v6h-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                  <path d="M1 20v-6h6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                  <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
                Refresh
              </button>
            )}
            <button className="rc-close-btn" onClick={() => {
              if (district) {
                fetch('/pyapi/buildings/cleanup', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ district }),
                }).catch(() => {});
              }
              onClose();
            }}>✕</button>
          </div>
        </div>

        {/* ── Loading Overlay ──────────────────────────── */}
        {district && (dl.status === 'starting' || dl.status === 'downloading' || analysis.status === 'starting' || analysis.status === 'processing') && (
          <div className="rc-loading-overlay">
            <div className="rc-loading-content">
              <div className="rc-loading-spinner"></div>
              <div className="rc-loading-text">
                {dl.status === 'starting' && analysis.status !== 'starting' && analysis.status !== 'processing' && (
                  <div className="rc-loading-label">Initializing geospatial pipeline…</div>
                )}
                {dl.status === 'downloading' && (
                  <>
                    <div className="rc-loading-label">Streaming building inventory…</div>
                    <div className="rc-loading-progress">{Math.round(dl.progress)}%</div>
                  </>
                )}
                {analysis.status === 'starting' && dl.status !== 'downloading' && (
                  <div className="rc-loading-label">
                    {dl.status === 'done' ? 'Intersecting flood susceptibility zones…' : 'Rehydrating analysis from cache…'}
                  </div>
                )}
                {analysis.status === 'processing' && (
                  <>
                    <div className="rc-loading-label">Running spatial intelligence engine…</div>
                    <div className="rc-loading-progress">{Math.round(analysis.progress)}%</div>
                  </>
                )}
              </div>
            </div>
          </div>
        )}

        {/* ── Pipeline Log ──────────────────────────── */}
        {district && pipelineSteps.length > 0 && analysis.status === 'done' && (() => {
          const lastRunning = pipelineSteps.filter(s => s.status === 'running').slice(-1)[0];
          const allDone = pipelineSteps.every(s => s.status === 'done');
          const hasError = pipelineSteps.some(s => s.status === 'error');
          if (allDone && !hasError) return null;
          const step = hasError ? pipelineSteps.find(s => s.status === 'error') : lastRunning;
          if (!step) return null;
          return (
            <div className={`rc-pipeline rc-pipeline--${step.status}`}>
              <span className="rc-pipe-icon">
                {step.status === 'running' && <span className="rc-pipe-spinner" />}
                {step.status === 'error' && '✕'}
              </span>
              <span className="rc-pipe-msg">{step.msg}</span>
            </div>
          );
        })()}

        {/* ── District Info ──────────────────────────── */}
        {district ? (
          <>
            <InView className="rc-section">
              <div className="rc-section-title">
                District: {district}
                {totalStructures > 0 && (
                  <span
                    className="rc-total-badge"
                    title="Residential housing structures from the census (used for damage-cost math)"
                  >
                    <AnimCount value={totalStructures} /> from census
                  </span>
                )}
                {analysis?.result?.total_buildings > 0 && (
                  <span
                    className="rc-total-badge rc-total-badge--dataset"
                    title="All building polygons in the GeoServer buildings dataset (residential + non-residential)"
                  >
                    <AnimCount value={analysis.result.total_buildings} /> from buildings dataset
                  </span>
                )}
              </div>
            </InView>

            {/* ── Loading Message ────────────────────── */}
            {!housing && (
              <div className="rc-section rc-no-district">
                <span className="rc-no-district-text">Loading district data...</span>
              </div>
            )}

            {/* ── Structure Exposure ─────────────────── */}
            {housing && totalStructures > 0 ? (
              <InView className="rc-section" delay={80}>
                <div className="rc-section-title">Step 1 &mdash; Building Exposure by Structure Type</div>
                <div className="rc-dc1-formula">Total structures in the district grouped by type (Brick, Block, Stone, Timber, Adobe)</div>
                <div className="rc-struct-grid">
                  {STRUCTURE_TYPES.map(st => {
                    const count = housing[st.key] || 0;
                    if (count === 0) return null;
                    const pct = ((count / totalStructures) * 100).toFixed(1);
                    return (
                      <div key={st.key} className="rc-struct-card">
                        <div className="rc-struct-card-header">
                          <span className="rc-struct-dot" style={{ background: st.color }} />
                          <span className="rc-struct-card-label">{st.label}</span>
                        </div>
                        <div className="rc-struct-card-count"><AnimCount value={count} /></div>
                        <div className="rc-struct-bar-track">
                          <div className="rc-struct-bar-fill" style={{ width: `${pct}%`, background: st.color }} />
                        </div>
                        <div className="rc-struct-card-pct">{pct}%</div>
                      </div>
                    );
                  })}
                </div>
              </InView>
            ) : (
              <div className="rc-section rc-no-district">
                <span className="rc-no-district-text">No structure data available for this district</span>
              </div>
            )}

            {/* ── Location Factor ────────────────── */}
            <InView className="rc-section" delay={100}>
              <div className="rc-section-title">Step 2 &mdash; Location Factor</div>
              <div className="rc-dc1-formula">Province-wise cost multiplier reflecting local construction costs</div>
              <div className="rc-lf-row">
                <span className="rc-lf-province">{PROVINCE_LABELS[province] || province || '—'}</span>
                <div className="rc-cost-input-wrap rc-lf-input-wrap">
                  <input
                    type="text"
                    className="rc-cost-input rc-lf-input"
                    value={locationFactor}
                    onChange={e => {
                      const v = e.target.value;
                      if (v === '' || /^\d*\.?\d*$/.test(v)) setLocationFactor(v === '' ? '' : v);
                    }}
                    onBlur={() => {
                      const n = parseFloat(locationFactor);
                      setLocationFactor(isNaN(n) || n <= 0 ? defaultLF : n);
                    }}
                  />
                </div>
                {locationFactor !== defaultLF && (
                  <button className="rc-lf-reset" onClick={() => setLocationFactor(defaultLF)} title="Reset to default">↺</button>
                )}
              </div>
            </InView>

            {/* ── Structure → Flood Vulnerability Class ─ */}
            <InView className="rc-section" delay={100}>
              <div className="rc-section-title">Step 3 &mdash; Flood Vulnerability Class by Structure</div>
              <div className="rc-dc1-formula">Each structure type maps to a vulnerability class (A–E) based on its flood resistance</div>
              <div className="rc-df-legend-row">
                {STRUCTURE_TYPES.map(st => (
                  <div key={st.key} className="rc-df-legend-item">
                    <span className="rc-struct-dot" style={{ background: st.color }} />
                    <span className="rc-df-legend-label">{st.label}</span>
                    <span className="rc-df-class-badge">{structVulnClass[st.key]}</span>
                  </div>
                ))}
              </div>
            </InView>

            {/* ── Damage Factors Matrix ──────────────── */}
            <InView className="rc-section" delay={100}>
              <div className="rc-section-title">Step 4 &mdash; Damage Factors for Floods</div>
              <div className="rc-dc1-formula">Fraction of damage by severity level and vulnerability class (A–E) — independent of flood zones</div>
              <div className="rc-table-wrap">
                <table className="rc-table rc-df-table">
                  <thead>
                    <tr>
                      <th className="rc-th-left">Severity</th>
                      {FLOOD_VULN_CLASSES.map(c => (
                        <th key={c} className="rc-th-zone">{c}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {DAMAGE_SEVERITY_LEVELS.map(risk => (
                      <tr key={risk} className={damageSeverity === risk ? 'rc-df-row-active' : ''}>
                        <td>
                          <span className="rc-df-risk-label" style={{ color: DAMAGE_SEVERITY_COLORS[risk] }}>
                            {DAMAGE_SEVERITY_LABELS[risk]}
                          </span>
                        </td>
                        {FLOOD_VULN_CLASSES.map(cls => (
                          <td key={cls} className="rc-td-center">
                            <input
                              type="text"
                              className="rc-df-cell-input"
                              value={damageFactors[risk][cls]}
                              onChange={e => updateDamageFactor(risk, cls, e.target.value)}
                              onBlur={() => blurDamageFactor(risk, cls)}
                            />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="rc-severity-selector">
                <span className="rc-severity-label">Apply Damage Severity:</span>
                <div className="rc-severity-options">
                  {DAMAGE_SEVERITY_LEVELS.map(s => (
                    <label key={s} className={`rc-severity-option${damageSeverity === s ? ' rc-severity-option--active' : ''}`}
                      style={{ '--sev-color': DAMAGE_SEVERITY_COLORS[s] }}>
                      <input type="radio" name="damageSeverity" value={s} checked={damageSeverity === s}
                        onChange={() => setDamageSeverity(s)} />
                      <span className="rc-severity-dot" style={{ background: DAMAGE_SEVERITY_COLORS[s] }} />
                      <span>{DAMAGE_SEVERITY_LABELS[s]}</span>
                    </label>
                  ))}
                </div>
              </div>
            </InView>

            {/* ── Vulnerability Class Selection ────── */}
            <InView className="rc-section" delay={100}>
              <div className="rc-section-title">Step 5 &mdash; Select Flood Risk Zone</div>
              <div className="rc-dc1-formula">
                {floodZoneThreshold === 'low'
                  ? 'Low → includes Low + Medium + High zone buildings'
                  : floodZoneThreshold === 'medium'
                  ? 'Medium → includes Medium + High zone buildings'
                  : 'High → includes High zone buildings only'}
              </div>
              <div className="rc-severity-selector">
                <span className="rc-severity-label">Minimum Zone:</span>
                <div className="rc-severity-options">
                  {VULNERABILITY_CLASSES.map(vc => (
                    <label key={vc.key} className={`rc-severity-option${floodZoneThreshold === vc.key ? ' rc-severity-option--active' : ''}`}
                      style={{ '--sev-color': vc.color }}>
                      <input type="radio" name="floodZoneThreshold" value={vc.key}
                        checked={floodZoneThreshold === vc.key}
                        onChange={() => setFloodZoneThreshold(vc.key)} />
                      <span className="rc-severity-dot" style={{ background: vc.color }} />
                      <span>{vc.label}</span>
                    </label>
                  ))}
                </div>
              </div>
            </InView>

            {/* ── Buildings per Flood Zone ────────── */}
            {analysis.status === 'done' && analysis.result && (
              <InView className="rc-section" delay={120}>
                <div className="rc-section-title">Step 6 &mdash; Buildings per Flood Risk Zone</div>

                {noFloodCoverage ? (
                  <div className="rc-no-district" style={{ padding: '18px 0', gap: 10, alignItems: 'flex-start' }}>
                    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0, marginTop: 2 }}>
                      <path d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"
                        stroke="#ffa726" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                    <div>
                      <div style={{ color: '#ffa726', fontWeight: 600, marginBottom: 4 }}>No Flood Susceptibility Coverage</div>
                      <div className="rc-no-district-text">
                        The flood susceptibility dataset does not cover this district.
                        Flood-zone cost calculations are available for Punjab, Sindh, KP, and Balochistan.
                      </div>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="rc-dc1-formula">
                      {floodZoneThreshold === 'low'
                        ? 'Low selected → includes Low + Medium + High zone buildings'
                        : floodZoneThreshold === 'medium'
                        ? 'Medium selected → includes Medium + High zone buildings'
                        : 'High selected → includes High zone buildings only'}
                    </div>
                    <div className="rc-vuln-grid">
                      {VULNERABILITY_CLASSES.filter(
                        vc => selectedZones.includes(vc.key)
                      ).map(vc => {
                        const count = analysis.result.counts[vc.key] || 0;
                        const total = analysis.result.total_buildings || 1;
                        const pct = ((count / total) * 100).toFixed(1);
                        const zoneStats = analysis.result.stats?.[vc.key];
                        const area = zoneStats?.area || 0;
                        const height = zoneStats?.height || 0;
                        return (
                          <div key={vc.key} className="rc-vuln-card" style={{ borderColor: vc.color }}>
                            <div className="rc-vuln-card-header">
                              <span className="rc-vuln-dot" style={{ background: vc.color }} />
                              <span className="rc-vuln-card-label">{vc.label}</span>
                            </div>
                            <div className="rc-vuln-card-count"><AnimCount value={count} /></div>
                            <div className="rc-struct-bar-track">
                              <div className="rc-struct-bar-fill" style={{ width: `${pct}%`, background: vc.color }} />
                            </div>
                            <div className="rc-vuln-card-pct">{pct}% of buildings</div>
                            {zoneStats && (
                              <div className="rc-vuln-card-stats">
                                <div>Area: {Math.round(area).toLocaleString()} sq ft</div>
                                <div>Total Height: {Math.round(height).toLocaleString()} m</div>
                              </div>
                            )}
                          </div>
                        );
                      })}
                      {selectedZones.length > 0 && (() => {
                        const aggCount = selectedZones.reduce((sum, z) => sum + (analysis.result.counts[z] || 0), 0);
                        const total = analysis.result.total_buildings || 1;
                        const pct = ((aggCount / total) * 100).toFixed(1);
                        const aggArea = selectedZones.reduce((sum, z) => sum + (analysis.result.stats?.[z]?.area || 0), 0);
                        const aggHeight = selectedZones.reduce((sum, z) => sum + (analysis.result.stats?.[z]?.height || 0), 0);
                        return (
                          <div className="rc-vuln-card rc-vuln-card--total" style={{ borderColor: '#1976d2' }}>
                            <div className="rc-vuln-card-header">
                              <span className="rc-vuln-dot" style={{ background: '#1976d2' }} />
                              <span className="rc-vuln-card-label">Total Selected</span>
                            </div>
                            <div className="rc-vuln-card-count"><AnimCount value={aggCount} /></div>
                            <div className="rc-struct-bar-track">
                              <div className="rc-struct-bar-fill" style={{ width: `${pct}%`, background: '#1976d2' }} />
                            </div>
                            <div className="rc-vuln-card-pct">{pct}% of buildings</div>
                            {analysis.result.stats && (
                              <div className="rc-vuln-card-stats">
                                <div>Total Area: {Math.round(aggArea).toLocaleString()} sq ft</div>
                                <div>Total Height: {Math.round(aggHeight).toLocaleString()} m</div>
                              </div>
                            )}
                          </div>
                        );
                      })()}
                      {analysis.result.counts.unclassified > 0 && (
                        <div className="rc-vuln-card rc-vuln-card--unclassified">
                          <div className="rc-vuln-card-header">
                            <span className="rc-vuln-dot" style={{ background: '#78909c' }} />
                            <span className="rc-vuln-card-label">Outside Zones</span>
                          </div>
                          <div className="rc-vuln-card-count"><AnimCount value={analysis.result.counts.unclassified} /></div>
                          <div className="rc-vuln-card-pct">
                            {((analysis.result.counts.unclassified / (analysis.result.total_buildings || 1)) * 100).toFixed(1)}%
                          </div>
                        </div>
                      )}
                    </div>
                    <div className="rc-vuln-total">
                      Total Buildings in District: <strong>{analysis.result.total_buildings.toLocaleString()}</strong>
                    </div>
                  </>
                )}
              </InView>
            )}

            {/* ── Step 7: Replacement Cost Rates Reference ── */}
            {dc1 && (
              <>
              <InView className="rc-section" delay={140}>
                <div className="rc-section-title">Step 7 &mdash; Replacement Cost per Sq Ft</div>
                <div className="rc-dc1-formula">Reference rates used to calculate the per-structure replacement cost in Step 8.</div>
                <div className="rc-rate-grid">
                  {STRUCTURE_TYPES.map(st => (
                    <div key={st.key} className="rc-rate-card">
                      <span className="rc-struct-dot" style={{ background: st.color }} />
                      <span className="rc-rate-label">{st.label}</span>
                      <span className="rc-rate-value">PKR {st.costPerSqft.toLocaleString()}<span className="rc-rate-unit">/sq ft</span></span>
                    </div>
                  ))}
                </div>
              </InView>

              {/* ── Step 8: Damage Cost (with DF + LF) ── */}
              <InView className="rc-section" delay={150}>
                <div className="rc-section-title">Step 8 &mdash; Damage Cost per Structure (DC-1)</div>
                <div className="rc-dc1-formula">Formula: <strong>Footprint × Cost/sq ft × Stories × Damage Factor × Location Factor</strong></div>
                {analysis.status === 'done' && analysis.result?.stats && (() => {
                  const totalBldgs = selectedZones.reduce((s, z) => s + (analysis.result.counts?.[z] || 0), 0);
                  const totalArea = selectedZones.reduce((s, z) => s + (analysis.result.stats?.[z]?.area || 0), 0);
                  const totalHeight = selectedZones.reduce((s, z) => s + (analysis.result.stats?.[z]?.height || 0), 0);
                  return (
                    <div className="rc-zone-summary">
                      <div className="rc-zone-summary-item">
                        <div className="rc-zone-summary-label">Buildings in Flood Zones</div>
                        <div className="rc-zone-summary-value"><AnimCount value={totalBldgs} /></div>
                      </div>
                      <div className="rc-zone-summary-item">
                        <div className="rc-zone-summary-label">Total Footprint</div>
                        <div className="rc-zone-summary-value"><AnimCount value={Math.round(totalArea)} /> <span className="rc-zone-summary-unit">sq ft</span></div>
                      </div>
                      <div className="rc-zone-summary-item">
                        <div className="rc-zone-summary-label">Total Height</div>
                        <div className="rc-zone-summary-value"><AnimCount value={Math.round(totalHeight)} /> <span className="rc-zone-summary-unit">m</span></div>
                      </div>
                    </div>
                  );
                })()}
                <div className="rc-cost-grid">
                  {dc1.rows.map(row => {
                    const bd = costBreakdown[row.key];
                    if (!bd) return null;
                    return (
                      <div key={row.key} className="rc-cost-row">
                        <div className="rc-cost-row-left">
                          <span className="rc-struct-dot" style={{ background: row.color }} />
                          <span className="rc-cost-label">{row.label}</span>
                          <span className="rc-df-class-badge rc-df-class-badge--sm">{row.vulnCls}</span>
                        </div>
                        <div className="rc-dc-row-result">
                          <span className="rc-dc-row-result-label">DC-1</span>
                          <span className="rc-dc-row-result-value">{formatPKR(row.dc)}</span>
                        </div>
                        {bd.area > 0 && (
                          <div className="rc-cost-breakdown">
                            <div className="rc-cost-line">
                              <span className="rc-cost-line-label">Share:</span>
                              <span>{bd.stCount.toLocaleString()} ÷ {bd.totalStructures.toLocaleString()}</span>
                              <span className="rc-cost-formula-op">=</span>
                              <span className="rc-cost-formula-result">{(bd.proportion * 100).toFixed(1)}%</span>
                            </div>
                            <div className="rc-cost-line">
                              <span className="rc-cost-line-label">Buildings in zones:</span>
                              {selectedZones.map(z => (
                                <span key={z} className="rc-zone-pill" style={{ borderColor: FLOOD_ZONE_COLORS[z] }}>
                                  <span className="rc-zone-pill-dot" style={{ background: FLOOD_ZONE_COLORS[z] }} />
                                  {FLOOD_ZONE_LABELS[z]}: {(bd.zoneBuildings[z] || 0).toLocaleString()}
                                </span>
                              ))}
                              <span className="rc-cost-formula-op">=</span>
                              <span className="rc-cost-formula-result">{bd.totalForType.toLocaleString()} total</span>
                            </div>
                            <div className="rc-cost-line">
                              <span className="rc-cost-line-label">Footprint:</span>
                              <span>{(bd.proportion * 100).toFixed(1)}% × {Math.round(bd.totalZoneArea).toLocaleString()} sq ft</span>
                              <span className="rc-cost-formula-op">=</span>
                              <span className="rc-cost-formula-result">{Math.round(bd.area).toLocaleString()} sq ft</span>
                            </div>
                            <div className="rc-cost-line">
                              <span className="rc-cost-line-label">Height:</span>
                              <span>{(bd.proportion * 100).toFixed(1)}% × {Math.round(bd.totalZoneHeight).toLocaleString()} m</span>
                              <span className="rc-cost-formula-op">=</span>
                              <span className="rc-cost-formula-result">{Math.round(bd.height).toLocaleString()} m → {bd.stories} {bd.stories === 1 ? 'story' : 'stories'}</span>
                            </div>
                            <div className="rc-cost-line">
                              <span className="rc-cost-line-label">Replacement:</span>
                              <span>{Math.round(bd.area).toLocaleString()} × PKR {bd.costPerSqft.toLocaleString()} × {bd.stories}</span>
                              <span className="rc-cost-formula-op">=</span>
                              <span className="rc-cost-formula-result">{formatPKR(bd.cost)}</span>
                            </div>
                            <div className="rc-cost-line">
                              <span className="rc-cost-line-label">× DF ({DAMAGE_SEVERITY_LABELS[damageSeverity]}/{row.vulnCls}):</span>
                              <span>{formatPKR(bd.cost)} × {row.df}</span>
                              <span className="rc-cost-formula-op">=</span>
                              <span className="rc-cost-formula-result">{formatPKR(bd.cost * row.df)}</span>
                            </div>
                            <div className="rc-cost-line">
                              <span className="rc-cost-line-label">× LF ({PROVINCE_LABELS[province] || province}):</span>
                              <span>{formatPKR(bd.cost * row.df)} × {row.lf}</span>
                              <span className="rc-cost-formula-op">=</span>
                              <span className="rc-cost-formula-result">{formatPKR(bd.cost * row.df * row.lf)}</span>
                            </div>
                            <div className="rc-cost-line rc-cost-line--final">
                              <span>DC-1 ({row.label})</span>
                              <span className="rc-cost-formula-op">=</span>
                              <span className="rc-cost-formula-result">{formatPKR(row.dc)}</span>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
                <div className="rc-dc1-grand-banner">
                  <span className="rc-dc1-grand-banner-label">Grand Total DC-1</span>
                  <span className="rc-dc1-grand-banner-value">{formatPKR(dc1.grandTotal)}</span>
                </div>
              </InView>

              {/* ── Step 9: Resilience Cost ───────────── */}
              <InView className="rc-section" delay={160}>
                <div className="rc-section-title">Step 9 &mdash; Resilience Cost for Reconstruction</div>
                <div className="rc-dc1-formula">
                  Resilience Cost = {resiliencePct}% of DC-1 = {formatPKR(dc1.grandTotal)} &times; {resiliencePct}%
                </div>
                <div className="rc-final-breakdown">
                  <div className="rc-final-row">
                    <span className="rc-final-row-label">Resilience %</span>
                    <div className="rc-final-row-right">
                      <div className="rc-cost-input-wrap rc-pct-input-wrap">
                        <input
                          type="text"
                          className="rc-cost-input rc-pct-input"
                          value={resiliencePct}
                          onChange={e => { const v = e.target.value; if (v === '' || /^\d{0,3}$/.test(v)) setResiliencePct(v === '' ? '' : v); }}
                          onBlur={() => { const n = parseInt(resiliencePct, 10); setResiliencePct(isNaN(n) || n < 0 ? 10 : Math.min(100, n)); }}
                        />
                        <span className="rc-cost-prefix">%</span>
                      </div>
                      <span className="rc-final-row-value">{formatPKR(resilienceCost)}</span>
                    </div>
                  </div>
                </div>
              </InView>

              {/* ── Step 10: Debris Removal Cost ─────── */}
              <InView className="rc-section" delay={170}>
                <div className="rc-section-title">Step 10 &mdash; Debris Removal Cost</div>
                <div className="rc-dc1-formula">
                  Debris Removal = {debrisPct}% of DC-1 = {formatPKR(dc1.grandTotal)} &times; {debrisPct}%
                </div>
                <div className="rc-final-breakdown">
                  <div className="rc-final-row">
                    <span className="rc-final-row-label">Debris %</span>
                    <div className="rc-final-row-right">
                      <div className="rc-cost-input-wrap rc-pct-input-wrap">
                        <input
                          type="text"
                          className="rc-cost-input rc-pct-input"
                          value={debrisPct}
                          onChange={e => { const v = e.target.value; if (v === '' || /^\d{0,3}$/.test(v)) setDebrisPct(v === '' ? '' : v); }}
                          onBlur={() => { const n = parseInt(debrisPct, 10); setDebrisPct(isNaN(n) || n < 0 ? 5 : Math.min(100, n)); }}
                        />
                        <span className="rc-cost-prefix">%</span>
                      </div>
                      <span className="rc-final-row-value">{formatPKR(debrisCost)}</span>
                    </div>
                  </div>
                </div>
              </InView>

              {/* ── Final DC card with animation ──── */}
              <InView className="rc-section" delay={180}>
                <div className="rc-section-title">Final Damage Cost</div>
                <div className="rc-dc1-formula">
                  Final DC = DC-1 + Resilience Cost + Debris Removal Cost
                </div>
                <div className={`rc-final-dc-card${finalDCRevealed ? ' rc-final-dc-card--revealed' : ''}`}>
                  {!finalDCRevealed ? (
                    <div className="rc-final-dc-loading">
                      <div className="rc-final-dc-spinner" />
                      <span>Calculating Final Damage Cost…</span>
                    </div>
                  ) : (
                    <>
                      <div className="rc-final-dc-label">Final Damage Cost (DC)</div>
                      <div className="rc-final-dc-value">{formatPKR(finalDC)}</div>
                      <div className="rc-final-dc-breakdown">
                        {formatPKR(dc1.grandTotal)} + {formatPKR(resilienceCost)} + {formatPKR(debrisCost)}
                      </div>
                    </>
                  )}
                </div>
              </InView>
              </>
            )}
          </>
        ) : (
          <div className="rc-section rc-no-district">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none">
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2z" stroke="currentColor" strokeWidth="1.5" fill="none" opacity="0.4"/>
              <path d="M12 8v5" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
              <circle cx="12" cy="16" r="1" fill="currentColor"/>
            </svg>
            <span className="rc-no-district-text">Please select a district first</span>
          </div>
        )}

      </div>
    </div>,
    document.body
  );
}

export default RiskCalculatorModal;
