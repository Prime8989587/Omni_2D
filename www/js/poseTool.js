// Free Move: moving the whole character.
//
// NOTHING TO AIM AT
//
// A drag anywhere on the canvas moves the character. No handle to hit, no
// bone picker, no hit-testing of bones, layers or pixels -- there is only
// one thing a drag can mean here, so it needs no target.
//
// There is also a drag pad BELOW the buttons, well clear of the canvas.
// It does exactly the same thing, and exists so the character can be
// thrown about and watched jiggling without a thumb parked on top of it.
//
// WHAT A DRAG WRITES
//
// The ROOT BONE'S OWN position, directly. moveWorldHead() writes
// bone.localHead, and for a root -- which has no parent to be relative to
// -- that IS its world position. No delta is passed downstream to anyone.
//
// Every other bone then DERIVES its position from that, every frame, by
// the forward kinematics the app already uses:
//
//   world head = parent's current world transform  x  stored rest offset
//
// so a bone without physics tracks the root exactly, with no lag, because
// its position is not integrated at all -- it is recomputed from scratch
// each time anything asks where it is. A bone WITH physics reads its
// target from that same chain, live, and keeps its own simulated angle
// trailing behind, carrying on after the finger lifts.

import { bonesStore } from './bones.js';
import { view } from './view.js';
import { history } from './history.js';
import { appState, AppState } from './state.js';

let drag = null;

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
  if (drag || !bone) return;
  // Offset from wherever the finger went down, so the character moves
  // WITH the finger instead of snapping its root under it.
  const head = bonesStore.restWorldHead(bone);
  drag = {
    bone,
    offsetX: head.x - scenePoint.x,
    offsetY: head.y - scenePoint.y,
    token: history.capture('Move character'),
    moved: false,
  };
}

export function updatePoseDrag(scenePoint) {
  if (!drag) return;
  const target = snapToCell({
    x: scenePoint.x + drag.offsetX,
    y: scenePoint.y + drag.offsetY,
  });
  const head = bonesStore.restWorldHead(drag.bone);
  if (head.x === target.x && head.y === target.y) return;

  // Writes the root bone's own position. Everything else derives from it.
  bonesStore.moveWorldHead(drag.bone, target.x, target.y);
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
