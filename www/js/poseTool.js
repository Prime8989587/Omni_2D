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
import { history } from './history.js';
import { appState, AppState } from './state.js';

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

export function isPosing() {
  return drag !== null;
}

// Bone endpoints sit on pixel centres (the grid revision's rule), so the
// character lands on whole pixels however it is dragged.
function snapToCell(point) {
  return { x: Math.floor(point.x) + 0.5, y: Math.floor(point.y) + 0.5 };
}

export function beginPoseDrag(bone, scenePoint) {
  if (drag) return;
  const piercing = poseTarget === PoseTarget.PIERCER;
  // A reference point the finger carries. It is a root bone's own
  // position when there is a rig, so the drag still writes root data;
  // with no bones at all it is just the finger, so unbound artwork can
  // still be pushed around.
  const anchorBone = piercing ? piercerBones()[0] : bone;
  const anchor = anchorBone ? bonesStore.restWorldHead(anchorBone) : snapToCell(scenePoint);
  drag = {
    offsetX: anchor.x - scenePoint.x,
    offsetY: anchor.y - scenePoint.y,
    lastX: anchor.x,
    lastY: anchor.y,
    token: history.capture(piercing ? 'Move piercer' : 'Move character'),
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
    bonesStore.translateRoots(dx, dy);
    // Piercers are excluded here so the body cannot drag the needle along
    // with it; the Piercer target is the only thing that moves those.
    partsStore.translateUnbound(dx, dy, { skipPiercers: true });
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
    beginPoseDrag(masterBone(), sceneFromScreen(screenFromEvent(element, event)));
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
