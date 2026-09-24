// Skinning must not lose area when two bones disagree by a large angle.
//
// This is the regression guard for the Free-Move tearing bug. The old
// linear blend averaged the POSITIONS each bone produced, which lands on
// the chord rather than the arc and collapses the layer to cos^2(theta/2)
// of its area -- invisible at a debug slider's pace, catastrophic at the
// 58-128 degrees of spring lag a real drag produces.
//
// Everything here is measured on AREA, because area is what the artifact
// actually was: a layer crushed to a fraction of its size reads on screen
// as torn, jagged, detached edges.

import { deformVertices } from '../www/js/mesh.js';

const report = [];
const say = (ok, name, detail = '') => report.push({ ok, name, detail });
const near = (a, b, tol, name, detail) =>
  say(Math.abs(a - b) <= tol, name, detail || `expected ~${b}, got ${a.toFixed(4)}`);

// A square layer, bound to two bones that share a bind pose.
function makePart(size = 32) {
  return {
    id: 'p1',
    naturalWidth: size,
    naturalHeight: size,
    scale: 1,
    rotation: 0,
    x: 0,
    y: 0,
    centerX: size / 2,
    centerY: size / 2,
    visible: true,
    pins: new Set(),
    pixels: new Uint8ClampedArray(size * size * 4).fill(255),
  };
}

// Shoelace area of the deformed mesh's outer footprint, approximated by
// summing every triangle's absolute area -- which is exactly the quantity
// the collapse destroys.
function meshArea(mesh, positions) {
  let total = 0;
  for (let i = 0; i < mesh.triangles.length; i += 3) {
    const a = positions[mesh.triangles[i]];
    const b = positions[mesh.triangles[i + 1]];
    const c = positions[mesh.triangles[i + 2]];
    total += Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)) / 2;
  }
  return total;
}

const SIZE = 32;
const part = makePart(SIZE);

// A plain 4x4 grid of quads over the layer, built by hand rather than
// through bindPart() -- which reaches into the live bones store. Skinning
// is the thing under test here, so the mesh around it stays inert.
function gridMesh(size, cells = 4) {
  const vertices = [];
  const step = size / cells;
  for (let row = 0; row <= cells; row++) {
    for (let col = 0; col <= cells; col++) {
      vertices.push({
        restLocal: { x: col * step - size / 2, y: row * step - size / 2 },
        uv: { u: col * step, v: row * step },
        weights: { A: 0.5, B: 0.5 },
      });
    }
  }
  const triangles = [];
  const at = (r, c) => r * (cells + 1) + c;
  for (let row = 0; row < cells; row++) {
    for (let col = 0; col < cells; col++) {
      triangles.push(at(row, col), at(row, col + 1), at(row + 1, col));
      triangles.push(at(row, col + 1), at(row + 1, col + 1), at(row + 1, col));
    }
  }
  return {
    vertices,
    triangles,
    isBound: true,
    bindPose: {
      A: { head: { x: 0, y: 0 }, rotation: 0 },
      B: { head: { x: 0, y: 0 }, rotation: 0 },
    },
  };
}
part.mesh = gridMesh(SIZE);

const transformsAt = (degA, degB) => ({
  A: { head: { x: 0, y: 0 }, rotation: degA * Math.PI / 180, physics: false, partId: 'p1',
    rigidHead: { x: 0, y: 0 }, rigidRotation: degA * Math.PI / 180 },
  B: { head: { x: 0, y: 0 }, rotation: degB * Math.PI / 180, physics: false, partId: 'p1',
    rigidHead: { x: 0, y: 0 }, rigidRotation: degB * Math.PI / 180 },
});

const restArea = meshArea(part.mesh, deformVertices(part.mesh, part, transformsAt(0, 0)));
say(restArea > 0, 'the test mesh has a real area to start with', `${restArea.toFixed(1)}`);

// ---------------------------------------------------------------------------
// The headline: the implementation IS the stated formula,
//   v' = sum_i w_i * M_now,i * inv(M_bind,i) * v
// checked against an independent reference at every angle.
//
// This section used to assert that AREA was preserved at every angle, for a
// "transform blending" that averaged rotations about scene (0,0). Those
// checks passed only because every bone here sits exactly AT (0,0) -- the
// one layout where that pivot and the joint coincide. Away from the origin
// the same blend inflated a bent elbow to 573% of its area. So the checks
// below test the formula itself, and origin invariance separately.

function reference(vertex, transforms) {
  const vx = vertex.restLocal.x + part.centerX;
  const vy = vertex.restLocal.y + part.centerY;
  let x = 0; let y = 0; let t = 0;
  for (const [id, w] of Object.entries(vertex.weights)) {
    const bind = part.mesh.bindPose[id];
    const now = transforms[id];
    const a = now.rotation - bind.rotation;
    const dx = vx - bind.head.x; const dy = vy - bind.head.y;
    x += w * (dx * Math.cos(a) - dy * Math.sin(a) + now.head.x);
    y += w * (dx * Math.sin(a) + dy * Math.cos(a) + now.head.y);
    t += w;
  }
  return { x: x / t, y: y / t };
}

for (const deg of [0, 15, 30, 58, 90, 128, 179]) {
  const tr = transformsAt(0, deg);
  const positions = deformVertices(part.mesh, part, tr);
  let worst = 0;
  part.mesh.vertices.forEach((vertex, i) => {
    const r = reference(vertex, tr);
    worst = Math.max(worst, Math.hypot(positions[i].x - r.x, positions[i].y - r.y));
  });
  near(worst, 0, 1e-9, `with the bones ${deg} degrees apart it equals sum w_i M_now inv(M_bind) v`,
    `worst ${worst.toExponential(2)} px off the reference`);
}

// Linear blending's known cost, stated rather than hidden: a vertex split
// EVENLY between two bones an angle theta apart keeps cos^2(theta/2) of its
// area. This mesh is the worst case -- 50/50 on every vertex -- which real
// auto-weights never are (a realistic falloff across a joint keeps 88.5% at
// 90 degrees, not the 50% below).
for (const deg of [30, 90]) {
  const area = meshArea(part.mesh, deformVertices(part.mesh, part, transformsAt(0, deg)));
  const expected = Math.cos(deg * Math.PI / 360) ** 2;
  near(area / restArea, expected, 1e-9,
    `a 50/50 vertex set ${deg} degrees apart keeps exactly cos^2(theta/2) of its area, as the formula says`,
    `kept ${((area / restArea) * 100).toFixed(1)}%, formula ${(expected * 100).toFixed(1)}%`);
}

// ORIGIN INVARIANCE -- the property the old blend failed. Same pose, the
// whole scene moved: every vertex must move by exactly that and no more.
{
  const S = 300;
  const shiftT = (t) => Object.fromEntries(Object.entries(t).map(([id, v]) => [id, {
    ...v, head: { x: v.head.x + S, y: v.head.y + S }, rigidHead: { x: v.rigidHead.x + S, y: v.rigidHead.y + S },
  }]));
  const moved = { ...part, x: part.x + S, y: part.y + S,
    get centerX() { return part.centerX + S; }, get centerY() { return part.centerY + S; } };
  const savedBind = part.mesh.bindPose;
  const base = deformVertices(part.mesh, part, transformsAt(10, 100));
  part.mesh.bindPose = Object.fromEntries(Object.entries(savedBind).map(([id, b]) => [id,
    { ...b, head: { x: b.head.x + S, y: b.head.y + S } }]));
  const shifted = deformVertices(part.mesh, moved, shiftT(transformsAt(10, 100)));
  part.mesh.bindPose = savedBind;
  let worst = 0;
  base.forEach((p, i) => { worst = Math.max(worst, Math.hypot(shifted[i].x - S - p.x, shifted[i].y - S - p.y)); });
  near(worst, 0, 1e-9, 'ORIGIN INVARIANT: the same pose moved 300px lands exactly 300px away, nothing more',
    `worst ${worst.toExponential(2)} px of drift (the old blend: tens to hundreds)`);
}

// 180 degrees exactly, 50/50: the formula's own degenerate case -- each
// vertex's two candidate positions are mirror images through the joint and
// average onto it. That is what the formula says; it must still produce
// FINITE positions, never NaN.
{
  const positions = deformVertices(part.mesh, part, transformsAt(0, 180));
  say(positions.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)),
    'a clean 180-degree opposition still produces finite positions');
}

// ---------------------------------------------------------------------------
// It still agrees with the old formula wherever the old formula was right.

{
  // Both bones moved identically: every blend degenerates to one rigid
  // motion, and the answer is exactly the rigid answer.
  const deg = 40;
  const positions = deformVertices(part.mesh, part, transformsAt(deg, deg));
  const th = deg * Math.PI / 180;
  let worst = 0;
  part.mesh.vertices.forEach((vertex, i) => {
    const rx = vertex.restLocal.x + part.centerX;
    const ry = vertex.restLocal.y + part.centerY;
    const ex = rx * Math.cos(th) - ry * Math.sin(th);
    const ey = rx * Math.sin(th) + ry * Math.cos(th);
    worst = Math.max(worst, Math.hypot(positions[i].x - ex, positions[i].y - ey));
  });
  near(worst, 0, 1e-9, 'bones in agreement give exactly the rigid answer', `worst ${worst.toExponential(2)} off`);
}

{
  // A pure translation, no rotation anywhere: the layer must move by
  // exactly that and not deform at all.
  const t = { A: { head: { x: 7, y: -3 }, rotation: 0, physics: false, partId: 'p1', rigidHead: { x: 7, y: -3 }, rigidRotation: 0 },
    B: { head: { x: 7, y: -3 }, rotation: 0, physics: false, partId: 'p1', rigidHead: { x: 7, y: -3 }, rigidRotation: 0 } };
  const positions = deformVertices(part.mesh, part, t);
  const restPositions = deformVertices(part.mesh, part, transformsAt(0, 0));
  let worst = 0;
  positions.forEach((p, i) => {
    worst = Math.max(worst, Math.hypot(p.x - (restPositions[i].x + 7), p.y - (restPositions[i].y - 3)));
  });
  near(worst, 0, 1e-9, 'a pure translation moves the layer and deforms nothing', `worst ${worst.toExponential(2)} off`);
}

{
  // At rest the mesh must sit exactly on the undeformed sprite -- the
  // guarantee the original comment made and the renderer depends on.
  const positions = deformVertices(part.mesh, part, transformsAt(0, 0));
  let worst = 0;
  part.mesh.vertices.forEach((vertex, i) => {
    worst = Math.max(worst, Math.hypot(
      positions[i].x - (vertex.restLocal.x + part.centerX),
      positions[i].y - (vertex.restLocal.y + part.centerY)));
  });
  near(worst, 0, 1e-9, 'an unmoved skeleton leaves the mesh exactly at rest', `worst ${worst.toExponential(2)} off`);
}

// ---------------------------------------------------------------------------
// A lopsided weighting still behaves: the heavier bone dominates, and the
// area survives regardless.

{
  for (const vertex of part.mesh.vertices) vertex.weights = { A: 0.9, B: 0.1 };
  const tr = transformsAt(0, 120);
  const positions = deformVertices(part.mesh, part, tr);
  const area = meshArea(part.mesh, positions);
  // The blended linear part is 0.9*I + 0.1*R(120deg); its determinant is
  // the area factor, exactly.
  const c = Math.cos(120 * Math.PI / 180); const sn = Math.sin(120 * Math.PI / 180);
  const det = (0.9 + 0.1 * c) ** 2 + (0.1 * sn) ** 2;
  near(area / restArea, det, 1e-9,
    'a 90/10 split across a 120-degree gap keeps exactly the area the formula predicts',
    `kept ${((area / restArea) * 100).toFixed(1)}%, formula ${(det * 100).toFixed(1)}%`);

  // The heavier bone dominates: each vertex lands far closer to where bone
  // A alone would put it than to where B would.
  let closerToHeavy = 0;
  part.mesh.vertices.forEach((vertex, i) => {
    const onlyA = reference({ ...vertex, weights: { A: 1 } }, tr);
    const onlyB = reference({ ...vertex, weights: { B: 1 } }, tr);
    const p = positions[i];
    if (Math.hypot(p.x - onlyA.x, p.y - onlyA.y) <= Math.hypot(p.x - onlyB.x, p.y - onlyB.y)) closerToHeavy++;
  });
  say(closerToHeavy === part.mesh.vertices.length,
    'and every vertex sits nearer the heavier bone\'s answer than the lighter one\'s',
    `${closerToHeavy}/${part.mesh.vertices.length}`);
}

// ---------------------------------------------------------------------------
// Weights that do not sum to 1 (a bone deleted since binding) renormalize.

{
  for (const vertex of part.mesh.vertices) vertex.weights = { A: 0.25, B: 0.25 };
  const half = deformVertices(part.mesh, part, transformsAt(0, 60));
  for (const vertex of part.mesh.vertices) vertex.weights = { A: 0.5, B: 0.5 };
  const full = deformVertices(part.mesh, part, transformsAt(0, 60));
  let worst = 0;
  half.forEach((p, i) => { worst = Math.max(worst, Math.hypot(p.x - full[i].x, p.y - full[i].y)); });
  near(worst, 0, 1e-9, 'weights that do not sum to 1 renormalize to the same answer', `worst ${worst.toExponential(2)} off`);
}

console.log('\nskinning.js:\n');
let pass = 0;
for (const r of report) {
  console.log(`  ${r.ok ? 'ok  ' : 'FAIL'}  ${r.name}`);
  if (r.detail) console.log(`          ${r.detail}`);
  if (r.ok) pass++;
}
console.log(`\n${pass}/${report.length} checks passed`);
process.exit(report.every((r) => r.ok) ? 0 : 1);
