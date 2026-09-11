// Project serialization: the whole scene as plain data, and back again.
//
// ONE serializer serves two very different callers:
//
//   * Save/Load writes snapshots into IndexedDB, which stores typed arrays
//     natively via structured clone -- so pixel buffers go in as-is, with
//     no base64 round-trip to bloat them.
//   * Undo/redo keeps snapshots in memory. There the pixel buffers are
//     SHARED rather than copied: a Part's pixels are written once at
//     import and never mutated again, so every history entry can point at
//     the same buffer. That is what makes whole-state snapshots cheap
//     enough to use as the undo mechanism.
//
// Everything else (positions, flags, bones, mesh weights) is small and is
// deep-copied, so a snapshot can never be mutated from underneath.

import {
  Part, partsStore, reservePartId,
  PierceRole, PIERCE_ROLES, clampPierceDepth,
  DEFAULT_PIERCE_ENTER, DEFAULT_PIERCE_END,
  PiercePhysics, PIERCE_PHYSICS,
} from './parts.js';
import { Bone, bonesStore, reserveBoneId, DEFAULT_INERTIA, JointType, JOINT_TYPES } from './bones.js';
import { MeshVertex, PartMesh } from './mesh.js';
import { sceneStore } from './scene.js';
import { resetPierceContainment } from './pierce.js';

export const PROJECT_FORMAT_VERSION = 1;

function serializeMesh(mesh) {
  if (!mesh) return null;
  return {
    cols: mesh.cols,
    rows: mesh.rows,
    density: mesh.density,
    triangles: [...mesh.triangles],
    vertices: mesh.vertices.map((vertex) => ({
      u: vertex.u,
      v: vertex.v,
      restLocal: { x: vertex.restLocal.x, y: vertex.restLocal.y },
      weights: { ...vertex.weights },
    })),
    bindPose: Object.fromEntries(
      Object.entries(mesh.bindPose).map(([boneId, pose]) => [
        boneId,
        { head: { x: pose.head.x, y: pose.head.y }, rotation: pose.rotation },
      ])
    ),
  };
}

function deserializeMesh(data) {
  if (!data) return null;
  const vertices = data.vertices.map((v) => {
    const vertex = new MeshVertex(v.u, v.v, { x: v.restLocal.x, y: v.restLocal.y });
    vertex.weights = { ...v.weights };
    return vertex;
  });
  const mesh = new PartMesh({
    cols: data.cols,
    rows: data.rows,
    density: data.density,
    vertices,
    triangles: [...data.triangles],
  });
  mesh.bindPose = Object.fromEntries(
    Object.entries(data.bindPose || {}).map(([boneId, pose]) => [
      boneId,
      { head: { x: pose.head.x, y: pose.head.y }, rotation: pose.rotation },
    ])
  );
  return mesh;
}

// `copyPixels: false` shares the buffer (in-memory history); `true` clones
// it, which matters only if a caller ever intends to keep the snapshot
// alive past the part's own lifetime.
function serializePart(part, copyPixels) {
  return {
    id: part.id,
    name: part.name,
    width: part.naturalWidth,
    height: part.naturalHeight,
    pixels: copyPixels ? new Uint8ClampedArray(part.pixels) : part.pixels,
    x: part.x,
    y: part.y,
    scale: part.scale,
    rotation: part.rotation,
    zIndex: part.zIndex,
    visible: part.visible,
    locked: part.locked,
    placement: part.placement,
    // Px Pin: texel indices in the layer's own pixel grid. A tiny array,
    // and part of the scene state -- so undo, Reverse and named saves all
    // carry pins along without any special casing.
    pins: [...part.pins],
    // Pierce: the explicit role, the painted region in the layer's own
    // grid, and (for a piercer) its two depths. Same treatment as pins --
    // small arrays of numbers that ride along with undo, Reverse, named
    // saves and PSaver exports without any special casing.
    pierceRole: part.pierceRole,
    pierceRegion: [...part.pierceRegion],
    pierceDeformRegion: [...part.pierceDeformRegion],
    pierceBarrierRegion: [...part.pierceBarrierRegion],
    pierceEnteredRegion: [...part.pierceEnteredRegion],
    piercePhysics: part.piercePhysics,
    pierceEnter: part.pierceEnter,
    pierceEnd: part.pierceEnd,
    mesh: serializeMesh(part.mesh),
  };
}

function deserializePart(data) {
  reservePartId(data.id);
  const part = new Part({
    name: data.name,
    image: null,
    pixels: data.pixels,
    width: data.width,
    height: data.height,
    objectUrl: null,
    x: data.x,
    y: data.y,
    scale: data.scale,
    rotation: data.rotation,
    placement: data.placement || 'manual',
  });
  part.id = data.id; // keep ids stable so mesh weights keep referring to bones
  part.zIndex = data.zIndex;
  part.visible = data.visible !== false;
  part.locked = Boolean(data.locked);
  part.pins = new Set(data.pins || []); // absent in older saves: no pins
  // Absent in saves made before Pierce existed, which is exactly a layer
  // with no role -- the defaults already say that.
  // The PIERCED role was called "interactive" when these projects were
  // saved. The name changed; what it means did not, so a project from
  // before the rename opens with its roles intact rather than silently
  // losing them.
  const role = data.pierceRole === 'interactive' ? PierceRole.PIERCED : data.pierceRole;
  part.pierceRole = PIERCE_ROLES.has(role) ? role : PierceRole.NONE;
  part.pierceRegion = new Set(data.pierceRegion || []);
  // Absent in projects saved before the deformable mask existed, and an
  // empty one means "all of the pierceable area gives way" -- which is
  // exactly how those projects behaved, so they load unchanged.
  part.pierceDeformRegion = new Set(data.pierceDeformRegion || []);
  // Absent before barriers existed; empty means no walls, which is how
  // those projects behaved.
  part.pierceBarrierRegion = new Set(data.pierceBarrierRegion || []);
  // Absent before the morph existed; empty means the region keeps its rest
  // shape, which is what those projects looked like.
  part.pierceEnteredRegion = new Set(data.pierceEnteredRegion || []);
  // Absent before the setting existed, and its default is the behaviour
  // those projects were saved under.
  part.piercePhysics = PIERCE_PHYSICS.has(data.piercePhysics)
    ? data.piercePhysics : PiercePhysics.PIERCER;
  part.pierceEnter = clampPierceDepth(data.pierceEnter ?? DEFAULT_PIERCE_ENTER);
  part.pierceEnd = clampPierceDepth(data.pierceEnd ?? DEFAULT_PIERCE_END);
  part.mesh = deserializeMesh(data.mesh);
  return part;
}

function serializeBone(bone) {
  return {
    id: bone.id,
    name: bone.name,
    parentId: bone.parentId,
    localHead: { x: bone.localHead.x, y: bone.localHead.y },
    rotation: bone.rotation,
    length: bone.length,
    jointType: bone.jointType,
    // Kept alongside jointType so a project saved now still opens in a
    // build from before pivot existed, reading as rigid or physics.
    physicsEnabled: bone.physicsEnabled,
    stiffness: bone.stiffness,
    damping: bone.damping,
    gravityInfluence: bone.gravityInfluence,
    inertia: bone.inertia,
    simWorldRotation: bone.simWorldRotation,
    angularVelocity: bone.angularVelocity,
    attachedPartId: bone.attachedPartId,
    visible: bone.visible,
  };
}

function deserializeBone(data) {
  reserveBoneId(data.id, data.name);
  const bone = new Bone({
    name: data.name,
    parentId: data.parentId,
    localHead: data.localHead,
    rotation: data.rotation,
    length: data.length,
  });
  bone.id = data.id;
  // Projects saved before pivot existed carry only the physics flag; the
  // two choices it could express map onto the first two joint types.
  bone.jointType = JOINT_TYPES.has(data.jointType)
    ? data.jointType
    : (data.physicsEnabled ? JointType.PHYSICS : JointType.RIGID);
  bone.stiffness = data.stiffness;
  bone.damping = data.damping;
  bone.gravityInfluence = data.gravityInfluence;
  // Projects saved before Free Move existed have no sway value; those
  // rigs were authored without it, so they keep the default.
  bone.inertia = data.inertia ?? DEFAULT_INERTIA;
  bone.simWorldRotation = data.simWorldRotation ?? null;
  bone.angularVelocity = data.angularVelocity || 0;
  bone.attachedPartId = data.attachedPartId ?? null;
  bone.visible = data.visible !== false;
  return bone;
}

export function serializeProject({ copyPixels = false } = {}) {
  return {
    version: PROJECT_FORMAT_VERSION,
    canvas: { width: sceneStore.width, height: sceneStore.height },
    parts: partsStore.parts.map((part) => serializePart(part, copyPixels)),
    bones: bonesStore.bones.map(serializeBone),
    selectedPartId: partsStore.selectedId,
    selectedBoneId: bonesStore.selectedId,
  };
}

// Rebuilds the entire scene from a snapshot. Applied wholesale rather than
// diffed: one code path restores a loaded project, an undo and a redo, so
// there is only one thing to get right.
export function applyProject(data) {
  if (!data) return;
  if (data.canvas) sceneStore.setSize(data.canvas.width, data.canvas.height);
  partsStore.replaceAll((data.parts || []).map(deserializePart), data.selectedPartId ?? null);
  bonesStore.replaceAll((data.bones || []).map(deserializeBone), data.selectedBoneId ?? null);
  // Loading (or undoing) teleports the skeleton; that jump is not motion
  // anyone applied, so the springs must not feel it as one.
  bonesStore.resumePhysics();
  // Same reasoning for a contained piercer tip. That state remembers which
  // side of a wall the tip was on, and ids survive a load -- so without
  // this, a scene restored with the needle somewhere else would sweep from
  // where the OLD one had got to and drag the contact across with it.
  resetPierceContainment();
}
