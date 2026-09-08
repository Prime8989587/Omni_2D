// Canvas renderer.
//
// Draws the scene's Parts back-to-front with image smoothing disabled, so
// pixel art stays blocky at any scale instead of being blurred by the
// browser's default bilinear interpolation.
//
// This is also where the bone/skeleton renderer and animation playback
// will live in a later part -- see the FUTURE HOOK notes below.

import { partsStore } from './parts.js';

const ACCENT = '#FF2E93';
const SELECTION_OUTLINE_PX = 2;

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

function render() {
  if (!ctx || !canvasEl) return;

  // Reset per frame: setting canvas.width during a resize clears this.
  ctx.imageSmoothingEnabled = false;

  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, viewWidth, viewHeight);

  const selectedId = partsStore.selectedId;
  for (const part of partsStore.partsBottomFirst) {
    drawPart(part, part.id === selectedId);
  }

  // FUTURE HOOK: bone/skeleton overlays, drag handles for joints, and
  // per-frame animation playback draw here, on top of the parts.
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
