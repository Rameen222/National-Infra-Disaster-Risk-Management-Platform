/**
 * Loader + fuzzy lookup for Pakistan_Tehsil_Housing_Data.csv — per-tehsil
 * construction-type (Pakka / Semi Pakka / Kacha) and structure-age counts plus
 * projected population. GeoServer tehsil names are clean ("Bagh"), while the
 * CSV names carry admin suffixes ("BAGH TEHSIL", "AWARAN SUB-DIVISION"), so the
 * matcher strips those suffixes and scopes by district before fuzzy matching.
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

const num = (v) => {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/[,"]/g, '').trim());
  return Number.isFinite(n) ? n : null;
};

const normalize = (s) =>
  String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');

// Strip administrative suffixes/prefixes so "AWARAN SUB-DIVISION" ≈ "Awaran".
const ADMIN_WORDS = /\b(sub division|subdivision|tehsil|tehsils|taluka|taluka|district|division|town committee|town|municipal committee|municipal corporation|municipal|cantonment|cantt|city|mc)\b/g;
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

// Fraction of `target`'s tokens that also appear in `cand` (directional).
// Lets a clean GeoServer name ("khar") match a CSV name that carries the
// district inline ("khar bajaur") — all target tokens are contained.
function containment(target, cand) {
  const tt = target.split(' ').filter(Boolean);
  if (!tt.length) return 0;
  const tc = new Set(cand.split(' ').filter(Boolean));
  let inter = 0;
  for (const t of tt) if (tc.has(t)) inter++;
  return inter / tt.length;
}

// Best match score of a GeoServer name against a CSV row, combining character
// similarity and token containment over both the full and district-stripped
// tehsil names.
function tehsilScore(target, row) {
  return Math.max(
    similarity(target, row.tehsilClean),
    similarity(target, row.tehsilCore),
    containment(target, row.tehsilClean),
    containment(target, row.tehsilCore),
  );
}

/**
 * Fetch + parse the tehsil housing CSV.
 * Returns { rows: [{ province, district, tehsil, tehsilClean, districtClean,
 *   population, pakka, semiPakka, kacha, builtLt7, built7to12, built12to22,
 *   built22to52, builtOver52 }] }
 */
export async function loadTehsilHousingCSV(url = '/schema/Pakistan_Tehsil_Housing_Data.csv') {
  const text = await (await fetch(url)).text();
  const rows = csvRows(text);
  if (rows.length === 0) return { rows: [] };

  const header = rows[0];
  const at = (name) => header.findIndex((h) => h.trim().toLowerCase() === name.toLowerCase());
  const idx = {
    province: at('Province'),
    district: at('District'),
    tehsil:   at('Tehsil'),
    pop:      at('Projected Population'),
    pakka:     at('Pakka'),
    semiPakka: at('Semi_Pakka'),
    kacha:     at('Kacha'),
    lt7:       at('Built_Less_Than_7_Years'),
    y7to12:    at('Built_7_to_12_Years'),
    y12to22:   at('Built_12_to_22_Years'),
    y22to52:   at('Built_22_to_52_Years'),
    over52:    at('Built_Over_52_Years'),
  };

  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const tehsil = idx.tehsil >= 0 ? r[idx.tehsil] : null;
    if (!tehsil) continue;
    const district = idx.district >= 0 ? r[idx.district] : '';
    const tehsilClean = cleanName(tehsil);
    const districtClean = cleanName(district);
    // Drop district-name tokens so "khar bajaur" → "khar" (falls back to the
    // full clean name if stripping would empty it, e.g. tehsil == district).
    const distTokens = new Set(districtClean.split(' ').filter(Boolean));
    const tehsilCore = tehsilClean.split(' ').filter((w) => w && !distTokens.has(w)).join(' ') || tehsilClean;
    out.push({
      province:     idx.province >= 0 ? r[idx.province] : '',
      district,
      tehsil,
      tehsilClean,
      tehsilCore,
      districtClean,
      population:   num(r[idx.pop]),
      pakka:        num(r[idx.pakka]),
      semiPakka:    num(r[idx.semiPakka]),
      kacha:        num(r[idx.kacha]),
      builtLt7:     num(r[idx.lt7]),
      built7to12:   num(r[idx.y7to12]),
      built12to22:  num(r[idx.y12to22]),
      built22to52:  num(r[idx.y22to52]),
      builtOver52:  num(r[idx.over52]),
    });
  }
  return { rows: out };
}

/**
 * Resolve the tehsil row for a clicked feature. Scopes candidates to the
 * matching district first (when a district name is given), then fuzzy-matches
 * the tehsil name. Falls back to a global tehsil-name match.
 */
export function findTehsil(index, tehsilName, districtName, threshold = 0.7) {
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
