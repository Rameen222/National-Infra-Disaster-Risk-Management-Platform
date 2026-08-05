/**
 * Loader and fuzzy matcher for Nullahs_Desilting_104_ajk.csv.
 * Returns a structure of nullahs grouped by CSV district, plus a mapping
 * onto the canonical district list (e.g. AJK districts loaded from PDD).
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
        if (line[i] === '"' && (i + 1 >= len || line[i + 1] === ',')) {
          i += 2;
          break;
        }
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
  return text
    .split(/\r?\n/)
    .map(parseCsvLine)
    .filter((r) => r.length > 1 && r[0] !== '');
}

const normalize = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');

// Levenshtein distance (small strings, simple DP)
function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const m = a.length, n = b.length;
  const dp = new Array(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1]
        ? prev
        : 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  return dp[n];
}

function similarity(a, b) {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const dist = levenshtein(na, nb);
  const maxLen = Math.max(na.length, nb.length);
  return 1 - dist / maxLen;
}

/**
 * Fuzzy-match a CSV district name against a list of known district names.
 * Returns the best candidate name if its similarity is above the threshold,
 * else null.
 */
export function fuzzyMatchDistrict(csvName, knownNames, threshold = 0.78) {
  let best = null;
  let bestScore = 0;
  for (const k of knownNames) {
    const score = similarity(csvName, k);
    if (score > bestScore) {
      bestScore = score;
      best = k;
    }
  }
  return bestScore >= threshold ? best : null;
}

/**
 * Fetch and parse the Nullahs CSV.
 * Returns:
 *   {
 *     byDistrict: Map<csvDistrictName, {
 *       district: string,
 *       nullahs: [{ srNo, name, exposedFamilies }],
 *       exposedFamilies: number,    // de-duplicated value for the district
 *     }>,
 *     districts: string[],          // CSV district names in first-seen order
 *   }
 */
export async function loadNullahsCSV(url = '/Nullahs_Desilting_104_ajk.csv') {
  const text = await (await fetch(url)).text();
  const rows = csvRows(text);
  if (rows.length === 0) return { byDistrict: new Map(), districts: [] };
  // Skip header
  const byDistrict = new Map();
  const order = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const srNo = r[0];
    const district = r[1];
    const name = r[2];
    const exposed = Number(String(r[3] || '').replace(/,/g, '')) || 0;
    if (!district) continue;
    if (!byDistrict.has(district)) {
      byDistrict.set(district, { district, nullahs: [], exposedFamilies: exposed });
      order.push(district);
    }
    const entry = byDistrict.get(district);
    entry.nullahs.push({ srNo, name, exposedFamilies: exposed });
    // The CSV repeats the same exposed-families value for every nullah in a
    // district — capture it once (use the max in case of variation).
    if (exposed > entry.exposedFamilies) entry.exposedFamilies = exposed;
  }
  return { byDistrict, districts: order };
}

/**
 * Build a fuzzy mapping between CSV district names and a canonical name list.
 * Returns:
 *   {
 *     matched:    Map<canonicalName, csvDistrictName>,
 *     unmatched:  string[],   // csv district names that didn't resolve
 *   }
 */
export function matchNullahDistricts(csvDistricts, canonicalNames, threshold = 0.78) {
  const matched = new Map();
  const unmatched = [];
  const usedCsv = new Set();
  // First pass: exact normalized match
  for (const cName of canonicalNames) {
    const nC = normalize(cName);
    const hit = csvDistricts.find((d) => !usedCsv.has(d) && normalize(d) === nC);
    if (hit) {
      matched.set(cName, hit);
      usedCsv.add(hit);
    }
  }
  // Second pass: fuzzy for remaining canonical names
  const remainingCanonical = canonicalNames.filter((c) => !matched.has(c));
  const remainingCsv = csvDistricts.filter((d) => !usedCsv.has(d));
  for (const cName of remainingCanonical) {
    const hit = fuzzyMatchDistrict(cName, remainingCsv, threshold);
    if (hit) {
      matched.set(cName, hit);
      usedCsv.add(hit);
    }
  }
  // Anything in the CSV not assigned is unmatched
  for (const d of csvDistricts) {
    if (!usedCsv.has(d)) unmatched.push(d);
  }
  return { matched, unmatched };
}
