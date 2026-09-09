// Live drag posing: the interaction that finally drives the whole rig at
// once, on the main canvas rather than through a debug slider.
//
// WHAT A DRAG WRITES
//
// Exactly one number pair: the held bone's offset from its parent. Every
// other bone in the skeleton is DERIVED from that, every frame, by the
// same forward kinematics the rest of the app already uses --
//
//   world head = parent's current world transform  x  stored rest offset
//
// so there is no separate "drag pose" to keep in sync with anything. A
// bone with no physics therefore tracks its parent exactly, with no lag
// and no catching up, because its position is not integrated at all -- it
// is recomputed from scratch each time anything asks where it is.
//
// A bone WITH physics reads its target from that same chain, live, and
// keeps its own simulated angle trailing behind it. Dragging the parent
// moves the target every frame; the spring is what decides how quickly
// the bone gets there, and it carries on settling after the finger lifts.
//
// DIRECTION
//
// Writing the held bone's own offset is what makes the two directions
// come out right without a special case: everything BELOW it is expressed
// relative to it and so comes along, while everything ABOVE it is
// expressed relative to ITS own parent and is not touched at all. Drag the
// root and the character moves; drag a hand and only the hand and its
// fingers move.

import { bonesStore } from './bones.js';
import { view } from './view.js';
import { history } from './history.js';
import { appState, AppState } from './state.js';

// Screen-space, so grabbing a bone feels the same at any zoom.
export const POSE_HIT_RADIUS_PX = 24;
const TAP_SLOP_PX = 8;

let drag = null;

export function isPosing() {
  return drag !== null;
}

export function posedBoneId() {
  return drag ? drag.bone.id : null;
}

// Bone endpoints live on pixel centres (the grid revision's rule), so a
// dragged bone lands on whole pixels like a placed one does.
function snapToCell(point) {
  return { x: Math.floor(point.x) + 0.5, y: Math.floor(point.y) + 0.5 };
}

export function boneAt(scenePoint) {
  return bonesStore.hitTest(scenePoint.x, scenePoint.y, POSE_HIT_RADIUS_PX / view.zoom);
}

export function beginPoseDrag(bone, scenePoint) {
  if (drag) return;
  // Grab offset measured against the REST pose, which is what the drag
  // writes; for a bone whose chain is at rest that is also where it is
  // drawn, so it does not jump under the finger.
  const head = bonesStore.restWorldHead(bone);
  drag = {
    bone,
    offsetX: head.x - scenePoint.x,
    offsetY: head.y - scenePoint.y,
    token: history.capture('Pose bone'),
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

  bonesStore.moveWorldHead(drag.bone, target.x, target.y);
  drag.moved = true;
}

export function endPoseDrag() {
  if (!drag) return;
  history.commitCapture(drag.token, drag.moved);
  drag = null;
}

export function cancelPoseDrag() {
  drag = null;
}

// ---------------------------------------------------------------------------
// Free Move: the same interaction wired to the Animate screen's canvas.

function sceneFromEvent(canvasEl, event) {
  const rect = canvasEl.getBoundingClientRect();
  return view.toScene(event.clientX - rect.left, event.clientY - rect.top);
}

function screenFromEvent(canvasEl, event) {
  const rect = canvasEl.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

export function initPoseTool(canvasEl) {
  let pointerDownScreen = null;
  let pan = null;

  const active = () => appState.state === AppState.ANIMATING;

  canvasEl.addEventListener('pointerdown', (event) => {
    if (!active()) return;
    // A second finger means a pinch, which viewGestures owns.
    if (view.activePointerCount > 1) {
      endPoseDrag();
      pointerDownScreen = null;
      pan = null;
      return;
    }
    event.preventDefault();
    canvasEl.setPointerCapture(event.pointerId);

    pointerDownScreen = screenFromEvent(canvasEl, event);
    pan = null;

    const bone = boneAt(sceneFromEvent(canvasEl, event));
    if (bone) {
      bonesStore.select(bone.id);
      beginPoseDrag(bone, sceneFromEvent(canvasEl, event));
    }
  });

  canvasEl.addEventListener('pointermove', (event) => {
    if (!active() || !pointerDownScreen) return;
    if (view.activePointerCount > 1) {
      endPoseDrag();
      return;
    }
    event.preventDefault();

    if (isPosing()) {
      updatePoseDrag(sceneFromEvent(canvasEl, event));
      return;
    }

    // A finger on empty space pans, once it has clearly moved.
    const screenPoint = screenFromEvent(canvasEl, event);
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
