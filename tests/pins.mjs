// Px Pin under a hard pull: pinned artwork holds, and its neighbours stay
// attached to it instead of tearing away.
//
// The regression guard for the pin-tearing bug. A pin eases its hold off
// across a transition band, and that band has to absorb the whole difference
// between where the pin holds the artwork and where the bone swings it. It
// was one mesh cell wide, always -- enough at the default spring, not enough
// at a loose one, where a Free-Move throw swung a pinned hair layer 150
// degrees off its rest and the texels either side of the band landed 4-5px
// apart: the hair peeling off its pinned scalp. The band now widens with the
// pull, and stays exactly one cell when there is none.
//
// Measured, as in seams.mjs, on the artwork: texels that touch at rest,
// pushed through the renderer's own geometry, and how far apart they land.

import { Part, partsStore } from '../www/js/parts.js';
import { bonesStore } from '../www/js/bones.js';
import {
  bindPart, deformVertices, deformVerticesSnapped, pinInfluence, pinCarriageOffset, localToWorld,
} from '../www/js/mesh.js';
import { addVertex } from '../www/js/meshedit.js';

let passed = 0;
let total = 0;
const say = (ok, name, detail = '') => {
  total++;
  if (ok) passed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}`);
  if (detail) console.log(`          ${detail}`);
};

// A hair layer on a spring bone, hanging from a rigid body bone.
function buildHair(pinShape) {
  partsStore.replaceAll([], null);
  bonesStore.replaceAll([], null);
  const W = 30, H = 40;
  const pixels = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) pixels.set([196, 40, 176, 255], i * 4);
  const hair = new Part({ name: 'Hair', pixels, width: W, height: H, x: 49, y: 18 });
  partsStore.add(hair);
  bonesStore.addBone({ head: { x: 64.5, y: 30.5 }, tail: { x: 64.5, y: 60.5 }, name: 'body' });
  const body = bonesStore.bones[0];
  bonesStore.addBone({ parentId: body.id, head: { x: 64.5, y: 20.5 }, tail: { x: 64.5, y: 52.5 }, name: 'hair' });
  const bone = bonesStore.bones[1];
  bonesStore.setAttachedPart(bone.id, hair.id);
  bonesStore.setJointType(bone.id, 'physics');
  bindPart(hair, bonesStore);

  const pins = [];
  if (pinShape === 'edge') {
    // A thin stripe down the layer's whole left silhouette edge.
    for (let v = 0; v < H; v++) pins.push(v * W);
  } else {
    // The scalp band: the top seven rows.
    for (let v = 0; v < 7; v++) for (let u = 0; u < W; u++) pins.push(v * W + u);
  }
  partsStore.setPins(hair.id, pins, true);
  return { hair: partsStore.parts[0], bone };
}

// The spring trailing its target by `degrees`, as a throw leaves it.
function lag(bone, degrees) {
  bone.simWorldRotation = bonesStore.targetWorldRotation(bone) + (degrees * Math.PI) / 180;
}

// The pin rule as it was: a fixed one-cell band. Kept here as the control.
function oneCellBand(mesh, part, transforms) {
  const unpinned = Object.create(part);
  unpinned.pins = new Set();
  const out = deformVertices(mesh, unpinned, transforms);
  const influence = pinInfluence(mesh, part);
  const carriage = pinCarriageOffset(part, transforms);
  return out.map((p, i) => {
    const k = influence[i];
    const rest = localToWorld(part, mesh.vertices[i].restLocal);
    return { x: p.x + (rest.x + carriage.x - p.x) * k, y: p.y + (rest.y + carriage.y - p.y) * k };
  });
}

// Where every texel lands through a given set of vertex positions, snapped
// as the renderer snaps them.
function landingsFrom(part, positions) {
  const P = positions.map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) }));
  const V = part.mesh.vertices, T = part.mesh.triangles, W = part.naturalWidth;
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
        const l0 = ((b.v - c.v) * (x + 0.5 - c.u) + (c.u - b.u) * (y + 0.5 - c.v)) / den;
        const l1 = ((c.v - a.v) * (x + 0.5 - c.u) + (a.u - c.u) * (y + 0.5 - c.v)) / den;
        const l2 = 1 - l0 - l1;
        if (l0 < -1e-9 || l1 < -1e-9 || l2 < -1e-9) continue;
        const p = P[T[t]], q = P[T[t + 1]], r = P[T[t + 2]];
        out.set(i, { x: l0 * p.x + l1 * q.x + l2 * r.x, y: l0 * p.y + l1 * q.y + l2 * r.y });
      }
    }
  }
  return out;
}

// Worst distance between two texels that touch at rest -- over the whole
// layer, and over the pairs that straddle a pin's edge.
function worstStretch(part, positions) {
  const land = landingsFrom(part, positions);
  const W = part.naturalWidth, H = part.naturalHeight;
  let anywhere = 0, acrossPin = 0;
  for (let v = 0; v < H; v++) {
    for (let u = 0; u < W; u++) {
      const i = v * W + u;
      for (const j of [u + 1 < W ? i + 1 : -1, v + 1 < H ? i + W : -1]) {
        if (j < 0) continue;
        const p = land.get(i), q = land.get(j);
        if (!p || !q) continue;
        const d = Math.hypot(p.x - q.x, p.y - q.y);
        anywhere = Math.max(anywhere, d);
        if (part.pins.has(i) !== part.pins.has(j)) acrossPin = Math.max(acrossPin, d);
      }
    }
  }
  return { anywhere, acrossPin };
}

// ---------------------------------------------------------------------------
console.log('Under no pull, the pin is exactly what it was');

{
  const { hair, bone } = buildHair('band');
  lag(bone, 2);
  const T = bonesStore.snapshotTransforms();
  const now = deformVertices(hair.mesh, hair, T);
  const was = oneCellBand(hair.mesh, hair, T);
  const diff = Math.max(...now.map((p, i) => Math.hypot(p.x - was[i].x, p.y - was[i].y)));
  say(diff === 0, 'a spring 2 degrees off its target: identical to the fixed one-cell band, to the bit',
    `worst difference ${diff.toExponential(2)}px`);
}

{
  // THE THIN-STRIPE CASE the old fixed widening was reverted over: at rest
  // and under a small pull, exactly as tight as before -- no extra holding.
  const { hair, bone } = buildHair('edge');
  lag(bone, 3);
  const T = bonesStore.snapshotTransforms();
  const now = deformVertices(hair.mesh, hair, T);
  const was = oneCellBand(hair.mesh, hair, T);
  const diff = Math.max(...now.map((p, i) => Math.hypot(p.x - was[i].x, p.y - was[i].y)));
  say(diff === 0, 'a thin pinned stripe down a whole edge is held no more than before under a small pull',
    `worst difference ${diff.toExponential(2)}px`);
}

{
  const { hair } = buildHair('band');
  const base = pinInfluence(hair.mesh, hair);
  const cellW = hair.naturalWidth / hair.mesh.cols;
  const cellH = hair.naturalHeight / hair.mesh.rows;
  const cell = Math.max(cellW, cellH);
  // Pinned rows 0..6 collapse to the whole cells they sit in -- here just
  // the first row of cells -- and every column is pinned, so the distance to
  // the held region is purely vertical.
  const heldRows = new Set([...hair.pins].map((i) => Math.min(hair.mesh.rows - 1, Math.floor(Math.floor(i / hair.naturalWidth) / cellH))));
  const heldBottom = (Math.max(...heldRows) + 1) * cellH;
  const expected = hair.mesh.vertices.map((v) => {
    const vv = v.restLocal.y + hair.naturalHeight / 2;
    const d = Math.max(0, vv - heldBottom);
    const t = Math.max(0, Math.min(1, 1 - d / cell));
    return t * t * (3 - 2 * t);
  });
  const diff = Math.max(...base.map((k, i) => Math.abs(k - expected[i])));
  say(diff < 1e-12, 'the influence the pierce solver masks by is still the one-cell band',
    `worst difference ${diff.toExponential(2)}`);
}

// ---------------------------------------------------------------------------
console.log('Under a hard pull, the pinned edge does not tear');

for (const shape of ['band', 'edge']) {
  const { hair, bone } = buildHair(shape);
  let worstNow = { anywhere: 0, acrossPin: 0 };
  let worstWas = { anywhere: 0, acrossPin: 0 };
  let drift = 0;
  for (const degrees of [30, 60, 90, 120, 150, -60, -120, -150]) {
    lag(bone, degrees);
    const T = bonesStore.snapshotTransforms();
    const now = deformVertices(hair.mesh, hair, T);
    const a = worstStretch(hair, now);
    const b = worstStretch(hair, oneCellBand(hair.mesh, hair, T));
    worstNow = { anywhere: Math.max(worstNow.anywhere, a.anywhere), acrossPin: Math.max(worstNow.acrossPin, a.acrossPin) };
    worstWas = { anywhere: Math.max(worstWas.anywhere, b.anywhere), acrossPin: Math.max(worstWas.acrossPin, b.acrossPin) };
    // The promise of a pin: pinned texels exactly where it holds them.
    const snapped = deformVerticesSnapped(hair.mesh, hair, T);
    const carriage = pinCarriageOffset(hair, T);
    const influence = pinInfluence(hair.mesh, hair);
    hair.mesh.vertices.forEach((v, i) => {
      if (influence[i] < 1) return;
      const r = localToWorld(hair, v.restLocal);
      drift = Math.max(drift, Math.hypot(snapped[i].x - Math.round(r.x + carriage.x), snapped[i].y - Math.round(r.y + carriage.y)));
    });
  }
  const label = shape === 'band' ? 'a pinned scalp band' : 'a pinned edge stripe';
  say(worstWas.anywhere > 3, `${label}, one-cell band (control): texels that touched land far apart -- the tear`,
    `worst ${worstWas.anywhere.toFixed(2)}px`);
  // Under 3px anywhere: at most a stretched pixel or two where a hair
  // bends 150 degrees away from its pins -- continuous, never background.
  // And under 2px across the pin's own edge, which is where the tear was.
  say(worstNow.anywhere < 3 && worstNow.acrossPin < 2,
    `${label}, swung up to 150 degrees each way: nothing lands 3px from a texel it touched, nor 2px across the pin`,
    `worst ${worstNow.anywhere.toFixed(2)}px anywhere, ${worstNow.acrossPin.toFixed(2)}px across the pin's edge`);
  say(drift === 0, `${label}: every fully pinned vertex sits exactly where the pin holds it`, `worst ${drift}px`);
}

// ---------------------------------------------------------------------------
console.log('Editing a pinned mesh');

{
  // Mesh Trim edits the mesh IN PLACE. The pin cache used to be keyed on
  // the pins alone, so a vertex added afterwards read an influence that did
  // not exist and deformed to NaN.
  const { hair, bone } = buildHair('band');
  deformVertices(hair.mesh, hair, bonesStore.snapshotTransforms()); // warm the cache
  const result = addVertex(hair.mesh, hair, 14.5, 20.5, { bonesStore });
  lag(bone, 40);
  const out = deformVertices(hair.mesh, hair, bonesStore.snapshotTransforms());
  say(result.ok !== false && out.length === hair.mesh.vertices.length && out.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)),
    'a vertex added to a pinned layer deforms to a real position, not NaN',
    `${out.length} vertices, ${out.filter((p) => !Number.isFinite(p.x)).length} non-finite`);
}

console.log(`\n${passed}/${total} checks passed`);
process.exit(passed === total ? 0 : 1);
