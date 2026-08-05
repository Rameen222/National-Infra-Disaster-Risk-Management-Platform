import { findDistrict } from '../utils/provincialIntake';

// Single source of truth for province identity: the kebab-case id used in app
// state (e.g. 'gilgit-baltistan') and the Title-case label shown in the UI and
// stored on stats records (e.g. 'Gilgit Baltistan'). Adding a province is one
// row here instead of editing duplicated if/else chains.
export const PROVINCE_REGISTRY = {
  balochistan: { label: 'Balochistan' },
  kpk: { label: 'KP' },
  sindh: { label: 'Sindh' },
  punjab: { label: 'Punjab' },
  ajk: { label: 'AJK' },
  'gilgit-baltistan': { label: 'Gilgit Baltistan' },
  islamabad: { label: 'Federal Capital' },
};

// Title-case label for a province id, or null if the id is unknown.
export function provinceLabel(provinceId) {
  return PROVINCE_REGISTRY[provinceId]?.label ?? null;
}

// Islamabad / Federal Capital has no per-district map — its single record is
// synthesised from the national CSV row.
function islamabadRecord(districtName, ict) {
  return {
    name: districtName,
    population: {
      total: ict.total,
      male: ict.male,
      female: ict.female,
      area: ict.area,
      density: ict.density,
      avgHHSize: ict.avgHHSize,
    },
    housing: { totalStructures: ict.totalStructures },
    education: { total: 0 },
    health: null,
    roads: null,
  };
}

/**
 * Resolve a district to its stats record and province label.
 *
 * @param {string} provinceId   kebab-case province id (key of PROVINCE_REGISTRY)
 * @param {string} districtName the clicked/searched district name
 * @param {object} sources      per-province district data Maps keyed by province
 *                              id, plus `nationalCSVData` for the Islamabad case
 * @returns {{ record: object, label: string } | null}
 */
export function resolveDistrict(provinceId, districtName, sources = {}) {
  const entry = PROVINCE_REGISTRY[provinceId];
  if (!entry || !districtName) return null;

  if (provinceId === 'islamabad') {
    const ict = sources.nationalCSVData?.get('ISLAMABAD');
    return ict ? { record: islamabadRecord(districtName, ict), label: entry.label } : null;
  }

  const data = sources[provinceId];
  if (!data) return null;
  const rec = findDistrict(data, districtName);
  return rec ? { record: rec, label: entry.label } : null;
}
