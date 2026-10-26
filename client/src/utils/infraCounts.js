import React from 'react';

// Facility counts (health facilities, schools, dams) and road / NHA highway
// length for Pakistan, a province, a district or a tehsil, from the GCOP
// GeoServer layers (pybackend/infra_counts.py).
//
// Schools / health facilities / dams are counted live by GeoServer every
// time; road km comes from the backend's one stored result. Pakistan,
// provinces and districts: GET /pyapi/infra/area. A tehsil sends its own
// outline: POST /pyapi/infra/counts.
//
// Every count is `number | null`; null means it couldn't be computed
// (GeoServer unreachable, road km not built yet), never zero.

const cache = new Map(); // scope key → Promise<counts>

function cached(key, load) {
  if (!cache.has(key)) {
    cache.set(key, load().catch((err) => { cache.delete(key); throw err; }));
  }
  return cache.get(key);
}

const json = (r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)));

function loadArea(level, name) {
  const q = new URLSearchParams({ level, ...(name ? { name } : {}) });
  return cached(`${level}|${name || ''}`, () => fetch(`/pyapi/infra/area?${q}`).then(json));
}

function loadTehsil(district, tehsil, geometry) {
  return cached(`tehsil|${district}|${tehsil}`, () => fetch('/pyapi/infra/counts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ geometry, district, tehsil }),
  }).then(json));
}

/**
 * @param {{ national?: boolean, province?: string, district?: string, tehsil?: string, tehsilGeometry?: object }} scope
 *   province = app label (e.g. 'KP'); the most specific level given wins.
 * @returns {{ status: 'idle'|'loading'|'done'|'error', counts: object|null }}
 */
export function useInfraCounts({ national, province, district, tehsil, tehsilGeometry }) {
  const [state, setState] = React.useState({ status: 'idle', counts: null });

  React.useEffect(() => {
    let live = true;
    let job;
    if (tehsil && tehsilGeometry) job = loadTehsil(district, tehsil, tehsilGeometry);
    else if (district) job = loadArea('district', district);
    else if (province) job = loadArea('province', province);
    else if (national) job = loadArea('national');
    else {
      setState({ status: 'idle', counts: null });
      return undefined;
    }
    setState({ status: 'loading', counts: null });
    job
      .then((counts) => live && setState({ status: counts ? 'done' : 'error', counts }))
      .catch(() => live && setState({ status: 'error', counts: null }));
    return () => { live = false; };
  }, [national, province, district, tehsil, tehsilGeometry]);

  return state;
}
