// Contact: when two layers touch, which way, and how hard.
//
// ONE CONTACT SYSTEM, TWO USES
//
// Pierce was the first thing in the app that let one layer touch another:
// a piercer's painted Tip against a pierced layer's painted Pierceable area,
// measured ALONG AN AXIS -- how far the tip's leading edge still has to go
// to reach the flesh's near face, negative once it is in -- and turned into
// a press: 0 at first touch, 1 at the End Point, up to 2 for leaning on it
// past there. Interactive (interactive.js) is the same question asked of
// any two layers marked Interactive, about their whole OUTLINES:
//
//                 regions               axis                 the press does
//   Pierce        painted Tip vs        read off the         opens the wedge
//                 painted Pierceable    piercer's artwork    and leans spring
//                                                            bones
//   Interactive   outline vs outline    the toucher's live   pushes the touched
//                                       movement             layer's structure
//
// So the measuring lives here, once, and both read it: the axial gap and
// the press are the functions Pierce has always used, moved here unchanged
// (pierce.js imports them back). What is new is only what Interactive
// needs on top: outlines instead of painted regions, and a press counted
// only through the faces the movement actually runs into (frontPress).

// ---------------------------------------------------------------------------
// Moved from pierce.js, unchanged

export function centroid(points) {
  let x = 0;
  let y = 0;
  for (const p of points) { x += p.x; y += p.y; }
  return { x: x / points.length, y: y / points.length };
}

// How far the painted tip reaches from its own middle. A broad tip pushes
// a broad area aside and a needle pushes a narrow one, which falls out of
// the artwork the user painted rather than from a number they have to
// guess at.
export function spread(points, middle) {
  let worst = 0;
  for (const p of points) worst = Math.max(worst, Math.hypot(p.x - middle.x, p.y - middle.y));
  return worst;
}

// Plain closest-pixel separation. Not what depth is measured with (see
// pierce.js's header), but it is the honest answer to "how far apart are
// these two regions" when the piercer is not pointed at the flesh at all,
// and that is the number worth reporting in that case.
//
// Exact, but it does not look at every pair unless it has to. The naive
// double loop is O(tip x flesh) -- 3.1 ms for a 160-texel tip against a
// 1024-texel area, paid every frame the loop is awake -- and this is the
// case where the piercer is NOT aimed at the flesh, which is most of the
// time. A tip point whose distance to the flesh's bounding box already
// exceeds the best pair found so far cannot beat it, so it is skipped
// whole. The answer is identical; only the work is smaller.
export function nearestSeparation(tip, flesh) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const b of flesh) {
    if (b.x < x0) x0 = b.x;
    if (b.y < y0) y0 = b.y;
    if (b.x > x1) x1 = b.x;
    if (b.y > y1) y1 = b.y;
  }

  let nearest = Infinity;
  for (const a of tip) {
    const dx = Math.max(x0 - a.x, 0, a.x - x1);
    const dy = Math.max(y0 - a.y, 0, a.y - y1);
    if (Math.hypot(dx, dy) >= nearest) continue;
    for (const b of flesh) {
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (d < nearest) nearest = d;
    }
  }
  return nearest;
}

// How far the tip still has to go, along the axis, to reach the flesh --
// negative once it is already in. Only flesh within the tip's own width of
// the axis counts: flesh off to one side is not in the path, and a needle
// travelling past a shoulder should not drive into it sideways.
//
// Returns null when nothing at all is in the path, which is NOT a gap of
// infinity -- it is "this piercer is not aimed at this flesh", and the
// caller reports the plain separation and stays disengaged.
export function axialGap(tip, flesh, tipMiddle, tipSpread, axis) {
  const reach = Math.max(1, tipSpread);
  let lead = -Infinity;
  for (const p of tip) lead = Math.max(lead, p.x * axis.x + p.y * axis.y);

  let surface = Infinity;
  for (const f of flesh) {
    const ox = f.x - tipMiddle.x;
    const oy = f.y - tipMiddle.y;
    // Distance from the axis line: the perpendicular component.
    if (Math.abs(oy * axis.x - ox * axis.y) > reach) continue;
    surface = Math.min(surface, f.x * axis.x + f.y * axis.y);
  }
  if (!Number.isFinite(surface)) return null;
  // Both numbers, not just their difference. The gap is what engagement is
  // measured from; `surface` is WHERE along the axis the flesh's near face
  // sits, which is the only thing that says where on the outline the dent's
  // base belongs. Deriving it later from the gap is not possible once
  // containment has moved the tip, so it travels with the reading that
  // produced it.
  return { gap: surface - lead, surface };
}

// Past the End Point the tip stops advancing, but the DRAG does not, and
// that leftover travel is the only thing on screen still saying "harder".
// So it goes on counting toward the press after the depth has stopped
// counting -- which is what makes leaning on something feel different from
// resting against it -- up to one more End Point's worth, and no further.
export const MAX_PRESS = 2;

// How hard this contact is pressing, 0 at first touch and 1 at the End
// Point. t is the part of it the depth accounts for; the overshoot carries
// it on past, because past End the tip has stopped advancing and the
// leftover travel is the only thing still saying "harder".
export function pressOf(contact) {
  if (!contact || !contact.engaged) return 0;
  const beyond = contact.end > 0 ? Math.min(1, contact.overshoot / contact.end) : 0;
  return Math.min(MAX_PRESS, contact.t + beyond);
}

// ---------------------------------------------------------------------------
// Outlines

// A layer's outline, in its own texels: one sample per EXPOSED SIDE of every
// opaque texel -- a side whose neighbour is transparent or off the image --
// at the middle of that side, with the side's outward normal. Per side, not
// per texel: a texel of a one-pixel line is exposed above AND below, and a
// single averaged normal there would point nowhere.
//
// This is the layer's boundary in the sense the rest of the app already
// uses it (the contour ring hugs the same edges): where its artwork stops.
// Cached against the pixels and a cheap fingerprint of them, so a frame
// never rebuilds it and an edit to the artwork does.
const outlineCache = new WeakMap();

function alphaFingerprint(pixels) {
  let sum = 0;
  for (let i = 3; i < pixels.length; i += 28) sum = (sum * 31 + pixels[i]) % 1000003;
  return sum;
}

const SIDES = [
  { du: -1, dv: 0 }, { du: 1, dv: 0 }, { du: 0, dv: -1 }, { du: 0, dv: 1 },
];

export function outlineSamples(part) {
  const pixels = part && part.pixels;
  if (!pixels) return { count: 0, u: [], v: [], nu: [], nv: [] };
  const W = part.naturalWidth;
  const H = part.naturalHeight;
  const key = `${W}x${H}:${alphaFingerprint(pixels)}`;
  const cached = outlineCache.get(pixels);
  if (cached && cached.key === key) return cached.samples;
  const opaque = (x, y) => x >= 0 && y >= 0 && x < W && y < H && pixels[(y * W + x) * 4 + 3] !== 0;
  const u = [];
  const v = [];
  const nu = [];
  const nv = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!opaque(x, y)) continue;
      for (const { du, dv } of SIDES) {
        if (opaque(x + du, y + dv)) continue;
        u.push(x + 0.5 + du * 0.5);
        v.push(y + 0.5 + dv * 0.5);
        nu.push(du);
        nv.push(dv);
      }
    }
  }
  const samples = { count: u.length, u, v, nu, nv };
  outlineCache.set(pixels, { key, samples });
  return samples;
}

// ---------------------------------------------------------------------------
// The press of one outline moving into another

// A face counts as turned against the movement when its outward normal is
// at least this far into the oncoming direction (cos ~75 degrees): the top
// of a waistband for a hand coming down onto it, not its two ends.
const FRONT_FACING = 0.25;
const FOOTPRINT_MAX = 32;

// HOW FAR ONE OUTLINE HAS RUN INTO ANOTHER
//
// Pierce's axial gap, asked slice by slice. The movement's axis cuts both
// outlines into thin slices across it; in every slice the toucher has a
// leading edge (furthest along the axis) and a trailing one. A face of the
// touched layer is being pushed when, in its slice:
//
//   * it faces the movement (its normal points back at the toucher), so a
//     hand sliding ALONG a waistband pushes nothing -- the band's top and
//     bottom face sideways to that movement, and its far end faces away;
//   * the toucher has crossed it (it has artwork behind the face as well as
//     in front), so a hand merely passing the band's end is not in it;
//   * to START a press, it lies ahead of the toucher's middle, so a hand
//     pulling back out of something it was pressing lets go -- what it had
//     pushed is now behind it -- instead of hooking it and dragging it
//     along. A press already under way (`engaged`) only needs the face
//     still crossed: in a quick push the pushed layer lags the toucher for
//     a few frames, and a small hand can briefly be more than half way into
//     it -- that is the press at its hardest, not the moment to let go.
//
// The press is how far the toucher's leading edge has gone past that face:
// Pierce's -gap, per slice, the deepest slice winning. `at` is where on the
// touched outline the push lands: the middle of every face being pressed,
// each counted by how deep it is pressed -- the middle of the hand's
// footprint, which stays put while the hand does, rather than whichever
// single texel happens to be a hair deeper this frame.
//
// Points carry scene x, y; the touched ones also their scene normal nx, ny.
// `slice` is the slice thickness in scene px (a texel of the coarser of the
// two layers, never under one pixel). Null when nothing is pressed.
export function frontPress(toucher, touched, axis, toucherMiddle, slice = 1, engaged = false) {
  if (!toucher.length || !touched.length || !axis) return null;
  const width = Math.max(1, slice);
  const lateral = (p) => (p.x * axis.y - p.y * axis.x) / width;
  const along = (p) => p.x * axis.x + p.y * axis.y;
  const lo = new Map();
  const hi = new Map();
  for (const p of toucher) {
    const k = Math.round(lateral(p));
    const a = along(p);
    if (!lo.has(k) || a < lo.get(k)) lo.set(k, a);
    if (!hi.has(k) || a > hi.get(k)) hi.set(k, a);
  }
  const middle = along(toucherMiddle);
  let deepest = 0;
  const hits = [];
  for (const f of touched) {
    if (f.nx * axis.x + f.ny * axis.y > -FRONT_FACING) continue;
    const a = along(f);
    if (!engaged && a <= middle) continue;
    const k = Math.round(lateral(f));
    let back = Infinity;
    let lead = -Infinity;
    for (let j = k - 1; j <= k + 1; j++) {
      if (!lo.has(j)) continue;
      back = Math.min(back, lo.get(j));
      lead = Math.max(lead, hi.get(j));
    }
    if (!(back < a)) continue;
    const depth = lead - a;
    if (depth <= 0) continue;
    hits.push({ f, depth });
    if (depth > deepest) deepest = depth;
  }
  if (deepest <= 0) return null;
  let x = 0;
  let y = 0;
  let rx = 0;
  let ry = 0;
  let w = 0;
  for (const { f, depth } of hits) {
    x += f.x * depth;
    y += f.y * depth;
    // The same faces where they would be if nothing were pushing them, for
    // a caller that pushes them (rx, ry; the drawn point when absent).
    rx += (f.rx ?? f.x) * depth;
    ry += (f.ry ?? f.y) * depth;
    w += depth;
  }
  // The footprint: every pressed face, unpushed -- the whole stretch of
  // outline the toucher is bearing on, a few dozen at most.
  const step = Math.max(1, Math.ceil(hits.length / FOOTPRINT_MAX));
  const footprint = [];
  for (let i = 0; i < hits.length; i += step) {
    const { f } = hits[i];
    footprint.push({ x: f.rx ?? f.x, y: f.ry ?? f.y });
  }
  return { depth: deepest, at: { x: x / w, y: y / w }, rest: { x: rx / w, y: ry / w }, footprint, faces: hits.length };
}

// ---------------------------------------------------------------------------
// Long and thin

// How long and how thick a layer's artwork is, whatever way it lies: the
// spread of its opaque texels along their two principal directions. A
// uniform bar L long has a variance of L^2/12 along its length, so
// sqrt(12 * variance) reads back its length and its thickness, in texels --
// a diagonal strap measures the same as a level one.
const shapeCache = new WeakMap();

export function elongation(part) {
  const pixels = part && part.pixels;
  if (!pixels) return { length: 0, thickness: 0 };
  const W = part.naturalWidth;
  const H = part.naturalHeight;
  const key = `${W}x${H}:${alphaFingerprint(pixels)}`;
  const cached = shapeCache.get(pixels);
  if (cached && cached.key === key) return cached.shape;
  let n = 0;
  let sx = 0;
  let sy = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (pixels[(y * W + x) * 4 + 3] === 0) continue;
      n++; sx += x; sy += y;
    }
  }
  let shape = { length: 0, thickness: 0 };
  if (n > 0) {
    const mx = sx / n;
    const my = sy / n;
    let xx = 0;
    let yy = 0;
    let xy = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (pixels[(y * W + x) * 4 + 3] === 0) continue;
        const dx = x - mx;
        const dy = y - my;
        xx += dx * dx; yy += dy * dy; xy += dx * dy;
      }
    }
    xx /= n; yy /= n; xy /= n;
    const mean = (xx + yy) / 2;
    const root = Math.sqrt(((xx - yy) / 2) ** 2 + xy * xy);
    // + 1/12 per axis: a texel is a unit square, not a point, so a bar one
    // texel thick has a variance of 1/12 across it rather than none.
    shape = {
      length: Math.sqrt(12 * (mean + root + 1 / 12)),
      thickness: Math.sqrt(12 * Math.max(0, mean - root + 1 / 12)),
    };
  }
  shapeCache.set(pixels, { key, shape });
  return shape;
}

// A waistband, a strap: at most this thick, and at least this many times
// as long as it is thick (in the layer's own texels).
export const THIN_MAX_THICKNESS = 8;
export const THIN_MIN_RATIO = 4;

export function isThinElongated(part) {
  const { length, thickness } = elongation(part);
  return thickness > 0 && thickness <= THIN_MAX_THICKNESS && length >= THIN_MIN_RATIO * thickness;
}
