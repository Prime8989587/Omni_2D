// Canvas interaction for Rig mode: placing bones, selecting them, and
// dragging their head/tail handles.
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

import { appState, AppState } from './state.js';
import { bonesStore } from './bones.js';

const BONE_HIT_RADIUS = 22; // generous: fingertips are not precise
const HANDLE_HIT_RADIUS = 26;
const TAP_SLOP = 8; // movement below this still counts as a tap, not a drag

let placement = null; // null | { stage: 'head' | 'tail', parentId, head }
let drag = null; // null | { bone, handle: 'head' | 'tail' }
let pointerDownAt = null;

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

function pointFromEvent(canvasEl, event) {
  const rect = canvasEl.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

function handleAt(point) {
  const bone = bonesStore.selected;
  if (!bone) return null;

  const head = bonesStore.worldHead(bone);
  if (Math.hypot(point.x - head.x, point.y - head.y) <= HANDLE_HIT_RADIUS) {
    return { bone, handle: 'head' };
  }

  const tail = bonesStore.worldTail(bone);
  if (Math.hypot(point.x - tail.x, point.y - tail.y) <= HANDLE_HIT_RADIUS) {
    return { bone, handle: 'tail' };
  }
  return null;
}

function handleTap(point) {
  if (placement) {
    if (placement.stage === 'head') {
      placement.head = point;
      placement.stage = 'tail';
      emit();
      return;
    }

    // Zero-length bones are unselectable and invisible, so ignore a second
    // tap landing on the first one.
    if (Math.hypot(point.x - placement.head.x, point.y - placement.head.y) < 1) return;

    const bone = bonesStore.addBone({
      parentId: placement.parentId,
      head: placement.head,
      tail: point,
    });
    placement = null;
    bonesStore.select(bone.id);
    emit();
    return;
  }

  const hit = bonesStore.hitTest(point.x, point.y, BONE_HIT_RADIUS);
  bonesStore.select(hit ? hit.id : null);
}

export function initRigTool(canvasEl) {
  canvasEl.addEventListener('pointerdown', (event) => {
    if (appState.state !== AppState.RIG) return;
    event.preventDefault();
    canvasEl.setPointerCapture(event.pointerId);

    const point = pointFromEvent(canvasEl, event);
    pointerDownAt = point;
    // Handles only grab while not mid-placement, so a placement tap that
    // lands on the selected bone's handle still places the bone.
    drag = placement ? null : handleAt(point);
  });

  canvasEl.addEventListener('pointermove', (event) => {
    if (appState.state !== AppState.RIG || !drag) return;
    event.preventDefault();

    const point = pointFromEvent(canvasEl, event);
    if (drag.handle === 'head') {
      bonesStore.setWorldHead(drag.bone, point.x, point.y);
    } else {
      bonesStore.setWorldTail(drag.bone, point.x, point.y);
    }
  });

  const endPointer = (event) => {
    if (appState.state !== AppState.RIG || !pointerDownAt) return;

    const point = pointFromEvent(canvasEl, event);
    const moved = Math.hypot(point.x - pointerDownAt.x, point.y - pointerDownAt.y);
    if (!drag && moved <= TAP_SLOP) handleTap(point);

    drag = null;
    pointerDownAt = null;
  };

  canvasEl.addEventListener('pointerup', endPointer);
  canvasEl.addEventListener('pointercancel', endPointer);
}
