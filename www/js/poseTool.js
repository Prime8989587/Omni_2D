// Free Move: posing the character by dragging it.
//
// SELECTION FIRST, THEN DRAG ANYWHERE
//
// The user picks which bone they are moving from a list of names, before
// touching the canvas. After that, a drag ANYWHERE on the canvas moves
// that bone. There is deliberately no hit-testing of any kind here: not
// of bones, not of layers, not of pixels. Which bone moves is a decision
// the user already made, not something inferred from where a fingertip
// happened to land -- and on a phone, landing a fingertip on the right
// piece of a character is exactly the fiddly problem this avoids.
//
// WHAT A DRAG WRITES
//
// Exactly one number pair: the target bone's offset from its parent.
// Every other bone is DERIVED from that, every frame, by the forward
// kinematics the app already uses --
//
//   world head = parent's current world transform  x  stored rest offset
//
// so there is no separate "pose" to keep in sync with anything. A bone
// without physics tracks its parent exactly, with no lag, because its
// position is not integrated at all: it is recomputed from scratch each
// time anything asks where it is. A bone WITH physics reads its target
// from that same chain, live, and keeps its own simulated angle trailing
// behind it, carrying on after the finger lifts.
//
// Writing the target's own offset is also what makes the two directions
// come out right without a special case: everything BELOW it is expressed
// relative to it and comes along, while everything ABOVE it is expressed
// relative to ITS parent and is untouched. Drag the body and the whole
// character moves; drag a hand and only the hand and its fingers move.

import { bonesStore } from './bones.js';
import { partsStore } from './parts.js';
import { view } from './view.js';
import { history } from './history.js';
import { appState, AppState } from './state.js';

let targetId = null;
let drag = null;
const listeners = new Set();

function emit() {
  listeners.forEach((listener) => listener());
}

export function subscribeTargets(listener) {
  listeners.add(listener);
  listener();
  return () => listeners.delete(listener);
}

// Every bone is offered. A spring bone's ANGLE is simulated, but its
// position is not, so moving one is still meaningful -- it is where that
// hair or cloth hangs from. Hiding bones on a guess would be worse than
// showing one the user turns out not to want.
export function dragTargets() {
  return bonesStore.toTreeList();
}

// The chosen bone, falling back to the root so the common case (move the
// whole character) needs no setup. Also recovers if the chosen bone was
// deleted while the picker was not looking.
export function getDragTarget() {
  const chosen = targetId ? bonesStore.byId(targetId) : null;
  if (chosen) return chosen;
  const [root] = bonesStore.roots;
  return root || null;
}

export function getDragTargetId() {
  const target = getDragTarget();
  return target ? target.id : null;
}

export function setDragTarget(id) {
  if (targetId === id) return;
  targetId = id;
  emit();
}

export function isPosing() {
  return drag !== null;
}

// Bone endpoints sit on pixel centres (the grid revision's rule), so a
// dragged bone lands on whole pixels like a placed one does.
function snapToCell(point) {
  return { x: Math.floor(point.x) + 0.5, y: Math.floor(point.y) + 0.5 };
}

export function beginPoseDrag(bone, scenePoint) {
  if (drag || !bone) return;
  // The offset is measured from wherever the finger went down, so the
  // bone moves WITH the finger rather than jumping to it. Taken against
  // the rest pose, which is what a drag writes.
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

function sceneFromEvent(canvasEl, event) {
  const rect = canvasEl.getBoundingClientRect();
  return view.toScene(event.clientX - rect.left, event.clientY - rect.top);
}

export function initPoseTool(canvasEl) {
  const active = () => appState.state === AppState.ANIMATING;

  canvasEl.addEventListener('pointerdown', (event) => {
    if (!active()) return;
    // Two fingers belong to the camera (viewGestures pinches and pans).
    if (view.activePointerCount > 1) {
      endPoseDrag();
      return;
    }
    const bone = getDragTarget();
    if (!bone || partsStore.isEmpty) return;

    event.preventDefault();
    canvasEl.setPointerCapture(event.pointerId);
    beginPoseDrag(bone, sceneFromEvent(canvasEl, event));
  });

  canvasEl.addEventListener('pointermove', (event) => {
    if (!active() || !isPosing()) return;
    if (view.activePointerCount > 1) {
      endPoseDrag();
      return;
    }
    event.preventDefault();
    updatePoseDrag(sceneFromEvent(canvasEl, event));
  });

  const endPointer = () => {
    if (!active()) return;
    endPoseDrag();
  };

  canvasEl.addEventListener('pointerup', endPointer);
  canvasEl.addEventListener('pointercancel', endPointer);

  // A deleted or reloaded skeleton must not leave the picker pointing at
  // a bone that no longer exists.
  bonesStore.subscribe(() => {
    if (targetId && !bonesStore.byId(targetId)) {
      targetId = null;
      emit();
    }
  });
}
