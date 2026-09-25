// A layer's own space, and the scene's.
//
// One tiny function, in a module of its own because two modules that import
// each other's work both need it: mesh.js deforms layers, and spread.js --
// which mesh.js imports to open a pierced layer's V -- has to place texels in
// the scene without importing mesh.js back. mesh.js re-exports it, so every
// existing caller still finds it where it always was.

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
