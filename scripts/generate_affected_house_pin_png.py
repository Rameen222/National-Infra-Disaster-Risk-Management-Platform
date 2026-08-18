"""
Mapbox GL JS's map.loadImage()/addImage() only decodes raster formats
(PNG/JPEG/WebP) — SVG fetches fine over HTTP but silently fails to decode,
which is why the "Affected Houses" pin never rendered (console: 'Image
"infra-icon-affected_houses" could not be loaded'). This rasterizes the same
pin design (see affected-house-pin.svg) directly with PIL at 4x supersample
then downsamples for clean anti-aliased edges, since cairosvg/rsvg aren't
available in this environment.
"""
from PIL import Image, ImageDraw

SCALE = 4
W, H = 32 * SCALE, 40 * SCALE
ORANGE = (249, 115, 22, 255)
STROKE = (124, 45, 18, 255)
WHITE = (255, 255, 255, 255)

img = Image.new('RGBA', (W, H), (0, 0, 0, 0))
draw = ImageDraw.Draw(img)

cx = 16 * SCALE
top_r = 12.5 * SCALE
circle_cy = 14 * SCALE
tip = (cx, 38 * SCALE)

# Teardrop pin: circle body + triangular point, same silhouette as the SVG.
draw.polygon([
    (cx - top_r * 0.86, circle_cy + top_r * 0.5),
    (cx + top_r * 0.86, circle_cy + top_r * 0.5),
    tip,
], fill=ORANGE)
draw.ellipse([cx - top_r, circle_cy - top_r, cx + top_r, circle_cy + top_r], fill=ORANGE)

# Stroke outline (approximate: draw a slightly larger silhouette behind, already
# covered by fill order above — add a thin outline via a second smaller pass)
stroke_w = 1.6 * SCALE
draw.ellipse([cx - top_r, circle_cy - top_r, cx + top_r, circle_cy + top_r], outline=STROKE, width=int(stroke_w))

inner_r = 6 * SCALE
draw.ellipse([cx - inner_r, circle_cy - inner_r, cx + inner_r, circle_cy + inner_r], fill=WHITE)
center_r = 3 * SCALE
draw.ellipse([cx - center_r, circle_cy - center_r, cx + center_r, circle_cy + center_r], fill=ORANGE)

img = img.resize((32, 40), Image.LANCZOS)
out_path = 'C:/NDMA/infra_portal/client/public/infra/affected-house-pin.png'
img.save(out_path)
print(f'wrote {out_path} ({img.size[0]}x{img.size[1]})')
