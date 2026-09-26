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

// A pierced layer's V -- its two halves swung apart about their hinges by
// as much as the piercer's depth says (spread.js reads the depth the pierce
// solver publishes through pierceState.js, so this file never imports the
// solver, which imports THIS file).
import { applySpread } from './spread.js';
// And the PxLink solver's correction, through a leaf for the same reason:
// pxlink.js deforms linked layers through this file.
import { pxlinkCorrection } from './pxlinkState.js';
import { localToWorld } from './layerSpace.js';

export const DEFAULT_MAX_INFLUENCES = 3;
export const MIN_DENSITY = 3;
export const MAX_DENSITY = 16;

// Pixel art is chunky, so the grid stays coarse: cells along the longest
// side, scaled by the source's pixel dimensions and clamped to 6..10.
export function defaultDensity(part) {
  const longest = Math.max(part.naturalWidth, part.naturalHeight);
  return Math.min(10, Math.max(6, Math.round(longest / 12)));
}

// Local image space to scene pixels -- see layerSpace.js, where it lives so
// spread.js can use it without importing this file.
export { localToWorld };

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
    this.joints = []; // joint seams this layer's artwork sits on (withSeams)
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

// ONE vertex's weights, by the inverse-distance rule autoWeightMesh uses.
//
// Lifted out so that a vertex added to an existing mesh later -- by the
// Mesh Trim tool -- is weighted by exactly this calculation rather than by
// a second copy of it that could drift away from this one.
//
// INFLUENCE STAYS ON THE LIMB
//
// Distance alone does not know anatomy. With the arms hanging, a hand sits
// beside its own thigh, and the thigh is close enough to win a share of it:
// measured, hand vertices carried up to 4.2% thigh weight, so a kick moved
// the hand. Nothing about the distances is wrong -- the thigh really is that
// close. What is wrong is asking the question of every bone in the rig.
//
// So a vertex is first given to the bone it sits on (the nearest segment),
// and may then blend only with the bones JOINTED DIRECTLY to that one: its
// parent and its children. That is where skin genuinely shares motion -- at
// a joint, between two segments that meet there -- and it rules out a hand
// ever answering to a thigh, a torso or the other arm, however near they
// happen to be drawn. A shoulder vertex still blends torso and upper arm; an
// elbow vertex still blends upper arm and forearm.
//
// Segments carry `parentId` for this. When NONE of them does -- a mesh bound
// by an older build, whose bind pose never recorded the hierarchy -- there is
// no topology to go on and the rule falls back to plain distance, exactly as
// it always was, rather than guessing at a skeleton it cannot see.
function weightsFromSegments(world, segments, maxInfluences = DEFAULT_MAX_INFLUENCES) {
  const measured = segments
    .map((segment) => ({
      id: segment.id,
      distance: Math.max(
        DISTANCE_EPSILON,
        distanceToSegment(world.x, world.y, segment.head.x, segment.head.y, segment.tail.x, segment.tail.y)
      ),
    }))
    .sort((a, b) => a.distance - b.distance);
  if (measured.length === 0) return {};

  let candidates = measured;
  if (segments.some((segment) => 'parentId' in segment)) {
    const home = measured[0].id;
    const homeSegment = segments.find((segment) => segment.id === home);
    const jointed = new Set([home]);
    if (homeSegment && homeSegment.parentId) jointed.add(homeSegment.parentId);
    for (const segment of segments) if (segment.parentId === home) jointed.add(segment.id);
    candidates = measured.filter((entry) => jointed.has(entry.id));
  }
  const ranked = candidates.slice(0, maxInfluences);

  const raw = ranked.map((entry) => ({ id: entry.id, weight: 1 / entry.distance ** FALLOFF_EXPONENT }));
  const total = raw.reduce((sum, entry) => sum + entry.weight, 0);

  const weights = {};
  for (const entry of raw) {
    const normalized = entry.weight / total;
    if (normalized > WEIGHT_EPSILON) weights[entry.id] = normalized;
  }
  const sum = Object.values(weights).reduce((a, b) => a + b, 0);
  if (sum > 0) for (const id of Object.keys(weights)) weights[id] /= sum;
  return weights;
}

// ---------------------------------------------------------------------------
// Joint seams: two layers that meet at a joint stay joined there.
//
// WHY A LAYER CAME OFF AT ITS JOINT
//
// Skinning is worked out one layer at a time, and a layer with a "Controls
// layer" bone is weighted to that bone alone -- on purpose, so a hand resting
// on a chest never answers to the chest. Measured on a layered arm: every
// Hand vertex 100% hand bone, every Forearm vertex 100% forearm bone. So the
// two layers are two rigid bodies that merely touch. Swing the hand and it
// turns about the wrist point, and everything that was touching the forearm
// at a distance t from that point is carried 2 t sin(angle / 2) away from it.
// Measured in Free Move, on the pixels actually drawn: the wrist seam opened
// past 1.5px at 7 degrees and reached 9.45px at 145, at any drag speed --
// the hand pivoting over the cuff, joined at one point and nowhere else.
//
// The earlier joint-gap fix (swing about the head instead of sliding the
// head) was right, and its test was right about what it measured: the BONE
// joint does not travel. But the artwork on either side of it is two
// separately-skinned layers, and nothing asked them to agree at the seam.
//
// THE FIX: ONE RULE FOR THE SEAM, WHOEVER'S ARTWORK IS THERE
//
// Two layers can only stay joined along a seam if they move every point of
// that seam identically -- which, with skinning, means they give it the same
// weights. So at a joint between a parent and its child, the weights across
// the seam are a function of POSITION alone, the same for every layer: a band
// straddling the joint, perpendicular to the limb, easing from all-parent on
// one side to all-child on the other, 50/50 on the joint line itself. The
// Forearm layer's cuff and the Hand layer's wrist, drawn side by side, are
// weighted by the identical rule, so they are moved identically and cannot
// part. Beyond the band each layer is exactly what it was: 100% its own bone.
//
// Weights that vary only ACROSS the seam are constant ALONG it, so the map is
// affine along any line parallel to the seam. Two layers whose edges meet
// along the joint line therefore land on exactly the same pixels however
// differently their meshes happen to be triangulated.
//
// WHERE IT APPLIES, AND WHERE IT DELIBERATELY DOES NOT
//
// Only at SERIAL joints: a child whose head sits on its parent's tail (elbow,
// wrist, knee, a chain of hair segments). There the parent's artwork is on one
// side of the joint and the child's on the other, and "which side of the
// seam" is the right question. A child hung off the SIDE of its parent -- an
// arm on a torso bone that runs down the middle of the body -- has no such
// line: the torso's own artwork continues right past the shoulder, so a band
// there would hand torso pixels to the arm. Those keep the existing rule.
//
// Only near the limb: the band stops a mesh cell beyond the layer's own
// artwork on the seam, measured across the limb, and only for a vertex whose
// own bone is one of the two -- so a torso drawn at wrist height beside a
// hanging hand is not touched. And it brings in exactly one extra bone, the
// one jointed to the layer's own; the audit's rule that weight never reaches
// an unrelated bone still holds.

const SEAM_BAND_FRACTION = 0.35; // half-width of the band, x the shorter bone
const SEAM_BAND_MIN = 1.5;
const SEAM_BAND_MAX = 8;
// How close a child's head must be to its parent's tail to count as serial:
// endpoints tap-placed on pixel centres, so within a pixel or so.
const SERIAL_JOINT_TOLERANCE = 1.5;

function smoothstep01(x) {
  const t = Math.max(0, Math.min(1, x));
  return t * t * (3 - 2 * t);
}

// Every serial joint one of `boneIds` takes part in, in the REST pose -- the
// same pose the bind pose is captured in.
function serialJoints(bonesStore, boneIds) {
  const joints = [];
  for (const child of bonesStore.bones) {
    const parent = child.parentId ? bonesStore.byId(child.parentId) : null;
    if (!parent) continue;
    if (!boneIds.has(child.id) && !boneIds.has(parent.id)) continue;
    const head = bonesStore.restWorldHead(child);
    const parentTail = bonesStore.restWorldTail(parent);
    const offset = Math.hypot(head.x - parentTail.x, head.y - parentTail.y);
    if (offset > Math.max(SERIAL_JOINT_TOLERANCE, parent.length * 0.1)) continue;
    // The seam runs perpendicular to the limb through the joint: along the
    // bisector of the two bones, so a bent rest pose splits the bend evenly.
    const a = bonesStore.restWorldRotation(parent);
    const c = bonesStore.restWorldRotation(child);
    let nx = Math.cos(a) + Math.cos(c);
    let ny = Math.sin(a) + Math.sin(c);
    let length = Math.hypot(nx, ny);
    if (length < 0.2) { nx = Math.cos(c); ny = Math.sin(c); length = 1; } // folded back on itself
    joints.push({
      parentId: parent.id,
      childId: child.id,
      head: { x: head.x, y: head.y },
      normal: { x: nx / length, y: ny / length },
      band: Math.min(SEAM_BAND_MAX, Math.max(SEAM_BAND_MIN,
        SEAM_BAND_FRACTION * Math.min(parent.length, child.length))),
      parentLength: parent.length,
      childLength: child.length,
      reach: 0,
    });
  }
  return joints;
}

// A point in the joint's frame: s along the limb (negative on the parent's
// side), t across it.
function seamFrame(joint, point) {
  const dx = point.x - joint.head.x;
  const dy = point.y - joint.head.y;
  return {
    s: dx * joint.normal.x + dy * joint.normal.y,
    t: -dx * joint.normal.y + dy * joint.normal.x,
  };
}

function homeBone(weights) {
  let home = null;
  let best = 0;
  for (const [id, weight] of Object.entries(weights)) {
    if (weight > best) { best = weight; home = id; }
  }
  return home;
}

// The joint whose seam a point lies on, if any, for a vertex whose own bone
// is `home`. A vertex on the child's side keeps the seam rule all the way
// back across the parent's length (a hand drawn tucked into its sleeve moves
// with the sleeve), and one on the parent's side likewise into the child's.
function seamAt(world, home, joints) {
  let chosen = null;
  let chosenScore = Infinity;
  for (const joint of joints) {
    const isChild = joint.childId === home;
    if (!isChild && joint.parentId !== home) continue;
    if (!(joint.reach > 0)) continue;
    const { s, t } = seamFrame(joint, world);
    if (Math.abs(t) > joint.reach) continue;
    if (isChild ? (s >= joint.band || s < -joint.parentLength) : (s <= -joint.band || s > joint.childLength)) {
      continue;
    }
    const score = Math.abs(s) / joint.band;
    if (score < chosenScore) { chosenScore = score; chosen = { joint, s }; }
  }
  return chosen;
}

// Weights for a point, with any joint seam it lies on taking over. The
// seam's weights depend on nothing but the point's position, which is the
// whole guarantee: every layer computes the same ones.
function withSeams(world, weights, joints) {
  if (!joints || joints.length === 0) return weights;
  const seam = seamAt(world, homeBone(weights), joints);
  if (!seam) return weights;
  const { joint, s } = seam;
  const child = smoothstep01((s + joint.band) / (2 * joint.band));
  const out = {};
  if (1 - child > WEIGHT_EPSILON) out[joint.parentId] = 1 - child;
  if (child > WEIGHT_EPSILON) out[joint.childId] = child;
  const total = Object.values(out).reduce((sum, weight) => sum + weight, 0);
  for (const id of Object.keys(out)) out[id] /= total;
  return out;
}

// How far across the limb this layer's seam must reach at a joint: its own
// opaque artwork within the band, whose own bone is one of the joint's two,
// plus `margin` -- one mesh cell, so every triangle holding seam artwork has
// all three corners on the seam rule. Zero when the layer has no artwork
// there, which leaves that joint out of this layer entirely.
function seamReach(part, joint, segments, margin) {
  const width = part.naturalWidth;
  const height = part.naturalHeight;
  let widest = -1;
  for (let v = 0; v < height; v++) {
    for (let u = 0; u < width; u++) {
      if (part.pixels[(v * width + u) * 4 + 3] === 0) continue;
      const world = localToWorld(part, { x: u + 0.5 - width / 2, y: v + 0.5 - height / 2 });
      const { s, t } = seamFrame(joint, world);
      if (Math.abs(s) > joint.band || Math.abs(t) <= widest) continue;
      const home = homeBone(weightsFromSegments(world, segments));
      if (home !== joint.parentId && home !== joint.childId) continue;
      widest = Math.abs(t);
    }
  }
  if (widest < 0) return 0;
  return widest + margin + 1e-9;
}

// The bones a layer may be bound to, as segments in the REST pose.
//
// If the user has said which bones control this layer -- the "Controls
// layer" choice in the bone editor -- then those are the only candidates,
// and distance decides nothing but how the weight is shared between them.
// Distance alone is not good enough once parts overlap, which on a character
// they constantly do: a hand resting against the chest has a chest bone
// closer to some of its pixels than its own hand bone. With no explicit
// assignment there is nothing to go on but distance, and every bone is a
// candidate. (Joint seams then add, near a joint only, the one bone jointed
// to the layer's own; see withSeams.)
//
// The REST skeleton, not wherever a spring bone happens to be swinging right
// now: the bind pose is the reference the deformation is measured against,
// so capturing a mid-jiggle pose would leave the artwork permanently skewed
// once the bone came back to rest. The hierarchy is taken from the WHOLE
// rig, then narrowed to the candidates: a bone's parent may not itself be a
// candidate (a layer assigned only to a forearm), and then that bone simply
// has no jointed neighbour among them -- which is correct, not an error.
function bindingSegments(part, bonesStore) {
  const assigned = part && part.id ? bonesStore.bonesAttachedTo(part.id) : [];
  const bones = assigned.length > 0 ? assigned : bonesStore.bones;
  const candidateIds = new Set(bones.map((bone) => bone.id));
  const segments = bones.map((bone) => ({
    id: bone.id,
    head: bonesStore.restWorldHead(bone),
    tail: bonesStore.restWorldTail(bone),
    rotation: bonesStore.restWorldRotation(bone),
    parentId: bone.parentId && candidateIds.has(bone.parentId) ? bone.parentId : null,
  }));
  return { candidateIds, segments };
}

// The same rule, reachable from outside, for a vertex added to a mesh that
// is already bound: it reads the bind pose the mesh was bound against, so
// the new vertex agrees with the ones around it rather than with wherever
// the bones happen to be swinging now.
export function autoWeightOneVertex(mesh, part, restLocal, maxInfluences = DEFAULT_MAX_INFLUENCES) {
  // The SAME segments autoWeightMesh measured against, read back from the
  // bind pose: head AND tail, and the hierarchy.
  //
  // This used to measure to the bone's head alone, because the bind pose
  // did not store a tail -- and its comment called that "exactly right".
  // It was not. A point near a bone's far end is close to the bone but far
  // from its head, and close to the head of the CHILD that starts there. A
  // vertex added 0.3px from the upper arm, near the elbow, came out 95%
  // forearm, 3% thigh and 2% upper arm, where the full rule gives 97% upper
  // arm. Binding now records the tail and parent, so an added vertex is
  // weighted exactly as its neighbours were. A mesh bound by an older build
  // has neither, and keeps the old head-only behaviour rather than a guess.
  //
  // Bones the bind pose holds only for a joint seam are not candidates for
  // the ordinary rule -- they were never chosen to drive this layer -- and
  // come back in through the seam rule, exactly as they did at bind time.
  const segments = Object.entries(mesh.bindPose || {})
    .filter(([, pose]) => !pose.jointOnly)
    .map(([id, pose]) => {
      const segment = { id, head: pose.head, tail: pose.tail || pose.head, rotation: pose.rotation };
      if ('parentId' in pose) segment.parentId = pose.parentId;
      return segment;
    });
  if (segments.length === 0) return {};
  const world = localToWorld(part, restLocal);
  return withSeams(world, weightsFromSegments(world, segments, maxInfluences), mesh.joints);
}

// Auto-weighting: every vertex is bound to its nearest few bones by
// inverse squared distance to the bone segment, normalized to sum to 1.
// Capping the influence count keeps deformation crisp -- letting every
// bone touch every vertex produces mush.
export function autoWeightMesh(mesh, part, bonesStore, maxInfluences = DEFAULT_MAX_INFLUENCES) {
  // Which bones may drive this layer: see bindingSegments. Note that a
  // SPRING bone may well win a share of a layer it was never meant to
  // drive; deformRaw is what stops that share from jiggling.
  const { candidateIds, segments } = bindingSegments(part, bonesStore);
  mesh.bindPose = {};
  mesh.joints = [];
  if (segments.length === 0) {
    for (const vertex of mesh.vertices) vertex.weights = {};
    return mesh;
  }

  // Recorded with the tail and the parent too, so a vertex ADDED to this
  // mesh later (Mesh Trim) can be weighted by the identical rule without
  // consulting the live rig, which may have moved on since.
  for (const segment of segments) {
    mesh.bindPose[segment.id] = {
      head: { x: segment.head.x, y: segment.head.y },
      tail: { x: segment.tail.x, y: segment.tail.y },
      rotation: segment.rotation,
      parentId: segment.parentId,
    };
  }

  // The joint seams this layer's artwork sits on (see withSeams). Kept on
  // the mesh, with the bind pose, so Mesh Trim, undo and a saved project all
  // weight by the same seams the layer was bound with.
  const cell = Math.hypot(part.naturalWidth / Math.max(1, mesh.cols),
    part.naturalHeight / Math.max(1, mesh.rows)) * (part.scale || 1);
  const joints = serialJoints(bonesStore, candidateIds);
  for (const joint of joints) joint.reach = seamReach(part, joint, segments, cell);
  mesh.joints = joints.filter((joint) => joint.reach > 0);
  // A seam may bring in the one bone jointed to this layer's own -- the
  // forearm, for a Hand layer. Its bind transform is needed to skin by it;
  // `jointOnly` records that it drives this layer only through the seam.
  for (const joint of mesh.joints) {
    for (const id of [joint.parentId, joint.childId]) {
      if (mesh.bindPose[id]) continue;
      const bone = bonesStore.byId(id);
      const head = bonesStore.restWorldHead(bone);
      const tail = bonesStore.restWorldTail(bone);
      mesh.bindPose[id] = {
        head: { x: head.x, y: head.y },
        tail: { x: tail.x, y: tail.y },
        rotation: bonesStore.restWorldRotation(bone),
        parentId: bone.parentId || null,
        jointOnly: true,
      };
    }
  }

  for (const vertex of mesh.vertices) {
    const world = localToWorld(part, vertex.restLocal);
    vertex.weights = withSeams(world, weightsFromSegments(world, segments, maxInfluences), mesh.joints);
  }

  return mesh;
}

// RE-BINDING MUST NOT MOVE THE ARTWORK
//
// A bound layer is drawn at
//
//   part origin  +  (where its bones are now  -  where they were at bind)
//
// so once the character has been dragged in Free Move, the layer is on
// screen some distance away from its own stored origin: the bones carry
// it, and translateUnbound() deliberately leaves bound layers' x/y alone
// precisely because the bones already do that job.
//
// Re-binding recaptures the bind pose at wherever the bones are NOW, which
// zeroes that second term -- so without this, the layer drops back onto its
// stored origin the moment you press Auto-weight, looking for all the world
// like the button had teleported it back to where it was imported. It had
// not moved anything; it had removed the offset that was holding it away
// from an origin that had gone stale.
//
// So the offset is moved into the origin instead of being discarded: the
// layer keeps its place on screen, and its stored position finally means
// what it says again. Measured against the REST pose, not the simulated
// one, so re-binding mid-jiggle folds in the settled displacement and lets
// the spring carry on from there rather than freezing the wobble into the
// layer's coordinates.
function carryBoneOffsetIntoOrigin(part, bonesStore) {
  if (!part.mesh || !part.mesh.isBound) return; // a first bind moves nothing
  const rest = bonesStore.snapshotRestTransforms();
  const deformed = deformVertices(part.mesh, part, rest);
  if (deformed.length === 0) return;

  // Where the layer draws now, against where a fresh bind would put it
  // (its own centre, since the mesh's rest shape is centred on the origin).
  const cx = deformed.reduce((sum, p) => sum + p.x, 0) / deformed.length;
  const cy = deformed.reduce((sum, p) => sum + p.y, 0) / deformed.length;
  const dx = Math.round(cx - part.centerX);
  const dy = Math.round(cy - part.centerY);
  if (dx === 0 && dy === 0) return;

  // Whole cells only: a layer's origin is integer scene pixels, and that
  // invariant outranks chasing the last fraction of a cell in a pose that
  // has been rotated (where no rigid origin can be exactly right anyway).
  part.x += dx;
  part.y += dy;
}

// THE COARSEST MESH THAT CAN HOLD A LAYER'S SEAMS
//
// A joint seam blends across a band a few pixels wide, and a mesh can only
// express what happens at its vertices. With cells wider than the band, the
// blend falls between vertices: one triangle then spans the seam AND the
// artwork beside it, and drags the seam's corner toward whatever those far
// vertices are weighted to. Measured on a one-layer jacket at its default
// density (cells 9.3px across, the wrist band 7px): the cuff still parted
// 4.0px from the hand. At density 10 it closed to 1.8px, at 14 to 2.0px.
//
// So a layer with artwork on a seam is bound at least as finely as its
// narrowest seam needs -- one cell per band -- and never coarser than asked.
// Capped at the density slider's own maximum. A layer with no seam artwork
// is untouched.
export function seamDensity(part, bonesStore) {
  const { candidateIds, segments } = bindingSegments(part, bonesStore);
  if (segments.length === 0) return 0;
  const longest = Math.max(part.naturalWidth, part.naturalHeight) * (part.scale || 1);
  let needed = 0;
  for (const joint of serialJoints(bonesStore, candidateIds)) {
    if (seamReach(part, joint, segments, 0) <= 0) continue;
    needed = Math.max(needed, Math.ceil(longest / (2 * joint.band)));
  }
  return Math.min(MAX_DENSITY, needed);
}

export function bindPart(part, bonesStore, density) {
  carryBoneOffsetIntoOrigin(part, bonesStore);
  const resolved = Math.max(density || defaultDensity(part), seamDensity(part, bonesStore));
  part.mesh = autoWeightMesh(generateMesh(part, resolved), part, bonesStore);
  return part.mesh;
}

// The weight invariant, applied to a weight set of unknown provenance:
// every weight finite and positive, the set summing to 1, or empty. Used
// where weights arrive from OUTSIDE this module's own arithmetic -- a saved
// project, which may be hand-edited, shared, or written by an older build --
// so nothing downstream ever has to wonder whether the numbers it was handed
// obey the rule. Non-positive and non-numeric entries are dropped rather
// than clamped: a negative weight has no meaning to recover, and keeping it
// as 0 would only leave an empty key behind.
export function sanitizeWeights(weights) {
  const out = {};
  let total = 0;
  for (const [id, raw] of Object.entries(weights || {})) {
    const w = Number(raw);
    if (!Number.isFinite(w) || w <= 0) continue;
    out[id] = w;
    total += w;
  }
  if (total <= 0) return {};
  for (const id of Object.keys(out)) out[id] /= total;
  return out;
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

// Skinning: the inverse bind transform, blended LINEARLY.
//
//   v' = sum_i w_i * M_now,i * inv(M_bind,i) * v
//
// M_bind,i is bone i's world transform AT BIND TIME, stored per mesh in
// mesh.bindPose when the layer was bound and never touched by posing.
// inv(M_bind,i) takes the rest vertex into that bone's own frame as it was
// then; M_now,i carries it back out along wherever the bone is now. So each
// term is "where this bone has MOVED the vertex since binding", and a bone
// that has not moved hands the vertex back exactly where it started.
//
// For one bone, in 2D, that term is
//
//   R(theta_now - theta_bind) * (v - head_bind) + head_now
//
// and the weighted SUM of those terms is the whole formula. It is an affine
// combination of affine maps with weights summing to 1, which is what makes
// it independent of where scene (0,0) happens to be.
//
// WHY THIS REPLACED THE "TRANSFORM BLENDING" THAT WAS HERE
//
// This briefly blended the bones' motions instead: a circular mean of the
// rotation deltas plus a mean of the translations, applied once. The aim was
// to avoid linear blending's thinning at a strongly bent joint. It was
// wrong, and wrong in a way its own tests could not see. Each bone's motion
// was written as "rotate about the ORIGIN, then translate", so averaging
// them averaged rotations about scene (0,0) -- an arbitrary point, often
// hundreds of pixels from the joint. Measured on an elbow away from the
// origin, a vertex shared by two bones:
//
//   same pose, character moved +300px      122.8px of error (should be 0)
//   joint area, forearm bent 58 / 90 / 128  142% / 281% / 573% (should be ~100)
//
// -- vertices flung outward along arcs about a point nowhere near the bone,
// growing with distance from the canvas origin and with the bend. Its tests
// put both bone heads exactly AT (0,0), the one layout where the pivot and
// the joint coincide and the error vanishes.
//
// The linear blend, on the same elbow: 0.0000px of origin error, exact for
// every single-bone vertex, and joint area 98.5% / 94.6% / 88.5% / 81.4% at
// 30 / 58 / 90 / 128 degrees with a realistic weight falloff across the
// joint. That thinning at a hard bend is the known, bounded behaviour of
// standard linear blend skinning -- a very different thing from a layer
// inflating five-fold.
//
// With no bone moved, every term is the vertex itself, so the mesh sits
// exactly at rest and renders identically to the undeformed sprite.
function deformRaw(mesh, part, boneTransforms) {
  const out = new Array(mesh.vertices.length);

  for (let i = 0; i < mesh.vertices.length; i++) {
    const vertex = mesh.vertices[i];
    const rest = localToWorld(part, vertex.restLocal);

    let x = 0;
    let y = 0;
    let totalWeight = 0;

    for (const [boneId, weight] of Object.entries(vertex.weights)) {
      if (!(weight > 0)) continue;
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
      //
      // A bone this layer takes ONLY through a joint seam is the exception,
      // and is always read live. The seam exists to move exactly as the
      // neighbouring layer moves -- and that layer, owning the bone, reads it
      // live. Reading it rigidly here would put the two sides of the seam on
      // two different poses of the same bone and reopen the gap whenever it
      // swung.
      const springElsewhere = !bind.jointOnly && current.physics && current.partId !== (part && part.id);
      const head = springElsewhere ? current.rigidHead : current.head;
      const rotation = springElsewhere ? current.rigidRotation : current.rotation;

      // inv(M_bind): into the bone's frame as it was at bind time...
      const dx = rest.x - bind.head.x;
      const dy = rest.y - bind.head.y;
      // ...then M_now: turned by how far the bone has rotated since, and
      // carried to where its head is now.
      const angle = rotation - bind.rotation;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      x += weight * (dx * cos - dy * sin + head.x);
      y += weight * (dx * sin + dy * cos + head.y);
      totalWeight += weight;
    }

    // Dividing by the weight actually used is what renormalizes a vertex
    // whose surviving bones no longer sum to 1 (one having been deleted
    // since binding, say). With nothing usable left, the vertex stays at
    // rest rather than collapsing to the origin.
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

// EXCEPT ON A JOINT SEAM.
//
// Two layers meeting at a joint are weighted identically across the seam
// (withSeams), so their shared edge follows the SAME continuous line in both.
// Rounding then pulls them apart again: each layer has its own vertices along
// that edge, each rounded on its own, so the two snapped edges wander up to
// half a pixel apart in opposite directions -- measured, the seam still left
// 1-3 background pixels showing between cuff and hand in ten frames of a slow
// wrist swing. Left unsnapped, the two edges are the one line, and a pixel
// centre cannot fall between them.
//
// The band is a bend -- it stretches and turns by design -- so whole-pixel
// stepping has nothing to protect there. And at rest an unsnapped vertex maps
// the texture by the identity, so the art is still drawn exactly as authored.
//
// A PxLink point is the same situation across two layers that share no mesh
// at all: the solver lands each layer's link point on exactly the same
// continuous position, and rounding each layer's vertices on its own would
// pull them apart again by up to a pixel. So the vertices around a link point
// stay unsnapped too (pxlink.js marks them).
export function deformVerticesSnapped(mesh, part, boneTransforms, half = null) {
  const link = pxlinkCorrection(part, boneTransforms);
  const positions = deformVertices(mesh, part, boneTransforms, half);
  const onSeam = seamVertices(mesh, part);
  const nearLink = link && link.mesh === mesh ? link.nearLink : null;
  return positions.map((p, i) => (
    onSeam[i] || (nearLink && nearLink[i]) ? p : { x: Math.round(p.x), y: Math.round(p.y) }
  ));
}

// Which vertices lie in a joint seam's band, in the bind pose. Cached
// against the joints and the vertices, which change only on a re-bind or a
// Mesh Trim edit.
function seamVertices(mesh, part) {
  const joints = mesh.joints || [];
  if (joints.length === 0) return [];
  const key = `${vertexSignature(mesh)}|${part.x}|${part.y}|${part.scale}|${part.rotation}`;
  if (mesh._seamVertices && mesh._seamVerticesKey === key && mesh._seamVerticesJoints === joints) {
    return mesh._seamVertices;
  }
  const flags = mesh.vertices.map((vertex) => {
    const world = localToWorld(part, vertex.restLocal);
    return joints.some((joint) => {
      const { s, t } = seamFrame(joint, world);
      return Math.abs(s) < joint.band && Math.abs(t) <= joint.reach;
    });
  });
  mesh._seamVertices = flags;
  mesh._seamVerticesKey = key;
  mesh._seamVerticesJoints = joints;
  return flags;
}

// ---------------------------------------------------------------------------
// Px Pin: pixels excused from deformation.
//
// WHY THE FIRST VERSION TORE
//
// Pins started life as a rendering trick: the rasterizer skipped pinned
// texels, and a second pass painted them at their undeformed spot. The
// mesh never knew the pins existed. So the deformation carried the
// surrounding artwork wherever physics wanted while those texels stayed
// put, and the two simply came apart -- a hair layer with a pinned scalp
// band opened a seam up to 80 cells wide, across 49 columns, at exactly
// the pin boundary. That is what a "simple override, invisible to the
// surrounding mesh" gets you, and it also broke the renderer's founding
// promise that every scene pixel is decided exactly once by one mesh.
//
// A pin is now a CONSTRAINT ON THE MESH instead. Each vertex gets an
// influence in 0..1 -- 1 where it sits on pinned artwork, easing to 0
// about a mesh cell away -- and its final position is that fraction of the
// way from where the bones would put it back to where it rests. Pinned
// regions therefore hold still, their neighbours are pulled along a
// continuous surface, and the boundary cannot tear because there is only
// ONE mesh and one raster pass again: a seam would have to be a hole in a
// triangle, which the rasterizer cannot produce.
//
// The transition is a smoothstep so the surface has no crease, and it
// spans one mesh cell because that is the finest detail this mesh can
// express. For the same reason a pin holds the whole CELL its pixel sits
// in: cell corners are the only places a mesh can pin anything, so holding
// the cell is what makes the pixel land exactly on its rest position. The
// pinned pixel is therefore exact, and the cost is that its immediate
// neighbours within the cell come along -- raise Mesh density in Bind mode
// to shrink that neighbourhood.

//
// HOW WIDE THE TRANSITION IS -- AND WHY IT IS NOT A CONSTANT
//
// The band between held artwork and free artwork is the only thing that
// bridges the two, so it absorbs the WHOLE difference between where the pin
// holds a vertex and where the bone would put it. Spread over a width w, a
// difference D stretches neighbouring texels apart by roughly D / w each.
//
// Any FIXED width therefore tears at some swing. One cell (about six texels
// on a default mesh) held at the default spring -- measured 1.3px worst
// between a pinned texel and its neighbour at 17 degrees of lag -- and tore
// at the loosest spring the sliders allow: 55 degrees of lag on a slow sway,
// whole turns on a throw, pinned and unpinned texels landing 4.4px apart and
// the hair peeling off the pinned scalp as a separate cap.
//
// Widening it to a fixed three cells was tried and reverted, correctly: for
// a thin pinned stripe, which touches a staircase of cells right across a
// layer, three cells at ALL times held 73% of a layer instead of 30%, even
// at rest, where there was no shear to absorb.
//
// Both measurements say the same thing: the width has to follow the pull,
// not be chosen once. So it is one cell -- exactly as before -- whenever the
// bones are barely pulling on the pins, and widens in proportion to the pull
// when they pull hard (deformVertices, PIN_BAND_PER_PULL). A layer at rest,
// or on a stiff spring, is held exactly as tightly as it always was; a layer
// being whirled round on a loose one bends away from its pins over a
// distance long enough to carry the bend instead of tearing at the edge.

// Texels of transition band per scene pixel the bones are pulling the held
// region away from its pins. 1.5 keeps the smoothstep's steepest slope -- 1.5x
// its average -- to about one extra pixel of stretch per pixel crossed, which
// is where nearest-neighbour texels stop reading as detached.
const PIN_BAND_PER_PULL = 1.5;

// A cheap fingerprint of a mesh's rest shape, for caches that must notice
// Mesh Trim editing the vertex list in place: a vertex added or removed
// changes the count, one dragged changes the sums.
function vertexSignature(mesh) {
  let sumX = 0;
  let sumY = 0;
  for (const vertex of mesh.vertices) { sumX += vertex.restLocal.x; sumY += vertex.restLocal.y; }
  return `${mesh.vertices.length}|${sumX}|${sumY}`;
}

// Distance from every vertex to the nearest held cell, in texels. Pins change
// on a tap and the rest shape only under Mesh Trim, so this is computed when
// either actually changes rather than every frame; the per-frame band width
// is applied on top in pinInfluence. `cell` is one mesh cell, the narrowest
// band.
function pinDistances(mesh, part) {
  // Keyed on the mesh's vertices as well as the pins: Mesh Trim adds, moves
  // and removes vertices IN PLACE, and a cache keyed on the pins alone would
  // then hand back an array for a different mesh -- the wrong length, so a
  // new vertex read an undefined influence and deformed to NaN.
  const key = `${part.pinsVersion || 0}|${vertexSignature(mesh)}`;
  if (mesh._pinDistances && mesh._pinDistancesKey === key) return mesh._pinDistances;

  const width = part.naturalWidth;
  const height = part.naturalHeight;
  const cellW = width / Math.max(1, mesh.cols);
  const cellH = height / Math.max(1, mesh.rows);

  // Pinned texels collapse to the CELLS they sit in. A mesh can only hold
  // what its vertices can express, and the vertices are cell corners -- so
  // the cell under a pinned pixel is held whole, which is what makes the
  // pixel itself land exactly on its rest position rather than somewhere
  // within a fraction of a cell of it. Collapsing also caps the work at
  // cols x rows however many thousands of pixels a wide brush painted.
  const cells = new Set();
  for (const index of part.pins) {
    const cu = Math.min(mesh.cols - 1, Math.floor((index % width) / cellW));
    const cv = Math.min(mesh.rows - 1, Math.floor(Math.floor(index / width) / cellH));
    cells.add(cv * mesh.cols + cu);
  }
  const held = [...cells].map((c) => {
    const cu = c % mesh.cols;
    const cv = Math.floor(c / mesh.cols);
    return [cu * cellW, cv * cellH, (cu + 1) * cellW, (cv + 1) * cellH];
  });

  const distances = mesh.vertices.map((vertex) => {
    // The vertex in texel coordinates; pins are texel-indexed.
    const u = vertex.restLocal.x + width / 2;
    const v = vertex.restLocal.y + height / 2;
    let nearest = Infinity;
    for (const [x0, y0, x1, y1] of held) {
      // Distance to the held cell's rectangle, so every corner of a cell
      // carrying a pin reads exactly zero and is held completely.
      const dx = Math.max(x0 - u, 0, u - x1);
      const dy = Math.max(y0 - v, 0, v - y1);
      const d = Math.hypot(dx, dy);
      if (d < nearest) nearest = d;
      if (nearest === 0) break;
    }
    return nearest;
  });

  mesh._pinDistances = { distances, cell: Math.max(1, Math.max(cellW, cellH)) };
  mesh._pinDistancesKey = key;
  return mesh._pinDistances;
}

// Per-vertex pin influence in 0..1: 1 on held cells, easing to 0 across a
// band `radius` texels wide (never narrower than one mesh cell). With no
// radius given it is the one-cell band -- the influence at rest, which is
// also what the pierce solver masks by.
export function pinInfluence(mesh, part, radius = 0) {
  const { distances, cell } = pinDistances(mesh, part);
  const band = Math.max(cell, radius);
  if (band === cell && mesh._pinInfluence && mesh._pinInfluenceFor === mesh._pinDistances) {
    return mesh._pinInfluence;
  }
  const influence = distances.map((nearest) => {
    if (nearest === Infinity) return 0;
    const t = Math.max(0, Math.min(1, 1 - nearest / band));
    return t * t * (3 - 2 * t); // smoothstep: no crease at either end
  });
  if (band === cell) {
    mesh._pinInfluence = influence;
    mesh._pinInfluenceFor = mesh._pinDistances;
  }
  return influence;
}

// The deformation every consumer sees: the layer's own deformation (below),
// then its PxLink correction, if it is linked to other layers.
//
// PxLink is applied HERE, and only here, so that nothing can see a linked
// layer anywhere but where it is drawn: the renderer, Pierce's contact,
// weight painting and every other caller of this function get the same
// corrected geometry without knowing links exist. The solver (pxlink.js)
// deforms each linked layer uncorrected, solves the joint constraint across
// all of them, and hands back each layer's correction -- along with the
// uncorrected positions it already computed, so they are not worked out
// twice in one frame.
export function deformVertices(mesh, part, boneTransforms, half = null) {
  const link = pxlinkCorrection(part, boneTransforms);
  if (!link) return deformVerticesUncorrected(mesh, part, boneTransforms, half);
  // The solve's own uncorrected positions are the single-copy answer; one
  // half of a seam-split layer is worked out for itself.
  const base = link.mesh === mesh && link.uncorrected && half === null
    ? link.uncorrected
    : deformVerticesUncorrected(mesh, part, boneTransforms, half);
  return applyLinkWelds(mesh, base, link);
}

// A PxLink correction applied to a layer's deformed vertices: each weld -- a
// smooth local displacement that lands the layer's link point EXACTLY on the
// link's meeting point, fading to nothing a few cells away. Nothing else
// moves: vertices outside every weld are returned exactly as the layer's own
// bones, springs, pins and V put them. (pxlink.js applies the same function
// when it reads a link point back.)
export function applyLinkWelds(mesh, positions, link) {
  const welds = link && link.mesh === mesh ? link.welds : [];
  if (welds.length === 0) return positions;
  return positions.map((p, i) => {
    let { x, y } = p;
    const vertex = mesh.vertices[i];
    for (const weld of welds) {
      const d = Math.hypot(vertex.u - weld.u, vertex.v - weld.v);
      const k = smoothstep01(1 - d / weld.radius);
      if (k <= 0) continue;
      x += weld.dx * k;
      y += weld.dy * k;
    }
    return { x, y };
  });
}

// The layer's own deformation, before any PxLink: bone skinning, then pins
// pulling their neighbourhood back toward rest, then -- for a pierced layer
// being spread -- its V. One mesh, no seams.
export function deformVerticesUncorrected(mesh, part, boneTransforms, half = null) {
  const out = pinned(mesh, part, boneTransforms, deformRaw(mesh, part, boneTransforms));
  // A pierced layer's V, LAST: each half turns about its hinge as a whole,
  // pinned pixels and all, so the pins and the V compose instead of arguing
  // -- a pinned patch on a finger swings with the finger. `half` picks which
  // of a seam-split layer's two copies this is (see spread.js).
  return applySpread(mesh, part, out, half);
}

// Pins pulling their neighbourhood back toward rest.
function pinned(mesh, part, boneTransforms, out) {
  if (!part || !part.pins || part.pins.size === 0) return out;

  // Pinned artwork holds still relative to its LAYER, not to the canvas:
  // a Free-Move drag or a rigid/pivot chain still carries it, and this is
  // how far it has been carried.
  const carriage = pinCarriageOffset(part, boneTransforms);
  const anchors = mesh.vertices.map((vertex) => {
    const rest = localToWorld(part, vertex.restLocal);
    return { x: rest.x + carriage.x, y: rest.y + carriage.y };
  });

  // How hard the bones are pulling the held region off its pins right now:
  // the furthest any fully held vertex would have gone without them. Read
  // from the skinned result BEFORE the pins act, so it measures the pull and
  // cannot feed back on itself. The band widens with it (see the note on
  // pinInfluence); a pull of a pixel or two leaves it at its one-cell rest
  // width, exactly as it has always been.
  const atRest = pinInfluence(mesh, part);
  let pull = 0;
  for (let i = 0; i < out.length; i++) {
    if (atRest[i] < 1) continue;
    const d = Math.hypot(out[i].x - anchors[i].x, out[i].y - anchors[i].y);
    if (d > pull) pull = d;
  }
  const scale = part.scale || 1;
  const influence = pinInfluence(mesh, part, (PIN_BAND_PER_PULL * pull) / scale);

  for (let i = 0; i < out.length; i++) {
    const k = influence[i];
    if (k <= 0) continue;
    out[i] = {
      x: out[i].x + (anchors[i].x - out[i].x) * k,
      y: out[i].y + (anchors[i].y - out[i].y) * k,
    };
  }
  return out;
}

// A pinned pixel does not skin, does not turn with a bone and does not
// jiggle -- but it is NOT nailed to the canvas. The layer it belongs to is
// still carried around (Free Move drags the whole character; a rigid or
// pivot chain can carry the layer wholesale), and a pin rides along with
// that legitimate whole-layer motion. What it is excused from is the
// deformation machinery only.
//
// "Where the layer is being carried" is measured the same way the
// auto-weight fix measures it: deform the mesh at the REST pose (each
// bone's rigid transform -- carried by the drag, never swinging) and take
// the centroid's offset from the part's own centre. For a whole-character
// drag that is exactly the drag delta; physics never touches it, because
// the rest pose ignores the simulation entirely; and re-posing a bone in
// Rig mode carries the pins with the layer's average motion instead of
// stranding them in space where the limb used to be. Rounded to whole
// cells, keeping the grid invariant.
export function pinCarriageOffset(part, boneTransforms) {
  if (!part.mesh || !part.mesh.isBound || !boneTransforms) return { x: 0, y: 0 };

  const rest = {};
  for (const [id, t] of Object.entries(boneTransforms)) {
    const head = t.rigidHead || t.head;
    const rotation = t.rigidRotation ?? t.rotation;
    rest[id] = { head, rotation, physics: false, partId: t.partId, rigidHead: head, rigidRotation: rotation };
  }
  const points = deformRaw(part.mesh, part, rest);
  if (points.length === 0) return { x: 0, y: 0 };

  const cx = points.reduce((sum, p) => sum + p.x, 0) / points.length;
  const cy = points.reduce((sum, p) => sum + p.y, 0) / points.length;
  return { x: Math.round(cx - part.centerX), y: Math.round(cy - part.centerY) };
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
