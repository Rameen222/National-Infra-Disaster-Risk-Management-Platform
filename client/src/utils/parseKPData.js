/**
 * Parses the KP districts data CSV and returns a Map
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
 *  14 Section header literal  (ignored)
 *  15 Primary schools
 *  16 Middle schools
 *  17 High schools
 *  18 Higher Secondary
 *  19 Degree Colleges
 *  20 PG
 *  21 Universities
 *  22 Management (colleges)
 *  23 Technical (institutes)
 *
 * No health or roads data exists in this CSV.
 * Housing values (cols 8–12) are already percentages — do not recalculate.
 */

/** RFC 4180-compliant single-line CSV parser (handles quoted fields). */
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

const num = (s) => {
  if (s === undefined || s === null || s === '') return null;
  const n = parseFloat(String(s).replace(/,/g, '').trim());
  return isNaN(n) ? null : n;
};

export async function loadKPData() {
  const resp = await fetch('/districts_wise_data/KP/data.csv');
  const text = await resp.text();
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);

  // Skip header row (index 0)
  const dataLines = lines.slice(1);

  const districtMap = new Map();

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
        primary:         num(cols[15]),
        middle:          num(cols[16]),
        high:            num(cols[17]),
        higherSecondary: num(cols[18]),
        interColleges:   null,           // not in KP CSV
        degreeColleges:  num(cols[19]),
        pg:              num(cols[20]),
        universities:    num(cols[21]),
        management:      num(cols[22]),
        technical:       num(cols[23]),
      },
      // KP CSV has no health or roads data
      health: {
        hospitals:    null,
        dispensaries: null,
        tbClinics:    null,
        rhcs:         null,
        bhus:         null,
        mch:          null,
        total:        null,
      },
      roads: null,
    };

    districtMap.set(districtName.toLowerCase().trim(), record);
  }

  return districtMap;
}
