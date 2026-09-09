// Touch manipulation of Parts on the canvas.
//
//   one finger   - drag the part under the finger (and select it)
//   two fingers  - pinch to scale, twist to rotate, and slide to move the
//                  selected part
//
// Deltas are measured frame to frame rather than against the gesture's
// start, so the rotation can cross the +/-180 degree boundary without the
// part snapping around.

import { partsStore } from './parts.js';
import { appState, AppState } from './state.js';

const MIN_SCALE = 0.05;
const MAX_SCALE = 40;

const pointers = new Map();
let gesture = null;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function normalizeAngle(angle) {
  let result = angle;
  while (result > Math.PI) result -= 2 * Math.PI;
  while (result < -Math.PI) result += 2 * Math.PI;
  return result;
}

// The canvas element's CSS size matches the coordinate space we draw in
// (device pixel ratio only affects the backing store), so this is a plain
// offset from the element's top-left corner.
function pointFromEvent(canvasEl, event) {
  const rect = canvasEl.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

function twoPointerMetrics() {
  const [a, b] = [...pointers.values()];
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return {
    distance: Math.hypot(dx, dy),
    angle: Math.atan2(dy, dx),
    centerX: (a.x + b.x) / 2,
    centerY: (a.y + b.y) / 2,
  };
}

function beginTransform() {
  const part = partsStore.selected;
  if (!part) {
    gesture = null;
    return;
  }
  const metrics = twoPointerMetrics();
  gesture = {
    type: 'transform',
    part,
    lastDistance: metrics.distance,
    lastAngle: metrics.angle,
    lastCenterX: metrics.centerX,
    lastCenterY: metrics.centerY,
  };
}

function beginDrag(part) {
  const [pointer] = [...pointers.values()];
  gesture = { type: 'drag', part, lastX: pointer.x, lastY: pointer.y };
}

// Parts are only manipulable on the Home screen. In Rig mode the canvas
// belongs to the bone tool instead, so the character stays put while the
// skeleton is built on top of it.
function partsAreEditable() {
  return appState.state === AppState.HOME;
}

export function initGestures(canvasEl) {
  canvasEl.addEventListener('pointerdown', (event) => {
    if (!partsAreEditable()) return;
    event.preventDefault();
    canvasEl.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, pointFromEvent(canvasEl, event));

    if (pointers.size === 1) {
      const point = pointers.get(event.pointerId);
      const hit = partsStore.hitTest(point.x, point.y);
      partsStore.select(hit ? hit.id : null);
      gesture = null;
      if (hit) beginDrag(hit);
      return;
    }

    if (pointers.size === 2) {
      beginTransform();
    }
  });

  canvasEl.addEventListener('pointermove', (event) => {
    if (!partsAreEditable() || !pointers.has(event.pointerId)) return;
    event.preventDefault();
    pointers.set(event.pointerId, pointFromEvent(canvasEl, event));

    if (!gesture) return;

    if (gesture.type === 'drag' && pointers.size === 1) {
      const point = pointers.get(event.pointerId);
      gesture.part.x += point.x - gesture.lastX;
      gesture.part.y += point.y - gesture.lastY;
      gesture.lastX = point.x;
      gesture.lastY = point.y;
      partsStore.notifyTransformed();
      return;
    }

    if (gesture.type === 'transform' && pointers.size === 2) {
      const metrics = twoPointerMetrics();
      const part = gesture.part;

      if (gesture.lastDistance > 0) {
        const factor = metrics.distance / gesture.lastDistance;
        part.scale = clamp(part.scale * factor, MIN_SCALE, MAX_SCALE);
      }
      part.rotation += normalizeAngle(metrics.angle - gesture.lastAngle);
      part.x += metrics.centerX - gesture.lastCenterX;
      part.y += metrics.centerY - gesture.lastCenterY;

      gesture.lastDistance = metrics.distance;
      gesture.lastAngle = metrics.angle;
      gesture.lastCenterX = metrics.centerX;
      gesture.lastCenterY = metrics.centerY;
      partsStore.notifyTransformed();
    }
  });

  const endPointer = (event) => {
    if (!pointers.delete(event.pointerId)) return;

    if (pointers.size === 0) {
      gesture = null;
      return;
    }

    // Lifting one finger mid-pinch hands the part back to a plain drag
    // with whichever finger is still down, instead of ending the gesture.
    if (pointers.size === 1 && gesture) {
      beginDrag(gesture.part);
    }
  };

  canvasEl.addEventListener('pointerup', endPointer);
  canvasEl.addEventListener('pointercancel', endPointer);
}
