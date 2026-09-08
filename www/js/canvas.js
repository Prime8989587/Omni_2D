// Placeholder rendering-engine facade.
//
// Today this module only keeps the canvas sized to its container and
// clears it to black. It exists so ui.js has a stable, state-shaped
// interface to call into now -- the real bone/mesh/skeleton renderer,
// drag-handle hit testing, and animation playback will be built inside
// this file (or modules it coordinates) later without ui.js needing to
// change.

let canvasEl = null;
let ctx = null;

function render() {
  if (!ctx || !canvasEl) return;
  const dpr = window.devicePixelRatio || 1;
  const width = canvasEl.width / dpr;
  const height = canvasEl.height / dpr;

  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, width, height);

  // FUTURE HOOK: bone/mesh/skeleton drawing, drag-handle overlays, and
  // per-frame animation playback get called from here, e.g.
  //   renderSkeleton(ctx, currentPose);
  //   renderDragHandles(ctx, selection);
}

function resize() {
  if (!canvasEl) return;
  const dpr = window.devicePixelRatio || 1;
  const rect = canvasEl.parentElement.getBoundingClientRect();
  canvasEl.width = Math.round(rect.width * dpr);
  canvasEl.height = Math.round(rect.height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  render();
}

export function initCanvas(canvas) {
  canvasEl = canvas;
  ctx = canvasEl.getContext('2d');
  window.addEventListener('resize', resize);
  resize();
}

// The following are placeholder no-ops that mirror the app's state
// transitions. ui.js already calls these at the right moments, so wiring
// in the real behavior later is a matter of filling in these functions.

export function onEnterAnimateMode() {
  // FUTURE HOOK: show skeleton overlay, enable drag handles, etc.
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
