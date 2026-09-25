// PLink: drawn hinge connections between independent layers.
//
// WHAT A LINK IS
//
// Two layers imported separately -- a hand and an arm -- share no mesh, no
// weights and no vertices. Nothing relates them, so when either moves on its
// own bone a gap opens between them. That is not a bug in either layer; it is
// the correct result of two objects with no defined relationship. A PLink is
// that relationship: a point, drawn on the artwork, where two or more layers
// are to be considered JOINED.
//
// It is a HINGE, not a rigid attachment. The layers never part at the link
// point, but each still turns, bends and jiggles on its own bones -- they
// swing relative to one another AROUND the shared point, the way an elbow
// lets forearm and upper arm swing while staying joined.
//
// HOW IT IS HELD -- A CONSTRAINT, SOLVED EVERY FRAME
//
// Not T_child = T_parent * T_offset. That would glue the child rigidly to the
// parent's frame and turn it with the parent -- no hinge at all. Instead:
//
//   1. every linked layer is deformed exactly as it would be alone -- its own
//      bones, springs, pins, pierce -- and the link point is found on it;
//   2. each layer is then CORRECTED, as a rigid body, so that its link points
//      land on the shared positions: translated for one link, translated and
//      rotated (a least-squares rigid fit) when it has several;
//   3. repeated until every link agrees, because correcting one layer moves
//      the target for the next -- a chain of links settles in a few passes;
//   4. whatever a rigid correction cannot absorb -- two links pulling one
//      layer in incompatible directions -- is closed by a WELD: a local
//      displacement at that link point, fading out within a couple of mesh
//      cells, so the points coincide EXACTLY whatever the constraints ask.
//
// Rigid first, so a layer keeps its own shape wherever it can; the weld only
// ever takes up what is geometrically impossible to do rigidly.
//
// WHO GIVES WAY
//
// Each link names an ANCHOR: the member that holds still while the others are
// brought to it -- by default the layer closest to the skeleton's root, so a
// hand is brought to its arm and not the arm to the hand. Or none: SHARED, and
// every member gives way equally, meeting in the middle, as two free bodies at
// a hinge do. The choice is fixed per link rather than decided by whatever is
// being dragged, because a rule that changed with the finger would change the
// answer the moment the finger lifted, and the follower would jump.
//
// A follower's own rotation is untouched -- only its position is brought to
// the link. So whatever its bone does, it now does ABOUT the link point: a
// hand rotated on its own bone pivots at the wrist, and a hand carried by a
// swinging arm keeps its own angle. That is the hinge.
//
// WHERE THE CORRECTION IS APPLIED
//
// Inside mesh.js's deformVertices, through plinkState.js -- the one function
// every consumer of a layer's geometry already calls. So the renderer, Pierce,
// weight painting, the Free-Move drag and anything else see a linked layer
// exactly where it is drawn, and none of them had to learn what a link is.

import { partsStore } from './parts.js';
import { bonesStore } from './bones.js';
import { deformVerticesUncorrected, localToWorld, pinCarriageOffset } from './mesh.js';
import { pierceOffsets } from './pierceState.js';
import { registerPLinkSolver, carryByCorrection } from './plinkState.js';

const MAX_ITERATIONS = 32;
const CONVERGED = 1e-9; // scene px -- far below anything the grid can show
// A weld fades out over this many mesh cells from its link point. Two cells
// keeps every corner of the triangle holding the link point well inside the
// weld (at least half strength), so landing the point exactly never needs
// more than twice the residual at any vertex.
const WELD_CELLS = 2;
// Vertices this many texels (at least) from a link point are left unsnapped.
const UNSNAP_MIN_TEXELS = 3;

// ---------------------------------------------------------------------------
// The store

let nextLinkNumber = 1;

function freshId() {
  let id;
  do { id = `plink_${nextLinkNumber++}`; } while (plinkStore.byId(id));
  return id;
}

class PLinkStore {
  constructor() {
    this._links = [];
    this._listeners = new Set();
    this.version = 0;
  }

  get links() {
    return this._links;
  }

  byId(id) {
    return this._links.find((link) => link.id === id) || null;
  }

  linksFor(partId) {
    return this._links.filter((link) => link.members.some((m) => m.partId === partId));
  }

  subscribe(listener) {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  _emit() {
    this.version++;
    this._listeners.forEach((listener) => listener());
  }

  // members: [{ partId, u, v }] -- the link point in each layer's own texel
  // space. At least two distinct layers. anchorId: a member's partId, or
  // null for a shared link.
  add({ members, anchorId = null }) {
    const seen = new Set();
    const clean = [];
    for (const member of members || []) {
      if (!member || seen.has(member.partId)) continue;
      if (!Number.isFinite(member.u) || !Number.isFinite(member.v)) continue;
      seen.add(member.partId);
      clean.push({ partId: member.partId, u: member.u, v: member.v });
    }
    if (clean.length < 2) return null;
    const link = {
      id: freshId(),
      members: clean,
      anchorId: seen.has(anchorId) ? anchorId : null,
    };
    this._links.push(link);
    this._emit();
    return link;
  }

  remove(id) {
    const before = this._links.length;
    this._links = this._links.filter((link) => link.id !== id);
    if (this._links.length !== before) this._emit();
    return this._links.length !== before;
  }

  setAnchor(id, anchorId) {
    const link = this.byId(id);
    if (!link) return false;
    const next = link.members.some((m) => m.partId === anchorId) ? anchorId : null;
    if (link.anchorId === next) return false;
    link.anchorId = next;
    this._emit();
    return true;
  }

  // Drops members whose layer no longer exists, and any link left with fewer
  // than two. Deleting a layer therefore ends ITS links and touches nothing
  // else -- the other layers keep their data, and every other link stands.
  prune(existingPartIds) {
    const live = new Set(existingPartIds);
    let changed = false;
    const kept = [];
    for (const link of this._links) {
      const members = link.members.filter((m) => live.has(m.partId));
      if (members.length !== link.members.length) changed = true;
      if (members.length < 2) { changed = true; continue; }
      link.members = members;
      if (link.anchorId && !live.has(link.anchorId)) link.anchorId = null;
      kept.push(link);
    }
    if (changed) {
      this._links = kept;
      this._emit();
    }
    return changed;
  }

  // A layer's texture was cropped by (du, dv) texels (Mesh Trim): its link
  // points are in texel space, so they move with the crop to stay on the same
  // physical pixel.
  shiftAnchors(partId, du, dv) {
    let changed = false;
    for (const link of this._links) {
      for (const member of link.members) {
        if (member.partId !== partId) continue;
        member.u += du;
        member.v += dv;
        changed = true;
      }
    }
    if (changed) this._emit();
  }

  replaceAll(links) {
    this._links = (links || []).map((link) => ({
      id: link.id,
      anchorId: link.anchorId ?? null,
      members: link.members.map((m) => ({ partId: m.partId, u: m.u, v: m.v })),
    }));
    for (const link of this._links) {
      const n = Number(String(link.id).replace(/^plink_/, ''));
      if (Number.isFinite(n) && n >= nextLinkNumber) nextLinkNumber = n + 1;
    }
    this._emit();
  }
}

export const plinkStore = new PLinkStore();

// ---------------------------------------------------------------------------
// Persistence -- part of the project, so save, load, autosave, PSaver files
// and undo all carry links without any of them knowing.

export function serializePLinks() {
  return plinkStore.links.map((link) => ({
    id: link.id,
    anchorId: link.anchorId,
    members: link.members.map((m) => ({ partId: m.partId, u: m.u, v: m.v })),
  }));
}

// A link from a file is outside data: every field is checked, and a link that
// fails is dropped rather than trusted. Links to layers the project does not
// have are pruned the same way a deleted layer's would be.
export function deserializePLinks(data, partIds) {
  const live = new Set(partIds);
  const links = [];
  for (const raw of Array.isArray(data) ? data : []) {
    if (!raw || typeof raw.id !== 'string' || !Array.isArray(raw.members)) continue;
    const members = raw.members.filter((m) => m && typeof m.partId === 'string' && live.has(m.partId)
      && Number.isFinite(m.u) && Number.isFinite(m.v));
    const unique = [...new Map(members.map((m) => [m.partId, m])).values()];
    if (unique.length < 2) continue;
    const anchorId = unique.some((m) => m.partId === raw.anchorId) ? raw.anchorId : null;
    links.push({ id: raw.id, anchorId, members: unique });
  }
  return links;
}

// ---------------------------------------------------------------------------
// Geometry: where a layer's point is, and back

// A layer's geometry as the renderer draws it, before PLink: vertex
// positions, and the texel coordinates they carry. The same decision the
// renderer makes -- a bound or pierce-driven layer through its mesh, anything
// else as its plain quad -- so the solve works on what is actually drawn.
function layerGeometry(part, transforms) {
  const mesh = part.mesh;
  if (mesh && (mesh.isBound || pierceOffsets(part))) {
    return {
      mesh,
      positions: deformVerticesUncorrected(mesh, part, transforms),
      uvs: mesh.vertices,
      triangles: mesh.triangles,
    };
  }
  const w = part.naturalWidth;
  const h = part.naturalHeight;
  const uvs = [{ u: 0, v: 0 }, { u: w, v: 0 }, { u: w, v: h }, { u: 0, v: h }];
  return {
    mesh: null,
    positions: uvs.map((t) => localToWorld(part, { x: t.u - w / 2, y: t.v - h / 2 })),
    uvs,
    triangles: [0, 1, 3, 1, 2, 3],
  };
}

function barycentric(a, b, c, u, v) {
  const den = (b.v - c.v) * (a.u - c.u) + (c.u - b.u) * (a.v - c.v);
  if (Math.abs(den) < 1e-12) return null;
  const l0 = ((b.v - c.v) * (u - c.u) + (c.u - b.u) * (v - c.v)) / den;
  const l1 = ((c.v - a.v) * (u - c.u) + (a.u - c.u) * (v - c.v)) / den;
  return [l0, l1, 1 - l0 - l1];
}

// The triangle a texel point sits in, with its barycentric coordinates. A
// point outside the mesh -- a hinge drawn just past a layer's edge -- uses
// the NEAREST triangle, extended affinely: the layer carries the point as if
// its surface continued a little past its own edge.
function locate(geometry, u, v) {
  const { uvs, triangles } = geometry;
  let best = null;
  let bestOutside = Infinity;
  for (let t = 0; t < triangles.length; t += 3) {
    const ids = [triangles[t], triangles[t + 1], triangles[t + 2]];
    const bary = barycentric(uvs[ids[0]], uvs[ids[1]], uvs[ids[2]], u, v);
    if (!bary) continue;
    const outside = Math.max(0, -bary[0], -bary[1], -bary[2]);
    if (outside < bestOutside) { bestOutside = outside; best = { ids, bary }; }
    if (outside === 0) break;
  }
  return best;
}

function landing(geometry, located) {
  const { positions } = geometry;
  const [a, b, c] = located.ids.map((i) => positions[i]);
  const [l0, l1, l2] = located.bary;
  return { x: l0 * a.x + l1 * b.x + l2 * c.x, y: l0 * a.y + l1 * b.y + l2 * c.y };
}

// The inverse: where a SCENE point falls in a layer's texel space, through the
// layer's current geometry -- how a point drawn on the screen becomes a point
// on each layer's artwork. Nearest triangle, extended, as above.
export function sceneToTexel(part, point, transforms = currentTransforms()) {
  const geometry = layerGeometry(part, transforms);
  const correction = solveFor(transforms).get(part.id) || null;
  const positions = correction
    ? geometry.positions.map((p) => carryByCorrection(correction, p))
    : geometry.positions;
  const { uvs, triangles } = geometry;
  let best = null;
  let bestOutside = Infinity;
  for (let t = 0; t < triangles.length; t += 3) {
    const ids = [triangles[t], triangles[t + 1], triangles[t + 2]];
    const [a, b, c] = ids.map((i) => positions[i]);
    const den = (b.y - c.y) * (a.x - c.x) + (c.x - b.x) * (a.y - c.y);
    if (Math.abs(den) < 1e-12) continue;
    const l0 = ((b.y - c.y) * (point.x - c.x) + (c.x - b.x) * (point.y - c.y)) / den;
    const l1 = ((c.y - a.y) * (point.x - c.x) + (a.x - c.x) * (point.y - c.y)) / den;
    const l2 = 1 - l0 - l1;
    const outside = Math.max(0, -l0, -l1, -l2);
    if (outside < bestOutside) {
      bestOutside = outside;
      const [ua, ub, uc] = ids.map((i) => uvs[i]);
      best = { u: l0 * ua.u + l1 * ub.u + l2 * uc.u, v: l0 * ua.v + l1 * ub.v + l2 * uc.v };
    }
    if (outside === 0) break;
  }
  return best;
}

// How far a texel point is from the nearest opaque texel of a layer, in
// texels -- so the tool can say when a link is being drawn on empty space.
export function distanceToArtwork(part, u, v) {
  const W = part.naturalWidth;
  const H = part.naturalHeight;
  let best = Infinity;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (part.pixels[(y * W + x) * 4 + 3] === 0) continue;
      const dx = Math.max(0, Math.abs(u - (x + 0.5)) - 0.5);
      const dy = Math.max(0, Math.abs(v - (y + 0.5)) - 0.5);
      const d = Math.hypot(dx, dy);
      if (d < best) best = d;
      if (best === 0) return 0;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// The solve

const IDENTITY = Object.freeze({ cos: 1, sin: 0, from: { x: 0, y: 0 }, to: { x: 0, y: 0 } });

// Least-squares rigid fit of source points onto target points (2D Kabsch):
// the rotation and translation that best carry one set onto the other. One
// pair is a pure translation -- a single link leaves the layer's rotation to
// its own bones, which is exactly what makes it a hinge.
function rigidFit(pairs) {
  if (pairs.length === 0) return IDENTITY;
  let ax = 0, ay = 0, bx = 0, by = 0;
  for (const { from, to } of pairs) { ax += from.x; ay += from.y; bx += to.x; by += to.y; }
  ax /= pairs.length; ay /= pairs.length; bx /= pairs.length; by /= pairs.length;
  if (pairs.length === 1) return { cos: 1, sin: 0, from: { x: ax, y: ay }, to: { x: bx, y: by } };
  let dot = 0;
  let cross = 0;
  for (const { from, to } of pairs) {
    const fx = from.x - ax, fy = from.y - ay;
    const tx = to.x - bx, ty = to.y - by;
    dot += fx * tx + fy * ty;
    cross += fx * ty - fy * tx;
  }
  const angle = Math.hypot(dot, cross) < 1e-12 ? 0 : Math.atan2(cross, dot);
  return { cos: Math.cos(angle), sin: Math.sin(angle), from: { x: ax, y: ay }, to: { x: bx, y: by } };
}

// The welds for one layer: a smooth bump of displacement at each link point,
// sized so that every link point lands EXACTLY where its link wants it.
//
// A weld fades out over `radius` texels. Two link points closer than that
// on the same layer share vertices, so each weld also nudges the other's
// point -- sizing each alone would leave both off by the overlap. So they are
// sized TOGETHER: the displacement a link point receives is a fixed linear
// blend of every weld (its triangle's barycentric weights times each weld's
// fade at those three vertices), and requiring that blend to equal each
// point's residual is a small square system, solved exactly. One link point
// is the familiar case, a single division.
function weldFade(t, site) {
  const d = Math.hypot(t.u - site.member.u, t.v - site.member.v);
  const x = Math.max(0, Math.min(1, 1 - d / site.radius));
  return x * x * (3 - 2 * x);
}

function solveWelds(mesh, sites) {
  if (sites.length === 0 || sites.every((s) => Math.hypot(s.dx, s.dy) < 1e-12)) return [];
  const n = sites.length;
  // A[j][k]: how much of weld k reaches link point j.
  const A = sites.map(({ located: { ids, bary } }) => sites.map((site) =>
    ids.reduce((sum, vi, c) => sum + bary[c] * weldFade(mesh.vertices[vi], site), 0)));
  const rows = A.map((row, j) => [...row, sites[j].dx, sites[j].dy]);
  // Gauss-Jordan with partial pivoting. A column with no usable pivot is two
  // link points on the same spot of this layer asking for different things
  // -- impossible for any mesh -- and simply gets no weld of its own.
  const solved = new Array(n).fill(null);
  const used = new Array(n).fill(false);
  for (let col = 0; col < n; col++) {
    let pivot = -1;
    for (let r = 0; r < n; r++) {
      if (!used[r] && (pivot < 0 || Math.abs(rows[r][col]) > Math.abs(rows[pivot][col]))) pivot = r;
    }
    if (pivot < 0 || Math.abs(rows[pivot][col]) < 1e-9) continue;
    used[pivot] = true;
    solved[col] = pivot;
    const p = rows[pivot][col];
    for (let c = 0; c < n + 2; c++) rows[pivot][c] /= p;
    for (let r = 0; r < n; r++) {
      if (r === pivot || rows[r][col] === 0) continue;
      const f = rows[r][col];
      for (let c = 0; c < n + 2; c++) rows[r][c] -= f * rows[pivot][c];
    }
  }
  const welds = [];
  sites.forEach((site, k) => {
    const r = solved[k];
    if (r === null) return;
    const dx = rows[r][n];
    const dy = rows[r][n + 1];
    if (Math.hypot(dx, dy) < 1e-12) return;
    welds.push({ u: site.member.u, v: site.member.v, dx, dy, radius: site.radius, scale: 1 });
  });
  return welds;
}

// The default anchor for a new link: the member on the bone nearest the
// skeleton's root. A layer with no bone at all never anchors while one with a
// bone is present -- unbound artwork is what gets brought to the rig, not the
// other way round. Ties go to the first layer chosen.
export function defaultAnchor(partIds) {
  let best = null;
  let bestDepth = Infinity;
  for (const partId of partIds) {
    const bone = bonesStore.bonesAttachedTo(partId)[0];
    if (!bone) continue;
    let depth = 0;
    for (let b = bone; b && b.parentId; b = bonesStore.byId(b.parentId)) depth++;
    if (depth < bestDepth) { bestDepth = depth; best = partId; }
  }
  return best;
}

// The last few solves, keyed by the transforms object they were solved
// against. The renderer takes ONE snapshot per frame and hands it to every
// layer, so a frame solves once however many layers ask; anything that
// takes its own snapshot (Pierce, the brush) gets a fresh solve, correctly.
const NO_BONES = Object.freeze({});
let cache = new WeakMap();
let cacheStamp = '';
let partsVersion = 0;

function stamp() {
  return `${plinkStore.version}|${partsVersion}`;
}

export function currentTransforms() {
  return bonesStore.isEmpty ? NO_BONES : bonesStore.snapshotTransforms();
}

// Every linked layer's correction under these transforms: Map partId ->
// { cos, sin, from, to, welds, nearLink, uncorrected, mesh }.
function solveFor(transforms) {
  const key = transforms || NO_BONES;
  // A scene with no bones hands every frame the same shared empty set, so
  // its identity says nothing about which frame it is -- and a pierced
  // layer's offsets still move between frames. Never cached, then; with no
  // skeleton there is little to solve.
  if (Object.keys(key).length === 0) return solve(key);
  const s = stamp();
  if (s !== cacheStamp) { cache = new WeakMap(); cacheStamp = s; }
  const hit = cache.get(key);
  if (hit) return hit;
  const result = solve(key);
  cache.set(key, result);
  return result;
}

export function solve(transforms) {
  const result = new Map();
  const partsById = new Map(partsStore.parts.map((part) => [part.id, part]));
  const links = plinkStore.links
    .map((link) => ({ ...link, members: link.members.filter((m) => partsById.has(m.partId)) }))
    .filter((link) => link.members.length >= 2);
  if (links.length === 0) return result;

  // 1. Each linked layer deformed on its own, and its link points found.
  const geometry = new Map();
  for (const link of links) {
    for (const member of link.members) {
      if (!geometry.has(member.partId)) {
        geometry.set(member.partId, layerGeometry(partsById.get(member.partId), transforms));
      }
    }
  }
  const points = links.map((link) => link.members.map((member) => {
    const g = geometry.get(member.partId);
    const located = locate(g, member.u, member.v);
    return located ? { located, at: landing(g, located) } : null;
  }));

  // 2-3. Rigid corrections, iterated until every link agrees.
  const corrections = new Map([...geometry.keys()].map((id) => [id, IDENTITY]));
  const carry = (id, p) => carryByCorrection(corrections.get(id), p);
  const targetOf = (link, k) => {
    const pts = points[k];
    const anchorIndex = link.members.findIndex((m) => m.partId === link.anchorId);
    if (anchorIndex >= 0 && pts[anchorIndex]) return carry(link.anchorId, pts[anchorIndex].at);
    let x = 0, y = 0, n = 0;
    link.members.forEach((m, i) => {
      if (!pts[i]) return;
      const p = carry(m.partId, pts[i].at);
      x += p.x; y += p.y; n++;
    });
    return n ? { x: x / n, y: y / n } : null;
  };

  let targets = [];
  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    targets = links.map((link, k) => targetOf(link, k));
    // Each layer fitted to the links it GIVES WAY in -- not the ones it
    // anchors, where by definition it holds still.
    for (const id of geometry.keys()) {
      const pairs = [];
      links.forEach((link, k) => {
        if (link.anchorId === id || !targets[k]) return;
        const i = link.members.findIndex((m) => m.partId === id);
        if (i < 0 || !points[k][i]) return;
        pairs.push({ from: points[k][i].at, to: targets[k] });
      });
      corrections.set(id, rigidFit(pairs));
    }
    let worst = 0;
    links.forEach((link, k) => {
      const target = targetOf(link, k);
      if (!target) return;
      link.members.forEach((m, i) => {
        if (!points[k][i]) return;
        const p = carry(m.partId, points[k][i].at);
        worst = Math.max(worst, Math.hypot(p.x - target.x, p.y - target.y));
      });
    });
    if (worst < CONVERGED) break;
  }
  targets = links.map((link, k) => targetOf(link, k));

  // 4. Whatever the rigid fit could not do, a weld does exactly.
  for (const [id, g] of geometry) {
    const part = partsById.get(id);
    const cellU = g.mesh ? part.naturalWidth / Math.max(1, g.mesh.cols) : part.naturalWidth;
    const cellV = g.mesh ? part.naturalHeight / Math.max(1, g.mesh.rows) : part.naturalHeight;
    const radius = Math.max(UNSNAP_MIN_TEXELS, WELD_CELLS * Math.hypot(cellU, cellV));
    // Every link point on this layer, with how far it still is from where
    // its link wants it -- zero where the layer anchors, or where the rigid
    // fit already put it. Zeros are kept: a weld must not drag a point that
    // is already right, so those points are held by the same solve.
    const sites = [];
    links.forEach((link, k) => {
      const i = link.members.findIndex((m) => m.partId === id);
      if (i < 0 || !points[k][i]) return;
      const at = carry(id, points[k][i].at);
      const target = targets[k] || at;
      const member = link.members[i];
      const located = points[k][i].located;
      // A point drawn just past the layer's edge is carried by the nearest
      // triangle extended, whose corners can sit further off than a couple
      // of cells. The zone around the point always takes in that whole
      // triangle, so the weld reaches it and none of it is snapped.
      let reach = radius;
      if (g.mesh) {
        for (const vi of located.ids) {
          const t = g.mesh.vertices[vi];
          reach = Math.max(reach, 1.5 * Math.hypot(t.u - member.u, t.v - member.v));
        }
      }
      sites.push({ member, located, radius: reach, dx: target.x - at.x, dy: target.y - at.y });
    });
    const welds = g.mesh ? solveWelds(g.mesh, sites) : [];
    const nearLink = g.mesh
      ? g.mesh.vertices.map((t) => sites.some(({ member: a, radius: r }) => Math.hypot(t.u - a.u, t.v - a.v) <= r))
      : null;
    const c = corrections.get(id);
    result.set(id, {
      cos: c.cos, sin: c.sin, from: c.from, to: c.to,
      welds, nearLink, uncorrected: g.mesh ? g.positions : null, mesh: g.mesh,
    });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Questions the rest of the app asks

// The registered hook: mesh.js calls this from deformVertices.
function correctionFor(part, transforms) {
  if (plinkStore.links.length === 0 || !part) return null;
  return solveFor(transforms).get(part.id) || null;
}

export function isLinked(part) {
  return Boolean(part) && plinkStore.links.some((link) => link.members.some((m) => m.partId === part.id));
}

// A scene point carried by a layer's current PLink correction -- for code
// that places a layer's own points without going through its mesh: Pierce's
// painted regions, the Free-Move drag's pivot, the Px Pin window.
export function carryPoint(part, point, transforms = currentTransforms()) {
  if (!isLinked(part)) return { x: point.x, y: point.y };
  return carryByCorrection(solveFor(transforms).get(part.id) || null, point);
}

// A layer's rigid PLink correction under these transforms, or null when it
// has no links -- for code that caches scene points and needs to know when
// the correction has changed underneath it.
export function correctionOf(part, transforms = currentTransforms()) {
  if (!isLinked(part)) return null;
  return solveFor(transforms).get(part.id) || null;
}

// How far PLink has shifted a layer, taken at its centre: for the full-screen
// windows (Px Pin, Pierce) that draw each layer as a flat, unrotated bitmap
// at its bones' carriage. Zero for a layer with no links.
export function linkShift(part, transforms = currentTransforms()) {
  if (!isLinked(part)) return { x: 0, y: 0 };
  const carriage = pinCarriageOffset(part, transforms);
  const centre = localToWorld(part, { x: 0, y: 0 });
  const at = { x: centre.x + carriage.x, y: centre.y + carriage.y };
  const moved = carryPoint(part, at, transforms);
  return { x: moved.x - at.x, y: moved.y - at.y };
}

// The quad an UNBOUND linked layer is drawn as, corrected: the renderer's quad
// path has no mesh for deformVertices to correct, so it asks here.
export function correctQuad(part, corners, transforms) {
  const correction = correctionFor(part, transforms);
  return correction ? corners.map((p) => carryByCorrection(correction, p)) : corners;
}

// Where every link point is right now, per member, after the solve -- for the
// tool's markers and for tests that want to know the constraint held.
export function linkPositions(transforms = currentTransforms()) {
  const out = [];
  const partsById = new Map(partsStore.parts.map((part) => [part.id, part]));
  const solved = solveFor(transforms);
  for (const link of plinkStore.links) {
    const members = [];
    for (const member of link.members) {
      const part = partsById.get(member.partId);
      if (!part) continue;
      const g = layerGeometry(part, transforms);
      const located = locate(g, member.u, member.v);
      if (!located) continue;
      const c = solved.get(part.id);
      let p = landing(g, located);
      if (c) {
        // The corrected landing: the rigid part, plus the welds evaluated at
        // the three corners of the triangle the point sits in.
        const corrected = located.ids.map((vi) => {
          let q = carryByCorrection(c, g.positions[vi]);
          if (g.mesh) {
            for (const weld of c.welds) {
              const t = g.mesh.vertices[vi];
              const d = Math.hypot(t.u - weld.u, t.v - weld.v);
              const x = Math.max(0, Math.min(1, 1 - d / weld.radius));
              const k = x * x * (3 - 2 * x) * weld.scale;
              q = { x: q.x + weld.dx * k, y: q.y + weld.dy * k };
            }
          }
          return q;
        });
        const [l0, l1, l2] = located.bary;
        p = {
          x: l0 * corrected[0].x + l1 * corrected[1].x + l2 * corrected[2].x,
          y: l0 * corrected[0].y + l1 * corrected[1].y + l2 * corrected[2].y,
        };
      }
      members.push({ partId: part.id, x: p.x, y: p.y });
    }
    out.push({ id: link.id, anchorId: link.anchorId, members });
  }
  return out;
}

export function initPLink() {
  registerPLinkSolver(correctionFor);
  // Any change to any layer -- moved, re-bound, re-meshed, pins, pierce
  // regions -- can move a link point, so the solve cache is keyed on it.
  partsStore.subscribe(() => {
    partsVersion++;
    // A deleted layer takes its links with it, and only its links.
    plinkStore.prune(partsStore.parts.map((part) => part.id));
  });
}
