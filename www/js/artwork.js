// Where a layer's artwork is: the one test every tool that draws on a
// layer uses to keep its strokes on it.
//
// ONE RULE FOR EVERY TOOL
//
// A stroke, a weight dab, a pin, a painted pierce region, a trim boundary
// or a placed joint lands only where the layer it is aimed at actually has
// pixels -- its non-transparent area. A touch or a drag past the edge of
// the artwork, into the transparent margin of its image or out into the
// empty window around it, simply does not register: nothing is written
// and nothing is added to undo.
//
// Before this, each tool clipped only to the layer's image RECTANGLE, and
// some not even to that. A brush that overhung the silhouette went on
// painting into the transparent pixels round it: a pierce region, a pin or
// a weight on a spot with no artwork, where it does nothing visible but
// still counts -- a pinned texel no one can see, a pierceable area outside
// the flesh. Asking the same question everywhere is what makes the
// behaviour the same everywhere.
//
// OPAQUE MEANS ANY ALPHA AT ALL
//
// A texel is artwork when its alpha is above zero. That is the same line
// every other part of the app draws -- the mesh's artworkBounds, the
// importer's contentBounds, CLayer's crop -- so an anti-aliased fringe
// pixel counts as the layer, exactly as the mesh already treats it.

// Whether texel (u, v) of an RGBA buffer holds any artwork. A layer with
// no pixel data at all (never the case for an imported one) is treated as
// solid, so a tool can never lock itself out of it.
export function opaqueAt(pixels, width, height, u, v) {
  if (u < 0 || v < 0 || u >= width || v >= height) return false;
  if (!pixels) return true;
  return pixels[(v * width + u) * 4 + 3] !== 0;
}

// The same, by flat texel index (v * width + u).
export function opaqueIndex(pixels, width, height, index) {
  if (index < 0 || index >= width * height) return false;
  if (!pixels) return true;
  return pixels[index * 4 + 3] !== 0;
}

// A POINT, rather than a texel, is on the artwork when it lies on the
// closed square of an opaque texel. Edges and corners count: a mesh vertex
// or a PxLink joint sits exactly on the line between pixels -- a joint
// usually sits on the boundary between two layers -- and a point on the
// edge of the artwork is on it.
export function pointOnArtwork(pixels, width, height, u, v) {
  const eps = 1e-6;
  const x0 = Math.floor(u - eps);
  const x1 = Math.floor(u + eps);
  const y0 = Math.floor(v - eps);
  const y1 = Math.floor(v + eps);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (opaqueAt(pixels, width, height, x, y)) return true;
    }
  }
  return false;
}

// The texel a point on a DEFORMED layer is over: the triangle of the mesh
// it falls in, as drawn right now, and the point's place in that triangle
// carried back to the texel it came from. Null when the point is outside
// every triangle -- off the layer entirely.
//
// `vertices` carry each vertex's texel position (u, v); `positions` are
// where the same vertices are drawn, in the same order.
export function texelUnder(vertices, positions, triangles, point) {
  for (let t = 0; t < triangles.length; t += 3) {
    const ia = triangles[t];
    const ib = triangles[t + 1];
    const ic = triangles[t + 2];
    const a = positions[ia];
    const b = positions[ib];
    const c = positions[ic];
    const den = (b.y - c.y) * (a.x - c.x) + (c.x - b.x) * (a.y - c.y);
    if (Math.abs(den) < 1e-12) continue;
    const l0 = ((b.y - c.y) * (point.x - c.x) + (c.x - b.x) * (point.y - c.y)) / den;
    const l1 = ((c.y - a.y) * (point.x - c.x) + (a.x - c.x) * (point.y - c.y)) / den;
    const l2 = 1 - l0 - l1;
    if (l0 < -1e-9 || l1 < -1e-9 || l2 < -1e-9) continue;
    const va = vertices[ia];
    const vb = vertices[ib];
    const vc = vertices[ic];
    return { u: l0 * va.u + l1 * vb.u + l2 * vc.u, v: l0 * va.v + l1 * vb.v + l2 * vc.v };
  }
  return null;
}
