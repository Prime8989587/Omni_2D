// The PxLink solver's hook into deformation.
//
// A leaf module, like pierceState.js, and for the same reason: mesh.js has
// to ask "how is this layer corrected by its links this frame?" from inside
// deformVertices, and the solver that answers it (pxlink.js) itself imports
// mesh.js to deform the linked layers. Routing the question through a leaf
// that knows neither keeps the import graph acyclic. Until pxlink.js
// registers itself there is no solver, and every layer is uncorrected.

let solver = null;

export function registerPxLinkSolver(fn) {
  solver = fn;
}

// The correction PxLink applies to one layer under these bone transforms, or
// null when the layer is in no link. Shape (see pxlink.js):
//
//   welds                    exact local closures at each link point -- the
//                            ONLY thing a link moves
//   nearLink                 which vertices a weld reaches (left unsnapped)
//   uncorrected, mesh        the geometry the solve already computed
export function pxlinkCorrection(part, transforms) {
  return solver && part ? solver(part, transforms) : null;
}

// A point turned rigidly: p -> R(p - from) + to, with R the rotation by
// (cos, sin). Identity for a null turn. The V's halves turn about their
// hinges with it.
export function carryByCorrection(correction, point) {
  if (!correction) return { x: point.x, y: point.y };
  const dx = point.x - correction.from.x;
  const dy = point.y - correction.from.y;
  return {
    x: correction.to.x + dx * correction.cos - dy * correction.sin,
    y: correction.to.y + dx * correction.sin + dy * correction.cos,
  };
}

// ---------------------------------------------------------------------------
// Where a texel point is on a deformed layer
//
// A link point, and a pierced half's hinge, are both stored in a layer's own
// texel space and have to be found on the layer however its bones, pins and
// springs have bent it this frame. Both use these two functions -- one rule
// for "where is this point of the artwork right now", in one place.

function barycentric(a, b, c, u, v) {
  const den = (b.v - c.v) * (a.u - c.u) + (c.u - b.u) * (a.v - c.v);
  if (Math.abs(den) < 1e-12) return null;
  const l0 = ((b.v - c.v) * (u - c.u) + (c.u - b.u) * (v - c.v)) / den;
  const l1 = ((c.v - a.v) * (u - c.u) + (a.u - c.u) * (v - c.v)) / den;
  return [l0, l1, 1 - l0 - l1];
}

// The triangle a texel point sits in, with its barycentric coordinates. A
// point outside the mesh -- drawn just past a layer's edge -- uses the
// NEAREST triangle, extended affinely: the layer carries the point as if its
// surface continued a little past its own edge.
export function locateTexel(uvs, triangles, u, v) {
  let best = null;
  let bestOutside = Infinity;
  for (let t = 0; t < triangles.length; t += 3) {
    const ids = [triangles[t], triangles[t + 1], triangles[t + 2]];
    const bary = barycentric(uvs[ids[0]], uvs[ids[1]], uvs[ids[2]], u, v);
    if (!bary) continue;
    const outside = Math.max(0, -bary[0], -bary[1], -bary[2]);
    if (outside < bestOutside) { bestOutside = outside; best = { ids, bary }; }
    if (outside === 0) break;
  }
  return best;
}

// Where a located point lands among these vertex positions.
export function landTexel(positions, located) {
  const [a, b, c] = located.ids.map((i) => positions[i]);
  const [l0, l1, l2] = located.bary;
  return { x: l0 * a.x + l1 * b.x + l2 * c.x, y: l0 * a.y + l1 * b.y + l2 * c.y };
}
