import { PROVINCES } from '../../config/mapConfig';
import {
  loadBalochistanDistricts,
  loadKPDistricts,
  loadSindhDistricts,
  loadPunjabDistricts,
  loadAJKDistricts,
  loadGBDistricts,
} from '../../utils/provincialIntake';

// The 6 provinces (Federal Capital/Islamabad is a federal territory, not a
// province, and is excluded here — same reasoning that already excludes it
// from having its own per-district loader below).
export const PROVINCE_OPTIONS = PROVINCES.filter((p) => p.id !== 'islamabad');

const LOADERS = {
  punjab: loadPunjabDistricts,
  sindh: loadSindhDistricts,
  kpk: loadKPDistricts,
  balochistan: loadBalochistanDistricts,
  'gilgit-baltistan': loadGBDistricts,
  ajk: loadAJKDistricts,
};

// Reuses the same per-province district CSVs the dashboard already loads
// for population stats (a few KB each) — just reading district names out
// of them, nothing added or changed there.
const cache = new Map();

export async function loadDistrictsForProvince(provinceId) {
  if (cache.has(provinceId)) return cache.get(provinceId);
  const loader = LOADERS[provinceId];
  if (!loader) return [];
  const dataMap = await loader();
  const names = Array.from(dataMap.keys()).sort();
  cache.set(provinceId, names);
  return names;
}
