// The opening a pierce makes: a closed seam in the pierced artwork whose two
// edges bow apart around the piercer's tip.
//
// WHAT IT LOOKS LIKE, AND WHY IT IS NOT THE THINGS BEFORE IT
//
// Two earlier models got the motion wrong in opposite ways. A notch cut out
// of one surface (2.5.1's dent) removes artwork rather than moving it, so
// nothing around the hole reacts. Two rigid halves pivoting apart about
// their base points (2.4.1's V) moves the artwork, but as flat plates with
// straight edges, so what opens is a hard-edged V.
//
// What a soft seam actually does when something is pushed into it is
// neither. The material on either side of the seam is pushed OUTWARD, as
// one continuous, rounded swelling centred on the tip: most right round the
// tip, easing back to rest ahead of it and settling round the piercer's own
// width behind it. As the tip goes deeper the swelling travels with it,
// grows and reaches further along the seam; as it comes out, everything
// eases back to the rest outline through the same shapes in reverse.
//
// So that is what this builds: a PROXIMITY-BASED SOFT DISPLACEMENT of the
// two sides of a seam, in two parts.
//
//   THE SWELLING -- how far the material beside the seam is pushed out, a
//   smooth hump along the seam (openingAmplitude) that follows the tip.
//
//   THE RIM -- how far the seam's own two edges part. Never further than
//   the piercer actually reaches on that side, at that point along it
//   (openingRim): ahead of the tip the seam stays closed, round the tip it
//   wraps the tip's own outline, behind it it rests against the piercer's
//   sides. Whatever shows between the edges is therefore always the
//   piercer, drawn beneath -- never the background through a hole.
//
//                         ||                      <- closed seam ahead,
//                       ( || )                       material swelling out
//                      (  /\  )                    <- swelling widest at the
//                     (  |  |  )                     tip; rim wrapping it
//                      ( |  | )                   <- rim resting against
//                       (|  |)                       the piercer behind it
//                      --    --                   <- the surface, base end
//
// THE MARKER SAYS WHERE; THE CONTACT SAYS HOW MUCH, AND WHERE ALONG IT
//
// The artist places the triangle marker once (Paint regions… → Dent): its
// base on the surface where the piercer comes in, its apex pointing in the
// direction it travels. Its centreline IS the seam -- the line the two
// edges part along -- its depth is how far the seam runs in, and its width
// is how far apart the edges open at the tip, at full depth. Nothing is
// subtracted from the artwork, ever: the triangle is a placement tool.
//
// Every frame the live contact then supplies:
//   * how far in the piercer is, as a fraction from the Dent Trigger
//     Distance (0) to the End Point (1) -- how big the swelling is;
//   * where its leading point is ALONG the seam -- where it is centred;
//   * the outline of its tip, carried into this layer's texels -- what the
//     rim may open round, side by side and point by point.
// Nothing is integrated or remembered, so a given contact always produces
// the same shape, and backing out is the same sweep run backwards.
//
// Past the piercer's Wedge Lock Point the solver hands this module the
// contact AS IT WAS AT THE LOCK -- the fraction clamped there, the tip taken
// back to where it was (pierce.js, openingOf) -- so from the lock to the
// End Point the shape built here is one and the same.
//
// HOW THE SEAM OPENS WITHOUT TEARING ANYTHING ELSE
//
// The layer is drawn twice, through complementary per-texel masks: one
// pass for the texels on each side of the seam's centreline. Each pass
// moves its side outward by a field that is CONTINUOUS across the whole
// layer -- every vertex, both sides of the line, is moved the same way in a
// given pass -- so within a pass no triangle is torn or folded. The two
// passes move in opposite directions near the seam and not at all away
// from it; where they do not move, they draw exactly what one pass would.
// The only place they part is the seam itself, by the rim, which is exactly
// where the opening is supposed to be -- and the piercer's tip, already
// drawn beneath the layer while it is in contact, fills it.
//
// Across the seam the push starts at the rim, rises smoothly to the
// swelling a little way out, and fades to nothing further out still. It
// never falls faster than it moves sideways, so nothing folds over; where
// it rises above the rim the material stretches a little, the way it
// does round something pressed into it.
//
// The field rides on top of the layer's own deformation: bones (through the
// inverse bind), springs, PxLink welds and Px Pin all decide where the
// layer is first, and the opening displaces that surface. Pinned artwork
// holds against it through the same smooth influence Px Pin uses -- eased
// over a band that widens with the push, so a pin near the seam bends its
// neighbours rather than letting them fold or come apart.
//
// A FINER MESH, ONLY WHILE IT IS OPEN
//
// A layer's binding mesh is coarse -- six texels a cell is typical -- and a
// curve sampled only at its corners comes out as a few straight segments,
// which is to say a V. So the opening is drawn through a refined copy: every
// triangle of the layer's mesh split k×k into smaller ones (a texel and a
// half or so -- fine enough that what is drawn stays within half a pixel of
// the smooth field), each new vertex carried along inside its parent
// triangle by the parent's own deformation. Because every small triangle lies inside one
// large one, the refined mesh maps the artwork EXACTLY as the coarse one
// does wherever the field is zero -- so switching to it at first contact
// changes no pixel -- and the displacement only adds detail where the bulge
// is.
//
// THE CONTACT IS MEASURED ON THE CLOSED LAYER
//
// Contact, walls, the depth cap and force transfer all read the layer as if
// it were closed. The opening is a consequence of the contact, drawn on top;
// if it fed back into the measurement, the flesh would move away from the
// tip, the depth would drop, the seam would close, the depth would rise...
// and the edges would chatter. Measuring the closed layer is what keeps it
// a pure function of where the piercer is.

import { texelNearest, texelFrameNearest } from './artwork.js';
import { meshCellSize, pinDistances } from './mesh.js';

// The edges settle round the piercer behind its tip, but never as wide as
// AT the tip: the widest point of the bulge stays where the tip is.
const MAX_HUG = 0.85;

// How far ahead of (and behind) the tip the bulge reaches, as a multiple of
// half its full width -- and how much further that reach grows by full
// depth. The deformed stretch of edge lengthens as the piercer goes in.
const REACH_PER_HALF_WIDTH = 1;
const REACH_GROWTH = 1;

// Sideways, the displacement fades to nothing over this many times the
// current bulge, plus a fixed margin. A fade steeper than about 1.5× its
// height folds the surface over itself; anything short of that squeezes the
// material it fades through, and squeezed pixel art drops texels -- a
// one-pixel outline in the squeeze comes out dashed. 4× keeps the squeeze
// to about a third at its strongest, and puts that well out from the seam.
const LATERAL_SPREAD = 4;
const LATERAL_MARGIN = 4;

// Across the seam, the push rises from the rim to the full swelling over
// this many times the swelling's height (and at least two texels): quickly
// enough that the material just beside the rim carries the swelling,
// slowly enough that it never stretches to much more than double. Set by
// the swelling alone, not by how far the rim already is from it, so the
// material a little way out does not lurch where the rim closes in front
// of the tip.
const RISE_SPREAD = 1.35;
const MIN_RISE = 2;

// How gently the rim gives way to the piercer's outline where the two
// meet, in texels: the edge rounds that corner instead of creasing on it.
const RIM_SOFTNESS = 1;

// HOW WIDE IT OPENS: A SHARE OF THE PIERCER'S OWN WIDTH, OR A FIXED WIDTH
//
// The gap between the two edges is the pierced layer's Dilation (a
// percentage, parts.js) of the piercer's tip width -- 75% of an 8 px tip is
// a 6 px gap, of a 12 px tip a 9 px gap -- or, with the layer's wedge width
// set to Manual, exactly the pixels it names, whatever the piercer. Rounded
// to whole pixels, because a gap is a number of pixels; split between the
// two sides of the mirror line as evenly as a whole number allows, the odd
// pixel going to side B (+across) -- 7 px is 3 on side A and 4 on side B --
// rather than half a pixel each, which no pixel can show.
//
// Each edge then follows the tip's own width, row by row along the seam,
// halved about the mirror line and scaled so that its widest row is that
// side's width: the flesh hugs the piercer at that share of its width,
// wherever the piercer is in the seam -- closed ahead of it, narrow round a
// pointed front, full width where the tip is widest -- and the two sides
// are the same shape, mirror images, wherever across the line it sits. So
// the gap grows as the tip goes in, from its outline alone; the Wedge Lock
// Point needs no say in it -- past the lock the tip it is given is
// the one AT the lock (pierce.js, openingOf), so the gap holds there too.
// The swelling beside the gap is never allowed below the gap itself, so the
// material at the edge is pushed exactly the gap's width and eases out from
// there.

// The two sides of a gap of `gapPx` scene pixels, in the pierced layer's
// texels: { a, b, px } -- side A floor(px / 2), side B the rest.
export function openingSideWidths(gapPx, scale = 1) {
  const px = Math.max(0, Math.round(gapPx));
  const a = Math.floor(px / 2);
  const s = Math.max(1e-6, scale || 1);
  return { a: a / s, b: (px - a) / s, px };
}

// Where something holds the material still -- a pin, or the edge of a
// painted Deformable region -- the push has to fall to nothing between the
// two, and the material there is squeezed. Over this many times the push it
// is falling from, at least: the same gentle limit as the sideways fade, so
// a pin or a region edge right beside a deep opening bends the material
// round it instead of folding it.
const HOLD_SPREAD = 4;
// The narrowest a Deformable region's edge is ever eased over, in texels.
const DEFORM_EDGE = 1.5;

// The refined mesh's target spacing, in texels.
const REFINE_TEXELS = 1.5;
const MAX_REFINE = 8;

// ---------------------------------------------------------------------------
// Where the marker is

// The placement is stored on the layer in its own texel grid: a base point
// and the direction the apex points. Both are the artist's, set by dragging
// the marker in the Pierce window.
//
// A layer that has never had one placed still needs somewhere sensible for
// the handles to start, so one is derived from the pierceable paint: the
// middle of the region's topmost run, pointing at the region's middle --
// a point ON the outline aimed INTO the material, which is where a seam
// opens from. It is a starting position rather than a stored decision; the
// first drag replaces it with a real one.
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

// The triangle as the artist left it, before the mirror line has its say.
function trianglePlacement(part) {
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

// THE MIRROR LINE
//
// The wedge's centre, placed first (Pierce window → Dent → Mirror line),
// as a line between two texel corners. Everything about the opening is
// built about it:
//
//   * the triangle slides ALONG it -- its base is wherever the artist put
//     it, carried square onto the line; its apex points along the line, in
//     whichever of the line's two directions the artist aimed it -- so it
//     cannot be off-centre or askew however it is dragged;
//   * the two sides of the opening are mirror images about it (coverageOf):
//     each row of the seam opens to the piercer's whole width there, split
//     evenly about the line, never to how far it happens to reach on each
//     side.
//
// Until one is placed, the line is the triangle's own centreline, so a
// layer set up before the mirror line existed opens where it always did.
// { p1, p2, dir, placed } -- dir is the unit vector p1 -> p2.
export function openingMirror(part) {
  if (!part) return null;
  if (part.pierceMirrorPlaced) {
    const p1 = { x: part.pierceMirrorX1, y: part.pierceMirrorY1 };
    const p2 = { x: part.pierceMirrorX2, y: part.pierceMirrorY2 };
    const length = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    if (length > 1e-9) {
      return { p1, p2, dir: { x: (p2.x - p1.x) / length, y: (p2.y - p1.y) / length }, placed: true };
    }
  }
  const t = trianglePlacement(part);
  const dir = { x: Math.cos(t.angle), y: Math.sin(t.angle) };
  const reach = Math.max(4, part.pierceDentDepth || 0);
  return {
    p1: { x: t.x, y: t.y },
    p2: { x: t.x + dir.x * reach, y: t.y + dir.y * reach },
    dir,
    placed: false,
  };
}

// A point carried square onto the mirror line.
export function onMirror(mirror, point) {
  const along = (point.x - mirror.p1.x) * mirror.dir.x + (point.y - mirror.p1.y) * mirror.dir.y;
  return { x: mirror.p1.x + mirror.dir.x * along, y: mirror.p1.y + mirror.dir.y * along };
}

export function openingPlacement(part) {
  if (!part) return null;
  const t = trianglePlacement(part);
  const mirror = openingMirror(part);
  if (!mirror.placed) return t;
  // On the line, pointing along it: the way the triangle was aimed decides
  // which of its two directions.
  const base = onMirror(mirror, t);
  const aimed = Math.cos(t.angle) * mirror.dir.x + Math.sin(t.angle) * mirror.dir.y;
  const angle = Math.atan2(mirror.dir.y, mirror.dir.x) + (aimed < 0 ? Math.PI : 0);
  return { x: base.x, y: base.y, angle };
}

// The marker itself, at full size, in the layer's texel space -- what the
// painter draws and drags. Null when it has no size.
export function openingMarker(part) {
  if (!part) return null;
  const depth = part.pierceDentDepth || 0;
  const width = part.pierceDentWidth || 0;
  if (depth <= 0 || width <= 0) return null;
  const placement = openingPlacement(part);
  const base = { x: placement.x, y: placement.y };
  const inward = { x: Math.cos(placement.angle), y: Math.sin(placement.angle) };
  const across = { x: -inward.y, y: inward.x };
  const half = width / 2;
  return {
    b1: { x: base.x + across.x * half, y: base.y + across.y * half },
    b2: { x: base.x - across.x * half, y: base.y - across.y * half },
    apex: { x: base.x + inward.x * depth, y: base.y + inward.y * depth },
    base, inward, across, depth, width,
  };
}

// ---------------------------------------------------------------------------
// The shape of the opening

const smooth = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
// 1 at zero, easing to 0 at one, with no crease at either end.
const bump = (x) => (x >= 1 ? 0 : 0.5 * (1 + Math.cos(Math.PI * x)));

// This frame's opening, from the marker and the live contact -- or null
// when there is none: no marker size, or the piercer short of the Dent
// Trigger Distance.
//
//   fraction      0 at the Dent Trigger Distance, 1 at the End Point
//   tip           the piercer's leading point, in this layer's texel space
//   tipHalfWidth  half the tip's width across its travel, in texels
//   tipPoints     the tip's painted texels, carried into this layer's texel
//                 space -- the outline the rim may open round. Without
//                 them the tip is taken to be round-ended, tipHalfWidth
//                 across.
//   tipWidth      the tip's full width across its travel, in SCENE pixels,
//   dilation      and the share of it the gap opens to, in percent -- both
//                 or neither (without them the gap is the tip's whole
//                 outline, as before the Dilation existed)
export function openingFor(part, {
  fraction, tip, tipHalfWidth = 0, tipPoints = null, tipWidth = 0, dilation = null,
}) {
  const marker = openingMarker(part);
  if (!marker || !(fraction > 0) || !tip) return null;
  const f = Math.min(1, fraction);
  const { base, inward, across } = marker;
  const length = marker.depth;
  const halfWidth = marker.width / 2;
  // Where along the seam the leading point is: its distance in from the
  // base. The swelling is centred there, kept on the seam -- short of the
  // surface, the surface flinches first.
  const sApex = (tip.u - base.x) * inward.x + (tip.v - base.y) * inward.y;
  const sTip = Math.max(0, Math.min(length, sApex));
  // The gap's two sides (see HOW WIDE IT OPENS): a fixed number of pixels
  // when the layer says so, whatever the piercer; otherwise the Dilation's
  // share of the tip.
  const manual = part.pierceWedgeMode === 'manual' && part.pierceWedgeWidthPx > 0;
  const sides = manual
    ? openingSideWidths(part.pierceWedgeWidthPx, part.scale)
    : tipWidth > 0 && Number.isFinite(dilation)
      ? openingSideWidths((tipWidth * dilation) / 100, part.scale)
      : null;
  const peak = f * halfWidth;
  const reach = Math.max(2, halfWidth * REACH_PER_HALF_WIDTH) * (1 + REACH_GROWTH * f);
  const o = {
    base, inward, across, length, halfWidth,
    fraction: f,
    sTip,
    sApex,
    tipHalfWidth: Math.max(0, tipHalfWidth),
    peak,
    // Behind the tip, the edges rest against the piercer rather than
    // closing through it -- as a share of the peak, below the peak.
    hug: Math.max(0, Math.min(MAX_HUG, tipHalfWidth / Math.max(1e-6, halfWidth))),
    ahead: reach,
    behind: reach,
    // The seam is closed past its far end and outside the surface, so the
    // field fades to exactly nothing at both -- over at least the bulge's
    // own height, so even the lips at the surface turn in no steeper than
    // the rest of the curve.
    closeIn: Math.max(2, peak),
    closeOut: Math.max(1.5, peak),
    // Over the swelling or the gap, whichever is the more: the material at
    // the gap's edge is pushed the gap's width however small the swelling.
    lateral: LATERAL_SPREAD * (sides ? Math.max(peak, sides.a, sides.b) : peak) + LATERAL_MARGIN,
    cover: null,
    // { a, b, px }: the gap's sides in texels and its width in scene pixels,
    // or null when it is the tip's whole outline.
    sides,
    // Per side, what the piercer's reach is multiplied by so that its
    // widest row lands exactly on that side's width (1: unscaled).
    coverScale: { a: 1, b: 1 },
  };
  if (tipPoints && tipPoints.length) o.cover = coverageOf(o, tipPoints, coverMargin(part));
  if (sides) {
    // The widest the piercer reaches on each side, as openingCover reads it
    // -- the smooth curve through the bins, sampled finely: it peaks between
    // two equal bins, not at either one's middle.
    const widest = (side) => {
      if (!o.cover) return o.tipHalfWidth;
      const values = side > 0 ? o.cover.b : o.cover.a;
      let best = 0;
      for (let j = -8; j <= values.length * 8 + 8; j++) best = Math.max(best, reachOf(o, o.cover.s0 + j / 8, side));
      return best;
    };
    const wa = widest(-1);
    const wb = widest(1);
    o.coverScale = { a: wa > 1e-6 ? sides.a / wa : 0, b: wb > 1e-6 ? sides.b / wb : 0 };
  }
  return o;
}

// How far, along the seam, the rim's limit has to be kept back from the
// tip's outline so that the drawn edge -- straight lines between the
// refined mesh's points -- never crosses it between them: one refined
// triangle's reach, in whole texels.
function coverMargin(part) {
  if (!part.mesh) return 1;
  const cell = meshCellSize(part.mesh, part);
  const size = Math.max(cell.w, cell.h);
  const k = Math.max(1, Math.min(MAX_REFINE, Math.round(size / REFINE_TEXELS)));
  // One more texel for the smoothing that reads the bins back (openingCover).
  return Math.max(1, Math.ceil((size / k) * 1.5)) + 1;
}

// How far the opening reaches to each side of the seam, at every texel
// along it: from the piercer's painted texels, binned by where they fall
// along the seam -- the same on both sides (see MIRRORED, below).
//
// Then made conservative: each bin is lowered to the least of the bins
// within `margin` of it, so the rim never runs past a step in the outline,
// nor past the outline's end, anywhere between two of the mesh's points.
// Read back through a smooth curve (openingCover), which never rises above
// the bins it is drawn through.
function coverageOf(o, points, margin = 1) {
  let lo = Infinity;
  let hi = -Infinity;
  const st = points.map(({ u, v }) => {
    const p = seamCoordinates(o, u, v);
    lo = Math.min(lo, p.s);
    hi = Math.max(hi, p.s);
    return p;
  });
  // Bin i spans [s0 + i, s0 + i + 1) and stands for its middle: a texel's
  // worth of seam, the same rows the layer's own texels sit on.
  const s0 = Math.floor(lo) - 1;
  const n = Math.floor(hi) - s0 + 2;
  const tMin = new Float64Array(n).fill(Infinity);
  const tMax = new Float64Array(n).fill(-Infinity);
  for (const { s, t } of st) {
    const i = Math.floor(s - s0);
    if (t < tMin[i]) tMin[i] = t;
    if (t > tMax[i]) tMax[i] = t;
  }
  const raw = () => {
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      // MIRRORED: half the tip's whole width across this row, on both sides
      // alike -- the same number for side A and side B, so the two sides of
      // the opening are mirror images about the line by construction,
      // wherever across it the piercer happens to sit. (Before the mirror
      // line, each side took how far the tip reached on ITS side, so a tip
      // a pixel off the centreline opened a lopsided wedge.)
      if (!(tMax[i] >= tMin[i])) continue;
      out[i] = (tMax[i] - tMin[i]) / 2;
    }
    const eroded = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let least = out[i];
      for (let j = i - margin; j <= i + margin; j++) least = Math.min(least, j >= 0 && j < n ? out[j] : 0);
      eroded[i] = least;
    }
    return eroded;
  };
  const both = raw();
  return { s0, a: both, b: both };
}

// How far the piercer reaches from the seam on one side (-1: side A, +1:
// side B) at seam position s, in texels.
export function openingCover(o, s, side) {
  if (!o) return 0;
  const scale = o.coverScale ? (side > 0 ? o.coverScale.b : o.coverScale.a) : 1;
  return scale * reachOf(o, s, side);
}

function reachOf(o, s, side) {
  if (o.cover) {
    // A quadratic B-spline through the bins: smooth in value and slope, so
    // the rim -- and the material it carries -- has no corner where the
    // outline it follows steps; and a weighted average of three bins, so it
    // never rises above them.
    const values = side > 0 ? o.cover.b : o.cover.a;
    const x = s - o.cover.s0 - 0.5;
    const i = Math.round(x);
    const k = x - i;
    const at = (j) => (j >= 0 && j < values.length ? values[j] : 0);
    return 0.5 * (0.5 - k) * (0.5 - k) * at(i - 1) + (0.75 - k * k) * at(i) + 0.5 * (0.5 + k) * (0.5 + k) * at(i + 1);
  }
  // No outline to go on: a round-ended tip, tipHalfWidth across.
  const r = o.tipHalfWidth;
  const behind = o.sApex - s;
  if (!(r > 0) || behind <= 0) return 0;
  if (behind >= r) return r;
  return Math.sqrt(r * r - (r - behind) * (r - behind));
}

// How far each edge stands off the centreline at seam position s, in
// texels. Zero outside the seam; at most `peak`; widest at the tip.
export function openingAmplitude(o, s) {
  if (!o) return 0;
  const d = s - o.sTip;
  let g;
  if (d >= 0) {
    g = bump(d / o.ahead);
  } else {
    g = o.hug + (1 - o.hug) * bump(-d / o.behind);
  }
  return o.peak * g * openingClosure(o, s);
}

// Closed past the seam's far end, and outside the surface: 1 along the seam,
// easing to 0 at both.
function openingClosure(o, s) {
  const end = smooth((o.length - s) / o.closeIn);
  const start = smooth((s + o.closeOut) / o.closeOut);
  return end * start;
}

// The seam frame of a texel point: s along the seam, t across it.
export function seamCoordinates(o, u, v) {
  const du = u - o.base.x;
  const dv = v - o.base.y;
  return { s: du * o.inward.x + dv * o.inward.y, t: du * o.across.x + dv * o.across.y };
}

// How far one edge of the seam stands off the centreline at s: the
// swelling, but never past what the piercer covers on that side -- the two
// meeting in a rounded corner rather than a crease. Zero ahead of the tip,
// zero where the piercer does not straddle the seam, zero outside it.
export function openingRim(o, s, side, amplitude = openingAmplitude(o, s)) {
  if (!o) return 0;
  // With a Dilation, exactly the tip's outline at its share (HOW WIDE IT
  // OPENS), closed where the seam is.
  if (o.sides) return amplitude > 0 ? openingCover(o, s, side) * openingClosure(o, s) : 0;
  if (amplitude <= 0) return 0;
  const cover = openingCover(o, s, side);
  if (cover <= 0) return 0;
  const d = amplitude - cover;
  return Math.max(0, 0.5 * (amplitude + cover - Math.sqrt(d * d + RIM_SOFTNESS * RIM_SOFTNESS)));
}

// The displacement at a texel point for one side's pass (-1: side A, the
// texels behind the centreline, pushed toward -across; +1: side B, toward
// +across), as a distance along that side's outward direction.
//
// On the line it is the rim. Moving away from the line it rises smoothly
// to the swelling and then fades to nothing; both through smoothsteps in
// |t|, which have no slope at zero, so there is no crease along the line.
// It never falls faster than about 0.6 of a texel per texel sideways, so
// it cannot fold the surface over itself.
export function openingShift(o, u, v, side = 1) {
  const { s, t } = seamCoordinates(o, u, v);
  const swelling = openingAmplitude(o, s);
  if (swelling === 0) return 0;
  const rim = openingRim(o, s, side, swelling);
  // Never less than the gap (see HOW WIDE IT OPENS).
  const amplitude = o.sides ? Math.max(swelling, openingRim(o, s, -1, swelling), openingRim(o, s, 1, swelling)) : swelling;
  return sideProfile(o, rim, amplitude, Math.abs(t));
}

function riseOf(amplitude) {
  return Math.max(MIN_RISE, RISE_SPREAD * amplitude);
}

function sideProfile(o, rim, amplitude, d) {
  return (rim + (amplitude - rim) * smooth(d / riseOf(amplitude))) * (1 - smooth(d / o.lateral));
}

// The whole displacement one PASS applies, as a signed distance along
// +across, at every point of the layer -- both sides of the line.
//
// The true displacement is the side profile pushed outward on each side:
// +profile on side B, -profile on side A, which jumps by the two rims at
// the line -- the opening. A pass draws only its own side, but the
// triangles that straddle the line carry both, so its field has to be
// CONTINUOUS there, or a straddling triangle would average the two sides'
// pushes and open a sliver of a gap where the rim is closed. So each pass
// uses the true field on its own side and, across the line, the other
// side's true field with the jump taken out (fading off a few texels away,
// so the hidden far side is not dragged along). Matching in value and in
// slope at the line, the straddling triangles land the seam exactly where
// it belongs.
export function openingDisplacement(o, u, v, pass) {
  const { s, t } = seamCoordinates(o, u, v);
  const swelling = openingAmplitude(o, s);
  if (swelling === 0) return 0;
  const rimA = openingRim(o, s, -1, swelling);
  const rimB = openingRim(o, s, 1, swelling);
  // Never less than the gap (see HOW WIDE IT OPENS).
  const amplitude = o.sides ? Math.max(swelling, rimA, rimB) : swelling;
  const d = Math.abs(t);
  const own = t >= 0 ? 1 : -1;
  const value = own * sideProfile(o, own > 0 ? rimB : rimA, amplitude, d);
  if (own === pass) return value;
  // The jump is +(rimA + rimB) going from side A to side B. It fades over
  // at least twice its own size, so the hidden side is never squeezed or
  // stretched by much more than the drawn one.
  const gap = rimA + rimB;
  const fade = riseOf(amplitude) + 1 + 2 * gap;
  const jump = gap * (1 - smooth(d / fade));
  return pass > 0 ? value + jump : value - jump;
}

// Which texels each pass draws: side A (behind the centreline, t < 0) and
// side B. Complementary, so every texel is drawn exactly once.
const sideCache = new Map();
export function openingSides(part, o) {
  const W = part.naturalWidth;
  const H = part.naturalHeight;
  const key = `${W}x${H}:${o.base.x}:${o.base.y}:${o.across.x}:${o.across.y}`;
  const cached = sideCache.get(part.id);
  if (cached && cached.key === key) return cached.sides;
  const a = new Uint8Array(W * H);
  const b = new Uint8Array(W * H);
  for (let v = 0; v < H; v++) {
    for (let u = 0; u < W; u++) {
      const t = (u + 0.5 - o.base.x) * o.across.x + (v + 0.5 - o.base.y) * o.across.y;
      if (t < 0) a[v * W + u] = 1; else b[v * W + u] = 1;
    }
  }
  const sides = { a, b };
  sideCache.set(part.id, { key, sides });
  return sides;
}

// ---------------------------------------------------------------------------
// The refined mesh

// Every triangle of the layer's mesh split k×k, sharing the points along
// every shared edge so the result has no T-junctions. Each refined vertex
// is a fixed blend of (at most three) coarse vertices -- its place inside
// the coarse triangle it was made from -- so carrying it along with the
// layer's deformation is a weighted sum, not a fresh solve.
function meshSignature(mesh) {
  let sum = 0;
  for (const vertex of mesh.vertices) sum += vertex.u * 7.13 + vertex.v * 3.71;
  let tri = 0;
  for (let i = 0; i < mesh.triangles.length; i++) tri = (tri * 31 + mesh.triangles[i]) % 1000003;
  return `${mesh.vertices.length}|${mesh.triangles.length}|${sum}|${tri}`;
}

export function refinedMesh(mesh, part) {
  const signature = meshSignature(mesh);
  if (mesh._refined && mesh._refined.signature === signature) return mesh._refined;
  const cell = meshCellSize(mesh, part);
  const k = Math.max(1, Math.min(MAX_REFINE, Math.round(Math.max(cell.w, cell.h) / REFINE_TEXELS)));
  const V = mesh.vertices;
  const T = mesh.triangles;
  const blends = []; // [{ ids: [ia, ib, ic], ws: [wa, wb, wc], tri }]
  const uvs = [];
  const index = new Map();
  const add = (key, ids, ws, tri) => {
    if (index.has(key)) return index.get(key);
    const id = blends.length;
    blends.push({ ids, ws, tri });
    let u = 0;
    let v = 0;
    for (let c = 0; c < ids.length; c++) { u += V[ids[c]].u * ws[c]; v += V[ids[c]].v * ws[c]; }
    uvs.push({ u, v });
    index.set(key, id);
    return id;
  };
  // A point on the edge p-q, `step` k-ths of the way from p: keyed the same
  // way from both triangles that share the edge.
  const onEdge = (p, q, step, tri) => {
    if (step === 0) return add(`v${p}`, [p], [1], tri);
    if (step === k) return add(`v${q}`, [q], [1], tri);
    const [lo, hi, s] = p < q ? [p, q, step] : [q, p, k - step];
    return add(`e${lo}-${hi}-${s}`, [lo, hi], [1 - s / k, s / k], tri);
  };
  const triangles = [];
  for (let t = 0; t < T.length; t += 3) {
    const tri = t / 3;
    const A = T[t];
    const B = T[t + 1];
    const C = T[t + 2];
    const point = (i, j) => {
      if (j === 0) return onEdge(A, B, i, tri);
      if (i === 0) return onEdge(A, C, j, tri);
      if (i + j === k) return onEdge(B, C, j, tri);
      return add(`t${tri}-${i}-${j}`, [A, B, C], [1 - (i + j) / k, i / k, j / k], tri);
    };
    for (let j = 0; j < k; j++) {
      for (let i = 0; i + j < k; i++) {
        triangles.push(point(i, j), point(i + 1, j), point(i, j + 1));
        if (i + j < k - 1) triangles.push(point(i + 1, j), point(i + 1, j + 1), point(i, j + 1));
      }
    }
  }
  mesh._refined = { signature, k, blends, uvs, triangles };
  return mesh._refined;
}

// ---------------------------------------------------------------------------
// The two passes

// What holds the material still, per refined vertex, for the opening to
// give way round: the distance to the nearest pinned cell (Px Pin's own
// measure, carried in from the layer's mesh), and -- when a Deformable
// region is painted -- the distance in from that region's edge. Both are
// rest-shape facts, so they are worked out when the pins, the region or the
// mesh change, never per frame.
function holdsFor(part, mesh, refined) {
  const pinKey = part.pins && part.pins.size > 0 ? `${part.pinsVersion || 0}:${part.pins.size}` : null;
  const region = part.pierceDeformRegion;
  const deformKey = region && region.size > 0 ? `${part.pierceDeformRegionVersion || 0}:${region.size}` : null;
  const key = `${pinKey}|${deformKey}`;
  if (refined._holds && refined._holdsKey === key) return refined._holds;
  let pins = null;
  let cell = 1;
  if (pinKey) {
    const measured = pinDistances(mesh, part);
    cell = measured.cell;
    pins = refined.blends.map(({ ids, ws }) => {
      let d = 0;
      for (let c = 0; c < ids.length; c++) d += measured.distances[ids[c]] * ws[c];
      return d;
    });
  }
  const inside = deformKey ? insideDistances(part, region, refined.uvs) : null;
  refined._holds = { pins, cell, inside };
  refined._holdsKey = key;
  return refined._holds;
}

// How far in from the edge of the Deformable region each point is, in
// texels (zero or less outside it): a distance transform over the layer's
// texels, read back at each point between the texel centres.
function insideDistances(part, region, points) {
  const W = part.naturalWidth;
  const H = part.naturalHeight;
  const far = W + H;
  const dist = new Float64Array(W * H);
  for (let i = 0; i < W * H; i++) dist[i] = region.has(i) ? far : 0;
  // Two chamfer passes (1 straight, sqrt 2 diagonal): close to the true
  // distance, and plenty for an easing band a few texels wide.
  const D = Math.SQRT2;
  const relax = (i, j, w) => { if (dist[j] + w < dist[i]) dist[i] = dist[j] + w; };
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (dist[i] === 0) continue;
      if (x === 0 || y === 0 || x === W - 1 || y === H - 1) dist[i] = Math.min(dist[i], 1);
      if (x > 0) relax(i, i - 1, 1);
      if (y > 0) relax(i, i - W, 1);
      if (x > 0 && y > 0) relax(i, i - W - 1, D);
      if (x < W - 1 && y > 0) relax(i, i - W + 1, D);
    }
  }
  for (let y = H - 1; y >= 0; y--) {
    for (let x = W - 1; x >= 0; x--) {
      const i = y * W + x;
      if (dist[i] === 0) continue;
      if (x < W - 1) relax(i, i + 1, 1);
      if (y < H - 1) relax(i, i + W, 1);
      if (x < W - 1 && y < H - 1) relax(i, i + W + 1, D);
      if (x > 0 && y < H - 1) relax(i, i + W - 1, D);
    }
  }
  // Centre-to-centre distances, less half a texel: the distance to the
  // region's actual edge. Read back bilinearly between texel centres.
  const at = (x, y) => (x < 0 || y < 0 || x >= W || y >= H ? -0.5 : dist[y * W + x] - 0.5);
  return points.map(({ u, v }) => {
    const x = u - 0.5;
    const y = v - 0.5;
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = x - x0;
    const fy = y - y0;
    return (at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx) * (1 - fy)
      + (at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx) * fy;
  });
}

// How much of a push of size `push` refined vertex i takes, 0 to 1.
//
// Pins hold through Px Pin's own smooth influence -- held completely on
// the pinned cells, easing to free across a band one mesh cell wide -- but
// the band widens with the push, to HOLD_SPREAD times it, so however deep
// the opening the material between a pin and the seam is squeezed no
// harder than the sideways fade squeezes it. A painted Deformable region
// limits the opening to itself the same way: free inside, held outside,
// eased across its edge over a band that widens with the push. With no
// Deformable region painted, all of the layer gives.
function giveAt(holds, i, push) {
  let give = 1;
  if (holds.pins) {
    const band = Math.max(holds.cell, HOLD_SPREAD * push);
    give *= smooth(holds.pins[i] / band);
  }
  if (holds.inside) {
    const band = Math.max(DEFORM_EDGE, HOLD_SPREAD * push);
    give *= smooth(holds.inside[i] / band);
  }
  return give;
}

// One pass's geometry: the refined mesh, carried by the layer's deformed
// (coarse) positions, with that pass's field applied (see
// openingDisplacement). `side` is -1 for the texels behind the centreline,
// +1 for the others.
export function openingGeometry(part, coarse, o, side) {
  const mesh = part.mesh;
  const refined = refinedMesh(mesh, part);
  const P = coarse.positions;
  const V = mesh.vertices;
  const T = mesh.triangles;
  // Each coarse triangle's local map from texels to the scene, as drawn:
  // the push is decided in texels and has to go where those texels went.
  const jacobians = new Array(T.length / 3);
  for (let t = 0; t < T.length; t += 3) {
    const a = T[t];
    const b = T[t + 1];
    const c = T[t + 2];
    const du1 = V[b].u - V[a].u; const dv1 = V[b].v - V[a].v;
    const du2 = V[c].u - V[a].u; const dv2 = V[c].v - V[a].v;
    const det = du1 * dv2 - du2 * dv1;
    if (Math.abs(det) < 1e-12) { jacobians[t / 3] = null; continue; }
    const ex1 = P[b].x - P[a].x; const ey1 = P[b].y - P[a].y;
    const ex2 = P[c].x - P[a].x; const ey2 = P[c].y - P[a].y;
    // J = [e1 e2] · inv([d1 d2])
    jacobians[t / 3] = {
      xu: (ex1 * dv2 - ex2 * dv1) / det, xv: (ex2 * du1 - ex1 * du2) / det,
      yu: (ey1 * dv2 - ey2 * dv1) / det, yv: (ey2 * du1 - ey1 * du2) / det,
    };
  }
  const holds = holdsFor(part, mesh, refined);
  const positions = refined.blends.map(({ ids, ws, tri }, i) => {
    let x = 0;
    let y = 0;
    for (let c = 0; c < ids.length; c++) { x += P[ids[c]].x * ws[c]; y += P[ids[c]].y * ws[c]; }
    const { u, v } = refined.uvs[i];
    let shift = openingDisplacement(o, u, v, side);
    if (shift !== 0) shift *= giveAt(holds, i, Math.abs(shift));
    const J = jacobians[tri];
    if (shift === 0 || !J) return { x, y };
    const du = o.across.x * shift;
    const dv = o.across.y * shift;
    return { x: x + J.xu * du + J.xv * dv, y: y + J.yu * du + J.yv * dv };
  });
  return { positions, uvs: refined.uvs, triangles: refined.triangles };
}

// Where along the seam a scene point is, through the layer's current shape:
// the tip's place on the seam is read this way every frame.
export function texelOfScenePoint(part, positions, point) {
  return texelNearest(part.mesh.vertices, positions, part.mesh.triangles, point);
}

// A piercer's tip, carried into this layer's texels: its leading point and
// every painted texel of it, all through the posed layer's local map at
// the leading point. `shift` is how far the tip is drawn from where its
// texels were measured (the depth cap and the walls holding it back).
export function tipInTexels(part, positions, leading, points, shift = { x: 0, y: 0 }) {
  const frame = texelFrameNearest(part.mesh.vertices, positions, part.mesh.triangles, leading);
  if (!frame) return null;
  const carry = (p) => {
    const dx = p.x + shift.x - leading.x;
    const dy = p.y + shift.y - leading.y;
    return { u: frame.u + frame.uX * dx + frame.uY * dy, v: frame.v + frame.vX * dx + frame.vY * dy };
  };
  return { tip: { u: frame.u, v: frame.v }, points: points.map(carry) };
}

// ---------------------------------------------------------------------------
// Sanity

// Whether a marker sits over any of the layer's artwork at all -- a seam
// placed off the art opens onto nothing.
export function markerCoversArtwork(part) {
  const marker = openingMarker(part);
  if (!marker) return false;
  const { b1, b2, apex } = marker;
  const x0 = Math.max(0, Math.floor(Math.min(b1.x, b2.x, apex.x)));
  const x1 = Math.min(part.naturalWidth - 1, Math.ceil(Math.max(b1.x, b2.x, apex.x)));
  const y0 = Math.max(0, Math.floor(Math.min(b1.y, b2.y, apex.y)));
  const y1 = Math.min(part.naturalHeight - 1, Math.ceil(Math.max(b1.y, b2.y, apex.y)));
  const edge = (a, b, x, y) => (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      const e1 = edge(b1, b2, px, py);
      const e2 = edge(b2, apex, px, py);
      const e3 = edge(apex, b1, px, py);
      const inside = (e1 >= 0 && e2 >= 0 && e3 >= 0) || (e1 <= 0 && e2 <= 0 && e3 <= 0);
      if (inside && (!part.pixels || part.pixels[(y * part.naturalWidth + x) * 4 + 3] !== 0)) return true;
    }
  }
  return false;
}

export function resetOpeningCaches() {
  defaultCache.clear();
  sideCache.clear();
}
