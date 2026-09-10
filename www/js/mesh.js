// Deformable mesh: grid generation, bone weight binding, and linear blend
// skinning.
//
// Pure math and data -- no DOM, no canvas, no gestures. canvas.js renders
// what this produces; bindTool.js edits weights through it.
//
// COORDINATE SPACES
//
// A vertex's rest position is stored in the PART'S LOCAL IMAGE SPACE (the
// image's center at the origin, one unit per source pixel), not in world
// space. That choice matters:
//
//   * At rest, skinning collapses to exactly the part's own transform, so
//     a bound part renders pixel-identically to the flat sprite and still
//     drags/scales/rotates normally on the Home screen.
//   * Bone bind poses ARE captured in world space, because bones live in
//     world space. Moving a part after binding therefore leaves its
//     deformation pivots where the bones were at bind time -- re-bind
//     (Auto-weight) to re-establish that relationship.
//
// The deformation entry point is deformVertices(mesh, part, boneTransforms):
// hand it live bone transforms and it returns deformed world positions.
// Nothing else about the binding needs to be touched to drive animation.

const MIN_CELLS = 2;
const WEIGHT_EPSILON = 0.001;
const DISTANCE_EPSILON = 0.5; // guards against dividing by a zero distance
const FALLOFF_EXPONENT = 2;

export const DEFAULT_MAX_INFLUENCES = 3;
export const MIN_DENSITY = 3;
export const MAX_DENSITY = 16;

// Pixel art is chunky, so the grid stays coarse: cells along the longest
// side, scaled by the source's pixel dimensions and clamped to 6..10.
export function defaultDensity(part) {
  const longest = Math.max(part.naturalWidth, part.naturalHeight);
  return Math.min(10, Math.max(6, Math.round(longest / 12)));
}

// Local image space (centre at the origin, one unit per source pixel) to
// scene pixels. With the part's integer top-left and integer scale, an
// unrotated local point lands on exact integers.
export function localToWorld(part, local) {
  const cos = Math.cos(part.rotation);
  const sin = Math.sin(part.rotation);
  const sx = local.x * part.scale;
  const sy = local.y * part.scale;
  return { x: part.centerX + sx * cos - sy * sin, y: part.centerY + sx * sin + sy * cos };
}

export class MeshVertex {
  constructor(u, v, restLocal) {
    this.u = u; // UV in source-image pixels
    this.v = v;
    this.restLocal = restLocal; // rest position in the part's local space
    this.weights = {}; // { boneId: weight }, normalized to sum to 1
  }
}

export class PartMesh {
  constructor({ cols, rows, density, vertices, triangles }) {
    this.cols = cols;
    this.rows = rows;
    this.density = density;
    this.vertices = vertices;
    this.triangles = triangles; // flat list of vertex-index triples
    this.bindPose = {}; // { boneId: { head: {x,y}, rotation } } at bind time
  }

  get isBound() {
    return Object.keys(this.bindPose).length > 0;
  }
}

// Standard regular grid split into two triangles per cell. Nothing exotic
// -- a uniform grid is the right shape for a rectangular sprite.
export function generateMesh(part, density) {
  const longest = Math.max(part.naturalWidth, part.naturalHeight);
  const cols = Math.max(MIN_CELLS, Math.round((part.naturalWidth / longest) * density));
  const rows = Math.max(MIN_CELLS, Math.round((part.naturalHeight / longest) * density));

  const width = part.naturalWidth;
  const height = part.naturalHeight;
  const vertices = [];

  for (let row = 0; row <= rows; row++) {
    for (let col = 0; col <= cols; col++) {
      const u = (col / cols) * width;
      const v = (row / rows) * height;
      vertices.push(new MeshVertex(u, v, { x: u - width / 2, y: v - height / 2 }));
    }
  }

  const triangles = [];
  const stride = cols + 1;
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const topLeft = row * stride + col;
      const topRight = topLeft + 1;
      const bottomLeft = topLeft + stride;
      const bottomRight = bottomLeft + 1;
      triangles.push(topLeft, topRight, bottomLeft);
      triangles.push(topRight, bottomRight, bottomLeft);
    }
  }

  return new PartMesh({ cols, rows, density, vertices, triangles });
}

// Shortest distance from a point to a bone's head->tail segment.
function distanceToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(px - ax, py - ay);

  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

// Auto-weighting: every vertex is bound to its nearest few bones by
// inverse squared distance to the bone segment, normalized to sum to 1.
// Capping the influence count keeps deformation crisp -- letting every
// bone touch every vertex produces mush.
export function autoWeightMesh(mesh, part, bonesStore, maxInfluences = DEFAULT_MAX_INFLUENCES) {
  // WHICH BONES ARE ALLOWED TO DRIVE THIS LAYER
  //
  // If the user has said which bones control this layer -- the "Controls
  // layer" choice in the bone editor -- then those are the only
  // candidates, and distance decides nothing but how the weight is shared
  // between them.
  //
  // Distance alone is not good enough once parts overlap, which on a
  // character they constantly do. A hand resting against the chest has a
  // chest bone closer to some of its pixels than its own hand bone, so
  // proximity would hand a slice of the hand over to the chest and the
  // hand would then swing whenever the chest did. That is not a weighting
  // subtlety the user can tune around; it is the wrong bone.
  //
  // With no explicit assignment there is nothing to go on but distance,
  // so the old behaviour stands and every bone is a candidate. Note that a
  // SPRING bone may well win a share of a layer it was never meant to
  // drive; deformVertices below is what stops that share from jiggling.
  const assigned = part && part.id ? bonesStore.bonesAttachedTo(part.id) : [];
  const bones = assigned.length > 0 ? assigned : bonesStore.bones;
  mesh.bindPose = {};
  if (bones.length === 0) {
    for (const vertex of mesh.vertices) vertex.weights = {};
    return mesh;
  }

  // The REST skeleton, not wherever a spring bone happens to be swinging
  // right now. The bind pose is the reference the deformation is measured
  // against, so capturing a mid-jiggle pose would leave the artwork
  // permanently skewed once the bone came back to rest -- and would break
  // the invariant that a freshly bound part renders identically at rest.
  const segments = bones.map((bone) => ({
    id: bone.id,
    head: bonesStore.restWorldHead(bone),
    tail: bonesStore.restWorldTail(bone),
    rotation: bonesStore.restWorldRotation(bone),
  }));

  for (const segment of segments) {
    mesh.bindPose[segment.id] = {
      head: { x: segment.head.x, y: segment.head.y },
      rotation: segment.rotation,
    };
  }

  for (const vertex of mesh.vertices) {
    const world = localToWorld(part, vertex.restLocal);
    const ranked = segments
      .map((segment) => ({
        id: segment.id,
        distance: Math.max(
          DISTANCE_EPSILON,
          distanceToSegment(world.x, world.y, segment.head.x, segment.head.y, segment.tail.x, segment.tail.y)
        ),
      }))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, maxInfluences);

    const raw = ranked.map((entry) => ({ id: entry.id, weight: 1 / entry.distance ** FALLOFF_EXPONENT }));
    const total = raw.reduce((sum, entry) => sum + entry.weight, 0);

    vertex.weights = {};
    for (const entry of raw) {
      const normalized = entry.weight / total;
      if (normalized > WEIGHT_EPSILON) vertex.weights[entry.id] = normalized;
    }
    normalizeWeights(vertex);
  }

  return mesh;
}

export function bindPart(part, bonesStore, density) {
  const resolved = density || defaultDensity(part);
  part.mesh = autoWeightMesh(generateMesh(part, resolved), part, bonesStore);
  return part.mesh;
}

function normalizeWeights(vertex) {
  const total = Object.values(vertex.weights).reduce((sum, weight) => sum + weight, 0);
  if (total <= 0) return;
  for (const boneId of Object.keys(vertex.weights)) {
    vertex.weights[boneId] /= total;
  }
}

// Adds `delta` to one bone's weight on a vertex and rescales the other
// bones' weights so the set still sums to 1 -- the invariant linear blend
// skinning depends on.
export function applyWeightDelta(vertex, boneId, delta) {
  const current = vertex.weights[boneId] || 0;
  const next = Math.min(1, Math.max(0, current + delta));

  let otherTotal = 0;
  for (const [id, weight] of Object.entries(vertex.weights)) {
    if (id !== boneId) otherTotal += weight;
  }

  if (otherTotal <= 0) {
    // Nothing else influences this vertex, so it belongs entirely to this
    // bone -- anything less would leave the weights summing below 1.
    vertex.weights = next > 0 ? { [boneId]: 1 } : {};
    return;
  }

  const scale = (1 - next) / otherTotal;
  for (const id of Object.keys(vertex.weights)) {
    if (id === boneId) continue;
    const scaled = vertex.weights[id] * scale;
    if (scaled > WEIGHT_EPSILON) vertex.weights[id] = scaled;
    else delete vertex.weights[id];
  }

  if (next > WEIGHT_EPSILON) vertex.weights[boneId] = next;
  else delete vertex.weights[boneId];

  normalizeWeights(vertex);
}

// Linear blend skinning.
//
// For each vertex: take its rest position in world space, and for every
// influencing bone compute where that bone's movement since bind time
// would carry the point -- rotate it about the bone's bind head by the
// bone's change in rotation, then translate to the bone's current head.
// The result is the weighted average of those per-bone answers.
//
//   deformed = sum_b w_b * ( R(theta_b_now - theta_b_bind) * (p - head_b_bind) + head_b_now )
//
// With no bone moved, every term reduces to p, so the mesh sits exactly at
// rest and renders identically to the undeformed sprite.
export function deformVertices(mesh, part, boneTransforms) {
  const out = new Array(mesh.vertices.length);

  for (let i = 0; i < mesh.vertices.length; i++) {
    const vertex = mesh.vertices[i];
    const rest = localToWorld(part, vertex.restLocal);

    let x = 0;
    let y = 0;
    let totalWeight = 0;

    for (const [boneId, weight] of Object.entries(vertex.weights)) {
      const bind = mesh.bindPose[boneId];
      const current = boneTransforms[boneId];
      // A bone deleted since binding simply drops out; the remaining
      // weights are renormalized below.
      if (!bind || !current) continue;

      // A SPRING BONE ONLY JIGGLES THE LAYER IT WAS GIVEN
      //
      // Switching physics on says "this piece is loose". Auto-weighting,
      // which knows only about distance, hands a spring bone a minority
      // share of every layer near it -- so a rigid torso came out 24%
      // owned by one chest bone, and a rigid hair layer 8%. The BONES were
      // never wrong: through a whole drag they stayed 0.00px from the
      // root, exactly as rigid bones should. Their ARTWORK was the thing
      // that lagged and jiggled, because a quarter of it was riding a
      // spring nobody had pointed at it.
      //
      // So for any layer other than the one it was assigned, the bone is
      // read at its RIGID transform: carried by the drag exactly like
      // every other bone, simply not swinging.
      //
      // Reading it rigidly rather than dropping it is the whole point. An
      // earlier version skipped the bone instead, which worked until a
      // vertex's weight sat ENTIRELY on spring bones -- then nothing was
      // left to blend, and the fallback at the end of this loop put that
      // vertex back at its untouched import position. A layer whose bone
      // had been re-pointed at something else lost all 42 of its vertices
      // that way and stayed pinned where it was imported while the rest of
      // the character was dragged off. Every bone now contributes
      // something, so that fallback stays unreachable.
      const springElsewhere = current.physics && current.partId !== (part && part.id);
      const head = springElsewhere ? current.rigidHead : current.head;
      const rotation = springElsewhere ? current.rigidRotation : current.rotation;

      const angle = rotation - bind.rotation;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const dx = rest.x - bind.head.x;
      const dy = rest.y - bind.head.y;

      x += weight * (head.x + dx * cos - dy * sin);
      y += weight * (head.y + dx * sin + dy * cos);
      totalWeight += weight;
    }

    out[i] = totalWeight > 0 ? { x: x / totalWeight, y: y / totalWeight } : rest;
  }

  return out;
}

// The grid snap. Skinning above is left exactly as it was -- continuous
// maths producing continuous answers -- and this rounds each answer to
// the nearest scene pixel before anything is drawn. That is the whole
// difference between a sprite that smears between pixels as it bends and
// one that moves in crisp whole-pixel steps.
export function snapToGrid(positions) {
  return positions.map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) }));
}

export function deformVerticesSnapped(mesh, part, boneTransforms) {
  return snapToGrid(deformVertices(mesh, part, boneTransforms));
}

// An unbound part drawn as a plain quad: its four corners in scene space,
// snapped, with the UVs and triangle order the rasterizer wants. At rest
// the corners are already integers, so snapping changes nothing.
export function partQuad(part) {
  const w = part.naturalWidth;
  const h = part.naturalHeight;
  const corners = [
    { x: -w / 2, y: -h / 2 },
    { x: w / 2, y: -h / 2 },
    { x: w / 2, y: h / 2 },
    { x: -w / 2, y: h / 2 },
  ].map((local) => localToWorld(part, local));

  return {
    positions: snapToGrid(corners),
    uvs: [{ u: 0, v: 0 }, { u: w, v: 0 }, { u: w, v: h }, { u: 0, v: h }],
    triangles: [0, 1, 3, 1, 2, 3],
  };
}
