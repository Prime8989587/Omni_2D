// Blend-shape morphing between two painted outlines.
//
// WHY NOT A PER-VERTEX PUSH
//
// The pierce used to move each mesh vertex on its own: a radial shove away
// from the tip, scaled by a smoothstep falloff. Every vertex decided its
// own answer, so neighbours could disagree -- and on the coarse mesh an
// unbound layer gets (6..10 cells across, whatever its size) disagreeing
// neighbours read as a torn, jagged silhouette rather than a shape
// changing. No amount of tuning fixes that, because the technique has no
// notion of the outline it is supposed to be producing.
//
// A blend shape does. The artist draws the outline they want at full
// depth; the renderer shows a point-for-point interpolation between the
// drawn rest outline and the drawn entered one. At any depth the result
// is a real shape somebody drew half of -- it cannot tear, because
// nothing is being pushed.
//
// THE FOUR STEPS
//
//   1. TRACE     each painted mask to an ordered boundary, by Moore
//                neighbourhood following around its largest blob.
//   2. RESAMPLE  both boundaries to the same fixed number of points, at
//                equal arc length, so point k on one means the same
//                fraction of the way round as point k on the other.
//   3. ALIGN     rotate one point list against the other to whichever
//                offset matches best, so the two outlines correspond
//                rather than being blended against an arbitrary seam.
//   4. WARP      give every mesh vertex mean-value coordinates against the
//                rest outline, then re-evaluate those same coordinates
//                against the blended outline.
//
// Step 4 is what makes the interior follow the edge smoothly. Mean value
// coordinates (Floater 2003) express a point inside a closed polygon as a
// weighted average of that polygon's vertices, with weights that vary
// smoothly across the interior and sum to one. Because every mesh vertex
// is the SAME weighted average of a moving outline, the interior can only
// move as smoothly as the outline does -- which is the property the
// per-vertex push never had.

// Enough to describe a hand-painted outline without making the per-frame
// evaluation expensive: the warp costs vertices x OUTLINE_POINTS.
export const OUTLINE_POINTS = 64;

// ---------------------------------------------------------------------------
// 1. Trace

// The largest 4-connected blob in a texel mask. Painting is freehand, so a
// stray speck left beside the real region should not become the outline
// that everything else is measured against.
function largestBlob(mask, width, height) {
  const seen = new Set();
  let best = null;
  for (const start of mask) {
    if (seen.has(start)) continue;
    const blob = new Set([start]);
    const stack = [start];
    seen.add(start);
    while (stack.length) {
      const index = stack.pop();
      const x = index % width;
      const y = (index - x) / width;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const next = ny * width + nx;
        if (!mask.has(next) || seen.has(next)) continue;
        seen.add(next);
        blob.add(next);
        stack.push(next);
      }
    }
    if (!best || blob.size > best.size) best = blob;
  }
  return best || new Set();
}

// Moore-neighbourhood border following: walk the outside of the blob,
// turning as tightly as it can, and come back to where it started. The
// result is the boundary texels in order, which is what an outline is.
//
// Each step resumes its search from just behind where it arrived
// (Jacob's stopping criterion), so a one-texel-wide neck is walked down
// and back rather than cutting the far side off.
const AROUND = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];

function traceBoundary(blob, width, height) {
  let start = -1;
  for (const index of blob) if (start < 0 || index < start) start = index;
  if (start < 0) return [];

  // The bounds test is not defensive tidiness: a mask is a FLAT array of
  // texels, so column -1 is the previous row's last texel and column
  // `width` is the next row's first. A region painted right up to the
  // artwork's left or right edge -- a band across a whole limb, say --
  // would have its walk wrap round to the next row and march off down the
  // image, producing an "outline" thousands of texels wide.
  const at = (x, y) => x >= 0 && y >= 0 && x < width && y < height
    && blob.has(y * width + x);
  const sx = start % width;
  const sy = (start - sx) / width;

  const path = [{ x: sx, y: sy }];
  let cx = sx;
  let cy = sy;
  let from = 4; // arrived from the left, the first direction scanned
  // A closed walk cannot be longer than the blob's own perimeter bound.
  const limit = blob.size * 8 + 16;

  for (let step = 0; step < limit; step++) {
    let moved = false;
    for (let k = 1; k <= 8; k++) {
      const dir = (from + k) % 8;
      const nx = cx + AROUND[dir][0];
      const ny = cy + AROUND[dir][1];
      if (!at(nx, ny)) continue;
      // Come back in facing the way we came, so the next scan starts
      // behind us rather than ahead.
      from = (dir + 5) % 8;
      cx = nx;
      cy = ny;
      moved = true;
      break;
    }
    if (!moved) break;                       // a single isolated texel
    if (cx === sx && cy === sy) break;       // closed the loop
    path.push({ x: cx, y: cy });
  }
  return path;
}

// ---------------------------------------------------------------------------
// 2. Resample

// `count` points spaced equally along the closed path's perimeter. Equal
// spacing is what makes index k mean the same thing on both outlines --
// "a quarter of the way round" rather than "the 17th texel somebody
// happened to paint".
function resampleClosed(path, count) {
  if (path.length === 0) return [];
  if (path.length === 1) return new Array(count).fill(null).map(() => ({ ...path[0] }));

  const spans = [];
  let perimeter = 0;
  for (let i = 0; i < path.length; i++) {
    const a = path[i];
    const b = path[(i + 1) % path.length];
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    spans.push(length);
    perimeter += length;
  }
  if (perimeter < 1e-9) return new Array(count).fill(null).map(() => ({ ...path[0] }));

  const out = [];
  let span = 0;
  let walked = 0;
  for (let i = 0; i < count; i++) {
    const target = (perimeter * i) / count;
    while (span < spans.length - 1 && walked + spans[span] < target) {
      walked += spans[span];
      span++;
    }
    const a = path[span];
    const b = path[(span + 1) % path.length];
    const t = spans[span] > 1e-9 ? (target - walked) / spans[span] : 0;
    out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 3. Align

// Two outlines traced independently start wherever their topmost-leftmost
// texel happened to be, which is not the same place on both. Blending
// them in that state twists the shape round as it morphs. This finds the
// rotation of the second list that sits closest to the first -- the
// correspondence a person would draw by eye.
//
// Both are centred first, so the match is about SHAPE rather than about
// where the two regions sit relative to each other.
function alignTo(reference, points) {
  if (reference.length !== points.length || points.length === 0) return points;
  const mid = (list) => {
    let x = 0;
    let y = 0;
    for (const p of list) { x += p.x; y += p.y; }
    return { x: x / list.length, y: y / list.length };
  };
  const a = mid(reference);
  const b = mid(points);

  let bestOffset = 0;
  let bestCost = Infinity;
  for (let offset = 0; offset < points.length; offset++) {
    let cost = 0;
    for (let i = 0; i < reference.length; i++) {
      const p = points[(i + offset) % points.length];
      const dx = (p.x - b.x) - (reference[i].x - a.x);
      const dy = (p.y - b.y) - (reference[i].y - a.y);
      cost += dx * dx + dy * dy;
      if (cost >= bestCost) break;
    }
    if (cost < bestCost) { bestCost = cost; bestOffset = offset; }
  }

  const out = new Array(points.length);
  for (let i = 0; i < points.length; i++) out[i] = points[(i + bestOffset) % points.length];
  return out;
}

// ---------------------------------------------------------------------------
// 3b. Correspond
//
// WHY EQUAL ARC LENGTH IS NOT ENOUGH ON ITS OWN
//
// Step 2 gives both outlines 64 points at equal spacing, and step 3 turns
// one against the other to the best whole-list rotation. That pairs them
// correctly only while the two shapes have the SAME arc-length
// parameterisation -- which stops being true the moment the artist draws
// the thing this feature exists for.
//
// Cut a notch into one shape and its perimeter grows. Measured on a cone
// with a V opening drawn at its tip: 173.7 texels of perimeter at rest
// against 178.5 entered. Equal spacing then slides every point past the
// notch a little further round, so the point that was the cone's top-left
// corner is now paired with somewhere slightly along the top edge -- and a
// rigid rotation cannot undo that, because the stretch is local. The
// result is a shape that changes where the artist drew nothing: 3.18 px of
// travel along a top edge that is identical in both drawings, which is
// exactly what "the top is changing pixels instead of the tip opening"
// looks like.
//
// WHAT CORRESPONDENCE ACTUALLY MEANS HERE
//
// Both shapes are drawn by one person over one piece of artwork, so they
// coincide nearly everywhere and differ in the one place being drawn. The
// correspondence a person would draw by eye is therefore: where the two
// outlines lie on top of each other, every point maps to ITSELF, and only
// across the stretch that differs does anything travel.
//
// So the coinciding stretches are found and pinned, and the rest is spread
// evenly between them.

// The closest point on a closed polyline to `point`, as a distance and a
// position measured in arc length from the start of the line.
function closestOn(point, polygon, cumulative, perimeter) {
  let bestDistance = Infinity;
  let bestAt = 0;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lengthSquared = dx * dx + dy * dy;
    let t = 0;
    if (lengthSquared > 1e-12) {
      t = ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared;
      t = t < 0 ? 0 : (t > 1 ? 1 : t);
    }
    const distance = Math.hypot(a.x + dx * t - point.x, a.y + dy * t - point.y);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestAt = cumulative[i] + Math.sqrt(lengthSquared) * t;
    }
  }
  return { distance: bestDistance, at: bestAt % perimeter };
}

function pointAt(polygon, cumulative, perimeter, at) {
  const target = ((at % perimeter) + perimeter) % perimeter;
  let i = 0;
  while (i < polygon.length - 1 && cumulative[i + 1] <= target) i++;
  const a = polygon[i];
  const b = polygon[(i + 1) % polygon.length];
  const span = cumulative[i + 1] - cumulative[i];
  const t = span > 1e-12 ? (target - cumulative[i]) / span : 0;
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

// Within this much of the other outline, a point is taken to be ON it --
// the same place in both drawings, and therefore something that must not
// move. One texel: closer than an artist can draw a difference, and
// comfortably wider than the sampling error from two independent traces.
const COINCIDENT = 1.0;

// The rest outline needs at least this many anchors before the pinning is
// trusted at all. Below it the two drawings share almost nothing, there is
// no "unchanged part" to hold still, and plain equal spacing is the honest
// answer.
const MIN_ANCHORS = 4;

export function correspondOutlines(rest, entered) {
  const n = rest.length;
  if (n === 0 || entered.length !== n) return entered;

  const cumulative = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    const a = entered[i];
    const b = entered[(i + 1) % n];
    cumulative[i + 1] = cumulative[i] + Math.hypot(b.x - a.x, b.y - a.y);
  }
  const perimeter = cumulative[n];
  if (perimeter < 1e-9) return entered;

  // Where each rest point sits on the entered outline, and whether it is
  // close enough to count as the same place in both drawings.
  const at = new Float64Array(n);
  const anchored = new Uint8Array(n);
  let anchors = 0;
  for (let i = 0; i < n; i++) {
    const hit = closestOn(rest[i], entered, cumulative, perimeter);
    at[i] = hit.at;
    if (hit.distance <= COINCIDENT) { anchored[i] = 1; anchors++; }
  }
  if (anchors < MIN_ANCHORS || anchors === n) return entered;

  // Anchors must advance around the outline in the same order the points
  // do; one that runs backwards is a mis-hit (a thin neck, two edges close
  // together) and is dropped rather than allowed to fold the shape.
  const first = anchored.indexOf(1);
  let previous = at[first];
  let travelled = 0;
  const order = [first];
  for (let step = 1; step < n; step++) {
    const i = (first + step) % n;
    if (!anchored[i]) continue;
    let advance = at[i] - previous;
    while (advance < 0) advance += perimeter;
    if (travelled + advance > perimeter) { anchored[i] = 0; continue; }
    travelled += advance;
    previous = at[i];
    order.push(i);
  }
  if (order.length < MIN_ANCHORS) return entered;

  // Every point between two anchors is spread evenly along the entered
  // outline between them -- so a notch the artist cut gets its whole arc
  // shared out across the points that have to describe it.
  const out = new Array(n);
  for (let k = 0; k < order.length; k++) {
    const startIndex = order[k];
    const endIndex = order[(k + 1) % order.length];
    let gap = (endIndex - startIndex + n) % n;
    if (gap === 0) gap = n;
    let arc = at[endIndex] - at[startIndex];
    while (arc < 0) arc += perimeter;
    for (let step = 0; step < gap; step++) {
      const i = (startIndex + step) % n;
      out[i] = pointAt(entered, cumulative, perimeter, at[startIndex] + (arc * step) / gap);
    }
  }
  for (let i = 0; i < n; i++) if (!out[i]) out[i] = entered[i];
  return out;
}

// How much of a painted mask its biggest single piece accounts for, 0..1.
//
// An outline is ONE closed path, so a mask painted as two separate pieces
// has no single outline to be. A stray speck beside the real region is
// harmless -- it barely moves this number -- but a shape cut clean in half
// leaves about half of it behind, and blending a whole region toward one
// of its halves is exactly the torn silhouette this module exists to
// avoid. Callers check this and decline rather than blend nonsense.
export function blobCoverage(mask, width, height) {
  if (!mask || mask.size === 0) return 0;
  return largestBlob(mask, width, height).size / mask.size;
}

// A painted mask to an outline of OUTLINE_POINTS points, in texel space.
export function outlineOf(mask, width, height, count = OUTLINE_POINTS) {
  if (!mask || mask.size === 0) return [];
  const path = traceBoundary(largestBlob(mask, width, height), width, height);
  // Texel CENTRES, matching every other coordinate this app measures in.
  return resampleClosed(path.map((p) => ({ x: p.x + 0.5, y: p.y + 0.5 })), count);
}

export function alignOutline(reference, outline) {
  return alignTo(reference, outline);
}

// ---------------------------------------------------------------------------
// 4. Warp

const EPSILON = 1e-8;

// Mean value coordinates of one point against a closed polygon: weights
// that sum to 1 and vary smoothly, so the same weights evaluated against a
// moved polygon give the point's matching position inside the moved shape.
//
// Outside the polygon the weights still sum to 1 and still vary smoothly,
// which is the reason this was chosen over barycentric schemes that are
// only defined inside: a mesh covers the whole layer, and vertices beyond
// the painted region have to follow it without a discontinuity at the
// boundary.
export function meanValueWeights(point, polygon) {
  const n = polygon.length;
  const weights = new Float64Array(n);
  if (n === 0) return weights;

  const dx = new Float64Array(n);
  const dy = new Float64Array(n);
  const radius = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    dx[i] = polygon[i].x - point.x;
    dy[i] = polygon[i].y - point.y;
    radius[i] = Math.hypot(dx[i], dy[i]);
    // Sitting on a polygon vertex: that vertex IS the answer.
    if (radius[i] < EPSILON) {
      weights[i] = 1;
      return weights;
    }
  }

  let total = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const cross = dx[i] * dy[j] - dy[i] * dx[j];
    const dot = dx[i] * dx[j] + dy[i] * dy[j];
    // tan(half the angle between the two spokes), by the half-angle
    // identity -- stable where the plain arctangent is not.
    const denominator = radius[i] * radius[j] + dot;
    const half = Math.abs(denominator) < EPSILON ? 0 : cross / denominator;
    weights[i] += half / radius[i];
    weights[j] += half / radius[j];
  }
  for (let i = 0; i < n; i++) total += weights[i];
  if (Math.abs(total) < EPSILON) {
    // Degenerate (a point exactly on an edge, a collapsed polygon): fall
    // back to an even share rather than dividing by nothing.
    weights.fill(1 / n);
    return weights;
  }
  for (let i = 0; i < n; i++) weights[i] /= total;
  return weights;
}

// Where a set of weights lands on a given outline.
export function evaluateWeights(weights, polygon) {
  let x = 0;
  let y = 0;
  for (let i = 0; i < polygon.length; i++) {
    x += weights[i] * polygon[i].x;
    y += weights[i] * polygon[i].y;
  }
  return { x, y };
}

// The outline at a given depth: point for point between the two drawn
// shapes. t of 0 is rest, 1 is entered, and anything between is a real
// shape rather than an approximation of one.
export function blendOutlines(rest, entered, t) {
  const out = new Array(rest.length);
  for (let i = 0; i < rest.length; i++) {
    out[i] = {
      x: rest[i].x + (entered[i].x - rest[i].x) * t,
      y: rest[i].y + (entered[i].y - rest[i].y) * t,
    };
  }
  return out;
}
