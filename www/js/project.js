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

import { Part, partsStore, reservePartId } from './parts.js';
import { Bone, bonesStore, reserveBoneId } from './bones.js';
import { MeshVertex, PartMesh } from './mesh.js';
import { sceneStore } from './scene.js';

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
    physicsEnabled: bone.physicsEnabled,
    stiffness: bone.stiffness,
    damping: bone.damping,
    gravityInfluence: bone.gravityInfluence,
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
  bone.physicsEnabled = Boolean(data.physicsEnabled);
  bone.stiffness = data.stiffness;
  bone.damping = data.damping;
  bone.gravityInfluence = data.gravityInfluence;
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
}
