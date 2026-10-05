// Interactive: layers that touch, push, and spring back.
//
// WHAT IT IS
//
// Any layer can be marked Interactive (Scene Parts → ⋮ → Interactive). Its
// OUTLINE -- where its artwork stops, the edge the contour ring hugs -- can
// then touch the outline of any other Interactive layer. When one moves
// into another that is set to Gives way, the touched layer is pushed in the
// direction the toucher is moving, together with everything PxLinked to it
// that is free to follow, and when the touch ends the whole structure
// springs back to where it was. A hand dragged into a waistband moves the
// waistband the way the hand is going; let go, and it settles home.
//
// WHAT IT IS MADE OF
//
// Nothing here is a second deformation system. It is four things the app
// already had, generalized:
//
//   * the CONTACT is Pierce's, asked of outlines instead of painted
//     regions (contact.js -- the same axial measure, now per slice);
//   * the PRESS is Pierce's pressOf, the very function: 0 at first touch,
//     1 at CONTACT_END px in, up to 2 for leaning on it past there;
//   * the SPRING is a physics bone's: the same stiffness and damping
//     (defaults 180 and 8, the same ranges), the same semi-implicit Euler
//     at the same substep, the same settle test -- here moving a point in
//     the plane instead of an angle;
//   * the STRUCTURE is the PxLink network, found by walking its links, and
//     the push is spread over it as one smooth field that is zero at every
//     link holding it to something that does not give way -- so its links
//     stay joined exactly as PxLink keeps them.
//
// Pierce itself is the specialised case: a painted tip pressing along the
// axis of its own artwork into a seam, opening a wedge (pierce.js). It
// shares the contact measure with this file and is configured from the
// same Interactive panel.
//
// WHICH WAY: THE TOUCHER'S LIVE MOVEMENT
//
// Not a preset axis, and not one read off the artwork: the push points the
// way the toucher is actually moving RELATIVE to what it touches, measured
// frame to frame from where both outlines are drawn (with any push of their
// own taken back out, so a layer bouncing on its own spring is not "moving
// into" anything). A hand sweeping down and to the right pushes down and to
// the right; the same hand coming up from underneath pushes up. When the
// toucher stops, the last direction it had is kept for as long as it stays
// in contact, so a hand pressed in and held keeps pressing.
//
// Only faces that the movement runs INTO are pushed (contact.js,
// frontPress): sliding a hand along a waistband pushes nothing, and
// pulling it back out lets go, because what it was pressing is then behind
// it rather than ahead.
//
// HOW HARD
//
// The press is how far the toucher's leading edge has got past the face it
// is pushing. That press asks the spring for CONTACT_GAIN times as much
// travel as the spring gives back for the same distance, so the touched
// structure gets out of the way of the toucher (it travels 0.8 of the way
// in, the rest staying pressed) rather than letting it pass through. The
// contact also damps, as real contact does, so a push lands without
// ringing; once the touch ends only the spring is left, and it rings and
// settles exactly as a physics bone of the same stiffness and damping does.
//
// WHAT MOVES: THE STRUCTURE
//
// The touched layer and everything joined to it by PxLinks (point or brush,
// any number, chains of them) that is free to follow -- found by walking
// the links outward from the touched layer. A layer is free unless something
// holds it:
//
//   * bound to the skeleton with no spring bone among its bones (the body on
//     its rigid bones) -- the skeleton holds it;
//   * Interactive and Solid -- it holds its ground by definition.
//
// A held layer is not pushed, and the walk does not pass through it. Its
// links to the structure are where the structure HANGS from: a waistband
// painted onto the body, a strap's end at the shoulder. Layers with no
// bones, and layers on spring bones (a breast that is meant to respond),
// follow.
//
// THE PUSH FIELD
//
// The structure moves by one displacement field across all of its layers,
// in scene space:
//
//   push(x) = d * smoothstep( distance from x to the nearest hold / reach )
//
// d is the spring's displacement -- the push under the toucher -- and
// `reach` the distance from the toucher's footprint (the stretch of outline
// it bears on) to the nearest hold. Held nowhere, it is d everywhere: the
// whole structure moves as ONE piece, every link in it trivially still
// joined. Held somewhere, it is zero at the holds and rises smoothly to d
// under the whole footprint -- material under a flat hand lies flat against
// it -- and everything further from the holds than the footprint (the cup
// below a strap pulled up, the breast below that) is carried the full d.
// Because it is one field over the scene rather than one per layer, two
// linked layers are pushed by the same amount at the point they share, and
// their link holds without any correction. It is never let fold the
// material it moves (BENT, NEVER FOLDED, below).
//
// It is applied after PxLink (mesh.js, deformVertices), so PxLink's own
// solve -- attachments, welds, brush fields -- runs exactly as it always
// did underneath, and the push is laid over its result.
//
// PAINTED HOLDS PEEL; POINTS ARE RIVETS
//
// A brush link is glue along a region. Pulled near it, the glue lets go
// around the pull -- every painted pair within WELD_SPREAD x (push + press)
// of the footprint -- so a waistband painted on along its whole length lifts
// off in a smooth arch around the hand and stays down everywhere else, and
// sticks again from the outside in as it settles. Either side of the pull,
// the last quarter of the painted region never lets go, so it can lift but
// not come off. A point link is a rivet: it never lets go, and a band can
// hardly be lifted right beside one.
// That is why thin, long Interactive pieces are attached with Brush
// (contact.js, isThinElongated; the PxLink window enforces it).

import { partsStore } from './parts.js';
import { bonesStore } from './bones.js';
import { deformVerticesUnpushed, generateMesh, defaultDensity } from './mesh.js';
import { refinedMesh } from './opening.js';
import { localToWorld } from './layerSpace.js';
import { pxlinkStore, linkPositions, currentTransforms } from './pxlink.js';
import { locateTexel, landTexel } from './pxlinkState.js';
import { registerPushSolver, pushAt } from './interactState.js';
import { centroid, pressOf, frontPress, outlineSamples, isThinElongated } from './contact.js';

// How far in, in scene px, a toucher has to be to press fully (press 1):
// Pierce's End Point, for an outline. Past it the press keeps building to 2
// (pressOf), and no further.
export const CONTACT_END = 12;
// How much harder a press pushes than the spring pulls back, per pixel.
export const CONTACT_GAIN = 4;
// PxLink's bend-never-fold ratio (pxlink.js): a displacement of d needs at
// least 2.5 d of material to bend over.
const WELD_SPREAD = 2.5;
const MIN_REACH = 0.5;
// What a painted hold always keeps, of its length either side of the pull.
const PEEL_KEEP = 0.25;
// How far, in px, a pull has to ease before glue that let go sticks again.
const PEEL_HOLD = 2;
// Relative movement, in px (decaying), that sets a direction.
const MIN_MOVE = 0.5;
const MOTION_MEMORY = 0.5;
// The spring's settle test, as a bone's (bones.js) but in pixels.
const SETTLE_PX = 0.02;
const SETTLE_SPEED = 0.2;
const MAX_FRAME_DT = 1 / 30;
const MAX_SUBSTEP = 1 / 120;

const NO_BONES = Object.freeze({});

// ---------------------------------------------------------------------------
// State

const lastCentre = new Map(); // partId -> its unpushed outline's middle last frame
const pairs = new Map();      // `${toucher}>${touched}` -> { m, axis, engaged }
const networks = new Map();   // structure key -> its spring
let fields = new Map();       // partId -> the push field it is drawn with
let lastContacts = [];

export function resetInteractive() {
  lastCentre.clear();
  pairs.clear();
  networks.clear();
  fields = new Map();
  lastContacts = [];
}

// ---------------------------------------------------------------------------
// Outlines, where they are drawn

const locatedCache = new WeakMap(); // mesh -> where each outline sample sits in it

function located(part, samples) {
  const mesh = part.mesh;
  const key = `${mesh.vertices.length}|${mesh.triangles.length}`;
  let cache = locatedCache.get(mesh);
  if (!cache || cache.samples !== samples || cache.key !== key) {
    const at = [];
    const out = [];
    for (let i = 0; i < samples.count; i++) {
      const u = samples.u[i];
      const v = samples.v[i];
      at.push(locateTexel(mesh.vertices, mesh.triangles, u, v));
      out.push(locateTexel(mesh.vertices, mesh.triangles, u + samples.nu[i] * 0.5, v + samples.nv[i] * 0.5));
    }
    cache = { samples, key, at, out };
    locatedCache.set(mesh, cache);
  }
  return cache;
}

// A layer's outline as drawn: every sample's scene point and outward
// normal, pushed (what touches) and unpushed (what says how it moved).
function outlineOf(part, transforms) {
  const samples = outlineSamples(part);
  if (samples.count === 0) return { drawn: [], rest: [] };
  const drawn = new Array(samples.count);
  const rest = new Array(samples.count);
  if (part.mesh) {
    const own = deformVerticesUnpushed(part.mesh, part, transforms);
    const field = fields.get(part.id) || null;
    const pushed = field ? own.map((p) => { const d = pushAt(field, p.x, p.y); return { x: p.x + d.x, y: p.y + d.y }; }) : own;
    const where = located(part, samples);
    for (let i = 0; i < samples.count; i++) {
      if (!where.at[i] || !where.out[i]) { drawn[i] = null; rest[i] = null; continue; }
      const p = landTexel(pushed, where.at[i]);
      const q = landTexel(pushed, where.out[i]);
      const len = Math.hypot(q.x - p.x, q.y - p.y) || 1;
      rest[i] = field ? landTexel(own, where.at[i]) : p;
      drawn[i] = { x: p.x, y: p.y, nx: (q.x - p.x) / len, ny: (q.y - p.y) / len, rx: rest[i].x, ry: rest[i].y };
    }
  } else {
    const halfW = part.naturalWidth / 2;
    const halfH = part.naturalHeight / 2;
    const cos = Math.cos(part.rotation || 0);
    const sin = Math.sin(part.rotation || 0);
    for (let i = 0; i < samples.count; i++) {
      const p = localToWorld(part, { x: samples.u[i] - halfW, y: samples.v[i] - halfH });
      const nu = samples.nu[i];
      const nv = samples.nv[i];
      drawn[i] = { x: p.x, y: p.y, nx: cos * nu - sin * nv, ny: sin * nu + cos * nv };
      rest[i] = drawn[i];
    }
  }
  return { drawn: drawn.filter(Boolean), rest: rest.filter(Boolean) };
}

function boundsOf(points) {
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  for (const p of points) {
    if (p.x < x0) x0 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.x > x1) x1 = p.x;
    if (p.y > y1) y1 = p.y;
  }
  return { x0, y0, x1, y1 };
}

function overlaps(a, b, margin) {
  return a.x0 - margin <= b.x1 && b.x0 - margin <= a.x1 && a.y0 - margin <= b.y1 && b.y0 - margin <= a.y1;
}

// ---------------------------------------------------------------------------
// The structure

// The bones that move a layer: its "Controls layer" bones and every bone
// its weights name.
function drivingBones(part) {
  const ids = new Set(bonesStore.bonesAttachedTo(part.id).map((bone) => bone.id));
  const mesh = part.mesh;
  if (mesh && mesh.isBound) {
    for (const vertex of mesh.vertices) {
      for (const [id, weight] of Object.entries(vertex.weights || {})) if (weight > 0) ids.add(id);
    }
  }
  return [...ids].map((id) => bonesStore.byId(id)).filter(Boolean);
}

// Whether a layer HOLDS its ground rather than following a push (see WHAT
// MOVES, above).
export function holdsGround(part) {
  if (part.interactive) return !part.givesWay;
  if (!part.mesh || !part.mesh.isBound) return false;
  const bones = drivingBones(part);
  if (bones.length === 0) return false;
  return !bones.some((bone) => bone.physicsEnabled);
}

function neighbours() {
  const map = new Map();
  for (const link of pxlinkStore.links) {
    for (const a of link.members) {
      if (!map.has(a.partId)) map.set(a.partId, new Set());
      for (const b of link.members) if (b.partId !== a.partId) map.get(a.partId).add(b.partId);
    }
  }
  return map;
}

// The structure a layer belongs to: itself, and every layer reachable from
// it through PxLinks without passing through one that holds its ground.
// `holders`: the layers that hold it -- linked to it, holding their ground.
export function structureOf(part, links = neighbours()) {
  const byId = new Map(partsStore.parts.map((p) => [p.id, p]));
  const members = new Set([part.id]);
  const holders = new Set();
  const queue = [part.id];
  while (queue.length) {
    const id = queue.shift();
    for (const other of links.get(id) || []) {
      if (members.has(other) || holders.has(other)) continue;
      const layer = byId.get(other);
      if (!layer) continue;
      if (holdsGround(layer)) { holders.add(other); continue; }
      members.add(other);
      queue.push(other);
    }
  }
  return { members, holders };
}

// Where the structure is held: every link point (every painted pair, for a
// brush link) a member shares with a layer outside it, where the member's
// side of it is drawn -- before any push.
function holdsOf(members, positions) {
  const out = [];
  for (const entry of positions) {
    const inside = entry.members.filter((m) => members.has(m.partId));
    if (inside.length === 0 || inside.length === entry.members.length) continue;
    if (entry.kind === 'brush' && entry.pairs) {
      entry.pairs.forEach((pair, i) => {
        for (const m of pair) {
          if (members.has(m.partId)) out.push({ x: m.x, y: m.y, kind: 'brush', link: entry.id, id: `${entry.id}#${i}:${m.partId}` });
        }
      });
    } else {
      for (const m of inside) out.push({ x: m.x, y: m.y, kind: 'point', link: entry.id, id: `${entry.id}:${m.partId}` });
    }
  }
  return out;
}

// The field for a structure pushed d over `footprint` (the faces the
// toucher bears on, unpushed), held at `holds` (see PAINTED HOLDS PEEL;
// POINTS ARE RIVETS). Its reach is the distance from the footprint to the
// nearest hold still holding, so the whole footprint moves the whole of d --
// the material under a flat hand lies flat against it, rather than peaking
// under its middle with its corners still pressed -- and the rise from the
// holds to it is as gentle as the room allows.
//
// `pulling` is how deep the press on it is right now: glue lets go by how
// hard it is pulled, not only by how far it has already moved -- sized
// from the move alone, a band painted on along its whole length could
// never start to lift, since it cannot move until its glue lets go.
//
// Glue that has let go stays let go until the pull has eased PEEL_HOLD px
// below where it gave (`peeled`, last frame's released pairs): a pair right
// at the edge would otherwise come and go from frame to frame, and the field
// with it.
export function shapeField(d, footprint, holds, pulling = 0, peeled = new Set()) {
  const size = Math.hypot(d.x, d.y);
  const peel = WELD_SPREAD * (size + Math.max(0, pulling));
  const kept = [];
  const painted = new Map();
  for (const h of holds) {
    if (h.kind !== 'brush') { kept.push(h); continue; }
    if (!painted.has(h.link)) painted.set(h.link, []);
    painted.get(h.link).push(h);
  }
  const released = new Set();
  for (const group of painted.values()) {
    const dist = group.map((h) => distanceTo(footprint, h));
    const limit = peelLimit(group, footprint);
    const radius = Math.min(peel, limit);
    group.forEach((h, i) => {
      const loose = dist[i] < radius || (peeled.has(h.id) && dist[i] < Math.min(radius + PEEL_HOLD, limit));
      if (loose) released.add(h.id); else kept.push(h);
    });
  }
  let near = Infinity;
  for (const h of kept) near = Math.min(near, distanceTo(footprint, h));
  const reach = kept.length ? Math.max(near, MIN_REACH) : 1;
  return {
    d: { x: d.x, y: d.y }, footprint, held: kept, reach, peeled: holds.length - kept.length, released,
  };
}

function distanceTo(points, p) {
  let best = Infinity;
  for (const q of points) best = Math.min(best, Math.hypot(q.x - p.x, q.y - p.y));
  return best;
}

// How far a painted region may peel round a press: it lies along a line (a
// waistband, a strap), and the press covers some stretch of it; whichever
// way along it from there is shorter, the last PEEL_KEEP of that way stays
// glued. So the band lifts round the hand and never comes off at either end
// -- even when the hand is nearer one end than the other.
function peelLimit(group, footprint) {
  let mx = 0;
  let my = 0;
  for (const h of group) { mx += h.x; my += h.y; }
  mx /= group.length;
  my /= group.length;
  let xx = 0;
  let yy = 0;
  let xy = 0;
  for (const h of group) {
    const dx = h.x - mx;
    const dy = h.y - my;
    xx += dx * dx; yy += dy * dy; xy += dx * dy;
  }
  const angle = 0.5 * Math.atan2(2 * xy, xx - yy);
  const ax = Math.cos(angle);
  const ay = Math.sin(angle);
  const along = (p) => (p.x - mx) * ax + (p.y - my) * ay;
  let lo = Infinity;
  let hi = -Infinity;
  for (const h of group) { const t = along(h); if (t < lo) lo = t; if (t > hi) hi = t; }
  let flo = Infinity;
  let fhi = -Infinity;
  for (const p of footprint) { const t = along(p); if (t < flo) flo = t; if (t > fhi) fhi = t; }
  return Math.max(0, (1 - PEEL_KEEP) * Math.min(flo - lo, hi - fhi));
}

// How much of d the field moves a point by (1 held nowhere).
function shareAt(field, at) {
  if (!field || !field.held.length) return 1;
  const t = Math.max(0, Math.min(1, distanceTo(field.held, at) / field.reach));
  return t * t * (3 - 2 * t);
}

// BENT, NEVER FOLDED
//
// A displacement field d * s(x) folds the material it moves exactly where
// 1 + d . grad s(x) <= 0 -- where it pushes some piece of the structure back
// over the piece behind it, toward a hold, harder than the room between
// them allows. Pushed away from a hold, or across the line to it, nothing
// folds: it only stretches and shears. So before each frame's push the
// field is checked at every vertex of every layer it moves, in the
// direction it is pushing, and the push is never let past the point where
// the worst of them would come within PxLink's own margin of folding
// (WELD_SPREAD: d . grad s may reach -1/WELD_SPREAD * 1.5, the same ratio
// PxLink sizes its welds by, for the same reason). Like the End Point on a
// pierce: past it, the structure gives no further. The push is shortened,
// never turned -- it still points the way the toucher is going. Null when
// nothing holds the structure (a field of one constant d cannot fold).
const FOLD_ROOM = 1.5 / WELD_SPREAD;

function foldGuard(field, members, transforms, byId) {
  if (!field || !field.held.length) return null;
  const { held, reach } = field;
  // Every vertex's way out of its nearest hold, and how steeply the field
  // rises there.
  const slopes = [];
  for (const id of members) {
    const part = byId.get(id);
    if (!part || !part.mesh) continue;
    // Checked where the layer is DRAWN: through the finer copy of its mesh
    // the renderer bends it with (canvas.js), whose points fall between its
    // own vertices -- where a field rising over a few pixels is steepest.
    const coarse = deformVerticesUnpushed(part.mesh, part, transforms);
    const points = refinedMesh(part.mesh, part).blends.map(({ ids, ws }) => {
      let x = 0;
      let y = 0;
      for (let c = 0; c < ids.length; c++) { x += coarse[ids[c]].x * ws[c]; y += coarse[ids[c]].y * ws[c]; }
      return { x, y };
    });
    for (const p of points) {
      let near = Infinity;
      let from = null;
      for (const h of held) {
        const dist = Math.hypot(p.x - h.x, p.y - h.y);
        if (dist < near) { near = dist; from = h; }
      }
      if (!from || near >= reach || near < 1e-9) continue;
      const t = near / reach;
      const steep = (6 * t * (1 - t)) / reach;
      slopes.push({ x: ((p.x - from.x) / near) * steep, y: ((p.y - from.y) / near) * steep });
    }
  }
  return { slopes };
}

// How much of a push d may be kept under a guard (1: all of it).
function guardKeep(guard, d) {
  if (!guard) return 1;
  const size = Math.hypot(d.x, d.y);
  if (size < 1e-9) return 1;
  let worst = 0;
  for (const g of guard.slopes) worst = Math.max(worst, -(d.x * g.x + d.y * g.y) / size);
  if (worst <= 0) return 1;
  return Math.min(1, FOLD_ROOM / (worst * size));
}

// A layer the push displaces needs vertices to displace -- the same unbound
// mesh Pierce and PxLink give a layer that has none (identity skinning, so
// it is drawn exactly where its quad was).
function meshFor(part) {
  if (!part.mesh) part.mesh = generateMesh(part, defaultDensity(part));
  return part.mesh;
}

// ---------------------------------------------------------------------------
// The step

function pressFor(depth) {
  return pressOf({
    engaged: depth > 0,
    t: Math.min(CONTACT_END, depth) / CONTACT_END,
    overshoot: Math.max(0, depth - CONTACT_END),
    end: CONTACT_END,
  });
}

// One frame: measure every touch, push every structure being touched, let
// every pushed structure spring. Returns whether anything is still moving.
export function stepInteractive(dt) {
  const touchers = partsStore.interactiveLayers.filter((part) => part.visible);
  if (touchers.length === 0 && networks.size === 0) {
    if (fields.size) fields = new Map();
    lastContacts = [];
    return false;
  }
  const transforms = bonesStore.isEmpty ? NO_BONES : currentTransforms();
  const links = neighbours();
  const byId = new Map(partsStore.parts.map((p) => [p.id, p]));

  // Where every Interactive layer is, and how it moved since last frame.
  const outlines = new Map();
  const moved = new Map();
  for (const part of touchers) {
    const outline = outlineOf(part, transforms);
    if (outline.drawn.length === 0) continue;
    const middle = centroid(outline.rest);
    const before = lastCentre.get(part.id);
    moved.set(part.id, before ? { x: middle.x - before.x, y: middle.y - before.y } : { x: 0, y: 0 });
    lastCentre.set(part.id, middle);
    outlines.set(part.id, { ...outline, middle: centroid(outline.drawn), bounds: boundsOf(outline.drawn) });
  }

  // Every touch: an Interactive layer moving into one that gives way.
  const contacts = [];
  const structures = new Map();
  for (const touched of touchers) {
    if (!touched.givesWay || !outlines.has(touched.id)) continue;
    const structure = structureOf(touched, links);
    const key = [...structure.members].sort().join('|');
    for (const toucher of touchers) {
      if (toucher === touched || !outlines.has(toucher.id)) continue;
      // Part of the same structure, or what it hangs from: one object, not
      // two things touching.
      if (structure.members.has(toucher.id) || structure.holders.has(toucher.id)) continue;
      const pairKey = `${toucher.id}>${touched.id}`;
      let pair = pairs.get(pairKey);
      if (!pair) { pair = { m: { x: 0, y: 0 }, axis: null, engaged: null }; pairs.set(pairKey, pair); }
      const a = moved.get(toucher.id);
      const b = moved.get(touched.id);
      pair.m = {
        x: pair.m.x * MOTION_MEMORY + (a.x - b.x),
        y: pair.m.y * MOTION_MEMORY + (a.y - b.y),
      };
      const size = Math.hypot(pair.m.x, pair.m.y);
      if (size >= MIN_MOVE) pair.axis = { x: pair.m.x / size, y: pair.m.y / size };
      if (!pair.axis) continue;
      const A = outlines.get(toucher.id);
      const B = outlines.get(touched.id);
      const slice = Math.max(1, toucher.scale || 1, touched.scale || 1);
      // A press under way stays engaged until the toucher turns back on it
      // (more than a right angle from the way it came in).
      if (pair.engaged && pair.axis.x * pair.engaged.x + pair.axis.y * pair.engaged.y <= 0) pair.engaged = null;
      if (!overlaps(A.bounds, B.bounds, slice)) { pair.engaged = null; continue; }
      const hit = frontPress(A.drawn, B.drawn, pair.axis, A.middle, slice, Boolean(pair.engaged));
      if (!hit) { pair.engaged = null; continue; }
      if (!pair.engaged) pair.engaged = { x: pair.axis.x, y: pair.axis.y };
      const field = fields.get(touched.id) || null;
      contacts.push({
        key,
        toucher,
        touched,
        depth: hit.depth,
        axis: pair.axis,
        at: hit.at,
        // Where the press lands, before this structure's push: the holds
        // the field is shaped round are measured there too.
        rest: hit.rest,
        footprint: hit.footprint,
        share: shareAt(field, hit.rest),
      });
      structures.set(key, structure);
    }
  }
  lastContacts = contacts;

  // A spring for every structure being touched, made the first time.
  for (const contact of contacts) {
    let state = networks.get(contact.key);
    if (!state) {
      state = {
        key: contact.key,
        members: structures.get(contact.key).members,
        d: { x: 0, y: 0 },
        v: { x: 0, y: 0 },
        at: contact.rest,
        footprint: contact.footprint,
        stiffness: contact.touched.interactiveStiffness,
        damping: contact.touched.interactiveDamping,
        contacts: [],
        field: null,
      };
      networks.set(contact.key, state);
    }
    state.contacts.push(contact);
  }

  // Integrate: a physics bone's spring, in the plane.
  const frameDt = Math.min(Math.max(dt, 0), MAX_FRAME_DT);
  const steps = Math.max(1, Math.ceil(frameDt / MAX_SUBSTEP));
  const h = frameDt / steps;
  let positions = null;
  for (const [key, state] of networks) {
    const k = state.stiffness;
    const c = state.damping;
    const start = { x: state.d.x, y: state.d.y };
    if (state.contacts.length) {
      // Where it is being pressed: every toucher's footprint (kept after the
      // touch ends, for the spring back).
      state.footprint = state.contacts.flatMap((ct) => ct.footprint);
      state.at = centroid(state.footprint);
    }
    const guard = foldGuard(state.field, state.members, transforms, byId);
    let force = { x: 0, y: 0 };
    for (let i = 0; i < steps; i++) {
      let fx = -k * state.d.x - c * state.v.x;
      let fy = -k * state.d.y - c * state.v.y;
      for (const ct of state.contacts) {
        // The press as it stands this substep: what was measured, less how
        // far the structure has since moved out of its way -- so the
        // contact and the spring are solved together rather than a frame
        // apart.
        const gone = ((state.d.x - start.x) * ct.axis.x + (state.d.y - start.y) * ct.axis.y) * ct.share;
        const depth = ct.depth - gone;
        if (depth <= 0) continue;
        const push = CONTACT_GAIN * k * CONTACT_END * pressFor(depth);
        const resist = CONTACT_GAIN * c * (state.v.x * ct.axis.x + state.v.y * ct.axis.y) * ct.share;
        fx += (push - resist) * ct.axis.x;
        fy += (push - resist) * ct.axis.y;
      }
      state.v.x += fx * h;
      state.v.y += fy * h;
      state.d.x += state.v.x * h;
      state.d.y += state.v.y * h;
      const keep = guardKeep(guard, state.d);
      if (keep < 1) {
        state.d.x *= keep;
        state.d.y *= keep;
        state.v.x *= keep;
        state.v.y *= keep;
      }
      force = { x: fx, y: fy };
    }
    const speed = Math.hypot(state.v.x, state.v.y);
    const fromRest = (Math.hypot(force.x, force.y) + c * speed) / Math.max(k, 1e-6);
    state.touching = state.contacts.length > 0;
    state.pulling = state.contacts.reduce((most, ct) => Math.max(most, ct.depth), 0);
    state.contacts = [];
    if (!state.touching && fromRest <= SETTLE_PX && speed <= SETTLE_SPEED && Math.hypot(state.d.x, state.d.y) <= SETTLE_PX) {
      networks.delete(key);
      continue;
    }
    // Where it hangs from, this frame, and the field over it.
    if (!positions) positions = pxlinkStore.links.length ? linkPositions(transforms) : [];
    state.field = shapeField(state.d, state.footprint, holdsOf(state.members, positions), state.pulling,
      state.field ? state.field.released : undefined);
  }

  // Publish: every member of every moving structure is drawn pushed.
  const next = new Map();
  for (const state of networks.values()) {
    if (!state.field) continue;
    for (const id of state.members) {
      const part = byId.get(id);
      if (!part) continue;
      meshFor(part);
      next.set(id, state.field);
    }
  }
  fields = next;
  // Forget pairs that have neither moved nor touched in a while.
  for (const [key, pair] of pairs) {
    if (Math.hypot(pair.m.x, pair.m.y) < 1e-3 && !pair.engaged) {
      pairs.delete(key);
    }
  }
  return networks.size > 0;
}

// ---------------------------------------------------------------------------
// Questions the rest of the app asks

export function interactiveFieldOf(part) {
  return part ? fields.get(part.id) || null : null;
}

// Whether a layer is being bent by its push (held somewhere) rather than
// moved whole -- the renderer draws a bent one through a finer mesh.
export function pushBends(part) {
  const field = interactiveFieldOf(part);
  return Boolean(field && field.held.length && Math.hypot(field.d.x, field.d.y) >= 0.5);
}

// For the Interactive panel: what moves with this layer when it is pushed,
// what holds it, and how it is held.
export function describeStructure(part) {
  if (!part) return null;
  const { members, holders } = structureOf(part);
  const name = (id) => (partsStore.parts.find((p) => p.id === id) || {}).name;
  let pointHolds = 0;
  let brushHolds = 0;
  for (const link of pxlinkStore.links) {
    const mine = link.members.some((m) => m.partId === part.id);
    const toHolder = link.members.some((m) => holders.has(m.partId));
    if (!mine || !toHolder) continue;
    if (link.kind === 'brush') brushHolds++; else pointHolds++;
  }
  return {
    moves: [...members].filter((id) => id !== part.id).map(name).filter(Boolean),
    heldBy: [...holders].map(name).filter(Boolean),
    pointHolds,
    brushHolds,
    thin: isThinElongated(part),
  };
}

// Test/debug window: every touch this frame, and every structure moving.
export function interactiveDebug() {
  const name = (id) => (partsStore.parts.find((p) => p.id === id) || {}).name;
  return {
    contacts: lastContacts.map((ct) => ({
      toucher: ct.toucher.name,
      touched: ct.touched.name,
      depth: ct.depth,
      press: pressFor(ct.depth),
      axis: { ...ct.axis },
      at: { ...ct.at },
    })),
    structures: [...networks.values()].map((state) => ({
      members: [...state.members].map(name),
      d: { ...state.d },
      v: { ...state.v },
      at: { ...state.at },
      touching: Boolean(state.touching),
      holds: state.field ? state.field.held.length : 0,
      peeled: state.field ? state.field.peeled : 0,
      reach: state.field ? state.field.reach : null,
    })),
  };
}

export function initInteractive() {
  registerPushSolver((part) => fields.get(part.id) || null);
}
