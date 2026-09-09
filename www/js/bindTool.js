// Bind mode canvas interaction: touch-based weight painting.
//
// Dragging a finger over the mesh raises the selected bone's influence on
// the vertices under the brush, and applyWeightDelta() rescales the other
// bones on those vertices so every vertex's weights still sum to 1 --
// the invariant linear blend skinning depends on.
//
// Vertices are hit-tested against their DEFORMED positions, not their rest
// positions, so the brush lands where the user actually sees the mesh even
// when a bone has already been rotated. The brush size is a screen-pixel
// radius -- it feels the same at every zoom -- and is converted to grid
// cells for the distance test.

import { appState, AppState } from './state.js';
import { partsStore } from './parts.js';
import { bonesStore } from './bones.js';
import { applyWeightDelta, deformVertices } from './mesh.js';
import { view } from './view.js';
import { history } from './history.js';

export const MIN_BRUSH = 10;
export const MAX_BRUSH = 120;

let brushRadius = 45; // screen pixels
let brushStrength = 0.35;
let painting = false;
let strokeHistory = null; // undo snapshot for the whole brush stroke
let strokePainted = false;

export function getBrush() {
  return { radius: brushRadius, strength: brushStrength };
}

export function setBrushRadius(value) {
  brushRadius = value;
}

export function setBrushStrength(value) {
  brushStrength = value;
}

function sceneFromEvent(canvasEl, event) {
  const rect = canvasEl.getBoundingClientRect();
  return view.toScene(event.clientX - rect.left, event.clientY - rect.top);
}

function paintAt(scenePoint) {
  const part = partsStore.selected;
  const boneId = bonesStore.selectedId;
  if (!part || !part.mesh || !part.mesh.isBound || !boneId) return;

  const radiusCells = brushRadius / view.zoom;
  const deformed = deformVertices(part.mesh, part, bonesStore.snapshotTransforms());
  let changed = false;

  for (let i = 0; i < part.mesh.vertices.length; i++) {
    const distance = Math.hypot(deformed[i].x - scenePoint.x, deformed[i].y - scenePoint.y);
    if (distance > radiusCells) continue;

    // Linear falloff: full strength at the brush centre, nothing at its rim.
    const falloff = 1 - distance / radiusCells;
    applyWeightDelta(part.mesh.vertices[i], boneId, brushStrength * falloff);
    changed = true;
  }

  if (changed) {
    strokePainted = true;
    partsStore.notifyTransformed();
  }
}

export function initBindTool(canvasEl) {
  canvasEl.addEventListener('pointerdown', (event) => {
    if (appState.state !== AppState.BIND) return;
    // A second finger means a pinch, which viewGestures owns.
    if (view.activePointerCount > 1) {
      painting = false;
      return;
    }
    event.preventDefault();
    canvasEl.setPointerCapture(event.pointerId);

    painting = true;
    // A stroke is one undo step, however many vertices it touches.
    strokeHistory = history.capture('Paint weights');
    strokePainted = false;
    paintAt(sceneFromEvent(canvasEl, event));
  });

  canvasEl.addEventListener('pointermove', (event) => {
    if (appState.state !== AppState.BIND || !painting) return;
    if (view.activePointerCount > 1) {
      painting = false;
      history.commitCapture(strokeHistory, strokePainted);
      strokeHistory = null;
      strokePainted = false;
      return;
    }
    event.preventDefault();
    paintAt(sceneFromEvent(canvasEl, event));
  });

  const endPointer = () => {
    painting = false;
    history.commitCapture(strokeHistory, strokePainted);
    strokeHistory = null;
    strokePainted = false;
  };

  canvasEl.addEventListener('pointerup', endPointer);
  canvasEl.addEventListener('pointercancel', endPointer);
}
