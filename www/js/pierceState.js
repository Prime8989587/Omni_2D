// What the pierce solver publishes for the deformation to read.
//
// This module exists to keep the import graph acyclic. The solver
// (pierce.js) needs mesh.js's geometry helpers, and mesh.js needs to read
// the solver's current answer while it deforms -- which would be a cycle if
// they imported each other directly. Both import THIS instead, which imports
// nothing at all.
//
// The answer is one number per V: how open it is, 0 shut to 1 fully open,
// straight from the piercer's depth (see pierce.js). It is simulation state,
// not authored data, so it lives here rather than on a Part: reloading a
// project rebuilds every Part, and the halves should come back shut rather
// than restoring some half-spread instant, for the same reason a spring
// bone's simulated angle is not saved either.

let open = new Map();

// The solver's whole answer for this frame, replacing the last one: a V
// with no entry is shut.
export function publishSpreadOpen(entries) {
  open = new Map(entries);
}

// How open one V is right now. READ-ONLY by contract -- the solver owns
// these numbers and writes them once per frame.
export function spreadOpen(key) {
  return open.get(key) || 0;
}

export function resetPierceState() {
  open = new Map();
}
