// Outline tracing for the Rig section's Contour mode.
//
// Pure: takes an alpha plane and hands back the indices of the pixels that
// sit on its boundary. No canvas, no view, no settings -- so "does this
// find the right edge" is answerable from a hand-written 5x5 grid in a
// headless test rather than by screenshotting a rig and squinting at it,
// the same split raster.js, spread.js and color.js already follow.
//
// WHAT COUNTS AS AN EDGE
//
// A pixel is on the contour when it is itself opaque and at least one of
// its four neighbours is not -- with off-buffer treated as transparent, so
// artwork running off the edge of the scene is still outlined along that
// edge rather than silently opening up there.
//
// Four-connected rather than eight: an eight-connected test also lights up
// the pixel diagonally inside a staircase, which on pixel art -- where
// every curve IS a staircase -- thickens the line to two pixels along every
// diagonal run while leaving it one pixel along the flats. The outline then
// reads as uneven for reasons that have nothing to do with the drawing.
//
// THICKNESS IS NOT DONE HERE
//
// Deliberately. Growing the set by dilating it costs O(width * height *
// thickness) every frame, and the caller is going to draw each of these as
// a rectangle anyway -- so it can simply draw a BIGGER rectangle, which
// costs nothing and gives the same result. This stays O(width * height)
// whatever thickness the user picks.

// `alpha` may be an RGBA buffer (stride 4, reading the alpha byte) or a
// dedicated single-channel plane (stride 1).
export function traceAlphaEdges(alpha, width, height, { stride = 4, threshold = 1 } = {}) {
  const edges = [];
  if (!alpha || width <= 0 || height <= 0) return edges;

  const opaqueAt = (x, y) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return false;
    const a = stride === 1 ? alpha[y * width + x] : alpha[(y * width + x) * 4 + 3];
    return a >= threshold;
  };

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!opaqueAt(x, y)) continue;
      if (opaqueAt(x - 1, y) && opaqueAt(x + 1, y) && opaqueAt(x, y - 1) && opaqueAt(x, y + 1)) {
        continue; // fully surrounded: interior, not boundary
      }
      edges.push(y * width + x);
    }
  }
  return edges;
}

// The same trace restricted to a rectangle, for per-layer outlines: a part
// occupies its own bounds, not the whole scene, so scanning the entire
// scene buffer once per part would make the cost of this mode scale with
// the number of layers times the canvas area rather than with the artwork.
//
// The neighbour test still reaches OUTSIDE the rectangle, because a part
// whose bounds have been clipped to the scene must still be outlined along
// the clip, and a pixel on the rectangle's inner edge is only genuinely a
// boundary if what lies beyond it really is transparent.
export function traceAlphaEdgesInBounds(alpha, width, height, bounds, options = {}) {
  const { stride = 4, threshold = 1 } = options;
  const edges = [];
  if (!alpha || !bounds) return edges;

  const x0 = Math.max(0, Math.floor(bounds.x0));
  const y0 = Math.max(0, Math.floor(bounds.y0));
  const x1 = Math.min(width, Math.ceil(bounds.x1));
  const y1 = Math.min(height, Math.ceil(bounds.y1));

  const opaqueAt = (x, y) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return false;
    const a = stride === 1 ? alpha[y * width + x] : alpha[(y * width + x) * 4 + 3];
    return a >= threshold;
  };

  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (!opaqueAt(x, y)) continue;
      if (opaqueAt(x - 1, y) && opaqueAt(x + 1, y) && opaqueAt(x, y - 1) && opaqueAt(x, y + 1)) {
        continue;
      }
      edges.push(y * width + x);
    }
  }
  return edges;
}

// THE OUTLINE CONTOUR MODE DRAWS: the pixels just OUTSIDE a shape.
//
// traceAlphaEdges finds the shape's own rim; an outline drawn ON that rim
// covers the outermost pixel of the artwork, which on pixel art is usually
// the artist's own line. So what Contour mode paints is the ring of
// transparent pixels around the shape instead, `thickness` pixels deep --
// the classic pixel-art outline, which adds to the drawing rather than
// painting over it, on the artwork's own pixel grid.
//
// The neighbourhood is the square one (a pixel diagonally off a corner is
// in the ring), so a one-pixel outline closes around every corner instead
// of leaving the corner pixel notched out. Thickness is a square dilation
// done as two separable running-window passes -- each pixel costs the same
// however thick the outline is.
//
// `bounds` (optional) limits the work to the rectangle the shape lives in;
// the ring may extend `thickness` beyond it, and is clipped to the buffer.
// Returns the buffer indices of the ring's pixels.
export function outlineRing(alpha, width, height, { stride = 4, threshold = 1, thickness = 1, bounds = null } = {}) {
  const ring = [];
  if (!alpha || width <= 0 || height <= 0) return ring;
  const t = Math.max(1, Math.round(thickness));
  const bx0 = bounds ? Math.floor(bounds.x0) : 0;
  const by0 = bounds ? Math.floor(bounds.y0) : 0;
  const bx1 = bounds ? Math.ceil(bounds.x1) : width;
  const by1 = bounds ? Math.ceil(bounds.y1) : height;
  const x0 = Math.max(0, bx0 - t);
  const y0 = Math.max(0, by0 - t);
  const x1 = Math.min(width, bx1 + t);
  const y1 = Math.min(height, by1 + t);
  const w = x1 - x0;
  const h = y1 - y0;
  if (w <= 0 || h <= 0) return ring;

  const solid = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y + y0) * width + (x + x0);
      solid[y * w + x] = (stride === 1 ? alpha[i] : alpha[i * 4 + 3]) >= threshold ? 1 : 0;
    }
  }

  // Horizontal pass: is there a solid pixel within t along the row?
  const across = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    let count = 0;
    const row = y * w;
    for (let x = 0; x < Math.min(t, w); x++) count += solid[row + x];
    for (let x = 0; x < w; x++) {
      if (x + t < w) count += solid[row + x + t];
      if (x - t - 1 >= 0) count -= solid[row + x - t - 1];
      across[row + x] = count > 0 ? 1 : 0;
    }
  }
  // Vertical pass over that: a solid pixel within t in both directions.
  for (let x = 0; x < w; x++) {
    let count = 0;
    for (let y = 0; y < Math.min(t, h); y++) count += across[y * w + x];
    for (let y = 0; y < h; y++) {
      if (y + t < h) count += across[(y + t) * w + x];
      if (y - t - 1 >= 0) count -= across[(y - t - 1) * w + x];
      if (count > 0 && !solid[y * w + x]) ring.push((y + y0) * width + (x + x0));
    }
  }
  return ring;
}
