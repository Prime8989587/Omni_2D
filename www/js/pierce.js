// Pierce: displacing flesh, not cutting a hole in it.
//
// WHAT THIS IS NOT
//
// It never removes a pixel, never hides one, never makes one transparent
// and never punches a hole. There is no second rendering pass and no
// stencil. Every pixel the interactive layer had before contact is still
// drawn afterwards, through the same rasterizer, in the same single pass.
// The ONLY thing that changes is where some mesh vertices are, which is
// exactly the same lever bone skinning already pulls -- so the effect is
// completely reversible by moving the piercer back out, with nothing to
// undo or restore.
//
// THE SPRING IS THE ONE ALREADY HERE
//
// A displaced vertex is not teleported to its displaced position. It gets
// a TARGET, and its actual offset springs toward that target under the
// same damped mass-spring integrated the same way bones.js integrates a
// physics bone:
//
//   acceleration = stiffness * (target - offset) - damping * velocity
//   velocity += acceleration * h        (semi-implicit / symplectic Euler:
//   offset   += velocity * h             velocity first, then position)
//
// with the same DEFAULT_STIFFNESS / DEFAULT_DAMPING the physics bones use
// and the same "has it settled yet" test, so flesh pushed aside gives way
// with weight rather than snapping, and springs back on its own when the
// piercer withdraws. That is also why this integrates in physics.js's
// frame loop rather than inside the renderer: a spring has to keep moving
// after the input that disturbed it stops, which is the whole point.
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
// The limit is enforced on the DISPLACEMENT, not on the finger. Refusing
// to let the user's own drag continue would mean this feature overriding
// direct input, which it has no business doing -- and Free Move's piercer
// drag is the user's, not ours. Pushing deeper than End simply stops
// making any difference.

import { partsStore } from './parts.js';
import { bonesStore, DEFAULT_STIFFNESS, DEFAULT_DAMPING } from './bones.js';
import { localToWorld, pinCarriageOffset, pinInfluence } from './mesh.js';
import { pierceStateFor, peekPierceState } from './pierceState.js';

export { pierceOffsets, resetPierceState } from './pierceState.js';

// Matching bones.js: distance-from-equilibrium and velocity bounds that
// decide when a spring has stopped meaningfully moving, so the frame loop
// may sleep. Expressed in scene pixels here rather than radians.
const SETTLE_OFFSET = 0.01;
const SETTLE_VELOCITY = 0.05;
const MAX_FRAME_DT = 0.1;
const MAX_SUBSTEP = 1 / 120;

// ---------------------------------------------------------------------------
// Geometry

// Where a layer's painted region currently is, in scene space: each marked
// texel's centre, mapped through the layer's own transform plus whatever
// carriage its bones have given it. Measured against the REST pose for the
// same reason pins are -- a tip that jittered with its own spring would
// make the contact point jitter with it, and the depth reading along with
// it.
function regionPoints(part, transforms) {
  if (!part || part.pierceRegion.size === 0) return [];
  const carriage = pinCarriageOffset(part, transforms);
  const halfW = part.naturalWidth / 2;
  const halfH = part.naturalHeight / 2;
  const points = [];
  for (const index of part.pierceRegion) {
    const u = index % part.naturalWidth;
    const v = Math.floor(index / part.naturalWidth);
    const world = localToWorld(part, { x: u + 0.5 - halfW, y: v + 0.5 - halfH });
    points.push({ x: world.x + carriage.x, y: world.y + carriage.y });
  }
  return points;
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

// The live contact between one piercer and one interactive layer. Null
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
function nearestSeparation(tip, flesh) {
  let nearest = Infinity;
  for (const a of tip) {
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

export function contactOf(piercer, interactive, transforms) {
  if (!piercer || !interactive) return null;
  const tip = regionPoints(piercer, transforms);
  const flesh = regionPoints(interactive, transforms);
  if (tip.length === 0 || flesh.length === 0) return null;

  const tipMiddle = centroid(tip);
  const tipSpread = spread(tip, tipMiddle);
  const axis = pierceAxis(piercer, tipMiddle, transforms);
  const axial = axis ? axialGap(tip, flesh, tipMiddle, tipSpread, axis) : null;
  // Off the path, or a piercer with no readable direction: report the real
  // separation, but nothing engages off a measurement that has no sign.
  const inPath = axial !== null;
  const gap = inPath ? axial : nearestSeparation(tip, flesh);

  const enter = piercer.pierceEnter;
  const end = Math.max(1, piercer.pierceEnd);
  const depth = inPath ? Math.min(end, Math.max(0, enter - gap)) : 0;

  // Past End the contact's GEOMETRY has to stop advancing as well, not
  // just the depth number. The push is aimed outward from the tip and
  // fades with distance from it, so a tip that kept travelling after the
  // depth was capped would walk straight through the flesh and out the
  // far side -- leaving every vertex too far away to be pushed, and the
  // dent melting away to nothing exactly when it should be deepest.
  // Holding the tip at the position where End was reached makes deeper
  // than End look identical to End, which is what a hard limit means.
  const overshoot = inPath ? Math.max(0, (enter - end) - gap) : 0;
  return {
    tip: overshoot > 0
      ? { x: tipMiddle.x - axis.x * overshoot, y: tipMiddle.y - axis.y * overshoot }
      : tipMiddle,
    tipSpread,
    gap,
    inPath,
    depth,
    // 0 at first contact, 1 at the End Point and never more, however far
    // past it the piercer is pushed.
    t: depth / end,
    end,
    engaged: depth > 0,
  };
}

// Every measurable contact in the scene: each interactive layer paired
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
  const interactives = partsStore.interactives;
  const contacts = [];
  for (const interactive of interactives) {
    if (!interactive.mesh) continue;
    let best = null;
    for (const piercer of piercers) {
      const contact = contactOf(piercer, interactive, transforms);
      if (!contact) continue;
      if (!best || contact.depth > best.depth ||
          (contact.depth === best.depth && contact.gap < best.gap)) {
        best = contact;
      }
    }
    contacts.push({ interactive, contact: best });
  }
  return contacts;
}

// ---------------------------------------------------------------------------
// The per-vertex target

// Which vertices may move at all: 1 on painted pierceable artwork, easing
// to 0 about a mesh cell outside it. The same shape of field pins use, and
// for the same reason -- a hard edge between "may move" and "may not"
// would crease the surface exactly at the boundary of the painted area.
function regionInfluence(mesh, part) {
  const version = part.pierceRegionVersion || 0;
  if (mesh._pierceInfluence && mesh._pierceInfluenceVersion === version) {
    return mesh._pierceInfluence;
  }

  const width = part.naturalWidth;
  const height = part.naturalHeight;
  const cellW = width / Math.max(1, mesh.cols);
  const cellH = height / Math.max(1, mesh.rows);
  const radius = Math.max(1, Math.max(cellW, cellH));

  // Painted texels collapse to the cells they sit in, exactly as pins do:
  // a mesh can only express what its vertices can, and this also caps the
  // work at cols x rows however many thousands of pixels were painted.
  const cells = new Set();
  for (const index of part.pierceRegion) {
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

// Where each vertex is being pushed to, as an offset from wherever the
// bones already put it.
//
// Direction is straight out from the tip: a vertex is shoved along the
// line from the tip through itself, which is what a solid object entering
// soft material does. Magnitude is the product of three independent
// fractions, each of which can shut the whole thing off on its own:
//
//   t         how deep the tip is between Enter and End
//   proximity how near this vertex is to the tip
//   region    whether this vertex is on painted pierceable artwork
//   (1 - pin) whether Px Pin has nailed this vertex down
//
// and scales with `end` -- the depth the piercer is allowed to reach is
// also how far the flesh it reached is pushed, so the two agree by
// construction instead of needing a second magnitude to tune.
function writeTargets(mesh, part, contact, transforms, targetX, targetY) {
  const influence = regionInfluence(mesh, part);
  const pins = part.pins.size > 0 ? pinInfluence(mesh, part) : null;
  const carriage = pinCarriageOffset(part, transforms);

  // How far the push reaches around the tip. A blunt tip disturbs a wider
  // area than a needle, and a deeper push reaches further than a shallow
  // one; below a couple of pixels there is nothing to resolve anyway.
  const reach = Math.max(2, contact.tipSpread + contact.end);

  for (let i = 0; i < mesh.vertices.length; i++) {
    targetX[i] = 0;
    targetY[i] = 0;

    const region = influence[i];
    if (region <= 0) continue;
    const pinned = pins ? pins[i] : 0;
    if (pinned >= 1) continue; // Px Pin holds this vertex; nothing may move it

    const rest = localToWorld(part, mesh.vertices[i].restLocal);
    const x = rest.x + carriage.x;
    const y = rest.y + carriage.y;

    let dx = x - contact.tip.x;
    let dy = y - contact.tip.y;
    let distance = Math.hypot(dx, dy);
    if (distance >= reach) continue;
    if (distance < 1e-6) {
      // A vertex sitting exactly on the tip has no outward direction of
      // its own; push it along the tip's own travel instead of dividing
      // by zero.
      dx = 0;
      dy = -1;
      distance = 1e-6;
    }

    const near = 1 - distance / reach;
    const proximity = near * near * (3 - 2 * near); // smoothstep, same as the fields above
    const push = contact.end * contact.t * proximity * region * (1 - pinned);
    targetX[i] = (dx / distance) * push;
    targetY[i] = (dy / distance) * push;
  }
}

// ---------------------------------------------------------------------------
// The frame step

// Advances every pierceable layer's displacement by dt seconds. Returns
// true while anything is still moving, so physics.js's loop knows when it
// may sleep -- including the whole spring-back after the piercer leaves,
// which is motion nobody is driving any more.
export function stepPierce(dt) {
  if (!partsStore.hasPierce) return false;

  const transforms = bonesStore.isEmpty ? null : bonesStore.snapshotTransforms();
  const contacts = activeContacts(transforms);
  if (contacts.length === 0) return false;

  const clamped = Math.min(Math.max(dt, 0), MAX_FRAME_DT);
  const steps = Math.max(1, Math.ceil(clamped / MAX_SUBSTEP));
  const h = clamped / steps;

  let active = false;
  for (const { interactive, contact } of contacts) {
    const mesh = interactive.mesh;
    const count = mesh.vertices.length;
    const entry = pierceStateFor(interactive.id, count);

    // With no contact -- or one still short of the Enter Point -- every
    // target is zero, which is precisely "spring back to where the bones
    // want you". The retraction needs no separate code path; it is the
    // same spring with the target released.
    const targetX = new Float64Array(count);
    const targetY = new Float64Array(count);
    if (contact && contact.engaged) {
      writeTargets(mesh, interactive, contact, transforms, targetX, targetY);
    }

    for (let s = 0; s < steps; s++) {
      for (let i = 0; i < count; i++) {
        const ax = DEFAULT_STIFFNESS * (targetX[i] - entry.offsetX[i]) - DEFAULT_DAMPING * entry.velocityX[i];
        const ay = DEFAULT_STIFFNESS * (targetY[i] - entry.offsetY[i]) - DEFAULT_DAMPING * entry.velocityY[i];
        entry.velocityX[i] += ax * h;
        entry.velocityY[i] += ay * h;
        entry.offsetX[i] += entry.velocityX[i] * h;
        entry.offsetY[i] += entry.velocityY[i] * h;
      }
    }

    // Still moving? Same test bones.js uses: distance from equilibrium
    // (acceleration and damping over stiffness) or raw speed.
    for (let i = 0; i < count; i++) {
      const restX = Math.abs(targetX[i] - entry.offsetX[i]);
      const restY = Math.abs(targetY[i] - entry.offsetY[i]);
      const speed = Math.hypot(entry.velocityX[i], entry.velocityY[i]);
      if (restX > SETTLE_OFFSET || restY > SETTLE_OFFSET || speed > SETTLE_VELOCITY) {
        active = true;
        break;
      }
    }
  }
  return active;
}

// Test/debug window into the solver: what the contact currently reads and
// how far the flesh has actually been pushed. Proving displacement starts
// at Enter, caps at End and returns to zero is the whole verification.
export function pierceDebug() {
  const transforms = bonesStore.isEmpty ? null : bonesStore.snapshotTransforms();
  return activeContacts(transforms).map(({ interactive, contact }) => {
    const entry = peekPierceState(interactive.id);
    let worst = 0;
    if (entry) {
      for (let i = 0; i < entry.count; i++) {
        worst = Math.max(worst, Math.hypot(entry.offsetX[i], entry.offsetY[i]));
      }
    }
    return {
      interactive: interactive.name,
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
