// Px Pin: a dedicated full-screen window for pinning single pixels.
//
// The user picks two layers -- ABOVE (the one being pinned) and BELOW
// (reference only, drawn underneath) -- and gets a private viewport with
// pinch-zoom, pan and per-layer opacity, precise enough to hit one texel.
//
// THE CAMERA HERE IS NOT THE APP'S CAMERA
//
// This window owns its own {zoom, pan} and its own <canvas>. Nothing in
// here reads or writes view.js, and nothing but setPins() ever writes to
// a part -- zooming to 800%, panning around, and leaving again cannot
// move, scale or rotate anything. That separation is the whole point:
// "get closer to see" must never turn into "accidentally moved the
// artwork". The layers are drawn FLAT (their own pixel grids, undeformed)
// at their current arrangement, which is exactly the frame pins live in.
//
// One finger paints, two fingers move the view. Pressing down starts a
// stroke and every texel the finger crosses is pinned (or erased) as it
// goes -- pinning a collar by tapping each pixel was the wrong amount of
// work. That leaves the camera to two fingers, which is where pinch
// already lived, so navigation still needs no mode switch. A second finger
// arriving mid-stroke means the user meant to pinch all along and simply
// landed one finger first, so the stroke is UNDONE rather than left behind
// as a stray pin. A whole stroke is one undo step.

import { partsStore } from './parts.js';
import { bonesStore } from './bones.js';
import { history } from './history.js';
import { pinCarriageOffset } from './mesh.js';

const ACCENT = '#FF2E93';
const MAX_ZOOM = 64; // css px per scene px -- far past single-pixel work
const MAX_BRUSH = 10; // the biggest square a single touch-point covers
const GRID_MIN_CELL_PX = 12; // draw the texel grid once cells are this big

const els = {};
let session = null;

function cacheElements() {
  for (const id of [
    'pxpinOpenBtn', 'pxpinPickerModal', 'pxpinAboveSelect', 'pxpinBelowSelect',
    'pxpinStartBtn', 'pxpinCancelBtn', 'pxpinModal', 'pxpinAboveName',
    'pxpinStatus', 'pxpinDoneBtn', 'pxpinCanvas', 'pxpinToolPinBtn',
    'pxpinToolEraseBtn', 'pxpinBrushBtn', 'pxpinBrushMenu', 'pxpinAboveOpacity',
    'pxpinBelowOpacity', 'pxpinAboveOpacityValue', 'pxpinBelowOpacityValue',
  ]) {
    els[id] = document.getElementById(id);
  }
}

function showToast(message) {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = message;
  toast.hidden = false;
  setTimeout(() => { toast.hidden = true; }, 4000);
}

// ---------------------------------------------------------------------------
// Picker

function fillSelect(select, chosenId) {
  select.replaceChildren();
  for (const part of partsStore.partsTopFirst) {
    const option = document.createElement('option');
    option.value = part.id;
    option.textContent = part.name;
    select.appendChild(option);
  }
  if (chosenId) select.value = chosenId;
}

export function openPxPinPicker() {
  const ordered = partsStore.partsTopFirst;
  if (ordered.length < 2) {
    showToast('Px Pin needs two layers — one to pin, one to line it up against.');
    return;
  }
  // Above defaults to the selected layer (or the topmost); below to the
  // next one down the stack, which is usually the thing being aligned to.
  const above = partsStore.selected || ordered[0];
  const index = ordered.findIndex((part) => part.id === above.id);
  const below = ordered[index + 1] || ordered[index - 1];
  fillSelect(els.pxpinAboveSelect, above.id);
  fillSelect(els.pxpinBelowSelect, below.id);
  els.pxpinPickerModal.hidden = false;
}

function closePicker() {
  els.pxpinPickerModal.hidden = true;
}

// ---------------------------------------------------------------------------
// Session

// A layer's pixels as an offscreen canvas, drawn once on entry; drawImage
// with smoothing off scales it losslessly at any zoom.
function layerCanvas(part) {
  const canvas = document.createElement('canvas');
  canvas.width = part.naturalWidth;
  canvas.height = part.naturalHeight;
  const context = canvas.getContext('2d');
  const image = context.createImageData(part.naturalWidth, part.naturalHeight);
  image.data.set(part.pixels);
  context.putImageData(image, 0, 0);
  return canvas;
}

// Where a layer currently sits: its own origin plus the carriage its
// bones have given it since bind (zero for unbound layers). Captured once
// on entry -- the main scene cannot change underneath a full-screen
// window -- and used for BOTH drawing and tap mapping, so what you see is
// exactly what you hit.
function layerPlacement(part) {
  const transforms = bonesStore.isEmpty ? null : bonesStore.snapshotTransforms();
  const offset = pinCarriageOffset(part, transforms);
  return { x: part.x + offset.x, y: part.y + offset.y };
}

function startSession() {
  const above = partsStore.parts.find((part) => part.id === els.pxpinAboveSelect.value);
  const below = partsStore.parts.find((part) => part.id === els.pxpinBelowSelect.value);
  if (!above || !below) return;
  if (above.id === below.id) {
    showToast('Pick two different layers — Above is pinned, Below is the reference.');
    return;
  }
  closePicker();

  // The two layers are held BY ID, not by reference: undo and project load
  // rebuild every Part from a snapshot, so a cached object would quietly go
  // stale and read pins that are no longer in the scene.
  session = {
    aboveId: above.id,
    belowId: below.id,
    get above() { return partsStore.parts.find((part) => part.id === this.aboveId); },
    get below() { return partsStore.parts.find((part) => part.id === this.belowId); },
    aboveAt: layerPlacement(above),
    belowAt: layerPlacement(below),
    aboveCanvas: layerCanvas(above),
    belowCanvas: layerCanvas(below),
    cam: { zoom: 1, panX: 0, panY: 0 },
    tool: 'pin',
    brush: 1,
    brushMenuOpen: false,
    aboveOpacity: 1,
    belowOpacity: 1,
    pointers: new Map(),
    pinch: null,
    stroke: null,
  };

  els.pxpinAboveName.textContent = above.name;
  els.pxpinAboveOpacity.value = '100';
  els.pxpinBelowOpacity.value = '100';
  els.pxpinAboveOpacityValue.textContent = '100%';
  els.pxpinBelowOpacityValue.textContent = '100%';
  els.pxpinModal.hidden = false;

  sizeCanvas();
  fitCamera();
  renderTools();
  render();
}

function endSession() {
  els.pxpinModal.hidden = true;
  session = null;
}

function sizeCanvas() {
  const canvas = els.pxpinCanvas;
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(rect.width * dpr));
  canvas.height = Math.max(1, Math.round(rect.height * dpr));
  session.cssWidth = rect.width;
  session.cssHeight = rect.height;
  session.dpr = dpr;
}

// Fit both layers on screen with a margin; that zoom is also the floor,
// so the user can always come back out to the overview.
function fitCamera() {
  const { above, below, aboveAt, belowAt, cam } = session;
  const x0 = Math.min(aboveAt.x, belowAt.x);
  const y0 = Math.min(aboveAt.y, belowAt.y);
  const x1 = Math.max(aboveAt.x + above.sceneWidth, belowAt.x + below.sceneWidth);
  const y1 = Math.max(aboveAt.y + above.sceneHeight, belowAt.y + below.sceneHeight);
  const spanX = Math.max(1, x1 - x0);
  const spanY = Math.max(1, y1 - y0);
  const zoom = Math.min(session.cssWidth / spanX, session.cssHeight / spanY) * 0.9;
  cam.zoom = Math.min(MAX_ZOOM, zoom);
  session.minZoom = Math.min(cam.zoom, zoom) * 0.5;
  cam.panX = (session.cssWidth - spanX * cam.zoom) / 2 - x0 * cam.zoom;
  cam.panY = (session.cssHeight - spanY * cam.zoom) / 2 - y0 * cam.zoom;
}

// ---------------------------------------------------------------------------
// Rendering

function drawLayer(ctx, canvas, at, part, opacity) {
  if (opacity <= 0) return;
  const { cam } = session;
  ctx.globalAlpha = opacity;
  ctx.drawImage(
    canvas,
    at.x * cam.zoom + cam.panX,
    at.y * cam.zoom + cam.panY,
    part.sceneWidth * cam.zoom,
    part.sceneHeight * cam.zoom
  );
  ctx.globalAlpha = 1;
}

function render() {
  if (!session) return;
  const canvas = els.pxpinCanvas;
  const ctx = canvas.getContext('2d');
  const { cam, above, below, aboveAt, belowAt } = session;
  if (!above || !below) { endSession(); return; } // a layer went away under us

  ctx.setTransform(session.dpr, 0, 0, session.dpr, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = '#101014';
  ctx.fillRect(0, 0, session.cssWidth, session.cssHeight);

  drawLayer(ctx, session.belowCanvas, belowAt, below, session.belowOpacity);
  drawLayer(ctx, session.aboveCanvas, aboveAt, above, session.aboveOpacity);

  // Texel grid over the ABOVE layer once cells are big enough to aim at.
  const cell = above.scale * cam.zoom;
  if (cell >= GRID_MIN_CELL_PX) {
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let u = 0; u <= above.naturalWidth; u++) {
      const x = (aboveAt.x + u * above.scale) * cam.zoom + cam.panX;
      ctx.moveTo(x, aboveAt.y * cam.zoom + cam.panY);
      ctx.lineTo(x, (aboveAt.y + above.sceneHeight) * cam.zoom + cam.panY);
    }
    for (let v = 0; v <= above.naturalHeight; v++) {
      const y = (aboveAt.y + v * above.scale) * cam.zoom + cam.panY;
      ctx.moveTo(aboveAt.x * cam.zoom + cam.panX, y);
      ctx.lineTo((aboveAt.x + above.sceneWidth) * cam.zoom + cam.panX, y);
    }
    ctx.stroke();
  }

  // Pinned pixels: solid pink corner marks + translucent fill, so the pin
  // reads clearly without completely hiding the artwork under it.
  for (const index of above.pins) {
    const u = index % above.naturalWidth;
    const v = Math.floor(index / above.naturalWidth);
    const x = (aboveAt.x + u * above.scale) * cam.zoom + cam.panX;
    const y = (aboveAt.y + v * above.scale) * cam.zoom + cam.panY;
    const size = above.scale * cam.zoom;
    // Skip the ones off-screen: a wide brush can leave thousands of pins,
    // and at the zoom that makes single pixels aimable most are outside.
    if (x + size < 0 || y + size < 0 || x > session.cssWidth || y > session.cssHeight) continue;
    ctx.fillStyle = 'rgba(255, 46, 147, 0.45)';
    ctx.fillRect(x, y, size, size);
    if (size >= 6) {
      ctx.strokeStyle = ACCENT;
      ctx.lineWidth = Math.min(2, Math.max(1, size / 10));
      ctx.strokeRect(x + 0.5, y + 0.5, size - 1, size - 1);
    }
  }

  els.pxpinStatus.textContent =
    `${above.pins.size} pinned · ${Math.round(cam.zoom * 100)}%`;
}

function renderTools() {
  els.pxpinToolPinBtn.setAttribute('aria-pressed', String(session.tool === 'pin'));
  els.pxpinToolEraseBtn.setAttribute('aria-pressed', String(session.tool === 'erase'));
  els.pxpinBrushBtn.textContent = `${session.brush} × ${session.brush} ⌄`;
  els.pxpinBrushBtn.setAttribute('aria-expanded', String(session.brushMenuOpen));
  els.pxpinBrushMenu.hidden = !session.brushMenuOpen;

  // Same size list for both tools -- a bigger brush just covers a bigger
  // square per touch-point, pinning or erasing identically.
  els.pxpinBrushMenu.replaceChildren();
  for (let size = 1; size <= MAX_BRUSH; size++) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'px-pin__brush';
    button.textContent = `${size}×${size}`;
    button.setAttribute('aria-pressed', String(session.brush === size));
    button.addEventListener('click', () => {
      session.brush = size;
      session.brushMenuOpen = false;
      renderTools();
    });
    els.pxpinBrushMenu.appendChild(button);
  }
}

// ---------------------------------------------------------------------------
// Input
//
// ONE FINGER PAINTS, TWO FINGERS MOVE THE VIEW.
//
// Pressing down starts a stroke and every texel the finger crosses is
// pinned (or erased) as it goes, like any paint tool -- tapping each pixel
// individually was the wrong amount of work for pinning a collar. That
// leaves the camera to two fingers, which is where pinch already lived, so
// nothing needed a mode switch.
//
// A second finger arriving mid-stroke means the user meant to pinch all
// along and simply landed one finger first, so the stroke is UNDONE rather
// than left behind as a stray pin. The whole stroke is one undo step.

function canvasPoint(event) {
  const rect = els.pxpinCanvas.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

// The ABOVE layer's texel under a point in the window, or null off-layer.
function texelAt(point) {
  const { above, aboveAt, cam } = session;
  const u = Math.floor(((point.x - cam.panX) / cam.zoom - aboveAt.x) / above.scale);
  const v = Math.floor(((point.y - cam.panY) / cam.zoom - aboveAt.y) / above.scale);
  return { u, v };
}

// The brush's square of texel indices, centred on (u, v).
function brushIndices(u, v) {
  const size = session.brush;
  const origin = Math.floor((size - 1) / 2);
  const indices = [];
  for (let dv = 0; dv < size; dv++) {
    for (let du = 0; du < size; du++) {
      const index = session.above.texelIndex(u - origin + du, v - origin + dv);
      if (index >= 0) indices.push(index);
    }
  }
  return indices;
}

// Applies the brush over a run of texels, remembering what each index was
// so the whole stroke can be rolled back if it turns out to be a pinch.
//
// One setPins call for the whole run, never one per pixel: setPins redraws
// the scene whenever it changes something, and a wide brush swept across a
// layer touches thousands of texels.
function stamp(texels) {
  const { above, stroke } = session;
  const pinning = session.tool === 'pin';
  const indices = new Set();
  for (const { u, v } of texels) {
    for (const index of brushIndices(u, v)) {
      if (pinning ? !above.pins.has(index) : above.pins.has(index)) indices.add(index);
    }
  }
  if (indices.size === 0) return;

  for (const index of indices) if (!stroke.touched.has(index)) stroke.touched.set(index, !pinning);
  partsStore.setPins(above.id, [...indices], pinning);
  stroke.changed = true;
}

// Fills in the texels between two samples, so a fast drag paints a line
// rather than a dotted trail.
function stampLine(from, to) {
  const steps = Math.max(Math.abs(to.u - from.u), Math.abs(to.v - from.v));
  if (steps <= 1) { stamp([to]); return; }
  const run = [];
  for (let i = 1; i <= steps; i++) {
    run.push({
      u: Math.round(from.u + ((to.u - from.u) * i) / steps),
      v: Math.round(from.v + ((to.v - from.v) * i) / steps),
    });
  }
  stamp(run);
}

function beginStroke(point) {
  session.stroke = {
    token: history.capture(session.tool === 'pin' ? 'Pin pixels' : 'Erase pins'),
    touched: new Map(), // index -> what it was before this stroke
    last: null,
    changed: false,
  };
  const texel = texelAt(point);
  stamp([texel]);
  session.stroke.last = texel;
  render();
}

function extendStroke(point) {
  const texel = texelAt(point);
  const last = session.stroke.last;
  if (last && texel.u === last.u && texel.v === last.v) return;
  if (last) stampLine(last, texel); else stamp([texel]);
  session.stroke.last = texel;
  render();
}

function endStroke() {
  const stroke = session.stroke;
  session.stroke = null;
  if (!stroke) return;
  history.commitCapture(stroke.token, stroke.changed);
}

// A pinch was intended: put back everything this stroke changed and drop
// its history entry, so a two-finger gesture never leaves a stray pin.
function abandonStroke() {
  const stroke = session.stroke;
  session.stroke = null;
  if (!stroke) return;
  // Two calls, not one per pixel: setPins redraws the scene each time it
  // changes something, and a long stroke with a wide brush touches
  // thousands of texels.
  const wasOn = [];
  const wasOff = [];
  for (const [index, wasPinned] of stroke.touched) (wasPinned ? wasOn : wasOff).push(index);
  if (wasOn.length) partsStore.setPins(session.above.id, wasOn, true);
  if (wasOff.length) partsStore.setPins(session.above.id, wasOff, false);
  history.commitCapture(stroke.token, false);
  render();
}

function onPointerDown(event) {
  if (!session) return;
  event.preventDefault();
  // Capture keeps a stroke delivering when the finger leaves the canvas; a
  // synthetic event (tests) has no active pointer to capture, which is
  // fine -- the gesture logic below works either way.
  try { els.pxpinCanvas.setPointerCapture(event.pointerId); } catch { /* no-op */ }
  session.pointers.set(event.pointerId, canvasPoint(event));

  if (session.pointers.size === 1) {
    session.pinch = null;
    beginStroke(canvasPoint(event));
  } else if (session.pointers.size === 2) {
    abandonStroke(); // two fingers is the camera, never paint
    const [a, b] = [...session.pointers.values()];
    session.pinch = {
      distance: Math.hypot(b.x - a.x, b.y - a.y),
      zoom: session.cam.zoom,
      mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      panX: session.cam.panX,
      panY: session.cam.panY,
    };
  }
}

function onPointerMove(event) {
  if (!session || !session.pointers.has(event.pointerId)) return;
  event.preventDefault();
  const point = canvasPoint(event);
  session.pointers.set(event.pointerId, point);

  if (session.pointers.size === 2 && session.pinch) {
    const [a, b] = [...session.pointers.values()];
    const distance = Math.hypot(b.x - a.x, b.y - a.y);
    const factor = distance / Math.max(1, session.pinch.distance);
    const zoom = Math.min(MAX_ZOOM, Math.max(session.minZoom, session.pinch.zoom * factor));
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    // Keep the scene point under the pinch midpoint fixed while zooming;
    // two fingers moving together therefore pan.
    const scale = zoom / session.pinch.zoom;
    session.cam.zoom = zoom;
    session.cam.panX = mid.x - (session.pinch.mid.x - session.pinch.panX) * scale;
    session.cam.panY = mid.y - (session.pinch.mid.y - session.pinch.panY) * scale;
    render();
    return;
  }

  if (session.pointers.size === 1 && session.stroke) extendStroke(point);
}

function onPointerUp(event) {
  if (!session || !session.pointers.has(event.pointerId)) return;
  session.pointers.delete(event.pointerId);
  if (session.pointers.size < 2) session.pinch = null;
  if (session.pointers.size === 0) endStroke();
}

// Read-only window into the private camera, for tests: proving the zoom
// lives HERE and nowhere near view.js or any part is the point of the
// whole design.
export function pxpinDebug() {
  if (!session) return null;
  return {
    zoom: session.cam.zoom,
    panX: session.cam.panX,
    panY: session.cam.panY,
    aboveAt: { ...session.aboveAt },
    belowAt: { ...session.belowAt },
    tool: session.tool,
    brush: session.brush,
    brushMenuOpen: session.brushMenuOpen,
  };
}

// ---------------------------------------------------------------------------
// Wiring

export function initPxPin() {
  cacheElements();

  els.pxpinOpenBtn.addEventListener('click', openPxPinPicker);
  els.pxpinStartBtn.addEventListener('click', startSession);
  els.pxpinCancelBtn.addEventListener('click', closePicker);
  els.pxpinDoneBtn.addEventListener('click', endSession);

  els.pxpinToolPinBtn.addEventListener('click', () => { if (session) { session.tool = 'pin'; renderTools(); } });
  els.pxpinToolEraseBtn.addEventListener('click', () => { if (session) { session.tool = 'erase'; renderTools(); } });
  els.pxpinBrushBtn.addEventListener('click', () => {
    if (!session) return;
    session.brushMenuOpen = !session.brushMenuOpen;
    renderTools();
  });

  els.pxpinAboveOpacity.addEventListener('input', () => {
    if (!session) return;
    session.aboveOpacity = Number(els.pxpinAboveOpacity.value) / 100;
    els.pxpinAboveOpacityValue.textContent = `${els.pxpinAboveOpacity.value}%`;
    render();
  });
  els.pxpinBelowOpacity.addEventListener('input', () => {
    if (!session) return;
    session.belowOpacity = Number(els.pxpinBelowOpacity.value) / 100;
    els.pxpinBelowOpacityValue.textContent = `${els.pxpinBelowOpacity.value}%`;
    render();
  });

  els.pxpinCanvas.addEventListener('pointerdown', onPointerDown);
  els.pxpinCanvas.addEventListener('pointermove', onPointerMove);
  els.pxpinCanvas.addEventListener('pointerup', onPointerUp);
  els.pxpinCanvas.addEventListener('pointercancel', onPointerUp);

  window.addEventListener('resize', () => {
    if (!session) return;
    sizeCanvas();
    render();
  });
}
