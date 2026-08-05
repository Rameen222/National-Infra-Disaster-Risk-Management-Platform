/**
 * Parses the Punjab districts data CSV and returns a Map
 * keyed by district name (lowercase, trimmed) → structured data object.
 *
 * CSV layout (0-indexed):
 *   Row 0  — blank (all commas)
 *   Row 1  — column headers (skipped)
 *   Rows 2+ — one district per row
 *
 *  DEMOGRAPHICS  cols 0–7
 *   0  District name
 *   1  "Population" literal   (ignored)
 *   2  Male
 *   3  Female
 *   4  Total population
 *   5  Area (sq km)
 *   6  Density / sq km
 *   7  Avg household size
 *   8  empty separator
 *
 *  HOUSING  cols 9–17
 *   9  District name repeat   (ignored)
 *  10  "Type of Structure" literal  (ignored)
 *  11  Brick Masonry %
 *  12  Block Masonry %
 *  13  Stone Masonry %
 *  14  Timber %
 *  15  Adobe %
 *  16  Total Structures (count)
 *  17  empty separator
 *
 *  HEALTH  cols 18–29
 *  18  District name repeat   (ignored)
 *  19  "Health Facilities in Punjab" literal  (ignored)
 *  20  Hospitals
 *  21  Dispensaries
 *  22  RHCs
 *  23  BHUs
 *  24  TB Clinics    (may be "-" → null)
 *  25  SHC           (may be "-" → null)
 *  26  MCH
 *  27  Trauma        (may be "-" → null)
 *  28  Total
 *  29  empty separator
 *
 *  ROADS  cols 30–35
 *  30  Zone/District label  (key for roadsMap — may differ from col 0)
 *  31  "Roads" literal      (ignored)
 *  32  National Highways (km)
 *  33  Motorway (km)
 *  34  Other Roads (km)
 *  35  Total (km)
 *
 * NOTE ON ROAD MATCHING
 *   The source CSV has a known Jhelum/Jhang row-swap in the road columns and
 *   abbreviated names (D.G. Khan, R.Y. Khan, T.T. Singh).  We fix this with a
 *   two-pass approach: pass 1 builds a roadsMap keyed by col 30; pass 2 assigns
 *   roads to districts via fuzzy matching on the col-30 label.
 */

/** RFC 4180-compliant CSV parser for a single line. */
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

/** Parse numeric value; treats empty string and "-" as null. */
const num = (s) => {
  if (s === undefined || s === null || s === '' || s === '-') return null;
  const n = parseFloat(String(s).replace(/,/g, '').trim());
  return isNaN(n) ? null : n;
};

/**
 * Find the best matching key in roadsMap for a given district name.
 * Resolution order:
 *   1. Exact match (case-insensitive)
 *   2. Prefix match on first 4 alphanumeric chars (handles "D.G. Khan" ↔ "Dera Ghazi…")
 *   3. Substring containment
 */
function matchRoadKey(districtName, roadsMap) {
  const dn = districtName.trim().toLowerCase();

  // 1. Exact
  for (const key of roadsMap.keys()) {
    if (key.toLowerCase() === dn) return key;
  }

  // 2. Prefix — strip dots/spaces/dashes, compare first 4 chars
  const strip = (s) => s.toLowerCase().replace(/[.\s-]/g, '');
  const dnS = strip(dn);
  for (const key of roadsMap.keys()) {
    const kS = strip(key);
    const len = Math.min(4, Math.min(dnS.length, kS.length));
    if (len >= 3 && dnS.slice(0, len) === kS.slice(0, len)) return key;
  }

  // 3. Substring
  for (const key of roadsMap.keys()) {
    const kl = key.toLowerCase();
    if (dn.includes(kl) || kl.includes(dn)) return key;
  }

  return null;
}

export async function loadPunjabData() {
  const resp = await fetch('/districts_wise_data/Punjab/data.csv');
  const text = await resp.text();

  // Parse every line into columns
  const rows = text.split('\n').map((line) => parseCSVLine(line));

  // Row 0 = blank, row 1 = header → data starts at index 2
  const dataRows = rows.slice(2).filter((r) => r[0] && r[0].trim() !== '');

  // ── Pass 1: build roadsMap keyed by col-30 zone label ──────────
  const roadsMap = new Map();
  for (const cols of dataRows) {
    const label = cols[30]?.trim();
    if (!label) continue;
    roadsMap.set(label, {
      nationalHighways: num(cols[32]),
      motorway:         num(cols[33]),
      otherRoads:       num(cols[34]),
      total:            num(cols[35]),
    });
  }

  // ── Pass 2: build district records ─────────────────────────────
  const districtMap = new Map();
  for (const cols of dataRows) {
    const name = cols[0].trim();

    const roadKey = matchRoadKey(name, roadsMap);
    const roads   = roadKey ? roadsMap.get(roadKey) : null;

    const record = {
      name,
      population: {
        male:      num(cols[2]),
        female:    num(cols[3]),
        total:     num(cols[4]),
        area:      num(cols[5]),
        density:   num(cols[6]),
        avgHHSize: num(cols[7]),
      },
      housing: {
        brickMasonry:    num(cols[11]),
        blockMasonry:    num(cols[12]),
        stoneMasonry:    num(cols[13]),
        timber:          num(cols[14]),
        adobe:           num(cols[15]),
        totalStructures: num(cols[16]),
      },
      // Punjab CSV has no education data
      education: {
        primary: null, middle: null, high: null,
        higherSecondary: null, interColleges: null, degreeColleges: null,
        pg: null, universities: null, management: null, technical: null,
      },
      health: {
        hospitals:    num(cols[20]),
        dispensaries: num(cols[21]),
        rhcs:         num(cols[22]),
        bhus:         num(cols[23]),
        tbClinics:    num(cols[24]),
        shc:          num(cols[25]),
        mch:          num(cols[26]),
        trauma:       num(cols[27]),
        total:        num(cols[28]),
      },
      roads,
    };

    districtMap.set(name.toLowerCase(), record);
  }

  return districtMap;
}
