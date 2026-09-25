// Free Move: moving the whole character, and moving a piercer into it.
//
// NOTHING TO AIM AT
//
// A drag anywhere on the canvas moves whatever the Body / Piercer tabs
// currently point it at. No handle to hit, no bone picker, no hit-testing
// of bones, layers or pixels -- the tab says what a drag means, so the
// drag itself needs no target.
//
// The Piercer tab only exists once some layer has been explicitly given
// the Pierce PIERCER role; with no piercer in the scene there is again
// exactly one thing a drag can mean.
//
// There is also a drag pad BELOW the buttons, well clear of the canvas.
// It does exactly the same thing, and exists so the character can be
// thrown about and watched jiggling without a thumb parked on top of it.
//
// WHAT A DRAG MOVES
//
// The whole character, which means three things and not just one:
//
//   * EVERY root bone's own position, written directly (a root's stored
//     offset IS its world position, having no parent to be relative to).
//     Not one chosen root: a rig can have several parentless bones, and
//     the ones that were not chosen used to stand still while the rest of
//     the body walked away from them.
//   * Everything under those roots, which follows for free.
//   * Every layer NOT bound to the skeleton. A bound layer follows its
//     bones through skinning, but an unbound one is drawn at its own
//     coordinates, so it used to sit pinned in place -- which looked for
//     all the world like something invisible holding it there. Plenty of
//     pieces are meant to be carried along exactly as drawn rather than
//     bent or bounced, and this is what carries them.
//
// Everything under a root DERIVES its position, every frame, from the
// forward kinematics the app already uses:
//
//   world head = parent's current world transform  x  stored rest offset
//
// so a bone without physics tracks the root exactly, with no lag, because
// its position is not integrated at all -- it is recomputed from scratch
// each time anything asks where it is. A bone WITH physics reads its
// target from that same chain, live, and keeps its own simulated angle
// trailing behind, carrying on after the finger lifts.

import { bonesStore } from './bones.js';
import { partsStore } from './parts.js';
import { view } from './view.js';
import { getSetting } from './settings.js';
import { history } from './history.js';
import { appState, AppState } from './state.js';
import { isLinked, carryPoint, linkPositions, currentTransforms } from './plink.js';

// A swing needs a lever. Closer to the joint than this and the angle a
// drag describes is dominated by grid snapping rather than by the user's
// hand, so the bone waits instead of spinning.
const MIN_SWING_RADIUS = 2; // scene pixels

// Shortest way round, so a swing across the +/-pi seam turns a few degrees
// rather than most of a full circle back the other way.
function normalizeAngle(radians) {
  let angle = radians;
  while (angle > Math.PI) angle -= Math.PI * 2;
  while (angle < -Math.PI) angle += Math.PI * 2;
  return angle;
}

let drag = null;

// WHAT A DRAG IS AIMED AT
//
// 'body'    the whole character, as described above.
// 'piercer' only the layers explicitly flagged with the Pierce PIERCER
//           role, so a needle can be pushed into a character that is
//           meanwhile jiggling on its own springs.
//
// The two are mutually exclusive by construction, not by luck: the body
// drag skips piercer layers and the piercer drag touches nothing else. An
// unbound piercer moved by both would travel twice as far as the finger
// and could never be brought toward the body at all, since the body would
// run away from it at exactly the same speed.
export const PoseTarget = Object.freeze({ BODY: 'body', PIERCER: 'piercer' });

let poseTarget = PoseTarget.BODY;

export function getPoseTarget() {
  return poseTarget;
}

export function setPoseTarget(target) {
  if (target !== PoseTarget.BODY && target !== PoseTarget.PIERCER) return;
  if (poseTarget === target) return;
  // Switching mid-drag would hand the finger a different object halfway
  // through the same gesture.
  endPoseDrag();
  poseTarget = target;
}

// The bones a piercer drag writes to: the roots of whatever bones drive
// the piercer layers. A piercer bound to its own little rig is moved by
// moving that rig; an unbound one is moved by its own coordinates
// (partsStore.translatePiercers). Doing both to the same layer would
// double its travel, which is why each layer answers to exactly one.
function piercerBones() {
  const bones = [];
  for (const part of partsStore.piercers) {
    for (const bone of bonesStore.bonesAttachedTo(part.id)) bones.push(bone);
  }
  return bones;
}

export function hasPiercerTarget() {
  return partsStore.piercers.length > 0;
}

// The character's root bone: the bone with NO PARENT. That is the only
// test. Nothing about a bone's rotation, its length, or which of its two
// ends is labelled "head" has any bearing on it -- draw the root upside
// down and it is still the root, because being the root is a fact about
// the hierarchy, not about the drawing.
//
// A rig can end up with more than one parentless bone (deleting a root
// re-parents its children to nothing), so when that happens the master
// handle takes the one carrying the most of the character with it, which
// is the body rather than some stray offcut.
export function masterBone() {
  const roots = bonesStore.roots;
  if (roots.length <= 1) return roots[0] || null;

  const descendants = (bone) =>
    bonesStore.childrenOf(bone.id).reduce((n, child) => n + 1 + descendants(child), 0);
  return roots.reduce((best, bone) => (descendants(bone) > descendants(best) ? bone : best), roots[0]);
}

// ---------------------------------------------------------------------------
// Which layer's bone a drag writes to
//
// SELECTION ONLY. Neither of the two things a drag can do is defined here
// or changed by anything here -- moving the whole character and moving one
// bone with its children both already existed, both are already verified,
// and this only decides which of them the finger gets. Everything below
// resolves to a bone and then hands off.
//
// null means the default the master handle has always had: the character's
// root, and with it the whole-character move. Anything else is a layer the
// user picked, whose ATTACHED bone becomes the target.
let targetPartId = null;

export function getTargetLayer() {
  return targetPartId;
}

export function setTargetLayer(partId) {
  if (targetPartId === partId) return;
  // Same reason switching Body/Piercer ends the drag: handing the finger a
  // different object halfway through one gesture is never what was meant.
  endPoseDrag();
  targetPartId = partId;
}

// The bone a body drag writes to, or null when there is nothing to write
// to. Resolved fresh on every call rather than cached at selection time,
// because the answer legitimately changes underneath a Free-Move session:
// a bone can be attached to the chosen layer in Rig mode and the user can
// come straight back expecting it to work, and a layer or its bone can be
// deleted while still selected.
export function targetBone() {
  if (targetPartId === null) return masterBone();
  return bonesStore.bonesAttachedTo(targetPartId)[0] || null;
}

// What the UI needs to tell the user where they stand: whether a layer is
// chosen at all, whether it has a bone, and whether that bone is the root
// (so a drag moves everything) or not (so a drag moves it and its children).
export function targetLayerStatus() {
  const bone = targetBone();
  return {
    partId: targetPartId,
    isDefault: targetPartId === null,
    bone,
    hasBone: Boolean(bone),
    isRoot: Boolean(bone) && bone.parentId === null,
  };
}

export function isPosing() {
  return drag !== null;
}

// Bone endpoints sit on pixel centres (the grid revision's rule), so the
// character lands on whole pixels however it is dragged.
function snapToCell(point) {
  // Honours the Rig section's Grid snap toggle, for the same reason
  // rigTool.js does: a character placed with snapping off has to be able
  // to sit between pixels, which is exactly what rounding would prevent.
  if (!getSetting('gridSnap')) return { x: point.x, y: point.y };
  return { x: Math.floor(point.x) + 0.5, y: Math.floor(point.y) + 0.5 };
}

// Where a bone's layer is SEEN to turn about, and where its tail is SEEN.
//
// A PLinked layer is moved after its bones have placed it -- brought to its
// link point -- so the bone's own joint is not where the layer is drawn. A
// layer that gives way at a link is held AT that point, and turning its bone
// turns it about the link, not about the bone's head. Aiming the swing from
// anywhere else would put the drawn tail somewhere other than under the
// finger. An unlinked layer is exactly the bone's own joint and tail.
function visibleSwing(bone) {
  const joint = bonesStore.restWorldHead(bone);
  const tail = bonesStore.restWorldTail(bone);
  const part = targetPartId === null ? null : partsStore.parts.find((p) => p.id === targetPartId);
  if (!part || !isLinked(part)) return { joint, tail };
  const transforms = currentTransforms();
  const held = linkPositions(transforms)
    .find((link) => link.anchorId !== part.id && link.members.some((m) => m.partId === part.id));
  const pivot = held ? held.members.find((m) => m.partId === part.id) : carryPoint(part, joint, transforms);
  return { joint: { x: pivot.x, y: pivot.y }, tail: carryPoint(part, tail, transforms) };
}

export function beginPoseDrag(bone, scenePoint) {
  if (drag) return;
  const piercing = poseTarget === PoseTarget.PIERCER;
  // A chosen layer with no bone attached has nothing to write to, so the
  // drag simply never starts -- which is what makes it a clean no-op rather
  // than something that silently falls back to moving the whole character.
  // The menu shows the warning and the tip; this is the half that makes the
  // canvas honour them.
  if (!piercing && !targetLayerStatus().hasBone) return;
  // A reference point the finger carries. It is a root bone's own
  // position when there is a rig, so the drag still writes root data;
  // with no bones at all it is just the finger, so unbound artwork can
  // still be pushed around.
  const anchorBone = piercing ? piercerBones()[0] : bone;
  // A NON-ROOT bone is grabbed by its TAIL, not its head. Its head is the
  // joint, which is exactly the point that is going to stay still -- anchor
  // the finger there and the lever starts at zero length, so a long drag
  // turns the bone barely at all (measured: 72px of drag for 2.3 degrees).
  // The tail is the far end, the hand at the end of the arm, and that is
  // what the user is reaching for when they drag a limb.
  const grabTail = !piercing && anchorBone && anchorBone.parentId !== null;
  const anchor = anchorBone
    ? (grabTail ? visibleSwing(anchorBone).tail : bonesStore.restWorldHead(anchorBone))
    : snapToCell(scenePoint);
  drag = {
    offsetX: anchor.x - scenePoint.x,
    offsetY: anchor.y - scenePoint.y,
    lastX: anchor.x,
    lastY: anchor.y,
    token: history.capture(piercing ? 'Move piercer'
      : (anchorBone && anchorBone.parentId !== null ? `Move ${anchorBone.name}` : 'Move character')),
    piercing,
    moved: false,
  };
}

export function updatePoseDrag(scenePoint) {
  if (!drag) return;
  const target = snapToCell({
    x: scenePoint.x + drag.offsetX,
    y: scenePoint.y + drag.offsetY,
  });
  const dx = target.x - drag.lastX;
  const dy = target.y - drag.lastY;
  if (dx === 0 && dy === 0) return;
  drag.lastX = target.x;
  drag.lastY = target.y;

  // Whole numbers of grid cells, applied to everything the drag is aimed
  // at -- and to nothing it is not.
  if (drag.piercing) {
    for (const bone of piercerBones()) bonesStore.nudgePosition(bone, dx, dy);
    partsStore.translatePiercers(dx, dy);
  } else {
    // The fork, and the ONLY thing the layer menu changes. Both branches
    // are the behaviour that was already here and already verified; which
    // one runs is the whole of the new feature.
    const target = targetBone();
    if (target && target.parentId !== null) {
      // A non-root bone: it and its children move, its parent chain stays
      // put. That rule is unchanged. What changed is the KIND of motion.
      //
      // WHY THIS SWINGS INSTEAD OF SLIDING
      //
      // nudgePosition moves the bone's HEAD, and the head is the joint --
      // the very point that has to stay attached to the parent. Dragging a
      // hand therefore carried the wrist away with it: measured at 33.12
      // scene px of joint travel while the parent sat at 0.00, which on
      // screen is the hand floating off the arm with a gap exactly as wide
      // as the drag.
      //
      // No amount of weight blending can hide that, and it should not: a
      // layer with an explicit "Controls layer" bone is auto-weighted to
      // that bone ALONE (measured: every vertex of the arm layer 100%
      // armBone), on purpose, so a hand resting on a chest does not get
      // handed to the chest bone. There is no shared influence at the seam
      // to stretch, so a translated joint can only separate.
      //
      // Rotating about the head instead makes the joint a FIXED POINT.
      // Skinning maps p -> R(angle)*p + (head - R(angle)*bindHead), so with
      // the head unmoved the bind head maps exactly onto itself: the layer
      // pivots at its joint and stays attached, no tolerance involved. The
      // bone still moves only itself and its children, and the parent chain
      // still does not move -- the rule is untouched, the limb just bends
      // from the joint the way an arm does rather than sliding off it.
      const { joint, tail } = visibleSwing(target);
      const reachX = drag.lastX - joint.x;
      const reachY = drag.lastY - joint.y;
      // Right on top of the joint there is no direction to point in, so a
      // finger that lands there waits rather than spinning the limb wildly.
      if (Math.hypot(reachX, reachY) >= MIN_SWING_RADIUS) {
        // Aim the bone AT the finger rather than integrating little angle
        // steps: the tail tracks the finger exactly, the drag cannot drift
        // away from it over a long gesture, and the joint never moves.
        const facing = Math.atan2(tail.y - joint.y, tail.x - joint.x);
        const wanted = Math.atan2(reachY, reachX);
        const delta = normalizeAngle(wanted - facing);
        if (delta !== 0) bonesStore.nudgeRotation(target, delta);
      }
    } else {
      // The root, whether by default or because the chosen layer's bone
      // IS the root: the whole character, untouched from what the master
      // handle has always done.
      bonesStore.translateRoots(dx, dy);
      // Piercers are excluded here so the body cannot drag the needle along
      // with it; the Piercer target is the only thing that moves those.
      partsStore.translateUnbound(dx, dy, { skipPiercers: true });
    }
  }
  drag.moved = true;
}

export function endPoseDrag() {
  if (!drag) return;
  history.commitCapture(drag.token, drag.moved);
  drag = null;
}

// ---------------------------------------------------------------------------
// Canvas input for the Free Move screen.

function screenFromEvent(canvasEl, event) {
  const rect = canvasEl.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

function sceneFromScreen(point) {
  return view.toScene(point.x, point.y);
}

// Both surfaces -- the canvas and the pad below the buttons -- run the
// same drag. Only deltas matter (the grab offset is captured on the way
// down), and view.toScene divides by the same zoom either way, so a
// finger travelling N screen pixels moves the character N/zoom scene
// pixels wherever it happens to be travelling.
function attachDragSurface(element) {
  const active = () => appState.state === AppState.ANIMATING;

  element.addEventListener('pointerdown', (event) => {
    if (!active()) return;
    // Two fingers belong to the camera (viewGestures pinches and pans).
    if (view.activePointerCount > 1) {
      endPoseDrag();
      return;
    }
    event.preventDefault();
    element.setPointerCapture(event.pointerId);
    beginPoseDrag(targetBone(), sceneFromScreen(screenFromEvent(element, event)));
  });

  element.addEventListener('pointermove', (event) => {
    if (!active() || !isPosing()) return;
    if (view.activePointerCount > 1) {
      endPoseDrag();
      return;
    }
    event.preventDefault();
    updatePoseDrag(sceneFromScreen(screenFromEvent(element, event)));
  });

  const endPointer = () => {
    if (!active()) return;
    endPoseDrag();
  };

  element.addEventListener('pointerup', endPointer);
  element.addEventListener('pointercancel', endPointer);
}

export function initPoseTool(canvasEl) {
  attachDragSurface(canvasEl);
}

export function initMovePad(padEl) {
  attachDragSurface(padEl);
}
