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
// made, or last frame, enters the solve.
//
// ONE POINT IS A JOINT; TWO OR MORE ATTACH
//
// A single link point between two layers is a joint: each keeps its own
// bones and only the neighbourhood of the point is welded. (The first
// version moved such a follower rigidly onto the anchor, which snapped a
// dragged hand back onto its wrist and turned its spring into a pivot about
// the link -- so a joint is never moved as a whole.)
//
// Two or more link points between the SAME two layers say something else:
// that one is fixed ON the other, the way a patch is sewn on at several
// places. A joint about two points cannot turn at all, so the layer has to
// go wherever the other one takes it -- as a whole. So before any weld, an
// ATTACHED layer is given the one rotation and translation that best carries
// its link points onto the other layer's (a least-squares rigid fit), and
// moved by it, every vertex; the welds then close only what is left, which
// is the little the two layers' own shapes disagree by. Its own shape is
// never stretched to make it fit, however violently the layer beneath it is
// thrown, and however far the links had to bring it from where it was drawn.
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
// (The whole-layer move first, then the welds -- applyLinkWelds.)
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
  deformVerticesUncorrected, applyLinkWelds, generateMesh, defaultDensity, meshCellSize,
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

// A link's members, checked: distinct layers, finite texel points, and for a
// brush link the same number of points on every member (at least one). Null
// when fewer than two layers survive.
function cleanMembers(members, kind) {
  const brush = kind === 'brush';
  const seen = new Set();
  const clean = [];
  for (const member of members || []) {
    if (!member || seen.has(member.partId)) continue;
    if (brush) {
      if (!Array.isArray(member.points) || member.points.length === 0) continue;
      if (!member.points.every((p) => p && Number.isFinite(p.u) && Number.isFinite(p.v))) continue;
      const points = member.points.map((p) => ({ u: p.u, v: p.v }));
      const u = points.reduce((sum, p) => sum + p.u, 0) / points.length;
      const v = points.reduce((sum, p) => sum + p.v, 0) / points.length;
      seen.add(member.partId);
      clean.push({ partId: member.partId, u, v, points });
      continue;
    }
    if (!Number.isFinite(member.u) || !Number.isFinite(member.v)) continue;
    seen.add(member.partId);
    clean.push({ partId: member.partId, u: member.u, v: member.v });
  }
  if (clean.length < 2) return null;
  if (brush && clean.some((m) => m.points.length !== clean[0].points.length)) return null;
  return clean;
}

// The solver's view of the links: a brush link is one point pair per painted
// spot, every pair a link of its own with the brush link's anchor. So all the
// rules for points -- who gives way, two or more to the same layer attach --
// hold for a painted region exactly as for points placed one by one.
export function expandLinks(links) {
  const out = [];
  for (const link of links) {
    if (link.kind !== 'brush' || !link.members.every((m) => m.points)) {
      out.push(link);
      continue;
    }
    const n = Math.min(...link.members.map((m) => m.points.length));
    for (let i = 0; i < n; i++) {
      out.push({
        id: `${link.id}#${i}`,
        parent: link.id,
        brush: true,
        anchorId: link.anchorId,
        members: link.members.map((m) => ({ partId: m.partId, u: m.points[i].u, v: m.points[i].v })),
      });
    }
  }
  return out;
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
  //
  // A BRUSH link (kind 'brush') is a painted region instead of one point:
  // every member carries `points`, the same number on each, the i-th point of
  // every member being one pair -- the texels of each layer that were drawn
  // on the same spot when it was painted. Its u, v are the region's middle,
  // for the list and the markers.
  add({ members, anchorId = null, kind = 'point' }) {
    const clean = cleanMembers(members, kind);
    if (!clean) return null;
    const seen = new Set(clean.map((m) => m.partId));
    const link = {
      id: freshId(),
      kind: clean[0].points ? 'brush' : 'point',
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
        if (member.points) member.points = member.points.map((p) => ({ u: p.u + du, v: p.v + dv }));
        changed = true;
      }
    }
    if (changed) this._emit();
  }

  replaceAll(links) {
    this._links = (links || []).map((link) => ({
      id: link.id,
      kind: link.kind === 'brush' ? 'brush' : 'point',
      anchorId: link.anchorId ?? null,
      members: link.members.map((m) => (m.points
        ? { partId: m.partId, u: m.u, v: m.v, points: m.points.map((p) => ({ u: p.u, v: p.v })) }
        : { partId: m.partId, u: m.u, v: m.v })),
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
  return pxlinkStore.links.map((link) => (link.kind === 'brush'
    ? {
      id: link.id,
      kind: 'brush',
      anchorId: link.anchorId,
      members: link.members.map((m) => ({ partId: m.partId, u: m.u, v: m.v, points: m.points.map((p) => [p.u, p.v]) })),
    }
    : {
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
    const brush = raw.kind === 'brush';
    const members = raw.members.filter((m) => m && typeof m.partId === 'string' && live.has(m.partId)
      && Number.isFinite(m.u) && Number.isFinite(m.v))
      .map((m) => (brush
        ? { partId: m.partId, points: (Array.isArray(m.points) ? m.points : []).map((p) => (Array.isArray(p) ? { u: p[0], v: p[1] } : p)) }
        : { partId: m.partId, u: m.u, v: m.v }));
    const unique = cleanMembers([...new Map(members.map((m) => [m.partId, m])).values()], brush ? 'brush' : 'point');
    if (!unique) continue;
    const anchorId = unique.some((m) => m.partId === raw.anchorId) ? raw.anchorId : null;
    links.push({ id: raw.id.replace(LEGACY_ID, 'pxlink_'), kind: brush ? 'brush' : 'point', anchorId, members: unique });
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
// positions -- its own bones, springs, pins and pierce dent, nothing else -- and the
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
// locateTexel/landTexel.
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

// SEVERAL LINKS ON ONE LAYER
//
// A layer held at two or more points -- a string between two hands and the
// body, a strap painted on with the brush, a hand at the wrist and the
// knuckle -- is corrected by ONE field, solved from all of its link points
// together. (It used to be a weld per point, their sizes solved jointly, and
// each weld only able to TRANSLATE: a point hauled far away, beside one that
// had to stay, needed a tiny weld pushing the other way almost as hard as
// the big one pulled, across a few texels -- the mesh folded and tore.)
//
// The field is an as-rigid-as-possible blend (moving least squares, rigid):
// every vertex takes the one rotation and translation that best carries the
// link points onto their meeting points, each point weighted by how close it
// is to that vertex, in the layer's own texels. Next to a point the layer
// goes exactly where that point goes; between points it bends and stretches
// smoothly from one to the next, turning rather than shearing; where all
// the points agree on one rigid motion, every vertex gets exactly that
// motion, so an attached layer is never bent at all.
//
// A layer with bones of its own keeps them away from its links: the field
// fades to nothing over at least WELD_SPREAD times the furthest it moves
// anything, as a single weld does. A layer the links carry -- attached, or
// with no bones of its own -- takes the field everywhere.
//
// Then, as before, every placed link point is landed EXACTLY (its triangle's
// three corners interpolate the field only approximately): small residual
// welds, a hold's width each. Painted brush points, dozens side by side, are
// not landed one by one -- the field already goes through them.

// The most link points one field is solved from: all placed points, and an
// even spread of a brush region's points beyond that (they are side by side,
// and past a few dozen each adds little the others have not said).
const FIELD_POINTS = 160;
// A weight never runs to infinity on a vertex sitting on a link point.
const FIELD_SOFTEN = 0.04;
// How far, in texels, a painted pair's last correction reaches round it.
const PAINT_REACH = 3;

function smooth01(x) {
  const t = Math.max(0, Math.min(1, x));
  return t * t * (3 - 2 * t);
}

// The link points the field is built from: every placed point, then brush
// points by farthest-first sampling in texels, up to FIELD_POINTS.
function fieldPoints(sites) {
  const placed = sites.filter((site) => !site.brush);
  const painted = sites.filter((site) => site.brush);
  if (placed.length + painted.length <= FIELD_POINTS) return sites;
  const chosen = placed.slice();
  const room = Math.max(1, FIELD_POINTS - chosen.length);
  const dist = painted.map(() => Infinity);
  const near = (a, b) => Math.hypot(a.member.u - b.member.u, a.member.v - b.member.v);
  for (const c of chosen) painted.forEach((p, i) => { dist[i] = Math.min(dist[i], near(p, c)); });
  let next = chosen.length ? dist.indexOf(Math.max(...dist)) : 0;
  for (let k = 0; k < room && next >= 0; k++) {
    const pick = painted[next];
    chosen.push(pick);
    let best = -1;
    let far = -1;
    painted.forEach((p, i) => {
      dist[i] = Math.min(dist[i], near(p, pick));
      if (dist[i] > far) { far = dist[i]; best = i; }
    });
    next = far > 0 ? best : -1;
  }
  return chosen;
}

// The field's own description -- its points and how far it reaches -- so it
// can be read at ANY texel, not only at the mesh's vertices: the renderer
// draws a layer the field bends through a finer copy of its mesh (canvas.js),
// so a long thin layer curves smoothly instead of bending in a few straight
// pieces.
function fieldMove(field, u, v, x, y, w) {
  const { ctrl } = field;
  const n = ctrl.length;
  let W = 0; let px = 0; let py = 0; let qx = 0; let qy = 0;
  for (let j = 0; j < n; j++) {
    const c = ctrl[j];
    const du = u - c.u; const dv = v - c.v;
    const wj = 1 / (du * du + dv * dv + FIELD_SOFTEN);
    w[j] = wj; W += wj;
    px += wj * c.px; py += wj * c.py; qx += wj * c.qx; qy += wj * c.qy;
  }
  px /= W; py /= W; qx /= W; qy /= W;
  let cc = 0; let ss = 0;
  for (let j = 0; j < n; j++) {
    const c = ctrl[j];
    const ax = c.px - px; const ay = c.py - py;
    const bx = c.qx - qx; const by = c.qy - qy;
    cc += w[j] * (ax * bx + ay * by);
    ss += w[j] * (ax * by - ay * bx);
  }
  const norm = Math.hypot(cc, ss);
  const cos = norm > 1e-12 ? cc / norm : 1;
  const sin = norm > 1e-12 ? ss / norm : 0;
  const rx = x - px; const ry = y - py;
  return { x: qx + cos * rx - sin * ry - x, y: qy + sin * rx + cos * ry - y };
}

// The field's push at a texel, `d` being the full field there: all of it on
// a layer the links carry; else faded out round the link points and never
// more than a weld of that reach could push (reach / WELD_SPREAD), so the
// fade can never fold the layer however the field turns.
function fieldPush(field, u, v, d) {
  if (!field.reach) return d;
  let keep = 1;
  let cap = 0;
  for (let j = 0; j < field.ctrl.length; j++) {
    const c = field.ctrl[j];
    const f = smooth01(1 - Math.hypot(u - c.u, v - c.v) / field.reach[j]);
    if (f <= 0) continue;
    keep *= 1 - f;
    cap = Math.max(cap, field.reach[j] / WELD_SPREAD);
  }
  const k = 1 - keep;
  if (k <= 0) return { x: 0, y: 0 };
  const size = Math.hypot(d.x, d.y);
  const limit = size > cap ? cap / size : 1;
  return { x: d.x * k * limit, y: d.y * k * limit };
}

// The whole correction past the rigid move, at any texel (u, v) of a layer
// whose own position there (after the rigid move) is (x, y), for the finer
// drawing of a layer the field bends: the field, and what it leaves over at
// every link point, carried to the texels round it. (The residual welds are
// for the layer's own coarse vertices, which can sit far from a link point;
// at the finer drawing's spacing the leftovers alone land every point.)
export function linkOffsetAt(link, u, v, x, y) {
  let dx = 0;
  let dy = 0;
  if (link.field) {
    const w = link.field.scratch;
    const d = fieldPush(link.field, u, v, fieldMove(link.field, u, v, x, y, w));
    const r = paintedRest(link.field, u, v);
    return { x: d.x + r.x, y: d.y + r.y };
  }
  for (const weld of link.welds || []) {
    const k = smooth01(1 - Math.hypot(u - weld.u, v - weld.v) / weld.radius);
    if (k <= 0) continue;
    dx += weld.dx * k;
    dy += weld.dy * k;
  }
  return { x: dx, y: dy };
}

// What the field leaves over at the link points (a brush link's painted
// pairs among them), carried to every texel within PAINT_REACH of them: an
// inverse-distance blend of those leftovers (so it never pushes harder than
// the largest of them, and meets each one exactly at its own point), faded
// out past them. Dozens of pairs side by side are no harder for it than one
// -- there is nothing to solve, so nothing to blow up.
function paintedRest(field, u, v) {
  const rest = field.rest;
  if (!rest || rest.length === 0) return { x: 0, y: 0 };
  let W = 0; let x = 0; let y = 0; let keep = 1;
  for (const r of rest) {
    const du = u - r.u; const dv = v - r.v;
    const d2 = du * du + dv * dv;
    if (d2 >= PAINT_REACH * PAINT_REACH) continue;
    const w = 1 / (d2 + 1e-6);
    W += w; x += w * r.dx; y += w * r.dy;
    keep *= 1 - smooth01(1 - Math.sqrt(d2) / PAINT_REACH);
  }
  if (W === 0) return { x: 0, y: 0 };
  const k = 1 - keep;
  return { x: (x / W) * k, y: (y / W) * k };
}


function solveField(part, g, sites, carried) {
  const scale = Math.max(1e-6, part.scale || 1);
  if (sites.every((site) => Math.hypot(site.dx, site.dy) < 1e-12)) return { offsets: null, welds: [], field: null };
  const ctrl = fieldPoints(sites).map((site) => ({
    u: site.member.u, v: site.member.v,
    px: site.at.x, py: site.at.y,
    qx: site.at.x + site.dx, qy: site.at.y + site.dy,
    hold: site.hold,
  }));
  const field = { ctrl, reach: null, scratch: new Float64Array(ctrl.length) };
  const V = g.mesh.vertices;
  const P = g.positions;
  const moves = V.map((t, i) => fieldMove(field, t.u, t.v, P[i].x, P[i].y, field.scratch));
  if (!carried) {
    // A layer with bones of its own keeps them away from its links: the
    // field only round each link point, over exactly the reach a weld there
    // would have -- WELD_SPREAD times that point's own travel -- so a pull
    // at the wrist bends the wrist and leaves the fingertips on their own
    // bone and spring, as a single weld always did.
    field.reach = ctrl.map((c) => Math.max(c.hold, (WELD_SPREAD * Math.hypot(c.qx - c.px, c.qy - c.py)) / scale));
  }
  const shaped = moves.map((d, i) => fieldPush(field, V[i].u, V[i].v, d));
  // What the field leaves over at each link point, measured at the point
  // itself and carried to the texels round it (paintedRest): a brush link's
  // painted pairs land on what they were painted on, and the finer drawing
  // lands every placed point too.
  field.rest = sites.map((site) => {
    const { u, v } = site.member;
    const d = fieldPush(field, u, v, fieldMove(field, u, v, site.at.x, site.at.y, field.scratch));
    return { u, v, dx: site.dx - d.x, dy: site.dy - d.y };
  });
  const offsets = shaped.map((d, i) => {
    const r = paintedRest(field, V[i].u, V[i].v);
    return { x: d.x + r.x, y: d.y + r.y };
  });
  // The layer's own vertices can sit far from a placed point -- its
  // triangle's corners are what land it -- so on them each placed point is
  // landed EXACTLY by a residual weld, as before.
  const moved = P.map((p, i) => ({ x: p.x + offsets[i].x, y: p.y + offsets[i].y }));
  const residual = [];
  let worst = 0;
  for (const site of sites) {
    if (site.brush) continue;
    const landed = landTexel(moved, site.located);
    const dx = site.at.x + site.dx - landed.x;
    const dy = site.at.y + site.dy - landed.y;
    worst = Math.max(worst, Math.hypot(dx, dy));
    // Sized like any weld: at least WELD_SPREAD times what it closes, so it
    // bends the layer's own mesh rather than folding it.
    residual.push({ member: site.member, located: site.located, radius: Math.max(site.hold, (WELD_SPREAD * Math.hypot(dx, dy)) / scale), dx, dy });
  }
  let welds = solveWelds(g.mesh, residual);
  // Two placed points almost on top of each other can ask the residual welds
  // for far more than they are closing; the field alone is then the answer.
  if (welds.some((weld) => Math.hypot(weld.dx, weld.dy) > 4 * worst + 0.5)) welds = [];
  return { offsets, welds, field };
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
  const links = expandLinks(pxlinkStore.links
    .map((link) => ({ ...link, members: link.members.filter((m) => partsById.has(m.partId)) }))
    .filter((link) => link.members.length >= 2));
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
  const uncorrected = new Map([...geometry].map(([id, g]) => [id, g.positions]));

  // 2. Attached layers move as a whole first (see ONE POINT IS A JOINT).
  const rigid = solveAttachments(links, geometry, points);

  // 3. Each link's meeting point, from those current points alone: the
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

  // 4. A weld at every link point that has to move, sized to how far.
  for (const [id, g] of geometry) {
    const part = partsById.get(id);
    const { w: cellU, h: cellV } = meshCellSize(g.mesh, part);
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
      sites.push({ member, located, at, radius: reach, hold, dx, dy, brush: Boolean(link.brush) });
    });
    // One link point: its weld, exactly as it always was. Two or more: ONE
    // field for the whole layer, solved from all of them together (see
    // SEVERAL LINKS ON ONE LAYER).
    let welds;
    let offsets = null;
    let field = null;
    // A piercer's points stay joints however many there are (see A PIERCER
    // IS NEVER ATTACHED): a field would carry it back as surely as an
    // attachment.
    if (sites.length <= 1 || part.isPiercer) {
      welds = solveWelds(g.mesh, sites);
    } else {
      const carried = rigid.has(id) || !(part.mesh && part.mesh.isBound);
      ({ offsets, welds, field } = solveField(part, g, sites, carried));
    }
    // The vertices left unsnapped, so the members' link points land on the
    // very same spot rather than each rounded its own way: the fixed
    // neighbourhood of each point, NOT the whole reach. The wider bend steps
    // in whole pixels like the rest of the layer -- and a zone that grew and
    // shrank with the gap would flip vertices between rounded and unrounded
    // mid-drag, a half-pixel shimmer at its edge.
    const nearLink = g.mesh.vertices.map((t) => sites.some(({ member: a, hold }) => Math.hypot(t.u - a.u, t.v - a.v) <= hold));
    result.set(id, { rigid: rigid.get(id) || null, offsets, field, welds, nearLink, uncorrected: uncorrected.get(id), mesh: g.mesh });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Attached layers

// Who is attached to whom: every link point at which a layer gives way to a
// given other layer -- as a follower of that layer's anchored links, or as
// one of a shared link's members -- grouped by that other layer. A group of
// two or more is an attachment. Map partId -> [{ k, i }] (link, member).
//
// A PIERCER IS NEVER ATTACHED. It is the one layer the Piercer tab drives
// on its own, into another; moved back as a whole onto whatever it is
// linked to, it could never be driven anywhere, and no pierce could begin
// (2.5.4 to 2.6.0: a finger tied to a hand layer at two points sat still
// under the drag and the wedge never opened). Its link points are joints:
// welded locally, as every link was before attachments, while the drag
// carries the rest of it in.
function isPiercerId(id) {
  const part = partsStore.parts.find((candidate) => candidate.id === id);
  return Boolean(part && part.isPiercer);
}

function pairGroups(links) {
  const groups = new Map(); // `${id}|${other}` -> [{ k, i, other }]
  links.forEach((link, k) => {
    link.members.forEach((member, i) => {
      if (member.partId === link.anchorId) return;
      if (isPiercerId(member.partId)) return;
      const others = link.anchorId
        ? [link.anchorId]
        : link.members.filter((m) => m.partId !== member.partId).map((m) => m.partId);
      for (const other of others) {
        const key = `${member.partId}|${other}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push({ k, i, other });
      }
    });
  });
  return groups;
}

// The members of `link` that are ATTACHED (tied to the same other layer by
// this link and at least one more) -- for the PxLink window's list.
export function attachedMembers(link, links = pxlinkStore.links) {
  const expanded = expandLinks(links);
  const groups = pairGroups(expanded);
  const mine = new Set();
  expanded.forEach((entry, k) => { if (entry === link || entry.parent === link.id) mine.add(k); });
  const out = [];
  for (const member of link.members) {
    if (member.partId === link.anchorId) continue;
    for (const [key, group] of groups) {
      if (key.startsWith(`${member.partId}|`) && group.length >= 2 && group.some((e) => mine.has(e.k))) {
        out.push(member.partId);
        break;
      }
    }
  }
  return out;
}

function attachmentsOf(links) {
  const groups = pairGroups(links);
  const attached = new Map();
  for (const [key, group] of groups) {
    if (group.length < 2) continue;
    const id = key.slice(0, key.indexOf('|'));
    if (!attached.has(id)) attached.set(id, []);
    for (const entry of group) {
      // A point shared with several layers counts once.
      if (!attached.get(id).some((e) => e.k === entry.k)) attached.get(id).push(entry);
    }
  }
  return attached;
}

// The rigid move for every attached layer, applied to its geometry and its
// link points in place. Layers are moved after the layers they are attached
// to, so a patch on a patch follows the one beneath it as moved. A loop of
// attachments (each attached to the other) is taken in link order.
function solveAttachments(links, geometry, points) {
  const attached = attachmentsOf(links);
  const moves = new Map();
  if (attached.size === 0) return moves;
  const order = [];
  const visiting = new Set();
  const visit = (id) => {
    if (order.includes(id) || visiting.has(id)) return;
    visiting.add(id);
    for (const { k } of attached.get(id) || []) {
      const anchor = links[k].anchorId;
      if (anchor && attached.has(anchor)) visit(anchor);
    }
    visiting.delete(id);
    order.push(id);
  };
  for (const id of attached.keys()) visit(id);
  // A shared link's meeting point is the middle of where its members ARE,
  // before any of them moves -- each then goes its half of the way. (Taken
  // after the first had moved, the second would chase a middle that had
  // already shifted.)
  const before = points.map((pts) => pts.map((p) => (p ? p.at : null)));

  for (const id of order) {
    const from = [];
    const to = [];
    for (const { k, i } of attached.get(id)) {
      const own = points[k][i];
      if (!own) continue;
      const link = links[k];
      const anchorIndex = link.members.findIndex((m) => m.partId === link.anchorId);
      let target = null;
      if (anchorIndex >= 0) {
        if (points[k][anchorIndex]) target = points[k][anchorIndex].at;
      } else {
        // Shared: the middle of everyone, as they were before any moved.
        let x = 0, y = 0, n = 0;
        for (const p of before[k]) { if (!p) continue; x += p.x; y += p.y; n++; }
        if (n) target = { x: x / n, y: y / n };
      }
      if (!target) continue;
      from.push(own.at);
      to.push(target);
    }
    const move = rigidFit(from, to);
    if (!move) continue;
    moves.set(id, move);
    const g = geometry.get(id);
    g.positions = g.positions.map((p) => moveRigid(move, p));
    links.forEach((link, k) => {
      link.members.forEach((member, i) => {
        if (member.partId === id && points[k][i]) points[k][i] = { ...points[k][i], at: landing(g, points[k][i].located) };
      });
    });
  }
  return moves;
}

// The rotation and translation that best carry `from` onto `to` (least
// squares, no scaling): q = to-centre + R (p - from-centre). Points that all
// sit on one spot fix no direction, so they only translate. Null with
// nothing to fit.
export function rigidFit(from, to) {
  const n = from.length;
  if (n === 0) return null;
  let ax = 0, ay = 0, bx = 0, by = 0;
  for (let i = 0; i < n; i++) { ax += from[i].x; ay += from[i].y; bx += to[i].x; by += to[i].y; }
  ax /= n; ay /= n; bx /= n; by /= n;
  let sxx = 0;
  let sxy = 0;
  let spread = 0;
  for (let i = 0; i < n; i++) {
    const px = from[i].x - ax; const py = from[i].y - ay;
    const qx = to[i].x - bx; const qy = to[i].y - by;
    sxx += px * qx + py * qy;
    sxy += px * qy - py * qx;
    spread += px * px + py * py;
  }
  const turn = spread > 1e-6 && Math.hypot(sxx, sxy) > 1e-9 ? Math.atan2(sxy, sxx) : 0;
  return { ax, ay, bx, by, cos: Math.cos(turn), sin: Math.sin(turn), turn };
}

export function moveRigid(move, p) {
  const x = p.x - move.ax;
  const y = p.y - move.ay;
  return { x: move.bx + move.cos * x - move.sin * y, y: move.by + move.sin * x + move.cos * y };
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
// A brush link also reports `pairs`: every painted pair, each member where it
// is drawn, in the same shape as `members`.
export function linkPositions(transforms = currentTransforms()) {
  const out = [];
  const partsById = new Map(partsStore.parts.map((part) => [part.id, part]));
  const solved = solveFor(transforms);
  const drawn = new Map(); // partId -> { g, positions }, once per layer
  const drawnOf = (part) => {
    if (!drawn.has(part.id)) {
      const g = layerGeometry(part, transforms);
      drawn.set(part.id, { g, positions: welded(g, solved.get(part.id) || null) });
    }
    return drawn.get(part.id);
  };
  // Where a point is drawn: its triangle's corners with the correction on.
  const at = (member) => {
    const part = partsById.get(member.partId);
    if (!part) return null;
    const { g, positions } = drawnOf(part);
    const located = locate(g, member.u, member.v);
    if (!located) return null;
    const p = landing({ positions }, located);
    return { partId: part.id, x: p.x, y: p.y };
  };
  for (const link of pxlinkStore.links) {
    const members = link.members.map(at).filter(Boolean);
    const entry = { id: link.id, anchorId: link.anchorId, kind: link.kind || 'point', members };
    if (link.kind === 'brush') {
      entry.pairs = expandLinks([link]).map((pair) => pair.members.map(at).filter(Boolean));
    }
    out.push(entry);
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
