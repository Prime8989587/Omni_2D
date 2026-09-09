// Canvas renderer.
//
// Draws the scene's Parts back-to-front with image smoothing disabled, so
// pixel art stays blocky at any scale instead of being blurred by the
// browser's default bilinear interpolation.
//
// This is also where the bone/skeleton renderer and animation playback
// will live in a later part -- see the FUTURE HOOK notes below.

import { partsStore } from './parts.js';
import { bonesStore } from './bones.js';
import { appState, AppState } from './state.js';
import { getPlacement, subscribeRig } from './rigTool.js';

const ACCENT = '#FF2E93';
const SELECTION_OUTLINE_PX = 2;

// Child bones are drawn in a lighter pink than roots, so the hierarchy is
// readable at a glance without consulting the list.
const ROOT_STROKE = ACCENT;
const CHILD_STROKE = '#FF8FC4';
const ROOT_FILL = 'rgba(255, 46, 147, 0.35)';
const CHILD_FILL = 'rgba(255, 143, 196, 0.28)';

// Rig mode veils the character art so bright pink bones stay readable on
// top of colorful pixel art.
const RIG_VEIL = 'rgba(0, 0, 0, 0.45)';

let canvasEl = null;
let ctx = null;
let viewWidth = 0;
let viewHeight = 0;
let frameRequested = false;

export function getViewSize() {
  return { width: viewWidth, height: viewHeight };
}

function drawPart(part, isSelected) {
  ctx.save();
  ctx.translate(part.x, part.y);
  ctx.rotate(part.rotation);
  ctx.scale(part.scale, part.scale);

  const width = part.naturalWidth;
  const height = part.naturalHeight;
  ctx.drawImage(part.image, -width / 2, -height / 2, width, height);

  if (isSelected) {
    // Divided by the part's scale so the outline is always the same
    // thickness on screen, however far the part is zoomed in or out.
    ctx.lineWidth = SELECTION_OUTLINE_PX / part.scale;
    ctx.strokeStyle = ACCENT;
    ctx.strokeRect(-width / 2, -height / 2, width, height);
  }

  ctx.restore();
}

// A bone is drawn as a tapered wedge: widest just past the head, tapering
// to a point at the tail, so its direction is obvious at a glance.
function drawBone(bone, isSelected) {
  const head = bonesStore.worldHead(bone);
  const tail = bonesStore.worldTail(bone);
  const length = Math.hypot(tail.x - head.x, tail.y - head.y);
  if (length < 0.5) return;

  const dirX = (tail.x - head.x) / length;
  const dirY = (tail.y - head.y) / length;
  const width = Math.min(Math.max(length * 0.14, 3), 11);
  const shoulder = Math.min(length * 0.25, width * 2);

  const shoulderX = head.x + dirX * shoulder;
  const shoulderY = head.y + dirY * shoulder;
  // Perpendicular to the bone direction.
  const perpX = -dirY * width;
  const perpY = dirX * width;

  ctx.beginPath();
  ctx.moveTo(head.x, head.y);
  ctx.lineTo(shoulderX + perpX, shoulderY + perpY);
  ctx.lineTo(tail.x, tail.y);
  ctx.lineTo(shoulderX - perpX, shoulderY - perpY);
  ctx.closePath();

  ctx.fillStyle = bone.isRoot ? ROOT_FILL : CHILD_FILL;
  ctx.fill();
  ctx.strokeStyle = bone.isRoot ? ROOT_STROKE : CHILD_STROKE;
  ctx.lineWidth = isSelected ? 3 : 1.5;
  ctx.stroke();

  if (isSelected) {
    // Handles are only shown for the selected bone -- they are what the
    // head/tail drags grab.
    for (const [point, radius] of [[head, 7], [tail, 5]]) {
      ctx.beginPath();
      ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
      ctx.fillStyle = ACCENT;
      ctx.fill();
    }
  }
}

// When a child's head has been dragged away from its parent's tail, a
// dashed line keeps the relationship visible.
function drawParentLink(bone) {
  const parent = bonesStore.parentOf(bone);
  if (!parent) return;

  const parentTail = bonesStore.worldTail(parent);
  const head = bonesStore.worldHead(bone);
  if (Math.hypot(head.x - parentTail.x, head.y - parentTail.y) < 2) return;

  ctx.save();
  ctx.beginPath();
  ctx.setLineDash([4, 4]);
  ctx.moveTo(parentTail.x, parentTail.y);
  ctx.lineTo(head.x, head.y);
  ctx.strokeStyle = CHILD_STROKE;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.restore();
}

function drawSkeleton() {
  ctx.fillStyle = RIG_VEIL;
  ctx.fillRect(0, 0, viewWidth, viewHeight);

  for (const bone of bonesStore.bones) drawParentLink(bone);

  const selectedId = bonesStore.selectedId;
  for (const bone of bonesStore.bones) drawBone(bone, bone.id === selectedId);

  // A bone mid-placement: mark where its head landed while we wait for
  // the tap that sets the tail.
  const placement = getPlacement();
  if (placement && placement.head) {
    ctx.beginPath();
    ctx.arc(placement.head.x, placement.head.y, 8, 0, Math.PI * 2);
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = 2;
    ctx.stroke();
  }
}

function render() {
  if (!ctx || !canvasEl) return;

  // Reset per frame: setting canvas.width during a resize clears this.
  ctx.imageSmoothingEnabled = false;

  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, viewWidth, viewHeight);

  const isRig = appState.state === AppState.RIG;
  // Parts are not selectable in Rig mode, so their outline would be noise.
  const selectedId = isRig ? null : partsStore.selectedId;
  for (const part of partsStore.partsBottomFirst) {
    drawPart(part, part.id === selectedId);
  }

  if (isRig) drawSkeleton();

  // FUTURE HOOK: animation playback and mesh deformation draw here.
}

export function requestRender() {
  if (frameRequested) return;
  frameRequested = true;
  requestAnimationFrame(() => {
    frameRequested = false;
    render();
  });
}

function resize() {
  if (!canvasEl) return;
  const dpr = window.devicePixelRatio || 1;
  const rect = canvasEl.parentElement.getBoundingClientRect();

  viewWidth = rect.width;
  viewHeight = rect.height;
  canvasEl.width = Math.round(rect.width * dpr);
  canvasEl.height = Math.round(rect.height * dpr);

  // Draw in CSS pixels; the backing store carries the extra device pixels.
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  render();
}

export function initCanvas(canvas) {
  canvasEl = canvas;
  ctx = canvasEl.getContext('2d');
  window.addEventListener('resize', resize);
  partsStore.subscribe(requestRender);
  bonesStore.subscribe(requestRender);
  appState.subscribe(requestRender);
  // Placing a bone's head changes what to draw without touching a store.
  subscribeRig(requestRender);
  resize();
}

// Placeholder no-ops mirroring the app's state transitions. ui.js already
// calls these at the right moments, so wiring in real behavior later is a
// matter of filling them in.

export function onEnterAnimateMode() {
  // FUTURE HOOK: show skeleton overlay, enable joint drag handles.
}

export function onExitAnimateMode() {
  // FUTURE HOOK: hide skeleton overlay, cancel any in-progress drag.
}

export function onStartRecording() {
  // FUTURE HOOK: begin capturing frames for GIF/MP4 export.
}

export function onStopRecording() {
  // FUTURE HOOK: stop capturing frames and hand the captured data off to
  // the export flow (see ui.js's handleSave) once real encoding exists.
}
