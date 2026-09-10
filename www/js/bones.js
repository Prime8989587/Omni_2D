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

// Loading a project restores bones under their saved ids and names, so
// neither generator may later hand out something that already exists.
export function reserveBoneId(id, name) {
  const match = /^bone_(\d+)$/.exec(String(id));
  if (match) nextId = Math.max(nextId, Number(match[1]) + 1);
  const named = /^Bone_(\d+)$/.exec(String(name || ''));
  if (named) nextBoneNumber = Math.max(nextBoneNumber, Number(named[1]) + 1);
}

// Spring defaults chosen so switching physics on looks obviously springy
// straight away rather than either dead or unstable. Stiffness 180 gives a
// natural frequency of sqrt(180) ~ 13 rad/s (about 2 Hz); damping 8 against
// a critical damping of 2*sqrt(180) ~ 26.8 is a damping ratio near 0.3, so
// it visibly overshoots a couple of times and settles in about a second.
export const DEFAULT_STIFFNESS = 180;
export const DEFAULT_DAMPING = 8;
export const DEFAULT_GRAVITY = 0;
// How strongly a bone resists having its pivot moved out from under it.
// On by default: a spring bone that does not react when the character is
// dragged around is not doing its job.
export const DEFAULT_INERTIA = 1;

export const PHYSICS_RANGES = Object.freeze({
  stiffness: { min: 10, max: 600, step: 5 },
  damping: { min: 0.5, max: 40, step: 0.5 },
  gravityInfluence: { min: 0, max: 60, step: 1 },
  inertia: { min: 0, max: 3, step: 0.1 },
});

// A pivot that teleports (a bone dropped somewhere far away, a project
// loaded) would otherwise hand the integrator an impulse big enough to
// throw the bone into orbit. Fast finger flicks stay well under this.
const MAX_PIVOT_ACCELERATION = 12000; // scene px / s^2

// The pivot history is a frame-to-frame difference. The loop sleeps and
// wakes constantly during a drag -- a spring that has not started moving
// yet lets the loop stop, and the next finger movement starts it again --
// so the history has to SURVIVE those gaps or the acceleration is never
// measured at all. What it must not survive is a real pause, where the
// difference would be across dead time rather than across a frame.
const MAX_PIVOT_GAP_MS = 250;

// A uniform rod of length L pivoted at one end: the torque a pivot
// acceleration exerts about that end, divided by the rod's moment of
// inertia, is 3/(2L) times the transverse component. Same shape as the
// gravity term below, which is the same physics with a constant field.
const ROD_PIVOT_FACTOR = 1.5;

// A long stall (backgrounded app) must not be integrated as one huge step,
// and each substep stays small enough for the integrator to stay stable
// even at maximum stiffness.
const MAX_FRAME_DT = 1 / 30;
const MAX_SUBSTEP = 1 / 120;

// When the bone counts as at rest and the frame loop may stop.
//
// The test has to bound the bone's remaining DISTANCE from equilibrium,
// not its raw acceleration. Acceleration is stiffness times that distance,
// so a fixed acceleration bound means a soft spring may stop while still
// far from where it belongs -- and it stays there, because the loop has
// gone to sleep. A bone at stiffness 10 could park 4.5 degrees short.
//
// Near rest, distance-from-equilibrium is (|acceleration| + damping *
// |velocity|) / stiffness, which is what SETTLE_ANGLE bounds. 0.0005 rad
// is 0.03 degrees: about 1/20 of a pixel at the tip of a 100px bone, so
// under the grid's resolution however the artwork is snapped.
const SETTLE_ANGLE = 0.0005;
const SETTLE_VELOCITY = 0.004; // rad/s -- also stops it sleeping mid-coast

export class Bone {
  constructor({ name, parentId = null, localHead, rotation = 0, length = 0 }) {
    this.id = `bone_${nextId++}`;
    this.name = name;
    this.parentId = parentId; // null for a root bone
    this.localHead = { x: localHead.x, y: localHead.y };
    this.rotation = rotation; // radians, relative to the parent's world rotation
    this.length = length;

    // Optional spring physics. Off by default -- a head or torso should
    // move rigidly with its parent; only loose things (hair, chest, cloth)
    // want to lag and jiggle.
    this.physicsEnabled = false;
    this.stiffness = DEFAULT_STIFFNESS;
    this.damping = DEFAULT_DAMPING;
    this.gravityInfluence = DEFAULT_GRAVITY;

    // Simulation state. simWorldRotation is the angle the bone is actually
    // drawn at, which trails the target that forward kinematics asks for.
    // null means "not yet initialized"; it is seeded from the target the
    // moment physics is switched on.
    this.simWorldRotation = null;
    this.angularVelocity = 0;
    this.inertia = DEFAULT_INERTIA;

    // Where this bone's pivot was on the previous frame, and how fast it
    // was travelling, so the simulation can tell that the bone is being
    // carried somewhere. Transient: never serialized, cleared on resume.
    this.pivotPrevHead = null;
    this.pivotVelocity = null;
    this.pivotAcceleration = { x: 0, y: 0 };

    // Which layer this bone is primarily associated with, chosen by the
    // user rather than inferred. null means "not assigned yet". Nothing
    // is guessed from proximity: a bone over a torso may well be meant to
    // drive the coat in front of it.
    this.attachedPartId = null;

    // Hidden bones stay in the skeleton and keep driving the artwork they
    // are bound to; they are simply not drawn and not touchable, so a
    // crowded rig can be thinned out while working on one area.
    this.visible = true;
  }

  get isRoot() {
    return this.parentId === null;
  }
}

function normalizeAngle(angle) {
  let result = angle;
  while (result > Math.PI) result -= 2 * Math.PI;
  while (result < -Math.PI) result += 2 * Math.PI;
  return result;
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
    this._lastPivotAt = 0;
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

  // Where forward kinematics says this bone should be: the parent's
  // current world rotation plus this bone's own local rotation. Physics
  // never changes the target -- only how quickly the bone reaches it.
  targetWorldRotation(bone) {
    const parent = this.parentOf(bone);
    return parent ? this.worldRotation(parent) + bone.rotation : bone.rotation;
  }

  // Where the bone actually is. For a physics bone that is the simulated
  // angle trailing the target; for everything else the two are identical.
  //
  // Every consumer goes through here -- child head positions, the bone
  // gizmos, hit testing, and snapshotTransforms() feeding mesh skinning --
  // so the lag propagates through the whole chain and into the deformed
  // artwork without any of those callers knowing physics exists.
  worldRotation(bone) {
    if (bone.physicsEnabled && bone.simWorldRotation !== null) {
      return bone.simWorldRotation;
    }
    return this.targetWorldRotation(bone);
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
  // physics/partId ride along so skinning can tell a spring bone's jiggle
  // apart from rigid motion, and tell whose artwork the jiggle is for.
  // Reading them here rather than storing them on the mesh keeps the whole
  // thing derived: toggling physics changes the result on the next frame,
  // in both directions, without touching a single stored weight.
  snapshotTransforms() {
    const transforms = {};
    for (const bone of this._bones) {
      transforms[bone.id] = {
        head: this.worldHead(bone),
        rotation: this.worldRotation(bone),
        physics: bone.physicsEnabled,
        partId: bone.attachedPartId,
      };
    }
    return transforms;
  }

  // ---- The REST pose ----------------------------------------------------
  //
  // worldRotation() and worldHead() report where a bone IS -- for a spring
  // bone, mid-jiggle. That is right for drawing, hit-testing and skinning.
  //
  // It is exactly wrong for AUTHORING. A bone's stored transform is an
  // offset from its parent, and that offset has to be measured against the
  // parent's REST pose. Measure it against a parent that happens to be
  // swinging and the swing is baked into the stored offset permanently:
  // the bone then settles somewhere it was never put.
  //
  // So every capture -- creating a bone, dragging a handle, nudging,
  // re-parenting, binding a mesh -- goes through these, which walk the
  // hierarchy ignoring the simulation entirely.

  restWorldRotation(bone) {
    const parent = this.parentOf(bone);
    return parent ? this.restWorldRotation(parent) + bone.rotation : bone.rotation;
  }

  restWorldHead(bone) {
    const parent = this.parentOf(bone);
    if (!parent) return { x: bone.localHead.x, y: bone.localHead.y };

    const parentHead = this.restWorldHead(parent);
    const offset = rotatePoint(bone.localHead.x, bone.localHead.y, this.restWorldRotation(parent));
    return { x: parentHead.x + offset.x, y: parentHead.y + offset.y };
  }

  restWorldTail(bone) {
    const head = this.restWorldHead(bone);
    const angle = this.restWorldRotation(bone);
    return {
      x: head.x + bone.length * Math.cos(angle),
      y: head.y + bone.length * Math.sin(angle),
    };
  }

  // Converts a world point into the coordinate frame a child of `parent`
  // is stored in, using the parent's REST pose. With no parent, the frame
  // is world space.
  toParentSpace(parent, x, y) {
    if (!parent) return { x, y };
    const parentHead = this.restWorldHead(parent);
    return rotatePoint(x - parentHead.x, y - parentHead.y, -this.restWorldRotation(parent));
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
      rotation: parent ? worldAngle - this.restWorldRotation(parent) : worldAngle,
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
    // The bone's REST tail, not the swinging one it is drawn at: dragging
    // a head re-aims the bone's rest pose, and the spring then animates
    // toward it. Reading the live tail here would fold the current jiggle
    // into the stored rotation and move the bone permanently.
    const tail = this.restWorldTail(bone);
    bone.localHead = this.toParentSpace(this.parentOf(bone), x, y);
    this.setWorldTail(bone, tail.x, tail.y);
  }

  // Moves the tail, which is what defines the bone's rotation and length.
  setWorldTail(bone, x, y) {
    const head = this.restWorldHead(bone);
    const dx = x - head.x;
    const dy = y - head.y;
    const parent = this.parentOf(bone);

    bone.length = Math.hypot(dx, dy);
    // Relative to the parent's REST rotation. Against a simulated parent
    // this would store "rest offset plus whatever the parent's swing
    // happened to be", which never comes back to the right place.
    bone.rotation = Math.atan2(dy, dx) - (parent ? this.restWorldRotation(parent) : 0);
    this._emit('transform');
  }

  // Shifts every ROOT bone by the same amount, which carries the entire
  // skeleton: each root's children are stored relative to it, so they come
  // along for free. Moving the character means moving all of it, and a rig
  // can legitimately have more than one parentless bone -- a stray root,
  // or children orphaned by deleting a root -- which would otherwise be
  // left standing where they were while the rest of the body walked off.
  translateRoots(dx, dy) {
    if (dx === 0 && dy === 0) return;
    for (const bone of this.roots) {
      bone.localHead = { x: bone.localHead.x + dx, y: bone.localHead.y + dy };
    }
    this._emit('transform');
  }

  // Places the bone's head at a world point, keeping its rotation and
  // length -- so the bone and everything under it translate together while
  // its parent chain stays exactly where it is. This is what a live drag
  // writes: the ONE bone the finger holds, expressed as an offset from its
  // parent's rest pose, with every other bone deriving from it as usual.
  moveWorldHead(bone, x, y) {
    bone.localHead = this.toParentSpace(this.parentOf(bone), x, y);
    this._emit('transform');
  }

  // Nudges the head in world space, keeping the bone's shape: the tail
  // follows, so the whole bone (and its children) translate together.
  nudgePosition(bone, dx, dy) {
    const parent = this.parentOf(bone);
    const head = this.restWorldHead(bone);
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
      const head = this.restWorldHead(child);
      const tail = this.restWorldTail(child);

      child.parentId = newParent ? newParent.id : null;
      child.localHead = this.toParentSpace(newParent, head.x, head.y);
      this.setWorldTail(child, tail.x, tail.y);
    }

    this._bones = this._bones.filter((candidate) => candidate.id !== id);
    if (this._selectedId === id) this._selectedId = null;
    this._emit('structure');
  }

  // ---- Spring physics ----------------------------------------------------

  setPhysicsEnabled(id, enabled) {
    const bone = this.byId(id);
    if (!bone) return;

    bone.physicsEnabled = enabled;
    // Seed the simulation at the target so switching physics on never
    // makes the bone jump; switching it off returns it to rigid FK.
    bone.simWorldRotation = enabled ? this.targetWorldRotation(bone) : null;
    bone.angularVelocity = 0;
    this._emit('structure');
  }

  setPhysicsParam(id, key, value) {
    const bone = this.byId(id);
    if (!bone) return;
    bone[key] = value;
    this._emit('structure');
  }

  get hasPhysicsBones() {
    return this._bones.some((bone) => bone.physicsEnabled);
  }

  // Called when the frame loop starts up again. The pivot history is a
  // frame-to-frame difference, and the gap across a sleep is not a frame:
  // differentiating across it would invent a huge acceleration and kick
  // every spring bone the moment the rig was touched.
  resumePhysics() {
    this._lastPivotAt = 0;
    for (const bone of this._bones) {
      bone.pivotPrevHead = null;
      bone.pivotVelocity = null;
      bone.pivotAcceleration = { x: 0, y: 0 };
    }
  }

  // How fast each physics bone's pivot is accelerating, measured once per
  // frame (not per substep: the pivot only moves when the rig changes, so
  // differentiating inside the frame would turn one move into a spike).
  _measurePivots(dt) {
    if (dt <= 0) return;

    const now = Date.now();
    const gap = this._lastPivotAt ? now - this._lastPivotAt : 0;
    this._lastPivotAt = now;
    if (gap > MAX_PIVOT_GAP_MS) {
      // Too long to be one frame: differentiating across it would invent
      // an acceleration nobody applied. Start the history again instead.
      for (const bone of this._bones) {
        bone.pivotPrevHead = null;
        bone.pivotVelocity = null;
        bone.pivotAcceleration = { x: 0, y: 0 };
      }
    }

    for (const bone of this._bones) {
      if (!bone.physicsEnabled) continue;

      const head = this.worldHead(bone);
      if (!bone.pivotPrevHead) {
        bone.pivotPrevHead = { x: head.x, y: head.y };
        bone.pivotVelocity = { x: 0, y: 0 };
        bone.pivotAcceleration = { x: 0, y: 0 };
        continue;
      }

      const vx = (head.x - bone.pivotPrevHead.x) / dt;
      const vy = (head.y - bone.pivotPrevHead.y) / dt;
      let ax = (vx - bone.pivotVelocity.x) / dt;
      let ay = (vy - bone.pivotVelocity.y) / dt;

      const magnitude = Math.hypot(ax, ay);
      if (magnitude > MAX_PIVOT_ACCELERATION) {
        const scale = MAX_PIVOT_ACCELERATION / magnitude;
        ax *= scale;
        ay *= scale;
      }

      bone.pivotAcceleration = { x: ax, y: ay };
      bone.pivotVelocity = { x: vx, y: vy };
      bone.pivotPrevHead = { x: head.x, y: head.y };
    }
  }

  // Advances every physics bone by dt seconds. Returns true while anything
  // is still moving, so the caller's frame loop knows when it may stop.
  //
  // Part 6 only has to keep writing new targets (bone.rotation) each frame
  // from touch input and call this -- no other coupling to the simulation.
  stepPhysics(dt) {
    const clamped = Math.min(Math.max(dt, 0), MAX_FRAME_DT);
    const steps = Math.max(1, Math.ceil(clamped / MAX_SUBSTEP));
    const h = clamped / steps;

    this._measurePivots(clamped);

    let active = false;
    for (let i = 0; i < steps; i++) {
      if (this._integrate(h)) active = true;
    }
    return active;
  }

  // One step of a damped mass-spring toward the FK target, integrated with
  // semi-implicit (symplectic) Euler -- velocity first, then position --
  // which stays stable at stiffnesses where plain explicit Euler blows up.
  //
  //   angular acceleration = stiffness * (target - current)      spring
  //                        - damping   * angularVelocity         damping
  //                        + gravity   * cos(current)            gravity
  //
  // The gravity term is the standard pendulum torque: it is zero when the
  // bone already points straight down (cos(pi/2) = 0) and strongest when
  // it is horizontal, so a heavy bone sags toward hanging.
  _integrate(h) {
    let active = false;

    // Parents before children: a child's target is built from its parent's
    // simulated rotation, so the parent must be updated first this step.
    for (const { bone } of this.toTreeList()) {
      if (!bone.physicsEnabled) continue;

      if (bone.simWorldRotation === null) {
        bone.simWorldRotation = this.targetWorldRotation(bone);
        bone.angularVelocity = 0;
      }

      // Normalized so the bone always springs the short way round rather
      // than unwinding the long way through a full turn.
      const error = normalizeAngle(this.targetWorldRotation(bone) - bone.simWorldRotation);

      // Carrying a bone around is felt as a torque about its own pivot:
      // in the pivot's accelerating frame the bone's mass is pushed the
      // other way, which is why a ponytail swings back when the head moves
      // sideways. Without this a spring bone whose parent is DRAGGED --
      // rather than rotated -- would follow in perfect lockstep and never
      // jiggle at all, because the whole chain merely translates and no
      // angle anywhere changes.
      //
      // The transverse component is what turns the bone; the same
      // expression with a constant downward field gives the gravity term
      // below, which is exactly what gravity is.
      const sin = Math.sin(bone.simWorldRotation);
      const cos = Math.cos(bone.simWorldRotation);
      const pivotTorque = bone.inertia === 0 || bone.length < 1e-6
        ? 0
        : (bone.inertia * ROD_PIVOT_FACTOR *
            (bone.pivotAcceleration.x * sin - bone.pivotAcceleration.y * cos)) /
          Math.max(bone.length, 1);

      const acceleration =
        bone.stiffness * error -
        bone.damping * bone.angularVelocity +
        bone.gravityInfluence * cos +
        pivotTorque;

      bone.angularVelocity += acceleration * h;
      bone.simWorldRotation += bone.angularVelocity * h;

      // How far the bone still is from where it will end up, in radians.
      // Dividing by stiffness is what makes this hold for a limp spring as
      // well as a tight one.
      const stiffness = Math.max(bone.stiffness, 1e-6);
      const distanceFromRest =
        (Math.abs(acceleration) + bone.damping * Math.abs(bone.angularVelocity)) / stiffness;

      if (distanceFromRest > SETTLE_ANGLE || Math.abs(bone.angularVelocity) > SETTLE_VELOCITY) {
        active = true;
      }
    }

    return active;
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

  // ---- Layer attachment and visibility ----------------------------------

  // The layer a bone is assigned to drive. Set explicitly by the user and
  // editable at any time; passing null clears the assignment.
  setAttachedPart(id, partId) {
    const bone = this.byId(id);
    if (!bone || bone.attachedPartId === partId) return;
    bone.attachedPartId = partId;
    this._emit('structure');
  }

  // Every bone assigned to a layer -- what the layer-delete warning counts.
  bonesAttachedTo(partId) {
    return this._bones.filter((bone) => bone.attachedPartId === partId);
  }

  // Clears the assignment on every bone pointing at a layer that is going
  // away, so a deleted layer never leaves bones pointing at nothing.
  detachPart(partId) {
    let changed = false;
    for (const bone of this._bones) {
      if (bone.attachedPartId !== partId) continue;
      bone.attachedPartId = null;
      changed = true;
    }
    if (changed) this._emit('structure');
    return changed;
  }

  setVisible(id, visible) {
    const bone = this.byId(id);
    if (!bone || bone.visible === visible) return;
    bone.visible = visible;
    this._emit('structure');
  }

  // Hiding a bone hides the branch under it: a hidden shoulder should take
  // the whole arm off the screen, not leave its children floating loose.
  isVisible(bone) {
    let current = bone;
    while (current) {
      if (!current.visible) return false;
      current = this.parentOf(current);
    }
    return true;
  }

  // Rebuilds the whole skeleton at once -- used by project load and undo.
  replaceAll(bones, selectedId = null) {
    this._bones = bones;
    this._selectedId = bones.some((bone) => bone.id === selectedId) ? selectedId : null;
    this._emit('structure');
  }

  // Nearest VISIBLE bone whose body is within `threshold` of the point,
  // or null: a bone you cannot see must not steal your touch.
  hitTest(x, y, threshold) {
    let best = null;
    let bestDistance = threshold;

    for (const bone of this._bones) {
      if (!this.isVisible(bone)) continue;
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
