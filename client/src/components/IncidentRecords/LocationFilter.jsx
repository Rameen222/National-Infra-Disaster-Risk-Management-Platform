import React from 'react';
import { PROVINCE_OPTIONS, loadDistrictsForProvince } from './pakistanLocations';

// Province + District cascading filter. District only becomes selectable
// once a province is chosen — trying to jump straight to a district first
// surfaces an inline warning instead of a native alert() (less disruptive,
// same effect: it tells the user to pick a province first).
export default function LocationFilter({ province, district, onChange }) {
  const [open, setOpen] = React.useState(false);
  const [districts, setDistricts] = React.useState([]);
  const [loading, setLoading] = React.useState(false);
  const [warn, setWarn] = React.useState(false);
  const wrapRef = React.useRef(null);

  React.useEffect(() => {
    if (!open) return;
    const onClick = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  React.useEffect(() => {
    if (!province) { setDistricts([]); return; }
    let cancelled = false;
    setLoading(true);
    loadDistrictsForProvince(province).then((names) => {
      if (!cancelled) { setDistricts(names); setLoading(false); }
    });
    return () => { cancelled = true; };
  }, [province]);

  const pickProvince = (id) => {
    setWarn(false);
    onChange({ province: id, district: null });
  };

  const pickDistrict = (name) => {
    if (!province) { setWarn(true); return; }
    onChange({ province, district: name });
  };

  const clear = () => {
    setWarn(false);
    onChange({ province: null, district: null });
  };

  const provinceLabel = PROVINCE_OPTIONS.find((p) => p.id === province)?.name;
  const triggerLabel = district ? `${provinceLabel} · ${district}` : provinceLabel || 'All locations';

  return (
    <div className="ir-trigger-wrap" ref={wrapRef}>
      <button
        type="button"
        className={`ir-trigger${province ? ' ir-trigger--active' : ''}`}
        onClick={() => setOpen((v) => !v)}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
          <path d="M12 21s7-7.2 7-12a7 7 0 10-14 0c0 4.8 7 12 7 12z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
          <circle cx="12" cy="9" r="2.4" stroke="currentColor" strokeWidth="1.6" />
        </svg>
        {triggerLabel}
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className="ir-trigger-chevron">
          <path d="M3 4.5l3 3 3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div className="ir-popover ir-popover--location">
          <div className="ir-loc-section">
            <div className="ir-loc-section-head">Provinces</div>
            <div className="ir-loc-list">
              {PROVINCE_OPTIONS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className={`ir-loc-item${province === p.id ? ' ir-loc-item--active' : ''}`}
                  onClick={() => pickProvince(p.id)}
                >
                  {p.name}
                </button>
              ))}
            </div>
          </div>

          <div className="ir-loc-section">
            <div className="ir-loc-section-head">District</div>
            {!province ? (
              <div className="ir-loc-warning">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                  <path d="M12 9v4M12 17h.01" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                  <path d="M10.3 3.86L1.8 18a1.5 1.5 0 001.3 2.25h17.8a1.5 1.5 0 001.3-2.25L13.7 3.86a1.5 1.5 0 00-2.6 0z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
                </svg>
                {warn ? 'Select a province first — then its districts show up here.' : 'Select a province to see its districts.'}
              </div>
            ) : loading ? (
              <div className="ir-loc-loading">Loading districts…</div>
            ) : (
              <div className="ir-loc-list ir-loc-list--districts">
                {districts.map((d) => (
                  <button
                    key={d}
                    type="button"
                    className={`ir-loc-item${district === d ? ' ir-loc-item--active' : ''}`}
                    onClick={() => pickDistrict(d)}
                  >
                    {d}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="ir-loc-footer">
            <button type="button" className="ir-date-btn ir-date-btn--cancel" onClick={clear}>Clear</button>
            <button type="button" className="ir-date-btn ir-date-btn--apply" onClick={() => setOpen(false)}>Done</button>
          </div>
        </div>
      )}
    </div>
  );
}
