/**
 * Parsers for latest_data_districts CSV files.
 * Each loader returns a Map<districtName, districtRecord>.
 * All masonry percentages are converted to actual structure counts.
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
    .split('\n')
    .map(parseCsvLine)
    .filter((r) => r.length > 1 && r[0] !== '');
}

function n(v) {
  if (v == null || v === '' || v === '-') return null;
  const cleaned = String(v).replace(/,/g, '').replace(/%$/, '').trim();
  const val = parseFloat(cleaned);
  return isNaN(val) ? null : val;
}

function toCount(pct, total) {
  return pct != null && total ? Math.round((pct * total) / 100) : 0;
}

function sumNonNull(...vals) {
  let s = 0;
  for (const v of vals) s += v ?? 0;
  return s;
}

/* ─── Balochistan Data.csv ──────────────────────────────────────
   Cols: name, Population(label), Male, Female, Total, Area, DENSITY, AVR H.H SIZE,
         Brick%, Block%, Stone%, Timber%, Adobe%, Total Str,
         Primary, Middle, High, High Sec, Inter Clgs, Deg Clgs,
         Hospitals, Dispensaries, TB Clinics, RHCs, BHUs, MCH, Total(health),
         District(repeat), Road label, Black Top, Shingle */
export async function loadBalochistanDistricts() {
  const text = await (await fetch('/latest_data_districts/districts_wise_data/Balochistan/Data.csv')).text();
  const rows = csvRows(text);
  const map = new Map();
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const name = r[0];
    if (!name || r[1] !== 'Population') continue;
    const totalStr = n(r[13]);
    const ts = totalStr ?? 0;
    const brickPct = n(r[8]), blockPct = n(r[9]), stonePct = n(r[10]), timberPct = n(r[11]), adobePct = n(r[12]);
    const primary = n(r[14]), middle = n(r[15]), high = n(r[16]), higherSec = n(r[17]);
    const interClg = n(r[18]), degClg = n(r[19]);
    const hospitals = n(r[20]), dispensaries = n(r[21]), tbClinics = n(r[22]);
    const rhcs = n(r[23]), bhus = n(r[24]), mch = n(r[25]);
    const blackTop = n(r[29]), shingle = n(r[30]);

    map.set(name, {
      name,
      population: { total: n(r[4]), male: n(r[2]), female: n(r[3]), area: n(r[5]), density: n(r[6]), avgHHSize: n(r[7]) },
      housing: {
        totalStructures: totalStr,
        brickMasonry: toCount(brickPct, ts), blockMasonry: toCount(blockPct, ts),
        stoneMasonry: toCount(stonePct, ts), timber: toCount(timberPct, ts), adobe: toCount(adobePct, ts),
        brickPct, blockPct, stonePct, timberPct, adobePct,
      },
      education: {
        primary, middle, high, higherSecondary: higherSec,
        interColleges: interClg, degreeColleges: degClg,
        total: sumNonNull(primary, middle, high, higherSec, interClg, degClg),
      },
      health: {
        hospitals, dispensaries, tbClinics, rhcs, bhus, mch,
        total: n(r[26]) ?? sumNonNull(hospitals, dispensaries, tbClinics, rhcs, bhus, mch),
      },
      roads: {
        blackTop, shingle,
        total: sumNonNull(blackTop, shingle),
      },
    });
  }
  return map;
}

/* ─── KP data.csv ───────────────────────────────────────────────
   Cols: Districts, Population(label), Male, Female, Total, Area, DENSITY, AVR H.H SIZE,
         Brick%, Block%, Stone%, Timber%, Adobe%, Total Str,
         Primary, Middle, High, High Sec, Deg Clgs, PG, Unis, Mgt, Tech */
export async function loadKPDistricts() {
  const text = await (await fetch('/latest_data_districts/districts_wise_data/KP/data.csv')).text();
  const rows = csvRows(text);
  const map = new Map();
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const name = r[0];
    if (!name || r[1] !== 'Population') continue;
    const totalStr = n(r[13]);
    const ts = totalStr ?? 0;
    const brickPct = n(r[8]), blockPct = n(r[9]), stonePct = n(r[10]), timberPct = n(r[11]), adobePct = n(r[12]);
    const primary = n(r[14]), middle = n(r[15]), high = n(r[16]), higherSec = n(r[17]);
    const degClg = n(r[18]), pg = n(r[19]), unis = n(r[20]), mgt = n(r[21]), tech = n(r[22]);

    map.set(name, {
      name,
      population: { total: n(r[4]), male: n(r[2]), female: n(r[3]), area: n(r[5]), density: n(r[6]), avgHHSize: n(r[7]) },
      housing: {
        totalStructures: totalStr,
        brickMasonry: toCount(brickPct, ts), blockMasonry: toCount(blockPct, ts),
        stoneMasonry: toCount(stonePct, ts), timber: toCount(timberPct, ts), adobe: toCount(adobePct, ts),
        brickPct, blockPct, stonePct, timberPct, adobePct,
      },
      education: {
        primary, middle, high, higherSecondary: higherSec,
        degreeColleges: degClg, pg, universities: unis, management: mgt, technical: tech,
        total: sumNonNull(primary, middle, high, higherSec, degClg, pg, unis, mgt, tech),
      },
      health: null,
      roads: null,
    });
  }
  return map;
}

/* ─── Sindh data.csv ────────────────────────────────────────────
   Cols: name, Population(label), Male, Female, Total, Area, DENSITY, AVR H.H SIZE,
         Brick%, Block%, Stone%, Timber%, Adobe%, Total Str */
export async function loadSindhDistricts() {
  const text = await (await fetch('/latest_data_districts/districts_wise_data/Sindh/data.csv')).text();
  const rows = csvRows(text);
  const map = new Map();
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const name = r[0];
    if (!name || name === 'Sindh' || r[1] !== 'Population') continue;
    const totalStr = n(r[13]);
    const ts = totalStr ?? 0;
    const brickPct = n(r[8]), blockPct = n(r[9]), stonePct = n(r[10]), timberPct = n(r[11]), adobePct = n(r[12]);

    map.set(name, {
      name,
      population: { total: n(r[4]), male: n(r[2]), female: n(r[3]), area: n(r[5]), density: n(r[6]), avgHHSize: n(r[7]) },
      housing: {
        totalStructures: totalStr,
        brickMasonry: toCount(brickPct, ts), blockMasonry: toCount(blockPct, ts),
        stoneMasonry: toCount(stonePct, ts), timber: toCount(timberPct, ts), adobe: toCount(adobePct, ts),
        brickPct, blockPct, stonePct, timberPct, adobePct,
      },
      education: { total: 0 },
      health: null,
      roads: null,
    });
  }
  return map;
}

/* ─── Punjab data.csv ───────────────────────────────────────────
   Cols: Districts, Population(label), Male, Female, Total, Area, DENSITY, AVR H.H SIZE,
         Brick%, Block%, Stone%, Timber%, Adobe%, Total Str,
         Hospitals, Dispensaries, RHCs, BHUs, TB Clinics, SHC, MCH, Trauma, Total(health),
         National Highways, Motorway, Roads, Total(roads) */
export async function loadPunjabDistricts() {
  const text = await (await fetch('/latest_data_districts/districts_wise_data/Punjab/data.csv')).text();
  const rows = csvRows(text);
  const map = new Map();
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const name = r[0];
    if (!name || r[1] !== 'Population') continue;
    const totalStr = n(r[13]);
    const ts = totalStr ?? 0;
    const brickPct = n(r[8]), blockPct = n(r[9]), stonePct = n(r[10]), timberPct = n(r[11]), adobePct = n(r[12]);
    const hospitals = n(r[14]), dispensaries = n(r[15]), rhcs = n(r[16]), bhus = n(r[17]);
    const tbClinics = n(r[18]), shc = n(r[19]), mch = n(r[20]), trauma = n(r[21]);
    const natHwy = n(r[23]), motorway = n(r[24]), otherRoads = n(r[25]);

    map.set(name, {
      name,
      population: { total: n(r[4]), male: n(r[2]), female: n(r[3]), area: n(r[5]), density: n(r[6]), avgHHSize: n(r[7]) },
      housing: {
        totalStructures: totalStr,
        brickMasonry: toCount(brickPct, ts), blockMasonry: toCount(blockPct, ts),
        stoneMasonry: toCount(stonePct, ts), timber: toCount(timberPct, ts), adobe: toCount(adobePct, ts),
        brickPct, blockPct, stonePct, timberPct, adobePct,
      },
      education: { total: 0 },
      health: {
        hospitals, dispensaries, rhcs, bhus, tbClinics, shc, mch, trauma,
        total: n(r[22]) ?? sumNonNull(hospitals, dispensaries, rhcs, bhus, tbClinics, shc, mch, trauma),
      },
      roads: {
        nationalHighways: natHwy, motorway, otherRoads,
        total: n(r[26]) ?? sumNonNull(natHwy, motorway, otherRoads),
      },
    });
  }
  return map;
}

/* ─── AJK Data.csv ──────────────────────────────────────────────
   Cols: Distrcts, Male, Female, Total, Area, DENSITY, AVR H.H SIZE,
         Brick%, Block%, Stone%, Timber%, Adobe%, Total Str, No. of Household,
         National Highways, Motorway, Other Roads, Total(roads),
         Hospitals, Dispensaries, RHCs, BHUs, TB Clinics, SHC, MCH, Trauma, Total(health) */
export async function loadAJKDistricts() {
  const text = await (await fetch('/latest_data_districts/districts_wise_data/Azad Jammu Kashmir/Data.csv')).text();
  const rows = csvRows(text);
  const map = new Map();
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const name = r[0];
    if (!name) continue;
    const totalStr = n(r[12]);
    const ts = totalStr ?? 0;
    const brickPct = n(r[7]), blockPct = n(r[8]), stonePct = n(r[9]), timberPct = n(r[10]), adobePct = n(r[11]);
    const natHwy = n(r[14]), motorway = n(r[15]), otherRoads = n(r[16]);
    const hospitals = n(r[18]), dispensaries = n(r[19]), rhcs = n(r[20]);
    const bhus = n(r[21]), tbClinics = n(r[22]), shc = n(r[23]), mch = n(r[24]), trauma = n(r[25]);

    map.set(name, {
      name,
      population: { total: n(r[3]), male: n(r[1]), female: n(r[2]), area: n(r[4]), density: n(r[5]), avgHHSize: n(r[6]) },
      housing: {
        totalStructures: totalStr,
        brickMasonry: toCount(brickPct, ts), blockMasonry: toCount(blockPct, ts),
        stoneMasonry: toCount(stonePct, ts), timber: toCount(timberPct, ts), adobe: toCount(adobePct, ts),
        brickPct, blockPct, stonePct, timberPct, adobePct,
      },
      education: { total: 0 },
      health: {
        hospitals, dispensaries, rhcs, bhus, tbClinics, shc, mch, trauma,
        total: n(r[26]) ?? sumNonNull(hospitals, dispensaries, rhcs, bhus, tbClinics, shc, mch, trauma),
      },
      roads: {
        nationalHighways: natHwy, motorway, otherRoads,
        total: n(r[17]) ?? sumNonNull(natHwy, motorway, otherRoads),
      },
    });
  }
  return map;
}

/* ─── GB Districts.csv ──────────────────────────────────────────
   Cols: Districts, Male, Female, Total, Area, DENSITY, AVR H.H SIZE,
         Brick%, Block%, Stone%, Timber%, Adobe%, Total Str, No. of households,
         Hospitals, Dispensaries, RHCs, BHUs, TB Clinics, SHC, MCH, Trauma, Total(health),
         National Highways, Motorway, Other Roads, Total(roads) */
export async function loadGBDistricts() {
  const text = await (await fetch('/latest_data_districts/districts_wise_data/Gilgit Baltistan/GB Districts.csv')).text();
  const rows = csvRows(text);
  const map = new Map();
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const name = r[0];
    if (!name) continue;
    const totalStr = n(r[12]);
    const ts = totalStr ?? 0;
    const brickPct = n(r[7]), blockPct = n(r[8]), stonePct = n(r[9]), timberPct = n(r[10]), adobePct = n(r[11]);
    const hospitals = n(r[14]), dispensaries = n(r[15]), rhcs = n(r[16]);
    const bhus = n(r[17]), tbClinics = n(r[18]), shc = n(r[19]), mch = n(r[20]), trauma = n(r[21]);
    const natHwy = n(r[23]), motorway = n(r[24]), otherRoads = n(r[25]);

    map.set(name, {
      name,
      population: { total: n(r[3]), male: n(r[1]), female: n(r[2]), area: n(r[4]), density: n(r[5]), avgHHSize: n(r[6]) },
      housing: {
        totalStructures: totalStr,
        brickMasonry: toCount(brickPct, ts), blockMasonry: toCount(blockPct, ts),
        stoneMasonry: toCount(stonePct, ts), timber: toCount(timberPct, ts), adobe: toCount(adobePct, ts),
        brickPct, blockPct, stonePct, timberPct, adobePct,
      },
      education: { total: 0 },
      health: {
        hospitals, dispensaries, rhcs, bhus, tbClinics, shc, mch, trauma,
        total: n(r[22]) ?? sumNonNull(hospitals, dispensaries, rhcs, bhus, tbClinics, shc, mch, trauma),
      },
      roads: {
        nationalHighways: natHwy, motorway, otherRoads,
        total: n(r[26]) ?? sumNonNull(natHwy, motorway, otherRoads),
      },
    });
  }
  return map;
}

/* ─── national_stats.csv ────────────────────────────────────────
   Cols: NAME OF ADMINISTRATIVE UNIT, Male, Female, Total, AREA IN SQ.KM,
         DENSITY PER SQ.KM, AVG. H.HOLD SIZE, Total Str, Rural Str, Urb Str,
         High Rise, Normal Structures, Jughi/Jhompri/Tent, Under Construction
   Returns a Map keyed by the name in the CSV (uppercase). */
export async function loadNationalStatsCSV() {
  const text = await (await fetch('/latest_data_districts/national/national_stats.csv')).text();
  const rows = csvRows(text);
  const map = new Map();
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const name = r[0]?.trim();
    if (!name) continue;
    map.set(name, {
      male:               n(r[1]),
      female:             n(r[2]),
      total:              n(r[3]),
      area:               n(r[4]),
      density:            n(r[5]),
      avgHHSize:          n(r[6]),
      totalStructures:    n(r[7]),
      ruralStructures:    n(r[8]),
      urbanStructures:    n(r[9]),
      highRise:           n(r[10]),
      normalStructures:   n(r[11]),
      jughi:              n(r[12]),
      underConstruction:  n(r[13]),
    });
  }
  return map;
}

/**
 * Find a district record by name (case-insensitive partial match).
 */
export function findDistrict(dataMap, districtName) {
  if (!dataMap || !districtName) return null;
  const lower = districtName.toLowerCase().trim();
  for (const [key, val] of dataMap) {
    if (key.toLowerCase().trim() === lower) return val;
  }
  for (const [key, val] of dataMap) {
    if (key.toLowerCase().includes(lower) || lower.includes(key.toLowerCase())) return val;
  }
  return null;
}
