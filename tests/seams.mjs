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

function buildArm() {
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
  bonesStore.setAttachedPart(bone('torso').id, torso.id);
  bonesStore.setAttachedPart(bone('upper').id, upper.id);
  bonesStore.setAttachedPart(bone('fore').id, fore.id);
  bonesStore.setAttachedPart(bone('hand').id, hand.id);
  for (const part of [torso, upper, fore, hand]) bindPart(part, bonesStore);
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
console.log('Joint seams: the arm stays joined where its layers meet');

{
  const { upper, fore, hand, bone } = buildArm();
  say(fore.mesh.joints.length === 2 && hand.mesh.joints.length === 1,
    'the forearm layer sits on two seams (elbow, wrist); the hand on one (wrist)',
    `forearm ${fore.mesh.joints.length}, hand ${hand.mesh.joints.length}`);

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

  // The weights at the joint line itself are an even split.
  const onLine = autoWeightOneVertex(hand.mesh, hand, { x: 46.5 - hand.centerX, y: 77.5 - hand.centerY });
  const handShare = onLine[bone('hand').id] || 0;
  say(Math.abs(handShare - 0.5) < 1e-9, 'on the joint line itself the split is exactly 50/50',
    `hand ${handShare.toFixed(6)}`);

  // Beyond the band, each layer is exactly its own bone -- rigid.
  const band = hand.mesh.joints[0].band;
  const handFar = hand.mesh.vertices.filter((v) => localToWorld(hand, v.restLocal).y > 77.5 + band + 1e-9);
  say(handFar.length > 0 && handFar.every((v) => names(v.weights) === 'hand'),
    'hand vertices beyond the seam band are 100% hand bone', `${handFar.length} vertices`);
  const foreMid = fore.mesh.vertices.filter((v) => {
    const y = localToWorld(fore, v.restLocal).y;
    return y > 55.5 + fore.mesh.joints[0].band + 1e-9 && y < 77.5 - band - 1e-9;
  });
  say(foreMid.length > 0 && foreMid.every((v) => names(v.weights) === 'fore'),
    'forearm vertices between its two seams are 100% forearm bone', `${foreMid.length} vertices`);

  // The audit's boundary rule still holds: nothing reaches beyond the bones
  // jointed to a layer's own.
  const allowed = { Forearm: ['fore', 'upper', 'hand'], Hand: ['hand', 'fore'] };
  let stray = 0, badSum = 0;
  for (const part of [fore, hand]) {
    for (const v of part.mesh.vertices) {
      const sum = Object.values(v.weights).reduce((s, w) => s + w, 0);
      if (Math.abs(sum - 1) > 1e-9) badSum++;
      for (const id of Object.keys(v.weights)) if (!allowed[part.name].includes(bonesStore.byId(id).name)) stray++;
    }
  }
  say(stray === 0 && badSum === 0, 'every weight is on the layer\'s own bone or one jointed to it, summing to 1',
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

  // And the elbow, with the whole forearm (hand riding along) swinging.
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

  // THE GUARD CAN SEE A GAP. Same arm, same swing, seams stripped out: the
  // layers go back to 100% their own bone, and the measure has to show it.
  for (const part of [fore, hand]) {
    const own = bonesStore.bonesAttachedTo(part.id)[0].id;
    for (const v of part.mesh.vertices) v.weights = { [own]: 1 };
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

// ---------------------------------------------------------------------------
console.log('Where seams deliberately do not apply');

{
  const { torso, upper } = buildArm();
  // The upper arm hangs off the SIDE of the torso bone: its head is nowhere
  // near the torso's tail, so there is no seam line to speak of there.
  const shoulder = torso.mesh.joints.find((j) => bonesStore.byId(j.childId).name === 'upper');
  say(!shoulder, 'no seam at a side-attached joint (arm on the torso), where "which side" has no answer');
  say(torso.mesh.joints.length === 0 && Object.values(torso.mesh.vertices).every((v) => names(v.weights) === 'torso'),
    'so the torso layer stays 100% torso, exactly as it was');
  say(upper.mesh.joints.length === 1 && bonesStore.byId(upper.mesh.joints[0].parentId).name === 'upper',
    'the upper arm carries only its elbow seam');

  // A layer with no artwork near any of its joints gets none.
  const patch = layer('Patch', 6, 6, 44, 63, [200, 40, 40]);
  bonesStore.setAttachedPart(bonesStore.bones.find((b) => b.name === 'fore').id, patch.id);
  bindPart(patch, bonesStore);
  say(patch.mesh.joints.length === 0, 'a patch in the middle of the forearm, far from both joints, has no seam',
    `${patch.mesh.joints.length} seams`);
}

// ---------------------------------------------------------------------------
console.log('At rest nothing moves, and nothing is redrawn differently');

{
  const { fore, hand } = buildArm();
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
  say(mismatched === 0, 'a freshly bound layer with seams renders pixel-identically to its sprite at rest',
    `${drawn} pixels drawn, ${mismatched} out of place`);
}

// ---------------------------------------------------------------------------
console.log('Every path keeps the seams');

{
  const { fore, hand, bone } = buildArm();
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
  say(Array.isArray(rebuilt.joints) && rebuilt.joints.length === hand.mesh.joints.length,
    'a Mesh Trim rebuild keeps the layer\'s seams', `${(rebuilt.joints || []).length} seams`);

  // Save / load and undo both go through the project serializer.
  setAngle(bone('hand'), 70);
  const before = [fore, hand].map((p) => deformVertices(p.mesh, p, bonesStore.snapshotTransforms()));
  const data = JSON.parse(JSON.stringify(serializeProject()));
  applyProject(data);
  const reFore = partsStore.parts.find((p) => p.name === 'Forearm');
  const reHand = partsStore.parts.find((p) => p.name === 'Hand');
  const after = [reFore, reHand].map((p) => deformVertices(p.mesh, p, bonesStore.snapshotTransforms()));
  let drift = 0;
  before.forEach((list, k) => list.forEach((p, i) => { drift = Math.max(drift, Math.hypot(p.x - after[k][i].x, p.y - after[k][i].y)); }));
  say(reHand.mesh.joints.length === 1 && Object.values(reHand.mesh.bindPose).some((p) => p.jointOnly),
    'a saved project reloads with its seams and its seam-only bones marked');
  say(drift === 0, 'and deforms exactly as it did before saving', `worst drift ${drift.toExponential(2)}px`);

  // A project saved before seams existed loads with none, unchanged.
  for (const p of data.parts) { if (p.mesh) { delete p.mesh.joints; } }
  applyProject(data);
  const legacy = partsStore.parts.find((p) => p.name === 'Hand');
  say(Array.isArray(legacy.mesh.joints) && legacy.mesh.joints.length === 0,
    'an older project (no seams recorded) loads with none rather than failing');

  // A corrupt seam is refused rather than put NaN into the weights.
  const bad = JSON.parse(JSON.stringify(serializeProject()));
  const handData = bad.parts.find((p) => p.name === 'Hand');
  handData.mesh.joints = [{ ...handData.mesh.joints?.[0], band: 'lots' }, null, { parentId: 7 }];
  applyProject(bad);
  say(partsStore.parts.find((p) => p.name === 'Hand').mesh.joints.length === 0,
    'malformed seams in a file are dropped, not trusted');
}

// ---------------------------------------------------------------------------
console.log('A spring bone on the far side of a seam');

{
  const { fore, hand, bone } = buildArm();
  // The hand is a spring bone attached to the Hand layer. The Forearm layer
  // takes it only through the wrist seam -- and must read it LIVE, as the
  // Hand layer does, or the two sides of the seam sit on two poses.
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
