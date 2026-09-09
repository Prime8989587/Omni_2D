// Bind mode canvas interaction: touch-based weight painting.
//
// Dragging a finger over the mesh raises the selected bone's influence on
// the vertices under the brush, and applyWeightDelta() rescales the other
// bones on those vertices so every vertex's weights still sum to 1 --
// the invariant linear blend skinning depends on.
//
// Vertices are hit-tested against their DEFORMED positions, not their rest
// positions, so the brush lands where the user actually sees the mesh even
// when a bone has already been rotated.

import { appState, AppState } from './state.js';
import { partsStore } from './parts.js';
import { bonesStore } from './bones.js';
import { applyWeightDelta, deformVertices } from './mesh.js';

export const MIN_BRUSH = 10;
export const MAX_BRUSH = 120;

let brushRadius = 45;
let brushStrength = 0.35;
let painting = false;
let lastBrush = null; // world position of the brush, for the cursor ring

const listeners = new Set();

export function subscribeBind(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit() {
  listeners.forEach((listener) => listener());
}

export function getBrush() {
  return { radius: brushRadius, strength: brushStrength, position: painting ? lastBrush : null };
}

export function setBrushRadius(value) {
  brushRadius = value;
}

export function setBrushStrength(value) {
  brushStrength = value;
}

function pointFromEvent(canvasEl, event) {
  const rect = canvasEl.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

function paintAt(point) {
  const part = partsStore.selected;
  const boneId = bonesStore.selectedId;
  if (!part || !part.mesh || !part.mesh.isBound || !boneId) return;

  const deformed = deformVertices(part.mesh, part, bonesStore.snapshotTransforms());
  let changed = false;

  for (let i = 0; i < part.mesh.vertices.length; i++) {
    const distance = Math.hypot(deformed[i].x - point.x, deformed[i].y - point.y);
    if (distance > brushRadius) continue;

    // Linear falloff: full strength at the brush centre, nothing at its rim.
    const falloff = 1 - distance / brushRadius;
    applyWeightDelta(part.mesh.vertices[i], boneId, brushStrength * falloff);
    changed = true;
  }

  if (changed) partsStore.notifyTransformed();
}

export function initBindTool(canvasEl) {
  canvasEl.addEventListener('pointerdown', (event) => {
    if (appState.state !== AppState.BIND) return;
    event.preventDefault();
    canvasEl.setPointerCapture(event.pointerId);

    painting = true;
    lastBrush = pointFromEvent(canvasEl, event);
    paintAt(lastBrush);
    emit();
  });

  canvasEl.addEventListener('pointermove', (event) => {
    if (appState.state !== AppState.BIND || !painting) return;
    event.preventDefault();

    lastBrush = pointFromEvent(canvasEl, event);
    paintAt(lastBrush);
    emit();
  });

  const endPointer = () => {
    if (!painting) return;
    painting = false;
    lastBrush = null;
    emit();
  };

  canvasEl.addEventListener('pointerup', endPointer);
  canvasEl.addEventListener('pointercancel', endPointer);
}
