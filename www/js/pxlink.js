// PxLink: drawn hinge connections between independent layers.
//
// WHAT A LINK IS
//
// Two layers imported separately -- a hand and an arm -- share no mesh, no
// weights and no vertices. Nothing relates them, so when either moves on its
// own bone a gap opens between them. That is not a bug in either layer; it is
// the correct result of two objects with no defined relationship. A PxLink is
// that relationship: a point, drawn on the artwork, where two or more layers
// are to be considered JOINED.
//
// It holds the two pieces of artwork together AT THAT POINT, and nowhere
// else. Each layer still turns, bends, jiggles and is dragged on its own
// bones exactly as it would be unlinked; the link only makes sure that,
// whatever those bones did this frame, the two link points are on the same
// spot.
//
// HOW IT IS HELD -- LIVE, EVERY FRAME, AND ONLY AT THE LINK POINT
//
//   1. every linked layer is deformed exactly as it would be alone -- its own
//      bones, springs, pivots, pins, pierce, and whatever the drag just did
//      -- and each link point is found on it, where it is RIGHT NOW;
//   2. each link's meeting point is worked out from those current points
//      alone: the anchor's own point if the link has one, else the middle
//      of all of them;
//   3. every member that gives way gets a WELD: a smooth local displacement
//      centred on its link point that lands that point exactly on the
//      meeting point and fades to nothing with distance. Everything outside
//      it is untouched -- drawn precisely where the layer's own systems put
//      it.
//
// There is no memory: nothing about where the layers were when the link was
// made, or last frame, enters the solve. And there is no whole-layer
// correction. The first version moved each follower rigidly so its link
// point sat on the anchor's, which overrode whatever the follower's own bone
// did to its position: a dragged follower was snapped back onto the link and
// could only pivot about it, and a follower's spring could only show as a
// turn about the link. That is replaced by the weld alone.
//
// A weld is sized to the gap it closes -- a couple of mesh cells at the
// least, and at least two and a half times the distance its point has to
// travel -- so closing a big gap bends the neighbourhood of the link point
// gently instead of shearing a sliver of it, and can never fold the mesh
// over itself (a smoothstep bump steeper than that could).
//
// WHO GIVES WAY
//
// Each link names an ANCHOR: the member whose link point stays exactly where
// its own layer puts it, the others' points coming to meet it -- by default
// the layer closest to the skeleton's root, so a hand's wrist meets its arm's
// and not the arm's the hand's. Or none: SHARED, and every member's point
// moves halfway, meeting in the middle. Either way, only the neighbourhood of
// each point moves; to make one layer CARRY another, put the second's bone
// under the first's -- the skeleton is what carries, the link is what joins.
//
// WHERE THE CORRECTION IS APPLIED
//
// Inside mesh.js's deformVertices, through pxlinkState.js -- the one function
// every consumer of a layer's geometry already calls. So the renderer, Pierce,
// weight painting, the Free-Move drag and anything else see a linked layer
// exactly where it is drawn, and none of them had to learn what a link is. A
// linked layer that was never bound is given a mesh (identity skinning, so it
// is drawn exactly as before) so that it, too, can be welded locally.

import { partsStore } from './parts.js';
import { bonesStore } from './bones.js';
import {
  deformVerticesUncorrected, applyLinkWelds, generateMesh, defaultDensity,
} from './mesh.js';
import { registerPxLinkSolver, locateTexel, landTexel } from './pxlinkState.js';

// A weld fades out over this many mesh cells from its link point. Two cells
// keeps every corner of the triangle holding the link point well inside the
// weld (at least half strength), so landing the point exactly never needs
// more than twice the residual at any vertex.
const WELD_CELLS = 2;
// Vertices this many texels (at least) from a link point are left unsnapped.
const UNSNAP_MIN_TEXELS = 3;
// A weld's reach, in multiples of the distance its point has to travel. A
// smoothstep bump folds the mesh once its reach is under 1.5 times its
// height; two and a half keeps a clear margin and bends gently.
const WELD_SPREAD = 2.5;

// ---------------------------------------------------------------------------
// The store

let nextLinkNumber = 1;

function freshId() {
  let id;
  do { id = `pxlink_${nextLinkNumber++}`; } while (pxlinkStore.byId(id));
  return id;
}

class PxLinkStore {
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
      const n = Number(String(link.id).replace(/^pxlink_/, ''));
      if (Number.isFinite(n) && n >= nextLinkNumber) nextLinkNumber = n + 1;
    }
    this._emit();
  }
}

export const pxlinkStore = new PxLinkStore();

// ---------------------------------------------------------------------------
// Persistence -- part of the project, so save, load, autosave, PSaver files
// and undo all carry links without any of them knowing.

export function serializePxLinks() {
  return pxlinkStore.links.map((link) => ({
    id: link.id,
    anchorId: link.anchorId,
    members: link.members.map((m) => ({ partId: m.partId, u: m.u, v: m.v })),
  }));
}

// Projects saved before the tool was named PxLink carry their links under its
// old name -- the project key and each link's id prefix. They are read the
// same way, so renaming the tool loses nobody's work; they are written back
// under the new name on the next save.
export const LEGACY_PROJECT_KEY = 'plinks';
const LEGACY_ID = /^plink_/;

// A link from a file is outside data: every field is checked, and a link that
// fails is dropped rather than trusted. Links to layers the project does not
// have are pruned the same way a deleted layer's would be.
export function deserializePxLinks(data, partIds) {
  const live = new Set(partIds);
  const links = [];
  for (const raw of Array.isArray(data) ? data : []) {
    if (!raw || typeof raw.id !== 'string' || !Array.isArray(raw.members)) continue;
    const members = raw.members.filter((m) => m && typeof m.partId === 'string' && live.has(m.partId)
      && Number.isFinite(m.u) && Number.isFinite(m.v));
    const unique = [...new Map(members.map((m) => [m.partId, m])).values()];
    if (unique.length < 2) continue;
    const anchorId = unique.some((m) => m.partId === raw.anchorId) ? raw.anchorId : null;
    links.push({ id: raw.id.replace(LEGACY_ID, 'pxlink_'), anchorId, members: unique });
  }
  return links;
}

// ---------------------------------------------------------------------------
// Geometry: where a layer's point is, and back

// A linked layer is always drawn through a mesh, because a weld is a local
// bend and a plain quad has nothing between its corners to bend. A layer that
// was never bound gets the same unbound mesh Pierce gives a pierced layer:
// no bind pose, no weights, so skinning is the identity and it is drawn
// exactly as its quad was. Binding it later replaces the mesh as usual.
export function ensureLinkMesh(part) {
  if (!part.mesh) part.mesh = generateMesh(part, defaultDensity(part));
  return part.mesh;
}

// A layer's geometry as the renderer draws it, before PxLink: vertex
// positions -- its own bones, springs, pins and V, nothing else -- and the
// texel coordinates they carry.
function layerGeometry(part, transforms) {
  const mesh = ensureLinkMesh(part);
  return {
    mesh,
    positions: deformVerticesUncorrected(mesh, part, transforms),
    uvs: mesh.vertices,
    triangles: mesh.triangles,
  };
}

// A layer's positions with its welds applied -- what is drawn (mesh.js's
// own function, so the two can never disagree).
function welded(geometry, correction) {
  return applyLinkWelds(geometry.mesh, geometry.positions, correction);
}

// The triangle a texel point sits in, and where it lands -- pxlinkState.js's
// locateTexel/landTexel, the same two functions a pierced half uses to find
// its hinge.
function locate(geometry, u, v) {
  return locateTexel(geometry.uvs, geometry.triangles, u, v);
}

function landing(geometry, located) {
  return landTexel(geometry.positions, located);
}

// The inverse: where a SCENE point falls in a layer's texel space, through the
// layer's current geometry -- how a point drawn on the screen becomes a point
// on each layer's artwork. Nearest triangle, extended, as above.
export function sceneToTexel(part, point, transforms = currentTransforms()) {
  const geometry = layerGeometry(part, transforms);
  const positions = welded(geometry, solveFor(transforms).get(part.id) || null);
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
    welds.push({ u: site.member.u, v: site.member.v, dx, dy, radius: site.radius });
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
  return `${pxlinkStore.version}|${partsVersion}`;
}

export function currentTransforms() {
  return bonesStore.isEmpty ? NO_BONES : bonesStore.snapshotTransforms();
}

// Every linked layer's correction under these transforms: Map partId ->
// { welds, nearLink, uncorrected, mesh }.
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
  const links = pxlinkStore.links
    .map((link) => ({ ...link, members: link.members.filter((m) => partsById.has(m.partId)) }))
    .filter((link) => link.members.length >= 2);
  if (links.length === 0) return result;

  // 1. Each linked layer exactly as its own systems put it this frame, and
  //    its link points found on it.
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

  // 2. Each link's meeting point, from those current points alone: the
  //    anchor's own point, or the middle of all of them. No iteration is
  //    needed -- every weld below lands its point EXACTLY, anchored points
  //    included (held at zero), so one pass is already the answer.
  const targets = links.map((link, k) => {
    const pts = points[k];
    const anchorIndex = link.members.findIndex((m) => m.partId === link.anchorId);
    if (anchorIndex >= 0 && pts[anchorIndex]) return pts[anchorIndex].at;
    let x = 0, y = 0, n = 0;
    for (const p of pts) { if (!p) continue; x += p.at.x; y += p.at.y; n++; }
    return n ? { x: x / n, y: y / n } : null;
  });

  // 3. A weld at every link point that has to move, sized to how far.
  for (const [id, g] of geometry) {
    const part = partsById.get(id);
    const cellU = part.naturalWidth / Math.max(1, g.mesh.cols || 1);
    const cellV = part.naturalHeight / Math.max(1, g.mesh.rows || 1);
    const radius = Math.max(UNSNAP_MIN_TEXELS, WELD_CELLS * Math.hypot(cellU, cellV));
    const scale = Math.max(1e-6, part.scale || 1);
    // Every link point on this layer, with how far it is from its link's
    // meeting point -- zero where the layer anchors. Zeros are kept: a weld
    // must not drag a point that is already right, so those points are held
    // by the same solve.
    const sites = [];
    links.forEach((link, k) => {
      const i = link.members.findIndex((m) => m.partId === id);
      if (i < 0 || !points[k][i]) return;
      const { at, located } = points[k][i];
      const target = targets[k] || at;
      const member = link.members[i];
      const dx = target.x - at.x;
      const dy = target.y - at.y;
      // A point drawn just past the layer's edge is carried by the nearest
      // triangle extended, whose corners can sit further off than a couple
      // of cells: the weld always takes in that whole triangle.
      let hold = radius;
      for (const vi of located.ids) {
        const t = g.mesh.vertices[vi];
        hold = Math.max(hold, 1.5 * Math.hypot(t.u - member.u, t.v - member.v));
      }
      // And it reaches further the further the point has to go -- WELD_SPREAD
      // times the distance, in this layer's texels -- so it bends, never
      // folds.
      const reach = Math.max(hold, WELD_SPREAD * Math.hypot(dx, dy) / scale);
      sites.push({ member, located, radius: reach, hold, dx, dy });
    });
    const welds = solveWelds(g.mesh, sites);
    // The vertices left unsnapped, so the members' link points land on the
    // very same spot rather than each rounded its own way: the fixed
    // neighbourhood of each point, NOT the whole reach. The wider bend steps
    // in whole pixels like the rest of the layer -- and a zone that grew and
    // shrank with the gap would flip vertices between rounded and unrounded
    // mid-drag, a half-pixel shimmer at its edge.
    const nearLink = g.mesh.vertices.map((t) => sites.some(({ member: a, hold }) => Math.hypot(t.u - a.u, t.v - a.v) <= hold));
    result.set(id, { welds, nearLink, uncorrected: g.positions, mesh: g.mesh });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Questions the rest of the app asks

// The registered hook: mesh.js calls this from deformVertices.
function correctionFor(part, transforms) {
  if (pxlinkStore.links.length === 0 || !part) return null;
  return solveFor(transforms).get(part.id) || null;
}

export function isLinked(part) {
  return Boolean(part) && pxlinkStore.links.some((link) => link.members.some((m) => m.partId === part.id));
}

// Where every link point is right now, per member, after the solve -- for the
// tool's markers and for tests that want to know the constraint held.
export function linkPositions(transforms = currentTransforms()) {
  const out = [];
  const partsById = new Map(partsStore.parts.map((part) => [part.id, part]));
  const solved = solveFor(transforms);
  for (const link of pxlinkStore.links) {
    const members = [];
    for (const member of link.members) {
      const part = partsById.get(member.partId);
      if (!part) continue;
      const g = layerGeometry(part, transforms);
      const located = locate(g, member.u, member.v);
      if (!located) continue;
      // Where the point is drawn: its triangle's corners with the welds on.
      const p = landing({ positions: welded(g, solved.get(part.id) || null) }, located);
      members.push({ partId: part.id, x: p.x, y: p.y });
    }
    out.push({ id: link.id, anchorId: link.anchorId, members });
  }
  return out;
}

export function initPxLink() {
  registerPxLinkSolver(correctionFor);
  // Any change to any layer -- moved, re-bound, re-meshed, pins, pierce
  // regions -- can move a link point, so the solve cache is keyed on it.
  partsStore.subscribe(() => {
    partsVersion++;
    // A deleted layer takes its links with it, and only its links.
    pxlinkStore.prune(partsStore.parts.map((part) => part.id));
  });
}
