// A layer's own space, and the scene's.
//
// One tiny function, in a leaf module of its own so that anything which
// places texels in the scene can use it without importing mesh.js (and
// whatever mesh.js imports). mesh.js re-exports it, so every existing caller
// still finds it where it always was.

// Local image space (centre at the origin, one unit per source pixel) to
// scene pixels. With the part's integer top-left and integer scale, an
// unrotated local point lands on exact integers.
export function localToWorld(part, local) {
  const cos = Math.cos(part.rotation);
  const sin = Math.sin(part.rotation);
  const sx = local.x * part.scale;
  const sy = local.y * part.scale;
  return { x: part.centerX + sx * cos - sy * sin, y: part.centerY + sx * sin + sy * cos };
}
