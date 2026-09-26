// Pierce: a piercer going BETWEEN two halves, which part to let it in.
//
// THE MOTION
//
// A closed fist, the thumb pressing into the seam between two fingers. As
// the thumb goes in, two things happen at once and are one motion: the
// thumb's own tip travels in along its path, visible the whole way, and the
// two fingers swing apart about their own bases into a V exactly as wide as
// the thumb has gone deep. The V never exists first and gets filled; there is
// no stage where the tip vanishes and reappears inside an opening. Both are
// read off ONE number -- the depth below -- in the same frame.
//
// The thumb is the PIERCER. The fingers are the two HALVES of the pierced
// side: two separate layers the artist paired, or one layer split by a seam
// the artist drew (see spread.js for the halves, their hinges and the V's
// geometry). This file measures the depth, turns it into how open the V is,
// and publishes that for the deformation to read.
//
// It replaced a model that CUT a triangular dent out of the pierced artwork
// and bunched "Deformable" pixels around it. That showed the piercer's tip
// sinking out of sight under the surface and then appearing inside a
// pre-formed notch -- which is not how two fingers make room for a thumb.
//
// HOW DEEP IS DEEP
//
//   gap   = how far the piercer's painted TIP still has to travel to reach
//           the painted PIERCEABLE pixels, in scene pixels -- measured
//           ALONG THE PIERCER'S OWN AXIS, and SIGNED: negative once the
//           tip is already that far in.
//   Enter = the gap at which contact begins. Further out than this and
//           nothing engages at all.
//   End   = how much FURTHER past that first contact the depth keeps
//           growing. Reaching it is the maximum, and going deeper than it
//           changes nothing more -- the hard limit.
//
//   depth = clamp(Enter - gap, 0, End)      t = depth / End
//
// The sign is the whole reason the gap is measured along an axis rather
// than as a plain nearest-pixel distance: two overlapping regions are zero
// apart however much further the tip is driven in, so a nearest-pixel
// distance could never say "deeper". Along the axis, driving deeper keeps
// making the number smaller, so Enter, the trigger and End sit on one
// continuous scale the way the depth bar draws them.
//
// HOW OPEN IS OPEN
//
// The V has its own start, the Dent Trigger Distance -- a gap on the same
// scale, independent of Enter -- and is fully open at the End Point:
//
//   open  = clamp((trigger - gap) / (trigger - (Enter - End)), 0, 1)
//
// So the halves are shut at the trigger, fully apart at End, and move
// smoothly in between; contact and opening are two different events the
// artist places separately. Nothing is integrated over time: a given depth
// always looks the same, and backing out runs the identical numbers down to
// shut. The bones' own springs are untouched and report for themselves.
//
// THE LIMIT BINDS THE PIERCER TOO
//
// Past End the piercer is DRAWN short of where the drag put it, by exactly
// the distance the depth refused (see pierceHold), so its tip stops where the
// depth stopped. Nothing blocks the finger: the layer's real coordinates
// still follow the drag and the contact is measured from them, so only the
// along-axis component of the motion stops having a visible effect.

import { partsStore, PiercePhysics, SpreadMode } from './parts.js';
import { bonesStore } from './bones.js';
import {
  localToWorld, pinCarriageOffset, generateMesh, defaultDensity,
} from './mesh.js';
import { publishSpreadOpen } from './pierceState.js';
import { carryByCorrection } from './pxlinkState.js';
import {
  pierceTargets, spreadTargetOf, spreadGeometry, swingAt, swingAtTexel, fullSwing,
} from './spread.js';
import { haptic } from './haptics.js';

export { resetPierceState } from './pierceState.js';

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
// and what cannot be crossed.
const REGIONS = {
  pierce: { set: (part) => part.pierceRegion, version: (part) => part.pierceRegionVersion || 0 },
  barrier: { set: (part) => part.pierceBarrierRegion, version: (part) => part.pierceBarrierRegionVersion || 0 },
};

function regionPoints(part, transforms, which = 'pierce') {
  if (!part) return [];
  const region = REGIONS[which].set(part);
  if (!region || region.size === 0) return [];
  const carriage = pinCarriageOffset(part, transforms);
  // (A PxLink never moves a layer as a whole -- it only welds the
  // neighbourhood of its link point -- so it adds nothing here.)
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
    const carried = { x: world.x + carriage.x, y: world.y + carriage.y };
    points.push(carried);
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
  publishSpreadOpen([]);
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
  // Both numbers, not just their difference. The gap is what engagement is
  // measured from; `surface` is WHERE along the axis the flesh's near face
  // sits, which is the only thing that says where on the outline the dent's
  // base belongs. Deriving it later from the gap is not possible once
  // containment has moved the tip, so it travels with the reading that
  // produced it.
  return { gap: surface - lead, surface };
}

// A V NEEDS A MESH TO SWING
//
// The halves turn by moving their mesh vertices, so a pierced layer with no
// mesh has nothing to turn. It is built here, on demand, rather than asking
// the user to rig and bind flesh first -- a prerequisite that has nothing to
// do with piercing. An unbound mesh has no bind pose and no weights, so
// skinning it is the identity -- it renders exactly as the flat sprite did --
// and binding the layer later replaces it as usual.
function meshFor(part) {
  if (!part.mesh) part.mesh = generateMesh(part, defaultDensity(part));
  return part.mesh;
}

// THE V'S OWN TWO ENDS
//
// The V starts opening at the Dent Trigger Distance -- the piercer's third
// depth, independent of Enter -- and is fully open at the End Point, the same
// place the depth stops. Sharing the far end is deliberate: a drag should not
// have two different "all the way in" positions, one for the numbers and one
// for the artwork.
//
// The near end has to stay in front of the far one, and nothing stops the
// user from editing Enter or End afterwards into a pair that puts it behind.
// Rather than refuse the edit or divide by a span of nothing, the trigger is
// held one pixel clear of the End Point: the V then starts as late as it
// still can, which is the closest thing to what was asked for.
const MIN_DENT_SPAN = 1;

function dentStartOf(piercer, enter, end) {
  const stored = Number.isFinite(piercer.pierceDentStart) ? piercer.pierceDentStart : enter;
  return Math.max(stored, enter - end + MIN_DENT_SPAN);
}

function dentSpan(piercer, enter, end) {
  return dentStartOf(piercer, enter, end) - (enter - end);
}

// Where a texel of a pierced layer sits at rest, the same way regionPoints
// places painted texels -- for the hinges the Barrier's walls turn about.
function restPoint(part, transforms, u, v) {
  const carriage = pinCarriageOffset(part, transforms);
  const world = localToWorld(part, { x: u - part.naturalWidth / 2, y: v - part.naturalHeight / 2 });
  return { x: world.x + carriage.x, y: world.y + carriage.y };
}

// A BARRIER IN A V IS TWO WALLS THAT OPEN WITH IT
//
// Walls are painted on the halves -- typically down each half's inner edge,
// either side of the seam -- so they swing with the halves: each wall texel
// turned about its own half's hinge by exactly the angle the artwork is at.
// The channel between them therefore widens as the V opens, and the tip may
// drift sideways within it by exactly as much as the V has made room for.
function wallPoints(target, transforms, open) {
  const out = [];
  for (const layer of target.layers) {
    const points = regionPoints(layer, transforms, 'barrier');
    if (points.length === 0) continue;
    if (!(open > 0) || target.mode === SpreadMode.OFF) { out.push(...points); continue; }
    const hinges = new Map();
    let k = 0;
    // regionPoints walks the region in the same order, so point k IS the
    // k-th texel of the set.
    for (const index of layer.pierceBarrierRegion) {
      const p = points[k++];
      if (!p) break;
      const u = (index % layer.naturalWidth) + 0.5;
      const v = Math.floor(index / layer.naturalWidth) + 0.5;
      const swing = swingAtTexel(layer, u, v, open);
      if (!swing || swing.angle === 0) { out.push(p); continue; }
      const hk = `${swing.hinge.u},${swing.hinge.v}`;
      if (!hinges.has(hk)) hinges.set(hk, restPoint(layer, transforms, swing.hinge.u, swing.hinge.v));
      const at = hinges.get(hk);
      out.push(carryByCorrection(
        { cos: Math.cos(swing.angle), sin: Math.sin(swing.angle), from: at, to: at }, p));
    }
  }
  return out;
}

// The V's centre line in the scene: through the point of the V (between its
// hinges), out along its seam to the mouth -- placed the same way the walls
// are, so the two agree about where the channel is.
function centreLine(target, transforms) {
  const geometry = spreadGeometry(target);
  if (!geometry) return null;
  if (target.mode === SpreadMode.SEAM) {
    const layer = target.layers[0];
    const origin = restPoint(layer, transforms, geometry.origin.x, geometry.origin.y);
    const mouth = restPoint(layer, transforms, geometry.mouth.x, geometry.mouth.y);
    const length = Math.hypot(mouth.x - origin.x, mouth.y - origin.y);
    if (length < 1e-6) return null;
    return { origin, axis: { x: (mouth.x - origin.x) / length, y: (mouth.y - origin.y) / length } };
  }
  const [a, b] = geometry.halves.map((half) => restPoint(half.part, transforms, half.hinge.u, half.hinge.v));
  return { origin: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, axis: geometry.axis };
}

// SIDEWAYS ONLY, INSIDE A V
//
// In a V the walls say how far the tip may drift ACROSS the channel, never
// how deep it may go -- that is the depth's job, and a wall that could stop
// the tip going in could stop the V from ever opening (the V opens because
// the tip goes in). So the tip is held on the line across the channel at its
// own depth: swept out from the V's centre line toward where the drag puts
// it, and stopped at the first wall. The centre line is the gap between the
// halves, so it is open by construction; a wall painted right across it
// fails open rather than trapping the tip.
function containAcross(aim, line, walls) {
  const s = (aim.x - line.origin.x) * line.axis.x + (aim.y - line.origin.y) * line.axis.y;
  const centre = { x: line.origin.x + line.axis.x * s, y: line.origin.y + line.axis.y * s };
  if (blockedAt(wallGridFor(walls), centre.x, centre.y)) return aim;
  return sweepContain(centre, aim, walls);
}

// How open the V is at this gap: 0 at the Dent Trigger Distance, 1 at the
// End Point, straight line in between.
function openAt(piercer, enter, end, gap) {
  return Math.min(1, Math.max(0, (dentStartOf(piercer, enter, end) - gap) / dentSpan(piercer, enter, end)));
}

function targetFor(pierced) {
  if (!pierced) return null;
  if (pierced.layers) return pierced;
  return spreadTargetOf(pierced) || { mode: SpreadMode.OFF, key: `off:${pierced.id}`, layers: [pierced] };
}

// The live contact between one piercer and one pierced target -- a single
// pierced layer, or the two halves of a V measured TOGETHER, so the pair has
// one depth and one opening rather than two that could disagree. Null when
// either side has nothing painted: an unpainted region is not a contact of
// size zero, it is no contact at all.
export function contactOf(piercer, pierced, transforms) {
  const target = targetFor(pierced);
  if (!piercer || !target) return null;
  const tip = regionPoints(piercer, transforms);
  const flesh = target.layers.flatMap((layer) => regionPoints(layer, transforms));
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
  const pair = `${piercer.id}:${target.key}`;

  // Apply the Physics Direction. The gap the rest of this function works
  // from is the measured one plus everything the excluded side has moved it
  // by since this pair came into range -- which is to say, the gap as it
  // would be if that side had stayed where it was. For a V that decides
  // whose movement drives the whole coupled motion -- the tip going in and
  // the halves parting -- because both are read off this one gap.
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

  // Past End the contact's geometry stops advancing as well as the depth
  // number: the tip is held where End was reached.
  const overshoot = rawInPath ? Math.max(0, (enter - end) - rawGap) : 0;
  const depthClamped = overshoot > 0
    ? { x: tipMiddle.x - axis.x * overshoot, y: tipMiddle.y - axis.y * overshoot }
    : tipMiddle;

  // A CONTAINED TIP IS STILL IN THERE
  //
  // A pair that was contained last frame stays a candidate this frame, and
  // the depth is re-measured from where the tip is ALLOWED to be -- held
  // inside the channel, it still reads as in contact, so it stays held.
  // Pulling back out along the axis is what ends it.
  const sticky = containedTips.has(pair);
  const walled = rawDepth > 0 || sticky;

  // The leading point does the entering, so it is the one contained: the
  // leading EDGE's midpoint, which means the same thing for a flat tip and a
  // pointed one.
  let leadX = 0;
  let leadY = 0;
  if (axis) {
    let best = -Infinity;
    for (const p of tip) best = Math.max(best, p.x * axis.x + p.y * axis.y);
    let sx = 0; let sy = 0; let n = 0;
    for (const p of tip) {
      if (best - (p.x * axis.x + p.y * axis.y) > 0.5) continue;
      sx += p.x; sy += p.y; n++;
    }
    leadX = n ? sx / n - tipMiddle.x : 0;
    leadY = n ? sy / n - tipMiddle.y : 0;
  }

  // Walls sit where the halves are at a given opening, and the opening
  // depends on where the walls let the tip get to. Measured at the raw
  // opening first, then -- if containment changed the depth -- once more at
  // the opening that produced, so the walls the tip is held by are the walls
  // that are drawn.
  const inV = target.mode !== SpreadMode.OFF;
  const contain = (open) => {
    const walls = (inV ? rawDepth > 0 : walled) ? wallPoints(target, transforms, open) : [];
    if (walls.length === 0 || !axis) return { contained: depthClamped, walls, held: null, blocked: false };
    const aim = { x: depthClamped.x + leadX, y: depthClamped.y + leadY };
    if (inV) {
      const line = centreLine(target, transforms);
      const held = line ? containAcross(aim, line, walls) : aim;
      const blocked = Math.hypot(held.x - aim.x, held.y - aim.y) > 0.5;
      return { contained: { x: held.x - leadX, y: held.y - leadY }, walls, held, blocked, across: true };
    }
    const previous = containedTips.get(pair);
    let held = sweepContain(previous || aim, aim, walls);
    // CONTAINMENT HOLDS BACK; IT NEVER PULLS FORWARD: whatever the walls say
    // sideways, the along-axis component can only ever lag the drag.
    const ahead = (held.x - aim.x) * axis.x + (held.y - aim.y) * axis.y;
    if (ahead > 0) held = { x: held.x - axis.x * ahead, y: held.y - axis.y * ahead };
    const blocked = Math.hypot(held.x - aim.x, held.y - aim.y) > 0.5;
    return { contained: { x: held.x - leadX, y: held.y - leadY }, walls, held, blocked };
  };
  const measureAt = (contained) => {
    const shiftX = contained.x - tipMiddle.x;
    const shiftY = contained.y - tipMiddle.y;
    if (!axis || (Math.abs(shiftX) <= 1e-6 && Math.abs(shiftY) <= 1e-6)) {
      return { inPath: rawInPath, gap: rawGap, surface, depth: rawDepth };
    }
    const moved = tip.map((p) => ({ x: p.x + shiftX, y: p.y + shiftY }));
    const heldAxial = axialGap(moved, flesh, contained, tipSpread, axis);
    if (heldAxial === null) return { inPath: rawInPath, gap: rawGap, surface, depth: rawDepth };
    return {
      inPath: true,
      gap: heldAxial.gap,
      surface: heldAxial.surface,
      depth: Math.min(end, Math.max(0, enter - heldAxial.gap)),
    };
  };

  const rawOpen = rawInPath ? openAt(piercer, enter, end, rawGap) : 0;
  let pass = contain(rawOpen);
  let reading = measureAt(pass.contained);
  let open = reading.inPath ? openAt(piercer, enter, end, reading.gap) : 0;
  if (pass.walls.length > 0 && Math.abs(open - rawOpen) > 1e-3) {
    pass = contain(open);
    reading = measureAt(pass.contained);
    open = reading.inPath ? openAt(piercer, enter, end, reading.gap) : 0;
  }
  if (pass.held) {
    // A BARRIER CROSSING, felt once per crossing -- the frame the tip first
    // meets the wall, not the leaning.
    if (pass.blocked && !wallContact.get(pair)) haptic('barrier');
    wallContact.set(pair, pass.blocked);
    // Only the plain sweep carries its position frame to frame; across a V
    // the tip is placed from the centre line afresh every frame.
    if (!pass.across) containedTips.set(pair, pass.held);
  }

  const { inPath, gap, depth } = reading;
  surface = reading.surface;
  const engaged = depth > 0;
  if (!engaged || pass.walls.length === 0) containedTips.delete(pair);

  return {
    // How open the V is, 0 to 1 -- on its OWN scale, 0 at the Dent Trigger
    // Distance and 1 at the End Point. Zero for a target with no V.
    openT: target.mode === SpreadMode.OFF ? 0 : open,
    piercer,
    target,
    axis,
    // How far PAST the End Point the piercer has been driven.
    overshoot,
    // Where the drag actually put the tip, against where it is allowed to be
    // once the depth cap and the walls have had their say; their difference
    // is how far the artwork is held back (see pierceHold).
    rawTip: tipMiddle,
    tip: pass.contained,
    tipSpread,
    gap,
    inPath,
    depth,
    surface,
    // 0 at first contact, 1 at the End Point and never more.
    t: depth / end,
    end,
    engaged,
  };
}

// Every measurable contact in the scene: each pierced target (a V of two
// halves counts once) paired with the one piercer that matters to it --
// deepest wins, and when nothing is in yet the nearest wins, so the choice
// is stable rather than flickering between piercers.
function activeContacts(transforms) {
  const piercers = partsStore.piercers;
  const contacts = [];
  for (const target of pierceTargets()) {
    for (const layer of target.layers) meshFor(layer);
    let best = null;
    for (const piercer of piercers) {
      const contact = contactOf(piercer, target, transforms);
      if (!contact) continue;
      if (!best || contact.depth > best.depth ||
          (contact.depth === best.depth && contact.gap < best.gap)) {
        best = contact;
      }
    }
    contacts.push({ target, contact: best });
  }
  return contacts;
}

// ---------------------------------------------------------------------------
// What the renderer needs: who is drawn in front of whom

// WHICH WAY THE TIP GOES IN THE STACK
//
// A plain pierced layer (no V) is ENTERED: its surface closes over the tip,
// so while in contact the painted tip is drawn BENEATH it -- the depth cue a
// 3D renderer would get from a depth buffer.
//
// A V is different, and that difference is the point of it. The tip goes
// BETWEEN the halves, into a gap they open for it, and it stays visible the
// whole way in -- its own shape, travelling along its own path. Hiding it
// beneath the halves would make it vanish and then reappear in the opening,
// which is exactly the "appearing inside a pre-formed hole" this replaced.
// So against a V the painted tip is drawn IN FRONT of both halves.
//
// Either way only the painted TIP moves in the stack. The rest of the
// piercer has not entered anything and stays where it was.
let occlusion = new Map(); // piercer id -> { mode: 'sink' | 'lift', layers }
let hold = new Map();      // piercer id -> how far to hold its artwork back
let occlusionStale = true;
let readout = [];

// ---------------------------------------------------------------------------
// Force transfer: the press the pierced side feels back

// How hard a piercer at full depth presses, as an angular acceleration about
// the bone it is pressing on. Against the default stiffness of 180 that is a
// steady deflection of about a seventh of a radian at the End Point with a
// full lever -- a lean you can see, well short of a flail.
const PIERCE_PUSH = 45;
// Past the End Point the leftover drag goes on counting toward the press, up
// to one more End Point's worth -- leaning on something feels different from
// resting against it.
const MAX_PRESS = 2;
// The moment arm, in units of the bone's own length, clamped so a contact far
// off to one side cannot manufacture an enormous torque.
const MAX_LEVER = 1;

let torqueChanged = false;
const torques = new Map();

// How hard this contact is pressing IN, 0 at first touch and 1 at the End
// Point, with the overshoot carrying it on past.
function pressOf(contact) {
  if (!contact || !contact.engaged) return 0;
  const beyond = contact.end > 0 ? Math.min(1, contact.overshoot / contact.end) : 0;
  return Math.min(MAX_PRESS, contact.t + beyond);
}

// How hard the halves are being pushed APART: the V's own opening, with the
// same overshoot on top. Zero until the V starts to open.
function spreadPressOf(contact) {
  if (!contact || !(contact.openT > 0)) return 0;
  const beyond = contact.end > 0 ? Math.min(1, contact.overshoot / contact.end) : 0;
  return Math.min(MAX_PRESS, contact.openT + beyond);
}

function chainFrom(attached) {
  const seen = new Set();
  const chain = [];
  for (const start of attached) {
    let bone = start;
    while (bone && !seen.has(bone.id)) {
      seen.add(bone.id);
      chain.push(bone);
      bone = bonesStore.parentOf(bone);
    }
  }
  return chain;
}

function addTorque(bone, at, dir, press) {
  const head = bonesStore.worldHead(bone);
  const rx = at.x - head.x;
  const ry = at.y - head.y;
  // The 2D cross product of the arm with the push: the signed moment, so a
  // push on either side of a pivot turns it the right way round without any
  // special casing.
  const moment = (rx * dir.y - ry * dir.x) / Math.max(bone.length, 1);
  const lever = Math.max(-MAX_LEVER, Math.min(MAX_LEVER, moment));
  torques.set(bone.id, (torques.get(bone.id) || 0) + PIERCE_PUSH * press * lever);
}

// Which way a half's own bones are pushed: straight away from the seam, on
// that half's side -- the direction the half is being parted in. The seam's
// normal is in the halves' frame: the scene for a pair, the layer's texels
// (turned by the layer's rotation) for a seam.
function spreadPush(target, geometry, half) {
  let n = geometry.normal;
  if (target.mode === SpreadMode.SEAM) {
    const layer = target.layers[0];
    const c = Math.cos(layer.rotation);
    const s = Math.sin(layer.rotation);
    n = { x: n.x * c - n.y * s, y: n.x * s + n.y * c };
  }
  return { x: n.x * half.sigma, y: n.y * half.sigma };
}

// A PIERCE IS A FORCE, AND A FORCE HAS SOMEWHERE TO GO
//
// Each engaged contact is turned into torques about the heads of the physics
// bones the pierced side is ATTACHED to (the user's own stated
// relationship, never guessed) and handed to the bone integrator, where the
// bone's own spring does the rest: it leans under the press, settles while
// the press holds, and springs back -- jiggling -- when the piercer
// withdraws.
//
// Against a V, the halves are being pushed APART, so each half's own bones
// are pushed sideways, away from the seam, by as much as the V is open. The
// bones those hang from (a palm, an arm) feel the piercer's push along its
// own axis, as any pierced layer does -- once each, however many halves
// hang from them.
function publishForce(contacts, transforms) {
  torques.clear();
  if (!bonesStore.hasPhysicsBones) return bonesStore.setPierceTorques(torques);

  for (const { target, contact } of contacts) {
    if (!contact || !contact.engaged || !contact.axis) continue;
    const at = contact.tip;
    const press = pressOf(contact);
    const geometry = target.mode === SpreadMode.OFF ? null : spreadGeometry(target);
    const lateral = new Map(); // bone id -> push direction, for half bones
    const spreadPress = spreadPressOf(contact);
    if (geometry && spreadPress > 0) {
      for (const half of geometry.halves) {
        for (const bone of bonesStore.bonesAttachedTo(half.part.id)) {
          if (target.mode === SpreadMode.PAIR) {
            lateral.set(bone.id, spreadPush(target, geometry, half));
            continue;
          }
          // One layer: a bone belongs to the half its middle lies on.
          const head = bonesStore.worldHead(bone);
          const tail = bonesStore.worldTail(bone);
          const mid = { x: (head.x + tail.x) / 2, y: (head.y + tail.y) / 2 };
          const hinge = restPoint(half.part, transforms, half.hinge.u, half.hinge.v);
          const push = spreadPush(target, geometry, half);
          const side = (mid.x - hinge.x) * push.x + (mid.y - hinge.y) * push.y;
          if (side > 1) lateral.set(bone.id, push);
        }
      }
    }
    const attached = target.layers.flatMap((layer) => bonesStore.bonesAttachedTo(layer.id));
    for (const bone of chainFrom(attached)) {
      if (!bone.physicsEnabled) continue;
      const sideways = lateral.get(bone.id);
      if (sideways) addTorque(bone, at, sideways, spreadPress);
      else if (press > 0) addTorque(bone, at, contact.axis, press);
    }
  }
  return bonesStore.setPierceTorques(torques);
}

function publishOcclusion(contacts, transforms = null) {
  const next = new Map();
  const held = new Map();
  const open = [];
  for (const { target, contact } of contacts) {
    if (!contact) continue;
    if (target.mode !== SpreadMode.OFF && contact.openT > 0) open.push([target.key, contact.openT]);
    const inFront = target.mode !== SpreadMode.OFF;
    if (contact.engaged || (inFront && contact.openT > 0)) {
      const current = next.get(contact.piercer.id);
      if (inFront) {
        // In front of every half, so none of them can cover the tip.
        const layers = current && current.mode === 'lift' ? [...current.layers, ...target.layers] : [...target.layers];
        next.set(contact.piercer.id, { mode: 'lift', layers });
      } else if (!current || (current.mode === 'sink' && target.layers[0].zIndex < current.layers[0].zIndex)) {
        // Beneath the LOWEST layer it is inside, so every one of them draws
        // over it rather than just the topmost.
        next.set(contact.piercer.id, { mode: 'sink', layers: [target.layers[0]] });
      }
    }

    if (!contact.engaged) continue;
    // THE END POINT IS A LIMIT ON THE PIERCER, NOT JUST ON THE DEPTH: the
    // artwork is held back by exactly the distance the depth (and the walls)
    // refused, along the piercer's own axis.
    const backX = contact.rawTip.x - contact.tip.x;
    const backY = contact.rawTip.y - contact.tip.y;
    const distance = Math.hypot(backX, backY);
    if (distance > 1e-6) {
      const previous = held.get(contact.piercer.id);
      // Two targets at once: obey whichever stopped it hardest.
      if (!previous || distance > previous.distance) {
        held.set(contact.piercer.id, { distance, x: backX, y: backY });
      }
    }
  }
  occlusion = next;
  hold = held;
  // The V's opening, written here rather than in the frame loop so the
  // renderer's own re-measure keeps it current: a frame that re-measured the
  // contact but drew last frame's V would lag the drag by a frame.
  publishSpreadOpen(open);
  torqueChanged = publishForce(contacts, transforms);

  // Taken from the same contacts in the same pass, so the on-screen numbers
  // are the ones the frame was actually drawn from.
  readout = contacts.map(({ target, contact }) => {
    const geometry = target.mode === SpreadMode.OFF ? null : spreadGeometry(target);
    const swings = geometry && contact
      ? geometry.halves.map((half) => (swingAt(half, contact.openT) * 180) / Math.PI)
      : [];
    return {
      pierced: target.layers.map((layer) => layer.name).join(' + '),
      mode: target.mode,
      piercer: contact ? contact.piercer.name : null,
      gap: contact ? contact.gap : null,
      inPath: Boolean(contact && contact.inPath),
      enter: contact ? contact.piercer.pierceEnter : null,
      end: contact ? contact.end : null,
      depth: contact ? contact.depth : 0,
      // The V's opening, 0 shut to 1 fully open, on its own scale -- seeing
      // it sit at 0 while the depth climbs is how the trigger distance proves
      // it is doing something.
      open: contact ? contact.openT : 0,
      swings,
      dentStart: contact ? dentStartOf(contact.piercer, contact.piercer.pierceEnter, contact.end) : null,
      engaged: Boolean(contact && contact.engaged),
      inFront: Boolean(contact && next.get(contact.piercer.id)?.mode === 'lift'),
      sunk: Boolean(contact && next.get(contact.piercer.id)?.mode === 'sink'),
      overshoot: contact ? contact.overshoot : 0,
      held: contact ? Math.hypot(contact.rawTip.x - contact.tip.x, contact.rawTip.y - contact.tip.y) : 0,
      press: pressOf(contact),
      walled: contact && contact.axis
        ? Math.abs((contact.rawTip.x - contact.tip.x) * -contact.axis.y
                 + (contact.rawTip.y - contact.tip.y) * contact.axis.x)
        : 0,
    };
  });
  occlusionStale = false;
}

// What the solver currently reads, for the on-screen probe.
export function pierceReadout() {
  pierceOcclusion();
  return readout;
}

// Anything that can move a piercer or a layer invalidates this. The frame
// loop republishes on every step it takes; this flag covers the first frame
// after a drag, where the renderer runs before the loop has stepped.
export function markPierceStale() {
  occlusionStale = true;
}

// Who is drawn where in the stack this frame: piercer id -> { mode, layers },
// 'sink' to draw its tip beneath a plain pierced layer, 'lift' to draw it in
// front of a V's halves.
export function pierceOcclusion() {
  if (occlusionStale) {
    const transforms = bonesStore.isEmpty ? null : bonesStore.snapshotTransforms();
    publishOcclusion(partsStore.hasPierce ? activeContacts(transforms) : [], transforms);
  }
  return occlusion;
}

// How far each piercer's artwork is to be held back from where the drag
// actually put it, so its tip stops at the End Point.
export function pierceHold() {
  pierceOcclusion();
  return hold;
}

// One byte per source texel, splitting a layer's artwork into its painted
// region and everything else. Cached against the region version.
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
//
// Which pixels the app thinks are painted is invisible once the painter is
// closed, so this draws them back onto the artwork, in the painter's own
// colours, through the layer's own geometry -- so it follows every
// deformation exactly, the V included.
const OVERLAY_TIP = [255, 46, 147, 185];
const OVERLAY_AREA = [46, 230, 255, 185];
// The seam a single layer is split along, in the painter's violet.
const OVERLAY_SEAM = [160, 120, 255, 215];
// Walls, in a near-white the others cannot be mistaken for.
const OVERLAY_BARRIER = [236, 238, 248, 215];

let overlayOn = false;
const overlayCache = new Map();

export function pierceOverlayEnabled() {
  return overlayOn;
}

export function setPierceOverlay(on) {
  overlayOn = Boolean(on);
}

export function pierceOverlayTexture(part) {
  if (!part) return null;
  if (part.pierceRegion.size === 0 && part.pierceBarrierRegion.size === 0 && part.pierceSeam.size === 0) return null;
  const size = part.naturalWidth * part.naturalHeight;
  const version = `${part.pierceRegionVersion || 0}:${part.pierceSeamVersion || 0}:` +
    `${part.pierceBarrierRegionVersion || 0}`;
  const cached = overlayCache.get(part.id);
  if (cached && cached.version === version && cached.role === part.pierceRole && cached.pixels.length === size * 4) {
    return cached.pixels;
  }

  const pixels = new Uint8ClampedArray(size * 4);
  const paint = (index, [r, g, b, a]) => {
    if (index < 0 || index >= size) return;
    const o = index * 4;
    pixels[o] = r; pixels[o + 1] = g; pixels[o + 2] = b; pixels[o + 3] = a;
  };
  for (const index of part.pierceRegion) paint(index, part.isPiercer ? OVERLAY_TIP : OVERLAY_AREA);
  if (!part.isPiercer) {
    for (const index of part.pierceSeam) paint(index, OVERLAY_SEAM);
    for (const index of part.pierceBarrierRegion) paint(index, OVERLAY_BARRIER);
  }
  overlayCache.set(part.id, { version, role: part.pierceRole, pixels });
  return pixels;
}

// ---------------------------------------------------------------------------
// Is this layer's V set up to do anything?

// The configurations that are chosen and then cannot work, said in words --
// the numbers alone would say a V is configured while nothing ever opens.
export function pierceSpreadIssue(part) {
  if (!part || !part.isPierced) return null;
  if (part.pierceSpreadMode === SpreadMode.SEAM && part.pierceSeam.size < 2) {
    return 'the V is set to split this layer along a seam, but no seam is drawn yet — draw it with Paint regions… → Seam';
  }
  if (part.pierceSpreadMode === SpreadMode.PAIR && !partsStore.partnerOf(part)) {
    return 'the V is set to pair this layer with another, but that other half is gone';
  }
  const target = spreadTargetOf(part);
  if (target && target.layers.every((layer) => layer.pierceRegion.size === 0)) {
    return 'no Pierceable area is painted on either half, so no piercer can reach the V';
  }
  if (target && !spreadGeometry(target)) {
    return 'the halves could not be worked out from this artwork';
  }
  return null;
}

// ---------------------------------------------------------------------------
// The frame step

// Re-measures every contact and republishes. Returns true while a changed
// press still has to reach the bones, so physics.js's loop knows when it may
// sleep. The V itself settles nothing: its shape IS the depth, so there is no
// motion left over once the piercer stops.
export function stepPierce() {
  if (!partsStore.hasPierce) {
    publishOcclusion([]);
    return false;
  }
  const transforms = bonesStore.isEmpty ? null : bonesStore.snapshotTransforms();
  publishOcclusion(activeContacts(transforms), transforms);
  return torqueChanged;
}

// Test/debug window into the solver: what each contact reads, how open its V
// is, and how far each half has turned.
export function pierceDebug() {
  const transforms = bonesStore.isEmpty ? null : bonesStore.snapshotTransforms();
  return activeContacts(transforms).map(({ target, contact }) => {
    const geometry = target.mode === SpreadMode.OFF ? null : spreadGeometry(target);
    return {
      pierced: target.layers.map((layer) => layer.name).join(' + '),
      mode: target.mode,
      key: target.key,
      engaged: Boolean(contact && contact.engaged),
      inPath: Boolean(contact && contact.inPath),
      gap: contact ? contact.gap : null,
      depth: contact ? contact.depth : 0,
      t: contact ? contact.t : 0,
      openT: contact ? contact.openT : 0,
      swings: geometry && contact ? geometry.halves.map((half) => swingAt(half, contact.openT)) : [],
      fullSwings: geometry ? geometry.halves.map((half) => fullSwing(half)) : [],
      tip: contact ? contact.tip : null,
      rawTip: contact ? contact.rawTip : null,
      axis: contact ? contact.axis : null,
    };
  });
}
