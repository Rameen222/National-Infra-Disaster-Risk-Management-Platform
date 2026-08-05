/**
 * Loader + fuzzy lookup for Pakistan_Tehsil_Hazard_Profile.csv — per-tehsil
 * prominent hazards and terrain/demography notes. Same matching approach as
 * tehsilData.js (GeoServer tehsil names are clean, e.g. "Bagh"; the CSV
 * carries admin suffixes, e.g. "BAGH TEHSIL", so suffixes are stripped and
 * lookups are scoped by district before fuzzy matching).
 */

function parseCsvLine(line) {
  const fields = [];
  let i = 0;
  const len = line.length;
  while (i < len) {
    if (line[i] === '"') {
      i++;
      let val = '';
      while (i < len) {
        if (line[i] === '"' && (i + 1 >= len || line[i + 1] === ',')) { i += 2; break; }
        val += line[i++];
      }
      fields.push(val.trim());
    } else {
      const j = line.indexOf(',', i);
      if (j === -1) { fields.push(line.slice(i).trim()); break; }
      fields.push(line.slice(i, j).trim());
      i = j + 1;
    }
  }
  return fields;
}

function csvRows(text) {
  return text.split(/\r?\n/).map(parseCsvLine).filter((r) => r.length > 1 && r[0] !== '');
}

const normalize = (s) =>
  String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');

const ADMIN_WORDS = /\b(sub division|subdivision|tehsil|tehsils|taluka|district|division|town committee|town|municipal committee|municipal corporation|municipal|cantonment|cantt|city|mc)\b/g;
const cleanName = (s) => normalize(s).replace(ADMIN_WORDS, ' ').replace(/\s+/g, ' ').trim();

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const n = b.length;
  const dp = new Array(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  return dp[n];
}

function similarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const maxLen = Math.max(a.length, b.length);
  return 1 - levenshtein(a, b) / maxLen;
}

function containment(target, cand) {
  const tt = target.split(' ').filter(Boolean);
  if (!tt.length) return 0;
  const tc = new Set(cand.split(' ').filter(Boolean));
  let inter = 0;
  for (const t of tt) if (tc.has(t)) inter++;
  return inter / tt.length;
}

function tehsilScore(target, row) {
  return Math.max(
    similarity(target, row.tehsilClean),
    similarity(target, row.tehsilCore),
    containment(target, row.tehsilClean),
    containment(target, row.tehsilCore),
  );
}

let _cache = null;

/**
 * Fetch + parse the tehsil hazard/terrain CSV. Cached in memory after the
 * first call (591 rows, loaded once, same pattern as loadTehsilHousingCSV).
 */
export async function loadTehsilHazardCSV(url = '/schema/Pakistan_Tehsil_Hazard_Profile.csv') {
  if (_cache) return _cache;
  const text = await (await fetch(url)).text();
  const rows = csvRows(text);
  if (rows.length === 0) return { rows: [] };

  const header = rows[0];
  const at = (name) => header.findIndex((h) => h.trim().toLowerCase() === name.toLowerCase());
  const idx = {
    province: at('Province'),
    district: at('District'),
    tehsil:   at('Tehsil'),
    hazards:  at('Prominent_Hazards'),
    terrain:  at('Terrain_and_Demography'),
  };

  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const tehsil = idx.tehsil >= 0 ? r[idx.tehsil] : null;
    if (!tehsil) continue;
    const district = idx.district >= 0 ? r[idx.district] : '';
    const tehsilClean = cleanName(tehsil);
    const districtClean = cleanName(district);
    const distTokens = new Set(districtClean.split(' ').filter(Boolean));
    const tehsilCore = tehsilClean.split(' ').filter((w) => w && !distTokens.has(w)).join(' ') || tehsilClean;
    out.push({
      province: idx.province >= 0 ? r[idx.province] : '',
      district,
      tehsil,
      tehsilClean,
      tehsilCore,
      districtClean,
      hazards: idx.hazards >= 0 ? (r[idx.hazards] || null) : null,
      terrain: idx.terrain >= 0 ? (r[idx.terrain] || null) : null,
    });
  }
  _cache = { rows: out };
  return _cache;
}

/**
 * Resolve the hazard/terrain row for a tehsil name, scoped to its district
 * when given. Same threshold/fallback behavior as findTehsil in tehsilData.js.
 */
export function findTehsilHazard(index, tehsilName, districtName, threshold = 0.7) {
  if (!index?.rows?.length || !tehsilName) return null;
  const target = cleanName(tehsilName);
  if (!target) return null;

  const pick = (pool) => {
    let best = null;
    let bestScore = 0;
    for (const r of pool) {
      const s = tehsilScore(target, r);
      if (s > bestScore) { bestScore = s; best = r; }
    }
    return bestScore >= threshold ? best : null;
  };

  if (districtName) {
    const dt = cleanName(districtName);
    const scoped = index.rows.filter((r) => similarity(r.districtClean, dt) >= 0.8);
    const hit = scoped.length ? pick(scoped) : null;
    if (hit) return hit;
  }
  return pick(index.rows);
}
