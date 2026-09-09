// Two-finger zoom and pan of the camera, plus the pointer bookkeeping that
// lets the single-finger tools notice when a second finger arrives.
//
// This owns multi-touch in every mode except Home. On the Home screen a
// pinch that begins on a part must scale and rotate that part (Part 2), so
// gestures.js decides there whether two fingers mean "transform the part"
// or "move the camera". Everywhere else two fingers always mean the camera.
//
// Register this before the mode tools: its pointerdown runs first, so by
// the time a tool sees the second finger, view.activePointerCount already
// says 2 and the tool can step aside.

import { view } from './view.js';
import { appState, AppState } from './state.js';

const pointers = new Map(); // pointerId -> screen point
let pinching = false;

function pointFromEvent(canvasEl, event) {
  const rect = canvasEl.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

function ownsMultiTouch() {
  return appState.state !== AppState.HOME;
}

export function initViewGestures(canvasEl) {
  canvasEl.addEventListener('pointerdown', (event) => {
    view.trackPointer(event.pointerId);
    pointers.set(event.pointerId, pointFromEvent(canvasEl, event));

    if (pointers.size === 2 && ownsMultiTouch()) {
      event.preventDefault();
      canvasEl.setPointerCapture(event.pointerId);
      pinching = true;
    }
  });

  canvasEl.addEventListener('pointermove', (event) => {
    if (!pointers.has(event.pointerId)) return;

    const previous = pointers.get(event.pointerId);
    const current = pointFromEvent(canvasEl, event);
    pointers.set(event.pointerId, current);

    if (!pinching || pointers.size !== 2) return;
    event.preventDefault();

    // The other finger hasn't moved this event, so it is its own "previous".
    const other = [...pointers.entries()].find(([id]) => id !== event.pointerId)[1];
    view.pinch(previous, other, current, other);
  });

  const endPointer = (event) => {
    view.releasePointer(event.pointerId);
    pointers.delete(event.pointerId);

    if (pinching && pointers.size < 2) {
      pinching = false;
      // Settle on whole device pixels per cell so the grid is crisp again.
      view.snapToDevicePixels();
    }
  };

  canvasEl.addEventListener('pointerup', endPointer);
  canvasEl.addEventListener('pointercancel', endPointer);
}
