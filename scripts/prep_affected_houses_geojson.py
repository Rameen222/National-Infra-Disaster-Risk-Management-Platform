"""
One-off prep for the Furori flash-flood "Affected Houses" map layer.

Takes the already-cleaned/grouped client/public/infra/affected_houses.geojson
(copied verbatim from the field-data package) and, in place:
  1. rewrites each photo's relative "photos/record_XX_photo_N.jpg" path to the
     path it's actually served from (/infra/affected_houses_photos/...)
  2. bakes in a formatted DMS lat/lon string per feature (from the decimal
     coordinates already in the geometry) so the frontend popup can just
     display properties.lat_dms / lon_dms with no runtime conversion.
  3. copies the FeatureCollection-level event metadata (event/date/district)
     down onto every feature, formatted for display, so the popup can show
     "Flash Flood on 22-07-2026 at Village Furori, District Tangir, GB"
     without the frontend needing to know about collection-level properties.

Idempotent — safe to re-run (photo paths are re-derived from the filename
alone each time, not appended to). Run once per data update; the output is
committed as the final geojson, not regenerated on every build.
"""
import json

PATH = 'C:/NDMA/infra_portal/client/public/infra/affected_houses.geojson'


def to_dms(decimal, is_lat):
    hemi = ('N' if decimal >= 0 else 'S') if is_lat else ('E' if decimal >= 0 else 'W')
    decimal = abs(decimal)
    degrees = int(decimal)
    minutes_full = (decimal - degrees) * 60
    minutes = int(minutes_full)
    seconds = (minutes_full - minutes) * 60
    return f'{degrees}\u00b0{minutes}\'{seconds:.2f}"{hemi}'


with open(PATH) as f:
    data = json.load(f)

meta = data.get('properties', {})
event_name = meta.get('event', 'Flash Flood')
event_date_iso = meta.get('date')  # 'YYYY-MM-DD'
event_date_display = None
if event_date_iso:
    y, m, d = event_date_iso.split('-')
    event_date_display = f'{d}-{m}-{y}'  # 22-07-2026, per the requested display format
meta_district = meta.get('district', '')

for feat in data['features']:
    props = feat['properties']
    for p in props.get('photos', []):
        p['photo'] = '/infra/affected_houses_photos/' + p['photo'].split('/')[-1]

    lon, lat = feat['geometry']['coordinates']
    props['lat_dms'] = to_dms(lat, is_lat=True)
    props['lon_dms'] = to_dms(lon, is_lat=False)

    props['event'] = event_name
    props['event_date'] = event_date_display
    props['district'] = meta_district

with open(PATH, 'w') as f:
    json.dump(data, f)

n_photos = sum(len(f['properties'].get('photos', [])) for f in data['features'])
print(f'wrote {len(data["features"])} features, {n_photos} photo refs, to {PATH}')
