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
// TWO DRAWN SHAPES, NOT A PUSH
//
// The shape of the contact is a BLEND between two outlines the artist
// drew: the pierceable mask as painted (the rest shape) and a second mask
// painted for maximum depth (the entered shape). At any depth the
// rendered outline is a point-for-point interpolation between them, and
// every mesh vertex follows it through mean value coordinates. morph.js
// holds that machinery and explains it.
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
// Nothing about the blend is integrated over time. The outline IS the
// depth, so a given depth always looks the same, there is no state to fall
// out of step with the drag, and the frame loop has nothing left to settle
// once the piercer stops. The bones' own springs are untouched and go on
// reporting for themselves.
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
import { localToWorld, pinCarriageOffset, pinInfluence, generateMesh, defaultDensity } from './mesh.js';
import { pierceStateFor, peekPierceState } from './pierceState.js';
import {
  outlineOf, alignOutline, meanValueWeights, evaluateWeights, blendOutlines, blobCoverage,
} from './morph.js';

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
  const key = `${part.x},${part.y},${part.rotation},${part.scale},` +
    `${REGIONS[which].version(part)},${region.size},${carriage.x},${carriage.y}`;
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
    points.push({ x: world.x + carriage.x, y: world.y + carriage.y });
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
  return { x: middle.x + carriage.x, y: middle.y + carriage.y };
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
  return surface - lead;
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
  const measured = rawInPath ? axial : nearestSeparation(tip, flesh);

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
    const heldGap = axialGap(moved, flesh, contained, tipSpread, axis);
    if (heldGap !== null) {
      inPath = true;
      gap = heldGap;
      depth = Math.min(end, Math.max(0, enter - heldGap));
    }
  }

  const engaged = depth > 0;
  if (!engaged || walls.length === 0) containedTips.delete(pair);

  return {
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
let occlusionStale = true;
let readout = [];

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

  // The shape at this depth, written here rather than in the frame loop so
  // that the renderer's own re-measure keeps it current: a frame that
  // re-measured the contact but drew last frame's shape would lag the drag
  // by one frame at every depth.
  for (const { pierced, contact } of contacts) {
    if (!pierced.mesh) continue;
    const entry = pierceStateFor(pierced.id, pierced.mesh.vertices.length);
    writeMorph(pierced.mesh, pierced, contact, entry.offsetX, entry.offsetY);
  }
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
    // The blend fraction: 0 is the rest shape, 1 the entered one. Worth
    // reporting now that it IS the shape rather than a scale factor on a
    // push.
    t: contact ? contact.t : 0,
    engaged: Boolean(contact && contact.engaged),
    sunk: Boolean(contact && next.has(contact.piercer.id)),
    overshoot: contact ? contact.overshoot : 0,
    // How far the artwork is being held back in total -- the depth cap and
    // the walls together, since both land in the same difference.
    held: contact ? Math.hypot(contact.rawTip.x - contact.tip.x, contact.rawTip.y - contact.tip.y) : 0,
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
// The Entered silhouette, in the painter's violet. Only the texels it adds
// beyond the rest shape are tinted, deliberately: the question this answers
// is "is the shape I drew actually different, and which way does it go?",
// and filling the whole silhouette would paint over the cyan/amber split
// that the rest of the overlay exists to show. So violet reads as "the
// outline reaches out to here at full depth", and a pierceable texel with
// no violet beside it is one the outline pulls in from.
const OVERLAY_ENTERED = [178, 122, 255, 195];

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
  if (part.pierceRegion.size === 0 && part.pierceBarrierRegion.size === 0
    && part.pierceEnteredRegion.size === 0) return null;
  const size = part.naturalWidth * part.naturalHeight;
  const version = `${part.pierceRegionVersion || 0}:${part.pierceDeformRegionVersion || 0}:` +
    `${part.pierceBarrierRegionVersion || 0}:${part.pierceEnteredRegionVersion || 0}`;
  const cached = overlayCache.get(part.id);
  if (cached && cached.version === version && cached.role === part.pierceRole && cached.pixels.length === size * 4) {
    return cached.pixels;
  }

  const base = part.isPiercer ? OVERLAY_TIP : OVERLAY_AREA;
  const walls = part.isPiercer ? null : part.pierceBarrierRegion;
  const entered = part.isPiercer ? null : part.pierceEnteredRegion;
  // An unpainted deformable mask means the whole pierceable area gives
  // way, so it is all drawn as deformable -- the overlay says what will
  // actually happen, not what has been painted.
  const softAll = !part.isPiercer && part.pierceDeformRegion.size === 0;
  const pixels = new Uint8ClampedArray(size * 4);
  // Walls are drawn even where they sit outside the pierceable area: a
  // wall's whole job is to be somewhere the tip must not reach, and that
  // is often just beyond the cavity's edge.
  const extra = [];
  if (walls && walls.size > 0) extra.push(walls);
  if (entered && entered.size > 0) extra.push(entered);
  const marked = extra.length > 0
    ? new Set([...part.pierceRegion, ...extra.flatMap((set) => [...set])])
    : part.pierceRegion;
  for (const index of marked) {
    if (index < 0 || index >= size) continue;
    const wall = walls && walls.has(index);
    const grew = !wall && entered && entered.has(index) && !part.pierceRegion.has(index);
    const soft = !wall && !grew && !part.isPiercer
      && part.pierceRegion.has(index) && (softAll || part.pierceDeformRegion.has(index));
    if (!wall && !grew && !part.pierceRegion.has(index)) continue;
    const [r, g, b, a] = wall
      ? OVERLAY_BARRIER
      : (grew ? OVERLAY_ENTERED : (soft ? OVERLAY_DEFORM : base));
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

// Which vertices may move at all: 1 on painted deformable artwork, easing
// to 0 about a mesh cell outside it. The same shape of field pins use, and
// for the same reason -- a hard edge between "may move" and "may not"
// would crease the surface exactly at the boundary of the painted area.
function regionInfluence(mesh, part) {
  const version = `${part.pierceRegionVersion || 0}:${part.pierceDeformRegionVersion || 0}`;
  if (mesh._pierceInfluence && mesh._pierceInfluenceVersion === version) {
    return mesh._pierceInfluence;
  }

  const width = part.naturalWidth;
  const height = part.naturalHeight;
  const cellW = width / Math.max(1, mesh.cols);
  const cellH = height / Math.max(1, mesh.rows);
  const radius = Math.max(1, Math.max(cellW, cellH));

  // WHICH PIXELS MAY MOVE -- not which may be touched.
  //
  // Contact is decided by pierceRegion, over in contactOf(). This field is
  // the separate question of what gives way once contact has happened, and
  // it reads the DEFORMABLE mask: the pierceable pixels the user has said
  // may actually shift. Everything else pierceable still registers the
  // contact, still swaps the z-order, still reports its depth -- it simply
  // does not move, which is what a firm edge inside soft tissue looks like.
  //
  // An unpainted deformable mask means the whole pierceable area gives way,
  // which is how this behaved before the mask existed. The intersection is
  // taken rather than trusting the mask alone, so a stray mark outside the
  // pierceable area cannot make something deform that can never be touched.
  const deformable = part.pierceDeformRegion && part.pierceDeformRegion.size > 0
    ? [...part.pierceDeformRegion].filter((index) => part.pierceRegion.has(index))
    : part.pierceRegion;

  // Painted texels collapse to the cells they sit in, exactly as pins do:
  // a mesh can only express what its vertices can, and this also caps the
  // work at cols x rows however many thousands of pixels were painted.
  const cells = new Set();
  for (const index of deformable) {
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

  mesh._pierceInfluence = influence;
  mesh._pierceInfluenceVersion = version;
  return influence;
}

// THE TWO DRAWN OUTLINES, AND EVERY VERTEX'S PLACE BETWEEN THEM
//
// Tracing the masks and solving the mean value coordinates is the only
// expensive part of this, and none of it depends on depth -- so it is done
// once per painted change and kept. What a frame does is the cheap half:
// blend two point lists and evaluate weights that are already solved.
const morphCache = new Map();

// A painted shape has to be one piece to have an outline. Below this much
// of it in a single blob it is two pieces or more, and there is no honest
// one-to-one pairing to blend along. A speck of overspray is far above it.
const MIN_COVERAGE = 0.9;

// Why a pierced layer is not morphing, in the user's terms -- null when it
// is, or when it has simply not been given a second shape yet. The painter
// and the Pierce window both say this out loud, because a drawing that is
// quietly ignored is worse than one that is refused.
export function pierceMorphIssue(part) {
  if (!part || !part.isPierced || part.pierceEnteredRegion.size === 0) return null;
  const w = part.naturalWidth;
  const h = part.naturalHeight;
  if (part.pierceRegion.size === 0) return 'no pierceable shape to blend from';
  if (blobCoverage(part.pierceRegion, w, h) < MIN_COVERAGE) {
    return 'the pierceable shape is painted in separate pieces';
  }
  if (blobCoverage(part.pierceEnteredRegion, w, h) < MIN_COVERAGE) {
    return 'the entered shape is cut into separate pieces';
  }
  return null;
}

function morphFor(part, mesh) {
  const version = `${part.pierceRegionVersion || 0}:${part.pierceEnteredRegionVersion || 0}:` +
    `${mesh.vertices.length}`;
  const cached = morphCache.get(part.id);
  if (cached && cached.version === version) return cached.data;

  let data = null;
  // No entered shape means nothing to blend toward, so the region simply
  // keeps its rest shape. That is a state the user has not finished
  // configuring, not an error.
  if (part.pierceRegion.size > 0 && part.pierceEnteredRegion.size > 0
    && pierceMorphIssue(part) === null) {
    const rest = outlineOf(part.pierceRegion, part.naturalWidth, part.naturalHeight);
    const drawn = outlineOf(part.pierceEnteredRegion, part.naturalWidth, part.naturalHeight);
    if (rest.length > 0 && rest.length === drawn.length) {
      const entered = alignOutline(rest, drawn);
      const halfW = part.naturalWidth / 2;
      const halfH = part.naturalHeight / 2;
      // In the layer's own texel space, which is where both outlines live
      // and the one space that does not move when the layer does.
      const weights = mesh.vertices.map((vertex) => meanValueWeights(
        { x: vertex.restLocal.x + halfW, y: vertex.restLocal.y + halfH }, rest
      ));
      data = { rest, entered, weights };
    }
  }
  morphCache.set(part.id, { version, data });
  return data;
}

// Every vertex's offset at this contact's depth: where the blended outline
// puts it, against where the rest outline did. Nothing here is integrated
// or springs anywhere -- the shape IS the depth, so a given depth always
// looks the same and there is no state to get out of step.
function writeMorph(mesh, part, contact, offsetX, offsetY) {
  const morph = morphFor(part, mesh);
  if (!morph) {
    offsetX.fill(0);
    offsetY.fill(0);
    return;
  }

  const influence = regionInfluence(mesh, part);
  const pins = part.pins.size > 0 ? pinInfluence(mesh, part) : null;
  const shape = blendOutlines(morph.rest, morph.entered, contact ? contact.t : 0);
  // Texel space to scene space: the layer's integer scale, then its
  // rotation. The offsets are added to bone-skinned positions, which are
  // already in scene space.
  const cos = Math.cos(part.rotation) * part.scale;
  const sin = Math.sin(part.rotation) * part.scale;

  for (let i = 0; i < mesh.vertices.length; i++) {
    const region = influence[i];
    const pinned = pins ? pins[i] : 0;
    const share = region * (1 - pinned);
    if (share <= 0) {
      offsetX[i] = 0;
      offsetY[i] = 0;
      continue;
    }
    const moved = evaluateWeights(morph.weights[i], shape);
    const rest = evaluateWeights(morph.weights[i], morph.rest);
    const dx = (moved.x - rest.x) * share;
    const dy = (moved.y - rest.y) * share;
    offsetX[i] = dx * cos - dy * sin;
    offsetY[i] = dx * sin + dy * cos;
  }
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

  // Nothing here settles. The outline IS the depth, so a given depth
  // always looks the same and there is no motion left over once the
  // piercer stops -- which is exactly the property the springs did not
  // have, and the reason they needed the loop kept awake. The bones' own
  // springs still drive it; they are untouched and report for themselves.
  return false;
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
      maxOffset: worst,
    };
  });
}
