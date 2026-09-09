// Touch manipulation of Parts on the Home screen, and of the camera when
// the fingers land on empty grid.
//
//   one finger on a part     - drag it, in whole grid cells
//   two fingers on a part    - pinch to scale (whole-number steps), twist
//                              to rotate, slide to move
//   one finger on empty grid - pan the view
//   two fingers on empty grid- pinch-zoom the view
//
// Which of those a gesture becomes is decided by where the FIRST finger
// lands. That is how the camera and Part 2's part transform share the
// same two-finger gesture without stepping on each other.
//
// Deltas are measured frame to frame rather than against the gesture's
// start, so the rotation can cross the +/-180 degree boundary without the
// part snapping around. Position and scale, by contrast, accumulate as
// exact floats and are ROUNDED onto the grid each frame -- the part only
// ever occupies whole cells, but a slow finger still moves it eventually.

import { partsStore, clampScale, MIN_PART_SCALE, MAX_PART_SCALE } from './parts.js';
import { appState, AppState } from './state.js';
import { view } from './view.js';
import { history } from './history.js';

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

// A gesture is ONE undo step however many pointermove frames it spans:
// the snapshot is taken when the finger goes down and committed when the
// last finger lifts, and only if the layer actually ended up different.
let pendingEdit = null;

function beginEdit(part, label) {
  if (pendingEdit) return;
  pendingEdit = {
    token: history.capture(label),
    part,
    before: { x: part.x, y: part.y, scale: part.scale, rotation: part.rotation },
  };
}

function finishEdit() {
  if (!pendingEdit) return;
  const { token, part, before } = pendingEdit;
  pendingEdit = null;
  const changed =
    part.x !== before.x ||
    part.y !== before.y ||
    part.scale !== before.scale ||
    part.rotation !== before.rotation;
  history.commitCapture(token, changed);
}

function beginDrag(part, screenPoint) {
  gesture = {
    type: 'drag',
    part,
    anchorX: screenPoint.x,
    anchorY: screenPoint.y,
    originX: part.x,
    originY: part.y,
  };
}

function beginTransform(part) {
  const metrics = twoPointerMetrics();
  gesture = {
    type: 'transform',
    part,
    lastDistance: metrics.distance,
    lastAngle: metrics.angle,
    lastCenterX: metrics.centerX,
    lastCenterY: metrics.centerY,
    // Exact accumulators; the part gets the rounded versions.
    pendingScale: part.scale,
    centerX: part.centerX,
    centerY: part.centerY,
  };
}

function beginPan(screenPoint) {
  gesture = { type: 'pan', lastX: screenPoint.x, lastY: screenPoint.y };
}

// Parts are only manipulable on the Home screen. In the other modes the
// canvas belongs to that mode's tool and the character stays put.
function partsAreEditable() {
  return appState.state === AppState.HOME;
}

export function initGestures(canvasEl) {
  canvasEl.addEventListener('pointerdown', (event) => {
    if (!partsAreEditable()) return;
    event.preventDefault();
    canvasEl.setPointerCapture(event.pointerId);

    const screenPoint = pointFromEvent(canvasEl, event);
    pointers.set(event.pointerId, screenPoint);

    if (pointers.size === 1) {
      const scenePoint = view.toScene(screenPoint.x, screenPoint.y);
      // The SELECTED part wins whenever the finger lands on it, even if
      // another part is stacked on top. Otherwise a layer picked from the
      // Scene Parts list could never be dragged out from under a newer
      // one: the topmost hit would take over the touch and the selection.
      // Only when the finger is off the selected part does the touch
      // fall through to whatever is topmost there (tap-to-select).
      const selected = partsStore.selected;
      const hit = selected && selected.visible && selected.containsPoint(scenePoint.x, scenePoint.y)
        ? selected
        : partsStore.hitTest(scenePoint.x, scenePoint.y);
      partsStore.select(hit ? hit.id : null);
      // A locked layer can be selected and inspected but not moved, so the
      // touch drives the camera instead of the artwork.
      if (hit && !hit.locked) {
        beginEdit(hit, 'Move layer');
        beginDrag(hit, screenPoint);
      } else {
        beginPan(screenPoint);
      }
      return;
    }

    if (pointers.size === 2) {
      // A second finger joins whatever the first one started: a part
      // gesture becomes a part transform, a camera gesture becomes a pinch.
      const onPart = gesture && (gesture.type === 'drag' || gesture.type === 'transform');
      const part = partsStore.selected;
      if (onPart && part && !part.locked) {
        beginEdit(part, 'Transform layer');
        beginTransform(part);
      } else {
        gesture = { type: 'pinchView' };
      }
    }
  });

  canvasEl.addEventListener('pointermove', (event) => {
    if (!partsAreEditable() || !pointers.has(event.pointerId)) return;
    event.preventDefault();

    const previous = pointers.get(event.pointerId);
    const current = pointFromEvent(canvasEl, event);
    pointers.set(event.pointerId, current);
    if (!gesture) return;

    if (gesture.type === 'drag' && pointers.size === 1) {
      // Screen travel since the finger went down, converted to grid cells
      // and rounded: the part hops cell to cell, never in between.
      const dx = (current.x - gesture.anchorX) / view.zoom;
      const dy = (current.y - gesture.anchorY) / view.zoom;
      gesture.part.x = Math.round(gesture.originX + dx);
      gesture.part.y = Math.round(gesture.originY + dy);
      partsStore.notifyTransformed();
      return;
    }

    if (gesture.type === 'pan' && pointers.size === 1) {
      view.panBy(current.x - gesture.lastX, current.y - gesture.lastY);
      gesture.lastX = current.x;
      gesture.lastY = current.y;
      return;
    }

    if (gesture.type === 'pinchView' && pointers.size === 2) {
      const other = [...pointers.entries()].find(([id]) => id !== event.pointerId)[1];
      view.pinch(previous, other, current, other);
      return;
    }

    if (gesture.type === 'transform' && pointers.size === 2) {
      const metrics = twoPointerMetrics();
      const part = gesture.part;

      if (gesture.lastDistance > 0) {
        gesture.pendingScale = clamp(
          gesture.pendingScale * (metrics.distance / gesture.lastDistance),
          MIN_PART_SCALE,
          MAX_PART_SCALE
        );
      }
      part.rotation += normalizeAngle(metrics.angle - gesture.lastAngle);
      gesture.centerX += (metrics.centerX - gesture.lastCenterX) / view.zoom;
      gesture.centerY += (metrics.centerY - gesture.lastCenterY) / view.zoom;

      // Apply the scale first, then re-derive the top-left from the exact
      // centre, so a scale step grows the part evenly around the fingers
      // rather than from its corner.
      part.scale = clampScale(gesture.pendingScale);
      part.x = Math.round(gesture.centerX - part.sceneWidth / 2);
      part.y = Math.round(gesture.centerY - part.sceneHeight / 2);

      gesture.lastDistance = metrics.distance;
      gesture.lastAngle = metrics.angle;
      gesture.lastCenterX = metrics.centerX;
      gesture.lastCenterY = metrics.centerY;
      partsStore.notifyTransformed();
    }
  });

  const endPointer = (event) => {
    if (!pointers.delete(event.pointerId)) return;

    if (gesture && gesture.type === 'pinchView' && pointers.size < 2) {
      view.snapToDevicePixels();
    }

    if (pointers.size === 0) {
      gesture = null;
      finishEdit();
      return;
    }

    // Lifting one finger mid-gesture hands over to the remaining finger
    // instead of ending the gesture: a part pinch becomes a drag, a view
    // pinch becomes a pan.
    if (pointers.size === 1 && gesture) {
      const [remaining] = [...pointers.values()];
      if (gesture.type === 'transform') beginDrag(gesture.part, remaining);
      else if (gesture.type === 'pinchView') beginPan(remaining);
    }
  };

  canvasEl.addEventListener('pointerup', endPointer);
  canvasEl.addEventListener('pointercancel', endPointer);
}
