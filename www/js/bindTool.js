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

// PAINT AND ERASE ARE THE SAME BRUSH, POINTED THE OTHER WAY
//
// Weight painting only ever added: every stroke raised the selected
// bone's share and there was no way to lower it again except by painting
// a DIFFERENT bone over the top and letting renormalization take the
// difference -- which is a workaround, not a tool, and impossible on a
// layer with only one bone. Erase is the same brush with the delta
// negated, so brush size, falloff and strength all mean exactly what they
// already meant and there is no second code path to keep in step.
export const WeightTool = Object.freeze({ PAINT: 'paint', ERASE: 'erase' });

// Below this a lone influence is dropped rather than kept as a sliver
// nobody can see or paint over.
const WEIGHT_FLOOR = 0.01;

let weightTool = WeightTool.PAINT;
let brushRadius = 45; // screen pixels
let brushStrength = 0.35;
let painting = false;
let strokeHistory = null; // undo snapshot for the whole brush stroke
let strokePainted = false;

export function getBrush() {
  return { radius: brushRadius, strength: brushStrength };
}

export function getWeightTool() {
  return weightTool;
}

export function setWeightTool(tool) {
  weightTool = tool === WeightTool.ERASE ? WeightTool.ERASE : WeightTool.PAINT;
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
  // Erasing subtracts; applyWeightDelta clamps at zero and rescales the
  // OTHER bones on that vertex back up to fill the gap, so the weights
  // still sum to 1 and the vertex simply belongs more to whatever else was
  // already influencing it. A vertex whose last influence is erased keeps
  // an empty weight set, which skinning reads as "stay at rest".
  const direction = weightTool === WeightTool.ERASE ? -1 : 1;
  let changed = false;

  for (let i = 0; i < part.mesh.vertices.length; i++) {
    const distance = Math.hypot(deformed[i].x - scenePoint.x, deformed[i].y - scenePoint.y);
    if (distance > radiusCells) continue;

    const vertex = part.mesh.vertices[i];
    // Nothing to take away: skip rather than mark the stroke as having
    // done something, so scrubbing the eraser over already-clean artwork
    // does not land an empty step on the undo stack.
    if (direction < 0 && !(vertex.weights[boneId] > 0)) continue;

    // Linear falloff: full strength at the brush centre, nothing at its rim.
    const falloff = 1 - distance / radiusCells;
    const delta = direction * brushStrength * falloff;

    // A VERTEX NOTHING ELSE INFLUENCES IS THE ONE CASE THAT NEEDS SAYING
    //
    // applyWeightDelta keeps every vertex summing to 1 by handing whatever
    // one bone gives up to the others. Where there ARE no others it cannot
    // do that, so it does the only other correct thing and puts the weight
    // back to 1 -- which means erasing a solely-owned vertex changed
    // nothing at all, however long you scrubbed. Measured: a stroke that
    // moved shared vertices by 0.1 moved these by exactly 0.
    //
    // There is nothing to redistribute TO here, so the invariant is not
    // the question; what the user is asking for is for this bone to stop
    // moving this vertex. So the weight is allowed to decay on its own and
    // the influence is dropped once it reaches the floor, leaving the
    // vertex unweighted -- which skinning already reads as "stay at rest".
    // Partial values in between are invisible either way, because skinning
    // renormalizes by the total it finds.
    if (delta < 0) {
      let others = 0;
      for (const [id, weight] of Object.entries(vertex.weights)) {
        if (id !== boneId) others += weight;
      }
      if (others <= 0) {
        const next = vertex.weights[boneId] + delta;
        if (next <= WEIGHT_FLOOR) delete vertex.weights[boneId];
        else vertex.weights[boneId] = next;
        changed = true;
        continue;
      }
    }

    applyWeightDelta(vertex, boneId, delta);
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
    // Guarded the way the pierce and Px Pin canvases already guard it: a
    // synthetic event has no live pointer to capture, and an exception
    // here would abandon the stroke before it started.
    try { canvasEl.setPointerCapture(event.pointerId); } catch { /* no-op */ }

    painting = true;
    // A stroke is one undo step, however many vertices it touches.
    strokeHistory = history.capture(
      weightTool === WeightTool.ERASE ? 'Erase weights' : 'Paint weights'
    );
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
