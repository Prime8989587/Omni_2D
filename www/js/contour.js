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
