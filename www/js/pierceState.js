// The pierce solver's spring state, and nothing else.
//
// This module exists to keep the import graph acyclic. The solver
// (pierce.js) needs mesh.js's geometry helpers, and mesh.js needs to read
// the solver's current displacement while it deforms -- which would be a
// cycle if they imported each other directly. Both import THIS instead,
// which imports nothing at all.
//
// The numbers are simulation state, not authored data, so they live here
// rather than on the Part: reloading a project rebuilds every Part, and
// flesh should come back at rest rather than restoring some half-pushed
// instant, for the same reason a spring bone's simulated angle is not
// saved either.

const state = new Map();

// The per-vertex arrays for one layer, created on first use and rebuilt
// whenever the mesh's vertex count changes (a re-bind at a new density).
export function pierceStateFor(partId, vertexCount) {
  let entry = state.get(partId);
  if (!entry || entry.count !== vertexCount) {
    entry = {
      count: vertexCount,
      offsetX: new Float64Array(vertexCount),
      offsetY: new Float64Array(vertexCount),
      velocityX: new Float64Array(vertexCount),
      velocityY: new Float64Array(vertexCount),
    };
    state.set(partId, entry);
  }
  return entry;
}

// What the renderer adds on: this layer's current displacement, or null
// when it has none. READ-ONLY by contract -- the solver owns these numbers
// and advances them once per frame in the physics loop. If drawing
// advanced them too, the simulation would run once per redraw rather than
// once per frame, and would speed up on a busy screen.
export function pierceOffsets(part) {
  if (!part || !part.isPierced || !part.mesh) return null;
  const entry = state.get(part.id);
  if (!entry || entry.count !== part.mesh.vertices.length) return null;
  return entry;
}

export function peekPierceState(partId) {
  return state.get(partId) || null;
}

export function resetPierceState() {
  state.clear();
}
