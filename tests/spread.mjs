// The V: a piercer going between two halves, which part to let it in.
//
// Every check runs the real solver, the real deformation and the real draw
// geometry (deformVerticesSnapped, per half-copy for a seam-split layer) --
// nothing here re-implements what it is testing. The piercer is driven along
// its path one pixel at a time, in and back out, and at every step:
//
//   * the V's opening is EXACTLY the one depth-derived number the tip's
//     position also comes from (0 at the Dent Trigger Distance, 1 at End);
//   * each half has turned by exactly +/- opening x its full swing --
//     symmetric, and away from the seam;
//   * each hinge has not moved at all, and each half has turned RIGIDLY about
//     it (a pair) or bent smoothly into it (a seam), with no triangle folded;
//   * the piercer's own tip is drawn, in front of the halves, at a position
//     that moves continuously inward with the drag;
//   * backing out retraces the same numbers to shut.
//
// Then the three systems that have to keep working against the new
// geometry: Barrier (sideways only, widening with the V), force transfer
// (the halves' own bones pushed apart) and Physics Direction (whose movement
// drives the coupled motion) -- and save/load.

import { Part, partsStore, PierceRole, SpreadMode, PiercePhysics } from '../www/js/parts.js';
import { bonesStore } from '../www/js/bones.js';
import { deformVertices, deformVerticesSnapped, bindPart } from '../www/js/mesh.js';
import {
  stepPierce, pierceDebug, pierceHold, pierceOcclusion, markPierceStale, resetPierceContainment,
  pierceSpreadIssue,
} from '../www/js/pierce.js';
import {
  spreadTargetOf, spreadGeometry, fullSwing, spreadMasks, pierceTargets,
} from '../www/js/spread.js';
import { locateTexel, landTexel } from '../www/js/plinkState.js';
import { serializeProject, applyProject } from '../www/js/project.js';

let passed = 0;
let total = 0;
const say = (ok, name, detail = '') => {
  total++;
  if (ok) passed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}`);
  if (detail) console.log(`          ${detail}`);
};
const deg = (r) => (r * 180) / Math.PI;

function solid(w, h, rgb) {
  const p = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) p.set([...rgb, 255], i * 4);
  return p;
}
function layer(name, w, h, x, y, rgb = [200, 150, 120]) {
  const part = new Part({ name, pixels: solid(w, h, rgb), width: w, height: h, x, y });
  partsStore.add(part);
  return part;
}
const index = (part, u, v) => v * part.naturalWidth + u;
function paint(part, u0, u1, v0, v1) {
  const out = [];
  for (let v = v0; v <= v1; v++) for (let u = u0; u <= u1; u++) out.push(index(part, u, v));
  return out;
}

function reset() {
  partsStore.replaceAll([], null);
  bonesStore.replaceAll([], null);
  resetPierceContainment();
}

// A thumb above the V, pointing down (tip painted on its bottom rows).
function thumb(x = 46, y = 5) {
  const t = layer('Thumb', 8, 20, x, y, [240, 180, 150]);
  partsStore.setPierceRole(t.id, PierceRole.PIERCER);
  partsStore.setPierceRegion(t.id, paint(t, 0, 7, 16, 19), true);
  return t;
}

// Two fingers imported as separate layers, touching along x = 50.
function pairScene() {
  reset();
  const a = layer('Index', 10, 30, 40, 40);
  const b = layer('Medio', 10, 30, 50, 40);
  const t = thumb();
  for (const f of [a, b]) partsStore.setPierceRole(f.id, PierceRole.PIERCED);
  partsStore.setPierceRegion(a.id, paint(a, 5, 9, 0, 3), true);
  partsStore.setPierceRegion(b.id, paint(b, 0, 4, 0, 3), true);
  partsStore.setPiercePartner(a.id, b.id);
  return { a, b, t };
}

// Two fingers as ONE layer, split by a drawn seam down the middle.
function seamScene() {
  reset();
  const hand = layer('Hand', 20, 32, 40, 40);
  const t = thumb();
  partsStore.setPierceRole(hand.id, PierceRole.PIERCED);
  partsStore.setPierceRegion(hand.id, paint(hand, 6, 13, 0, 3), true);
  const seam = [];
  for (let v = 0; v <= 22; v++) seam.push(index(hand, v > 15 ? 9 : 10, v));
  partsStore.setPierceSeam(hand.id, seam, true);
  partsStore.setPierceSpreadMode(hand.id, SpreadMode.SEAM);
  return { hand, t };
}

function step() {
  partsStore.notifyTransformed();
  markPierceStale();
  stepPierce();
  return pierceDebug().find((d) => d.mode !== SpreadMode.OFF) || pierceDebug()[0];
}

// Where a texel point of a layer is drawn, on a given set of positions.
function pointOn(part, positions, u, v) {
  const located = locateTexel(part.mesh.vertices, part.mesh.triangles, u, v);
  return landTexel(positions, located);
}

// The signed area of every triangle of a drawn copy: a fold or tear flips
// or collapses one.
function worstTriangle(part, positions) {
  const T = part.mesh.triangles;
  let min = Infinity;
  for (let i = 0; i < T.length; i += 3) {
    const [a, b, c] = [positions[T[i]], positions[T[i + 1]], positions[T[i + 2]]];
    const area = (b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y);
    min = Math.min(min, area);
  }
  return min;
}

// The tip as DRAWN: where the drag put it, less whatever the End Point and
// the walls hold back.
function drawnTip(d, piercer) {
  const back = pierceHold().get(piercer.id) || { x: 0, y: 0 };
  return { x: d.rawTip.x - back.x, y: d.rawTip.y - back.y };
}

// ---------------------------------------------------------------------------
console.log('\nTwo layers: the halves, their seam and hinges, found from the artwork');
{
  const { a, b } = pairScene();
  const target = spreadTargetOf(a);
  const g = spreadGeometry(target);
  say(target && target.mode === SpreadMode.PAIR && target.layers.length === 2, 'Index + Medio are one V (a pair)');
  say(Math.abs(g.axis.x) < 0.05 && g.axis.y < -0.99, 'the seam runs where they touch, mouth up toward the painted Pierceable',
    `axis (${g.axis.x.toFixed(3)}, ${g.axis.y.toFixed(3)})`);
  const [ha, hb] = g.halves;
  say(ha.hinge.u === 9.5 && ha.hinge.v === 29.5 && hb.hinge.u === 0.5 && hb.hinge.v === 29.5,
    "each half's hinge defaults to the inside corner of its base -- the V's point",
    `Index ${JSON.stringify(ha.hinge)}, Medio ${JSON.stringify(hb.hinge)}`);
  say(ha.sigma === -1 && hb.sigma === 1, 'they turn away from each other (Index left, Medio right)');
  say(Math.abs(fullSwing(ha) - fullSwing(hb)) < 1e-9 && Math.abs(deg(fullSwing(ha)) - deg(Math.asin(6 / ha.lever))) < 1e-9,
    'each turns just far enough to move its mouth corner half the 12 px opening',
    `${deg(fullSwing(ha)).toFixed(2)} deg each over a ${ha.lever.toFixed(1)} px lever`);
  say(pierceTargets().filter((t2) => t2.mode === SpreadMode.PAIR).length === 1, 'the pair is measured as ONE target, not two');
}

// ---------------------------------------------------------------------------
async function sweep(label, scene, halvesOf) {
  const { t } = scene;
  const trail = [];
  const piercer = t;
  let worstCouple = 0;
  let worstSym = 0;
  let worstHinge = 0;
  let worstRigid = 0;
  let worstFold = Infinity;
  let worstBehind = 0;
  let lastTip = null;
  let worstJump = 0;
  let neverHidden = true;
  let backwards = 0;
  const ys = [];
  for (let y = 0; y <= 44; y++) ys.push(y);
  const path = [...ys, ...ys.slice().reverse()];
  const restHinges = new Map();
  for (const [k, y] of path.entries()) {
    t.y = y;
    const d = step();
    const enter = t.pierceEnter;
    const end = t.pierceEnd;
    const expected = d.inPath ? Math.min(1, Math.max(0, (t.pierceDentStart - d.gap) / (t.pierceDentStart - (enter - end)))) : 0;
    worstCouple = Math.max(worstCouple, Math.abs(d.openT - expected));
    const g = spreadGeometry(spreadTargetOf(halvesOf()[0].part));
    const full = g.halves.map((h) => fullSwing(h));
    d.swings.forEach((s, i) => { worstCouple = Math.max(worstCouple, Math.abs(Math.abs(s) - d.openT * full[i])); });
    if (d.swings.length === 2) worstSym = Math.max(worstSym, Math.abs(d.swings[0] + d.swings[1]));
    for (const h of halvesOf()) {
      const part = h.part;
      const key = `${part.id}:${h.copy}`;
      const drawn = deformVertices(part.mesh, part, null, h.copy);
      const hingeHere = pointOn(part, drawn, h.hinge.u, h.hinge.v);
      if (!restHinges.has(key)) restHinges.set(key, hingeHere);
      const rest = restHinges.get(key);
      worstHinge = Math.max(worstHinge, Math.hypot(hingeHere.x - rest.x, hingeHere.y - rest.y));
      worstFold = Math.min(worstFold, worstTriangle(part, deformVerticesSnapped(part.mesh, part, null, h.copy)));
      if (h.rigid) {
        // Every vertex exactly its rest position turned about the hinge.
        const swing = d.swings[h.index];
        const restPos = h.rest;
        const c = Math.cos(swing);
        const s = Math.sin(swing);
        drawn.forEach((p, i) => {
          const dx = restPos[i].x - rest.x;
          const dy = restPos[i].y - rest.y;
          worstRigid = Math.max(worstRigid, Math.hypot(p.x - (rest.x + dx * c - dy * s), p.y - (rest.y + dx * s + dy * c)));
        });
      }
    }
    if (halvesOf().length === 2 && halvesOf()[0].part === halvesOf()[1].part) {
      // One layer, two copies: identical at and behind the hinge.
      const part = halvesOf()[0].part;
      const A = deformVertices(part.mesh, part, null, 'a');
      const B = deformVertices(part.mesh, part, null, 'b');
      const g2 = spreadGeometry(spreadTargetOf(part));
      // Every TEXEL at or behind the hinge, as drawn through its triangle --
      // not just the mesh vertices, which is where a sub-pixel crack at the
      // V's point would hide.
      for (let v = 0; v < part.naturalHeight; v++) {
        for (let u = 0; u < part.naturalWidth; u++) {
          const s = (u + 0.5 - g2.origin.x) * g2.axis.x + (v + 0.5 - g2.origin.y) * g2.axis.y;
          if (s > 0) continue;
          const pa = pointOn(part, A, u + 0.5, v + 0.5);
          const pb = pointOn(part, B, u + 0.5, v + 0.5);
          worstBehind = Math.max(worstBehind, Math.hypot(pa.x - pb.x, pa.y - pb.y));
        }
      }
    }
    const tip = drawnTip(d, piercer);
    if (lastTip) {
      const moved = tip.y - lastTip.y;
      const dragged = k < ys.length ? 1 : -1;
      worstJump = Math.max(worstJump, Math.abs(moved));
      // Moving INWARD with the drag, never against it.
      if (moved * dragged < -1e-9) backwards++;
    }
    lastTip = tip;
    if (d.engaged) {
      const occ = pierceOcclusion().get(piercer.id);
      if (!occ || occ.mode !== 'lift') neverHidden = false;
    }
    trail.push({ y, gap: d.gap, open: d.openT, swings: d.swings.slice() });
  }
  // Reversible: the way back retraces the way in exactly.
  let worstReverse = 0;
  for (let i = 0; i < ys.length; i++) {
    const inward = trail[i];
    const outward = trail[trail.length - 1 - i];
    worstReverse = Math.max(worstReverse, Math.abs(inward.open - outward.open),
      ...inward.swings.map((s, j) => Math.abs(s - outward.swings[j])));
  }
  const opened = Math.max(...trail.map((r) => r.open));
  const samples = [0.1, 0.3, 0.5, 0.7, 0.9].map((q) => trail.find((r) => r.open >= q)).filter(Boolean);
  say(opened === 1 && trail[0].open === 0 && trail[trail.length - 1].open === 0,
    `${label}: shut before the trigger, fully open at End, shut again when backed out`);
  say(worstCouple < 1e-12, `${label}: the V is exactly the depth -- opening and both swings are one number`,
    `worst mismatch ${worstCouple.toExponential(1)}; at ${samples.map((r) => `${(r.open * 100).toFixed(0)}% ${r.swings.map((s) => deg(s).toFixed(1)).join('/')} deg`).join(', ')}`);
  say(worstSym < 1e-9, `${label}: symmetric -- the halves turn by equal and opposite angles`, `worst ${worstSym.toExponential(1)} rad`);
  say(worstHinge < 1e-9, `${label}: every hinge stays exactly where it is, like a PLink point`, `worst drift ${worstHinge.toExponential(1)} px`);
  if (worstRigid > 0 || halvesOf().some((h) => h.rigid)) {
    say(worstRigid < 1e-9, `${label}: each half turns rigidly about its hinge`, `worst deviation ${worstRigid.toExponential(1)} px`);
  }
  say(worstFold > 0, `${label}: no triangle of any drawn half ever folds or tears`, `smallest signed area ${worstFold.toFixed(3)}`);
  if (halvesOf().length === 2 && halvesOf()[0].part === halvesOf()[1].part) {
    say(worstBehind < 1e-9, `${label}: at and behind the V's point the two halves are one piece (copies identical)`,
      `worst ${worstBehind.toExponential(1)} px`);
  }
  say(backwards === 0 && worstJump <= 1 + 1e-9, `${label}: the tip is drawn moving continuously along its path with the drag -- never jumping, never backwards`,
    `largest step ${worstJump.toFixed(2)} px per 1 px of drag`);
  say(neverHidden, `${label}: whenever it is in contact the tip is drawn IN FRONT of the halves -- never hidden, never "appearing"`);
  say(worstReverse < 1e-12, `${label}: backing out retraces the exact same opening at every step`, `worst ${worstReverse.toExponential(1)}`);
}

console.log('\nTwo layers: driving the thumb in and back out, 1 px at a time');
{
  const scene = pairScene();
  const { a, b } = scene;
  const g = spreadGeometry(spreadTargetOf(a));
  step();
  const halves = g.halves.map((h, i) => ({
    part: h.part, copy: null, hinge: h.hinge, index: i, rigid: true,
    rest: deformVertices(h.part.mesh, h.part, null),
  }));
  await sweep('pair', scene, () => halves);
  // The V's measured width at full opening.
  scene.t.y = 40;
  const d = step();
  const pos = (p) => deformVertices(p.mesh, p, null);
  const ta = pointOn(a, pos(a), 9.5, 0.5);
  const tb = pointOn(b, pos(b), 0.5, 0.5);
  say(Math.abs(Math.hypot(ta.x - tb.x, ta.y - tb.y) - (12 + 1)) < 0.6 && d.openT === 1,
    'at full opening the mouth corners are the configured 12 px further apart than at rest',
    `${Math.hypot(ta.x - tb.x, ta.y - tb.y).toFixed(2)} px (1 px at rest)`);
  say(pierceOcclusion().get(scene.t.id)?.mode === 'lift', 'drawn in front of both halves while inside');
}

console.log('\nOne layer split by a drawn seam');
{
  const scene = seamScene();
  const { hand } = scene;
  const g = spreadGeometry(spreadTargetOf(hand));
  say(g && Math.abs(g.mouth.x - 10.5) < 1 && g.mouth.y < 1 && g.closed.y > 21,
    'the seam is read from the drawn line: mouth at the top edge, V point at its inner end',
    `mouth (${g.mouth.x.toFixed(1)}, ${g.mouth.y.toFixed(1)}), point (${g.closed.x.toFixed(1)}, ${g.closed.y.toFixed(1)})`);
  let both = 0; let neither = 0;
  for (let i = 0; i < g.maskA.length; i++) { if (g.maskA[i] && g.maskB[i]) both++; if (!g.maskA[i] && !g.maskB[i]) neither++; }
  say(both === 0 && neither === 0, 'every texel belongs to exactly one half');
  const left = g.maskA[index(hand, 2, 5)] ? 'a' : 'b';
  const right = g.maskA[index(hand, 17, 5)] ? 'a' : 'b';
  say(left !== right, 'the two sides of the seam are the two halves');
  // A wobble in the drawn line is followed, not straightened.
  const followsCurve = g.maskA[index(hand, 9, 18)] !== g.maskA[index(hand, 10, 5)]
    ? true : g.maskA[index(hand, 9, 18)] === g.maskA[index(hand, 8, 18)];
  say(followsCurve, 'the split follows the drawn seam where it bends');
  step();
  const halves = g.halves.map((h, i) => ({ part: hand, copy: h.side, hinge: h.hinge, index: i, rigid: false }));
  await sweep('seam', scene, () => halves);
  scene.t.y = 40;
  step();
  say(spreadMasks(hand) !== null, 'while open it is drawn as its two halves');
  scene.t.y = 0;
  step();
  say(spreadMasks(hand) === null, 'shut, it is drawn whole again');
}

// ---------------------------------------------------------------------------
console.log('\nHinges placed by hand');
{
  const { hand } = seamScene();
  partsStore.setPierceHinge(hand.id, 'a', { u: 2, v: 26 });
  partsStore.setPierceHinge(hand.id, 'b', { u: 18, v: 26 });
  const g = spreadGeometry(spreadTargetOf(hand));
  say(g.halves.some((h) => h.hinge.u === 2 && h.hinge.v === 26) && g.halves.some((h) => h.hinge.u === 18),
    'each half turns about its own placed hinge');
  scene2();
  function scene2() {
    const tt = partsStore.parts.find((p) => p.name === 'Thumb');
    tt.y = 40;
    const d = step();
    const parts = g.halves.map((h) => {
      const A = deformVertices(hand.mesh, hand, null, h.side);
      return pointOn(hand, A, h.hinge.u, h.hinge.v);
    });
    tt.y = 0;
    step();
    const rest = g.halves.map((h) => pointOn(hand, deformVertices(hand.mesh, hand, null, h.side), h.hinge.u, h.hinge.v));
    const drift = Math.max(...parts.map((p, i) => Math.hypot(p.x - rest[i].x, p.y - rest[i].y)));
    say(d.openT === 1 && drift < 1e-9, 'and neither placed hinge moves at full opening', `drift ${drift.toExponential(1)}`);
  }
}

// ---------------------------------------------------------------------------
console.log('\nBarrier: sideways only, and the channel widens with the V');
{
  const { a, b, t } = pairScene();
  // Walls down each finger, leaving a 4 px channel either side of the seam
  // (x 48..52 at rest), from just below the mouth to the base.
  partsStore.setPierceBarrierRegion(a.id, paint(a, 6, 7, 4, 29), true);
  partsStore.setPierceBarrierRegion(b.id, paint(b, 2, 3, 4, 29), true);
  // How far sideways the tip can be pushed, at one depth, before a wall
  // holds it: drag it 6 px to the right and see where it is drawn. Compared
  // at the SAME depth with the V set to open by different amounts -- a V
  // narrows toward its point, so comparing two depths would be comparing two
  // different places in it.
  const across = (width) => {
    partsStore.setPierceSpread(a.id, width);
    t.y = 30;
    t.x = 46 + 6;
    const d = step();
    const tip = drawnTip(d, t);
    t.x = 46;
    step();
    return { free: tip.x - 50, open: d.openT };
  };
  const shut = across(0);
  const some = across(8);
  const wide = across(20);
  say(shut.free < some.free - 0.5 && some.free < wide.free - 0.5,
    'the walls swing with the halves: the wider the V, the further the tip may drift sideways',
    `tip ${(wide.open * 100).toFixed(0)}% in: V shut ${shut.free.toFixed(1)} px, 8 px V ${some.free.toFixed(1)} px, 20 px V ${wide.free.toFixed(1)} px (of 6 asked)`);
  say(shut.free < 6 - 0.5, 'with the V shut the wall stops it well short of where the drag put it');
  partsStore.setPierceSpread(a.id, 12);
  // Straight down the middle nothing holds it back: the walls never stop
  // the tip going IN, so they can never stop the V opening.
  t.x = 46;
  let heldShort = 0;
  for (let y = 10; y <= 44; y++) {
    t.y = y;
    const d = step();
    // Before End nothing may hold the tip back at all.
    const back = pierceHold().get(t.id);
    if (back && d.depth < d.end - 1e-9) heldShort = Math.max(heldShort, back.distance);
  }
  const d = step();
  say(heldShort === 0 && d.openT === 1, 'walls never block the way in: straight down the middle the V opens fully',
    `held back before End by ${heldShort.toFixed(2)} px`);
}

// ---------------------------------------------------------------------------
console.log('\nForce transfer: the halves’ own bones are pushed apart');
{
  const { a, b, t } = pairScene();
  bonesStore.addBone({ head: { x: 50, y: 90 }, tail: { x: 50, y: 72 }, name: 'palm' });
  const palm = bonesStore.bones[0];
  bonesStore.addBone({ parentId: palm.id, head: { x: 45, y: 70 }, tail: { x: 45, y: 41 }, name: 'index' });
  bonesStore.addBone({ parentId: palm.id, head: { x: 55, y: 70 }, tail: { x: 55, y: 41 }, name: 'medio' });
  const bi = bonesStore.bones.find((x) => x.name === 'index');
  const bm = bonesStore.bones.find((x) => x.name === 'medio');
  bonesStore.setAttachedPart(bi.id, a.id);
  bonesStore.setAttachedPart(bm.id, b.id);
  bindPart(a, bonesStore);
  bindPart(b, bonesStore);
  bonesStore.setPhysicsEnabled(bi.id, true);
  bonesStore.setPhysicsEnabled(bm.id, true);
  // Drive in, and let the springs run.
  const angle = (bone) => (bone.simWorldRotation ?? bonesStore.targetWorldRotation(bone));
  const restI = bonesStore.targetWorldRotation(bi);
  const restM = bonesStore.targetWorldRotation(bm);
  for (let y = 0; y <= 36; y++) { t.y = y; step(); bonesStore.stepPhysics(1 / 60); }
  for (let k = 0; k < 90; k++) { step(); bonesStore.stepPhysics(1 / 60); }
  const leanI = angle(bi) - restI;
  const leanM = angle(bm) - restM;
  say(leanI < -0.01 && leanM > 0.01, 'held open, each finger’s physics bone leans away from the seam',
    `Index ${deg(leanI).toFixed(2)} deg, Medio ${deg(leanM).toFixed(2)} deg`);
  // Pull out: the press goes, and the springs swing back (jiggle) toward rest.
  t.y = 0;
  let crossed = false;
  let prev = angle(bi) - restI;
  for (let k = 0; k < 240; k++) {
    step();
    bonesStore.stepPhysics(1 / 60);
    const now = angle(bi) - restI;
    if (Math.sign(now) !== Math.sign(prev) && Math.abs(now) > 1e-4) crossed = true;
    prev = now;
  }
  say(Math.abs(angle(bi) - restI) < 0.01 && Math.abs(angle(bm) - restM) < 0.01,
    'released, both settle back to rest', `${crossed ? 'overshooting rest on the way (a jiggle)' : 'no overshoot'}`);
}

// ---------------------------------------------------------------------------
console.log('\nPhysics Direction: whose movement drives the coupled motion');
{
  const run = (mode) => {
    const { a, b, t } = pairScene();
    partsStore.setPiercePhysics(t.id, mode);
    t.y = 8;
    step();
    // The piercer drives in by 20 px...
    for (let y = 9; y <= 28; y++) { t.y = y; step(); }
    const byPiercer = step().openT;
    // ...then back out, and the HALVES move up onto it by 20 px instead.
    for (let y = 27; y >= 8; y--) { t.y = y; step(); }
    const start = step().openT;
    for (let k = 1; k <= 20; k++) { a.y = 40 - k; b.y = 40 - k; step(); }
    const byHalves = step().openT;
    return { byPiercer, byHalves, start };
  };
  const p = run(PiercePhysics.PIERCER);
  const q = run(PiercePhysics.PIERCED);
  const both = run(PiercePhysics.BOTH);
  say(p.byPiercer > 0.5 && p.byHalves === p.start, 'Piercer: only the piercer driving in opens the V',
    `piercer in: ${(p.byPiercer * 100).toFixed(0)}%, halves moved onto it: ${(p.byHalves * 100).toFixed(0)}%`);
  say(q.byPiercer === 0 && q.byHalves > 0.5, 'Pierced: only the halves moving onto it opens the V',
    `piercer in: ${(q.byPiercer * 100).toFixed(0)}%, halves moved: ${(q.byHalves * 100).toFixed(0)}%`);
  say(both.byPiercer > 0.5 && both.byHalves > 0.5, 'Both: either one does');
}

// ---------------------------------------------------------------------------
console.log('\nSetup, save and load');
{
  const { a, b } = pairScene();
  partsStore.setPierceHinge(a.id, 'a', { u: 7, v: 28 });
  partsStore.setPierceSpread(a.id, 20);
  say(b.pierceSpread === 20, 'a pair shares one opening: setting it on one half sets both');
  const saved = JSON.parse(JSON.stringify(serializeProject()));
  reset();
  await applyProject(saved);
  const a2 = partsStore.parts.find((p) => p.name === 'Index');
  const b2 = partsStore.parts.find((p) => p.name === 'Medio');
  say(partsStore.partnerOf(a2) === b2 && a2.pierceSpreadMode === SpreadMode.PAIR && a2.pierceHingeA.u === 7
    && a2.pierceSpread === 20, 'save + load restores the pair, its hinge and its opening');

  // A half deleted: the other is left pierced with its V off, not half a pair.
  partsStore.remove(b2.id);
  say(a2.pierceSpreadMode === SpreadMode.OFF && a2.piercePartnerId === null && a2.isPierced,
    'deleting one half switches the other’s V off, cleanly');

  // A seam layer round-trips too.
  const { hand } = seamScene();
  partsStore.setPierceHinge(hand.id, 'b', { u: 15, v: 27 });
  const saved2 = JSON.parse(JSON.stringify(serializeProject()));
  reset();
  await applyProject(saved2);
  const h2 = partsStore.parts.find((p) => p.name === 'Hand');
  say(h2.pierceSpreadMode === SpreadMode.SEAM && h2.pierceSeam.size === hand.pierceSeam.size
    && h2.pierceHingeB.u === 15 && h2.pierceHingeA === null, 'save + load restores a seam and its hinges');

  // A project saved with the old dent loads cleanly, its V switched off.
  const old = JSON.parse(JSON.stringify(saved2));
  for (const part of old.parts) {
    delete part.pierceSpreadMode; delete part.pierceSeam; delete part.piercePartnerId;
    delete part.pierceHingeA; delete part.pierceHingeB; delete part.pierceSpread;
    Object.assign(part, { pierceDentDepth: 9, pierceDentWidth: 14, pierceDentPlaced: true, pierceDentX: 3, pierceDentY: 4,
      pierceDentAngle: 1, pierceDeformRegion: [1, 2, 3] });
  }
  reset();
  await applyProject(old);
  const h3 = partsStore.parts.find((p) => p.name === 'Hand');
  say(h3.isPierced && h3.pierceSpreadMode === SpreadMode.OFF && h3.pierceRegion.size > 0 && !('pierceDentDepth' in h3),
    'a project saved with the old dent opens with its pierce intact and its V off');

  // A pair whose other half is missing from the file is not a pair.
  const broken = JSON.parse(JSON.stringify(saved));
  broken.parts = broken.parts.filter((p) => p.name !== 'Medio');
  reset();
  await applyProject(broken);
  const a4 = partsStore.parts.find((p) => p.name === 'Index');
  say(a4.pierceSpreadMode === SpreadMode.OFF && a4.piercePartnerId === null, 'a pair missing its other half loads with the V off');

  // Told plainly when a V cannot work.
  const { hand: bare } = seamScene();
  partsStore.setPierceSeam(bare.id, [...bare.pierceSeam], false);
  say(/no seam is drawn/.test(pierceSpreadIssue(bare) || ''), 'a Seam V with no seam drawn says so', pierceSpreadIssue(bare));
}

console.log(`\n${passed}/${total} passed`);
if (passed !== total) process.exit(1);
