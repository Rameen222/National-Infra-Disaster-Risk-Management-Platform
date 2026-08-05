import React from 'react';

const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const startOfWeek = (d) => addDays(startOfDay(d), -startOfDay(d).getDay());
const startOfMonth = (d) => new Date(d.getFullYear(), d.getMonth(), 1);
const endOfMonth = (d) => new Date(d.getFullYear(), d.getMonth() + 1, 0);
const startOfYear = (d) => new Date(d.getFullYear(), 0, 1);
const endOfYear = (d) => new Date(d.getFullYear(), 11, 31);
const sameDay = (a, b) => !!a && !!b && startOfDay(a).getTime() === startOfDay(b).getTime();
// Local date components, not toISOString() — that converts to UTC and
// shifts the displayed day by one in timezones ahead of UTC.
const toISO = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const fmt = (d) => d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });

function presets() {
  const today = startOfDay(new Date());
  const yesterday = addDays(today, -1);
  const lastMonthDate = new Date(today.getFullYear(), today.getMonth() - 1, 1);
  const lastYearDate = new Date(today.getFullYear() - 1, 0, 1);
  return [
    { label: 'Today', start: today, end: today },
    { label: 'Yesterday', start: yesterday, end: yesterday },
    { label: 'This week', start: startOfWeek(today), end: today },
    { label: 'Last week', start: addDays(startOfWeek(today), -7), end: addDays(startOfWeek(today), -1) },
    { label: 'This month', start: startOfMonth(today), end: today },
    { label: 'Last month', start: startOfMonth(lastMonthDate), end: endOfMonth(lastMonthDate) },
    { label: 'This year', start: startOfYear(today), end: today },
    { label: 'Last year', start: startOfYear(lastYearDate), end: endOfYear(lastYearDate) },
    { label: 'All time', start: null, end: null },
  ];
}

function buildMonthCells(year, month) {
  const startDow = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells = [];
  for (let i = 0; i < startDow; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(new Date(year, month, d));
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}

const WEEKDAY_LABELS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

function MonthGrid({ year, month, rangeStart, rangeEnd, onPick }) {
  const cells = buildMonthCells(year, month);
  const monthName = new Date(year, month, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  return (
    <div className="ir-cal-month">
      <div className="ir-cal-month-title">{monthName}</div>
      <div className="ir-cal-weekdays">
        {WEEKDAY_LABELS.map((w) => <span key={w}>{w}</span>)}
      </div>
      <div className="ir-cal-grid">
        {cells.map((d, i) => {
          if (!d) return <span key={i} className="ir-cal-cell ir-cal-cell--empty" />;
          const inRange = rangeStart && rangeEnd && d > rangeStart && d < rangeEnd;
          const isStart = sameDay(d, rangeStart);
          const isEnd = sameDay(d, rangeEnd);
          const cls = ['ir-cal-cell'];
          if (inRange) cls.push('ir-cal-cell--in-range');
          if (isStart || isEnd) cls.push('ir-cal-cell--edge');
          return (
            <button key={i} type="button" className={cls.join(' ')} onClick={() => onPick(d)}>
              {d.getDate()}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default function DateRangeFilter({ value, onChange }) {
  const [open, setOpen] = React.useState(false);
  const [viewDate, setViewDate] = React.useState(() => value?.start ? new Date(value.start) : new Date());
  const [rangeStart, setRangeStart] = React.useState(value?.start ? new Date(value.start) : null);
  const [rangeEnd, setRangeEnd] = React.useState(value?.end ? new Date(value.end) : null);
  const wrapRef = React.useRef(null);

  React.useEffect(() => {
    if (!open) return;
    const onClick = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  const openPopover = () => {
    setRangeStart(value?.start ? new Date(value.start) : null);
    setRangeEnd(value?.end ? new Date(value.end) : null);
    setViewDate(value?.start ? new Date(value.start) : new Date());
    setOpen(true);
  };

  const pickDay = (d) => {
    if (!rangeStart || (rangeStart && rangeEnd)) {
      setRangeStart(d);
      setRangeEnd(null);
    } else if (d < rangeStart) {
      setRangeEnd(rangeStart);
      setRangeStart(d);
    } else {
      setRangeEnd(d);
    }
  };

  const pickPreset = (p) => {
    setRangeStart(p.start);
    setRangeEnd(p.end);
    if (p.start) setViewDate(new Date(p.start));
  };

  const apply = () => {
    onChange(rangeStart ? { start: rangeStart, end: rangeEnd || rangeStart } : null);
    setOpen(false);
  };

  const year = viewDate.getFullYear();
  const month = viewDate.getMonth();
  const nextMonthDate = new Date(year, month + 1, 1);

  const label = value?.start
    ? (sameDay(value.start, value.end) ? fmt(value.start) : `${fmt(value.start)} – ${fmt(value.end)}`)
    : 'All time';

  return (
    <div className="ir-trigger-wrap" ref={wrapRef}>
      <button type="button" className={`ir-trigger${value?.start ? ' ir-trigger--active' : ''}`} onClick={openPopover}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
          <rect x="3" y="5" width="18" height="16" rx="2" stroke="currentColor" strokeWidth="1.6" />
          <path d="M3 9h18M8 3v4M16 3v4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
        {label}
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className="ir-trigger-chevron">
          <path d="M3 4.5l3 3 3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div className="ir-popover ir-popover--date">
          <div className="ir-date-presets">
            {presets().map((p) => (
              <button
                key={p.label}
                type="button"
                className="ir-date-preset"
                onClick={() => pickPreset(p)}
              >
                {p.label}
              </button>
            ))}
          </div>

          <div className="ir-date-cal">
            <div className="ir-cal-months">
              <MonthGrid year={year} month={month} rangeStart={rangeStart} rangeEnd={rangeEnd} onPick={pickDay} />
              <MonthGrid year={nextMonthDate.getFullYear()} month={nextMonthDate.getMonth()} rangeStart={rangeStart} rangeEnd={rangeEnd} onPick={pickDay} />
              <div className="ir-cal-nav">
                <button type="button" className="ir-cal-nav-btn" onClick={() => setViewDate(new Date(year, month - 1, 1))} title="Previous month">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M15 5l-7 7 7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
                </button>
                <button type="button" className="ir-cal-nav-btn" onClick={() => setViewDate(new Date(year, month + 1, 1))} title="Next month">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M9 5l7 7-7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
                </button>
              </div>
            </div>

            <div className="ir-date-footer">
              <div className="ir-date-field">{rangeStart ? toISO(rangeStart) : '—'}</div>
              <span className="ir-date-field-sep">–</span>
              <div className="ir-date-field">{rangeEnd ? toISO(rangeEnd) : rangeStart ? toISO(rangeStart) : '—'}</div>
              <div className="ir-date-actions">
                <button type="button" className="ir-date-btn ir-date-btn--cancel" onClick={() => setOpen(false)}>Cancel</button>
                <button type="button" className="ir-date-btn ir-date-btn--apply" onClick={apply}>Apply</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
