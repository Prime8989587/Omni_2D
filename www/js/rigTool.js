// Canvas interaction for Rig mode: placing bones, selecting them, and
// dragging their head/tail handles -- all snapped to the pixel grid.
//
// Placement is a deliberate two-step tap sequence rather than a drag,
// because tapping two points is far more forgiving on a phone than
// dragging a precise line with a fingertip:
//
//   root bone  - tap once for the head, tap again for the tail
//   child bone - the head is attached to the parent's tail already, so a
//                single tap sets the tail
//
// After placing, the new bone becomes selected, so the next Add Bone
// chains onto it (root -> spine -> head -> hair with no extra taps).
//
// SNAPPING
//
// Every point that comes in from a finger -- a placement tap, a handle
// drag -- is snapped to the CENTRE of the grid cell it landed in before
// the skeleton ever sees it. A bone endpoint therefore always sits on a
// definite pixel and can never drift between two. The cell being snapped
// to is exposed through getSnapCell() so the renderer can light it up.
//
// The skeleton's own maths stays continuous: a bone stored as "length 40
// at 37 degrees" has a tail that is not on an integer, and that is fine --
// forward kinematics and the spring physics need real numbers. Only the
// user's input is quantized; the rendered artwork is quantized separately
// by the rasterizer.

import { appState, AppState } from './state.js';
import { bonesStore } from './bones.js';
import { view } from './view.js';
import { history } from './history.js';

// Touch tolerances are in SCREEN pixels, so a bone is as easy to grab
// zoomed out as zoomed in.
const BONE_HIT_RADIUS_PX = 22;
const HANDLE_HIT_RADIUS_PX = 26;
const TAP_SLOP_PX = 8;

let placement = null; // null | { stage: 'head' | 'tail', parentId, head }
let drag = null; // null | { bone, handle: 'head' | 'tail' }
let pan = null; // null | { lastX, lastY } screen-space finger position
let pointerDownScreen = null;
let dragCell = null; // the grid cell a dragged handle is currently snapped to
let dragHistory = null; // undo snapshot taken when a handle drag begins

const listeners = new Set();

export function subscribeRig(listener) {
  listeners.add(listener);
  listener();
  return () => listeners.delete(listener);
}

function emit() {
  listeners.forEach((listener) => listener());
}

export function getPlacement() {
  return placement;
}

// The grid cell to highlight: where a dragged handle is, or where a
// placed-but-unfinished head landed. null when nothing is being snapped.
export function getSnapCell() {
  if (dragCell) return dragCell;
  if (placement && placement.head) {
    return { x: Math.floor(placement.head.x), y: Math.floor(placement.head.y) };
  }
  return null;
}

// Drives the hint line and the Add Bone button's enabled state.
export function getRigStatus() {
  const selected = bonesStore.selected;
  const parentName = placement && placement.parentId
    ? (bonesStore.byId(placement.parentId) || {}).name
    : null;

  return {
    placing: placement !== null,
    stage: placement ? placement.stage : null,
    parentName,
    selectedName: selected ? selected.name : null,
    // The first bone is the root and needs no parent; after that, a parent
    // must be chosen explicitly before a bone can be added.
    canAddBone: bonesStore.isEmpty || selected !== null,
  };
}

export function beginPlaceBone() {
  if (bonesStore.isEmpty) {
    placement = { stage: 'head', parentId: null, head: null };
    emit();
    return;
  }

  const parent = bonesStore.selected;
  if (!parent) return; // the UI disables Add Bone in this case

  // A child starts life attached to its parent's tail; it only needs a
  // tail point. The head can be dragged elsewhere on the parent after.
  placement = { stage: 'tail', parentId: parent.id, head: bonesStore.worldTail(parent) };
  emit();
}

export function cancelPlacement() {
  if (!placement) return;
  placement = null;
  emit();
}

function screenFromEvent(canvasEl, event) {
  const rect = canvasEl.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

// Snap a scene point to the centre of the cell containing it.
function snapToCell(scenePoint) {
  return { x: Math.floor(scenePoint.x) + 0.5, y: Math.floor(scenePoint.y) + 0.5 };
}

function sceneFromScreen(screenPoint) {
  return view.toScene(screenPoint.x, screenPoint.y);
}

function screenDistance(scenePoint, screenPoint) {
  const onScreen = view.toScreen(scenePoint.x, scenePoint.y);
  return Math.hypot(onScreen.x - screenPoint.x, onScreen.y - screenPoint.y);
}

function handleAt(screenPoint) {
  const bone = bonesStore.selected;
  if (!bone) return null;

  if (screenDistance(bonesStore.worldHead(bone), screenPoint) <= HANDLE_HIT_RADIUS_PX) {
    return { bone, handle: 'head' };
  }
  if (screenDistance(bonesStore.worldTail(bone), screenPoint) <= HANDLE_HIT_RADIUS_PX) {
    return { bone, handle: 'tail' };
  }
  return null;
}

function handleTap(screenPoint) {
  const snapped = snapToCell(sceneFromScreen(screenPoint));

  if (placement) {
    if (placement.stage === 'head') {
      placement.head = snapped;
      placement.stage = 'tail';
      emit();
      return;
    }

    // Both taps in the same cell would make a zero-length bone, which is
    // invisible and unselectable, so ignore the second one.
    if (snapped.x === placement.head.x && snapped.y === placement.head.y) return;

    // Selecting the new bone is PART of the action: it has to be inside
    // the history entry, or redoing the creation would leave the editor
    // pointing at nothing.
    history.run('Add bone', () => {
      const bone = bonesStore.addBone({
        parentId: placement.parentId,
        head: placement.head,
        tail: snapped,
      });
      bonesStore.select(bone.id);
    });
    placement = null;
    emit();
    return;
  }

  // Selection is tested in scene space with a tolerance converted from
  // screen pixels, so it feels the same at any zoom.
  const scenePoint = sceneFromScreen(screenPoint);
  const hit = bonesStore.hitTest(scenePoint.x, scenePoint.y, BONE_HIT_RADIUS_PX / view.zoom);
  bonesStore.select(hit ? hit.id : null);
}

export function initRigTool(canvasEl) {
  canvasEl.addEventListener('pointerdown', (event) => {
    if (appState.state !== AppState.RIG) return;
    // A second finger means a pinch, which viewGestures owns.
    if (view.activePointerCount > 1) {
      drag = null;
      pan = null;
      pointerDownScreen = null;
      dragCell = null;
      return;
    }
    event.preventDefault();
    canvasEl.setPointerCapture(event.pointerId);

    const screenPoint = screenFromEvent(canvasEl, event);
    pointerDownScreen = screenPoint;
    // Handles only grab while not mid-placement, so a placement tap that
    // lands on the selected bone's handle still places the bone.
    drag = placement ? null : handleAt(screenPoint);
    // One undo step per handle drag, not one per pointermove.
    dragHistory = drag ? history.capture('Move bone') : null;
    pan = null;
  });

  canvasEl.addEventListener('pointermove', (event) => {
    if (appState.state !== AppState.RIG || !pointerDownScreen) return;
    if (view.activePointerCount > 1) return;
    event.preventDefault();

    const screenPoint = screenFromEvent(canvasEl, event);

    if (drag) {
      const snapped = snapToCell(sceneFromScreen(screenPoint));
      dragCell = { x: Math.floor(snapped.x), y: Math.floor(snapped.y) };
      if (drag.handle === 'head') bonesStore.setWorldHead(drag.bone, snapped.x, snapped.y);
      else bonesStore.setWorldTail(drag.bone, snapped.x, snapped.y);
      emit();
      return;
    }

    // A finger that travels on empty grid pans the view. It only becomes a
    // pan once it has clearly moved, so a slightly wobbly tap still taps.
    if (!pan) {
      const moved = Math.hypot(screenPoint.x - pointerDownScreen.x, screenPoint.y - pointerDownScreen.y);
      if (moved <= TAP_SLOP_PX) return;
      pan = { lastX: pointerDownScreen.x, lastY: pointerDownScreen.y };
    }
    view.panBy(screenPoint.x - pan.lastX, screenPoint.y - pan.lastY);
    pan.lastX = screenPoint.x;
    pan.lastY = screenPoint.y;
  });

  const endPointer = (event) => {
    if (appState.state !== AppState.RIG || !pointerDownScreen) return;

    const screenPoint = screenFromEvent(canvasEl, event);
    const moved = Math.hypot(screenPoint.x - pointerDownScreen.x, screenPoint.y - pointerDownScreen.y);
    if (!drag && !pan && moved <= TAP_SLOP_PX && view.activePointerCount <= 1) handleTap(screenPoint);

    if (pan) view.snapToDevicePixels();
    const wasDragging = drag !== null;
    if (wasDragging) history.commitCapture(dragHistory, true);
    dragHistory = null;
    drag = null;
    pan = null;
    dragCell = null;
    pointerDownScreen = null;
    if (wasDragging) emit();
  };

  canvasEl.addEventListener('pointerup', endPointer);
  canvasEl.addEventListener('pointercancel', endPointer);
}
