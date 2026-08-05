/**
 * Loader + fuzzy lookup for Pakistan_Infrastructure_Cleaned.csv — per-district
 * construction-type (Pakka / Semi Pakka / Kacha) and structure-age counts for
 * every district of Pakistan. Matched to a selected district by name, with
 * fuzzy fallback so minor spelling differences still resolve.
 */
import { fuzzyMatchDistrict } from './nullahsData';

// Parse one CSV line, honouring quoted fields (values contain thousands commas).
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

// "402,895" / "4055" → number; blanks → null
const num = (v) => {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/[,"]/g, '').trim());
  return Number.isFinite(n) ? n : null;
};

/**
 * Fetch + parse the infrastructure CSV.
 * Returns { byDistrict: Map<districtName, row>, districts: string[] }
 * where row = { district, pakka, semiPakka, kacha,
 *               builtLt7, built7to12, built12to22, built22to52, builtOver52 }.
 */
export async function loadInfrastructureCSV(url = '/schema/Pakistan_Infrastructure_Cleaned.csv') {
  const text = await (await fetch(url)).text();
  const rows = csvRows(text);
  if (rows.length === 0) return { byDistrict: new Map(), districts: [] };

  const header = rows[0];
  const at = (name) => header.findIndex((h) => h.trim() === name);
  const idx = {
    district:  header.findIndex((h) => /^districts$/i.test(h.trim())),
    pakka:      at('Pakka'),
    semiPakka:  at('Semi_Pakka'),
    kacha:      at('Kacha'),
    lt7:        at('Built_Less_Than_7_Years'),
    y7to12:     at('Built_7_to_12_Years'),
    y12to22:    at('Built_12_to_22_Years'),
    y22to52:    at('Built_22_to_52_Years'),
    over52:     at('Built_Over_52_Years'),
  };

  const byDistrict = new Map();
  const districts = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const district = idx.district >= 0 ? r[idx.district] : null;
    if (!district) continue;
    if (byDistrict.has(district)) continue;
    byDistrict.set(district, {
      district,
      pakka:       num(r[idx.pakka]),
      semiPakka:   num(r[idx.semiPakka]),
      kacha:       num(r[idx.kacha]),
      builtLt7:    num(r[idx.lt7]),
      built7to12:  num(r[idx.y7to12]),
      built12to22: num(r[idx.y12to22]),
      built22to52: num(r[idx.y22to52]),
      builtOver52: num(r[idx.over52]),
    });
    districts.push(district);
  }
  return { byDistrict, districts };
}

/**
 * Resolve the infrastructure row for a district name (exact-normalised first,
 * then fuzzy). Returns the row or null.
 */
export function findInfrastructure(index, districtName, threshold = 0.78) {
  if (!index || !districtName) return null;
  const match = fuzzyMatchDistrict(districtName, index.districts, threshold);
  return match ? (index.byDistrict.get(match) || null) : null;
}
