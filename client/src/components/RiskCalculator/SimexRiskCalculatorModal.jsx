import React, { useState, useEffect, useRef } from 'react';
import ReactDOM from 'react-dom';
import './RiskCalculatorModal.css';
import './SimexRiskCalculatorModal.css';

/* ── constants ───────────────────────────────────────────── */
const STRUCTURE_TYPES = [
  { key: 'brickMasonry', label: 'Brick Masonry', color: '#e57373', costPerSqft: 7000 },
  { key: 'blockMasonry', label: 'Block Masonry', color: '#ff8a65', costPerSqft: 6000 },
  { key: 'stoneMasonry', label: 'Stone Masonry', color: '#ffb74d', costPerSqft: 5000 },
  { key: 'timber',       label: 'Timber',        color: '#aed581', costPerSqft: 6000 },
  { key: 'adobe',        label: 'Adobe',         color: '#4dd0e1', costPerSqft: 2000 },
];

// Pakistan national-average structure proportions used when census data is unavailable
const DEFAULT_PROPORTIONS = {
  brickMasonry: 0.40,
  blockMasonry: 0.15,
  stoneMasonry: 0.20,
  timber:       0.15,
  adobe:        0.10,
};

const SIMEX_SCENARIOS = [
  { key: 'worst',  label: 'Worst',  fraction: 0.60, severity: 'high',   color: '#ef4444', desc: '60% structures damaged' },
  { key: 'medium', label: 'Medium', fraction: 0.30, severity: 'medium', color: '#f97316', desc: '30% structures damaged' },
  { key: 'low',    label: 'Low',    fraction: 0.08, severity: 'low',    color: '#22c55e', desc: '<10% structures damaged' },
];

const FLOOD_VULN_CLASSES = ['A', 'B', 'C', 'D', 'E'];

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

const DEFAULT_LOCATION_FACTORS = {
  punjab: 1.0, kpk: 1.0, balochistan: 1.2, sindh: 1.1,
  'gilgit-baltistan': 1.0, ajk: 1.0,
};

const PROVINCE_LABELS = {
  punjab: 'Punjab', kpk: 'KP', balochistan: 'Balochistan',
  sindh: 'Sindh', 'gilgit-baltistan': 'Gilgit-Baltistan', ajk: 'AJK',
};

/* ── helpers ─────────────────────────────────────────────── */
function formatPKR(n) {
  if (n == null || isNaN(n)) return '—';
  if (n >= 1e9) return `PKR ${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `PKR ${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `PKR ${(n / 1e3).toFixed(0)}K`;
  return `PKR ${n.toLocaleString()}`;
}

function cloneMatrix(m) {
  return Object.fromEntries(Object.entries(m).map(([k, v]) => [k, { ...v }]));
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
      { threshold: 0.12 }
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [delay]);
  return <div ref={ref} className={`${className} rc-inview${visible ? ' rc-inview--visible' : ''}`}>{children}</div>;
}

/* ── Animated counter ───────────────────────────────────── */
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
    if (prevValue.current !== value && !animating.current) {
      runAnim(prevValue.current);
      prevValue.current = value;
      return;
    }
    prevValue.current = value;
    const obs = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) { obs.disconnect(); runAnim(0); }
    }, { threshold: 0.1 });
    obs.observe(el);
    return () => obs.disconnect();
  }, [value, duration]);

  return <span ref={ref}>{display.toLocaleString()}</span>;
}

/* ── Main component ─────────────────────────────────────── */
export default function SimexRiskCalculatorModal({
  scenarioId,
  scenarioLabel,   // e.g. "Ravi River (307)"
  district,        // display name with spaces
  buildingCount,   // total buildings in scenario for this district
  districtData,    // may be null if province not loaded
  province,        // province key, may be null
  onClose,
}) {
  const housing = districtData?.housing;
  const totalStructures = housing?.totalStructures || 0;

  /* ── selected SIMEX scenario ───────────────────────────── */
  const [scenarioKey, setScenarioKey] = useState('medium');
  const scenario = SIMEX_SCENARIOS.find(s => s.key === scenarioKey);

  /* ── average building parameters (editable) ─────────────── */
  const [avgFootprint, setAvgFootprint] = useState(750);   // sq ft per building
  const [avgStories, setAvgStories]     = useState(1.5);   // multiplier

  /* ── location factor ────────────────────────────────────── */
  const defaultLF = DEFAULT_LOCATION_FACTORS[province] ?? 1.0;
  const [locationFactor, setLocationFactor] = useState(defaultLF);
  useEffect(() => { setLocationFactor(DEFAULT_LOCATION_FACTORS[province] ?? 1.0); }, [province]);

  /* ── damage factor matrix ───────────────────────────────── */
  const [damageFactors, setDamageFactors] = useState(cloneMatrix(DEFAULT_DAMAGE_FACTORS));
  const structVulnClass = DEFAULT_STRUCT_VULN_CLASS;

  const updateDamageFactor = (sev, cls, value) => {
    if (value === '' || /^[01]?\.?\d*$/.test(value)) {
      setDamageFactors(prev => {
        const next = cloneMatrix(prev);
        next[sev][cls] = value;
        return next;
      });
    }
  };
  const blurDamageFactor = (sev, cls) => {
    setDamageFactors(prev => {
      const next = cloneMatrix(prev);
      const n = parseFloat(next[sev][cls]);
      next[sev][cls] = isNaN(n) ? DEFAULT_DAMAGE_FACTORS[sev][cls] : Math.min(1, Math.max(0, n));
      return next;
    });
  };

  /* ── resilience & debris ────────────────────────────────── */
  const [resiliencePct, setResiliencePct] = useState(10);
  const [debrisPct, setDebrisPct]         = useState(5);

  /* ── final reveal animation ────────────────────────────── */
  const [finalRevealed, setFinalRevealed] = useState(false);

  const prevGrandRef = useRef(null); // kept to avoid lint warnings on removal

  /* ── derived counts ─────────────────────────────────────── */
  const damagedCount = Math.round(buildingCount * scenario.fraction);

  /* ── proportions: from census if available, else defaults ── */
  const proportions = React.useMemo(() => {
    if (housing && totalStructures > 0) {
      return Object.fromEntries(
        STRUCTURE_TYPES.map(st => [st.key, (housing[st.key] || 0) / totalStructures])
      );
    }
    return DEFAULT_PROPORTIONS;
  }, [housing, totalStructures]);

  /* ── per-type cost breakdown ─────────────────────────────── */
  const costBreakdown = React.useMemo(() => {
    const severityRow = damageFactors[scenario.severity] || {};
    const lf = typeof locationFactor === 'number' && locationFactor > 0 ? locationFactor : 1;
    const stories = typeof avgStories === 'number' && avgStories > 0 ? avgStories : 1;
    const footprint = typeof avgFootprint === 'number' && avgFootprint > 0 ? avgFootprint : 750;

    return STRUCTURE_TYPES.map(st => {
      const proportion  = proportions[st.key] || 0;
      const countType   = Math.round(damagedCount * proportion);
      const area        = countType * footprint;                     // sq ft
      const replacement = area * st.costPerSqft * stories;
      const vulnCls     = structVulnClass[st.key];
      const df          = parseFloat(severityRow[vulnCls]) || 0;
      const dc          = replacement * df * lf;
      const censusCount = housing ? (housing[st.key] || 0) : Math.round(proportion * 10000);
      return { ...st, proportion, countType, area, stories, replacement, vulnCls, df, lf, dc, censusCount };
    }).filter(r => r.proportion > 0);
  }, [proportions, damagedCount, damageFactors, scenario.severity, locationFactor, avgStories, avgFootprint, housing]);

  const grandTotal = costBreakdown.reduce((s, r) => s + r.dc, 0);
  const resilienceCost = grandTotal * (resiliencePct / 100);
  const debrisCost     = grandTotal * (debrisPct / 100);
  const finalDC        = grandTotal + resilienceCost + debrisCost;

  /* ── reveal animation ───────────────────────────────────── */
  useEffect(() => {
    if (grandTotal === 0) { setFinalRevealed(false); prevGrandRef.current = null; return; }
    if (prevGrandRef.current !== grandTotal) {
      setFinalRevealed(false);
      const t = setTimeout(() => setFinalRevealed(true), 1000);
      prevGrandRef.current = grandTotal;
      return () => clearTimeout(t);
    }
  }, [grandTotal]);

  const scenarioColor = scenario.color;

  return ReactDOM.createPortal(
    <div className="rc-overlay" onClick={onClose}>
      <div className="rc-modal src-modal" onClick={e => e.stopPropagation()}>

        {/* ── Header ─────────────────────────────────────── */}
        <div className="rc-header src-header">
          <div className="rc-header-left">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
              <path d="M13 2L3 14h9l-1 8 9-12h-9l2-8z"
                    stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round"/>
            </svg>
            SIMEX Risk Calculator
          </div>
          <button className="rc-close-btn" onClick={onClose}>✕</button>
        </div>

        {/* ── Scenario + District banner ──────────────────── */}
        <div className="src-banner">
          <div className="src-banner-row">
            <span className="src-banner-label">Scenario</span>
            <span className="src-banner-val">{scenarioLabel || `Scenario ${scenarioId}`}</span>
          </div>
          <div className="src-banner-row">
            <span className="src-banner-label">District</span>
            <span className="src-banner-val">{district}</span>
          </div>
          <div className="src-banner-row">
            <span className="src-banner-label">Buildings in scenario</span>
            <span className="src-banner-val src-banner-count">{buildingCount.toLocaleString()}</span>
          </div>
          {!housing && (
            <div className="src-banner-note">
              Census housing data not loaded — using national-average structure proportions.
            </div>
          )}
        </div>

        {/* ── Step 1: Structure type exposure ─────────────── */}
        <InView className="rc-section" delay={0}>
          <div className="rc-section-title">Step 1 — Building Exposure by Structure Type</div>
          <div className="rc-dc1-formula">
            {housing && totalStructures > 0
              ? `${district} census: ${totalStructures.toLocaleString()} residential structures`
              : 'National-average proportions applied (load province data for census breakdown)'}
          </div>
          <div className="rc-struct-grid">
            {STRUCTURE_TYPES.map(st => {
              const pct = ((proportions[st.key] || 0) * 100).toFixed(1);
              const cnt = housing
                ? (housing[st.key] || 0)
                : Math.round((proportions[st.key] || 0) * (totalStructures || 10000));
              if (!proportions[st.key]) return null;
              return (
                <div key={st.key} className="rc-struct-card">
                  <div className="rc-struct-card-header">
                    <span className="rc-struct-dot" style={{ background: st.color }} />
                    <span className="rc-struct-card-label">{st.label}</span>
                  </div>
                  <div className="rc-struct-card-count">
                    {housing ? <AnimCount value={cnt} /> : pct + '%'}
                  </div>
                  <div className="rc-struct-bar-track">
                    <div className="rc-struct-bar-fill" style={{ width: `${pct}%`, background: st.color }} />
                  </div>
                  <div className="rc-struct-card-pct">{pct}%</div>
                </div>
              );
            })}
          </div>
        </InView>

        {/* ── Step 2: Location Factor ──────────────────────── */}
        <InView className="rc-section" delay={60}>
          <div className="rc-section-title">Step 2 — Location Factor</div>
          <div className="rc-dc1-formula">Province-wise cost multiplier reflecting local construction costs</div>
          <div className="rc-lf-row">
            <span className="rc-lf-province">{PROVINCE_LABELS[province] || province || 'Unknown province'}</span>
            <div className="rc-cost-input-wrap rc-lf-input-wrap">
              <input
                type="text"
                className="rc-cost-input rc-lf-input"
                value={locationFactor}
                onChange={e => { const v = e.target.value; if (v === '' || /^\d*\.?\d*$/.test(v)) setLocationFactor(v === '' ? '' : v); }}
                onBlur={() => { const n = parseFloat(locationFactor); setLocationFactor(isNaN(n) || n <= 0 ? defaultLF : n); }}
              />
            </div>
            {locationFactor !== defaultLF && (
              <button className="rc-lf-reset" onClick={() => setLocationFactor(defaultLF)} title="Reset to default">↺</button>
            )}
          </div>
        </InView>

        {/* ── Step 3: Flood Vulnerability Class ───────────── */}
        <InView className="rc-section" delay={80}>
          <div className="rc-section-title">Step 3 — Flood Vulnerability Class by Structure</div>
          <div className="rc-dc1-formula">Each structure type maps to a vulnerability class (A–E) based on flood resistance</div>
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

        {/* ── Step 4: Damage Factors Matrix ───────────────── */}
        <InView className="rc-section" delay={100}>
          <div className="rc-section-title">Step 4 — Damage Factors for Floods</div>
          <div className="rc-dc1-formula">Fraction of damage by severity and vulnerability class — the active row is determined by the SIMEX scenario in Step 5</div>
          <div className="rc-table-wrap">
            <table className="rc-table rc-df-table">
              <thead>
                <tr>
                  <th className="rc-th-left">Severity</th>
                  {FLOOD_VULN_CLASSES.map(c => <th key={c} className="rc-th-zone">{c}</th>)}
                </tr>
              </thead>
              <tbody>
                {['very_high', 'high', 'medium', 'low'].map(sev => (
                  <tr key={sev} className={scenario.severity === sev ? 'rc-df-row-active' : ''}>
                    <td>
                      <span className="rc-df-risk-label" style={{ color: { very_high: '#b71c1c', high: '#ef5350', medium: '#ffa726', low: '#66bb6a' }[sev] }}>
                        {{ very_high: 'Very High', high: 'High', medium: 'Medium', low: 'Low' }[sev]}
                      </span>
                    </td>
                    {FLOOD_VULN_CLASSES.map(cls => (
                      <td key={cls} className="rc-td-center">
                        <input
                          type="text"
                          className="rc-df-cell-input"
                          value={damageFactors[sev][cls]}
                          onChange={e => updateDamageFactor(sev, cls, e.target.value)}
                          onBlur={() => blurDamageFactor(sev, cls)}
                        />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </InView>

        {/* ── Step 5: SIMEX Scenario Selection ────────────── */}
        <InView className="rc-section" delay={120}>
          <div className="rc-section-title">Step 5 — Select SIMEX Damage Scenario</div>
          <div className="rc-dc1-formula">Choose the damage intensity for this scenario — determines the active damage factor row and the fraction of buildings that sustain damage</div>
          <div className="src-scenario-cards">
            {SIMEX_SCENARIOS.map(sc => (
              <label
                key={sc.key}
                className={`src-scenario-card${scenarioKey === sc.key ? ' src-scenario-card--active' : ''}`}
                style={{ '--sc-color': sc.color }}
              >
                <input
                  type="radio"
                  name="simexScenario"
                  value={sc.key}
                  checked={scenarioKey === sc.key}
                  onChange={() => setScenarioKey(sc.key)}
                />
                <div className="src-scenario-card__dot" style={{ background: sc.color }} />
                <div className="src-scenario-card__body">
                  <div className="src-scenario-card__label">{sc.label}</div>
                  <div className="src-scenario-card__desc">{sc.desc}</div>
                  <div className="src-scenario-card__sev">
                    Damage severity: <strong>{sc.severity === 'high' ? 'High' : sc.severity === 'medium' ? 'Medium' : 'Low'}</strong>
                  </div>
                </div>
                <div className="src-scenario-card__pct" style={{ color: sc.color }}>
                  {Math.round(sc.fraction * 100)}%
                </div>
              </label>
            ))}
          </div>
        </InView>

        {/* ── Step 6: Buildings in Scenario ───────────────── */}
        <InView className="rc-section" delay={140}>
          <div className="rc-section-title">Step 6 — Buildings in Scenario</div>
          <div className="rc-dc1-formula">
            Damaged buildings = {buildingCount.toLocaleString()} × {Math.round(scenario.fraction * 100)}% ({scenario.desc})
          </div>
          <div className="src-counts-grid">
            <div className="src-count-card src-count-card--total">
              <div className="src-count-card__label">Total in Scenario</div>
              <div className="src-count-card__val"><AnimCount value={buildingCount} /></div>
            </div>
            <div className="src-count-card" style={{ borderColor: scenarioColor }}>
              <div className="src-count-card__label">Damaged ({Math.round(scenario.fraction * 100)}%)</div>
              <div className="src-count-card__val" style={{ color: scenarioColor }}>
                <AnimCount value={damagedCount} />
              </div>
            </div>
            <div className="src-count-card src-count-card--safe">
              <div className="src-count-card__label">Unaffected</div>
              <div className="src-count-card__val">{(buildingCount - damagedCount).toLocaleString()}</div>
            </div>
          </div>
          <div className="src-bar-track">
            <div
              className="src-bar-fill"
              style={{ width: `${scenario.fraction * 100}%`, background: scenarioColor }}
            />
          </div>
          <div className="src-bar-labels">
            <span style={{ color: scenarioColor }}>Damaged: {Math.round(scenario.fraction * 100)}%</span>
            <span>Unaffected: {Math.round((1 - scenario.fraction) * 100)}%</span>
          </div>
        </InView>

        {/* ── Step 7: Average Building Parameters ─────────── */}
        <InView className="rc-section" delay={160}>
          <div className="rc-section-title">Step 7 — Average Building Parameters</div>
          <div className="rc-dc1-formula">Used to estimate total floor area since individual building footprints are not used in the cost formula here</div>
          <div className="src-params-grid">
            <div className="src-param-row">
              <span className="src-param-label">Avg footprint per building</span>
              <div className="rc-cost-input-wrap">
                <input
                  type="text"
                  className="rc-cost-input"
                  value={avgFootprint}
                  onChange={e => { const v = e.target.value.replace(/[^0-9]/g, ''); setAvgFootprint(v === '' ? '' : Number(v)); }}
                  onBlur={() => { const n = Number(avgFootprint); setAvgFootprint(isNaN(n) || n <= 0 ? 750 : n); }}
                />
              </div>
              <span className="src-param-unit">sq ft</span>
            </div>
            <div className="src-param-row">
              <span className="src-param-label">Avg stories (multiplier)</span>
              <div className="rc-cost-input-wrap">
                <input
                  type="text"
                  className="rc-cost-input"
                  value={avgStories}
                  onChange={e => { const v = e.target.value; if (v === '' || /^\d*\.?\d*$/.test(v)) setAvgStories(v === '' ? '' : v); }}
                  onBlur={() => { const n = parseFloat(avgStories); setAvgStories(isNaN(n) || n <= 0 ? 1.5 : n); }}
                />
              </div>
              <span className="src-param-unit">floors</span>
            </div>
          </div>
          <div className="src-param-note">
            Total floor area per type = Damaged buildings of type × {avgFootprint || 750} sq ft × {avgStories || 1.5} stories
          </div>
        </InView>

        {/* ── Step 8: Replacement Cost Rates ──────────────── */}
        <InView className="rc-section" delay={180}>
          <div className="rc-section-title">Step 8 — Replacement Cost per Sq Ft</div>
          <div className="rc-dc1-formula">Reference rates by structure type (PKR)</div>
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

        {/* ── Step 9: Damage Cost DC-1 ─────────────────────── */}
        <InView className="rc-section" delay={200}>
          <div className="rc-section-title">Step 9 — Damage Cost per Structure (DC-1)</div>
          <div className="rc-dc1-formula">
            Formula: <strong>Damaged buildings × Proportion × Avg footprint × Rate × Stories × Damage Factor × Location Factor</strong>
          </div>

          {/* summary chips */}
          <div className="rc-zone-summary">
            <div className="rc-zone-summary-item">
              <div className="rc-zone-summary-label">Total Damaged</div>
              <div className="rc-zone-summary-value"><AnimCount value={damagedCount} /></div>
            </div>
            <div className="rc-zone-summary-item">
              <div className="rc-zone-summary-label">Avg Footprint</div>
              <div className="rc-zone-summary-value">{(avgFootprint || 750).toLocaleString()} <span className="rc-zone-summary-unit">sq ft</span></div>
            </div>
            <div className="rc-zone-summary-item">
              <div className="rc-zone-summary-label">Avg Stories</div>
              <div className="rc-zone-summary-value">{avgStories || 1.5}</div>
            </div>
          </div>

          <div className="rc-cost-grid">
            {costBreakdown.map(row => (
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
                <div className="rc-cost-breakdown">
                  <div className="rc-cost-line">
                    <span className="rc-cost-line-label">Proportion:</span>
                    <span>{(row.proportion * 100).toFixed(1)}% → {row.countType.toLocaleString()} damaged buildings</span>
                  </div>
                  <div className="rc-cost-line">
                    <span className="rc-cost-line-label">Floor area:</span>
                    <span>{row.countType.toLocaleString()} × {(avgFootprint || 750).toLocaleString()} sq ft × {avgStories || 1.5} stories</span>
                    <span className="rc-cost-formula-op">=</span>
                    <span className="rc-cost-formula-result">{Math.round(row.area * (avgStories || 1.5)).toLocaleString()} sq ft total</span>
                  </div>
                  <div className="rc-cost-line">
                    <span className="rc-cost-line-label">Replacement:</span>
                    <span>{Math.round(row.area * (avgStories || 1.5)).toLocaleString()} × PKR {row.costPerSqft.toLocaleString()}</span>
                    <span className="rc-cost-formula-op">=</span>
                    <span className="rc-cost-formula-result">{formatPKR(row.replacement)}</span>
                  </div>
                  <div className="rc-cost-line">
                    <span className="rc-cost-line-label">× DF ({scenario.label}/{row.vulnCls}):</span>
                    <span>{formatPKR(row.replacement)} × {row.df}</span>
                    <span className="rc-cost-formula-op">=</span>
                    <span className="rc-cost-formula-result">{formatPKR(row.replacement * row.df)}</span>
                  </div>
                  <div className="rc-cost-line">
                    <span className="rc-cost-line-label">× LF ({PROVINCE_LABELS[province] || province || '—'}):</span>
                    <span>{formatPKR(row.replacement * row.df)} × {row.lf}</span>
                    <span className="rc-cost-formula-op">=</span>
                    <span className="rc-cost-formula-result">{formatPKR(row.dc)}</span>
                  </div>
                  <div className="rc-cost-line rc-cost-line--final">
                    <span>DC-1 ({row.label})</span>
                    <span className="rc-cost-formula-op">=</span>
                    <span className="rc-cost-formula-result">{formatPKR(row.dc)}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
          <div className="rc-dc1-grand-banner">
            <span className="rc-dc1-grand-banner-label">Grand Total DC-1</span>
            <span className="rc-dc1-grand-banner-value">{formatPKR(grandTotal)}</span>
          </div>
        </InView>

        {/* ── Step 10: Resilience Cost ─────────────────────── */}
        <InView className="rc-section" delay={220}>
          <div className="rc-section-title">Step 10 — Resilience Cost for Reconstruction</div>
          <div className="rc-dc1-formula">Resilience Cost = {resiliencePct}% of DC-1 = {formatPKR(grandTotal)} × {resiliencePct}%</div>
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

        {/* ── Step 11: Debris Cost ─────────────────────────── */}
        <InView className="rc-section" delay={240}>
          <div className="rc-section-title">Step 11 — Debris Removal Cost</div>
          <div className="rc-dc1-formula">Debris Removal = {debrisPct}% of DC-1 = {formatPKR(grandTotal)} × {debrisPct}%</div>
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

        {/* ── Final DC ─────────────────────────────────────── */}
        <InView className="rc-section" delay={260}>
          <div className="rc-section-title">Final Damage Cost</div>
          <div className="rc-dc1-formula">Final DC = DC-1 + Resilience Cost + Debris Removal Cost</div>
          <div className={`rc-final-dc-card${finalRevealed ? ' rc-final-dc-card--revealed' : ''}`}>
            {!finalRevealed ? (
              <div className="rc-final-dc-loading">
                <div className="rc-final-dc-spinner" />
                <span>Calculating Final Damage Cost…</span>
              </div>
            ) : (
              <>
                <div className="rc-final-dc-label">Final Damage Cost (DC) — {scenario.label} Scenario</div>
                <div className="rc-final-dc-value">{formatPKR(finalDC)}</div>
                <div className="rc-final-dc-breakdown">
                  {formatPKR(grandTotal)} + {formatPKR(resilienceCost)} + {formatPKR(debrisCost)}
                </div>
                <div className="src-final-meta">
                  {district} · {damagedCount.toLocaleString()} damaged buildings · {scenario.desc}
                </div>
              </>
            )}
          </div>
        </InView>

      </div>
    </div>,
    document.body
  );
}
