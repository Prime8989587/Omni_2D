// Editing a mesh's vertices: add, move, remove.
//
// Pure -- takes a mesh and returns a changed mesh, touches no DOM and no
// stores -- so "is the triangulation still valid" is answerable against a
// hand-built grid in Node rather than by looking at a wireframe and hoping.
// Same split mesh.js itself follows.
//
// THE INVARIANT EVERY OPERATION HERE MUST HOLD
//
// The renderer's founding promise is that every scene pixel is decided
// exactly once by one triangle. A mesh that has been edited has to keep
// that, which means after any of these:
//
//   * no triangle references a vertex that is gone
//   * no triangle is degenerate (its three corners collinear), because
//     rasterizeTriangle drops those outright and a dropped triangle is a
//     hole in the artwork
//   * no triangle is duplicated, and none overlaps another
//   * the area the mesh covers is unchanged except where a vertex was
//     genuinely removed from the boundary
//
// tests/meshedit.mjs checks all of that after every operation rather than
// trusting any of the algorithms below to be obviously right.

import { MeshVertex, localToWorld, autoWeightOneVertex } from './mesh.js';

// A vertex nearer than this to a tap is the one being tapped, rather than a
// place to insert a new vertex. In source texels, so it scales with the
// artwork rather than with the zoom.
//
// It cannot be a FIXED number, and the reason is worth stating: a dense mesh
// has small cells -- density 14 over a 64px layer puts vertices 4.6 texels
// apart -- so a flat radius of 3 leaves almost no point that is not "within
// 3 of a vertex", and Add becomes impossible to use on exactly the meshes
// that most need editing. So the radius is a fraction of the mesh's own cell
// size, capped at the comfortable-thumb figure for coarse meshes.
export const VERTEX_HIT_TEXELS = 3;

export function hitRadius(mesh, part) {
  if (!mesh || !part) return VERTEX_HIT_TEXELS;
  const cols = Math.max(1, mesh.cols || 1);
  const rows = Math.max(1, mesh.rows || 1);
  const cell = Math.min(part.naturalWidth / cols, part.naturalHeight / rows);
  return Math.max(0.75, Math.min(VERTEX_HIT_TEXELS, cell * 0.35));
}
// Closer than this to an edge and an inserted vertex is treated as ON that
// edge, which has to split both triangles sharing it rather than one -- see
// addVertex.
const EDGE_EPSILON = 1e-6;

// ---------------------------------------------------------------------------
// Grid snapping
//
// Vertex positions are stored in the part's local space, centred on the
// origin, one unit per source pixel. Snapping there means snapping the UV --
// the source texel the vertex sits on -- which is the grid that actually
// matters for pixel art, and it is the same relationship generateMesh()
// builds: restLocal = uv - size/2.

export function snapUV(u, v, part) {
  return {
    u: Math.min(part.naturalWidth, Math.max(0, Math.round(u))),
    v: Math.min(part.naturalHeight, Math.max(0, Math.round(v))),
  };
}

export function restLocalForUV(u, v, part) {
  return { x: u - part.naturalWidth / 2, y: v - part.naturalHeight / 2 };
}

// ---------------------------------------------------------------------------
// Geometry helpers, all in UV space (where the mesh's own grid lives)

const cross = (ax, ay, bx, by, cx, cy) => (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);

function triangleArea2(a, b, c) {
  return cross(a.u, a.v, b.u, b.v, c.u, c.v);
}

// Barycentric containment, inclusive of the edges so a point on a shared
// edge is found rather than falling between two triangles.
function pointInTriangle(p, a, b, c) {
  const area = triangleArea2(a, b, c);
  if (area === 0) return null;
  const s = Math.sign(area);
  const w0 = cross(b.u, b.v, c.u, c.v, p.u, p.v) * s;
  const w1 = cross(c.u, c.v, a.u, a.v, p.u, p.v) * s;
  const w2 = cross(a.u, a.v, b.u, b.v, p.u, p.v) * s;
  if (w0 < 0 || w1 < 0 || w2 < 0) return null;
  const total = Math.abs(area);
  return { w0: w0 / total, w1: w1 / total, w2: w2 / total };
}

// ---------------------------------------------------------------------------
// Picking

export function vertexAt(mesh, u, v, radius = VERTEX_HIT_TEXELS) {
  let best = -1;
  let bestDistance = radius;
  mesh.vertices.forEach((vertex, index) => {
    const d = Math.hypot(vertex.u - u, vertex.v - v);
    if (d <= bestDistance) { bestDistance = d; best = index; }
  });
  return best;
}

export function triangleAt(mesh, u, v) {
  const p = { u, v };
  for (let i = 0; i < mesh.triangles.length; i += 3) {
    const a = mesh.vertices[mesh.triangles[i]];
    const b = mesh.vertices[mesh.triangles[i + 1]];
    const c = mesh.vertices[mesh.triangles[i + 2]];
    const bary = pointInTriangle(p, a, b, c);
    if (bary) return { index: i, ids: [mesh.triangles[i], mesh.triangles[i + 1], mesh.triangles[i + 2]], bary };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Move
//
// The vertex's REST position moves and its UV moves with it, so the vertex
// keeps sampling the texel it sits on. Moving restLocal alone would leave
// the vertex pointing at a texel it is no longer over, which shears the
// artwork under the whole one-ring rather than adjusting where the mesh
// sits -- the opposite of what a tool called Mesh Trim is for.
//
// Weights are untouched. A vertex that was hand-painted onto a bone is
// still on that bone after being nudged a few texels; re-deriving them
// would silently undo weight painting every time the mesh was tidied.

export function moveVertex(mesh, part, index, u, v) {
  const vertex = mesh.vertices[index];
  if (!vertex) return { ok: false, reason: 'no such vertex' };
  const snapped = snapUV(u, v, part);
  vertex.u = snapped.u;
  vertex.v = snapped.v;
  vertex.restLocal = restLocalForUV(snapped.u, snapped.v, part);
  return { ok: true, index, u: snapped.u, v: snapped.v };
}

// ---------------------------------------------------------------------------
// Add
//
// A point inside a triangle splits it into three. A point ON a shared edge
// has to split BOTH triangles using that edge, into two each -- splitting
// only one would leave the other with a vertex sitting in the middle of one
// of its edges, touching but not joined. That is a T-junction, and it is a
// hairline crack in the artwork the moment the two sides deform by
// different amounts.

export function addVertex(mesh, part, u, v, { bonesStore = null } = {}) {
  const snapped = snapUV(u, v, part);

  const existing = vertexAt(mesh, snapped.u, snapped.v, hitRadius(mesh, part));
  if (existing >= 0) return { ok: false, reason: 'a vertex is already there', index: existing };

  const hit = triangleAt(mesh, snapped.u, snapped.v);
  if (!hit) return { ok: false, reason: 'that point is not on the mesh' };

  const restLocal = restLocalForUV(snapped.u, snapped.v, part);
  const vertex = new MeshVertex(snapped.u, snapped.v, restLocal);
  // The inverse-distance-to-bones rule, reached through mesh.js so this is
  // the same calculation auto-weighting uses rather than a copy of it. With
  // no bind pose to read (an unbound mesh) it returns nothing, and the
  // barycentric fallback below gives the vertex its neighbours' weights.
  vertex.weights = autoWeightOneVertex(mesh, part, restLocal);
  if (Object.keys(vertex.weights).length === 0) {
    vertex.weights = blendWeights([
      { weights: mesh.vertices[hit.ids[0]].weights, share: hit.bary.w0 },
      { weights: mesh.vertices[hit.ids[1]].weights, share: hit.bary.w1 },
      { weights: mesh.vertices[hit.ids[2]].weights, share: hit.bary.w2 },
    ]);
  }

  const newIndex = mesh.vertices.length;
  mesh.vertices.push(vertex);

  // Which edge of the hit triangle, if any, the point landed on: the
  // barycentric coordinate opposite that edge is zero there.
  const [ia, ib, ic] = hit.ids;
  const onEdge = hit.bary.w0 <= EDGE_EPSILON ? [ib, ic]
    : hit.bary.w1 <= EDGE_EPSILON ? [ic, ia]
    : hit.bary.w2 <= EDGE_EPSILON ? [ia, ib]
    : null;

  const kept = [];
  let split = 0;
  for (let i = 0; i < mesh.triangles.length; i += 3) {
    const t = [mesh.triangles[i], mesh.triangles[i + 1], mesh.triangles[i + 2]];
    const splitsHere = onEdge
      ? t.includes(onEdge[0]) && t.includes(onEdge[1])
      : i === hit.index;
    if (!splitsHere) { kept.push(...t); continue; }
    split++;
    if (onEdge) {
      // Find the split edge as this triangle winds it, p -> q, with r the
      // opposite corner. Cutting p -> q at the new vertex gives (p, N, r)
      // and (N, q, r), both still wound the way (p, q, r) was.
      for (let k = 0; k < 3; k++) {
        const p = t[k];
        const q = t[(k + 1) % 3];
        const r = t[(k + 2) % 3];
        if ((p !== onEdge[0] || q !== onEdge[1]) && (p !== onEdge[1] || q !== onEdge[0])) continue;
        kept.push(p, newIndex, r, newIndex, q, r);
        break;
      }
    } else {
      // Interior: three triangles fanning out to the original corners,
      // each in the original winding order.
      for (let k = 0; k < 3; k++) kept.push(t[k], t[(k + 1) % 3], newIndex);
    }
  }
  mesh.triangles = dropDegenerate(mesh, kept);
  return { ok: true, index: newIndex, u: snapped.u, v: snapped.v, splitTriangles: split, onEdge: Boolean(onEdge) };
}

// ---------------------------------------------------------------------------
// Remove
//
// Deleting a vertex leaves a hole shaped like its ONE-RING: the polygon
// made of the far edges of every triangle that used it. Re-filling that
// polygon is what keeps the artwork whole -- drop the triangles and stop
// and there is a visible gap exactly the size of the vertex's neighbourhood.
//
// The ring is walked into order first (the triangles arrive in whatever
// order the list happens to hold them) and then ear-clipped. Ear clipping
// is the right tool here and not overkill: a one-ring is small, and it is
// frequently CONCAVE once a few vertices have already been moved, which a
// naive fan from one corner would fill with overlapping and inverted
// triangles.
//
// The vertex's weights are not discarded -- they are handed to the ring
// neighbours, weighted by inverse distance, so a bone that was painted onto
// this vertex keeps its hold on that patch of artwork instead of the patch
// snapping to whatever its remaining neighbours happened to say.

export function removeVertex(mesh, part, index) {
  const victim = mesh.vertices[index];
  if (!victim) return { ok: false, reason: 'no such vertex' };
  if (mesh.vertices.length <= 3) return { ok: false, reason: 'a mesh needs at least three vertices' };

  // The far edge of every triangle that used this vertex, with the triangle's
  // own winding preserved so the ring comes out consistently oriented.
  const edges = [];
  const untouched = [];
  for (let i = 0; i < mesh.triangles.length; i += 3) {
    const t = [mesh.triangles[i], mesh.triangles[i + 1], mesh.triangles[i + 2]];
    const at = t.indexOf(index);
    if (at < 0) { untouched.push(...t); continue; }
    edges.push([t[(at + 1) % 3], t[(at + 2) % 3]]);
  }
  if (edges.length === 0) return { ok: false, reason: 'that vertex is in no triangle' };

  const ring = orderRing(edges);
  if (ring.length < 3) return { ok: false, reason: 'the hole around that vertex cannot be re-filled' };

  redistributeWeights(mesh, index, ring);

  const patch = earClip(mesh.vertices, ring);
  const rebuilt = dropDegenerate(mesh, [...untouched, ...patch]);

  // Drop the vertex and slide every later index down one.
  mesh.vertices.splice(index, 1);
  mesh.triangles = rebuilt.map((id) => (id > index ? id - 1 : id));

  return { ok: true, removed: index, ringSize: ring.length, patchTriangles: patch.length / 3 };
}

// The far edges arrive unordered; this chains them head-to-tail into a
// loop. An interior vertex closes; a vertex on the mesh's outer edge gives
// an open chain, whose two ends are simply joined by the ear clipper --
// which is correct, because removing a boundary vertex is exactly what
// straightens that stretch of boundary.
function orderRing(edges) {
  const next = new Map();
  for (const [from, to] of edges) {
    if (!next.has(from)) next.set(from, []);
    next.get(from).push(to);
  }
  // Start at a vertex nothing points INTO when the chain is open, so an
  // open chain is walked from its true start rather than from the middle.
  const incoming = new Set(edges.map(([, to]) => to));
  let start = edges.find(([from]) => !incoming.has(from));
  start = start ? start[0] : edges[0][0];

  const ring = [];
  const seen = new Set();
  let current = start;
  while (current !== undefined && !seen.has(current)) {
    ring.push(current);
    seen.add(current);
    const options = next.get(current);
    current = options && options.length ? options.find((id) => !seen.has(id)) ?? options[0] : undefined;
  }
  return ring;
}

// Textbook ear clipping, on a polygon given as vertex indices.
function earClip(vertices, ring) {
  const poly = [...ring];
  const out = [];
  const at = (i) => vertices[poly[i]];

  // Signed area decides the polygon's own winding, so "convex" below means
  // convex for THIS polygon rather than for an assumed orientation.
  let area2 = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = at(i);
    const b = at((i + 1) % poly.length);
    area2 += a.u * b.v - b.u * a.v;
  }
  const orientation = area2 >= 0 ? 1 : -1;

  let guard = poly.length * poly.length + 16;
  while (poly.length > 3 && guard-- > 0) {
    let clipped = false;
    for (let i = 0; i < poly.length; i++) {
      const prev = at((i - 1 + poly.length) % poly.length);
      const curr = at(i);
      const next = at((i + 1) % poly.length);
      if (triangleArea2(prev, curr, next) * orientation <= 0) continue; // reflex or flat

      // An ear may not swallow any other vertex of the polygon.
      let contains = false;
      for (let k = 0; k < poly.length; k++) {
        if (k === i || k === (i - 1 + poly.length) % poly.length || k === (i + 1) % poly.length) continue;
        if (pointInTriangle(at(k), prev, curr, next)) { contains = true; break; }
      }
      if (contains) continue;

      out.push(poly[(i - 1 + poly.length) % poly.length], poly[i], poly[(i + 1) % poly.length]);
      poly.splice(i, 1);
      clipped = true;
      break;
    }
    // No ear found: the ring is self-intersecting or fully degenerate.
    // Fanning is not correct in general, but it is the honest fallback --
    // it fills the hole, and dropDegenerate strips whatever is flat.
    if (!clipped) break;
  }
  for (let i = 1; i + 1 < poly.length; i++) out.push(poly[0], poly[i], poly[i + 1]);
  return out;
}

// ---------------------------------------------------------------------------
// Weights

function blendWeights(sources) {
  const out = {};
  let total = 0;
  for (const { weights, share } of sources) {
    if (!weights || share <= 0) continue;
    for (const [boneId, weight] of Object.entries(weights)) {
      out[boneId] = (out[boneId] || 0) + weight * share;
      total += weight * share;
    }
  }
  if (total > 0) for (const id of Object.keys(out)) out[id] /= total;
  return out;
}

// The removed vertex's hold on its bones is handed to the ring, nearest
// neighbours getting the largest share. Each neighbour ends up with its own
// weights blended toward the departing vertex's, in proportion to how much
// of the hole it is inheriting.
function redistributeWeights(mesh, index, ring) {
  const victim = mesh.vertices[index];
  if (!victim || Object.keys(victim.weights).length === 0) return;

  const shares = ring.map((id) => {
    const n = mesh.vertices[id];
    return 1 / Math.max(0.5, Math.hypot(n.u - victim.u, n.v - victim.v));
  });
  const total = shares.reduce((a, b) => a + b, 0);
  if (total <= 0) return;

  ring.forEach((id, i) => {
    const share = shares[i] / total;
    const neighbour = mesh.vertices[id];
    neighbour.weights = blendWeights([
      { weights: neighbour.weights, share: 1 - share },
      { weights: victim.weights, share },
    ]);
  });
}

// ---------------------------------------------------------------------------

// Strips flat triangles and exact duplicates. Both are holes in the
// artwork: rasterizeTriangle returns early on a zero area, and a duplicate
// is a second triangle claiming pixels another already owns.
function dropDegenerate(mesh, triangles) {
  const out = [];
  const seen = new Set();
  for (let i = 0; i < triangles.length; i += 3) {
    const ids = [triangles[i], triangles[i + 1], triangles[i + 2]];
    if (new Set(ids).size !== 3) continue;
    const a = mesh.vertices[ids[0]];
    const b = mesh.vertices[ids[1]];
    const c = mesh.vertices[ids[2]];
    if (!a || !b || !c) continue;
    if (triangleArea2(a, b, c) === 0) continue;
    const key = [...ids].sort((x, y) => x - y).join(',');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(...ids);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The validity check the tests assert on, exported so the app can use the
// same definition rather than a second opinion about what "valid" means.

export function meshProblems(mesh) {
  const problems = [];
  const used = new Set();
  const seen = new Set();
  for (let i = 0; i < mesh.triangles.length; i += 3) {
    const ids = [mesh.triangles[i], mesh.triangles[i + 1], mesh.triangles[i + 2]];
    for (const id of ids) {
      if (id < 0 || id >= mesh.vertices.length) problems.push(`triangle ${i / 3} references missing vertex ${id}`);
      used.add(id);
    }
    if (new Set(ids).size !== 3) problems.push(`triangle ${i / 3} repeats a vertex`);
    const [a, b, c] = ids.map((id) => mesh.vertices[id]);
    if (a && b && c && triangleArea2(a, b, c) === 0) problems.push(`triangle ${i / 3} is degenerate`);
    const key = [...ids].sort((x, y) => x - y).join(',');
    if (seen.has(key)) problems.push(`triangle ${i / 3} duplicates another`);
    seen.add(key);
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Carrying weights across a regenerated mesh
//
// Trimming the boundary reshapes the artwork, so the mesh has to be built
// again against the new bounds -- a mesh sized for the old silhouette left
// sitting on the new one is stale in exactly the way that produces stretched
// and detached artwork.
//
// But regenerating from scratch would throw away every hand-painted weight,
// and the user did not repaint the layer, they trimmed its edge. So the NEW
// vertices take their weights from where the OLD mesh had them: each new
// vertex reads the old mesh at the same place on the artwork and takes what
// it finds there, interpolated across whichever old triangle covers it.
//
// `offset` is where the old image's origin sits inside the new one, in
// texels, so the lookup compares the same physical pixel rather than the
// same coordinate -- a trim that crops the top-left moves every texel's
// index without moving the artwork at all.
//
// A new vertex over ground the old mesh did not cover -- which can only be
// area the trim did not retain -- gets nothing, which is the correct
// outcome: there is no weight painting for a region that was cut away.

export function transferWeights(oldMesh, newMesh, { offsetU = 0, offsetV = 0 } = {}) {
  let carried = 0;
  let orphaned = 0;
  for (const vertex of newMesh.vertices) {
    const u = vertex.u + offsetU;
    const v = vertex.v + offsetV;
    const hit = triangleAt(oldMesh, u, v);
    if (hit) {
      vertex.weights = blendWeights([
        { weights: oldMesh.vertices[hit.ids[0]].weights, share: hit.bary.w0 },
        { weights: oldMesh.vertices[hit.ids[1]].weights, share: hit.bary.w1 },
        { weights: oldMesh.vertices[hit.ids[2]].weights, share: hit.bary.w2 },
      ]);
      if (Object.keys(vertex.weights).length > 0) { carried++; continue; }
    }
    // Outside the old mesh: fall back to the nearest old vertex, so a new
    // vertex a texel beyond the old edge still lands on sensible weights
    // rather than on none at all.
    let best = null;
    let bestDistance = Infinity;
    for (const old of oldMesh.vertices) {
      const d = Math.hypot(old.u - u, old.v - v);
      if (d < bestDistance) { bestDistance = d; best = old; }
    }
    if (best && Object.keys(best.weights).length > 0) {
      vertex.weights = { ...best.weights };
      carried++;
    } else {
      vertex.weights = {};
      orphaned++;
    }
  }
  newMesh.bindPose = { ...oldMesh.bindPose };
  return { carried, orphaned, total: newMesh.vertices.length };
}

export function meshArea(mesh) {
  let total = 0;
  for (let i = 0; i < mesh.triangles.length; i += 3) {
    const a = mesh.vertices[mesh.triangles[i]];
    const b = mesh.vertices[mesh.triangles[i + 1]];
    const c = mesh.vertices[mesh.triangles[i + 2]];
    if (a && b && c) total += Math.abs(triangleArea2(a, b, c)) / 2;
  }
  return total;
}
