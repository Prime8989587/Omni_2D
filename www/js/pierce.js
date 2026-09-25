// Pierce: displacing flesh, not cutting a hole in it.
//
// WHAT THIS IS NOT
//
// It never removes a pixel, never hides one, never makes one transparent
// and never punches a hole. There is no second rendering pass and no
// stencil. Every pixel the pierced layer had before contact is still
// drawn afterwards, through the same rasterizer, in the same single pass.
// The ONLY thing that changes is where some mesh vertices are, which is
// exactly the same lever bone skinning already pulls -- so the effect is
// completely reversible by moving the piercer back out, with nothing to
// undo or restore.
//
// A WEDGE, NOT TWO DRAWN SHAPES
//
// The local shape of a contact is a triangular dent: an apex driven in
// along the approach, a base across the surface, both sized by the depth
// fraction and by two numbers the artist sets. dent.js holds that
// machinery, cuts the wedge out of the artwork as a per-texel mask, and
// shoves the material marked Deformable outward around its faces.
//
// It replaced a blend between two hand-painted outlines, which worked on
// primitives and could not work on organic artwork: two freehand drawings
// of a curvy silhouette have no reliable point-to-point correspondence to
// blend along, and every attempt to find one narrowed the failure without
// removing it.
//
// This replaced a per-vertex spring push, and the reason is worth keeping.
// That version gave each vertex its own radial shove away from the tip
// with its own smoothstep falloff, so neighbours decided independently --
// and on the coarse mesh an unbound layer gets, independent neighbours
// read as a torn, jagged silhouette rather than a shape changing. It is a
// technique mismatch rather than a tuning problem: nothing in it knew what
// outline it was supposed to be producing, so no stiffness could have made
// it produce one.
//
// Nothing about the dent is integrated over time. The wedge IS the depth,
// so a given depth always looks the same, there is no state to fall out of
// step with the drag, withdrawing runs the identical numbers backwards to
// exactly zero, and the frame loop has nothing left to settle once the
// piercer stops. The bones' own springs are untouched and go on reporting
// for themselves.
//
// HOW DEEP IS DEEP
//
//   gap   = how far the piercer's painted TIP still has to travel to reach
//           the painted PIERCEABLE pixels, in scene pixels -- measured
//           ALONG THE PIERCER'S OWN AXIS, and SIGNED: negative once the
//           tip is already that far in.
//   Enter = the gap at which contact begins. Further out than this and
//           nothing moves at all.
//   End   = how much FURTHER past that first contact the push keeps
//           growing. Reaching it is the maximum, and going deeper than it
//           changes nothing more -- the hard limit.
//
//   depth = clamp(Enter - gap, 0, End)      t = depth / End
//
// The sign is the whole reason the gap is measured along an axis rather
// than as a plain nearest-pixel distance. A nearest-pixel distance cannot
// go below zero -- two overlapping regions are zero apart and stay zero
// however much further the needle is driven in -- so depth could never
// exceed Enter, and any End beyond it (including the 24 the app offers by
// default against an Enter of 12) was simply unreachable. Along the axis,
// driving deeper keeps making the number smaller, so the two marks sit on
// one continuous scale the way the depth bar draws them.
//
// One consequence worth knowing, because it is the effect rather than a
// side effect: at the instant the tip actually touches, gap is 0 and depth
// is already Enter, so the flesh has retreated Enter pixels AHEAD of the
// tip. Flesh dents away from a needle instead of being skewered by it, and
// Enter is how far ahead of itself the needle pushes. Past End it stops
// giving way, which is what "hard limit" looks like on screen.
//
// t runs 0 at first touch to 1 at the limit, and scales the push, so a
// tip barely in contact moves the flesh barely at all.
//
// The limit binds the PIERCER too, not only the push. Capping the depth
// alone left the artwork free to carry on through the layer and out the
// far side while the numbers sat pinned at End, which is not what a hard
// limit looks like. Past End the piercer is DRAWN short of where the drag
// put it, by exactly the distance the depth refused (see pierceHold), so
// its tip stops where the depth stopped.
//
// Nothing blocks the finger: the drag is still the user's, the layer's
// real coordinates still follow it exactly, and the contact is still
// measured from those real coordinates rather than from where the sprite
// was drawn -- so there is no feedback between the two. Only the axis
// component of the motion stops having a visible effect. Sideways motion
// and pulling back out track the finger one-for-one as they always did.

import { partsStore, PiercePhysics } from './parts.js';
import { bonesStore } from './bones.js';
import {
  localToWorld, pinCarriageOffset, pinInfluence, generateMesh, defaultDensity,
} from './mesh.js';
import { pierceStateFor, peekPierceState } from './pierceState.js';
import { carryByCorrection } from './plinkState.js';
import { correctionOf } from './plink.js';
import {
  dentTriangleAt, dentCutMask, dentCutArea, writeBunch, resetDentCache,
} from './dent.js';
import { haptic } from './haptics.js';

export { pierceOffsets, resetPierceState } from './pierceState.js';

// ---------------------------------------------------------------------------
// Geometry

// Where a layer's painted region currently is, in scene space: each marked
// texel's centre, mapped through the layer's own transform plus whatever
// carriage its bones have given it. Measured against the REST pose for the
// same reason pins are -- a tip that jittered with its own spring would
// make the contact point jitter with it, and the depth reading along with
// it.
//
// Mapping every painted texel through the layer's transform is the single
// most expensive thing this file does -- a thousand painted pixels is a
// thousand rotations -- and it is asked for twice in a frame where the
// renderer has to re-measure before the frame loop has stepped. Measured
// at 3.1 ms a call for a 160-texel tip against a 1024-texel area, which is
// most of a frame's budget on a phone and was being paid every frame even
// when nothing had moved.
//
// So the answer is kept until something that could change it changes: the
// layer's own placement, what is painted on it, or where its bones are
// carrying it. Everything the result depends on is in that key, which is
// why it is safe to trust -- and why the carriage, the one part of it that
// is not a plain field, is still computed on every call.
const pointsCache = new Map();

// The two masks that have a position in the scene: what can be touched,
// and what cannot be crossed. (Deformable never needs scene coordinates --
// it is asked about per mesh vertex, in the layer's own texel space.)
const REGIONS = {
  pierce: { set: (part) => part.pierceRegion, version: (part) => part.pierceRegionVersion || 0 },
  barrier: { set: (part) => part.pierceBarrierRegion, version: (part) => part.pierceBarrierRegionVersion || 0 },
};

function regionPoints(part, transforms, which = 'pierce') {
  if (!part) return [];
  const region = REGIONS[which].set(part);
  if (!region || region.size === 0) return [];
  const carriage = pinCarriageOffset(part, transforms);
  // A PLinked layer is drawn where its link puts it, so that is where its
  // regions are touched -- the same rigid correction its mesh receives.
  const link = correctionOf(part, transforms || undefined);
  const key = `${part.x},${part.y},${part.rotation},${part.scale},` +
    `${REGIONS[which].version(part)},${region.size},${carriage.x},${carriage.y}` +
    (link ? `,${link.cos},${link.sin},${link.from.x},${link.from.y},${link.to.x},${link.to.y}` : '');
  const cacheKey = `${part.id}:${which}`;
  const cached = pointsCache.get(cacheKey);
  if (cached && cached.key === key) return cached.points;

  const halfW = part.naturalWidth / 2;
  const halfH = part.naturalHeight / 2;
  const points = [];
  for (const index of region) {
    const u = index % part.naturalWidth;
    const v = Math.floor(index / part.naturalWidth);
    const world = localToWorld(part, { x: u + 0.5 - halfW, y: v + 0.5 - halfH });
    const carried = { x: world.x + carriage.x, y: world.y + carriage.y };
    points.push(link ? carryByCorrection(link, carried) : carried);
  }
  pointsCache.set(cacheKey, { key, points });
  return points;
}

// LATERAL CONTAINMENT
//
// Enter and End say how far IN the tip may go, along one axis. They say
// nothing about sideways, so a tip driven at an angle could slide out
// through the edge of the pierceable shape and sit in open space beyond
// it -- the small artifact poking past the region's outline.
//
// Barrier pixels are walls. This pushes the contained tip back out of any
// it has entered: the deepest single overlap decides the direction and
// the distance, rather than the sum of every nearby wall pixel, because a
// wall IS many pixels and summing them would fire the tip across the
// cavity. Two passes, so a corner (two walls at once) resolves against
// both instead of sliding along one into the other.
//
const wallGrids = new WeakMap();

// One number per blocked scene cell, so the lookup allocates nothing. The
// string keys this used to build were the single most expensive thing in a
// frame near a wall: a long sweep asked hundreds of thousands of times and
// made a fresh string for every one of them.
const GRID_BIAS = 8192;
const cellKey = (x, y) => (x + GRID_BIAS) * 65536 + (y + GRID_BIAS);

function wallGridFor(walls) {
  let grid = wallGrids.get(walls);
  if (!grid) {
    grid = new Set();
    for (const w of walls) grid.add(cellKey(Math.round(w.x), Math.round(w.y)));
    wallGrids.set(walls, grid);
  }
  return grid;
}

// A WALL IS THE PIXELS THAT WERE PAINTED, AND NOTHING ELSE
//
// This used to treat a wall pixel as blocking everything within the TIP'S
// OWN half-extent of it, which is a simplification that quietly invents
// walls nobody painted. Two barriers down the sides of a cavity, each
// inflated by the tip's spread, meet in the middle of anything narrower
// than twice that spread -- and the inflation reaches up past the topmost
// painted pixel too, roofing over an entrance that was left wide open.
// Measured on a 20 px cavity with a tip of spread 12.3 and NOTHING painted
// across its front: entry straight down the middle stalled at depth 9 of
// 16, blocked by a ceiling that existed only in this function.
//
// So the test is now the honest one: the contained position is a point,
// and it is blocked exactly when the scene cell it lands in was painted.
// An unpainted direction has nothing in it, so it stays open.
function blockedAt(grid, x, y) {
  return grid.has(cellKey(Math.round(x), Math.round(y)));
}

function sweepContain(from, to, walls) {
  const grid = wallGridFor(walls);
  // Already standing on a painted pixel means something put the tip there
  // without crossing anything -- a layer moved out from under it, a
  // project loaded mid-pierce. Containment simply stands down for the
  // frame rather than hunting for a way out: failing OPEN leaves the user
  // holding a piercer that still answers the drag, and the next frame
  // re-establishes containment normally once it is off the pixel.
  if (blockedAt(grid, from.x, from.y)) return to;

  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.hypot(dx, dy);
  if (distance < 1e-6) return from;

  // Half a scene pixel a step, so no cell along the path is stepped over.
  // Capped, because the drag can be arbitrarily far from where the tip is
  // pinned and no amount of sampling past a wall changes the answer.
  const steps = Math.min(4096, Math.max(1, Math.ceil(distance * 2)));
  let reached = from;
  let lastX = Math.round(from.x);
  let lastY = Math.round(from.y);
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const x = from.x + dx * t;
    const y = from.y + dy * t;
    const cx = Math.round(x);
    const cy = Math.round(y);
    if (grid.has(cellKey(cx, cy))) break;
    // A diagonal step changes both coordinates at once and would slip
    // through the corner between two painted pixels. Treat that corner as
    // closed by testing the two cells it cuts between.
    if (cx !== lastX && cy !== lastY &&
        (grid.has(cellKey(cx, lastY)) || grid.has(cellKey(lastX, cy)))) break;
    lastX = cx;
    lastY = cy;
    reached = { x, y };
  }
  return reached;
}

// Where each live contact's tip has been allowed to get to, so the next
// frame's sweep knows which side of a wall it started on. Keyed per
// piercer-and-layer pair, and dropped the moment that contact ends -- a
// disengaged piercer is not being contained by anything, and keeping a
// stale point would teleport it on re-entry.
const containedTips = new Map();
// Whether each piercer/pierced pair's tip was against a barrier last frame,
// so the haptic marks the crossing rather than repeating while it leans.
const wallContact = new Map();

// WHOSE MOVEMENT COUNTS
//
// The gap is a measurement between two painted regions, so it has no
// opinion about which of them moved -- flesh sliding onto a parked needle
// reads identically to a needle driven into parked flesh. The Physics
// Direction setting is the opinion, and this is where it is applied:
// each frame the excluded side's contribution to the change in gap is
// accumulated and added straight back, so its movement nets out to
// nothing while the other side's passes through untouched.
//
// It cancels DEEPENING, not participation. A contact already established
// keeps its depth, its z-order and its springs whichever side is excluded;
// the excluded one simply cannot drive it further in. The accumulator is
// re-baselined whenever the pair drifts out of range, so it can never
// wander off over a long session.
const motionState = new Map();
const IN_PLAY_MARGIN = 4;

export function resetPierceContainment() {
  containedTips.clear();
  motionState.clear();
  dentCuts = new Map();
  placementIssues.clear();
  resetDentCache();
}

// The middle of a region, cached against the points array regionPoints
// already keeps -- so this is recomputed when the layer moves or its paint
// changes, not per frame.
const centroids = new WeakMap();

function centroidOf(points) {
  let middle = centroids.get(points);
  if (!middle) {
    middle = centroid(points);
    centroids.set(points, middle);
  }
  return middle;
}

// The layer's own centre in scene space. Local (0,0) IS that centre --
// regionPoints places texel u,v at u + 0.5 - width/2 -- so this is the
// same mapping with nothing painted in it.
function layerCentre(part, transforms) {
  const carriage = pinCarriageOffset(part, transforms);
  const middle = localToWorld(part, { x: 0, y: 0 });
  const carried = { x: middle.x + carriage.x, y: middle.y + carriage.y };
  const link = correctionOf(part, transforms || undefined);
  return link ? carryByCorrection(link, carried) : carried;
}

function centroid(points) {
  let x = 0;
  let y = 0;
  for (const p of points) { x += p.x; y += p.y; }
  return { x: x / points.length, y: y / points.length };
}

// How far the painted tip reaches from its own middle. A broad tip pushes
// a broad area aside and a needle pushes a narrow one, which falls out of
// the artwork the user painted rather than from a number they have to
// guess at.
function spread(points, middle) {
  let worst = 0;
  for (const p of points) worst = Math.max(worst, Math.hypot(p.x - middle.x, p.y - middle.y));
  return worst;
}

// The live contact between one piercer and one pierced layer. Null
// when either side has nothing painted -- an unpainted region is not a
// contact of size zero, it is no contact at all, and reporting it as one
// would let an unconfigured pair start deforming.
// Which way the piercer is travelling: from the middle of the whole layer
// toward the middle of its painted tip. That falls straight out of the
// artwork -- a needle has its point at one end of its sprite -- so the
// axis rotates with the layer and costs the user nothing to specify. Null
// when the tip's middle IS the layer's middle (a region painted over the
// whole sprite), which leaves no direction to read.
function pierceAxis(piercer, tipMiddle, transforms) {
  const body = layerCentre(piercer, transforms);
  const dx = tipMiddle.x - body.x;
  const dy = tipMiddle.y - body.y;
  const length = Math.hypot(dx, dy);
  if (length < 1e-6) return null;
  return { x: dx / length, y: dy / length };
}

// Plain closest-pixel separation. Not what depth is measured with (see
// the header), but it is the honest answer to "how far apart are these
// two regions" when the piercer is not pointed at the flesh at all, and
// that is the number worth reporting in that case.
//
// Exact, but it does not look at every pair unless it has to. The naive
// double loop is O(tip x flesh) -- 3.1 ms for a 160-texel tip against a
// 1024-texel area, paid every frame the loop is awake -- and this is the
// case where the piercer is NOT aimed at the flesh, which is most of the
// time. A tip point whose distance to the flesh's bounding box already
// exceeds the best pair found so far cannot beat it, so it is skipped
// whole. The answer is identical; only the work is smaller.
function nearestSeparation(tip, flesh) {
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
function axialGap(tip, flesh, tipMiddle, tipSpread, axis) {
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

// A DISPLACEMENT NEEDS SOMEWHERE TO LIVE
//
// The offsets this solver produces are PER VERTEX, so an pierced layer
// with no mesh has nowhere to put them. Until now such a layer was simply
// skipped, which meant the whole feature quietly did nothing unless the
// user had first rigged a skeleton and bound the flesh to it in Bind mode
// -- a prerequisite nothing in the Pierce UI ever mentions, and one that
// has nothing to do with piercing. Measured on a two-layer scene with
// roles assigned and regions painted: the contact read perfectly (gap 31
// down to -13, depth capped at End) while the displacement stayed at
// 0.000 px at every depth, because the layer never reached the solver.
//
// So the mesh is built here, on demand. An unbound mesh has no bind pose
// and no weights, so skinning it is the identity -- it renders exactly as
// the flat sprite did -- and it exists purely as the surface a pierce can
// push on. Binding the layer later replaces it as usual.
function meshFor(part) {
  if (!part.mesh) part.mesh = generateMesh(part, defaultDensity(part));
  return part.mesh;
}

// THE DENT'S OWN TWO ENDS
//
// The notch starts at the Dent Trigger Distance -- the piercer's third
// depth, independent of Enter -- and is complete at the End Point, the same
// place the depth stops. Sharing the far end is deliberate: a drag should
// not have two different "all the way in" positions, one for the numbers
// and one for the artwork.
//
// The near end has to stay in front of the far one, and nothing stops the
// user from editing Enter or End afterwards into a pair that puts it
// behind. Rather than refuse the edit or divide by a span of nothing, the
// trigger is held one pixel clear of the End Point: the dent then starts as
// late as it still can, which is the closest thing to what was asked for.
const MIN_DENT_SPAN = 1;

function dentStartOf(piercer, enter, end) {
  const stored = Number.isFinite(piercer.pierceDentStart) ? piercer.pierceDentStart : enter;
  return Math.max(stored, enter - end + MIN_DENT_SPAN);
}

function dentSpan(piercer, enter, end) {
  return dentStartOf(piercer, enter, end) - (enter - end);
}

export function contactOf(piercer, pierced, transforms) {
  if (!piercer || !pierced) return null;
  const tip = regionPoints(piercer, transforms);
  const flesh = regionPoints(pierced, transforms);
  if (tip.length === 0 || flesh.length === 0) return null;

  const tipMiddle = centroid(tip);
  const tipSpread = spread(tip, tipMiddle);
  const axis = pierceAxis(piercer, tipMiddle, transforms);
  const axial = axis ? axialGap(tip, flesh, tipMiddle, tipSpread, axis) : null;
  // Off the path, or a piercer with no readable direction: report the real
  // separation, but nothing engages off a measurement that has no sign.
  const rawInPath = axial !== null;
  const measured = rawInPath ? axial.gap : nearestSeparation(tip, flesh);
  let surface = rawInPath ? axial.surface : null;

  const enter = piercer.pierceEnter;
  const end = Math.max(1, piercer.pierceEnd);
  const pair = `${piercer.id}:${pierced.id}`;

  // Apply the Physics Direction. The gap the rest of this function works
  // from is the measured one plus everything the excluded side has moved
  // it by since this pair came into range -- which is to say, the gap as
  // it would be if that side had stayed where it was.
  const mode = piercer.piercePhysics || PiercePhysics.PIERCER;
  let rawGap = measured;
  if (axis && rawInPath && mode !== PiercePhysics.BOTH) {
    const along = (p) => p.x * axis.x + p.y * axis.y;
    const tipAlong = along(tipMiddle);
    const fleshAlong = along(centroidOf(flesh));
    const inPlay = measured < enter + IN_PLAY_MARGIN;
    const previous = motionState.get(pair);
    let ignored = 0;
    if (inPlay && previous) {
      // A tip advancing by d shrinks the gap by d, so cancelling it means
      // adding d back. Flesh advancing by d grows the gap by d, so
      // cancelling that means taking d away.
      ignored = previous.ignored + (mode === PiercePhysics.PIERCED
        ? tipAlong - previous.tipAlong
        : previous.fleshAlong - fleshAlong);
    }
    if (inPlay) motionState.set(pair, { tipAlong, fleshAlong, ignored });
    else motionState.delete(pair);
    rawGap = measured + ignored;
  } else {
    motionState.delete(pair);
  }

  const rawDepth = rawInPath ? Math.min(end, Math.max(0, enter - rawGap)) : 0;

  // Past End the contact's GEOMETRY has to stop advancing as well, not
  // just the depth number. The push is aimed outward from the tip and
  // fades with distance from it, so a tip that kept travelling after the
  // depth was capped would walk straight through the flesh and out the
  // far side -- leaving every vertex too far away to be pushed, and the
  // dent melting away to nothing exactly when it should be deepest.
  // Holding the tip at the position where End was reached makes deeper
  // than End look identical to End, which is what a hard limit means.
  const overshoot = rawInPath ? Math.max(0, (enter - end) - rawGap) : 0;
  const depthClamped = overshoot > 0
    ? { x: tipMiddle.x - axis.x * overshoot, y: tipMiddle.y - axis.y * overshoot }
    : tipMiddle;
  // Walls apply only once the tip is actually in contact, the same
  // threshold everything else about a pierce turns on. A piercer merely
  // passing nearby is not being contained by anything.
  // A CONTAINED TIP IS STILL IN THERE
  //
  // Engagement cannot be read off the raw position once walls are in play,
  // or the two undo each other: the wall holds the tip inside the cavity
  // while the finger carries on outside it, the raw reading says "nothing
  // in my path", the contact drops -- and dropping the contact releases
  // the containment that was holding the tip. Measured before this: the
  // tip sat correctly at the wall (137) up to the moment the raw needle
  // left the channel, then sprang out to 146, 154, 168 as the drag went on.
  //
  // So a pair that was contained last frame stays a candidate this frame,
  // and the depth is re-measured from where the tip is ALLOWED to be. The
  // loop closes: held inside the cavity, it still reads as in contact, so
  // it stays held. Pulling back out along the axis is what ends it -- the
  // sweep follows the retreat freely, the gap opens past Enter, and the
  // contact drops for the ordinary reason.
  const sticky = containedTips.has(pair);
  const walls = rawDepth > 0 || sticky ? regionPoints(pierced, transforms, 'barrier') : [];

  let contained = depthClamped;
  if (walls.length > 0 && axis) {
    // WHICH POINT IS THE ONE THAT MUST NOT CROSS
    //
    // Not the tip's middle. On anything but a very shallow tip the middle
    // sits well behind the part that actually goes in, and a wall running
    // down the side of a cavity starts BELOW it -- so the middle glides
    // over the top of the wall and out the other side without ever
    // entering a painted pixel. Measured on a 10-row tip against walls
    // occupying rows 121..144: the middle sat at 120 the whole way and
    // sailed straight past.
    //
    // The leading point does the entering, so it is the one contained.
    // Everything else about the tip is carried by the same correction,
    // which is how the middle -- still what the displacement radiates
    // from -- ends up where it belongs.
    // A flat tip has a whole ROW at the same distance along the axis, so
    // "the furthest one" is a tie between every texel across its front.
    // Picking any single winner picks a corner -- and a corner of a tip
    // wider than the cavity starts out already inside the wall, which
    // blocked entry down a completely open channel. The leading EDGE's
    // midpoint is the one point that means the same thing for a flat tip
    // and a pointed one.
    let best = -Infinity;
    for (const p of tip) best = Math.max(best, p.x * axis.x + p.y * axis.y);
    let leadSumX = 0;
    let leadSumY = 0;
    let leadCount = 0;
    for (const p of tip) {
      if (best - (p.x * axis.x + p.y * axis.y) > 0.5) continue;
      leadSumX += p.x;
      leadSumY += p.y;
      leadCount++;
    }
    const leadX = leadCount ? leadSumX / leadCount - tipMiddle.x : 0;
    const leadY = leadCount ? leadSumY / leadCount - tipMiddle.y : 0;

    const previous = containedTips.get(pair);
    const target = { x: depthClamped.x + leadX, y: depthClamped.y + leadY };
    let held = sweepContain(previous || target, target, walls);

    // CONTAINMENT HOLDS BACK; IT NEVER PULLS FORWARD
    //
    // The sweep starts from where the tip was last frame, so a withdrawal
    // whose path clips a wall could stop short and leave the tip deeper
    // than the finger is now asking for. Drawn, that is a piercer sliding
    // INTO the flesh on its own -- the needle appearing to be sucked in,
    // or to stick when pulled. Nothing here is allowed to do that: whatever
    // the walls say sideways, the along-axis component can only ever lag
    // the drag, never lead it.
    const ahead = (held.x - target.x) * axis.x + (held.y - target.y) * axis.y;
    if (ahead > 0) {
      held = { x: held.x - axis.x * ahead, y: held.y - axis.y * ahead };
    }

    // A BARRIER CROSSING, felt once per crossing.
    //
    // "Contained" means the sweep was stopped by a painted wall: the tip
    // tried to go somewhere the barrier does not allow. What is worth
    // feeling is the CROSSING -- the frame the tip first meets the wall --
    // not the leaning, which can go on for as long as a finger holds it
    // there. So this fires on the transition into contact and stays quiet
    // until the tip has come off the wall again.
    const blocked = Math.hypot(held.x - target.x, held.y - target.y) > 0.5;
    if (blocked && !wallContact.get(pair)) haptic('barrier');
    wallContact.set(pair, blocked);

    contained = { x: held.x - leadX, y: held.y - leadY };
    containedTips.set(pair, held);
  }

  let inPath = rawInPath;
  let gap = rawGap;
  let depth = rawDepth;
  const shiftX = contained.x - tipMiddle.x;
  const shiftY = contained.y - tipMiddle.y;
  if (axis && (Math.abs(shiftX) > 1e-6 || Math.abs(shiftY) > 1e-6)) {
    const moved = tip.map((p) => ({ x: p.x + shiftX, y: p.y + shiftY }));
    const heldAxial = axialGap(moved, flesh, contained, tipSpread, axis);
    if (heldAxial !== null) {
      inPath = true;
      gap = heldAxial.gap;
      surface = heldAxial.surface;
      depth = Math.min(end, Math.max(0, enter - heldAxial.gap));
    }
  }

  const engaged = depth > 0;
  if (!engaged || walls.length === 0) containedTips.delete(pair);

  return {
    // How much of the configured dent is currently cut, 0 to 1. Measured on
    // its OWN scale -- 0 at the Dent Trigger Distance, 1 at the End Point --
    // which is the whole point of that setting: contact and the notch are
    // two different events and the artist places them separately.
    dentT: inPath
      ? Math.min(1, Math.max(0, (dentStartOf(piercer, enter, end) - gap) / dentSpan(piercer, enter, end)))
      : 0,
    piercer,
    axis,
    // How far PAST the End Point the piercer has been driven. The depth
    // stops at End, but the drag does not, and this is the difference.
    overshoot,
    // Where the drag actually put the tip, against where it is allowed to
    // be once the depth cap and the walls have had their say. The gap
    // between the two IS how far the artwork has to be held back for the
    // tip to stop where it stopped -- see pierceHold(), which is simply
    // their difference and so covers both constraints at once.
    rawTip: tipMiddle,
    tip: contained,
    tipSpread,
    gap,
    inPath,
    depth,
    // Where the flesh's near face is, as a distance along the axis from the
    // scene origin. Projecting the tip forward by (surface - tipAlong)
    // lands exactly on the outline the piercer is going through, which is
    // where the dent's base is centred.
    surface,
    // 0 at first contact, 1 at the End Point and never more, however far
    // past it the piercer is pushed.
    t: depth / end,
    end,
    engaged,
  };
}

// Every measurable contact in the scene: each pierced layer paired
// with the one piercer that matters to it. One piece of flesh being pushed
// by two needles at once is not a thing this models, so exactly one is
// chosen, by a single rule: deepest wins, and when nothing is in yet (both
// depths zero) the nearest wins. That is stable rather than flickering
// between them, and it keeps the closest approach of a piercer that has
// not reached the Enter Point yet -- a real measurement, and the one the
// "nothing should be happening at this distance" case is made of.
//
// Whether that contact actually DOES anything is a separate question,
// asked with contact.engaged. A contact short of Enter has depth 0 and
// therefore a zero target, which is the same thing as no contact at all
// as far as the springs are concerned.
function activeContacts(transforms) {
  const piercers = partsStore.piercers;
  const piercedLayers = partsStore.piercedLayers;
  const contacts = [];
  for (const pierced of piercedLayers) {
    meshFor(pierced);
    let best = null;
    for (const piercer of piercers) {
      const contact = contactOf(piercer, pierced, transforms);
      if (!contact) continue;
      if (!best || contact.depth > best.depth ||
          (contact.depth === best.depth && contact.gap < best.gap)) {
        best = contact;
      }
    }
    contacts.push({ pierced, contact: best });
  }
  return contacts;
}

// ---------------------------------------------------------------------------
// What the renderer needs: who is inside whom, and which texels are which

// A 2D stack does not imply depth. A piercer drawn above the flesh it has
// entered goes on looking like it is lying ON the surface however far in
// the numbers say it is, because painter's-algorithm order is the only
// depth cue the scene bitmap has. So while a tip is actually in contact,
// it is drawn BENEATH the layer it has entered and the surface closes over
// it -- which is the same information a 3D renderer would get from a depth
// buffer, taken from the one place this app actually knows it.
//
// Only the painted TIP moves. The rest of the piercer -- the shaft of a
// needle, the finger behind a nail -- has not entered anything and stays
// exactly where it was in the stack, so the artwork reads as one object
// going in rather than the whole sprite ducking under.
//
// This map is written from the SAME contact objects the displacement is
// integrated from, in the same pass. There is one contact test, and both
// effects read its answer, so the tip cannot sink a frame before the flesh
// gives way or stay sunk a frame after it lets go.
let occlusion = new Map(); // piercer id -> the pierced part to sink beneath
let hold = new Map();      // piercer id -> how far to hold its artwork back
let dentCuts = new Map();  // pierced id -> its draw mask, dent texels zeroed
let occlusionStale = true;
let readout = [];

// ---------------------------------------------------------------------------
// Force transfer: the press the pierced layer feels back

// How hard a piercer at full depth presses, as an angular acceleration
// about the bone it is pressing on. Against the default stiffness of 180
// that is a steady deflection of about a seventh of a radian at the End
// Point with a full lever -- a lean you can see, well short of a flail.
const PIERCE_PUSH = 45;

// Past the End Point the tip stops advancing, but the DRAG does not, and
// that leftover travel is the only thing on screen still saying "harder".
// So it goes on counting toward the press after the depth has stopped
// counting -- which is what makes leaning on something feel different from
// resting against it -- up to one more End Point's worth, and no further.
const MAX_PRESS = 2;

// The moment arm, in units of the bone's own length, clamped so a contact
// far off to one side cannot manufacture an enormous torque out of a
// small force. Beyond the bone's own reach the lever stops growing.
const MAX_LEVER = 1;

let torqueChanged = false;
const torques = new Map();

// A PIERCE IS A FORCE, AND A FORCE HAS SOMEWHERE TO GO
//
// The contact already knows everything a torque needs: where the tip is,
// which way it is pushing, and how hard. What was missing was the other
// half of Newton's third law -- the pierced layer took the shape change
// and gave nothing back, so a piercer driven into a character stopped dead
// at the End Point against something that never reacted. Read as a
// picture, that is a needle hitting a wall, not entering flesh.
//
// So each engaged contact is turned into a torque about the head of every
// physics bone the pierced layer is ATTACHED to -- the user's own stated
// relationship, never guessed from proximity -- and handed to the bone
// integrator, where it sits in the same sum as gravity and the carry
// torque. The bone's own spring does the rest: it leans away under the
// press, settles there while the press holds, and springs back when the
// piercer withdraws and the torque goes to zero.
//
// This is a genuine feedback loop and is meant to be: the flesh leaning
// away opens the gap, which lowers the depth, which lowers the press. It
// converges rather than oscillating because the loop gain is well under
// one -- the contact point moves a fraction of the End Point's distance
// for a full deflection -- and the spring's damping absorbs what is left.
// That settling IS the soft-contact behaviour; nothing models it
// separately.
// How hard this contact is pressing, 0 at first touch and 1 at the End
// Point. t is the part of it the depth accounts for; the overshoot carries
// it on past, because past End the tip has stopped advancing and the
// leftover travel is the only thing still saying "harder".
function pressOf(contact) {
  if (!contact || !contact.engaged) return 0;
  const beyond = contact.end > 0 ? Math.min(1, contact.overshoot / contact.end) : 0;
  return Math.min(MAX_PRESS, contact.t + beyond);
}

function chainFrom(attached) {
  const seen = new Set();
  const chain = [];
  for (const start of attached) {
    let bone = start;
    // A cycle is not constructible through the UI, but the walk is
    // bounded by the visited set either way rather than by trust.
    while (bone && !seen.has(bone.id)) {
      seen.add(bone.id);
      chain.push(bone);
      bone = bonesStore.parentOf(bone);
    }
  }
  return chain;
}

function publishForce(contacts) {
  torques.clear();
  if (!bonesStore.hasPhysicsBones) return bonesStore.setPierceTorques(torques);

  for (const { pierced, contact } of contacts) {
    if (!contact || !contact.engaged || !contact.axis) continue;
    // The bones the layer is attached to, AND every bone above them. A
    // force on a link is felt at every joint it hangs from -- poke a
    // finger hard enough and the arm moves -- and each joint feels it
    // about its own head, with its own lever. Collected as a set so a
    // chain whose child and parent are both attached to the layer is
    // still pressed once.
    const bones = chainFrom(bonesStore.bonesAttachedTo(pierced.id));
    if (bones.length === 0) continue;

    // t is the press up to the End Point; the overshoot carries it on
    // past. Both are already clamped by the contact, so this is bounded
    // whatever the drag does.
    const press = pressOf(contact);
    if (press <= 0) continue;

    // The tip as it is ALLOWED to be, not as the drag asked -- the press
    // acts where the piercer actually is on screen.
    const at = contact.tip;
    for (const bone of bones) {
      if (!bone.physicsEnabled) continue;
      const head = bonesStore.worldHead(bone);
      const rx = at.x - head.x;
      const ry = at.y - head.y;
      // The 2D cross product of the arm with the push direction: the
      // signed moment, positive one way round the pivot and negative the
      // other, so a tip on the left of a bone turns it the other way from
      // one on the right without any special casing.
      const moment = (rx * contact.axis.y - ry * contact.axis.x) /
        Math.max(bone.length, 1);
      const lever = Math.max(-MAX_LEVER, Math.min(MAX_LEVER, moment));
      const add = PIERCE_PUSH * press * lever;
      torques.set(bone.id, (torques.get(bone.id) || 0) + add);
    }
  }
  return bonesStore.setPierceTorques(torques);
}

function publishOcclusion(contacts) {
  const next = new Map();
  const held = new Map();
  for (const { pierced, contact } of contacts) {
    if (!contact || !contact.engaged) continue;
    const current = next.get(contact.piercer.id);
    // Beneath the LOWEST layer it is inside, so every one of them draws
    // over it rather than just the topmost.
    if (!current || pierced.zIndex < current.zIndex) next.set(contact.piercer.id, pierced);

    // THE END POINT IS A LIMIT ON THE PIERCER, NOT JUST ON THE PUSH
    //
    // Capping the depth stops the flesh giving way any further, which is
    // half of what a hard limit means. The other half is that the piercer
    // itself has to stop, and it did not: its artwork was drawn at the raw
    // dragged position, so the drag carried it on through the layer and
    // out the far side while the depth sat pinned at End. Measured with a
    // needle driven past a 32 px block: depth held at 16 the whole way
    // while the tip travelled from 435 px to 720 px down the screen and
    // crossed the flesh's bottom edge at 590 -- a needle visibly coming
    // out the other side of something it was only ever meant to dent.
    //
    // So the artwork is held back by exactly the distance the depth
    // refused, along the piercer's own axis. The drag keeps being the
    // user's -- nothing blocks the finger, and moving sideways or pulling
    // out still tracks it one-for-one -- but the axis component of it
    // stops having any effect once End is reached, which is what "the tip
    // stops advancing" has to mean on screen. Pulling back shrinks the
    // overshoot to nothing and the piercer follows the finger again.
    const backX = contact.rawTip.x - contact.tip.x;
    const backY = contact.rawTip.y - contact.tip.y;
    const distance = Math.hypot(backX, backY);
    if (distance > 1e-6) {
      const previous = held.get(contact.piercer.id);
      // Two layers at once: obey whichever stopped it hardest.
      if (!previous || distance > previous.distance) {
        held.set(contact.piercer.id, { distance, x: backX, y: backY });
      }
    }
  }
  occlusion = next;
  hold = held;
  torqueChanged = publishForce(contacts);

  // THE DENT, BOTH HALVES OF IT, IN ONE PASS
  //
  // Written here rather than in the frame loop so the renderer's own
  // re-measure keeps it current: a frame that re-measured the contact but
  // drew last frame's shape would lag the drag by one frame at every
  // depth.
  //
  // The wedge is built once and both halves come off the SAME object --
  // the texels it takes out, and the push it gives the material around it.
  // That is what stops them reading as two effects that happen to overlap:
  // one depth fraction, one triangle, one rim.
  const cuts = new Map();
  for (const { pierced, contact } of contacts) {
    if (!pierced.mesh) continue;
    const tri = dentFor(pierced, contact);
    const entry = pierceStateFor(pierced.id, pierced.mesh.vertices.length);
    const pins = pierced.pins.size > 0 ? pinInfluence(pierced.mesh, pierced) : null;
    writeBunch(pierced.mesh, pierced, tri, entry.offsetX, entry.offsetY, pins);
    const mask = dentCutMask(pierced, tri);
    if (mask) cuts.set(pierced.id, mask);
  }
  dentCuts = cuts;
  // Taken from the same contacts in the same pass, so the on-screen
  // numbers are the ones the frame was actually drawn from rather than a
  // second measurement that could disagree with it.
  readout = contacts.map(({ pierced, contact }) => ({
    pierced: pierced.name,
    piercer: contact ? contact.piercer.name : null,
    gap: contact ? contact.gap : null,
    inPath: Boolean(contact && contact.inPath),
    enter: contact ? contact.piercer.pierceEnter : null,
    end: contact ? contact.end : null,
    depth: contact ? contact.depth : 0,
    // The dent fraction: 0 is no notch at all, 1 the full configured Depth
    // and Width. Worth reporting because it IS the wedge's size rather than
    // a scale factor on a push -- and because it runs on its own scale, so
    // seeing it sit at 0 while the depth climbs is how the trigger distance
    // proves it is doing something.
    dent: contact ? contact.dentT : 0,
    dentStart: contact ? dentStartOf(contact.piercer, contact.piercer.pierceEnter, contact.end) : null,
    engaged: Boolean(contact && contact.engaged),
    sunk: Boolean(contact && next.has(contact.piercer.id)),
    overshoot: contact ? contact.overshoot : 0,
    // How far the artwork is being held back in total -- the depth cap and
    // the walls together, since both land in the same difference.
    held: contact ? Math.hypot(contact.rawTip.x - contact.tip.x, contact.rawTip.y - contact.tip.y) : 0,
    // How hard the contact is pressing back on the pierced layer's bones,
    // 0 to 2. Reported because a press that produces no visible reaction
    // is otherwise indistinguishable from no press at all -- and the
    // usual reason for that is the lever, not the force.
    press: pressOf(contact),
    // Purely lateral: what the walls alone are doing, so a sideways
    // containment can be told apart from a depth cap on screen.
    walled: contact && contact.axis
      ? Math.abs((contact.rawTip.x - contact.tip.x) * -contact.axis.y
               + (contact.rawTip.y - contact.tip.y) * contact.axis.x)
      : 0,
  }));
  occlusionStale = false;
}

// What the solver currently reads, for the on-screen probe. Goes through
// pierceOcclusion() so a stale answer is re-measured first.
export function pierceReadout() {
  pierceOcclusion();
  return readout;
}

// Anything that can move a piercer or a layer invalidates this. The frame
// loop republishes on every step it takes, so while something is moving
// the answer is always this frame's; when the loop is asleep nothing is
// moving and the last answer still stands. This flag covers the gap
// between the two -- the first frame after a drag, where the renderer runs
// before the loop has stepped.
export function markPierceStale() {
  occlusionStale = true;
}

export function pierceOcclusion() {
  if (occlusionStale) {
    const transforms = bonesStore.isEmpty ? null : bonesStore.snapshotTransforms();
    publishOcclusion(partsStore.hasPierce ? activeContacts(transforms) : []);
  }
  return occlusion;
}

// How far each piercer's artwork is to be held back from where the drag
// actually put it, so its tip stops at the End Point. Empty for every
// piercer that has not reached its limit, which is the normal case.
export function pierceHold() {
  pierceOcclusion();
  return hold;
}

// The dent's cut, as a draw mask per pierced layer: one byte per source
// texel, zero where the wedge has taken the artwork out. Empty for every
// layer not currently dented, which is the normal case.
export function pierceDentCuts() {
  pierceOcclusion();
  return dentCuts;
}

// The wedge itself, for tests and for the on-canvas overlay -- the same
// object the cut and the bunching are both built from.
export function pierceDentOf(part) {
  pierceOcclusion();
  const transforms = bonesStore.isEmpty ? null : bonesStore.snapshotTransforms();
  for (const { pierced, contact } of activeContacts(transforms)) {
    if (pierced.id === part.id) return dentFor(pierced, contact);
  }
  return null;
}

// One byte per source texel, splitting a layer's artwork into its painted
// region and everything else. Cached against the region version, so
// painting rebuilds them and a frame never does.
const maskCache = new Map();

export function pierceMasks(part) {
  if (!part || part.pierceRegion.size === 0) return null;
  const size = part.naturalWidth * part.naturalHeight;
  const version = part.pierceRegionVersion || 0;
  const cached = maskCache.get(part.id);
  if (cached && cached.version === version && cached.region.length === size) return cached;

  const region = new Uint8Array(size);
  const rest = new Uint8Array(size).fill(1);
  for (const index of part.pierceRegion) {
    if (index < 0 || index >= size) continue;
    region[index] = 1;
    rest[index] = 0;
  }
  const entry = { version, region, rest };
  maskCache.set(part.id, entry);
  return entry;
}

// ---------------------------------------------------------------------------
// The region overlay: a testing aid, off by default

// Which pixels the app thinks are painted is invisible once the painter is
// closed, so "nothing is happening" and "the regions are not where I think
// they are" look identical. This draws them back onto the artwork, in the
// painter's own two colours, through the layer's own geometry -- so it
// follows every deformation exactly and cannot drift out of step with what
// it is reporting on.
//
// The colours are the painter's own, laid on harder than it lays them: the
// painter can dim the artwork underneath with its opacity sliders, and
// here the artwork is at full strength. So the hue still reads as pink or cyan over
// bright pixel art instead of washing out to a pale tint of whatever is
// beneath it. Opaque enough to identify, sheer enough to still see the
// artwork it is describing.
const OVERLAY_TIP = [255, 46, 147, 185];
const OVERLAY_AREA = [46, 230, 255, 185];
// Pierceable AND deformable, in the painter's amber. Telling the two
// apart on the canvas is the whole point of the split: cyan is where a
// pierce registers, amber is where it actually moves anything.
const OVERLAY_DEFORM = [255, 176, 46, 190];
// Walls, in a near-white the other three cannot be mistaken for. A barrier
// is not a degree of anything -- it is solid or it is not -- so it reads
// as the most opaque of the four.
const OVERLAY_BARRIER = [236, 238, 248, 215];

let overlayOn = false;
const overlayCache = new Map();

export function pierceOverlayEnabled() {
  return overlayOn;
}

export function setPierceOverlay(on) {
  overlayOn = Boolean(on);
}

// A texture the size of the layer's artwork: the region's colour where the
// user painted, fully transparent everywhere else. Drawn over the layer
// through the same triangles with the same mask, so it lands on exactly
// the texels it is describing.
export function pierceOverlayTexture(part) {
  if (!part) return null;
  if (part.pierceRegion.size === 0 && part.pierceBarrierRegion.size === 0) return null;
  const size = part.naturalWidth * part.naturalHeight;
  const version = `${part.pierceRegionVersion || 0}:${part.pierceDeformRegionVersion || 0}:` +
    `${part.pierceBarrierRegionVersion || 0}`;
  const cached = overlayCache.get(part.id);
  if (cached && cached.version === version && cached.role === part.pierceRole && cached.pixels.length === size * 4) {
    return cached.pixels;
  }

  const base = part.isPiercer ? OVERLAY_TIP : OVERLAY_AREA;
  const walls = part.isPiercer ? null : part.pierceBarrierRegion;
  // Deformable no longer means "gives way" and an empty one no longer
  // means "all of it". It is the material that BUNCHES around the dent,
  // and painting none of it asks for none -- so amber is drawn where the
  // artist actually painted, and nowhere else. An all-cyan pierceable area
  // is now a true report: pierceable, with nothing set to react.
  const pixels = new Uint8ClampedArray(size * 4);
  // Walls are drawn even where they sit outside the pierceable area: a
  // wall's whole job is to be somewhere the tip must not reach, and that
  // is often just beyond the cavity's edge.
  const marked = walls && walls.size > 0
    ? new Set([...part.pierceRegion, ...walls])
    : part.pierceRegion;
  for (const index of marked) {
    if (index < 0 || index >= size) continue;
    const wall = walls && walls.has(index);
    const soft = !wall && !part.isPiercer
      && part.pierceRegion.has(index) && part.pierceDeformRegion.has(index);
    if (!wall && !part.pierceRegion.has(index)) continue;
    const [r, g, b, a] = wall
      ? OVERLAY_BARRIER
      : (soft ? OVERLAY_DEFORM : base);
    const o = index * 4;
    pixels[o] = r;
    pixels[o + 1] = g;
    pixels[o + 2] = b;
    pixels[o + 3] = a;
  }
  overlayCache.set(part.id, { version, role: part.pierceRole, pixels });
  return pixels;
}

// ---------------------------------------------------------------------------
// The shape at this depth

// A dent needs somewhere to be cut from. Everything else about the two
// numbers is a legitimate setting -- a depth or a width of zero is simply
// "this layer registers contact without giving way" -- so this reports the
// one combination that is configured to do something and then cannot.
const placementIssues = new Map();

export function pierceDentIssue(part) {
  if (!part || !part.isPierced) return null;
  if (!(part.pierceDentDepth > 0) || !(part.pierceDentWidth > 0)) return null;
  if (part.pierceRegion.size === 0) {
    return 'a dent is configured but no Pierceable area is painted, so there ' +
      'is nothing for it to be cut out of';
  }
  // A placed dent can be dragged somewhere there is nothing to cut, which
  // the numbers alone cannot show: Depth and Width would both read as set
  // while the notch never appeared. Asked at FULL size, so a dent that only
  // reaches the paint part-way through its growth still counts as working.
  //
  // Cached, because this is asked once per pierced layer per frame and the
  // answer only moves when the paint or the placement does -- and the scan
  // is the wedge's whole bounding box, which at the top of the size range
  // is sixteen thousand texels.
  const key = `${part.pierceRegionVersion || 0}:${part.pierceRegion.size}:` +
    `${part.pierceDentDepth}:${part.pierceDentWidth}:${part.pierceDentPlaced}:` +
    `${part.pierceDentX}:${part.pierceDentY}:${part.pierceDentAngle}`;
  let cached = placementIssues.get(part.id);
  if (!cached || cached.key !== key) {
    cached = { key, empty: dentCutArea(part, dentTriangleAt(part, 1)) === 0 };
    placementIssues.set(part.id, cached);
  }
  if (cached.empty) {
    return 'the dent is placed where this layer has no Pierceable pixels, so ' +
      'there is nothing for it to cut — drag it onto the painted area';
  }
  return null;
}

// What the dent currently is, for this layer, given its contact. Rebuilt
// every frame from the live dent fraction -- the wedge IS that fraction, so
// there is no state to hold and nothing to get out of step.
//
// Gated on the DENT's fraction, not on contact.engaged. Enter and the
// trigger distance are separate settings and have to be able to disagree:
// a trigger set further out than Enter has to be able to start the notch
// before contact, and one set closer has to be able to hold it back after
// contact has begun. Reading engagement here would quietly overrule both.
function dentFor(pierced, contact) {
  if (!contact || !(contact.dentT > 0)) return null;
  if (pierceDentIssue(pierced) !== null) return null;
  return dentTriangleAt(pierced, contact.dentT);
}

// ---------------------------------------------------------------------------
// The frame step

// Advances every pierceable layer's displacement by dt seconds. Returns
// true while anything is still moving, so physics.js's loop knows when it
// may sleep -- including the whole spring-back after the piercer leaves,
// which is motion nobody is driving any more.
export function stepPierce() {
  if (!partsStore.hasPierce) {
    publishOcclusion([]);
    return false;
  }

  const transforms = bonesStore.isEmpty ? null : bonesStore.snapshotTransforms();
  // Publishing is what writes the shapes -- see publishOcclusion -- and it
  // happens on every path, including the ones with nothing in contact: an
  // empty answer is still this frame's answer, and a stale one would leave
  // a tip sunk under flesh it is no longer touching.
  publishOcclusion(activeContacts(transforms));

  // The SHAPE settles nothing: the outline IS the depth, so a given depth
  // always looks the same and there is no motion left over once the
  // piercer stops -- which is exactly the property the springs did not
  // have, and the reason they needed the loop kept awake.
  //
  // The PRESS does need one more step, though, and only when it changed.
  // The bones integrate before this runs, so a press first written after
  // their step would otherwise be sitting on a sleeping loop, unfelt. One
  // more frame hands it to them; from there their own settle test has it,
  // because an unbalanced press is an unbalanced spring.
  return torqueChanged;
}

// Test/debug window into the solver: what the contact currently reads and
// how far the flesh has actually been pushed. Proving displacement starts
// at Enter, caps at End and returns to zero is the whole verification.
export function pierceDebug() {
  const transforms = bonesStore.isEmpty ? null : bonesStore.snapshotTransforms();
  return activeContacts(transforms).map(({ pierced, contact }) => {
    const entry = peekPierceState(pierced.id);
    let worst = 0;
    if (entry) {
      for (let i = 0; i < entry.count; i++) {
        worst = Math.max(worst, Math.hypot(entry.offsetX[i], entry.offsetY[i]));
      }
    }
    return {
      pierced: pierced.name,
      // The measured separation is reported whether or not it is close
      // enough to do anything; null means there was nothing to measure at
      // all (a region on either side still unpainted).
      engaged: Boolean(contact && contact.engaged),
      inPath: Boolean(contact && contact.inPath),
      gap: contact ? contact.gap : null,
      depth: contact ? contact.depth : 0,
      t: contact ? contact.t : 0,
      dentT: contact ? contact.dentT : 0,
      maxOffset: worst,
    };
  });
}
