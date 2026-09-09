// Skeleton model: bones and the parent/child hierarchy between them.
//
// Deliberately separate from parts.js. A bone does not belong to a Part --
// later a single mesh may span several parts, or one part may need several
// bones -- so the two systems only meet at the mesh-binding step.
//
// Each bone stores its transform in its PARENT'S space, not world space:
//
//   localHead - where the bone's head sits in the parent's coordinate frame
//   rotation  - the bone's angle relative to the parent's angle
//   length    - how long the bone is
//
// World positions are derived by walking up the chain. That is what makes
// this a real forward-kinematics skeleton: rotating a parent automatically
// carries every descendant with it, because the children's stored values
// are relative and never have to be rewritten. Storing world coordinates
// instead would break the moment a parent moved.

let nextId = 1;
let nextBoneNumber = 1;

export class Bone {
  constructor({ name, parentId = null, localHead, rotation = 0, length = 0 }) {
    this.id = `bone_${nextId++}`;
    this.name = name;
    this.parentId = parentId; // null for a root bone
    this.localHead = { x: localHead.x, y: localHead.y };
    this.rotation = rotation; // radians, relative to the parent's world rotation
    this.length = length;

    // FUTURE HOOK: mesh binding (Part 4) will reference bones by id to
    // build vertex weight associations. Nothing here assumes a bone maps
    // to exactly one Part.
  }

  get isRoot() {
    return this.parentId === null;
  }
}

function rotatePoint(x, y, angle) {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return { x: x * cos - y * sin, y: x * sin + y * cos };
}

class BonesStore {
  constructor() {
    this._bones = [];
    this._selectedId = null;
    this._listeners = new Set();
  }

  get bones() {
    return this._bones;
  }

  get isEmpty() {
    return this._bones.length === 0;
  }

  get selectedId() {
    return this._selectedId;
  }

  get selected() {
    return this.byId(this._selectedId);
  }

  byId(id) {
    return this._bones.find((bone) => bone.id === id) || null;
  }

  get roots() {
    return this._bones.filter((bone) => bone.parentId === null);
  }

  childrenOf(id) {
    return this._bones.filter((bone) => bone.parentId === id);
  }

  parentOf(bone) {
    return bone && bone.parentId ? this.byId(bone.parentId) : null;
  }

  subscribe(listener) {
    this._listeners.add(listener);
    listener('structure');
    return () => this._listeners.delete(listener);
  }

  _emit(type) {
    this._listeners.forEach((listener) => listener(type));
  }

  notifyTransformed() {
    this._emit('transform');
  }

  // ---- Forward kinematics ------------------------------------------------
  // Walking up to the root each time is O(depth); skeletons here are a few
  // dozen bones deep at most, so this stays far cheaper than maintaining
  // and invalidating a cache.

  worldRotation(bone) {
    const parent = this.parentOf(bone);
    return parent ? this.worldRotation(parent) + bone.rotation : bone.rotation;
  }

  worldHead(bone) {
    const parent = this.parentOf(bone);
    if (!parent) return { x: bone.localHead.x, y: bone.localHead.y };

    const parentHead = this.worldHead(parent);
    const offset = rotatePoint(bone.localHead.x, bone.localHead.y, this.worldRotation(parent));
    return { x: parentHead.x + offset.x, y: parentHead.y + offset.y };
  }

  worldTail(bone) {
    const head = this.worldHead(bone);
    const angle = this.worldRotation(bone);
    return {
      x: head.x + bone.length * Math.cos(angle),
      y: head.y + bone.length * Math.sin(angle),
    };
  }

  // Every bone's current world transform, keyed by id. This is the whole
  // input the mesh skinning needs each frame -- Part 6's animation loop
  // can feed exactly this into deformVertices().
  snapshotTransforms() {
    const transforms = {};
    for (const bone of this._bones) {
      transforms[bone.id] = {
        head: this.worldHead(bone),
        rotation: this.worldRotation(bone),
      };
    }
    return transforms;
  }

  // Converts a world point into the coordinate frame a child of `parent`
  // is stored in. With no parent, the frame is world space.
  toParentSpace(parent, x, y) {
    if (!parent) return { x, y };
    const parentHead = this.worldHead(parent);
    return rotatePoint(x - parentHead.x, y - parentHead.y, -this.worldRotation(parent));
  }

  // ---- Mutations ---------------------------------------------------------

  // Creates a bone spanning the two world-space points. The first bone
  // added has no parent and becomes the root.
  addBone({ parentId = null, head, tail, name = null }) {
    const parent = parentId ? this.byId(parentId) : null;
    const dx = tail.x - head.x;
    const dy = tail.y - head.y;
    const worldAngle = Math.atan2(dy, dx);

    const bone = new Bone({
      name: name || `Bone_${nextBoneNumber++}`,
      parentId: parent ? parent.id : null,
      localHead: this.toParentSpace(parent, head.x, head.y),
      rotation: parent ? worldAngle - this.worldRotation(parent) : worldAngle,
      length: Math.hypot(dx, dy),
    });

    this._bones.push(bone);
    this._emit('structure');
    return bone;
  }

  select(id) {
    if (this._selectedId === id) return;
    this._selectedId = id;
    this._emit('selection');
  }

  rename(id, name) {
    const bone = this.byId(id);
    if (!bone) return;
    bone.name = name;
    this._emit('structure');
  }

  // Moves the head, keeping the tail where it is -- so dragging a child's
  // head to a different attachment point on its parent re-aims the bone
  // rather than dragging the whole chain along.
  setWorldHead(bone, x, y) {
    const tail = this.worldTail(bone);
    bone.localHead = this.toParentSpace(this.parentOf(bone), x, y);
    this.setWorldTail(bone, tail.x, tail.y);
  }

  // Moves the tail, which is what defines the bone's rotation and length.
  setWorldTail(bone, x, y) {
    const head = this.worldHead(bone);
    const dx = x - head.x;
    const dy = y - head.y;
    const parent = this.parentOf(bone);

    bone.length = Math.hypot(dx, dy);
    bone.rotation = Math.atan2(dy, dx) - (parent ? this.worldRotation(parent) : 0);
    this._emit('transform');
  }

  // Nudges the head in world space, keeping the bone's shape: the tail
  // follows, so the whole bone (and its children) translate together.
  nudgePosition(bone, dx, dy) {
    const parent = this.parentOf(bone);
    const head = this.worldHead(bone);
    bone.localHead = this.toParentSpace(parent, head.x + dx, head.y + dy);
    this._emit('transform');
  }

  // Rotating a bone rotates every descendant with it, for free: their
  // stored rotations are relative to this one.
  nudgeRotation(bone, deltaRadians) {
    bone.rotation += deltaRadians;
    this._emit('transform');
  }

  // Deleting re-parents any children onto the deleted bone's own parent
  // and preserves their world positions, rather than cascade-deleting
  // them. Losing a limb because its shoulder was removed is the more
  // destructive outcome, and re-parenting is trivially undoable by hand
  // whereas deleted bones are not.
  deleteBone(id) {
    const bone = this.byId(id);
    if (!bone) return;

    const newParent = this.parentOf(bone);
    for (const child of this.childrenOf(id)) {
      // Capture where the child sits now, re-parent, then restore it, so
      // the child does not jump when its frame of reference changes.
      const head = this.worldHead(child);
      const tail = this.worldTail(child);

      child.parentId = newParent ? newParent.id : null;
      child.localHead = this.toParentSpace(newParent, head.x, head.y);
      this.setWorldTail(child, tail.x, tail.y);
    }

    this._bones = this._bones.filter((candidate) => candidate.id !== id);
    if (this._selectedId === id) this._selectedId = null;
    this._emit('structure');
  }

  // ---- Queries used by the UI -------------------------------------------

  // Flattens the tree depth-first into [{ bone, depth }], so the panel can
  // render it as an indented list.
  toTreeList() {
    const rows = [];
    const walk = (bone, depth) => {
      rows.push({ bone, depth });
      for (const child of this.childrenOf(bone.id)) walk(child, depth + 1);
    };
    for (const root of this.roots) walk(root, 0);
    return rows;
  }

  // Nearest bone whose body is within `threshold` of the point, or null.
  hitTest(x, y, threshold) {
    let best = null;
    let bestDistance = threshold;

    for (const bone of this._bones) {
      const distance = this._distanceToBone(bone, x, y);
      if (distance <= bestDistance) {
        best = bone;
        bestDistance = distance;
      }
    }
    return best;
  }

  _distanceToBone(bone, x, y) {
    const head = this.worldHead(bone);
    const tail = this.worldTail(bone);
    const dx = tail.x - head.x;
    const dy = tail.y - head.y;
    const lengthSquared = dx * dx + dy * dy;

    if (lengthSquared === 0) return Math.hypot(x - head.x, y - head.y);

    // Project the point onto the bone segment, clamped to its ends.
    const t = Math.max(0, Math.min(1, ((x - head.x) * dx + (y - head.y) * dy) / lengthSquared));
    return Math.hypot(x - (head.x + t * dx), y - (head.y + t * dy));
  }
}

export const bonesStore = new BonesStore();
