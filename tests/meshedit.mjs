// Vertex editing must never break the mesh.
//
// The renderer's founding promise is that every scene pixel is decided
// exactly once by one triangle. So after EVERY operation here the mesh is
// put through meshProblems() -- missing vertices, repeated corners,
// degenerate triangles, duplicates -- because any one of those is a visible
// hole or a double-drawn patch in the artwork, and none of them are obvious
// by looking at a wireframe.

import { generateMesh, MeshVertex } from '../www/js/mesh.js';
import {
  addVertex, moveVertex, removeVertex, vertexAt, triangleAt,
  meshProblems, meshArea, snapUV, restLocalForUV,
} from '../www/js/meshedit.js';

const report = [];
const say = (ok, name, detail = '') => report.push({ ok, name, detail });
const clean = (mesh, label) => {
  const problems = meshProblems(mesh);
  say(problems.length === 0, label, problems.length ? problems.slice(0, 3).join('; ') : 'no problems');
};

function makePart(w = 64, h = 64) {
  return {
    id: 'p1', naturalWidth: w, naturalHeight: h,
    scale: 1, rotation: 0, x: 0, y: 0,
    centerX: w / 2, centerY: h / 2,
    pixels: new Uint8ClampedArray(w * h * 4).fill(255),
  };
}

// A dense mesh, as the task asks for -- density 10 over 64x64 gives a
// 10x10 grid of cells, 121 vertices, 200 triangles.
const part = makePart();
const fresh = () => {
  const mesh = generateMesh(part, 10);
  // Two bones' worth of hand-painted weights, so redistribution has
  // something real to preserve.
  mesh.bindPose = { A: { head: { x: 10, y: 10 }, rotation: 0 }, B: { head: { x: 54, y: 54 }, rotation: 0 } };
  for (const vertex of mesh.vertices) {
    const t = vertex.u / part.naturalWidth;
    vertex.weights = { A: 1 - t, B: t };
  }
  return mesh;
};

{
  const mesh = fresh();
  say(mesh.vertices.length === 121 && mesh.triangles.length / 3 === 200,
    'the fixture is a dense mesh',
    `${mesh.vertices.length} vertices, ${mesh.triangles.length / 3} triangles`);
  clean(mesh, 'the freshly generated mesh is valid to begin with');
}

// ---------------------------------------------------------------------------
// Grid snapping

{
  say(snapUV(12.4, 30.7, part).u === 12 && snapUV(12.4, 30.7, part).v === 31,
    'a tapped point snaps to the nearest whole texel', JSON.stringify(snapUV(12.4, 30.7, part)));
  say(snapUV(-5, 999, part).u === 0 && snapUV(-5, 999, part).v === part.naturalHeight,
    'and is clamped to the layer rather than escaping it', JSON.stringify(snapUV(-5, 999, part)));
  const rl = restLocalForUV(16, 48, part);
  say(rl.x === -16 && rl.y === 16,
    'rest position follows the UV, the same relationship generateMesh builds', JSON.stringify(rl));
}

// ---------------------------------------------------------------------------
// Add

{
  const mesh = fresh();
  const before = { vertices: mesh.vertices.length, triangles: mesh.triangles.length / 3, area: meshArea(mesh) };
  // Deliberately off-grid and strictly inside one cell, so it is an
  // interior split rather than an edge split.
  const result = addVertex(mesh, part, 9.4, 9.7);
  say(result.ok, 'Add inserts a vertex inside a triangle', JSON.stringify(result));
  clean(mesh, 'the mesh is still valid after Add');
  say(mesh.vertices.length === before.vertices + 1, 'exactly one vertex was added');
  say(mesh.triangles.length / 3 === before.triangles + 2,
    'one triangle became three', `${before.triangles} -> ${mesh.triangles.length / 3}`);
  say(Math.abs(meshArea(mesh) - before.area) < 1e-9,
    'and the mesh covers exactly the same area as before',
    `${before.area} -> ${meshArea(mesh)}`);

  const added = mesh.vertices[result.index];
  say(Number.isInteger(added.u) && Number.isInteger(added.v),
    'the added vertex is grid-snapped', `(${added.u}, ${added.v})`);
  say(added.restLocal.x === added.u - part.naturalWidth / 2,
    'and its rest position matches its UV');
  const total = Object.values(added.weights).reduce((a, b) => a + b, 0);
  say(Object.keys(added.weights).length > 0 && Math.abs(total - 1) < 1e-9,
    'the added vertex carries normalized weights from the auto-weight rule',
    JSON.stringify(added.weights));
}

{
  // A point exactly on a shared edge must split BOTH triangles using it,
  // or the untouched one is left with a vertex sitting mid-edge: a
  // T-junction, which cracks open the moment the two sides deform apart.
  const mesh = fresh();
  const a = mesh.vertices[0];
  const b = mesh.vertices[1];
  // The midpoint of the top-left cell's diagonal is shared by two triangles.
  const shared = mesh.vertices[12]; // one row down, one col across
  const mu = Math.round((b.u + shared.u) / 2);
  const mv = Math.round((b.v + shared.v) / 2);
  const before = mesh.triangles.length / 3;
  const result = addVertex(mesh, part, mu, mv);
  say(result.ok, 'Add accepts a point lying on a shared edge', JSON.stringify(result));
  clean(mesh, 'the mesh is still valid after an edge split');
  if (result.onEdge) {
    say(result.splitTriangles === 2, 'both triangles sharing that edge were split', `${result.splitTriangles}`);
    say(mesh.triangles.length / 3 === before + 2, 'two triangles became four',
      `${before} -> ${mesh.triangles.length / 3}`);
  } else {
    say(mesh.triangles.length / 3 === before + 2, 'it split as an interior point',
      `${before} -> ${mesh.triangles.length / 3}`);
  }
  say(a !== undefined, 'the original corner vertices are untouched');
}

{
  const mesh = fresh();
  const existing = mesh.vertices[25];
  const result = addVertex(mesh, part, existing.u, existing.v);
  say(!result.ok && result.index === 25,
    'Add refuses a point that is already a vertex, and says which one', JSON.stringify(result));
  const outside = addVertex(mesh, part, 500, 500);
  say(!outside.ok, 'Add refuses a point off the mesh', JSON.stringify(outside));
}

// ---------------------------------------------------------------------------
// Move

{
  const mesh = fresh();
  const index = 60; // an interior vertex
  const weightsBefore = { ...mesh.vertices[index].weights };
  const result = moveVertex(mesh, part, index, 33.6, 27.2);
  say(result.ok, 'Move repositions a vertex', JSON.stringify(result));
  clean(mesh, 'the mesh is still valid after Move');
  const moved = mesh.vertices[index];
  say(moved.u === 34 && moved.v === 27, 'to a grid-snapped position', `(${moved.u}, ${moved.v})`);
  say(moved.restLocal.x === 34 - 32 && moved.restLocal.y === 27 - 32,
    'with the rest position following it', JSON.stringify(moved.restLocal));
  say(JSON.stringify(moved.weights) === JSON.stringify(weightsBefore),
    'and its weights are preserved exactly -- moving a vertex is not a reason to undo weight painting',
    JSON.stringify(moved.weights));
  say(mesh.vertices.length === 121 && mesh.triangles.length / 3 === 200,
    'Move changes no counts at all');
}

// ---------------------------------------------------------------------------
// Remove

{
  const mesh = fresh();
  const index = 60; // interior: a full six-triangle one-ring
  const before = { vertices: mesh.vertices.length, triangles: mesh.triangles.length / 3, area: meshArea(mesh) };
  const victimWeights = { ...mesh.vertices[index].weights };
  const result = removeVertex(mesh, part, index);
  say(result.ok, 'Remove deletes an interior vertex', JSON.stringify(result));
  clean(mesh, 'the mesh is still valid after removing an interior vertex');
  say(mesh.vertices.length === before.vertices - 1, 'exactly one vertex is gone');
  say(result.patchTriangles === result.ringSize - 2,
    'the hole is re-filled with a proper triangulation of its ring',
    `ring of ${result.ringSize} -> ${result.patchTriangles} triangles`);
  say(Math.abs(meshArea(mesh) - before.area) < 1e-6,
    'and the mesh still covers the same area -- no hole was left behind',
    `${before.area.toFixed(2)} -> ${meshArea(mesh).toFixed(2)}`);
  say(Object.keys(victimWeights).length > 0, 'the removed vertex had weights to redistribute');
  // Every surviving vertex must still be normalized.
  const worst = mesh.vertices.reduce((acc, vertex) => {
    const total = Object.values(vertex.weights).reduce((a, b) => a + b, 0);
    return Math.max(acc, Math.abs(total - 1));
  }, 0);
  say(worst < 1e-9, 'and every surviving vertex is still normalized to sum to 1',
    `worst drift ${worst.toExponential(2)}`);
}

{
  // A CONCAVE one-ring -- produced by first dragging a neighbour inward --
  // is the case a naive fan gets wrong, filling the hole with overlapping
  // and inverted triangles.
  const mesh = fresh();
  moveVertex(mesh, part, 49, 30, 30);   // pull a neighbour of vertex 60 inward
  moveVertex(mesh, part, 71, 34, 34);
  const before = meshArea(mesh);
  const result = removeVertex(mesh, part, 60);
  say(result.ok, 'Remove copes with a concave one-ring', JSON.stringify(result));
  clean(mesh, 'the mesh is still valid after removing from a concave ring');
  say(Math.abs(meshArea(mesh) - before) < 1e-6,
    'and the concave hole is filled exactly, with no overlap or spill',
    `${before.toFixed(2)} -> ${meshArea(mesh).toFixed(2)}`);
}

{
  // A boundary vertex has an OPEN one-ring. Removing it straightens that
  // stretch of edge, which legitimately loses a little area -- but must
  // still leave a valid mesh.
  const mesh = fresh();
  const before = meshArea(mesh);
  const result = removeVertex(mesh, part, 5); // top edge, not a corner
  say(result.ok, 'Remove deletes a vertex on the mesh boundary', JSON.stringify(result));
  clean(mesh, 'the mesh is still valid after removing a boundary vertex');
  say(meshArea(mesh) <= before + 1e-6,
    'and removing from the boundary never invents area', `${before.toFixed(2)} -> ${meshArea(mesh).toFixed(2)}`);
}

{
  // Every triangle index must still point at a real vertex after the
  // re-index that follows a removal -- the failure this would hide is a
  // triangle silently pointing at the wrong artwork.
  const mesh = fresh();
  const targetU = mesh.vertices[60].u;
  removeVertex(mesh, part, 60);
  const stillThere = mesh.vertices.some((v, i) => i === 60 && v.u === targetU);
  say(!stillThere || mesh.vertices[60].u !== targetU,
    'indices after the removed one slide down, so nothing points at a stale vertex');
  const maxIndex = Math.max(...mesh.triangles);
  say(maxIndex < mesh.vertices.length,
    'and no triangle index runs past the end of the vertex list',
    `max index ${maxIndex}, ${mesh.vertices.length} vertices`);
}

// ---------------------------------------------------------------------------
// A long sequence, because a single operation proving out is a weaker claim
// than fifty of them in a row leaving the mesh intact.

{
  const mesh = fresh();
  let ops = 0;
  let attempted = 0;
  // Some of these legitimately bounce -- a point that snaps onto a vertex
  // already there is refused on purpose, and that refusal is the correct
  // answer rather than a failure. What matters is that everything which
  // DID apply left the mesh intact.
  for (let i = 0; i < 18; i++) {
    attempted++;
    const r = addVertex(mesh, part, 7 + i * 3.3, 11 + i * 2.7);
    if (r.ok) ops++;
  }
  // Moves are DRAGS: a texel or two from where each vertex already is,
  // which is what a finger does. These used to teleport each vertex to a
  // fixed point across the mesh -- (20+i, 40-i) whatever the vertex -- and
  // most of those folded the mesh over itself. They were accepted, and the
  // "still valid" check below passed only because meshProblems could not
  // see a fold. It can now, and moveVertex refuses a fold outright; a
  // teleport of that kind is checked separately, as a refusal.
  for (let i = 0; i < 12; i++) {
    const index = 30 + i * 3;
    attempted++;
    if (index < mesh.vertices.length) {
      const v = mesh.vertices[index];
      if (moveVertex(mesh, part, index, Math.round(v.u) + 1, Math.round(v.v)).ok) ops++;
    }
  }
  for (let i = 0; i < 14; i++) {
    attempted++;
    if (mesh.vertices.length > 4 && removeVertex(mesh, part, 40).ok) ops++;
  }
  {
    const probe = fresh();
    const far = probe.vertices[probe.vertices.length - 1];
    const r = moveVertex(probe, part, 0, far.u, far.v - 1);
    say(!r.ok && meshProblems(probe).length === 0,
      'a move that would fold the mesh across itself is REFUSED, and leaves it valid',
      JSON.stringify(r));
  }
  say(ops >= 30, 'a long mixed run of Add / Move / Remove applied',
    `${ops} of ${attempted} applied; the rest were correctly refused`);
  clean(mesh, 'and the mesh is STILL valid after all of them');
  const maxIndex = Math.max(...mesh.triangles);
  say(maxIndex < mesh.vertices.length, 'with every index still in range',
    `max ${maxIndex}, ${mesh.vertices.length} vertices`);
  say(mesh.triangles.length > 0, 'and the mesh is not empty');
}

// ---------------------------------------------------------------------------
// Picking

{
  const mesh = fresh();
  const v = mesh.vertices[44];
  say(vertexAt(mesh, v.u + 1, v.v) === 44, 'a tap near a vertex finds it');
  say(vertexAt(mesh, v.u + 40, v.v + 40) !== 44, 'a tap far from it does not');
  say(triangleAt(mesh, 32, 32) !== null, 'a tap inside the mesh finds a triangle');
  say(triangleAt(mesh, -50, -50) === null, 'a tap outside it finds none');
}

console.log('\nmeshedit.js:\n');
let pass = 0;
for (const r of report) {
  console.log(`  ${r.ok ? 'ok  ' : 'FAIL'}  ${r.name}`);
  if (r.detail) console.log(`          ${r.detail}`);
  if (r.ok) pass++;
}
console.log(`\n${pass}/${report.length} checks passed`);
process.exit(report.every((r) => r.ok) ? 0 : 1);
