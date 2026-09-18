// Pixel operations for PCreate's drawing tools.
//
// EVERY OPERATION HERE IS PURE AND DOM-FREE, DELIBERATELY
//
// A drawing tool is exactly the kind of code that looks right on screen
// while being subtly wrong -- an outline one pixel thick on three sides and
// two on the fourth, a 90-degree rotation that loses the last column, a
// "blend" that quietly invents a colour when there was nothing to blend.
// None of that is visible by eye on pixel art at 8x zoom, and all of it is
// trivially checkable against a hand-built array. So the arithmetic lives
// here, takes plain buffers and returns plain buffers, and
// tests/pixelops.mjs runs it in Node against fixtures small enough to
// reason about by hand. pcreate.js is then only responsible for deciding
// WHICH operation a gesture means -- never for the arithmetic itself.
//
// The buffer convention throughout is the app's own: a Uint8ClampedArray of
// RGBA bytes, row-major, indexed by (v * width + u) * 4. An "index set" is
// a Set of v * width + u texel indices -- the same sparse representation
// every other mask in the app already uses (pierceRegion, pins, CLayer's
// boundary and fill).
//
// NOTHING HERE EVER INTERPOLATES A COLOUR IT WAS NOT ASKED FOR. Rotation
// and flips sample nearest-neighbour, shapes are a hard in-or-out test per
// texel, and the one operation that does produce a new colour (blendAt)
// produces exactly one, only when asked, and refuses when the result would
// not be distinct from what is already there.

// ---------------------------------------------------------------------------
// Reading and writing single texels

export function samplePixel(pixels, width, u, v) {
  const o = (v * width + u) * 4;
  return [pixels[o], pixels[o + 1], pixels[o + 2], pixels[o + 3]];
}

export function writePixel(pixels, width, u, v, rgba) {
  const o = (v * width + u) * 4;
  pixels[o] = rgba[0];
  pixels[o + 1] = rgba[1];
  pixels[o + 2] = rgba[2];
  pixels[o + 3] = rgba[3];
}

export function sameColor(a, b) {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
}

// A true per-channel midpoint, alpha included. Alpha is averaged like any
// other channel rather than special-cased: blending an opaque texel against
// an empty one is a legitimate thing to ask for, and the honest midpoint of
// "solid" and "nothing" is "half there".
export function midpointColor(a, b) {
  return [
    Math.round((a[0] + b[0]) / 2),
    Math.round((a[1] + b[1]) / 2),
    Math.round((a[2] + b[2]) / 2),
    Math.round((a[3] + b[3]) / 2),
  ];
}

export function inBounds(u, v, width, height) {
  return u >= 0 && v >= 0 && u < width && v < height;
}

// ---------------------------------------------------------------------------
// The brush
//
// A square stamp centred as closely as an even-sized square can be centred:
// the origin offset floor((size - 1) / 2) puts the extra row/column of an
// even brush down and to the right of the touch point, which is the same
// choice CLayer's boundary brush and Px Pin's already make. Consistency
// matters more than which side the bias falls on -- a brush that centred
// differently from every other brush in the app would feel broken even
// while being defensible in isolation.

export function squareIndices(u, v, size, width, height) {
  const origin = Math.floor((size - 1) / 2);
  const indices = [];
  for (let dv = 0; dv < size; dv++) {
    for (let du = 0; du < size; du++) {
      const tu = u - origin + du;
      const tv = v - origin + dv;
      if (inBounds(tu, tv, width, height)) indices.push(tv * width + tu);
    }
  }
  return indices;
}

// Every texel a fast drag passes through, not just its endpoints -- the
// same interpolation CLayer's stampLine uses, and for the same reason: a
// quick stroke sampled only where pointermove happened to fire would paint
// a dotted line rather than a continuous one. Consecutive texels are always
// at least diagonally adjacent, which is also what lets a Select boundary
// drawn with this seal against a 4-connected fill.
export function lineTexels(from, to) {
  const steps = Math.max(Math.abs(to.u - from.u), Math.abs(to.v - from.v));
  if (steps <= 0) return [{ u: to.u, v: to.v }];
  const run = [];
  for (let i = 1; i <= steps; i++) {
    run.push({
      u: Math.round(from.u + ((to.u - from.u) * i) / steps),
      v: Math.round(from.v + ((to.v - from.v) * i) / steps),
    });
  }
  return run;
}

export function paintIndices(pixels, indices, rgba) {
  for (const index of indices) {
    const o = index * 4;
    pixels[o] = rgba[0];
    pixels[o + 1] = rgba[1];
    pixels[o + 2] = rgba[2];
    pixels[o + 3] = rgba[3];
  }
}

// The eraser, and the "clear the selection" action: back to a genuinely
// empty texel (0,0,0,0), not a dimmed or white one.
export function clearIndices(pixels, indices) {
  for (const index of indices) {
    const o = index * 4;
    pixels[o] = 0;
    pixels[o + 1] = 0;
    pixels[o + 2] = 0;
    pixels[o + 3] = 0;
  }
}

// ---------------------------------------------------------------------------
// Shapes
//
// All three shapes are defined the same way: a predicate that answers "is
// this texel inside the shape", evaluated over the drag's bounding box. That
// one decision buys three properties worth having:
//
//   * every shape is hard-edged by construction, because a texel is inside
//     or it is not and there is no third answer;
//   * Outline mode is the same set minus its own interior, so an outline is
//     always exactly one texel thick on every side, including the diagonal
//     sides of a triangle, and is always a strict subset of the filled
//     version of the same drag; and
//   * a shape dragged to a 1xN or Nx1 box still produces something sensible
//     rather than collapsing to nothing.

function boundsOf(a, b, width, height) {
  const x0 = Math.max(0, Math.min(a.u, b.u));
  const x1 = Math.min(width - 1, Math.max(a.u, b.u));
  const y0 = Math.max(0, Math.min(a.v, b.v));
  const y1 = Math.min(height - 1, Math.max(a.v, b.v));
  return { x0, x1, y0, y1 };
}

function collect(width, height, box, isInside) {
  const inside = new Set();
  for (let v = box.y0; v <= box.y1; v++) {
    for (let u = box.x0; u <= box.x1; u++) {
      if (isInside(u, v)) inside.add(v * width + u);
    }
  }
  return inside;
}

// A texel is on the outline when it is inside the shape and at least one of
// its four neighbours is not. Anything past the canvas edge counts as
// outside, so a shape dragged hard against the border still gets a visible
// border of its own rather than silently losing that side.
export function outlineOf(inside, width, height) {
  const edge = new Set();
  for (const index of inside) {
    const u = index % width;
    const v = (index - u) / width;
    const neighbours = [[u - 1, v], [u + 1, v], [u, v - 1], [u, v + 1]];
    for (const [nu, nv] of neighbours) {
      if (!inBounds(nu, nv, width, height) || !inside.has(nv * width + nu)) {
        edge.add(index);
        break;
      }
    }
  }
  return edge;
}

export function squareShape(a, b, width, height, filled) {
  const box = boundsOf(a, b, width, height);
  if (box.x1 < box.x0 || box.y1 < box.y0) return new Set();
  const inside = collect(width, height, box, () => true);
  return filled ? inside : outlineOf(inside, width, height);
}

// An ellipse inscribed in the drag box, by the normalised-radius test. Half
// a texel is added to each radius so that a box an odd number of texels
// wide still produces a circle with a real centre texel rather than a ring
// with a hole in it.
export function circleShape(a, b, width, height, filled) {
  const box = boundsOf(a, b, width, height);
  if (box.x1 < box.x0 || box.y1 < box.y0) return new Set();
  const cx = (box.x0 + box.x1) / 2;
  const cy = (box.y0 + box.y1) / 2;
  const rx = (box.x1 - box.x0) / 2 + 0.5;
  const ry = (box.y1 - box.y0) / 2 + 0.5;
  const inside = collect(width, height, box, (u, v) => {
    const dx = (u - cx) / rx;
    const dy = (v - cy) / ry;
    return dx * dx + dy * dy <= 1;
  });
  return filled ? inside : outlineOf(inside, width, height);
}

// An isoceles triangle filling the drag box: apex at the top-centre, base
// along the bottom edge. A drag defines a box, and a box defines exactly one
// such triangle, so the gesture stays the same "drag from a start point to
// define the shape's bounding size" the other two shapes use rather than
// needing three separate taps for three corners.
export function triangleShape(a, b, width, height, filled) {
  const box = boundsOf(a, b, width, height);
  if (box.x1 < box.x0 || box.y1 < box.y0) return new Set();
  const boxHeight = box.y1 - box.y0;
  const apexX = (box.x0 + box.x1) / 2;
  const inside = collect(width, height, box, (u, v) => {
    // How far down the triangle this row sits, growing to a full-width base
    // on the last row. Rows are numbered from 1 rather than 0 deliberately:
    // sampling the top edge of each row instead gives the apex row a
    // half-width of zero AND the row below it a half-width under one texel,
    // so BOTH come out a single texel wide and the triangle grows a
    // two-texel needle on top of itself. Starting at 1 gives the apex its
    // one texel and the next row its first real widening.
    const t = boxHeight === 0 ? 1 : (v - box.y0 + 1) / (boxHeight + 1);
    const halfWidth = ((box.x1 - box.x0) / 2 + 0.5) * t;
    return Math.abs(u - apexX) <= halfWidth + 1e-9;
  });
  return filled ? inside : outlineOf(inside, width, height);
}

// ---------------------------------------------------------------------------
// Whole-buffer transforms

// turns is in quarter-turns clockwise. A 90 or 270 degree turn SWAPS the
// buffer's width and height, which is why this returns the new dimensions
// alongside the pixels rather than writing in place -- a caller that
// ignored that would silently shear a non-square canvas.
export function rotate90(pixels, width, height, turns) {
  const t = ((turns % 4) + 4) % 4;
  if (t === 0) return { pixels: new Uint8ClampedArray(pixels), width, height };

  const swap = t === 1 || t === 3;
  const outWidth = swap ? height : width;
  const outHeight = swap ? width : height;
  const out = new Uint8ClampedArray(outWidth * outHeight * 4);

  for (let v = 0; v < height; v++) {
    for (let u = 0; u < width; u++) {
      let ou;
      let ov;
      if (t === 1) { ou = height - 1 - v; ov = u; }
      else if (t === 2) { ou = width - 1 - u; ov = height - 1 - v; }
      else { ou = v; ov = width - 1 - u; }
      const from = (v * width + u) * 4;
      const to = (ov * outWidth + ou) * 4;
      out[to] = pixels[from];
      out[to + 1] = pixels[from + 1];
      out[to + 2] = pixels[from + 2];
      out[to + 3] = pixels[from + 3];
    }
  }
  return { pixels: out, width: outWidth, height: outHeight };
}

// axis: 'horizontal' mirrors left-to-right, 'vertical' mirrors top-to-bottom.
//
// FOUR NAMED DIRECTIONS, TWO DISTINCT TRANSFORMS. Mirroring is its own
// inverse: reflecting a picture "upward" across its horizontal centre line
// and reflecting it "downward" across that same line produce byte-identical
// results, and likewise for left and right. There is no arithmetic that
// could make them differ, so this takes an axis rather than a direction and
// PCreate's UI offers the two real operations under both of their names.
export function flipPixels(pixels, width, height, axis) {
  const out = new Uint8ClampedArray(pixels.length);
  for (let v = 0; v < height; v++) {
    for (let u = 0; u < width; u++) {
      const su = axis === 'horizontal' ? width - 1 - u : u;
      const sv = axis === 'vertical' ? height - 1 - v : v;
      const from = (sv * width + su) * 4;
      const to = (v * width + u) * 4;
      out[to] = pixels[from];
      out[to + 1] = pixels[from + 1];
      out[to + 2] = pixels[from + 2];
      out[to + 3] = pixels[from + 3];
    }
  }
  return out;
}

// Free-angle rotation about the buffer's centre, sampled NEAREST-NEIGHBOUR.
//
// Rotating hard pixel art to an arbitrary angle is the one place this app
// could easily end up with the soft, half-transparent edges it avoids
// everywhere else: a bilinear or smoothed sample would blend each output
// texel from up to four inputs and turn a two-colour sprite into a
// twenty-colour one. So the output grid is walked and each texel takes the
// colour of the single nearest source texel -- the result is re-snapped to
// the pixel grid by construction, with exactly the colours the input had
// and no others.
//
// expand widens the output to the source's diagonal so a rotated rectangle
// keeps its corners; without it the output keeps the input's dimensions and
// whatever swings outside them is genuinely gone.
export function rotateFree(pixels, width, height, degrees, expand = false) {
  const radians = (degrees * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);

  // The rotated bounding box per axis, not the diagonal. The diagonal is
  // the obvious guess and is one texel too SMALL in the worst case: at 45
  // degrees a square's corner texel sits further from the centre than any
  // output texel CENTRE in a diagonal-sized frame can reach, so the corners
  // get clipped by the very expansion meant to keep them. The two spare
  // texels leave a full one of margin on each side, which both absorbs the
  // half-texel rounding and keeps the guarantee easy to state and check:
  // an expanded result never touches its own border.
  const outWidth = expand ? Math.ceil(width * Math.abs(cos) + height * Math.abs(sin)) + 2 : width;
  const outHeight = expand ? Math.ceil(width * Math.abs(sin) + height * Math.abs(cos)) + 2 : height;
  const out = new Uint8ClampedArray(outWidth * outHeight * 4);

  const scx = width / 2;
  const scy = height / 2;
  const ocx = outWidth / 2;
  const ocy = outHeight / 2;

  for (let v = 0; v < outHeight; v++) {
    for (let u = 0; u < outWidth; u++) {
      // Inverse-mapped: every OUTPUT texel asks which source texel it came
      // from, so the result has no holes. Mapping forward instead would
      // leave gaps wherever two source texels rounded onto one output texel.
      const dx = u + 0.5 - ocx;
      const dy = v + 0.5 - ocy;
      const su = Math.floor(dx * cos + dy * sin + scx);
      const sv = Math.floor(-dx * sin + dy * cos + scy);
      if (!inBounds(su, sv, width, height)) continue;
      const from = (sv * width + su) * 4;
      const to = (v * outWidth + u) * 4;
      out[to] = pixels[from];
      out[to + 1] = pixels[from + 1];
      out[to + 2] = pixels[from + 2];
      out[to + 3] = pixels[from + 3];
    }
  }
  return { pixels: out, width: outWidth, height: outHeight };
}

// ---------------------------------------------------------------------------
// Regions: the selection's own arithmetic

export function regionBounds(indices, width) {
  let minU = Infinity;
  let minV = Infinity;
  let maxU = -Infinity;
  let maxV = -Infinity;
  for (const index of indices) {
    const u = index % width;
    const v = (index - u) / width;
    if (u < minU) minU = u;
    if (u > maxU) maxU = u;
    if (v < minV) minV = v;
    if (v > maxV) maxV = v;
  }
  if (minU > maxU) return null;
  return { x: minU, y: minV, width: maxU - minU + 1, height: maxV - minV + 1 };
}

// Lift a selection into its own small buffer. Texels inside the bounding box
// but OUTSIDE the selection come out fully transparent, so a lasso around an
// irregular shape carries that shape rather than its bounding rectangle.
export function extractRegion(pixels, width, indices, bounds) {
  const out = new Uint8ClampedArray(bounds.width * bounds.height * 4);
  for (const index of indices) {
    const u = index % width;
    const v = (index - u) / width;
    const to = ((v - bounds.y) * bounds.width + (u - bounds.x)) * 4;
    const from = index * 4;
    out[to] = pixels[from];
    out[to + 1] = pixels[from + 1];
    out[to + 2] = pixels[from + 2];
    out[to + 3] = pixels[from + 3];
  }
  return out;
}

// Stamp a lifted region back down at (atX, atY). Fully transparent texels in
// the region are skipped rather than punching holes in whatever is already
// underneath, which is what makes moving an irregular selection over
// existing artwork behave like moving a cut-out piece of paper. Returns the
// index set the region now occupies, so the selection can follow it.
export function blitRegion(pixels, width, height, region, regionWidth, regionHeight, atX, atY) {
  const landed = new Set();
  for (let v = 0; v < regionHeight; v++) {
    for (let u = 0; u < regionWidth; u++) {
      const from = (v * regionWidth + u) * 4;
      if (region[from + 3] === 0) continue;
      const tu = atX + u;
      const tv = atY + v;
      if (!inBounds(tu, tv, width, height)) continue;
      const index = tv * width + tu;
      const to = index * 4;
      pixels[to] = region[from];
      pixels[to + 1] = region[from + 1];
      pixels[to + 2] = region[from + 2];
      pixels[to + 3] = region[from + 3];
      landed.add(index);
    }
  }
  return landed;
}

export function offsetIndices(indices, width, height, dx, dy) {
  const moved = new Set();
  for (const index of indices) {
    const u = (index % width) + dx;
    const v = ((index - (index % width)) / width) + dy;
    if (inBounds(u, v, width, height)) moved.add(v * width + u);
  }
  return moved;
}

// ---------------------------------------------------------------------------
// Blend Colors
//
// Strictly a discrete, single-texel operation: one new colour, computed
// once, written to one texel. Never a smudge, never a gradient, never
// anything that touches a texel the user did not point at.
//
// THE REFUSAL IS THE INTERESTING PART. Two neighbours that are already the
// same colour obviously have nothing between them, but so do two that
// differ by a single unit in one channel: the midpoint of 10 and 11 rounds
// to 11, which is not a new intermediate shade, it is just one of the two
// originals wearing a different name. Writing it anyway would report
// success while changing either nothing or one texel into its neighbour. So
// the test is not "are these colours equal" but the stricter and more
// useful "is the midpoint DISTINCT FROM BOTH of them" -- which rejects the
// identical case and the indistinguishable case with one rule, and never
// invents a colour to have something to show for the tap.
export function blendAt(pixels, width, height, u, v, nu, nv) {
  if (!inBounds(u, v, width, height) || !inBounds(nu, nv, width, height)) {
    return { ok: false, reason: 'out-of-bounds' };
  }
  const a = samplePixel(pixels, width, u, v);
  const b = samplePixel(pixels, width, nu, nv);
  if (sameColor(a, b)) return { ok: false, reason: 'identical', a, b };

  const mid = midpointColor(a, b);
  if (sameColor(mid, a) || sameColor(mid, b)) {
    return { ok: false, reason: 'no-distinct-midpoint', a, b, mid };
  }
  return { ok: true, color: mid, a, b };
}

// ---------------------------------------------------------------------------
// Shadow
//
// The silhouette is every texel with any alpha at all. A shadow is that
// silhouette shifted by the light direction -- and then, crucially, minus
// the artwork itself: a drop shadow that painted over its own caster would
// not read as being BEHIND it. Restricting both steps to a selection, when
// one is active, is what makes "shadow this piece" work without shadowing
// everything else on the canvas too.

export function silhouetteIndices(pixels, width, height, restrictTo = null) {
  const out = new Set();
  const total = width * height;
  for (let index = 0; index < total; index++) {
    if (pixels[index * 4 + 3] === 0) continue;
    if (restrictTo && !restrictTo.has(index)) continue;
    out.add(index);
  }
  return out;
}

export function shadowIndices(pixels, width, height, dx, dy, restrictTo = null) {
  const silhouette = silhouetteIndices(pixels, width, height, restrictTo);
  const shifted = offsetIndices(silhouette, width, height, dx, dy);
  const out = new Set();
  for (const index of shifted) {
    if (pixels[index * 4 + 3] !== 0) continue; // never paint over the art casting it
    out.add(index);
  }
  return out;
}

// A darker, less saturated relative of what is actually on the canvas, so
// the default shadow reads as belonging to the same picture rather than as
// a generic grey dropped underneath it. The average of the opaque texels
// gives the artwork's overall hue; pulling that toward its own grey and
// then darkening it gives the shade that hue would cast.
export function suggestShadowColor(pixels, width, height, restrictTo = null) {
  let r = 0;
  let g = 0;
  let b = 0;
  let count = 0;
  const total = width * height;
  for (let index = 0; index < total; index++) {
    const o = index * 4;
    if (pixels[o + 3] === 0) continue;
    if (restrictTo && !restrictTo.has(index)) continue;
    r += pixels[o];
    g += pixels[o + 1];
    b += pixels[o + 2];
    count++;
  }
  if (count === 0) return null; // nothing on the canvas to take a cue from

  const avg = [r / count, g / count, b / count];
  const grey = (avg[0] + avg[1] + avg[2]) / 3;
  const DESATURATE = 0.4; // how far toward its own grey the hue is pulled
  const DARKEN = 0.45;
  const shade = avg.map((channel) => {
    const muted = channel + (grey - channel) * DESATURATE;
    return Math.max(0, Math.min(255, Math.round(muted * DARKEN)));
  });
  return [shade[0], shade[1], shade[2], 255];
}
