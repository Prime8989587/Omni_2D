// PLink: drawn hinge connections between independent layers.
//
// Every check here is made on the geometry the renderer DRAWS -- snapped,
// linked, the same deformVerticesSnapped / corrected quad canvas.js uses --
// and the link point is found on it independently of the solver's own
// bookkeeping (a second barycentric lookup written here, not borrowed). A
// solver that reported success while drawing something else would fail.
//
// What a hinge has to do, and each is tested separately:
//   * the linked points coincide, exactly, whatever the bones do;
//   * each layer keeps its OWN rotation -- a hand carried by a swinging arm
//     keeps its angle (T_child = T_parent * T_offset would turn it with the
//     arm, and a control below proves the test would catch that);
//   * a layer turned on its own bone pivots about the link point;
//   * three layers at one point, chains, a layer pulled two ways at once,
//     an unbound layer, a shared link, every joint type;
//   * save/load, undo, deleting a layer, cropping a layer.

import { Part, partsStore } from '../www/js/parts.js';
import { bonesStore, JointType } from '../www/js/bones.js';
import { bindPart, deformVertices, deformVerticesSnapped, deformVerticesUncorrected, localToWorld } from '../www/js/mesh.js';
import {
  plinkStore, initPLink, sceneToTexel, defaultAnchor, correctQuad, linkPositions,
  serializePLinks, deserializePLinks, linkShift,
} from '../www/js/plink.js';
import { serializeProject, applyProject } from '../www/js/project.js';
import { history } from '../www/js/history.js';
import { setTargetLayer, beginPoseDrag, updatePoseDrag, endPoseDrag, targetBone } from '../www/js/poseTool.js';

initPLink();

let passed = 0;
let total = 0;
const say = (ok, name, detail = '') => {
  total++;
  if (ok) passed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}`);
  if (detail) console.log(`          ${detail}`);
};
const deg = (radians) => (radians * 180) / Math.PI;
const rad = (degrees) => (degrees * Math.PI) / 180;
const wrap = (a) => { let x = a; while (x > Math.PI) x -= 2 * Math.PI; while (x < -Math.PI) x += 2 * Math.PI; return x; };

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
  plinkStore.replaceAll([]);
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
  return plinkStore.add({ members, anchorId: anchorId === undefined ? defaultAnchor(parts.map((p) => p.id)) : anchorId });
}

// ---------------------------------------------------------------------------
// The DRAWN geometry, and the link point found on it -- independently.

const snapshot = () => bonesStore.snapshotTransforms();

function corners(part) {
  const w = part.naturalWidth;
  const h = part.naturalHeight;
  return [{ x: -w / 2, y: -h / 2 }, { x: w / 2, y: -h / 2 }, { x: w / 2, y: h / 2 }, { x: -w / 2, y: h / 2 }]
    .map((local) => localToWorld(part, local));
}

function drawn(part, transforms) {
  if (part.mesh && part.mesh.isBound) {
    return { positions: deformVerticesSnapped(part.mesh, part, transforms), uvs: part.mesh.vertices, triangles: part.mesh.triangles };
  }
  const w = part.naturalWidth;
  const h = part.naturalHeight;
  return {
    positions: correctQuad(part, corners(part), transforms),
    uvs: [{ u: 0, v: 0 }, { u: w, v: 0 }, { u: w, v: h }, { u: 0, v: h }],
    triangles: [0, 1, 3, 1, 2, 3],
  };
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

// A layer's own orientation as drawn: the direction between two of its
// vertices far apart down its length (unsnapped, so it is exact).
function heading(part, transforms = snapshot()) {
  const V = part.mesh.vertices;
  let top = 0;
  let bottom = 0;
  V.forEach((t, i) => {
    if (t.v < V[top].v || (t.v === V[top].v && t.u < V[top].u)) top = i;
    if (t.v > V[bottom].v || (t.v === V[bottom].v && t.u < V[bottom].u)) bottom = i;
  });
  const P = deformVertices(part.mesh, part, transforms);
  return Math.atan2(P[bottom].y - P[top].y, P[bottom].x - P[top].x);
}

const EXACT = 1e-6; // scene px; a thousandth of a thousandth of a pixel

// ---------------------------------------------------------------------------
console.log('\nPLink -- two separate layers, one hinge');
{
  const { arm, hand } = scene();
  const wrist = { x: 45, y: 70 };
  const L = link([arm, hand], wrist);
  say(L && L.anchorId === arm.id, 'link created, arm (first chosen, equal depth) anchors',
    `anchor ${L && partsStore.parts.find((p) => p.id === L.anchorId).name}`);
  say(gap(L) < EXACT, 'at rest the drawn link points coincide', `gap ${gap(L).toExponential(2)}`);

  const before = deformVerticesUncorrected(hand.mesh, hand, snapshot());
  const after = deformVertices(hand.mesh, hand, snapshot());
  const moved = Math.max(...before.map((p, i) => Math.hypot(after[i].x - p.x, after[i].y - p.y)));
  say(moved < EXACT, 'at rest a link changes nothing', `max vertex shift ${moved.toExponential(2)}`);

  const handRest = heading(hand);
  const armRest = heading(arm);
  const base = bone('arm').rotation;
  let worstGap = 0;
  let worstTurn = 0;
  let armTurned = 0;
  for (const d of [5, 30, 60, 90, 135, 170, -45, -120, -179]) {
    bone('arm').rotation = base + rad(d);
    worstGap = Math.max(worstGap, gap(L));
    worstTurn = Math.max(worstTurn, Math.abs(wrap(heading(hand) - handRest)));
    armTurned = Math.max(armTurned, Math.abs(Math.abs(wrap(heading(arm) - armRest)) - Math.abs(rad(d))));
  }
  say(worstGap < EXACT, 'arm swung through 9 angles to +-179 deg: the wrist never parts', `worst gap ${worstGap.toExponential(2)} px`);
  say(worstTurn < 1e-9, 'HINGE, not rigid: the hand keeps its own angle while the arm swings',
    `worst hand turn ${deg(worstTurn).toExponential(2)} deg (rigid parenting would turn it up to 179 deg)`);
  say(armTurned < 1e-9, 'the anchor (arm) is drawn exactly where its own bone puts it', `worst ${armTurned.toExponential(2)}`);

  // Control: a rigidly PARENTED hand -- T_child = T_parent * T_offset --
  // turns with the arm. The heading test must see that, or it proves nothing.
  bone('arm').rotation = base + rad(90);
  const parentedTurn = Math.abs(wrap(heading(arm) - armRest));
  say(Math.abs(deg(parentedTurn) - 90) < 1e-6, 'control: the heading measure sees a 90 deg turn when one happens',
    `measured ${deg(parentedTurn).toFixed(4)} deg on the arm`);

  // The hand turned on ITS OWN bone pivots at the link, and stays joined.
  bone('arm').rotation = base + rad(40);
  const pinned = linkAt(L, arm.id);
  const hb = bone('hand').rotation;
  let worstPivot = 0;
  let worstOwn = 0;
  for (const d of [20, 75, -60, 150]) {
    bone('hand').rotation = hb + rad(d);
    const at = linkAt(L, hand.id);
    worstPivot = Math.max(worstPivot, Math.hypot(at.x - pinned.x, at.y - pinned.y));
    worstOwn = Math.max(worstOwn, Math.abs(wrap(heading(hand) - handRest - rad(d))));
  }
  say(worstPivot < EXACT, "the hand turned on its own bone pivots AT the link point (joint never moves)",
    `worst link drift ${worstPivot.toExponential(2)} px`);
  say(worstOwn < 1e-9, "and it turns by exactly its own bone's angle", `worst error ${deg(worstOwn).toExponential(2)} deg`);
  bone('hand').rotation = hb;
  bone('arm').rotation = base;

  // Shape: one link is a pure translation of the follower -- nothing bent.
  bone('arm').rotation = base + rad(70);
  const raw = deformVerticesUncorrected(hand.mesh, hand, snapshot());
  const fixed = deformVertices(hand.mesh, hand, snapshot());
  const tx = fixed[0].x - raw[0].x;
  const ty = fixed[0].y - raw[0].y;
  const bent = Math.max(...raw.map((p, i) => Math.hypot(fixed[i].x - p.x - tx, fixed[i].y - p.y - ty)));
  say(bent < 1e-9, "one link moves the follower rigidly: its own shape is untouched", `worst deviation ${bent.toExponential(2)}`);
  bone('arm').rotation = base;
}

// ---------------------------------------------------------------------------
console.log('\nEvery joint type, and physics mid-swing');
{
  for (const type of [JointType.RIGID, JointType.PHYSICS, JointType.PIVOT]) {
    const { arm, hand } = scene();
    bonesStore.setJointType(bone('arm').id, type);
    bonesStore.setJointType(bone('hand').id, type);
    const L = link([arm, hand], { x: 45, y: 70 });
    let worst = 0;
    const base = bone('torso').rotation;
    const armBase = bone('arm').rotation;
    for (let frame = 0; frame < 90; frame++) {
      // The torso rocks and the arm swings -- springs lag, pivots follow.
      bone('torso').rotation = base + 0.4 * Math.sin(frame / 7);
      bone('arm').rotation = armBase + 1.2 * Math.sin(frame / 5);
      bonesStore.stepPhysics(1 / 60);
      worst = Math.max(worst, gap(L));
    }
    say(worst < EXACT, `${type} bones on both layers: 90 frames rocking, the link never parts`, `worst gap ${worst.toExponential(2)} px`);
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
      const g = gap(L);
      worst = Math.max(worst, g);
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
  const armRaw = pointOn({ positions: deformVerticesUncorrected(arm.mesh, arm, snapshot()), uvs: arm.mesh.vertices, triangles: arm.mesh.triangles }, L.members[0].u, L.members[0].v);
  const handRaw = pointOn({ positions: deformVerticesUncorrected(hand.mesh, hand, snapshot()), uvs: hand.mesh.vertices, triangles: hand.mesh.triangles }, L.members[1].u, L.members[1].v);
  const met = linkAt(L, arm.id);
  const mid = { x: (armRaw.x + handRaw.x) / 2, y: (armRaw.y + handRaw.y) / 2 };
  say(gap(L) < EXACT && Math.hypot(met.x - mid.x, met.y - mid.y) < EXACT,
    'SHARED link: both give way and meet exactly halfway', `gap ${gap(L).toExponential(2)}, off midpoint ${Math.hypot(met.x - mid.x, met.y - mid.y).toExponential(2)}`);
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
  // swing the arm and no rigid placement of the hand can satisfy both. The
  // weld takes up exactly the difference, locally.
  const { torso, arm, hand } = scene();
  const wrist = link([arm, hand], { x: 45, y: 70 }, arm.id);
  const side = link([torso, hand], { x: 50, y: 80 }, torso.id);
  bone('arm').rotation += rad(35);
  const g1 = gap(wrist);
  const g2 = gap(side);
  say(g1 < EXACT && g2 < EXACT, 'a layer pulled two incompatible ways: BOTH points still coincide exactly',
    `wrist ${g1.toExponential(2)}, side ${g2.toExponential(2)}`);
  const P = deformVertices(hand.mesh, hand, snapshot());
  const finite = P.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  say(finite, 'and the compromise is finite everywhere');
}

// ---------------------------------------------------------------------------
console.log('\nAn unbound layer, pins, and the Free-Move drag');
{
  const { arm } = scene();
  const patch = layer('Patch', 6, 6, 42, 60, [250, 250, 60]); // unbound, on the forearm
  const L = link([arm, patch], { x: 45, y: 63 });
  say(L.anchorId === arm.id, 'unbound artwork is brought to the rig, never the reverse');
  let worst = 0;
  const base = bone('arm').rotation;
  for (const d of [20, 90, -130]) {
    bone('arm').rotation = base + rad(d);
    worst = Math.max(worst, gap(L));
  }
  say(worst < EXACT, 'an unbound layer rides its link exactly', `worst ${worst.toExponential(2)}`);
  const shift = linkShift(patch);
  say(Math.hypot(shift.x, shift.y) > 1, 'and the full-screen windows (Px Pin, Pierce) see it moved too',
    `shift (${shift.x.toFixed(2)}, ${shift.y.toFixed(2)})`);
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
  for (let frame = 0; frame < 60; frame++) {
    bone('arm').rotation = rad(90) + 1.0 * Math.sin(frame / 6) - Math.PI / 2 + bone('arm').rotation * 0;
    bonesStore.stepPhysics(1 / 60);
    worst = Math.max(worst, gap(L));
  }
  say(worst < EXACT, 'a Px-Pinned hand on a physics bone keeps its link', `worst ${worst.toExponential(2)}`);
}
for (const [label, step] of [['slow (1 px steps)', 1], ['fast (37 px jumps)', 37]]) {
  const { arm, hand } = scene();
  const L = link([arm, hand], { x: 45, y: 70 });
  setTargetLayer(arm.id);
  const b = targetBone();
  const tail = bonesStore.restWorldTail(b);
  beginPoseDrag(b, tail);
  const joint = bonesStore.restWorldHead(b);
  let worst = 0;
  let frames = 0;
  const radius = Math.hypot(tail.x - joint.x, tail.y - joint.y);
  // Sweep the finger round a half circle about the shoulder and back.
  const length = Math.PI * radius;
  const n = Math.max(2, Math.round(length / step));
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i <= n; i++) {
      const a = Math.PI / 2 + (pass === 0 ? 1 : -1) * Math.PI * (i / n) + (pass === 0 ? 0 : Math.PI);
      updatePoseDrag({ x: joint.x + radius * Math.cos(a), y: joint.y + radius * Math.sin(a) });
      worst = Math.max(worst, gap(L));
      frames++;
    }
  }
  endPoseDrag();
  say(worst < EXACT, `Free-Move dragging the ARM, ${label}: the wrist holds on every one of ${frames} frames`, `worst ${worst.toExponential(2)} px`);

  // Now drag the HAND: it swings about the wrist, and its drawn tail follows
  // the finger's direction from the link point.
  setTargetLayer(hand.id);
  const hb = targetBone();
  const handTail = bonesStore.restWorldTail(hb);
  const pivot = linkAt(L, arm.id);
  const handRest = heading(hand);
  beginPoseDrag(hb, handTail);
  worst = 0;
  let aimErr = 0;
  const reach = Math.hypot(handTail.x - pivot.x, handTail.y - pivot.y) + 2;
  const m = Math.max(2, Math.round((Math.PI * reach) / step));
  for (let i = 0; i <= m; i++) {
    const a = Math.PI / 2 + Math.PI * 0.9 * (i / m);
    const finger = { x: pivot.x + reach * Math.cos(a), y: pivot.y + reach * Math.sin(a) };
    updatePoseDrag(finger);
    worst = Math.max(worst, gap(L));
    const at = linkAt(L, hand.id);
    const drift = Math.hypot(at.x - pivot.x, at.y - pivot.y);
    worst = Math.max(worst, drift);
    // The hand's long axis should point at the finger: its heading has
    // turned from straight down to the finger's direction from the wrist
    // (the finger is snapped to the grid, so a few degrees of slack).
    const want = Math.atan2(finger.y - pivot.y, finger.x - pivot.x);
    const got = Math.PI / 2 + wrap(heading(hand) - handRest);
    aimErr = Math.max(aimErr, Math.abs(wrap(want - got)));
  }
  endPoseDrag();
  say(worst < EXACT, `Free-Move dragging the HAND, ${label}: it swings about the wrist, which never moves`, `worst ${worst.toExponential(2)} px`);
  say(deg(aimErr) < 8, `and the hand follows the finger round the hinge`, `worst aim error ${deg(aimErr).toFixed(2)} deg`);
  setTargetLayer(null);
}

// ---------------------------------------------------------------------------
console.log('\nSave, load, undo, delete, crop');
{
  const { torso, arm, hand, cuff } = scene();
  const a = link([arm, hand], { x: 45, y: 70 });
  const b = link([torso, cuff, hand], { x: 50, y: 69 }, null);
  const saved = JSON.parse(JSON.stringify(serializeProject()));
  say(Array.isArray(saved.plinks) && saved.plinks.length === 2, 'links are part of the project file', `${saved.plinks && saved.plinks.length} saved`);
  plinkStore.replaceAll([]);
  partsStore.replaceAll([], null);
  bonesStore.replaceAll([], null);
  await applyProject(saved);
  const back = plinkStore.links;
  const same = back.length === 2 && JSON.stringify(back.map((l) => [l.id, l.anchorId, l.members])) === JSON.stringify([a, b].map((l) => [l.id, l.anchorId, l.members]));
  say(same, 'load restores every link: ids, members, points, anchors');
  bone('arm').rotation += rad(75);
  const g = Math.max(gap(back[0]), gap(back[1]));
  say(g < EXACT, 'and the loaded links hold', `worst ${g.toExponential(2)}`);

  const junk = deserializePLinks([
    null, { id: 5 }, { id: 'x', members: 'no' },
    { id: 'plink_90', members: [{ partId: arm.id, u: 1, v: 2 }, { partId: 'ghost', u: 0, v: 0 }] },
    { id: 'plink_91', members: [{ partId: arm.id, u: 1, v: NaN }, { partId: hand.id, u: 1, v: 1 }] },
    { id: 'plink_92', anchorId: 'ghost', members: [{ partId: arm.id, u: 1, v: 2 }, { partId: arm.id, u: 3, v: 3 }, { partId: hand.id, u: 1, v: 1 }] },
  ], partsStore.parts.map((p) => p.id));
  say(junk.length === 1 && junk[0].members.length === 2 && junk[0].anchorId === null,
    'a damaged file: bad links dropped, missing layers pruned, duplicates merged, bad anchor cleared', JSON.stringify(junk));
}
{
  const { arm, hand, cuff } = scene();
  history.reset();
  let made = null;
  history.run('Add PLink', () => { made = link([arm, hand], { x: 45, y: 70 }); });
  history.run('Add PLink', () => { link([arm, cuff], { x: 45, y: 69 }); });
  say(plinkStore.links.length === 2, 'two links added through history');
  history.undo();
  say(plinkStore.links.length === 1 && plinkStore.links[0].id === made.id, 'undo removes only the last link');
  history.redo();
  say(plinkStore.links.length === 2, 'redo restores it');
  const victim = plinkStore.links[1].id;
  history.run('Delete PLink', () => plinkStore.remove(victim));
  say(plinkStore.links.length === 1 && plinkStore.links[0].id === made.id, 'deleting one link leaves the other untouched');
  history.undo();
  say(plinkStore.links.length === 2, 'and deleting is undoable');
}
{
  const { torso, arm, hand, cuff } = scene();
  link([arm, hand], { x: 45, y: 70 });
  link([torso, cuff], { x: 52, y: 69 });
  link([arm, hand, cuff], { x: 45, y: 69 });
  partsStore.remove(hand.id);
  const left = plinkStore.links.map((l) => l.members.length);
  say(plinkStore.links.length === 2 && left.includes(2) && !plinkStore.links.some((l) => l.members.some((m) => m.partId === hand.id)),
    "deleting a layer ends ITS links only (a 3-way link keeps its other two)", `left: ${JSON.stringify(left)}`);
}
{
  const { arm, hand } = scene();
  const L = link([arm, hand], { x: 45, y: 70 });
  const before = { ...L.members[0] };
  plinkStore.shiftAnchors(arm.id, -2, -3);
  const after = plinkStore.byId(L.id).members[0];
  say(after.u === before.u - 2 && after.v === before.v - 3 && plinkStore.byId(L.id).members[1].u === L.members[1].u,
    "a cropped layer's link point moves with the crop, and only that layer's");
}

console.log(`\n${passed}/${total} passed`);
if (passed !== total) process.exit(1);
