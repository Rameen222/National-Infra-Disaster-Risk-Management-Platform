import { MAP_CONFIG } from '../config/mapConfig';

const PROVINCE_LOOKUP = [
  { keys: ['punjab'],                              id: 'punjab' },
  { keys: ['sindh'],                               id: 'sindh' },
  { keys: ['khyber pakhtunkhwa', 'kpk', 'kp'],    id: 'kpk' },
  { keys: ['balochistan'],                         id: 'balochistan' },
  { keys: ['gilgit-baltistan', 'gilgit baltistan', 'gb'], id: 'gilgit-baltistan' },
  { keys: ['azad kashmir', 'azad jammu'],          id: 'ajk' },
  { keys: ['islamabad capital territory', 'islamabad', 'federal capital'], id: 'islamabad' },
];

function resolveProvinceId(text) {
  const lower = (text || '').toLowerCase();
  for (const { keys, id } of PROVINCE_LOOKUP) {
    if (keys.some((k) => lower.includes(k))) return id;
  }
  return null;
}

const TYPE_LABELS = {
  region:       'Province',
  district:     'District',
  place:        'City',
  locality:     'Area',
  neighborhood: 'Area',
  address:      'Address',
  poi:          'Place',
};

export function getTypeLabel(placeType) {
  return TYPE_LABELS[placeType] || 'Location';
}

function googleTypesToInternal(types = []) {
  if (types.includes('administrative_area_level_1')) return 'region';
  if (types.includes('administrative_area_level_2')) return 'district';
  if (types.includes('locality') || types.includes('sublocality')) return 'place';
  if (types.includes('neighborhood') || types.includes('sublocality_level_1')) return 'neighborhood';
  if (types.includes('route') || types.includes('street_address')) return 'address';
  if (types.includes('point_of_interest') || types.includes('establishment')) return 'poi';
  return 'place';
}

// Step 1: Get autocomplete suggestions (no coordinates yet)
// Uses Places API (New) v1 via the backend proxy
export async function searchLocations(query) {
  if (!query.trim()) return [];

  try {
    const res = await fetch(`/api/geocode/search?q=${encodeURIComponent(query.trim())}`);
    if (res.ok) {
      const data = await res.json();

      // Places API (New) returns { suggestions: [{ placePrediction: {...} }] }
      if (Array.isArray(data.suggestions)) {
        return data.suggestions
          .map((s) => s.placePrediction)
          .filter(Boolean)
          .map((p) => {
            const mainText = p.structuredFormat?.mainText?.text || p.text?.text || '';
            const secondaryText = p.structuredFormat?.secondaryText?.text || '';
            const fullText = p.text?.text || [mainText, secondaryText].filter(Boolean).join(', ');

            // Province from the secondary text (e.g. "Punjab, Pakistan")
            let provinceId = resolveProvinceId(secondaryText) || resolveProvinceId(fullText);

            // District is the first part of secondaryText when it has two comma-separated parts
            const secParts = secondaryText.split(',').map((s) => s.trim());
            const districtName = secParts.length >= 2 ? secParts[0] : null;

            return {
              id: p.placeId,
              placeName: fullText,
              shortName: mainText,
              center: null,
              bbox: null,
              provinceId,
              districtName,
              placeType: googleTypesToInternal(p.types || []),
              needsDetails: true,
            };
          });
      }
    }
  } catch (_) {
    // fall through to Mapbox
  }

  return mapboxSearch(query);
}

// Step 2: Fetch coordinates + address breakdown when user picks a result
// Places API (New) details endpoint
export async function getPlaceDetails(placeId) {
  try {
    const res = await fetch(`/api/geocode/details?place_id=${encodeURIComponent(placeId)}`);
    if (!res.ok) return null;
    const data = await res.json();

    // New Places API returns { location: { latitude, longitude }, viewport: { low, high }, addressComponents: [...] }
    if (!data.location) return null;

    const { latitude: lat, longitude: lng } = data.location;
    const components = data.addressComponents || [];

    let provinceId = null;
    let districtName = null;
    for (const comp of components) {
      const types = comp.types || [];
      // New API uses longText instead of long_name
      const name = comp.longText || comp.long_name || '';
      if (!provinceId && types.includes('administrative_area_level_1')) {
        provinceId = resolveProvinceId(name);
      }
      if (!districtName && types.includes('administrative_area_level_2')) {
        districtName = name;
      }
    }

    const vp = data.viewport;
    const bbox = vp
      ? [vp.low.longitude, vp.low.latitude, vp.high.longitude, vp.high.latitude]
      : null;

    return { center: [lng, lat], bbox, provinceId, districtName };
  } catch (err) {
    console.error('[geocoding] details failed', err);
    return null;
  }
}

// Mapbox fallback — used when service account is unavailable or returns an error
async function mapboxSearch(query) {
  const token = MAP_CONFIG.accessToken;
  if (!query.trim() || !token) return [];

  const encoded = encodeURIComponent(query.trim());
  const types = 'region,district,place,locality,neighborhood,address';
  const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encoded}.json?country=PK&limit=6&types=${types}&access_token=${token}`;

  try {
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = await res.json();

    return (data.features || []).map((f) => {
      let provinceId = null;
      let districtName = null;

      for (const ctx of (f.context || [])) {
        if (!provinceId && ctx.id?.startsWith('region.')) {
          provinceId = resolveProvinceId(ctx.text);
        }
        if (!districtName && (ctx.id?.startsWith('district.') || ctx.id?.startsWith('place.'))) {
          districtName = ctx.text || null;
        }
      }

      if (!provinceId && f.place_type?.includes('region')) {
        provinceId = resolveProvinceId(f.text);
      }
      if (!districtName && (f.place_type?.includes('district') || f.place_type?.includes('place'))) {
        districtName = f.text || null;
      }

      return {
        id: f.id,
        placeName: f.place_name,
        shortName: f.text,
        center: f.center,
        bbox: f.bbox || null,
        provinceId,
        districtName,
        placeType: f.place_type?.[0] || 'place',
        needsDetails: false,
      };
    });
  } catch (err) {
    console.error('[geocoding] mapbox fallback failed', err);
    return [];
  }
}
