// The local shape of a pierce: a triangular notch, and the material that
// bunches around it.
//
// WHY NOT TWO PAINTED OUTLINES
//
// The system this replaces asked the artist to draw the pierceable shape
// twice -- once at rest, once "entered" -- and blended between the two
// outlines point for point. On a rectangle or a cone that works: trace
// both, resample each to 64 points at equal arc length, and point 17 means
// the same place on both shapes.
//
// On real character art it does not, and cannot. Two freehand-painted
// outlines of an organic shape have different perimeters, different local
// detail, and no agreement about which point corresponds to which. Every
// fix for that -- rigid rotation, then pinning the stretches that coincide
// -- narrowed the failure without removing it, because the premise is
// wrong: there is no reliable correspondence to find between two hand
// drawings of a curvy silhouette. It also asked the artist to draw a whole
// second silhouette to express what is usually one small local change.
//
// WHAT THIS DOES INSTEAD
//
// A pierce makes a dent, and a dent has a shape you can state in two
// numbers: how deep and how wide. So the artist types those, and the app
// builds the wedge:
//
//        base, WIDTH across the surface
//     b1 ------------------ b2        <- the region's outline
//         \              /
//          \            /             <- the notch, cut out of the artwork
//           \          /
//            \        /   DEPTH along the approach
//             \      /
//              \    /
//               apex                  <- pointing inward, down the axis
//
// Both sizes scale with the contact's depth fraction, so the wedge starts
// at nothing and grows continuously as the piercer goes in, and shrinks
// back through the same values on the way out. Nothing is integrated and
// nothing is remembered: a given depth always produces exactly the same
// wedge, which is what makes the whole effect reversible for free.
//
// The cut is a per-TEXEL mask rather than a mesh deformation, so the notch
// is pixel-exact whatever the mesh density is -- the failure mode that
// sank the outline blend (a mesh too coarse to carry the shape) cannot
// happen to it.
//
// AND THE MATERIAL HAS TO GO SOMEWHERE
//
// A wedge pushed into something does not leave a clean hole with dead
// artwork around it. The material it displaces piles up at the rim. So the
// artist paints WHICH pixels are allowed to do that -- the Deformable mask
// in its new meaning -- and those get shoved along the wedge's own faces,
// outward, by an amount that falls off with distance from the notch and
// grows with depth. One wedge, one push, driven by the same number.

// How far the displaced material rises, as a fraction of the dent's depth.
// The wedge has to put what it removes somewhere, and at a bit under half
// the depth the rim reads as gathered without looking like a second,
// separate bulge sitting next to the notch.
const BUNCH_RISE = 0.45;

// How far from the notch the bunching reaches, as a multiple of the larger
// dent dimension. Deliberately NOT scaled by the depth fraction: the area
// that responds is a property of the dent the artist configured, and only
// the AMOUNT it moves grows as the piercer goes in. Scaling the reach too
// makes the rim crawl outward as it rises, which reads as the material
// spreading rather than gathering.
const BUNCH_REACH = 0.85;

// A floor on that reach, so a very small dent still has a rim rather than
// a one-texel-wide crease nothing can land in.
const MIN_REACH = 2;

// ---------------------------------------------------------------------------
// Texel space

// Scene coordinates back into the layer's own pixel grid. localToWorld's
// inverse, with the half-size added so the result is in texels rather than
// centred local units -- the space every painted mask already lives in.
//
// THE CARRIAGE IS NOT OPTIONAL ON A BOUND LAYER
//
// localToWorld reads the part's own x/y, which on a bound layer are its
// REST coordinates: dragging the character around moves what is drawn
// without changing them by one pixel. Every scene-space number the solver
// works from -- the tip, the surface scalar -- comes out of regionPoints,
// which adds pinCarriageOffset on top precisely for that reason. Inverting
// only the rest transform therefore lands the wedge wherever the layer
// USED to be. Measured on a 32-texel-wide bound layer after a 36 px
// whole-character drag: the notch's base came out at texel x = 52, twenty
// texels off the right-hand edge of the artwork, so nothing was cut and no
// vertex was anywhere near enough to bunch.
export function worldToTexel(part, point, carriage = null) {
  const cos = Math.cos(-part.rotation);
  const sin = Math.sin(-part.rotation);
  const dx = point.x - (carriage ? carriage.x : 0) - part.centerX;
  const dy = point.y - (carriage ? carriage.y : 0) - part.centerY;
  const scale = part.scale || 1;
  return {
    x: (dx * cos - dy * sin) / scale + part.naturalWidth / 2,
    y: (dx * sin + dy * cos) / scale + part.naturalHeight / 2,
  };
}

// A DIRECTION into the same space: rotation only, no translation, and
// re-normalised because a uniform scale leaves the direction alone but
// floating point does not.
function directionToTexel(part, vector) {
  const cos = Math.cos(-part.rotation);
  const sin = Math.sin(-part.rotation);
  const x = vector.x * cos - vector.y * sin;
  const y = vector.x * sin + vector.y * cos;
  const length = Math.hypot(x, y);
  return length < 1e-9 ? null : { x: x / length, y: y / length };
}

// ---------------------------------------------------------------------------
// The wedge

// The triangle this contact currently makes, in the pierced layer's texel
// space -- or null when there is no dent to make: nothing configured, no
// measurable surface, or a depth fraction of zero.
export function dentTriangle(part, contact) {
  if (!part || !contact || !contact.axis) return null;
  if (!Number.isFinite(contact.surface)) return null;
  const depth = part.pierceDentDepth || 0;
  const width = part.pierceDentWidth || 0;
  if (depth <= 0 || width <= 0) return null;
  const t = contact.t || 0;
  if (t <= 0) return null;

  // Where the axis through the tip crosses the region's surface. The
  // surface scalar is measured along the axis by the same sweep that
  // measures the gap, so this is the point the contact is actually at
  // rather than wherever the tip's middle happens to be.
  const along = contact.tip.x * contact.axis.x + contact.tip.y * contact.axis.y;
  const reach = contact.surface - along;
  const scene = {
    x: contact.tip.x + contact.axis.x * reach,
    y: contact.tip.y + contact.axis.y * reach,
  };

  const base = worldToTexel(part, scene, contact.carriage);
  const inward = directionToTexel(part, contact.axis);
  if (!inward) return null;
  const across = { x: -inward.y, y: inward.x };

  const half = (width * t) / 2;
  const reachIn = depth * t;
  return {
    // The two ends of the base, lying along the surface.
    b1: { x: base.x + across.x * half, y: base.y + across.y * half },
    b2: { x: base.x - across.x * half, y: base.y - across.y * half },
    // The point, driven inward along the approach.
    apex: { x: base.x + inward.x * reachIn, y: base.y + inward.y * reachIn },
    base,
    inward,
    across,
    depth: reachIn,
    width: width * t,
    reach: Math.max(MIN_REACH, Math.max(depth, width) * BUNCH_REACH),
    rise: BUNCH_RISE * depth * t,
  };
}

function edge(ax, ay, bx, by, px, py) {
  return (bx - ax) * (py - ay) - (by - ay) * (px - ax);
}

// Whether a point is inside the wedge, by the same all-edges-one-sign test
// the rasterizer uses -- so a texel is judged cut or not cut on exactly
// the rule that decides every other pixel in this renderer.
function inside(tri, x, y) {
  const w0 = edge(tri.b1.x, tri.b1.y, tri.b2.x, tri.b2.y, x, y);
  const w1 = edge(tri.b2.x, tri.b2.y, tri.apex.x, tri.apex.y, x, y);
  const w2 = edge(tri.apex.x, tri.apex.y, tri.b1.x, tri.b1.y, x, y);
  return (w0 >= 0 && w1 >= 0 && w2 >= 0) || (w0 <= 0 && w1 <= 0 && w2 <= 0);
}

// ---------------------------------------------------------------------------
// The cut

// One scratch buffer per layer, reused every frame. A dent changes on
// every frame of a drag, and a layer's mask is one byte per source texel
// -- allocating that afresh sixty times a second is a megabyte a second of
// garbage on a large layer for no reason. Only the texels actually touched
// last frame are reset, so the work is proportional to the dent rather
// than to the artwork.
const cutCache = new Map();

function cutBuffer(part) {
  const size = part.naturalWidth * part.naturalHeight;
  let entry = cutCache.get(part.id);
  if (!entry || entry.mask.length !== size) {
    entry = { mask: new Uint8Array(size).fill(1), box: null };
    cutCache.set(part.id, entry);
  }
  return entry;
}

function clearBox(entry, width) {
  if (!entry.box) return;
  const { x0, y0, x1, y1 } = entry.box;
  for (let v = y0; v <= y1; v++) {
    const row = v * width;
    for (let u = x0; u <= x1; u++) entry.mask[row + u] = 1;
  }
  entry.box = null;
}

// The layer's draw mask for this frame: 1 everywhere it should still be
// drawn, 0 on the texels the wedge has taken out. Null when nothing is cut,
// so the renderer can skip the mask entirely.
//
// The cut is intersected with the PIERCEABLE region deliberately. A dent is
// something that happens where a pierce can happen; without the
// intersection a deep enough wedge would chew through whatever else the
// layer happens to draw nearby, which is not a thing the artist asked for.
export function dentCutMask(part, tri) {
  const width = part.naturalWidth;
  const height = part.naturalHeight;
  const entry = cutBuffer(part);
  clearBox(entry, width);
  if (!tri || part.pierceRegion.size === 0) return null;

  const x0 = Math.max(0, Math.floor(Math.min(tri.b1.x, tri.b2.x, tri.apex.x)));
  const x1 = Math.min(width - 1, Math.ceil(Math.max(tri.b1.x, tri.b2.x, tri.apex.x)));
  const y0 = Math.max(0, Math.floor(Math.min(tri.b1.y, tri.b2.y, tri.apex.y)));
  const y1 = Math.min(height - 1, Math.ceil(Math.max(tri.b1.y, tri.b2.y, tri.apex.y)));
  if (x1 < x0 || y1 < y0) return null;

  let cut = 0;
  for (let v = y0; v <= y1; v++) {
    const row = v * width;
    for (let u = x0; u <= x1; u++) {
      const index = row + u;
      if (!part.pierceRegion.has(index)) continue;
      // Texel CENTRES, the same sample point the rasterizer decides every
      // other pixel on.
      if (!inside(tri, u + 0.5, v + 0.5)) continue;
      entry.mask[index] = 0;
      cut++;
    }
  }
  if (cut === 0) return null;
  // The island sweep below can zero a texel in the one-texel ring just
  // outside the wedge, so the box remembered for next frame's reset has to
  // cover that ring too -- otherwise a texel cut there would never be put
  // back, and the notch would leave a permanent nick behind it.
  entry.box = {
    x0: Math.max(0, x0 - 1),
    y0: Math.max(0, y0 - 1),
    x1: Math.min(width - 1, x1 + 1),
    y1: Math.min(height - 1, y1 + 1),
  };
  sweepIslands(part, entry, x0, y0, x1, y1);
  return entry.mask;
}

// WHAT THE WEDGE BREAKS OFF, IT TAKES WITH IT
//
// The notch is cut out of artwork whose own boundary wobbles, and where the
// wedge's mouth meets a bump in that boundary it can clip the bump's base
// away and leave the top of it floating. Measured on a 96-texel organic
// blob swept from Enter to End one scene pixel at a time: a single texel
// detached from the silhouette at five of 71 positions -- a speck hanging
// in the air just above the opening. Transient, one pixel, and on pixel art
// unmistakable.
//
// It is the CUT that does this, not the bunching: with the Deformable mask
// cleared the speck appears at exactly the same five positions, and with
// the dent set to zero it never appears at all.
//
// So anything the wedge strands is taken with it. The search is confined to
// the wedge's own bounding box plus a one-texel ring: everything still
// joined to that ring is joined to the rest of the artwork, and anything
// left over is an island. An island is only removed if it actually touches
// something this wedge cut, so a speck the artist drew detached stays
// exactly as drawn.
function sweepIslands(part, entry, bx0, by0, bx1, by1) {
  const width = part.naturalWidth;
  const height = part.naturalHeight;
  const x0 = Math.max(0, bx0 - 1);
  const y0 = Math.max(0, by0 - 1);
  const x1 = Math.min(width - 1, bx1 + 1);
  const y1 = Math.min(height - 1, by1 + 1);
  const w = x1 - x0 + 1;
  const h = y1 - y0 + 1;
  if (w <= 2 || h <= 2) return;

  const alive = (u, v) => {
    const index = v * width + u;
    return entry.mask[index] === 1 && part.pixels[index * 4 + 3] > 0;
  };
  const seen = new Uint8Array(w * h);
  const stack = [];
  // Seed from the ring: anything reachable from the box's border is part of
  // the artwork at large, whatever shape the notch left behind.
  const seed = (u, v) => {
    if (u < x0 || v < y0 || u > x1 || v > y1) return;
    const k = (v - y0) * w + (u - x0);
    if (seen[k] || !alive(u, v)) return;
    seen[k] = 1;
    stack.push(k);
  };
  for (let u = x0; u <= x1; u++) { seed(u, y0); seed(u, y1); }
  for (let v = y0; v <= y1; v++) { seed(x0, v); seed(x1, v); }
  while (stack.length) {
    const k = stack.pop();
    const u = x0 + (k % w);
    const v = y0 + Math.floor(k / w);
    for (let dv = -1; dv <= 1; dv++) {
      for (let du = -1; du <= 1; du++) {
        if (du === 0 && dv === 0) continue;
        seed(u + du, v + dv);
      }
    }
  }

  for (let v = y0; v <= y1; v++) {
    for (let u = x0; u <= x1; u++) {
      const k = (v - y0) * w + (u - x0);
      if (seen[k] || !alive(u, v)) continue;
      // Stranded. Only the wedge's doing counts: at least one neighbour has
      // to be a texel this cut actually took out.
      let bythis = false;
      for (let dv = -1; dv <= 1 && !bythis; dv++) {
        for (let du = -1; du <= 1; du++) {
          const nu = u + du;
          const nv = v + dv;
          if (nu < 0 || nv < 0 || nu >= width || nv >= height) continue;
          const n = nv * width + nu;
          if (entry.mask[n] === 0 && part.pixels[n * 4 + 3] > 0) { bythis = true; break; }
        }
      }
      if (bythis) entry.mask[v * width + u] = 0;
    }
  }
}

// How many texels the wedge currently takes out, without building a mask.
// The growth of this number over a depth sweep is what "smoothly and
// continuously" means in a renderer that can only ever remove whole texels.
export function dentCutArea(part, tri) {
  if (!tri || !part || part.pierceRegion.size === 0) return 0;
  const width = part.naturalWidth;
  const height = part.naturalHeight;
  const x0 = Math.max(0, Math.floor(Math.min(tri.b1.x, tri.b2.x, tri.apex.x)));
  const x1 = Math.min(width - 1, Math.ceil(Math.max(tri.b1.x, tri.b2.x, tri.apex.x)));
  const y0 = Math.max(0, Math.floor(Math.min(tri.b1.y, tri.b2.y, tri.apex.y)));
  const y1 = Math.min(height - 1, Math.ceil(Math.max(tri.b1.y, tri.b2.y, tri.apex.y)));
  let cut = 0;
  for (let v = y0; v <= y1; v++) {
    const row = v * width;
    for (let u = x0; u <= x1; u++) {
      if (!part.pierceRegion.has(row + u)) continue;
      if (inside(tri, u + 0.5, v + 0.5)) cut++;
    }
  }
  return cut;
}

export function resetDentCache() {
  cutCache.clear();
}

// ---------------------------------------------------------------------------
// The bunching

function nearestOnSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  let t = 0;
  if (lengthSquared > 1e-12) {
    t = ((px - ax) * dx + (py - ay) * dy) / lengthSquared;
    t = t < 0 ? 0 : (t > 1 ? 1 : t);
  }
  return { x: ax + dx * t, y: ay + dy * t };
}

// The closest point on the wedge's BOUNDARY, not on its area. A vertex
// that happens to sit inside the wedge still gets pushed out through the
// nearest face rather than being handed a zero-length direction -- which is
// what "the material the wedge is passing through" should do.
function nearestOnWedge(tri, x, y) {
  const candidates = [
    nearestOnSegment(x, y, tri.b1.x, tri.b1.y, tri.b2.x, tri.b2.y),
    nearestOnSegment(x, y, tri.b2.x, tri.b2.y, tri.apex.x, tri.apex.y),
    nearestOnSegment(x, y, tri.apex.x, tri.apex.y, tri.b1.x, tri.b1.y),
  ];
  let best = candidates[0];
  let bestDistance = Infinity;
  for (const point of candidates) {
    const d = Math.hypot(point.x - x, point.y - y);
    if (d < bestDistance) { bestDistance = d; best = point; }
  }
  return { point: best, distance: bestDistance };
}

// WHICH PIXELS BUNCH
//
// The Deformable mask in its new meaning: the artist paints the material
// that gathers around a dent. Painted texels collapse to the mesh cells
// they sit in, exactly as pins and the old masks do -- a mesh can only
// express what its vertices can -- and the influence eases to zero about a
// cell beyond them so the gathering has no crease at its edge.
//
// EMPTY MEANS NONE, which is the opposite of what this mask used to mean
// and is the right way round for what it now does: bunching is an effect
// you ask for on the pixels you want it on, not one every pierceable pixel
// gets until told otherwise.
function bunchInfluence(mesh, part) {
  const version = `${part.pierceDeformRegionVersion || 0}`;
  if (mesh._bunchInfluence && mesh._bunchInfluenceVersion === version) {
    return mesh._bunchInfluence;
  }

  const width = part.naturalWidth;
  const height = part.naturalHeight;
  const cellW = width / Math.max(1, mesh.cols);
  const cellH = height / Math.max(1, mesh.rows);
  const radius = Math.max(1, Math.max(cellW, cellH));

  const cells = new Set();
  for (const index of part.pierceDeformRegion) {
    const cu = Math.min(mesh.cols - 1, Math.floor((index % width) / cellW));
    const cv = Math.min(mesh.rows - 1, Math.floor(Math.floor(index / width) / cellH));
    cells.add(cv * mesh.cols + cu);
  }
  const marked = [...cells].map((c) => {
    const cu = c % mesh.cols;
    const cv = Math.floor(c / mesh.cols);
    return [cu * cellW, cv * cellH, (cu + 1) * cellW, (cv + 1) * cellH];
  });

  const influence = mesh.vertices.map((vertex) => {
    const u = vertex.restLocal.x + width / 2;
    const v = vertex.restLocal.y + height / 2;
    let nearest = Infinity;
    for (const [x0, y0, x1, y1] of marked) {
      const dx = Math.max(x0 - u, 0, u - x1);
      const dy = Math.max(y0 - v, 0, v - y1);
      const d = Math.hypot(dx, dy);
      if (d < nearest) nearest = d;
      if (nearest === 0) break;
    }
    if (nearest === Infinity) return 0;
    const k = Math.max(0, Math.min(1, 1 - nearest / radius));
    return k * k * (3 - 2 * k); // smoothstep: no crease at either end
  });

  mesh._bunchInfluence = influence;
  mesh._bunchInfluenceVersion = version;
  return influence;
}

// Every vertex's displacement for this frame's wedge, written into the
// solver's per-vertex arrays in SCENE units (they are added to bone-skinned
// scene positions).
//
// Nothing here integrates and nothing is remembered. The push is a pure
// function of the wedge, so a given depth always produces the same rim, and
// withdrawing runs the identical numbers backwards to exactly zero.
export function writeBunch(mesh, part, tri, offsetX, offsetY, pins) {
  if (!tri || part.pierceDeformRegion.size === 0 || tri.rise <= 0) {
    offsetX.fill(0);
    offsetY.fill(0);
    return;
  }

  const influence = bunchInfluence(mesh, part);
  const halfW = part.naturalWidth / 2;
  const halfH = part.naturalHeight / 2;
  // Texel space to scene space: the layer's integer scale, then its
  // rotation.
  const cos = Math.cos(part.rotation) * part.scale;
  const sin = Math.sin(part.rotation) * part.scale;

  for (let i = 0; i < mesh.vertices.length; i++) {
    const pinned = pins ? pins[i] : 0;
    const share = influence[i] * (1 - pinned);
    if (share <= 0) {
      offsetX[i] = 0;
      offsetY[i] = 0;
      continue;
    }
    const u = mesh.vertices[i].restLocal.x + halfW;
    const v = mesh.vertices[i].restLocal.y + halfH;
    const { point, distance } = nearestOnWedge(tri, u, v);
    if (distance > tri.reach) {
      offsetX[i] = 0;
      offsetY[i] = 0;
      continue;
    }
    const k = 1 - distance / tri.reach;
    const fall = k * k * (3 - 2 * k);
    let dx = u - point.x;
    let dy = v - point.y;
    const length = Math.hypot(dx, dy);
    if (length < 1e-6) {
      // Exactly on a face: push straight out along that face's outward
      // normal is ambiguous, and a zero here is both harmless and honest.
      offsetX[i] = 0;
      offsetY[i] = 0;
      continue;
    }
    dx /= length;
    dy /= length;
    const amount = tri.rise * fall * share;
    const tx = dx * amount;
    const ty = dy * amount;
    offsetX[i] = tx * cos - ty * sin;
    offsetY[i] = tx * sin + ty * cos;
  }
}

// Test window: where the rim actually went, in texels, without going
// through the renderer.
export function bunchProbe(mesh, part, tri) {
  const influence = bunchInfluence(mesh, part);
  let moving = 0;
  let worst = 0;
  for (let i = 0; i < mesh.vertices.length; i++) {
    if (influence[i] <= 0) continue;
    if (!tri) continue;
    const u = mesh.vertices[i].restLocal.x + part.naturalWidth / 2;
    const v = mesh.vertices[i].restLocal.y + part.naturalHeight / 2;
    const { distance } = nearestOnWedge(tri, u, v);
    if (distance > tri.reach) continue;
    const k = 1 - distance / tri.reach;
    const fall = k * k * (3 - 2 * k);
    const amount = tri.rise * fall * influence[i];
    if (amount > 1e-9) moving++;
    worst = Math.max(worst, amount);
  }
  return { moving, worst, marked: influence.filter((k) => k > 0).length };
}
