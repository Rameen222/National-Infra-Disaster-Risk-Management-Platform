import { resolveDistrict, provinceLabel, PROVINCE_REGISTRY } from './provinceRegistry';

const sindh = new Map([
  ['Karachi', { name: 'Karachi', population: { total: 1000 } }],
  ['Sukkur', { name: 'Sukkur', population: { total: 200 } }],
]);

const sources = {
  sindh,
  balochistan: new Map([['Quetta', { name: 'Quetta' }]]),
  nationalCSVData: new Map([
    ['ISLAMABAD', { total: 50, male: 26, female: 24, area: 906, density: 55, avgHHSize: 6, totalStructures: 12 }],
  ]),
};

describe('provinceLabel', () => {
  it('maps a known id to its Title-case label', () => {
    expect(provinceLabel('gilgit-baltistan')).toBe('Gilgit Baltistan');
    expect(provinceLabel('kpk')).toBe('KP');
  });

  it('returns null for an unknown id', () => {
    expect(provinceLabel('atlantis')).toBeNull();
  });

  it('covers every registry entry', () => {
    for (const id of Object.keys(PROVINCE_REGISTRY)) {
      expect(typeof provinceLabel(id)).toBe('string');
    }
  });
});

describe('resolveDistrict', () => {
  it('returns null for an unknown province', () => {
    expect(resolveDistrict('atlantis', 'Karachi', sources)).toBeNull();
  });

  it('returns null when no district name is given', () => {
    expect(resolveDistrict('sindh', '', sources)).toBeNull();
  });

  it('returns null when the province data is not loaded yet', () => {
    expect(resolveDistrict('sindh', 'Karachi', { nationalCSVData: sources.nationalCSVData })).toBeNull();
  });

  it('resolves an exact district match to record + label', () => {
    const res = resolveDistrict('sindh', 'Karachi', sources);
    expect(res).not.toBeNull();
    expect(res.label).toBe('Sindh');
    expect(res.record.name).toBe('Karachi');
  });

  it('resolves a fuzzy / near-miss name (case + substring) via findDistrict', () => {
    // 'sukkur city' is not an exact key, but findDistrict matches on substring.
    const res = resolveDistrict('sindh', 'sukkur city', sources);
    expect(res).not.toBeNull();
    expect(res.record.name).toBe('Sukkur');
    expect(res.label).toBe('Sindh');
  });

  it('returns null when the district cannot be matched', () => {
    expect(resolveDistrict('sindh', 'Lahore', sources)).toBeNull();
  });

  it('synthesises the Islamabad record from the national CSV row', () => {
    const res = resolveDistrict('islamabad', 'Islamabad', sources);
    expect(res).not.toBeNull();
    expect(res.label).toBe('Federal Capital');
    expect(res.record.name).toBe('Islamabad');
    expect(res.record.population.total).toBe(50);
    expect(res.record.housing.totalStructures).toBe(12);
    expect(res.record.health).toBeNull();
  });

  it('returns null for Islamabad when the national CSV lacks the row', () => {
    expect(resolveDistrict('islamabad', 'Islamabad', { nationalCSVData: new Map() })).toBeNull();
  });
});
