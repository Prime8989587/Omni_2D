// Free Move: moving the whole character.
//
// ONE HANDLE, ONE MEANING
//
// Free Move has exactly one control: a big round handle riding on the
// character's root bone. Drag it and the whole character moves. There is
// nothing to choose and nothing to aim at -- no bone picker, no per-bone
// gizmos, no hit-testing of layers or pixels. The handle is deliberately
// far larger than Rig mode's precision handles, because this one is meant
// to be grabbed with a thumb, mid-motion, without looking.
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

// Rig mode's handles are 5-7px drawn with a 26px grab radius, sized for
// placing a bone precisely. This one is for a thumb, so it is roughly
// twice that across and easier to hit than to miss.
export const MASTER_HANDLE_RADIUS_PX = 30;
const MASTER_HANDLE_HIT_PX = 40;
const EDGE_MARGIN_PX = MASTER_HANDLE_RADIUS_PX + 8;
const TAP_SLOP_PX = 8;

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

// Where the handle sits on screen: on the root bone, but kept inside the
// canvas so that a character dragged off the edge can still be grabbed
// and brought back.
export function masterHandlePosition() {
  const bone = masterBone();
  if (!bone) return null;

  // The bone's MIDPOINT, not its head. The midpoint of a segment is the
  // same place whichever end you call the head, so flipping or redrawing
  // the root leaves the handle exactly where it was; anchoring to the
  // head would make it jump to the other end of the bone.
  const head = bonesStore.worldHead(bone);
  const tail = bonesStore.worldTail(bone);
  const point = view.toScreen((head.x + tail.x) / 2, (head.y + tail.y) / 2);
  const maxX = Math.max(EDGE_MARGIN_PX, view.viewWidth - EDGE_MARGIN_PX);
  const maxY = Math.max(EDGE_MARGIN_PX, view.viewHeight - EDGE_MARGIN_PX);
  const x = Math.min(Math.max(point.x, EDGE_MARGIN_PX), maxX);
  const y = Math.min(Math.max(point.y, EDGE_MARGIN_PX), maxY);
  return { x, y, tethered: x !== point.x || y !== point.y };
}

export function isOnMasterHandle(screenPoint) {
  const handle = masterHandlePosition();
  if (!handle) return false;
  return Math.hypot(screenPoint.x - handle.x, screenPoint.y - handle.y) <= MASTER_HANDLE_HIT_PX;
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

export function initPoseTool(canvasEl) {
  let pointerDownScreen = null;
  let pan = null;

  const active = () => appState.state === AppState.ANIMATING;

  canvasEl.addEventListener('pointerdown', (event) => {
    if (!active()) return;
    // Two fingers belong to the camera (viewGestures pinches and pans).
    if (view.activePointerCount > 1) {
      endPoseDrag();
      pointerDownScreen = null;
      pan = null;
      return;
    }
    event.preventDefault();
    canvasEl.setPointerCapture(event.pointerId);

    const screenPoint = screenFromEvent(canvasEl, event);
    pointerDownScreen = screenPoint;
    pan = null;

    if (isOnMasterHandle(screenPoint)) {
      beginPoseDrag(masterBone(), sceneFromScreen(screenPoint));
    }
  });

  canvasEl.addEventListener('pointermove', (event) => {
    if (!active() || !pointerDownScreen) return;
    if (view.activePointerCount > 1) {
      endPoseDrag();
      return;
    }
    event.preventDefault();
    const screenPoint = screenFromEvent(canvasEl, event);

    if (isPosing()) {
      updatePoseDrag(sceneFromScreen(screenPoint));
      return;
    }

    // Anywhere off the handle, a finger pans the view -- the camera is
    // not part of the rig, so this does not compete with the one control.
    if (!pan) {
      const moved = Math.hypot(screenPoint.x - pointerDownScreen.x, screenPoint.y - pointerDownScreen.y);
      if (moved <= TAP_SLOP_PX) return;
      pan = { lastX: pointerDownScreen.x, lastY: pointerDownScreen.y };
    }
    view.panBy(screenPoint.x - pan.lastX, screenPoint.y - pan.lastY);
    pan.lastX = screenPoint.x;
    pan.lastY = screenPoint.y;
  });

  const endPointer = () => {
    if (!active()) return;
    endPoseDrag();
    if (pan) view.snapToDevicePixels();
    pan = null;
    pointerDownScreen = null;
  };

  canvasEl.addEventListener('pointerup', endPointer);
  canvasEl.addEventListener('pointercancel', endPointer);
}
