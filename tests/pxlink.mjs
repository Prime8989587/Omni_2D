// PxLink: drawn connections between independent layers.
//
// Every check here is made on the geometry the renderer DRAWS -- snapped,
// linked, the same deformVerticesSnapped canvas.js uses -- and the link point
// is found on it independently of the solver's own bookkeeping (a second
// barycentric lookup written here, not borrowed). A solver that reported
// success while drawing something else would fail.
//
// What a link has to do, and each is tested separately:
//   * the linked points coincide, exactly, whatever the bones do;
//   * NOTHING ELSE CHANGES: away from its link point every linked layer is
//     drawn exactly where the same layer is drawn with no link at all -- its
//     own bones, springs, pivots and Free-Move drag untouched -- and the
//     layer that holds still is untouched everywhere;
//   * it is live: solved from the current pose alone, remembering nothing;
//   * three layers at one point, chains, a layer pulled two ways at once,
//     an unbound layer, a shared link, every joint type, physics;
//   * save/load (including files saved under the tool's old name), undo,
//     deleting a layer, cropping a layer.

import { Part, partsStore } from '../www/js/parts.js';
import { bonesStore, JointType } from '../www/js/bones.js';
import { bindPart, deformVertices, deformVerticesSnapped, deformVerticesUncorrected } from '../www/js/mesh.js';
import {
  pxlinkStore, initPxLink, sceneToTexel, defaultAnchor, linkPositions,
  serializePxLinks, deserializePxLinks, solve,
} from '../www/js/pxlink.js';
import { serializeProject, applyProject } from '../www/js/project.js';
import { history } from '../www/js/history.js';
import { setTargetLayer, beginPoseDrag, updatePoseDrag, endPoseDrag, targetBone } from '../www/js/poseTool.js';

initPxLink();

let passed = 0;
let total = 0;
const say = (ok, name, detail = '') => {
  total++;
  if (ok) passed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}`);
  if (detail) console.log(`          ${detail}`);
};
const rad = (degrees) => (degrees * Math.PI) / 180;

// ---------------------------------------------------------------------------
// Fixture: an arm and a hand imported as SEPARATE layers, each on its OWN
// bone, and both bones children of the torso -- the hand bone is not the
// arm bone's child, so nothing in the skeleton relates them at all.

function solid(width, height, rgb) {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) pixels.set([...rgb, 255], i * 4);
  return pixels;
}

function layer(name, width, height, x, y, rgb = [200, 120, 80]) {
  const part = new Part({ name, pixels: solid(width, height, rgb), width, height, x, y });
  partsStore.add(part);
  return part;
}

const bone = (name) => bonesStore.bones.find((b) => b.name === name);

function scene() {
  pxlinkStore.replaceAll([]);
  partsStore.replaceAll([], null);
  bonesStore.replaceAll([], null);
  const torso = layer('Torso', 24, 40, 52, 30, [60, 90, 200]);
  const arm = layer('Arm', 10, 30, 40, 40, [220, 150, 110]); // x 40..50, y 40..70
  const hand = layer('Hand', 10, 12, 40, 70, [240, 190, 160]); // x 40..50, y 70..82
  const cuff = layer('Cuff', 12, 4, 39, 68, [40, 200, 120]); // across the wrist
  bonesStore.addBone({ head: { x: 64.5, y: 30.5 }, tail: { x: 64.5, y: 69.5 }, name: 'torso' });
  const t = bone('torso').id;
  bonesStore.addBone({ parentId: t, head: { x: 45, y: 41 }, tail: { x: 45, y: 69 }, name: 'arm' });
  bonesStore.addBone({ parentId: t, head: { x: 45, y: 71 }, tail: { x: 45, y: 81 }, name: 'hand' });
  bonesStore.addBone({ parentId: t, head: { x: 40, y: 70 }, tail: { x: 50, y: 70 }, name: 'cuff' });
  bonesStore.setAttachedPart(bone('torso').id, torso.id);
  bonesStore.setAttachedPart(bone('arm').id, arm.id);
  bonesStore.setAttachedPart(bone('hand').id, hand.id);
  bonesStore.setAttachedPart(bone('cuff').id, cuff.id);
  for (const part of [torso, arm, hand, cuff]) bindPart(part, bonesStore);
  return { torso, arm, hand, cuff };
}

function link(parts, point, anchorId) {
  const members = parts.map((part) => ({ partId: part.id, ...sceneToTexel(part, point) }));
  return pxlinkStore.add({ members, anchorId: anchorId === undefined ? defaultAnchor(parts.map((p) => p.id)) : anchorId });
}

// ---------------------------------------------------------------------------
// The DRAWN geometry, and the link point found on it -- independently.

const snapshot = () => bonesStore.snapshotTransforms();

function drawn(part, transforms) {
  return { positions: deformVerticesSnapped(part.mesh, part, transforms), uvs: part.mesh.vertices, triangles: part.mesh.triangles };
}

function pointOn(geometry, u, v) {
  const { positions, uvs, triangles } = geometry;
  let best = null;
  let bestOut = Infinity;
  for (let t = 0; t < triangles.length; t += 3) {
    const [a, b, c] = [triangles[t], triangles[t + 1], triangles[t + 2]];
    const A = uvs[a], B = uvs[b], C = uvs[c];
    const den = (B.v - C.v) * (A.u - C.u) + (C.u - B.u) * (A.v - C.v);
    if (Math.abs(den) < 1e-12) continue;
    const l0 = ((B.v - C.v) * (u - C.u) + (C.u - B.u) * (v - C.v)) / den;
    const l1 = ((C.v - A.v) * (u - C.u) + (A.u - C.u) * (v - C.v)) / den;
    const l2 = 1 - l0 - l1;
    const out = Math.max(0, -l0, -l1, -l2);
    if (out < bestOut) {
      bestOut = out;
      best = {
        x: l0 * positions[a].x + l1 * positions[b].x + l2 * positions[c].x,
        y: l0 * positions[a].y + l1 * positions[b].y + l2 * positions[c].y,
      };
    }
  }
  return best;
}

// The widest separation between any two members of a link, as drawn.
function gap(theLink, transforms = snapshot()) {
  const pts = theLink.members.map((m) => {
    const part = partsStore.parts.find((p) => p.id === m.partId);
    return pointOn(drawn(part, transforms), m.u, m.v);
  });
  let worst = 0;
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) worst = Math.max(worst, Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y));
  }
  return worst;
}

function linkAt(theLink, partId, transforms = snapshot()) {
  const m = theLink.members.find((x) => x.partId === partId);
  const part = partsStore.parts.find((p) => p.id === partId);
  return pointOn(drawn(part, transforms), m.u, m.v);
}

// The same layer, same pose, with NO links in the project at all -- the
// control every "nothing else changes" check is measured against. Links are
// taken out and put back through the store, so nothing of the solve can
// leak into the control.
function unlinked(part, transforms = snapshot()) {
  const saved = serializePxLinks();
  pxlinkStore.replaceAll([]);
  const positions = deformVertices(part.mesh, part, transforms);
  pxlinkStore.replaceAll(saved);
  return positions;
}

// Where a link point would be with no link: the gap the link is closing.
function openGap(theLink, transforms = snapshot()) {
  const pts = theLink.members.map((m) => {
    const part = partsStore.parts.find((p) => p.id === m.partId);
    return pointOn({ positions: unlinked(part, transforms), uvs: part.mesh.vertices, triangles: part.mesh.triangles }, m.u, m.v);
  });
  let worst = 0;
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) worst = Math.max(worst, Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y));
  }
  return worst;
}

// How the linked layer differs from the same layer unlinked: the worst
// difference among vertices OUTSIDE every weld (must be zero), how many
// vertices that is, and the furthest (in texels) any moved vertex is from a
// link point on this layer, against the reach of the widest weld.
function footprint(part, transforms = snapshot()) {
  const linked = deformVertices(part.mesh, part, transforms);
  const alone = unlinked(part, transforms);
  const correction = solve(transforms).get(part.id);
  const welds = correction ? correction.welds : [];
  const V = part.mesh.vertices;
  let outsideWorst = 0;
  let outside = 0;
  let movedFar = 0;
  linked.forEach((p, i) => {
    const d = Math.hypot(p.x - alone[i].x, p.y - alone[i].y);
    const within = welds.some((w) => Math.hypot(V[i].u - w.u, V[i].v - w.v) < w.radius);
    if (!within) { outside++; outsideWorst = Math.max(outsideWorst, d); }
    if (d > 0) {
      for (const w of welds) movedFar = Math.max(movedFar, Math.hypot(V[i].u - w.u, V[i].v - w.v) / w.radius);
    }
  });
  const everyWorst = Math.max(...linked.map((p, i) => Math.hypot(p.x - alone[i].x, p.y - alone[i].y)));
  return { outsideWorst, outside, of: V.length, movedFar, everyWorst, welds };
}

// Triangles turned inside out by the link that are not inside out unlinked.
function folds(part, transforms = snapshot()) {
  const linked = deformVertices(part.mesh, part, transforms);
  const alone = unlinked(part, transforms);
  const T = part.mesh.triangles;
  const area = (P, t) => {
    const [a, b, c] = [P[T[t]], P[T[t + 1]], P[T[t + 2]]];
    return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  };
  let n = 0;
  for (let t = 0; t < T.length; t += 3) if (Math.sign(area(linked, t)) !== Math.sign(area(alone, t))) n++;
  return n;
}

const EXACT = 1e-6; // scene px; a thousandth of a thousandth of a pixel

// ---------------------------------------------------------------------------
console.log('\nPxLink -- two separate layers, joined at one point and nowhere else');
{
  const { arm, hand } = scene();
  const wrist = { x: 45, y: 70 };
  const L = link([arm, hand], wrist);
  say(L && L.anchorId === arm.id && L.id.startsWith('pxlink_'), 'link created, arm (first chosen, equal depth) holds still',
    `anchor ${L && partsStore.parts.find((p) => p.id === L.anchorId).name}, id ${L && L.id}`);
  say(gap(L) < EXACT, 'at rest the drawn link points coincide', `gap ${gap(L).toExponential(2)}`);

  const before = deformVerticesUncorrected(hand.mesh, hand, snapshot());
  const after = deformVertices(hand.mesh, hand, snapshot());
  const moved = Math.max(...before.map((p, i) => Math.hypot(after[i].x - p.x, after[i].y - p.y)));
  say(moved < EXACT, 'at rest a link changes nothing', `max vertex shift ${moved.toExponential(2)}`);

  const base = bone('arm').rotation;
  let worstGap = 0;
  let worstOpen = 0;
  let armWorst = 0;
  let outsideWorst = 0;
  let movedFar = 0;
  let folded = 0;
  const kept = [];
  for (const d of [5, 30, 60, 90, 135, 170, -45, -120, -179]) {
    bone('arm').rotation = base + rad(d);
    worstGap = Math.max(worstGap, gap(L));
    worstOpen = Math.max(worstOpen, openGap(L));
    armWorst = Math.max(armWorst, footprint(arm).everyWorst);
    const f = footprint(hand);
    outsideWorst = Math.max(outsideWorst, f.outsideWorst);
    movedFar = Math.max(movedFar, f.movedFar);
    folded += folds(hand);
    kept.push(`${d}deg ${f.outside}/${f.of}`);
  }
  say(worstGap < EXACT, 'arm swung through 9 angles to +-179 deg: the wrist never parts',
    `worst gap ${worstGap.toExponential(2)} px (unlinked it would open to ${worstOpen.toFixed(1)} px)`);
  say(armWorst === 0, 'the layer that holds still (arm) is drawn EXACTLY as with no link, every vertex', `worst ${armWorst}`);
  say(outsideWorst === 0, "the hand, away from the wrist, is drawn EXACTLY where its own bone puts it -- no whole-layer move",
    `worst ${outsideWorst} px; vertices outside the weld: ${kept.join(', ')}`);
  say(movedFar <= 1, 'every hand vertex the link moved is inside the weld around the link point',
    `furthest moved vertex at ${movedFar.toFixed(3)} of the weld's reach`);
  say(folded === 0, 'closing even a 55 px gap bends the wrist, never folds it inside out', `${folded} folded triangles`);
  bone('arm').rotation = base;

  // The hand turned on ITS OWN bone: it turns exactly as its bone says, and
  // the link point still meets the arm's.
  const hb = bone('hand').rotation;
  let worstOwn = 0;
  let worstHeld = 0;
  const armPoint = linkAt(L, arm.id);
  for (const d of [20, 75, -60, 150]) {
    bone('hand').rotation = hb + rad(d);
    worstOwn = Math.max(worstOwn, footprint(hand).outsideWorst);
    const at = linkAt(L, hand.id);
    worstHeld = Math.max(worstHeld, Math.hypot(at.x - armPoint.x, at.y - armPoint.y));
  }
  say(worstOwn === 0, "the hand turned on its own bone: drawn exactly as its own bone turns it (outside the weld)", `worst ${worstOwn}`);
  say(worstHeld < EXACT, "and its link point still sits on the arm's", `worst ${worstHeld.toExponential(2)} px`);
  bone('hand').rotation = hb;

  // Hand holds still instead: the ARM's link point comes to the hand's, and
  // the hand is untouched everywhere.
  pxlinkStore.setAnchor(L.id, hand.id);
  bone('hand').rotation = hb + rad(40);
  const handAll = footprint(hand).everyWorst;
  const armOut = footprint(arm).outsideWorst;
  say(gap(L) < EXACT && handAll === 0 && armOut === 0, "hand holds still: the arm's link point follows the hand's; the hand is untouched",
    `gap ${gap(L).toExponential(2)}, hand ${handAll}, arm outside its weld ${armOut}`);
  bone('hand').rotation = hb;
}

// ---------------------------------------------------------------------------
console.log('\nLive, every frame: nothing is remembered');
{
  const { arm, hand } = scene();
  const L = link([arm, hand], { x: 45, y: 70 });
  const base = bone('arm').rotation;
  const at = (d) => { bone('arm').rotation = base + rad(d); return deformVerticesSnapped(hand.mesh, hand, snapshot()); };
  const first = at(50);
  for (const d of [10, -90, 170, 3, -40, 120]) at(d);
  const again = at(50);
  const same = first.every((p, i) => p.x === again[i].x && p.y === again[i].y);
  say(same, 'the same pose reached by any path is drawn bit-for-bit the same');

  // A link made in a DIFFERENT pose -- the arm already swung -- draws the
  // pose identically: where the layers were when the link was made is not
  // stored anywhere.
  const fresh = scene();
  bone('arm').rotation = base + rad(80);
  const L2 = link([fresh.arm, fresh.hand], { x: 45, y: 70 });
  bone('arm').rotation = base + rad(50);
  const madeElsewhere = deformVerticesSnapped(fresh.hand.mesh, fresh.hand, snapshot());
  const outside = footprint(fresh.hand);
  say(gap(L2) < EXACT && outside.outsideWorst === 0,
    'a link made in another pose: still coincident, still no whole-layer move',
    `gap ${gap(L2).toExponential(2)}, outside the weld ${outside.outsideWorst}`);
  say(madeElsewhere.length === first.length, '(same mesh either way)');
  void L;
}

// ---------------------------------------------------------------------------
console.log('\nEvery joint type, and physics: the link never touches the bones');
{
  const run = (type, withLink) => {
    const { arm, hand } = scene();
    bonesStore.setJointType(bone('arm').id, type);
    bonesStore.setJointType(bone('hand').id, type);
    const L = withLink ? link([arm, hand], { x: 45, y: 70 }) : null;
    const trace = [];
    let worst = 0;
    let outside = 0;
    const base = bone('torso').rotation;
    const armBase = bone('arm').rotation;
    for (let frame = 0; frame < 90; frame++) {
      // The torso rocks and the arm swings -- springs lag, pivots follow.
      bone('torso').rotation = base + 0.4 * Math.sin(frame / 7);
      bone('arm').rotation = armBase + 1.2 * Math.sin(frame / 5);
      bonesStore.stepPhysics(1 / 60);
      const T = snapshot();
      trace.push(JSON.stringify(Object.values(T).map((t) => [t.head, t.rotation])));
      if (L) {
        worst = Math.max(worst, gap(L, T));
        outside = Math.max(outside, footprint(hand, T).outsideWorst);
      }
    }
    return { trace, worst, outside };
  };
  for (const type of [JointType.RIGID, JointType.PHYSICS, JointType.PIVOT]) {
    const linked = run(type, true);
    const control = run(type, false);
    const sameBones = linked.trace.length === control.trace.length && linked.trace.every((t, i) => t === control.trace[i]);
    say(linked.worst < EXACT, `${type} bones on both layers: 90 frames rocking, the link never parts`, `worst gap ${linked.worst.toExponential(2)} px`);
    say(sameBones, `${type}: every bone -- ${type === JointType.PHYSICS ? 'springs included, ' : ''}frame by frame -- moves exactly as with no link`);
    say(linked.outside === 0, `${type}: the hand, away from the wrist, is drawn exactly as unlinked on all 90 frames`, `worst ${linked.outside}`);
  }
}

// ---------------------------------------------------------------------------
console.log('\nThree layers at one point');
{
  const { arm, hand, cuff } = scene();
  const L = link([arm, hand, cuff], { x: 45, y: 70 });
  say(L.members.length === 3, 'one link, three members');
  let worst = 0;
  const report = [];
  for (const name of ['arm', 'hand', 'cuff']) {
    const b = bone(name);
    const r = b.rotation;
    for (const d of [30, -80, 140]) {
      b.rotation = r + rad(d);
      worst = Math.max(worst, gap(L));
    }
    report.push(`${name} ${worst.toExponential(1)}`);
    b.rotation = r;
  }
  say(worst < EXACT, 'arm, hand and cuff each swung in turn: all three coincide throughout', report.join(', '));
  bone('arm').rotation += rad(60);
  bone('hand').rotation += rad(-30);
  bone('cuff').rotation += rad(100);
  say(gap(L) < EXACT, 'all three swung at once: still one point', `gap ${gap(L).toExponential(2)}`);
}

// ---------------------------------------------------------------------------
console.log('\nShared links, chains, and a layer pulled two ways');
{
  const { arm, hand } = scene();
  const L = link([arm, hand], { x: 45, y: 70 }, null);
  bone('arm').rotation += rad(80);
  const armRaw = pointOn({ positions: unlinked(arm), uvs: arm.mesh.vertices, triangles: arm.mesh.triangles }, L.members[0].u, L.members[0].v);
  const handRaw = pointOn({ positions: unlinked(hand), uvs: hand.mesh.vertices, triangles: hand.mesh.triangles }, L.members[1].u, L.members[1].v);
  const met = linkAt(L, arm.id);
  const mid = { x: (armRaw.x + handRaw.x) / 2, y: (armRaw.y + handRaw.y) / 2 };
  say(gap(L) < EXACT && Math.hypot(met.x - mid.x, met.y - mid.y) < EXACT,
    'SHARED link: both points give way and meet exactly halfway', `gap ${gap(L).toExponential(2)}, off midpoint ${Math.hypot(met.x - mid.x, met.y - mid.y).toExponential(2)}`);
  const a = footprint(arm).outsideWorst;
  const h = footprint(hand).outsideWorst;
  say(a === 0 && h === 0, 'and both layers, away from the point, are exactly where their own bones put them', `arm ${a}, hand ${h}`);
}
{
  // Chain: torso -> arm at the shoulder, arm -> hand at the wrist, with the
  // arm and hand bones BOTH children of the torso.
  const { torso, arm, hand } = scene();
  const shoulder = link([torso, arm], { x: 45, y: 41 }, torso.id);
  const wrist = link([arm, hand], { x: 45, y: 70 }, arm.id);
  let worst = 0;
  const tb = bone('torso').rotation;
  for (const d of [15, -25, 40]) {
    bone('torso').rotation = tb + rad(d);
    bone('arm').rotation += rad(d * 2);
    worst = Math.max(worst, gap(shoulder), gap(wrist));
  }
  say(worst < EXACT, 'a chain (torso -> arm -> hand): both links hold as everything moves', `worst ${worst.toExponential(2)}`);
}
{
  // The hand linked to the arm at the wrist AND to the torso at its side:
  // swing the arm and each weld takes up its own point's difference, locally.
  const { torso, arm, hand } = scene();
  const wrist = link([arm, hand], { x: 45, y: 70 }, arm.id);
  const side = link([torso, hand], { x: 50, y: 80 }, torso.id);
  bone('arm').rotation += rad(35);
  const g1 = gap(wrist);
  const g2 = gap(side);
  say(g1 < EXACT && g2 < EXACT, 'a layer linked at two points: BOTH points coincide exactly',
    `wrist ${g1.toExponential(2)}, side ${g2.toExponential(2)}`);
  const P = deformVertices(hand.mesh, hand, snapshot());
  const finite = P.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  say(finite, 'and the result is finite everywhere');
}

// ---------------------------------------------------------------------------
console.log('\nAn unbound layer, pins, and the Free-Move drag');
{
  const { arm } = scene();
  const patch = layer('Patch', 6, 6, 42, 60, [250, 250, 60]); // unbound, on the forearm
  const L = link([arm, patch], { x: 45, y: 63 });
  say(L.anchorId === arm.id, 'the rigged layer holds still by default; unbound artwork gives way');
  say(Boolean(patch.mesh) && !patch.mesh.isBound, 'the unbound layer is given an unbound mesh, so it can bend locally');
  const rest = deformVerticesSnapped(patch.mesh, patch, snapshot());
  const quad = rest.every((p, i) => p.x === patch.x + patch.mesh.vertices[i].u && p.y === patch.y + patch.mesh.vertices[i].v);
  say(quad, 'and at rest it is drawn exactly as its quad was');
  let worst = 0;
  const base = bone('arm').rotation;
  for (const d of [3, 20, 90, -130]) {
    bone('arm').rotation = base + rad(d);
    worst = Math.max(worst, gap(L));
  }
  say(worst < EXACT, "an unbound layer's link point meets the arm's exactly", `worst ${worst.toExponential(2)}`);
}
{
  const { arm, hand } = scene();
  // Pin the hand's lower half -- Px Pin holds it to the hand's own carriage.
  const idx = [];
  for (let v = 6; v < 12; v++) for (let u = 0; u < 10; u++) idx.push(v * 10 + u);
  partsStore.setPins(hand.id, idx, true);
  bonesStore.setJointType(bone('hand').id, JointType.PHYSICS);
  const L = link([arm, hand], { x: 45, y: 70 });
  let worst = 0;
  const base = bone('arm').rotation;
  for (let frame = 0; frame < 60; frame++) {
    bone('arm').rotation = base + 1.0 * Math.sin(frame / 6);
    bonesStore.stepPhysics(1 / 60);
    worst = Math.max(worst, gap(L));
  }
  say(worst < EXACT, 'a Px-Pinned hand on a physics bone keeps its link', `worst ${worst.toExponential(2)}`);
}
{
  // Free Move: the same drags, linked and unlinked, must turn the bones
  // IDENTICALLY -- springs and all, frame by frame; the link never changes
  // what a drag does -- and the link must hold on every frame.
  const pose = () => JSON.stringify(Object.values(snapshot()).map((t) => [t.head, t.rotation]));
  const dragArm = (withLink, step) => {
    const { arm, hand } = scene();
    bonesStore.setJointType(bone('arm').id, JointType.PHYSICS);
    const L = withLink ? link([arm, hand], { x: 45, y: 70 }) : null;
    setTargetLayer(arm.id);
    const b = targetBone();
    const tail = bonesStore.restWorldTail(b);
    beginPoseDrag(b, tail);
    const joint = bonesStore.restWorldHead(b);
    const radius = Math.hypot(tail.x - joint.x, tail.y - joint.y);
    const n = Math.max(2, Math.round((Math.PI * radius) / step));
    const angles = [];
    let worst = 0;
    let armTouched = 0;
    let handOutside = 0;
    let followed = 0;
    const handStart = L ? linkAt(L, hand.id) : null;
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i <= n; i++) {
        const a = Math.PI / 2 + (pass === 0 ? 1 : -1) * Math.PI * (i / n) + (pass === 0 ? 0 : Math.PI);
        updatePoseDrag({ x: joint.x + radius * Math.cos(a), y: joint.y + radius * Math.sin(a) });
        bonesStore.stepPhysics(1 / 60); // as the app does every frame
        angles.push(pose());
        if (L) {
          worst = Math.max(worst, gap(L));
          armTouched = Math.max(armTouched, footprint(arm).everyWorst);
          handOutside = Math.max(handOutside, footprint(hand).outsideWorst);
          const p = linkAt(L, hand.id);
          followed = Math.max(followed, Math.hypot(p.x - handStart.x, p.y - handStart.y));
        }
      }
    }
    endPoseDrag();
    setTargetLayer(null);
    return { angles, worst, armTouched, handOutside, followed };
  };
  const dragHand = (withLink, step) => {
    const { arm, hand } = scene();
    bonesStore.setJointType(bone('hand').id, JointType.PHYSICS);
    const L = withLink ? link([arm, hand], { x: 45, y: 70 }) : null;
    setTargetLayer(hand.id);
    const b = targetBone();
    const tail = bonesStore.restWorldTail(b);
    const joint = bonesStore.restWorldHead(b);
    beginPoseDrag(b, tail);
    const reach = Math.hypot(tail.x - joint.x, tail.y - joint.y) + 2;
    const m = Math.max(2, Math.round((Math.PI * reach) / step));
    const angles = [];
    let worst = 0;
    let outside = 0;
    for (let i = 0; i <= m; i++) {
      const a = Math.PI / 2 + Math.PI * 0.9 * (i / m);
      updatePoseDrag({ x: joint.x + reach * Math.cos(a), y: joint.y + reach * Math.sin(a) });
      bonesStore.stepPhysics(1 / 60);
      angles.push(pose());
      if (L) {
        worst = Math.max(worst, gap(L));
        outside = Math.max(outside, footprint(hand).outsideWorst);
      }
    }
    endPoseDrag();
    setTargetLayer(null);
    return { angles, worst, outside };
  };
  const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
  for (const [label, step] of [['slow (1 px steps)', 1], ['fast (37 px jumps)', 37]]) {
    const linked = dragArm(true, step);
    const control = dragArm(false, step);
    say(same(linked.angles, control.angles), `Free-Move dragging the physics ARM, ${label}: its bone and spring follow the finger exactly as unlinked, frame for frame`);
    say(linked.worst < EXACT && linked.armTouched === 0,
      `the arm holds still: drawn exactly as unlinked, every vertex, on all ${linked.angles.length} frames`,
      `worst gap ${linked.worst.toExponential(2)} px, arm ${linked.armTouched}`);
    say(linked.followed > 20 && linked.handOutside === 0,
      "and the hand's link point follows the arm's the whole way, the rest of the hand where its own bone puts it",
      `hand's wrist point travelled ${linked.followed.toFixed(1)} px; hand outside the weld ${linked.handOutside}`);

    const hand = dragHand(true, step);
    const handControl = dragHand(false, step);
    say(same(hand.angles, handControl.angles), `Free-Move dragging the physics HAND, ${label}: its bone and spring follow the finger exactly as unlinked`);
    say(hand.worst < EXACT && hand.outside === 0, `and it is drawn where that drag puts it (outside the weld), joined at the wrist throughout`,
      `worst gap ${hand.worst.toExponential(2)}, outside the weld ${hand.outside}`);
  }
}

// ---------------------------------------------------------------------------
console.log('\nSave, load, undo, delete, crop');
{
  const { torso, arm, hand, cuff } = scene();
  const a = link([arm, hand], { x: 45, y: 70 });
  const b = link([torso, cuff, hand], { x: 50, y: 69 }, null);
  const saved = JSON.parse(JSON.stringify(serializeProject()));
  say(Array.isArray(saved.pxlinks) && saved.pxlinks.length === 2, 'links are part of the project file', `${saved.pxlinks && saved.pxlinks.length} saved`);
  pxlinkStore.replaceAll([]);
  partsStore.replaceAll([], null);
  bonesStore.replaceAll([], null);
  await applyProject(saved);
  const back = pxlinkStore.links;
  const same = back.length === 2 && JSON.stringify(back.map((l) => [l.id, l.anchorId, l.members])) === JSON.stringify([a, b].map((l) => [l.id, l.anchorId, l.members]));
  say(same, 'load restores every link: ids, members, points, anchors');
  bone('arm').rotation += rad(75);
  const g = Math.max(gap(back[0]), gap(back[1]));
  say(g < EXACT, 'and the loaded links hold', `worst ${g.toExponential(2)}`);

  // A project saved before the tool was renamed: the old key, the old ids.
  const legacy = JSON.parse(JSON.stringify(saved));
  legacy.plinks = legacy.pxlinks.map((l) => ({ ...l, id: l.id.replace(/^pxlink_/, 'plink_') }));
  delete legacy.pxlinks;
  pxlinkStore.replaceAll([]);
  await applyProject(legacy);
  const old = pxlinkStore.links;
  say(old.length === 2 && old.every((l) => l.id.startsWith('pxlink_')) && JSON.stringify(old.map((l) => l.members)) === JSON.stringify([a, b].map((l) => l.members)),
    'a project saved under the old name loads every link, renamed', old.map((l) => l.id).join(', '));
  const resaved = serializeProject();
  say(Array.isArray(resaved.pxlinks) && !('plinks' in resaved), 'and is saved back under the new name');

  const junk = deserializePxLinks([
    null, { id: 5 }, { id: 'x', members: 'no' },
    { id: 'pxlink_90', members: [{ partId: arm.id, u: 1, v: 2 }, { partId: 'ghost', u: 0, v: 0 }] },
    { id: 'pxlink_91', members: [{ partId: arm.id, u: 1, v: NaN }, { partId: hand.id, u: 1, v: 1 }] },
    { id: 'pxlink_92', anchorId: 'ghost', members: [{ partId: arm.id, u: 1, v: 2 }, { partId: arm.id, u: 3, v: 3 }, { partId: hand.id, u: 1, v: 1 }] },
  ], partsStore.parts.map((p) => p.id));
  say(junk.length === 1 && junk[0].members.length === 2 && junk[0].anchorId === null,
    'a damaged file: bad links dropped, missing layers pruned, duplicates merged, bad anchor cleared', JSON.stringify(junk));
}
{
  const { arm, hand, cuff } = scene();
  history.reset();
  let made = null;
  history.run('Add PxLink', () => { made = link([arm, hand], { x: 45, y: 70 }); });
  history.run('Add PxLink', () => { link([arm, cuff], { x: 45, y: 69 }); });
  say(pxlinkStore.links.length === 2, 'two links added through history');
  history.undo();
  say(pxlinkStore.links.length === 1 && pxlinkStore.links[0].id === made.id, 'undo removes only the last link');
  history.redo();
  say(pxlinkStore.links.length === 2, 'redo restores it');
  const victim = pxlinkStore.links[1].id;
  history.run('Delete PxLink', () => pxlinkStore.remove(victim));
  say(pxlinkStore.links.length === 1 && pxlinkStore.links[0].id === made.id, 'deleting one link leaves the other untouched');
  history.undo();
  say(pxlinkStore.links.length === 2, 'and deleting is undoable');
}
{
  const { torso, arm, hand, cuff } = scene();
  link([arm, hand], { x: 45, y: 70 });
  link([torso, cuff], { x: 52, y: 69 });
  link([arm, hand, cuff], { x: 45, y: 69 });
  partsStore.remove(hand.id);
  const left = pxlinkStore.links.map((l) => l.members.length);
  say(pxlinkStore.links.length === 2 && left.includes(2) && !pxlinkStore.links.some((l) => l.members.some((m) => m.partId === hand.id)),
    "deleting a layer ends ITS links only (a 3-way link keeps its other two)", `left: ${JSON.stringify(left)}`);
}
{
  const { arm, hand } = scene();
  const L = link([arm, hand], { x: 45, y: 70 });
  const before = { ...L.members[0] };
  pxlinkStore.shiftAnchors(arm.id, -2, -3);
  const after = pxlinkStore.byId(L.id).members[0];
  say(after.u === before.u - 2 && after.v === before.v - 3 && pxlinkStore.byId(L.id).members[1].u === L.members[1].u,
    "a cropped layer's link point moves with the crop, and only that layer's");
  const reported = linkPositions()[0];
  say(reported && reported.members.length === 2, 'linkPositions reports every member for the tool markers');
}

console.log(`\n${passed}/${total} passed`);
if (passed !== total) process.exit(1);
