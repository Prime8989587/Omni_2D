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
// numbers: how deep and how wide. So the artist sets those -- by dragging
// the thing itself, or by typing -- and the app builds the wedge:
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
// Both sizes scale with the dent fraction, so the wedge starts at nothing
// and grows continuously as the piercer comes in, and shrinks back through
// the same values on the way out. Nothing is integrated and nothing is
// remembered: a given fraction always produces exactly the same wedge,
// which is what makes the whole effect reversible for free.
//
// The cut is a per-TEXEL mask rather than a mesh deformation, so the notch
// is pixel-exact whatever the mesh density is -- the failure mode that
// sank the outline blend (a mesh too coarse to carry the shape) cannot
// happen to it.
//
// WHERE IT IS, IS PLACED. HOW BIG IT IS, IS DRIVEN.
//
// The dent used to appear wherever the piercer's tip happened to be
// touching, which made its position a live readout of the drag rather than
// a decision anybody got to make. It is now the other way round: the artist
// PLACES the wedge -- base point and the direction it points -- once, in
// the pierced layer's own texel grid, and it stays exactly there. The
// piercer's approach drives only HOW MUCH of it there is.
//
// The placement living in TEXEL space rather than scene space is the whole
// reason there is no longer a coordinate correction to get wrong. The
// previous version read the contact point out of the solver (scene space,
// bone carriage already folded in) and inverted the layer's rest transform
// to get back to texels -- which landed the wedge wherever a bound layer
// USED to be, twenty texels off the edge of the artwork after a modest
// drag. A number stored in the grid it is used in cannot drift from it.
//
// AND THE MATERIAL HAS TO GO SOMEWHERE
//
// A wedge pushed into something does not leave a clean hole with dead
// artwork around it. The material it displaces piles up at the rim. So the
// artist paints WHICH pixels are allowed to do that -- the Deformable mask
// -- and those get shoved outward, by an amount that falls off with
// distance from the notch and grows as the notch grows.
//
// DEFORMABLE NEVER CUTS. The notch is the wedge's doing and only the
// wedge's: it is a per-texel mask built from the triangle and intersected
// with the PIERCEABLE region, and the Deformable mask is not consulted
// anywhere in it. Deformable's only power is to move a vertex, and the one
// direction it may move it is away from the notch. See writeBunch for the
// rule and for the bug that made this worth stating: material sitting
// inside the wedge used to be pushed away from the nearest FACE, which
// points into the wedge's own interior -- so the pixels the artist marked
// as "pile up here" were dragged into the hole instead, and Deformable
// looked like it was doing the carving.

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
// Where the dent is

// The placement is stored on the layer in its own texel grid: a base point
// and the direction the apex is driven in. Both are the artist's, set by
// dragging the wedge itself in the Pierce window.
//
// A layer that has never had one placed still needs somewhere sensible for
// the handles to start, so one is derived from the pierceable paint: the
// middle of the region's topmost run, pointing at the region's middle. That
// is a point ON the outline aimed INTO the material, which is what a dent
// wants, and it is a starting position rather than a stored decision --
// the first drag replaces it with a real one.
const defaultCache = new Map();

function derivePlacement(part) {
  let top = Infinity;
  let sumX = 0;
  let sumY = 0;
  let topSum = 0;
  let topCount = 0;
  for (const index of part.pierceRegion) {
    const u = (index % part.naturalWidth) + 0.5;
    const v = Math.floor(index / part.naturalWidth) + 0.5;
    sumX += u;
    sumY += v;
    if (v < top) { top = v; topSum = u; topCount = 1; }
    else if (v === top) { topSum += u; topCount++; }
  }
  const n = part.pierceRegion.size;
  if (n === 0) {
    return { x: part.naturalWidth / 2, y: 0, angle: Math.PI / 2 };
  }
  const x = topSum / topCount;
  const y = top;
  const toMiddleX = sumX / n - x;
  const toMiddleY = sumY / n - y;
  const angle = Math.hypot(toMiddleX, toMiddleY) < 1e-6
    ? Math.PI / 2
    : Math.atan2(toMiddleY, toMiddleX);
  return { x, y, angle };
}

export function dentPlacement(part) {
  if (!part) return null;
  if (part.pierceDentPlaced) {
    return { x: part.pierceDentX, y: part.pierceDentY, angle: part.pierceDentAngle };
  }
  const version = `${part.pierceRegionVersion || 0}:${part.pierceRegion.size}`;
  const cached = defaultCache.get(part.id);
  if (cached && cached.version === version) return cached.placement;
  const placement = derivePlacement(part);
  defaultCache.set(part.id, { version, placement });
  return placement;
}

// ---------------------------------------------------------------------------
// The wedge

// The triangle at growth fraction t, in the pierced layer's texel space --
// or null when there is no dent to make: nothing configured, or a fraction
// of zero.
//
// Position and direction come from the PLACEMENT and never from t, so the
// wedge grows and shrinks about a base that does not move. t scales the two
// sizes only.
export function dentTriangleAt(part, t) {
  if (!part) return null;
  const depth = part.pierceDentDepth || 0;
  const width = part.pierceDentWidth || 0;
  if (depth <= 0 || width <= 0) return null;
  if (!(t > 0)) return null;
  const grow = t > 1 ? 1 : t;

  const placement = dentPlacement(part);
  const base = { x: placement.x, y: placement.y };
  const inward = { x: Math.cos(placement.angle), y: Math.sin(placement.angle) };
  const across = { x: -inward.y, y: inward.x };

  const half = (width * grow) / 2;
  const reachIn = depth * grow;
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
    width: width * grow,
    reach: Math.max(MIN_REACH, Math.max(depth, width) * BUNCH_REACH),
    rise: BUNCH_RISE * depth * grow,
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
  defaultCache.clear();
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

// The closest point on the wedge's BOUNDARY, not on its area, plus which
// side of that boundary the query point is on. Both halves matter: the
// distance sets how much the material moves, and the side sets which way,
// because "away from the notch" is a different direction depending on
// whether you are already in it.
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
  return { point: best, distance: bestDistance, within: inside(tri, x, y) };
}

// WHICH WAY IS AWAY
//
// Outside the wedge, away from it is away from the nearest boundary point:
// the vertex is already clear and simply gets pushed further clear.
//
// Inside the wedge it is the OPPOSITE vector -- toward that nearest point,
// out through the face it sits on. This is the correction worth naming,
// because getting it backwards is what made Deformable look like it was
// cutting. The old code used `vertex - nearest` for both cases, and inside
// a triangle that vector points from the face into the interior: material
// the artist had marked "pile up here" was driven INTO the notch instead.
// Measured on a wedge 8 texels wide and 10 deep with a rise of 1: a vertex
// 0.186 texels inside the left face came out 1.184 texels inside it --
// further in than it started, and travelling toward the middle of the hole.
//
// The magnitude for an inside vertex carries it clear of the face first
// (`distance`) and then gives it the same rim rise everything else gets, so
// the two cases agree exactly at the boundary: at distance 0 both are a
// plain `rise`.
function bunchPush(tri, x, y) {
  const { point, distance, within } = nearestOnWedge(tri, x, y);
  const dx = within ? point.x - x : x - point.x;
  const dy = within ? point.y - y : y - point.y;
  const length = Math.hypot(dx, dy);
  // Exactly on a face: there is no direction to read, and a zero here is
  // both harmless and honest.
  if (length < 1e-6) return null;
  return { x: dx / length, y: dy / length, distance, evict: within ? distance : 0 };
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
    const push = bunchPush(tri, u, v);
    if (!push || push.distance > tri.reach) {
      offsetX[i] = 0;
      offsetY[i] = 0;
      continue;
    }
    const k = 1 - push.distance / tri.reach;
    const fall = k * k * (3 - 2 * k);
    // Out of the notch first if it is in it, then the rim rise. Both terms
    // are along the same outward direction, so nothing here can ever carry
    // a vertex toward the wedge.
    const amount = (push.evict + tri.rise * fall) * share;
    const tx = push.x * amount;
    const ty = push.y * amount;
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
    const push = bunchPush(tri, u, v);
    if (!push || push.distance > tri.reach) continue;
    const k = 1 - push.distance / tri.reach;
    const fall = k * k * (3 - 2 * k);
    const amount = (push.evict + tri.rise * fall) * influence[i];
    if (amount > 1e-9) moving++;
    worst = Math.max(worst, amount);
  }
  return { moving, worst, marked: influence.filter((k) => k > 0).length };
}
