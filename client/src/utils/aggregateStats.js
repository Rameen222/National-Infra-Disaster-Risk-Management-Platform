/**
 * Aggregates a province district Map (as returned by provincialIntake loaders)
 * into a single province-level summary object.
 *
 * Housing masonry values are already actual counts from the parser.
 */
export function aggregateProvince(dataMap, provinceName, color) {
  const districts = Array.from(dataMap.values());

  let pop = 0, male = 0, female = 0, area = 0, structures = 0;
  let wBrick = 0, wBlock = 0, wStone = 0, wTimber = 0, wAdobe = 0;
  let primary = 0, middle = 0, high = 0, higherSec = 0, interClg = 0, degClg = 0;
  let elementary = 0, secondary = 0, pg = 0, universities = 0, management = 0, technical = 0;
  let hospitals = 0, dispensaries = 0, tbClinics = 0, rhcs = 0, bhus = 0, mch = 0, shc = 0, trauma = 0, leprosyClinics = 0;
  let blackTop = 0, shingle = 0, nationalHighways = 0, motorway = 0, otherRoads = 0, highType = 0, lowType = 0;
  let hasHealth = false, hasRoads = false;

  for (const d of districts) {
    pop        += d.population.total     ?? 0;
    male       += d.population.male      ?? 0;
    female     += d.population.female    ?? 0;
    area       += d.population.area      ?? 0;
    structures += d.housing.totalStructures ?? 0;

    // Housing values are already actual counts from provincialIntake
    wBrick  += d.housing.brickMasonry ?? 0;
    wBlock  += d.housing.blockMasonry ?? 0;
    wStone  += d.housing.stoneMasonry ?? 0;
    wTimber += d.housing.timber       ?? 0;
    wAdobe  += d.housing.adobe        ?? 0;

    if (d.education) {
      primary      += d.education.primary         ?? 0;
      middle       += d.education.middle          ?? 0;
      high         += d.education.high            ?? 0;
      higherSec    += d.education.higherSecondary ?? 0;
      interClg     += d.education.interColleges   ?? 0;
      degClg       += d.education.degreeColleges  ?? 0;
      elementary   += d.education.elementary      ?? 0;
      secondary    += d.education.secondary       ?? 0;
      pg           += d.education.pg              ?? 0;
      universities += d.education.universities    ?? 0;
      management   += d.education.management      ?? 0;
      technical    += d.education.technical        ?? 0;
    }

    if (d.health && d.health.total != null) {
      hasHealth      = true;
      hospitals      += d.health.hospitals      ?? 0;
      dispensaries   += d.health.dispensaries    ?? 0;
      tbClinics      += d.health.tbClinics      ?? 0;
      rhcs           += d.health.rhcs           ?? 0;
      bhus           += d.health.bhus           ?? 0;
      mch            += d.health.mch            ?? 0;
      shc            += d.health.shc            ?? 0;
      trauma         += d.health.trauma         ?? 0;
      leprosyClinics += d.health.leprosyClinics ?? 0;
    }

    if (d.roads) {
      hasRoads          = true;
      blackTop          += d.roads.blackTop          ?? 0;
      shingle           += d.roads.shingle           ?? 0;
      nationalHighways  += d.roads.nationalHighways  ?? 0;
      motorway          += d.roads.motorway          ?? 0;
      otherRoads        += d.roads.otherRoads        ?? 0;
      highType          += d.roads.highType           ?? 0;
      lowType           += d.roads.lowType            ?? 0;
    }
  }

  const eduTotal = primary + middle + high + higherSec + interClg + degClg +
                   elementary + secondary + pg + universities + management + technical;

  return {
    name:       provinceName,
    color,
    districts:  districts.length,
    population: { total: pop, male, female, area: Math.round(area) },
    structures,
    housing: structures > 0 ? {
      brickMasonry: wBrick,
      blockMasonry: wBlock,
      stoneMasonry: wStone,
      timber:       wTimber,
      adobe:        wAdobe,
      totalStructures: structures,
    } : null,
    education:  { primary, middle, high, higherSec, interClg, degClg,
                  elementary, secondary, pg, universities, management, technical,
                  total: eduTotal },
    health:     hasHealth
      ? { hospitals, dispensaries, tbClinics, rhcs, bhus, mch, shc, trauma, leprosyClinics,
          total: hospitals + dispensaries + tbClinics + rhcs + bhus + mch + shc + trauma + leprosyClinics }
      : null,
    roads:      hasRoads ? {
      blackTop:         Math.round(blackTop),
      shingle:          Math.round(shingle),
      nationalHighways: Math.round(nationalHighways),
      motorway:         Math.round(motorway),
      otherRoads:       Math.round(otherRoads),
      highType:         Math.round(highType),
      lowType:          Math.round(lowType),
      total:            Math.round(blackTop + shingle + nationalHighways + motorway + otherRoads + highType + lowType),
    } : null,
  };
}

/**
 * Builds a national summary by combining multiple province aggregates.
 * @param {object[]} provinceAggregates  Array of aggregateProvince() results
 */
export function buildNationalStats(provinceAggregates) {
  const totals = provinceAggregates.reduce(
    (acc, p) => {
      acc.districts  += p.districts;
      acc.population += p.population.total;
      acc.area       += p.population.area;
      acc.structures += p.structures;
      acc.edu        += p.education.total;
      if (p.health)  acc.health += p.health.total;
      if (p.roads)   acc.roads  += p.roads.total ?? (p.roads.blackTop + p.roads.shingle);
      return acc;
    },
    { districts: 0, population: 0, area: 0, structures: 0, edu: 0, health: 0, roads: 0 }
  );

  return { totals, provinces: provinceAggregates };
}
