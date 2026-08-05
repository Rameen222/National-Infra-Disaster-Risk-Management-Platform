/**
 * Parses the Balochistan district data CSV and returns a Map
 * keyed by district name (lowercase, trimmed) → structured data object.
 *
 * CSV column layout (0-indexed, confirmed from actual file header):
 *  0  District name
 *  1  "Population" literal  (ignored)
 *  2  Male
 *  3  Female
 *  4  Total population
 *  5  Area (sq km)
 *  6  Density / sq km
 *  7  Avg household size
 *  8  Brick Masonry %
 *  9  Block Masonry %
 *  10 Stone Masonry %
 *  11 Timber %
 *  12 Adobe %
 *  13 Total Structures (count)
 *  14 Primary schools
 *  15 Middle schools
 *  16 High schools
 *  17 Higher Secondary schools
 *  18 Inter Colleges
 *  19 Degree Colleges
 *  20 Hospitals
 *  21 Dispensaries
 *  22 TB Clinics
 *  23 RHCs
 *  24 BHUs
 *  25 MCH centres
 *  26 Total health facilities
 *  27 Road district label  (may differ from col 0; may be combined e.g. "Chagai/Nushki")
 *  28 "Road in Kilometers…" literal  (ignored)
 *  29 Black Top km
 *  30 Shingle km
 *
 * Housing values (cols 8–12) are already percentages in the CSV — do not recalculate.
 * Some districts have empty housing or road columns; those produce null values.
 */

const num = (s) => {
  if (s === undefined || s === null || s === '') return null;
  const n = parseFloat(String(s).replace(/,/g, '').trim());
  return isNaN(n) ? null : n;
};

/** RFC 4180-compliant single-line CSV parser (handles quoted fields with internal commas). */
function parseCSVLine(line) {
  const cols = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      cols.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  cols.push(current.trim());
  return cols;
}

export async function loadBalochistanData() {
  const resp = await fetch('/districts_wise_data/Balochistan/data.csv');
  const text = await resp.text();
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);

  // Skip header row (index 0)
  const dataLines = lines.slice(1);

  const districtMap = new Map(); // key: lowercase district name
  const roadsMap    = new Map(); // key: lowercase road-label (col 27)

  for (const line of dataLines) {
    const cols = parseCSVLine(line);
    if (cols.length < 5) continue;

    const districtName = cols[0].trim();
    if (!districtName) continue;

    const record = {
      name: districtName,
      population: {
        male:      num(cols[2]),
        female:    num(cols[3]),
        total:     num(cols[4]),
        area:      num(cols[5]),
        density:   num(cols[6]),
        avgHHSize: num(cols[7]),
      },
      housing: {
        brickMasonry:    num(cols[8]),
        blockMasonry:    num(cols[9]),
        stoneMasonry:    num(cols[10]),
        timber:          num(cols[11]),
        adobe:           num(cols[12]),
        totalStructures: num(cols[13]),
      },
      education: {
        primary:         num(cols[14]),
        middle:          num(cols[15]),
        high:            num(cols[16]),
        higherSecondary: num(cols[17]),
        interColleges:   num(cols[18]),
        degreeColleges:  num(cols[19]),
      },
      health: {
        hospitals:    num(cols[20]),
        dispensaries: num(cols[21]),
        tbClinics:    num(cols[22]),
        rhcs:         num(cols[23]),
        bhus:         num(cols[24]),
        mch:          num(cols[25]),
        total:        num(cols[26]),
      },
      roads: null, // filled in second pass
    };

    districtMap.set(districtName.toLowerCase(), record);

    // Collect road data keyed by the road-section district label (col 27).
    // In the original spreadsheet the demographics section and roads section
    // were independent columns aligned by row, so col 27 may name a different
    // district than col 0.  We build a separate roadsMap and fuzzy-match later.
    const roadLabel = cols[27] ? cols[27].trim() : '';
    if (roadLabel) {
      const blackTop = num(cols[29]);
      const shingle  = num(cols[30]);
      if (blackTop !== null || shingle !== null) {
        roadsMap.set(roadLabel.toLowerCase(), {
          label:    roadLabel,
          blackTop: blackTop ?? 0,
          shingle:  shingle  ?? 0,
        });
      }
    }
  }

  // Match road entries back to districts via substring containment.
  // Road labels may be combined ("Chagai/Nushki") → split on '/' and test each part.
  for (const [roadKey, roadData] of roadsMap) {
    const parts = roadKey.split('/').map((s) => s.trim());
    for (const [distKey, rec] of districtMap) {
      if (parts.some((p) => distKey.includes(p) || p.includes(distKey))) {
        if (!rec.roads) {
          rec.roads = { label: roadData.label, blackTop: roadData.blackTop, shingle: roadData.shingle };
        }
      }
    }
  }

  return districtMap;
}

// ── Levenshtein edit distance ─────────────────────────────────
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

// Normalise a name for matching: lowercase, strip punctuation/extra spaces
const normalise = (s) =>
  s.toLowerCase().trim()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Look up a district record by name using exact → substring → Levenshtein fuzzy.
 * @param {Map} dataMap  result of loadBalochistanData()
 * @param {string} districtName  name from GeoJSON / sidebar
 * @returns {object|null}
 */
export function findDistrict(dataMap, districtName) {
  if (!dataMap || !districtName) return null;
  const query = normalise(districtName);

  // 1. Exact match
  if (dataMap.has(query)) return dataMap.get(query);

  // Build normalised key list once
  const entries = Array.from(dataMap.entries()).map(([k, v]) => ({
    normKey: normalise(k), v,
  }));

  // 2. Exact match on normalised keys
  const exact = entries.find((e) => e.normKey === query);
  if (exact) return exact.v;

  // 3. Substring containment (query inside key or key inside query)
  const sub = entries.find(
    (e) => e.normKey.includes(query) || query.includes(e.normKey)
  );
  if (sub) return sub.v;

  // 4. Word-level partial overlap (any query word matches any key word)
  const qWords = query.split(' ');
  const wordMatch = entries.find((e) => {
    const kWords = e.normKey.split(' ');
    return qWords.some((qw) => kWords.some((kw) => qw === kw && qw.length > 2));
  });
  if (wordMatch) return wordMatch.v;

  // 5. Levenshtein – pick closest, threshold = 40% of query length
  const threshold = Math.max(2, Math.ceil(query.length * 0.4));
  let best = null, bestDist = Infinity;
  for (const { normKey, v } of entries) {
    const dist = levenshtein(query, normKey);
    if (dist < bestDist) { bestDist = dist; best = v; }
  }
  return bestDist <= threshold ? best : null;
}
