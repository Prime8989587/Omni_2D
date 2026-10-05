// The Interactive push's hook into deformation.
//
// A leaf module, for the same reason pxlinkState.js is one: mesh.js has to
// ask "how far is this layer being pushed this frame?" from inside
// deformVertices, and the solver that answers it (interactive.js) itself
// imports mesh.js to find where layers are. Until interactive.js registers
// itself there is no solver, and nothing is ever pushed.

let solver = null;

export function registerPushSolver(fn) {
  solver = fn;
}

// The push on one layer this frame, or null when nothing is pushing the
// structure it belongs to. Shape (see interactive.js, THE PUSH FIELD):
//
//   d        the push, in scene px, where the toucher is pressing
//   held     scene points the structure is held at (its PxLinks to layers
//            that do not give way), each pushed not at all
//   reach    how far from the nearest held point the push takes to come
//            up to full strength
export function pushFieldOf(part) {
  return solver && part ? solver(part) : null;
}

function smooth01(x) {
  const t = Math.max(0, Math.min(1, x));
  return t * t * (3 - 2 * t);
}

// The push at one scene point: all of it where nothing holds the
// structure, none of it at a held point, and a smooth rise in between --
// so a structure held nowhere moves as one piece, and one held at a few
// places bends round them instead of tearing off them.
export function pushAt(field, x, y) {
  const { d, held, reach } = field;
  if (!held || held.length === 0) return d;
  let near = Infinity;
  for (const h of held) {
    const dx = x - h.x;
    const dy = y - h.y;
    const q = dx * dx + dy * dy;
    if (q < near) near = q;
  }
  const s = smooth01(Math.sqrt(near) / Math.max(1e-6, reach));
  return { x: d.x * s, y: d.y * s };
}

// A layer's deformed vertices, pushed.
export function applyPush(part, positions) {
  const field = pushFieldOf(part);
  if (!field) return positions;
  return positions.map((p) => {
    const d = pushAt(field, p.x, p.y);
    return { x: p.x + d.x, y: p.y + d.y };
  });
}
