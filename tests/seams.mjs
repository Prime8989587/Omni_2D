// Joint seams: two layers that meet at a joint must stay joined there.
//
// The regression guard for the layer-detachment bug. The earlier joint-gap
// test measured the BONE's joint -- which never moved -- and so passed while
// the artwork on either side of it came apart by 9.45px. Everything here is
// measured on the ARTWORK instead: pairs of texels that touch at rest, one
// on each side of the seam, pushed through exactly the geometry the renderer
// draws (skinning, snapping, the rasterizer's barycentric mapping), and asked
// how far apart they land. At rest that is 1px. A gap is anything more.
//
// It also checks that the test can SEE a gap, by measuring the same arm with
// the seams taken away -- a guard that passes whatever the code does is the
// exact failure this file exists to replace.

import { Part, partsStore } from '../www/js/parts.js';
import { bonesStore } from '../www/js/bones.js';
import {
  bindPart, deformVertices, deformVerticesSnapped, autoWeightOneVertex, seamDensity, localToWorld,
  defaultDensity,
} from '../www/js/mesh.js';
import { transferWeights } from '../www/js/meshedit.js';
import { serializeProject, applyProject } from '../www/js/project.js';
import { rasterizeTriangle } from '../www/js/raster.js';

let passed = 0;
let total = 0;
const say = (ok, name, detail = '') => {
  total++;
  if (ok) passed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}`);
  if (detail) console.log(`          ${detail}`);
};

// ---------------------------------------------------------------------------
// A layered arm, cut the way character art is cut: separate layers meeting
// edge to edge at their joints, each with its own "Controls layer" bone.

function solid(width, height, rgb) {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    pixels[i * 4] = rgb[0]; pixels[i * 4 + 1] = rgb[1]; pixels[i * 4 + 2] = rgb[2]; pixels[i * 4 + 3] = 255;
  }
  return pixels;
}

function layer(name, width, height, x, y, rgb) {
  const part = new Part({ name, pixels: solid(width, height, rgb), width, height, x, y });
  partsStore.add(part);
  return part;
}

// `controls: false` leaves every layer to auto-weighting (no "Controls
// layer" bone), the case seams still serve.
function buildArm(rule, { controls = true } = {}) {
  partsStore.replaceAll([], null);
  bonesStore.replaceAll([], null);
  const torso = layer('Torso', 28, 38, 50, 30, [44, 96, 206]);
  const upper = layer('UpperArm', 10, 23, 42, 33, [82, 132, 236]);
  const fore = layer('Forearm', 10, 22, 42, 56, [28, 66, 158]);
  const hand = layer('Hand', 10, 11, 42, 78, [238, 182, 150]);
  const add = (name, parent, head, tail) => bonesStore.addBone({
    parentId: parent ? bonesStore.bones.find((b) => b.name === parent).id : null, head, tail, name,
  });
  add('torso', null, { x: 64.5, y: 31.5 }, { x: 64.5, y: 66.5 });
  add('upper', 'torso', { x: 46.5, y: 34.5 }, { x: 46.5, y: 55.5 });
  add('fore', 'upper', { x: 46.5, y: 55.5 }, { x: 46.5, y: 77.5 });
  add('hand', 'fore', { x: 46.5, y: 77.5 }, { x: 46.5, y: 87.5 });
  const bone = (n) => bonesStore.bones.find((b) => b.name === n);
  if (controls) {
    bonesStore.setAttachedPart(bone('torso').id, torso.id);
    bonesStore.setAttachedPart(bone('upper').id, upper.id);
    bonesStore.setAttachedPart(bone('fore').id, fore.id);
    bonesStore.setAttachedPart(bone('hand').id, hand.id);
  }
  for (const part of [torso, upper, fore, hand]) bindPart(part, bonesStore, undefined, rule);
  return { torso, upper, fore, hand, bone };
}

// Where every opaque texel of a layer lands, through the renderer's own
// geometry: snapped deformed vertices, barycentric in UV space.
function landings(part, transforms) {
  const P = deformVerticesSnapped(part.mesh, part, transforms);
  const V = part.mesh.vertices;
  const T = part.mesh.triangles;
  const W = part.naturalWidth;
  const out = new Map();
  for (let t = 0; t < T.length; t += 3) {
    const a = V[T[t]], b = V[T[t + 1]], c = V[T[t + 2]];
    const den = (b.v - c.v) * (a.u - c.u) + (c.u - b.u) * (a.v - c.v);
    if (Math.abs(den) < 1e-12) continue;
    for (let y = Math.floor(Math.min(a.v, b.v, c.v)); y <= Math.ceil(Math.max(a.v, b.v, c.v)); y++) {
      for (let x = Math.floor(Math.min(a.u, b.u, c.u)); x <= Math.ceil(Math.max(a.u, b.u, c.u)); x++) {
        if (x < 0 || y < 0 || x >= W || y >= part.naturalHeight) continue;
        const i = y * W + x;
        if (out.has(i)) continue;
        const pu = x + 0.5, pv = y + 0.5;
        const l0 = ((b.v - c.v) * (pu - c.u) + (c.u - b.u) * (pv - c.v)) / den;
        const l1 = ((c.v - a.v) * (pu - c.u) + (a.u - c.u) * (pv - c.v)) / den;
        const l2 = 1 - l0 - l1;
        if (l0 < -1e-9 || l1 < -1e-9 || l2 < -1e-9) continue;
        const p = P[T[t]], q = P[T[t + 1]], r = P[T[t + 2]];
        out.set(i, { x: l0 * p.x + l1 * q.x + l2 * r.x, y: l0 * p.y + l1 * q.y + l2 * r.y });
      }
    }
  }
  return out;
}

// The seam pairs: the parent layer's last row against the child layer's
// first row, column by column (both layers span the same columns here).
function seamPairs(parent, child) {
  const pairs = [];
  for (let u = 0; u < parent.naturalWidth; u++) {
    pairs.push([(parent.naturalHeight - 1) * parent.naturalWidth + u, u]);
  }
  return pairs;
}

function worstSeam(parent, child, transforms) {
  const a = landings(parent, transforms);
  const b = landings(child, transforms);
  let worst = 0;
  for (const [i, j] of seamPairs(parent, child)) {
    const p = a.get(i), q = b.get(j);
    if (!p || !q) continue;
    worst = Math.max(worst, Math.hypot(p.x - q.x, p.y - q.y));
  }
  return worst;
}

// Both layers drawn into one buffer exactly as the renderer draws them
// (parent first, child on top), then: background pixels near the joint that
// are ENCLOSED by artwork. A seam that has opened shows background through
// it; a seam that has merely stretched shows stretched artwork. This is the
// visible definition of a gap.
function holesAtJoint(layers, transforms, joint, radius = 7) {
  const W = 128, H = 128;
  const target = new Uint8ClampedArray(W * H * 4);
  for (const part of layers) {
    const P = deformVerticesSnapped(part.mesh, part, transforms);
    const T = part.mesh.triangles, V = part.mesh.vertices;
    for (let t = 0; t < T.length; t += 3) {
      rasterizeTriangle(target, W, H, part.pixels, part.naturalWidth, part.naturalHeight,
        P[T[t]], P[T[t + 1]], P[T[t + 2]], V[T[t]], V[T[t + 1]], V[T[t + 2]]);
    }
  }
  const art = (i) => target[i * 4 + 3] > 0;
  const outside = new Uint8Array(W * H);
  const stack = [];
  for (let x = 0; x < W; x++) stack.push(x, (H - 1) * W + x);
  for (let y = 0; y < H; y++) stack.push(y * W, y * W + W - 1);
  while (stack.length) {
    const j = stack.pop();
    if (outside[j] || art(j)) continue;
    outside[j] = 1;
    const x = j % W, y = (j - x) / W;
    if (x > 0) stack.push(j - 1);
    if (x < W - 1) stack.push(j + 1);
    if (y > 0) stack.push(j - W);
    if (y < H - 1) stack.push(j + W);
  }
  let holes = 0;
  for (let i = 0; i < W * H; i++) {
    if (art(i) || outside[i]) continue;
    const x = i % W, y = (i - x) / W;
    if (Math.hypot(x + 0.5 - joint.x, y + 0.5 - joint.y) <= radius) holes++;
  }
  return holes;
}

// THE VISIBLE GAP: for every pair of texels that touch at rest across the
// seam, walk the straight line between where the two land now, over both
// layers drawn exactly as the renderer draws them. Stretched artwork covers
// that line; a seam that has opened shows background on it -- whether the
// opening is an enclosed hole or a notch open to the outside, which an
// enclosed-hole count alone cannot see.
function gappedPairs(parent, child, transforms) {
  const W = 128, H = 128;
  const target = new Uint8ClampedArray(W * H * 4);
  for (const part of [parent, child]) {
    const P = deformVerticesSnapped(part.mesh, part, transforms);
    const T = part.mesh.triangles, V = part.mesh.vertices;
    for (let t = 0; t < T.length; t += 3) {
      rasterizeTriangle(target, W, H, part.pixels, part.naturalWidth, part.naturalHeight,
        P[T[t]], P[T[t + 1]], P[T[t + 2]], V[T[t]], V[T[t + 1]], V[T[t + 2]]);
    }
  }
  const a = landings(parent, transforms);
  const b = landings(child, transforms);
  let gapped = 0;
  // Interior columns only. At the limb's two outer edges the pair straddles
  // the silhouette's own outline, and at a hard fold the line between them
  // cuts across the concave corner OUTSIDE the arm -- measured, both layers
  // still touch there on every row. A real opening is a wedge that runs in
  // from the edge, so it gaps interior pairs too: the control below, with
  // the seams stripped out, still shows half the interior pairs gapped.
  const pairs = seamPairs(parent, child).filter(([, j]) => j > 0 && j < child.naturalWidth - 1);
  for (const [i, j] of pairs) {
    const p = a.get(i), q = b.get(j);
    if (!p || !q) continue;
    // A background pixel counts only where the line passes through its
    // MIDDLE. Two neighbouring edge texels on a diagonal staircase are
    // joined by a line that clips the corner of the empty pixel beside the
    // step -- that is the silhouette's own outline, not a gap.
    const steps = Math.max(2, Math.ceil(Math.hypot(q.x - p.x, q.y - p.y) * 8));
    for (let k = 0; k <= steps; k++) {
      const sx = p.x + ((q.x - p.x) * k) / steps;
      const sy = p.y + ((q.y - p.y) * k) / steps;
      const x = Math.floor(sx), y = Math.floor(sy);
      if (Math.hypot(sx - (x + 0.5), sy - (y + 0.5)) > 0.35) continue;
      if (x < 0 || y < 0 || x >= W || y >= H || target[(y * W + x) * 4 + 3] === 0) {
        gapped++;
        if (process.env.SEAM_DEBUG) console.log('          gap pair', i, j, 'at', x, y, 'p', p, 'q', q);
        break;
      }
    }
  }
  return gapped;
}

function setAngle(bone, degrees) {
  bone.rotation = (degrees * Math.PI) / 180;
}

const names = (weights) => Object.keys(weights).map((id) => bonesStore.byId(id).name).sort().join('+');

// ---------------------------------------------------------------------------
console.log('A layer with its own bone moves with that bone alone');

// How far a layer's DRAWN geometry (snapped, exactly as rendered) has moved
// from where it is drawn at rest.
function travel(part, transforms, rest) {
  const now = deformVerticesSnapped(part.mesh, part, transforms);
  return Math.max(0, ...now.map((p, i) => Math.hypot(p.x - rest[i].x, p.y - rest[i].y)));
}

function swingWorst(child, parents, bone) {
  const rest = parents.map((p) => deformVerticesSnapped(p.mesh, p, bonesStore.snapshotTransforms()));
  let worst = 0;
  for (let deg = -150; deg <= 150; deg += 10) {
    setAngle(bone(child), deg);
    const transforms = bonesStore.snapshotTransforms();
    parents.forEach((p, k) => { worst = Math.max(worst, travel(p, transforms, rest[k])); });
  }
  setAngle(bone(child), 0);
  return worst;
}

// How far any vertex of a layer is from where its own bone ALONE carries it
// (a rigid turn about the bone's head), over a full swing of that bone. 0 is
// a layer that follows its bone exactly; anything else is part of it held
// back by some other bone.
function lagBehind(part, boneName, bone) {
  const b = bone(boneName);
  const rest = deformVertices(part.mesh, part, bonesStore.snapshotTransforms());
  const head0 = bonesStore.worldHead(b);
  const rot0 = bonesStore.worldRotation(b);
  let worst = 0;
  for (let deg = -150; deg <= 150; deg += 10) {
    setAngle(b, deg);
    const now = deformVertices(part.mesh, part, bonesStore.snapshotTransforms());
    const head = bonesStore.worldHead(b);
    const d = bonesStore.worldRotation(b) - rot0, c = Math.cos(d), s = Math.sin(d);
    rest.forEach((p, i) => {
      const x = c * (p.x - head0.x) - s * (p.y - head0.y) + head.x;
      const y = s * (p.x - head0.x) + c * (p.y - head0.y) + head.y;
      worst = Math.max(worst, Math.hypot(now[i].x - x, now[i].y - y));
    });
  }
  setAngle(b, 0);
  return worst;
}

{
  const { torso, upper, fore, hand, bone } = buildArm();
  const own = { Torso: 'torso', UpperArm: 'upper', Forearm: 'fore', Hand: 'hand' };
  let foreign = 0;
  for (const part of [torso, upper, fore, hand]) {
    for (const v of part.mesh.vertices) if (names(v.weights) !== own[part.name]) foreign++;
  }
  say(foreign === 0 && [torso, upper, fore, hand].every((p) => p.mesh.joints.length === 0),
    'every vertex of every layer is 100% the bone that controls it; no seam reaches across into it',
    `${foreign} vertices on another bone`);

  // The 2.7.1 report: swinging a child moved its parent's artwork.
  const cases = [
    ['fore', [upper, torso], 'swinging the forearm moves neither the UpperArm nor the Torso layer'],
    ['hand', [fore, upper, torso], 'swinging the hand moves neither the Forearm, UpperArm nor Torso layer'],
    ['upper', [torso], 'swinging the upper arm leaves the Torso layer where it is'],
  ];
  for (const [child, parents, label] of cases) {
    const worst = swingWorst(child, parents, bone);
    say(worst === 0, label, `worst ${worst.toFixed(3)}px over -150..150 degrees`);
  }

  // The 2.7.2 report: the forearm's elbow end stayed behind on the shoulder.
  // A layer turns rigidly about its own bone's head -- the elbow point it
  // hangs from -- every vertex exactly where that bone alone puts it.
  const foreLag = lagBehind(fore, 'fore', bone);
  const handLag = lagBehind(hand, 'hand', bone);
  say(foreLag < 1e-9 && handLag < 1e-9,
    'the Forearm and Hand layers follow their own bones exactly, all of them, swung -150..150 degrees',
    `worst ${Math.max(foreLag, handLag).toExponential(2)}px from the bone's own turn`);
}

{
  // The user's art: an elbow CAP drawn on the Forearm layer, reaching past
  // the joint over the end of the upper arm. Rules 1 and 2 handed that cap
  // to the upper arm bone (it lies on the parent's side of the joint line),
  // so it stayed on the shoulder while the forearm swung away.
  const capArm = (rule) => {
    const built = buildArm(rule);
    partsStore.remove?.(built.fore.id);
    const cap = layer('ForearmCap', 10, 28, 42, 50, [28, 66, 158]);
    bonesStore.setAttachedPart(built.bone('fore').id, cap.id);
    bindPart(cap, bonesStore, undefined, rule);
    return { ...built, cap };
  };
  const now = capArm();
  const lag = lagBehind(now.cap, 'fore', now.bone);
  say(lag < 1e-9, 'a Forearm layer with an elbow cap drawn past the joint swings as one piece, cap included',
    `worst ${lag.toExponential(2)}px`);
  // Each measured before the next is built: building replaces the stores.
  const v1 = capArm(1);
  const lag1 = lagBehind(v1.cap, 'fore', v1.bone);
  const v2 = capArm(2);
  const lag2 = lagBehind(v2.cap, 'fore', v2.bone);
  say(lag1 > 3 && lag2 > 3, 'bound by the old rules, the same cap is held back by the upper arm (the test is not blind)',
    `rule 1 ${lag1.toFixed(2)}px, rule 2 ${lag2.toFixed(2)}px`);
}

{
  // THE GUARD CAN SEE THE 2.7.1 BUG: bound by rule 1, the forearm swing moves
  // the UpperArm layer, measured by the same function.
  const { upper, fore, bone } = buildArm(1);
  const before = swingWorst('fore', [upper], bone);
  say(before > 1, 'bound by rule 1, the same forearm swing visibly moves the UpperArm layer (the test is not blind)',
    `${before.toFixed(3)}px`);
  const handBefore = swingWorst('hand', [fore], bone);
  say(handBefore > 1, 'and the hand swing moves the Forearm layer', `${handBefore.toFixed(3)}px`);
}

// ---------------------------------------------------------------------------
console.log('Layers left to auto-weighting stay joined where they meet');

{
  // No "Controls layer" bone on any layer: each is weighted by distance over
  // every bone, and the seams keep two layers' art agreeing across a joint.
  const { upper, fore, hand, bone } = buildArm(undefined, { controls: false });
  const wrist = (part) => part.mesh.joints.some((j) => j.parentId === bone('fore').id && j.childId === bone('hand').id);
  say(wrist(fore) && wrist(hand), 'the Forearm and Hand layers both carry the wrist seam',
    `forearm ${fore.mesh.joints.length} seams, hand ${hand.mesh.joints.length}`);

  // ONE RULE: the weights at a point on the seam do not depend on whose
  // artwork is there.
  let worstDiff = 0;
  for (let x = 42.5; x <= 51.5; x += 1) {
    for (const y of [76.5, 77.5, 78.5, 79.5]) {
      const w = { x, y };
      const inHand = autoWeightOneVertex(hand.mesh, hand, { x: w.x - hand.centerX, y: w.y - hand.centerY });
      const inFore = autoWeightOneVertex(fore.mesh, fore, { x: w.x - fore.centerX, y: w.y - fore.centerY });
      for (const id of new Set([...Object.keys(inHand), ...Object.keys(inFore)])) {
        worstDiff = Math.max(worstDiff, Math.abs((inHand[id] || 0) - (inFore[id] || 0)));
      }
    }
  }
  say(worstDiff < 1e-12, 'every point on the wrist seam is weighted identically by the Hand and Forearm layers',
    `worst difference ${worstDiff.toExponential(2)}`);

  const onLine = autoWeightOneVertex(hand.mesh, hand, { x: 46.5 - hand.centerX, y: 77.5 - hand.centerY });
  const handShare = onLine[bone('hand').id] || 0;
  say(Math.abs(handShare - 0.5) < 1e-9, 'on the joint line itself the split is exactly 50/50',
    `hand ${handShare.toFixed(6)}`);

  // The audit's boundary rule still holds: nothing reaches beyond the bones
  // jointed to a vertex's own.
  const allowed = { Forearm: ['fore', 'upper', 'hand'], Hand: ['hand', 'fore', 'upper'] };
  let stray = 0, badSum = 0;
  for (const part of [fore, hand]) {
    for (const v of part.mesh.vertices) {
      const sum = Object.values(v.weights).reduce((s, w) => s + w, 0);
      if (Math.abs(sum - 1) > 1e-9) badSum++;
      for (const id of Object.keys(v.weights)) if (!allowed[part.name].includes(bonesStore.byId(id).name)) stray++;
    }
  }
  say(stray === 0 && badSum === 0, 'every weight is on the bone a vertex sits on or one jointed to it, summing to 1',
    `stray ${stray}, bad sums ${badSum}`);

  // THE SWING: a wrist bent through the range a Free-Move drag reaches,
  // both ways. Under 2px means at most one stretched pixel between texels
  // that touched -- the outside of a hard bend stretches, as skin does.
  let worst = 0, worstAt = 0, holes = 0, holesAt = null;
  for (let deg = -150; deg <= 150; deg += 5) {
    setAngle(bone('hand'), deg);
    const transforms = bonesStore.snapshotTransforms();
    const s = worstSeam(fore, hand, transforms);
    if (s > worst) { worst = s; worstAt = deg; }
    const h = gappedPairs(fore, hand, transforms);
    if (h > holes) { holes = h; holesAt = deg; }
  }
  setAngle(bone('hand'), 0);
  say(worst < 2, 'swung -150..150 degrees, cuff and wrist texels that touch at rest never land 2px apart',
    `worst ${worst.toFixed(2)}px at ${worstAt} degrees`);
  say(holes === 0, 'and no background shows between them at any of those 61 angles',
    holes ? `${holes} of 8 interior pairs gapped at ${holesAt} degrees` : '');

  let worstElbow = 0, elbowHoles = 0;
  for (let deg = -150; deg <= 150; deg += 10) {
    setAngle(bone('fore'), deg);
    const transforms = bonesStore.snapshotTransforms();
    worstElbow = Math.max(worstElbow, worstSeam(upper, fore, transforms));
    elbowHoles = Math.max(elbowHoles, gappedPairs(upper, fore, transforms));
  }
  setAngle(bone('fore'), 0);
  say(worstElbow < 2 && elbowHoles === 0, 'the elbow seam holds the same way when the forearm swings',
    `worst ${worstElbow.toFixed(2)}px, ${elbowHoles} pairs gapped`);

  // THE GUARD CAN SEE A GAP: the same layers, each 100% its nearest bone and
  // no seams, through the same measure.
  for (const [part, name] of [[fore, 'fore'], [hand, 'hand']]) {
    for (const v of part.mesh.vertices) v.weights = { [bone(name).id]: 1 };
    part.mesh.joints = [];
  }
  setAngle(bone('hand'), 90);
  const unseamed = worstSeam(fore, hand, bonesStore.snapshotTransforms());
  let unseamedHoles = 0;
  for (let deg = -150; deg <= 150; deg += 5) {
    setAngle(bone('hand'), deg);
    unseamedHoles = Math.max(unseamedHoles, gappedPairs(fore, hand, bonesStore.snapshotTransforms()));
  }
  setAngle(bone('hand'), 0);
  say(unseamed > 5, 'with the seams removed the same measure reports the gap (the test is not blind)',
    `${unseamed.toFixed(2)}px at 90 degrees`);
  say(unseamedHoles > 0, 'and the gap check sees background between them',
    `${unseamedHoles} of 8 interior pairs gapped at worst`);
}

{
  // One layer holding a whole arm, all three bones controlling it: it bends
  // smoothly at the elbow rather than shearing.
  partsStore.replaceAll([], null);
  bonesStore.replaceAll([], null);
  const arm = layer('Arm', 10, 56, 42, 33, [82, 132, 236]);
  const add = (name, parent, head, tail) => bonesStore.addBone({
    parentId: parent ? bonesStore.bones.find((b) => b.name === parent).id : null, head, tail, name,
  });
  add('upper', null, { x: 46.5, y: 34.5 }, { x: 46.5, y: 55.5 });
  add('fore', 'upper', { x: 46.5, y: 55.5 }, { x: 46.5, y: 77.5 });
  add('hand', 'fore', { x: 46.5, y: 77.5 }, { x: 46.5, y: 87.5 });
  const bone = (n) => bonesStore.bones.find((b) => b.name === n);
  for (const n of ['upper', 'fore', 'hand']) bonesStore.setAttachedPart(bone(n).id, arm.id);
  bindPart(arm, bonesStore);
  setAngle(bone('fore'), 90);
  const bent = deformVertices(arm.mesh, arm, bonesStore.snapshotTransforms());
  setAngle(bone('fore'), 0);
  let longest = 0;
  const T = arm.mesh.triangles;
  for (let t = 0; t < T.length; t += 3) {
    for (const [a, b] of [[T[t], T[t + 1]], [T[t + 1], T[t + 2]], [T[t + 2], T[t]]]) {
      const restLen = Math.hypot(arm.mesh.vertices[a].restLocal.x - arm.mesh.vertices[b].restLocal.x,
        arm.mesh.vertices[a].restLocal.y - arm.mesh.vertices[b].restLocal.y);
      longest = Math.max(longest, Math.hypot(bent[a].x - bent[b].x, bent[a].y - bent[b].y) / restLen);
    }
  }
  say(arm.mesh.joints.length > 0 && longest < 2.5,
    'one layer controlled by the whole arm keeps its elbow seam and bends 90 degrees without shearing',
    `${arm.mesh.joints.length} seams, worst stretch ${longest.toFixed(2)}x`);
}

// ---------------------------------------------------------------------------
console.log('A rig bound by an older rule is brought up to date on load');

for (const rule of [1, 2]) {
  // A rig from before: bound by that rule, saved with its stamp (2.7.1) or
  // none (2.7.0 and older), and one vertex someone painted by hand.
  const { upper, bone } = buildArm(rule);
  const painted = upper.mesh.vertices.reduce((best, v, i) => {
    const y = localToWorld(upper, v.restLocal).y;
    return y > localToWorld(upper, upper.mesh.vertices[best].restLocal).y ? i : best;
  }, 0);
  const upperId = bone('upper').id, foreId = bone('fore').id;
  upper.mesh.vertices[painted].weights = { [upperId]: 0.7, [foreId]: 0.3 };
  const data = JSON.parse(JSON.stringify(serializeProject()));
  for (const p of data.parts) if (p.mesh) { if (rule === 1) delete p.mesh.weightRule; else p.mesh.weightRule = 2; }
  applyProject(data);
  const U = partsStore.parts.find((p) => p.name === 'UpperArm');
  const F = partsStore.parts.find((p) => p.name === 'Forearm');
  const H = partsStore.parts.find((p) => p.name === 'Hand');
  const tag = rule === 1 ? 'a 2.7.0 rig (rule 1)' : 'a 2.7.1 rig (rule 2)';
  say([U, F, H].every((p) => p.mesh.weightRule === 3), `${tag}: every mesh is stamped with the current rule once loaded`);
  const kept = U.mesh.vertices[painted].weights;
  say(Math.abs(kept[upperId] - 0.7) < 1e-12 && Math.abs(kept[foreId] - 0.3) < 1e-12,
    `${tag}: the hand-painted vertex is kept exactly as painted`, JSON.stringify(Object.values(kept).map((w) => +w.toFixed(3))));
  let off = 0;
  for (const part of [U, F, H]) {
    part.mesh.vertices.forEach((v, i) => {
      if (part === U && i === painted) return;
      const fresh = autoWeightOneVertex(part.mesh, part, v.restLocal);
      for (const id of new Set([...Object.keys(fresh), ...Object.keys(v.weights)])) {
        off = Math.max(off, Math.abs((fresh[id] || 0) - (v.weights[id] || 0)));
      }
    });
  }
  say(off < 1e-12 && [F, H].every((p) => p.mesh.joints.length === 0),
    `${tag}: every untouched vertex carries exactly what a fresh bind gives, and no seam reaches across`,
    `worst ${off.toExponential(2)}`);
  const foreLag = lagBehind(F, 'fore', bone);
  say(foreLag < 1e-9, `${tag}: after loading, the Forearm layer follows its bone exactly`, `worst ${foreLag.toExponential(2)}px`);
  const rest = deformVerticesSnapped(U.mesh, U, bonesStore.snapshotTransforms());
  let worstOther = 0;
  setAngle(bone('fore'), 60);
  const now = deformVerticesSnapped(U.mesh, U, bonesStore.snapshotTransforms());
  setAngle(bone('fore'), 0);
  now.forEach((p, i) => { if (i !== painted) worstOther = Math.max(worstOther, Math.hypot(p.x - rest[i].x, p.y - rest[i].y)); });
  say(worstOther === 0, `${tag}: and the forearm does not move the upper arm (bar the vertex painted to follow it)`,
    `worst ${worstOther.toFixed(3)}px`);
  const again = JSON.parse(JSON.stringify(serializeProject()));
  say(again.parts.every((p) => !p.mesh || p.mesh.weightRule === 3), `${tag}: it saves with the stamp, so it is migrated only once`);
}

// ---------------------------------------------------------------------------
console.log('Where seams deliberately do not apply');

{
  const { torso } = buildArm(undefined, { controls: false });
  // The upper arm hangs off the SIDE of the torso bone: its head is nowhere
  // near the torso's tail, so there is no seam line to speak of there.
  const shoulder = torso.mesh.joints.find((j) => bonesStore.byId(j.childId).name === 'upper');
  say(!shoulder, 'no seam at a side-attached joint (arm on the torso), where "which side" has no answer');

  // A layer with no artwork near any of its joints gets none.
  const patch = layer('Patch', 6, 6, 44, 38, [200, 40, 40]);
  bindPart(patch, bonesStore);
  say(patch.mesh.joints.length === 0, 'a patch in the middle of the upper arm, far from the elbow, has no seam',
    `${patch.mesh.joints.length} seams`);
}

// ---------------------------------------------------------------------------
console.log('At rest nothing moves, and nothing is redrawn differently');

for (const controls of [false, true]) {
  const { fore, hand } = buildArm(undefined, { controls });
  // Rasterize each layer at rest and compare against a straight copy of its
  // pixels: a freshly bound layer must render identically to the sprite.
  let mismatched = 0, drawn = 0;
  for (const part of [fore, hand]) {
    const W = 128, H = 128;
    const target = new Uint8ClampedArray(W * H * 4);
    const P = deformVerticesSnapped(part.mesh, part, bonesStore.snapshotTransforms());
    const T = part.mesh.triangles, V = part.mesh.vertices;
    for (let t = 0; t < T.length; t += 3) {
      rasterizeTriangle(target, W, H, part.pixels, part.naturalWidth, part.naturalHeight,
        P[T[t]], P[T[t + 1]], P[T[t + 2]], V[T[t]], V[T[t + 1]], V[T[t + 2]]);
    }
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const inside = x >= part.x && y >= part.y && x < part.x + part.naturalWidth && y < part.y + part.naturalHeight;
        const alpha = target[(y * W + x) * 4 + 3];
        if (alpha) drawn++;
        if (Boolean(alpha) !== inside) mismatched++;
      }
    }
  }
  say(mismatched === 0, `a freshly bound layer (${controls ? 'its own bone' : 'with seams'}) renders pixel-identically to its sprite at rest`,
    `${drawn} pixels drawn, ${mismatched} out of place`);
}

// ---------------------------------------------------------------------------
console.log('Every path keeps the seams');

{
  const { fore, hand, bone } = buildArm(undefined, { controls: false });
  // Mesh Trim's Add weighs a new vertex by the same rule as binding did.
  let worst = 0;
  for (const part of [fore, hand]) {
    for (const v of part.mesh.vertices) {
      const again = autoWeightOneVertex(part.mesh, part, v.restLocal);
      for (const id of new Set([...Object.keys(again), ...Object.keys(v.weights)])) {
        worst = Math.max(worst, Math.abs((again[id] || 0) - (v.weights[id] || 0)));
      }
    }
  }
  say(worst < 1e-12, 'a vertex added by Mesh Trim anywhere is weighted exactly as binding weighted that spot',
    `worst difference ${worst.toExponential(2)}`);

  // Mesh Trim's rebuild carries the seams with the bind pose.
  const rebuilt = { vertices: hand.mesh.vertices.map((v) => ({ ...v, weights: {} })), triangles: hand.mesh.triangles };
  transferWeights(hand.mesh, rebuilt);
  say(Array.isArray(rebuilt.joints) && rebuilt.joints.length === hand.mesh.joints.length && rebuilt.weightRule === 3,
    'a Mesh Trim rebuild keeps the layer\'s seams and its rule', `${(rebuilt.joints || []).length} seams`);

  // Save / load and undo both go through the project serializer.
  setAngle(bone('hand'), 70);
  const before = [fore, hand].map((p) => deformVertices(p.mesh, p, bonesStore.snapshotTransforms()));
  const seams = hand.mesh.joints.length;
  const data = JSON.parse(JSON.stringify(serializeProject()));
  applyProject(data);
  const reFore = partsStore.parts.find((p) => p.name === 'Forearm');
  const reHand = partsStore.parts.find((p) => p.name === 'Hand');
  const after = [reFore, reHand].map((p) => deformVertices(p.mesh, p, bonesStore.snapshotTransforms()));
  let drift = 0;
  before.forEach((list, k) => list.forEach((p, i) => { drift = Math.max(drift, Math.hypot(p.x - after[k][i].x, p.y - after[k][i].y)); }));
  say(seams > 0 && reHand.mesh.joints.length === seams, 'a saved project reloads with its seams', `${seams} seams`);
  // Loading renormalizes every weight set (sanitizeWeights), which can move
  // a three-bone sum by an ulp: exact to floating point, not to the bit.
  say(drift < 1e-9, 'and deforms exactly as it did before saving', `worst drift ${drift.toExponential(2)}px`);

  // A project saved before seams existed loads with none, unchanged.
  for (const p of data.parts) { if (p.mesh) { delete p.mesh.joints; } }
  applyProject(data);
  const legacy = partsStore.parts.find((p) => p.name === 'Hand');
  say(Array.isArray(legacy.mesh.joints) && legacy.mesh.joints.length === 0,
    'an older project (no seams recorded) loads with none rather than failing');

  // A corrupt seam is refused rather than put NaN into the weights.
  const bad = JSON.parse(JSON.stringify(serializeProject()));
  const handData = bad.parts.find((p) => p.name === 'Hand');
  handData.mesh.joints = [{ ...data.parts.find((p) => p.name === 'Hand').mesh.joints?.[0], band: 'lots' }, null, { parentId: 7 }];
  applyProject(bad);
  say(partsStore.parts.find((p) => p.name === 'Hand').mesh.joints.length === 0,
    'malformed seams in a file are dropped, not trusted');
}

// ---------------------------------------------------------------------------
console.log('A spring bone on the far side of a seam');

{
  const { fore, hand, bone } = buildArm(undefined, { controls: false });
  // The hand is a spring bone. The Forearm layer takes it through the wrist
  // seam -- and must read it LIVE, as the Hand layer does, or the two sides
  // of the seam sit on two poses.
  const handBone = bone('hand');
  bonesStore.setJointType(handBone.id, 'physics');
  handBone.simWorldRotation = bonesStore.targetWorldRotation(handBone) + (80 * Math.PI) / 180;
  const transforms = bonesStore.snapshotTransforms();
  const worst = worstSeam(fore, hand, transforms);
  say(worst < 2 && gappedPairs(fore, hand, transforms) === 0,
    'a spring hand swung 80 degrees off its target keeps the wrist seam closed',
    `worst ${worst.toFixed(2)}px`);
  bonesStore.setJointType(handBone.id, 'rigid');
}

// ---------------------------------------------------------------------------
console.log('A mesh too coarse to hold its seams is refined');

{
  partsStore.replaceAll([], null);
  bonesStore.replaceAll([], null);
  // One layer holding a whole sleeve, like a jacket: long, with the wrist
  // seam near its end. Its default density leaves cells wider than the band.
  const sleeve = layer('Sleeve', 12, 56, 40, 20, [44, 96, 206]);
  const add = (name, parent, head, tail) => bonesStore.addBone({
    parentId: parent ? bonesStore.bones.find((b) => b.name === parent).id : null, head, tail, name,
  });
  add('fore', null, { x: 46.5, y: 20.5 }, { x: 46.5, y: 66.5 });
  add('hand', 'fore', { x: 46.5, y: 66.5 }, { x: 46.5, y: 76.5 });
  const needed = seamDensity(sleeve, bonesStore);
  say(needed > defaultDensity(sleeve), 'the seam needs a finer mesh than the default',
    `default ${defaultDensity(sleeve)}, needed ${needed}`);
  bindPart(sleeve, bonesStore);
  say(sleeve.mesh.density === needed, 'and binding builds it at that density', `built at ${sleeve.mesh.density}`);
  bindPart(sleeve, bonesStore, 16);
  say(sleeve.mesh.density === 16, 'an explicitly finer density is kept, never lowered');

  const plain = layer('Plain', 12, 12, 90, 90, [200, 40, 40]);
  say(seamDensity(plain, bonesStore) <= defaultDensity(plain),
    'a layer with no artwork on a seam is left at its default');
}

console.log(`\n${passed}/${total} checks passed`);
process.exit(passed === total ? 0 : 1);
