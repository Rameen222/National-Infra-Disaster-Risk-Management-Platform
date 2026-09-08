/**
 * Flood depth simulation for the 3D building interior viewer.
 *
 * The production SIMEX/clipped data only carries building geometry and a
 * `height` attribute — there is no per-building flood-depth field anywhere
 * in the pipeline. Rather than block the prototype on new backend work, this
 * module derives a plausible water depth from the *scenario* the user has
 * selected (which encodes a recurrence interval / severity) scaled by the
 * building's own height.
 *
 * The depth brackets follow the First Street flood-damage model
 * (https://help.firststreet.org/hc/en-us/articles/9685667842583-Flood-damages-explained):
 * lower-probability scenarios = deeper floods. A short/elevated building lets
 * more water penetrate the interior (its floor sits close to ground / ground
 * level), while a taller building (often a multi-storey or raised structure)
 * is partly protected — its floor elevation keeps the first-storey contents
 * above a shallow flood.
 */

// Scenario severities keyed by their recurrence interval. Ordered from most
// frequent / shallowest to rarest / deepest.
export const SCENARIO_DEPTHS = {
  '10yr': { label: '10-year flood (10% / yr)',     depth: [0.3, 0.6] },
  '50yr': { label: '50-year flood (2% / yr)',      depth: [0.6, 1.2] },
  '100yr': { label: '100-year flood (1% / yr)',    depth: [1.2, 2.4] },
  '500yr': { label: '500-year flood (0.2% / yr)',  depth: [2.4, 4.5] },
};

// Map a SIMEX / GCOP scenario id (if known) onto one of the bracketed
// severities above. Unknown ids fall back to the 100-year default.
export function severityForScenario(scenarioId) {
  const id = String(scenarioId || '').toLowerCase();
  if (/(^|\D)(10|25)(\D|$)/.test(id)) return '10yr';
  if (/(^|\D)(50)(\D|$)/.test(id)) return '50yr';
  if (/(^|\D)(100)(\D|$)/.test(id)) return '100yr';
  if (/(^|\D)(500)(\D|$)/.test(id)) return '500yr';
  return '100yr';
}

/**
 * Compute the flood depth (metres) that would enter a building's interior.
 *
 * @param {object} opts
 * @param {number}  opts.buildingHeight - building height in metres (>= 0)
 * @param {string}  [opts.scenarioId]   - scenario id used to pick severity
 * @param {string}  [opts.severity]     - explicit severity key (overrides scenarioId)
 * @param {number}  [opts.randomSeed]   - deterministic 0..1 to pick a depth inside bracket
 * @returns {{ depth: number, severity: string, label: string, bracket: [number, number], penetration: number }}
 */
export function estimateFloodDepth({ buildingHeight = 3, scenarioId, severity, randomSeed = 0.5 }) {
  const key = severity || severityForScenario(scenarioId);
  const bracket = SCENARIO_DEPTHS[key] || SCENARIO_DEPTHS['100yr'];
  const [min, max] = bracket.depth;

  // Clamp the seed so consecutive identical buildings still vary slightly
  // but a given building is reproducible for a given seed.
  const t = Math.min(0.999, Math.max(0.001, randomSeed));

  // Surface depth inside the bracket (the flood that reaches the building).
  const surfaceDepth = min + (max - min) * t;

  // Ground-floor elevation loss factor (0..1). Buildings under ~3 m lose all
  // of their height to penetration; above that the loss drops toward a floor.
  // This mirrors First Street's "water to reach first floor" logic.
  const h = Math.max(0, Number(buildingHeight) || 0);
  const floorFactor = h <= 0 ? 1 : Math.max(0.25, 1 - h / 12);

  // Interior water = how much of the surface depth actually enters the home.
  const penetration = Math.min(0.95, Math.max(0, surfaceDepth * floorFactor));

  return {
    depth: Number(penetration.toFixed(2)),
    severity: key,
    label: bracket.label,
    bracket,
    penetration,
    buildingHeight: h,
  };
}

// Damage-impact tiers, again drawn from First Street's depth-by-damage table.
// Each tier lists what gets damaged at that interior depth.
export const DAMAGE_TIERS = [
  { min: 0.0, label: 'Minimal water', items: ['Floor sealant & paint', 'Lower wall scuffs'] },
  { min: 0.3, label: 'Shallow flood', items: ['Electrical outlets', 'HVAC / furnace units', 'Lower furniture'] },
  { min: 0.6, label: 'Moderate flood', items: ['Furniture & appliances', 'Wood flooring', 'Drywall up to wainscot'] },
  { min: 1.0, label: 'Deep flood', items: ['Plumbing & sewage systems', 'Kitchen fixtures', 'Structural framing footings'] },
  { min: 1.8, label: 'Severe flood', items: ['Full interior walls', 'Roof / ceiling structure', 'Building infrastructure'] },
];

export function damageTier(depthM) {
  let tier = DAMAGE_TIERS[0];
  for (const t of DAMAGE_TIERS) if (depthM >= t.min) tier = t;
  return tier;
}

// Rough cost + repair-time estimate derived from depth. These are illustrative
// prototype figures, not a real actuarial model.
export function estimateDamages(depthM) {
  const cost = Math.round((6000 + depthM * 22000) / 500) * 500;
  const days = Math.round(8 + depthM * 30);
  return {
    estimatedRepairCost: cost,
    estimatedRepairDays: days,
    waterReachesFirstFloor: depthM,
  };
}
