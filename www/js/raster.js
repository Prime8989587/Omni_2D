// Software rasterizer for the pixel grid. Pure functions over typed
// arrays -- no DOM, no canvas -- so the exactness guarantees below can be
// checked directly in Node.
//
// WHY A RASTERIZER, NOT PER-PIXEL SPLATTING
//
// The obvious way to "snap deformation to the grid" is to push each source
// pixel through the deformation, round the result, and paint it there.
// That leaks two artifacts: where the mesh is stretched, neighbouring
// source pixels round to cells two apart and leave a hole between them;
// where it is squashed, several round to the same cell and fight.
//
// This module does the inverse. The mesh vertices are snapped to the grid
// first, then each triangle is filled by asking, for every scene pixel,
// "does my CENTRE lie inside this triangle, and which single source texel
// is under it?" Every scene pixel is decided exactly once, so the output
// can never contain a gap or a doubled pixel. The trade-off is the one
// nearest-neighbour scaling has always had -- a stretched triangle repeats
// some texels and a squashed one drops some -- which pixel art already
// lives with.

// Twice the signed area of (a, b, p): positive on one side of a->b,
// negative on the other, zero on the line.
function edge(ax, ay, bx, by, px, py) {
  return (bx - ax) * (py - ay) - (by - ay) * (px - ax);
}

// Fills one textured triangle into `target` (RGBA, targetWidth x
// targetHeight). p0..p2 are the triangle's corners in scene pixels --
// callers snap them to integers first. uv0..uv2 are the matching source
// texel coordinates in `source` (RGBA, sourceWidth x sourceHeight).
//
// `mask`, when given, is one byte per source texel: a zero there is
// treated exactly like a fully transparent texel. It exists so one layer
// can be drawn in two passes at two different depths -- see canvas.js,
// where a piercer's painted tip is drawn underneath the flesh it has
// entered while the rest of it stays on top. Splitting by texel rather
// than by geometry keeps both passes on the SAME vertices, so the two
// halves cannot drift apart or leave a seam between them.
export function rasterizeTriangle(
  target, targetWidth, targetHeight,
  source, sourceWidth, sourceHeight,
  p0, p1, p2, uv0, uv1, uv2, mask = null
) {
  let area = edge(p0.x, p0.y, p1.x, p1.y, p2.x, p2.y);
  if (area === 0) return; // degenerate: no pixels have their centre inside

  // Normalize winding so "inside" is always "all edge functions >= 0".
  const sign = area > 0 ? 1 : -1;
  area *= sign;

  const minX = Math.max(0, Math.floor(Math.min(p0.x, p1.x, p2.x)));
  const maxX = Math.min(targetWidth - 1, Math.ceil(Math.max(p0.x, p1.x, p2.x)));
  const minY = Math.max(0, Math.floor(Math.min(p0.y, p1.y, p2.y)));
  const maxY = Math.min(targetHeight - 1, Math.ceil(Math.max(p0.y, p1.y, p2.y)));
  if (minX > maxX || minY > maxY) return;

  const maxTexelX = sourceWidth - 1;
  const maxTexelY = sourceHeight - 1;

  for (let y = minY; y <= maxY; y++) {
    const py = y + 0.5;
    for (let x = minX; x <= maxX; x++) {
      const px = x + 0.5;

      // Edge functions double as barycentric weights once divided by the
      // triangle's area. A centre exactly on a shared edge scores zero on
      // it and is claimed by both neighbours, which is harmless: both
      // interpolate to the same texel there.
      const w0 = edge(p1.x, p1.y, p2.x, p2.y, px, py) * sign;
      if (w0 < 0) continue;
      const w1 = edge(p2.x, p2.y, p0.x, p0.y, px, py) * sign;
      if (w1 < 0) continue;
      const w2 = edge(p0.x, p0.y, p1.x, p1.y, px, py) * sign;
      if (w2 < 0) continue;

      const u = (w0 * uv0.u + w1 * uv1.u + w2 * uv2.u) / area;
      const v = (w0 * uv0.v + w1 * uv1.v + w2 * uv2.v) / area;

      // Nearest neighbour: the single texel whose cell contains (u, v).
      const texelX = Math.min(maxTexelX, Math.max(0, Math.floor(u)));
      const texelY = Math.min(maxTexelY, Math.max(0, Math.floor(v)));
      const texel = texelY * sourceWidth + texelX;
      if (mask && mask[texel] === 0) continue;
      const s = texel * 4;
      const alpha = source[s + 3];
      if (alpha === 0) continue;

      const t = (y * targetWidth + x) * 4;
      if (alpha === 255) {
        target[t] = source[s];
        target[t + 1] = source[s + 1];
        target[t + 2] = source[s + 2];
        target[t + 3] = 255;
        continue;
      }

      // Semi-transparent texel: standard source-over onto what is there.
      const srcA = alpha / 255;
      const dstA = target[t + 3] / 255;
      const outA = srcA + dstA * (1 - srcA);
      if (outA === 0) continue;
      for (let c = 0; c < 3; c++) {
        target[t + c] = (source[s + c] * srcA + target[t + c] * dstA * (1 - srcA)) / outA;
      }
      target[t + 3] = outA * 255;
    }
  }
}

// Clears a rectangle of the scene buffer to transparent. Coordinates are
// clamped, so callers can pass a dirty box that runs off the grid.
export function clearRegion(target, targetWidth, targetHeight, x0, y0, x1, y1) {
  const startX = Math.max(0, Math.floor(x0));
  const endX = Math.min(targetWidth, Math.ceil(x1));
  const startY = Math.max(0, Math.floor(y0));
  const endY = Math.min(targetHeight, Math.ceil(y1));
  if (startX >= endX || startY >= endY) return;

  const rowBytes = (endX - startX) * 4;
  for (let y = startY; y < endY; y++) {
    const offset = (y * targetWidth + startX) * 4;
    target.fill(0, offset, offset + rowBytes);
  }
}
