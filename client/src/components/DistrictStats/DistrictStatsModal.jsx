import React from 'react';
import ReactDOM from 'react-dom';
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer } from 'recharts';
import './DistrictStatsModal.css';

// ── helpers ───────────────────────────────────────────────────
const fmt = (n) => (n == null ? null : Number(n).toLocaleString());
const hasVal = (n) => n != null && n !== '' && Number(n) !== 0;

const PieTooltip = ({ active, payload }) => {
  if (!active || !payload?.length) return null;
  const p = payload[0];
  return (
    <div className="ds-tt" style={{ color: p.payload?.color || p.color }}>
      {p.name}: <b>{Number(p.value).toLocaleString()}{p.payload?.pct != null ? ` (${p.payload.pct}%)` : ''}</b>
    </div>
  );
};

function SecHead({ label, right, tone }) {
  return (
    <div className={`ds-sechead${tone ? ` ds-sechead--${tone}` : ''}`}>
      <span className="ds-sechead-label">{label}</span>
      {right && <span className="ds-sechead-right">{right}</span>}
    </div>
  );
}

function NoData({ message }) {
  return <div className="ds-no-data">{message || 'No data available for this district'}</div>;
}

// ── main component ────────────────────────────────────────────
// Docked presentation (not a popup): a right-hand panel for building/
// structure detail, and a bottom bar for demographic detail. Same data,
// same computations, same props as before — only where each piece renders
// has changed.
export default function DistrictStatsModal({ data, province, onClose, hasBuildingData, onToggleBuildings, buildingsActive, buildingsLoading, buildingsLabel = 'Buildings', buildingCount, buildingError, onOpenEncroachment, nullahsForDistrict, unmatchedNullahDistricts, infrastructure, unitKind = 'District', bodyOverride, tehsilsSection }) {
  const [expandedUnmatched, setExpandedUnmatched] = React.useState(null);
  // Reset the expanded unmatched-district whenever the panel switches district
  React.useEffect(() => { setExpandedUnmatched(null); }, [data?.name]);
  // The bottom-dock portal target lives inside MapContainer, a sibling
  // component — it only exists in the real DOM after the first commit, so
  // look it up in an effect rather than during render.
  const [bottomDockSlot, setBottomDockSlot] = React.useState(null);
  React.useEffect(() => {
    setBottomDockSlot(document.getElementById('ds-dock-bottom-slot'));
  }, []);
  if (!data) return null;
  const { name, population: pop } = data;
  const provinceBadge = province || 'Pakistan';

  const genderData = [
    { name: 'Male',   value: pop.male,   fill: '#4fc3f7' },
    { name: 'Female', value: pop.female, fill: '#f796b8' },
  ].filter((d) => hasVal(d.value));

  // Construction-type and structure-age breakdowns from the national
  // infrastructure CSV (matched to this district by name / fuzzy).
  const constructionRaw = (infrastructure ? [
    { label: 'Pakka',      value: infrastructure.pakka,     color: '#4fc3f7' },
    { label: 'Semi Pakka', value: infrastructure.semiPakka, color: '#ffb74d' },
    { label: 'Kacha',      value: infrastructure.kacha,     color: '#ef5350' },
  ] : []).filter((d) => d.value != null);
  const constructionTotal = constructionRaw.reduce((s, d) => s + d.value, 0);
  const constructionData = constructionRaw.map((d) => ({
    ...d,
    pct: constructionTotal > 0 ? +((d.value / constructionTotal) * 100).toFixed(1) : null,
  }));

  const builtRaw = (infrastructure ? [
    { label: '< 7 yrs',    value: infrastructure.builtLt7,    color: '#66bb6a' },
    { label: '7–12 yrs',   value: infrastructure.built7to12,  color: '#4fc3f7' },
    { label: '12–22 yrs',  value: infrastructure.built12to22, color: '#ffb74d' },
    { label: '22–52 yrs',  value: infrastructure.built22to52, color: '#ab47bc' },
    { label: '> 52 yrs',   value: infrastructure.builtOver52, color: '#ef5350' },
  ] : []).filter((d) => d.value != null);
  const builtTotal = builtRaw.reduce((s, d) => s + d.value, 0);
  const builtData = builtRaw.map((d) => ({
    ...d,
    pct: builtTotal > 0 ? +((d.value / builtTotal) * 100).toFixed(1) : null,
  }));

  const kpis = [
    { label: 'Area (km2)',  value: fmt(pop.area),     accent: '#66bb6a', show: hasVal(pop.area) },
    { label: 'Density/km2', value: pop.density   != null ? Number(pop.density).toFixed(2) : null, accent: '#ffb74d', show: hasVal(pop.density) },
    { label: 'Avg HH Size', value: pop.avgHHSize != null ? String(pop.avgHHSize) : null, accent: '#f796b8', show: hasVal(pop.avgHHSize) },
  ].filter((k) => k.show);

  const hasBuildingContent = constructionData.length > 0 || builtData.length > 0 ||
    !!nullahsForDistrict || (unmatchedNullahDistricts?.length > 0) || !!tehsilsSection || !!bodyOverride;
  const hasDemographicContent = hasVal(pop.total) || genderData.length > 0 || kpis.length > 0;

  return (
    <>
      {/* ── Right dock: building / structure detail ─────────────── */}
      <aside className="ds-dock-right">
        {/* No district/province name here — it's already shown highlighted
            on the map and in the second sidebar's header. The close button
            lives in this row only when the toolbar below isn't rendered —
            otherwise it joins the toolbar row so Buildings/Encroachment/Close
            all sit on one line instead of leaving an empty band above them. */}
        {(bodyOverride || !hasBuildingData) && (
          <div className="ds-ph ds-ph--minimal">
            <button className="ds-close" onClick={onClose} aria-label="Close">
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <path d="M1 1l12 12M13 1L1 13" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
              </svg>
            </button>
          </div>
        )}

        {!bodyOverride && hasBuildingData && (
          <div className="ds-toolbar">
            <button
              className={`ds-buildings-btn${buildingsActive ? ' ds-buildings-btn--active' : ''}`}
              onClick={onToggleBuildings}
              disabled={buildingsLoading && !buildingsActive}
              title={buildingsActive ? 'Hide Buildings' : 'Show Buildings'}
            >
              {buildingsLoading && !buildingsActive ? (
                <span className="ds-buildings-spinner" />
              ) : (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                  <rect x="3" y="10" width="18" height="11" rx="1" stroke="currentColor" strokeWidth="1.8"/>
                  <path d="M9 21V14h6v7" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round"/>
                  <path d="M3 10l9-7 9 7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              )}
              {buildingsLoading && !buildingsActive ? 'Loading…' : buildingsActive ? 'Hide' : buildingsLabel}
            </button>

            {buildingCount != null && (
              <span className="ds-building-count" title="Buildings inside this tehsil">
                {Number(buildingCount).toLocaleString()} buildings
              </span>
            )}
            {buildingError && (
              <span className="ds-building-count ds-building-count--error" title={buildingError}>
                Failed
              </span>
            )}

            {onOpenEncroachment && (
              <button
                className="ds-encroach-btn"
                onClick={onOpenEncroachment}
                title="Buildings in encroachment zone"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                  <path d="M3 17c2-2 4-2 6 0s4 2 6 0 4-2 6 0" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
                  <path d="M3 12c2-2 4-2 6 0s4 2 6 0 4-2 6 0" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" opacity="0.7"/>
                  <path d="M3 7c2-2 4-2 6 0s4 2 6 0 4-2 6 0" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" opacity="0.45"/>
                </svg>
                Encroachment
              </button>
            )}

            <button className="ds-close ds-close--inline" onClick={onClose} aria-label="Close">
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <path d="M1 1l12 12M13 1L1 13" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
              </svg>
            </button>
          </div>
        )}

        <div className="ds-scroll">

          {bodyOverride}

          {!bodyOverride && !hasBuildingContent && (
            <NoData message={`No building data available for this ${unitKind.toLowerCase()}`} />
          )}

          {/* Construction types (cards) */}
          {constructionData.length > 0 && (
            <section className="ds-sec-2">
              <SecHead label="CONSTRUCTION TYPES" right={`${fmt(constructionTotal)} houses`} tone="construction" />
              <div className="ds-infra-row">
                {constructionData.map((d) => (
                  <div key={d.label} className="ds-infra-card" style={{ '--ic': d.color }}>
                    <div className="ds-infra-val">{fmt(d.value)}</div>
                    {d.pct != null && <div className="ds-infra-pct">{d.pct}%</div>}
                    <div className="ds-infra-lbl">{d.label}</div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Age of structures (pie chart) */}
          {builtData.length > 0 && (
            <section className="ds-sec-3">
              <SecHead label="AGE OF STRUCTURES" right={`${fmt(builtTotal)} houses`} tone="age" />
              <div className="ds-chart-wrap">
                <ResponsiveContainer width="100%" height={230}>
                  <PieChart margin={{ top: 22, right: 70, bottom: 22, left: 70 }}>
                    <Pie
                      data={builtData}
                      dataKey="value"
                      nameKey="label"
                      cx="50%"
                      cy="50%"
                      innerRadius={44}
                      outerRadius={70}
                      paddingAngle={3}
                      stroke="none"
                      label={({ label, pct }) => `${label} ${pct}%`}
                      labelLine={{ stroke: 'rgba(255,255,255,0.25)', strokeWidth: 1 }}
                    >
                      {builtData.map((d, i) => <Cell key={i} fill={d.color} />)}
                    </Pie>
                    <Tooltip content={<PieTooltip />} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
            </section>
          )}

          {(nullahsForDistrict || (unmatchedNullahDistricts && unmatchedNullahDistricts.length > 0)) && (
            <section className="ds-sec-3 ds-nullahs">
              <SecHead
                label="DESILTING NULLAHS"
                right={nullahsForDistrict ? `${nullahsForDistrict.nullahs.length} nullahs · ${fmt(nullahsForDistrict.exposedFamilies)} families` : undefined}
              />
              {nullahsForDistrict ? (
                <div className="ds-nullah-table-wrap">
                  <table className="ds-nullah-table">
                    <thead>
                      <tr>
                        <th style={{ width: 32 }}>#</th>
                        <th>Nullah Name</th>
                        <th style={{ width: 90, textAlign: 'right' }}>Exposed Families</th>
                      </tr>
                    </thead>
                    <tbody>
                      {nullahsForDistrict.nullahs.map((nullah, idx) => (
                        <tr key={`${nullah.srNo}-${idx}`}>
                          <td className="ds-nullah-idx">{idx + 1}</td>
                          <td className="ds-nullah-name">{nullah.name}</td>
                          <td className="ds-nullah-fam">{fmt(nullah.exposedFamilies)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <NoData message="No nullah desilting data for this district" />
              )}

              {unmatchedNullahDistricts && unmatchedNullahDistricts.length > 0 && (
                <div className="ds-nullah-unmatched">
                  <div className="ds-subsec-label">
                    Unmatched Districts ({unmatchedNullahDistricts.length})
                  </div>
                  <div className="ds-unmatched-chips">
                    {unmatchedNullahDistricts.map((entry) => {
                      const active = expandedUnmatched === entry.district;
                      return (
                        <button
                          key={entry.district}
                          type="button"
                          className={`ds-unmatched-chip${active ? ' ds-unmatched-chip--active' : ''}`}
                          onClick={() => setExpandedUnmatched(active ? null : entry.district)}
                        >
                          <span className="ds-unmatched-name">{entry.district}</span>
                          <span className="ds-unmatched-count">{entry.nullahs.length}</span>
                        </button>
                      );
                    })}
                  </div>
                  {expandedUnmatched && (() => {
                    const entry = unmatchedNullahDistricts.find((u) => u.district === expandedUnmatched);
                    if (!entry) return null;
                    return (
                      <div className="ds-nullah-table-wrap ds-nullah-table-wrap--nested">
                        <div className="ds-unmatched-head">
                          <span className="ds-unmatched-head-name">{entry.district}</span>
                          <span className="ds-unmatched-head-meta">
                            {entry.nullahs.length} nullahs · {fmt(entry.exposedFamilies)} families
                          </span>
                        </div>
                        <table className="ds-nullah-table">
                          <thead>
                            <tr>
                              <th style={{ width: 32 }}>#</th>
                              <th>Nullah Name</th>
                              <th style={{ width: 90, textAlign: 'right' }}>Exposed Families</th>
                            </tr>
                          </thead>
                          <tbody>
                            {entry.nullahs.map((nullah, idx) => (
                              <tr key={`${nullah.srNo}-${idx}`}>
                                <td className="ds-nullah-idx">{idx + 1}</td>
                                <td className="ds-nullah-name">{nullah.name}</td>
                                <td className="ds-nullah-fam">{fmt(nullah.exposedFamilies)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    );
                  })()}
                </div>
              )}
            </section>
          )}

          {tehsilsSection}

        </div>
      </aside>

      {/* ── Bottom bar: demographic detail — only rendered when there is
          real demographic data for this district; never fabricated.
          Portaled into MapContainer's own box (see ds-dock-bottom-slot) so
          it spans exactly the map's width and can never be covered by or
          overlap either sidebar. ──────────────────────────────────────── */}
      {hasDemographicContent && bottomDockSlot && ReactDOM.createPortal(
        <div className="ds-dock-bottom">
          {/* District name is already shown highlighted on the map and in
              the second sidebar's header, so it isn't repeated here. */}
          <div className="ds-dock-bottom-cards">
            {genderData.length > 0 && (
              <div className="ds-gender-bars">
                {genderData.map((g) => {
                  const pct = pop.total ? (g.value / pop.total) * 100 : null;
                  return (
                    <div key={g.name} className="ds-gbar-row" style={{ '--gc': g.fill }}>
                      <div className="ds-gbar-top">
                        <span className="ds-gbar-name">{g.name}</span>
                        {pct != null && <span className="ds-gbar-pct">{Math.round(pct)}%</span>}
                      </div>
                      <div className="ds-gbar-track">
                        <div className="ds-gbar-fill" style={{ width: `${pct ?? 0}%` }} />
                      </div>
                      <div className="ds-gbar-value">{fmt(g.value)}</div>
                    </div>
                  );
                })}
              </div>
            )}
            {hasVal(pop.total) && (
              <div className="ds-pop-total" style={{ '--gc': '#4fc3f7' }}>
                <div className="ds-pop-total-lbl">Projected Population Total</div>
                <div className="ds-pop-total-val">{fmt(pop.total)}</div>
              </div>
            )}
            {kpis.map((k) => (
              <div key={k.label} className="ds-kpi" style={{ '--a': k.accent }}>
                <div className="ds-kpi-val">{k.value}</div>
                <div className="ds-kpi-lbl">{k.label}</div>
              </div>
            ))}
          </div>
        </div>,
        bottomDockSlot,
      )}
    </>
  );
}
