// The PLink solver's hook into deformation.
//
// A leaf module, like pierceState.js, and for the same reason: mesh.js has
// to ask "how is this layer corrected by its links this frame?" from inside
// deformVertices, and the solver that answers it (plink.js) itself imports
// mesh.js to deform the linked layers. Routing the question through a leaf
// that knows neither keeps the import graph acyclic. Until plink.js
// registers itself there is no solver, and every layer is uncorrected.

let solver = null;

export function registerPLinkSolver(fn) {
  solver = fn;
}

// The correction PLink applies to one layer under these bone transforms, or
// null when the layer is in no link. Shape (see plink.js):
//
//   { cos, sin, from, to }   the rigid part: p -> R(p - from) + to
//   welds                    exact local closures at each link point
//   uncorrected, mesh        the geometry the solve already computed
export function plinkCorrection(part, transforms) {
  return solver && part ? solver(part, transforms) : null;
}

// A point carried by a layer's rigid PLink correction -- the whole-layer
// motion, without the local welds. Identity for a null correction.
export function carryByCorrection(correction, point) {
  if (!correction) return { x: point.x, y: point.y };
  const dx = point.x - correction.from.x;
  const dy = point.y - correction.from.y;
  return {
    x: correction.to.x + dx * correction.cos - dy * correction.sin,
    y: correction.to.y + dx * correction.sin + dy * correction.cos,
  };
}
