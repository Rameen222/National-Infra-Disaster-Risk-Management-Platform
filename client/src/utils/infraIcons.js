// Map marker icons for infra point layers, drawn on a canvas at runtime
// (Mapbox's addImage can't decode SVG, and this avoids shipping PNGs).
//
// Glyphs are Google Material Icons (Apache License 2.0), 24×24 path data.
const GLYPHS = {
  school: 'M5 13.18v4L12 21l7-3.82v-4L12 17l-7-3.82zM12 3L1 9l11 6 9-4.91V17h2V9L12 3z',
  hospital: 'M19 3H5c-1.1 0-1.99.9-1.99 2L3 19c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-1 11h-4v4h-4v-4H6v-4h4V6h4v4h4v4z',
};

export const ICON_PIXEL_RATIO = 2;

/**
 * A round badge — white disc, dark outline, glyph in `color` — as ImageData
 * for map.addImage(name, data, { pixelRatio: ICON_PIXEL_RATIO }). White
 * keeps it readable over satellite imagery and distinct from the coloured
 * building-height fills.
 */
export function drawGlyphBadge(glyph, color, cssSize = 26) {
  const size = cssSize * ICON_PIXEL_RATIO;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const r = size / 2;

  ctx.beginPath();
  ctx.arc(r, r, r - 2 * ICON_PIXEL_RATIO, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.lineWidth = 1.5 * ICON_PIXEL_RATIO;
  ctx.strokeStyle = '#0b0f0e';
  ctx.stroke();

  // Fit the 24-unit glyph into ~62% of the badge, centred.
  const glyphSize = size * 0.62;
  ctx.translate(r - glyphSize / 2, r - glyphSize / 2);
  ctx.scale(glyphSize / 24, glyphSize / 24);
  ctx.fillStyle = color;
  ctx.fill(new Path2D(GLYPHS[glyph]));

  return ctx.getImageData(0, 0, size, size);
}
