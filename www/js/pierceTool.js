// Pierce region painting: which pixels are the tip, and which are flesh.
//
// A dedicated full-screen window, deliberately built on the same pattern
// as Px Pin's: both layers of the relationship drawn together at their
// REAL relative positions, an opacity slider for each, and a private
// camera. What is painted here is two sets of texels --
//
//   on the PIERCER      the tip: the pixels that actually do the piercing
//   on the INTERACTIVE  the pierceable area: the pixels a tip may push into
//
// -- each stored as texel indices in ITS OWN layer's pixel grid, exactly
// like Px Pin's pins. Local coordinates are the whole point: a region
// stays glued to the artwork it was painted on no matter where the layer
// is afterwards dragged, deformed or re-rigged.
//
// THE CAMERA HERE IS NOT THE APP'S CAMERA
//
// Same rule as Px Pin, and for the same reason. This window owns its own
// {zoom, pan} and its own <canvas>; nothing in here reads or writes
// view.js, and the ONLY thing it ever writes to a part is its pierce
// region. Zooming to 800%, panning around and leaving again cannot move,
// scale or rotate either layer. "Get closer to see" must never turn into
// "accidentally moved the artwork".
//
// One finger paints, two fingers move the view -- the same interaction
// Px Pin settled on, so there is one way to paint pixels in this app
// rather than two.

import { partsStore } from './parts.js';
import { bonesStore } from './bones.js';
import { history } from './history.js';
import { pinCarriageOffset } from './mesh.js';

// The tip is the app's accent; the pierceable area is deliberately NOT,
// because the two are painted in the same window and confusing them would
// put the flesh region on the needle.
const TIP_COLOR = 'rgba(255, 46, 147, 0.55)';
const TIP_EDGE = '#FF2E93';
const AREA_COLOR = 'rgba(46, 230, 255, 0.45)';
const AREA_EDGE = '#2EE6FF';
// Deformable is a SUBSET of pierceable and is drawn on top of it, so it
// needs a colour that reads clearly against cyan rather than blending
// into it -- amber, the warm opposite of both the other two.
const DEFORM_COLOR = 'rgba(255, 176, 46, 0.6)';
const DEFORM_EDGE = '#FFB02E';
// Walls. Near-white, and the most opaque of the four: a barrier is not a
// degree of anything, it is solid or it is not.
const BARRIER_COLOR = 'rgba(236, 238, 248, 0.85)';
const BARRIER_EDGE = '#FFFFFF';

const MAX_ZOOM = 64; // css px per scene px -- far past single-pixel work
const MAX_BRUSH = 10; // the biggest square a single touch-point covers
const GRID_MIN_CELL_PX = 12; // draw the texel grid once cells are this big

const els = {};
let session = null;

function cacheElements() {
  for (const id of [
    'pierceWindow', 'pierceWindowTarget', 'pierceWindowStatus', 'pierceWindowDoneBtn',
    'pierceCanvas', 'pierceTargetTipBtn', 'pierceTargetAreaBtn', 'pierceTargetDeformBtn',
    'pierceTargetBarrierBtn', 'pierceToolPaintBtn',
    'pierceToolEraseBtn', 'pierceBrushBtn', 'pierceBrushMenu',
    'piercePiercerOpacity', 'piercePiercerOpacityValue',
    'pierceInteractiveOpacity', 'pierceInteractiveOpacityValue',
  ]) {
    els[id] = document.getElementById(id);
  }
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

// Where a layer currently sits: its own origin plus the carriage its bones
// have given it since bind (zero for unbound layers). Captured once on
// entry -- the main scene cannot change underneath a full-screen window --
// and used for BOTH drawing and touch mapping, so what you see is exactly
// what you hit.
function layerPlacement(part) {
  const transforms = bonesStore.isEmpty ? null : bonesStore.snapshotTransforms();
  const offset = pinCarriageOffset(part, transforms);
  return { x: part.x + offset.x, y: part.y + offset.y };
}

// Opens on whichever layer the user came from, with the other side of the
// relationship shown alongside it. Both are held BY ID: undo and project
// load rebuild every Part from a snapshot, so a cached object would go
// stale and paint into a layer no longer in the scene.
export function openPiercePainter(partId, partnerId) {
  const a = partsStore.parts.find((part) => part.id === partId);
  const b = partsStore.parts.find((part) => part.id === partnerId);
  if (!a || !b) return;

  const piercer = a.isPiercer ? a : b;
  const interactive = a.isInteractive ? a : b;
  if (!piercer || !interactive || piercer.id === interactive.id) return;

  session = {
    piercerId: piercer.id,
    interactiveId: interactive.id,
    get piercer() { return partsStore.parts.find((part) => part.id === this.piercerId); },
    get interactive() { return partsStore.parts.find((part) => part.id === this.interactiveId); },
    piercerAt: layerPlacement(piercer),
    interactiveAt: layerPlacement(interactive),
    piercerCanvas: layerCanvas(piercer),
    interactiveCanvas: layerCanvas(interactive),
    cam: { zoom: 1, panX: 0, panY: 0 },
    // Which region the brush writes into: the piercer's tip, or the
    // interactive layer's pierceable area. Opens on the side the user
    // came from, since that is the one they were just configuring.
    target: a.isPiercer ? 'tip' : 'area',
    tool: 'paint',
    brush: 1,
    brushMenuOpen: false,
    piercerOpacity: 1,
    interactiveOpacity: 1,
    pointers: new Map(),
    pinch: null,
    stroke: null,
  };

  els.piercePiercerOpacity.value = '100';
  els.pierceInteractiveOpacity.value = '100';
  els.piercePiercerOpacityValue.textContent = '100%';
  els.pierceInteractiveOpacityValue.textContent = '100%';
  els.pierceWindow.hidden = false;

  sizeCanvas();
  fitCamera();
  renderTools();
  render();
}

function endSession() {
  els.pierceWindow.hidden = true;
  session = null;
}

// The three masks the brush can write into. Tip lives on the piercer;
// pierceable and deformable BOTH live on the interactive layer, which is
// why the target rather than the layer has to decide which Set is being
// edited -- two of them share a part.
const MASKS = {
  tip: {
    region: (part) => part.pierceRegion,
    write: (id, indices, marked) => partsStore.setPierceRegion(id, indices, marked),
    label: 'tip',
  },
  area: {
    region: (part) => part.pierceRegion,
    write: (id, indices, marked) => partsStore.setPierceRegion(id, indices, marked),
    label: 'pierceable',
  },
  deform: {
    region: (part) => part.pierceDeformRegion,
    write: (id, indices, marked) => partsStore.setPierceDeformRegion(id, indices, marked),
    label: 'deformable',
  },
  barrier: {
    region: (part) => part.pierceBarrierRegion,
    write: (id, indices, marked) => partsStore.setPierceBarrierRegion(id, indices, marked),
    label: 'barrier',
  },
};

function targetMask() {
  return MASKS[session.target] || MASKS.area;
}

// The layer the brush is currently writing into, and the one it is not.
function targetPart() {
  return session.target === 'tip' ? session.piercer : session.interactive;
}

function targetPlacement() {
  return session.target === 'tip' ? session.piercerAt : session.interactiveAt;
}

function sizeCanvas() {
  const canvas = els.pierceCanvas;
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
  const { piercer, interactive, piercerAt, interactiveAt, cam } = session;
  const x0 = Math.min(piercerAt.x, interactiveAt.x);
  const y0 = Math.min(piercerAt.y, interactiveAt.y);
  const x1 = Math.max(piercerAt.x + piercer.sceneWidth, interactiveAt.x + interactive.sceneWidth);
  const y1 = Math.max(piercerAt.y + piercer.sceneHeight, interactiveAt.y + interactive.sceneHeight);
  const spanX = Math.max(1, x1 - x0);
  const spanY = Math.max(1, y1 - y0);
  const zoom = Math.min(session.cssWidth / spanX, session.cssHeight / spanY) * 0.9;
  cam.zoom = Math.min(MAX_ZOOM, zoom);
  session.minZoom = cam.zoom * 0.5;
  cam.panX = (session.cssWidth - spanX * cam.zoom) / 2 - x0 * cam.zoom;
  cam.panY = (session.cssHeight - spanY * cam.zoom) / 2 - y0 * cam.zoom;
}

// ---------------------------------------------------------------------------
// Rendering

function drawLayer(ctx, canvas, at, part, opacity) {
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

// A layer's painted region, drawn as filled texel blocks. Both regions are
// always shown -- the tip and the flesh only make sense in relation to
// each other, so hiding the one you are not painting would be hiding the
// thing you are aiming at.
function drawRegion(ctx, part, at, fill, edge, region = part.pierceRegion) {
  const { cam } = session;
  const size = part.scale * cam.zoom;
  ctx.fillStyle = fill;
  for (const index of region) {
    const u = index % part.naturalWidth;
    const v = Math.floor(index / part.naturalWidth);
    const x = (at.x + u * part.scale) * cam.zoom + cam.panX;
    const y = (at.y + v * part.scale) * cam.zoom + cam.panY;
    if (x + size < 0 || y + size < 0 || x > session.cssWidth || y > session.cssHeight) continue;
    ctx.fillRect(x, y, size, size);
    if (size >= 6) {
      ctx.strokeStyle = edge;
      ctx.lineWidth = Math.min(2, Math.max(1, size / 10));
      ctx.strokeRect(x + 0.5, y + 0.5, size - 1, size - 1);
    }
  }
}

function render() {
  if (!session) return;
  const canvas = els.pierceCanvas;
  const ctx = canvas.getContext('2d');
  const { cam, piercer, interactive, piercerAt, interactiveAt } = session;
  if (!piercer || !interactive) { endSession(); return; } // a layer went away under us

  ctx.setTransform(session.dpr, 0, 0, session.dpr, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = '#101014';
  ctx.fillRect(0, 0, session.cssWidth, session.cssHeight);

  drawLayer(ctx, session.interactiveCanvas, interactiveAt, interactive, session.interactiveOpacity);
  drawLayer(ctx, session.piercerCanvas, piercerAt, piercer, session.piercerOpacity);

  // The texel grid of the layer being painted, once its cells are big
  // enough to aim at.
  const part = targetPart();
  const at = targetPlacement();
  const cell = part.scale * cam.zoom;
  if (cell >= GRID_MIN_CELL_PX) {
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let u = 0; u <= part.naturalWidth; u++) {
      const x = (at.x + u * part.scale) * cam.zoom + cam.panX;
      ctx.moveTo(x, at.y * cam.zoom + cam.panY);
      ctx.lineTo(x, (at.y + part.sceneHeight) * cam.zoom + cam.panY);
    }
    for (let v = 0; v <= part.naturalHeight; v++) {
      const y = (at.y + v * part.scale) * cam.zoom + cam.panY;
      ctx.moveTo(at.x * cam.zoom + cam.panX, y);
      ctx.lineTo((at.x + part.sceneWidth) * cam.zoom + cam.panX, y);
    }
    ctx.stroke();
  }

  drawRegion(ctx, interactive, interactiveAt, AREA_COLOR, AREA_EDGE);
  // On top of the pierceable area, because it is a part of it.
  drawRegion(ctx, interactive, interactiveAt, DEFORM_COLOR, DEFORM_EDGE, interactive.pierceDeformRegion);
  // Walls last of the three: they are what the tip is stopped by, so they
  // belong on top of whatever they are bounding.
  drawRegion(ctx, interactive, interactiveAt, BARRIER_COLOR, BARRIER_EDGE, interactive.pierceBarrierRegion);
  drawRegion(ctx, piercer, piercerAt, TIP_COLOR, TIP_EDGE);

  els.pierceWindowTarget.textContent = session.target === 'tip'
    ? `${piercer.name} · tip`
    : `${interactive.name} · ${targetMask().label}`;
  const deform = interactive.pierceDeformRegion.size;
  els.pierceWindowStatus.textContent =
    `tip ${piercer.pierceRegion.size} px · flesh ${interactive.pierceRegion.size} px · ` +
    `soft ${deform || 'all'} · wall ${interactive.pierceBarrierRegion.size} · ` +
    `${Math.round(cam.zoom * 100)}%`;
}

function renderTools() {
  els.pierceTargetTipBtn.setAttribute('aria-pressed', String(session.target === 'tip'));
  els.pierceTargetAreaBtn.setAttribute('aria-pressed', String(session.target === 'area'));
  els.pierceTargetDeformBtn.setAttribute('aria-pressed', String(session.target === 'deform'));
  els.pierceTargetBarrierBtn.setAttribute('aria-pressed', String(session.target === 'barrier'));
  els.pierceToolPaintBtn.setAttribute('aria-pressed', String(session.tool === 'paint'));
  els.pierceToolEraseBtn.setAttribute('aria-pressed', String(session.tool === 'erase'));
  els.pierceBrushBtn.textContent = `${session.brush} × ${session.brush} ⌄`;
  els.pierceBrushBtn.setAttribute('aria-expanded', String(session.brushMenuOpen));
  els.pierceBrushMenu.hidden = !session.brushMenuOpen;

  els.pierceBrushMenu.replaceChildren();
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
    els.pierceBrushMenu.appendChild(button);
  }
}

// ---------------------------------------------------------------------------
// Input
//
// ONE FINGER PAINTS, TWO FINGERS MOVE THE VIEW -- the same model Px Pin
// uses, down to a second finger arriving mid-stroke meaning the user
// meant to pinch all along, so the stroke is rolled back rather than left
// behind as a stray mark. A whole stroke is one undo step.

function canvasPoint(event) {
  const rect = els.pierceCanvas.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

// The painted layer's texel under a point in the window.
function texelAt(point) {
  const part = targetPart();
  const at = targetPlacement();
  const { cam } = session;
  return {
    u: Math.floor(((point.x - cam.panX) / cam.zoom - at.x) / part.scale),
    v: Math.floor(((point.y - cam.panY) / cam.zoom - at.y) / part.scale),
  };
}

// The brush's square of texel indices, centred on (u, v).
function brushIndices(u, v) {
  const part = targetPart();
  const size = session.brush;
  const origin = Math.floor((size - 1) / 2);
  const indices = [];
  for (let dv = 0; dv < size; dv++) {
    for (let du = 0; du < size; du++) {
      const index = part.texelIndex(u - origin + du, v - origin + dv);
      if (index >= 0) indices.push(index);
    }
  }
  return indices;
}

// One setPierceRegion call for a whole run of texels, never one per pixel:
// the store redraws the scene whenever it changes something, and a wide
// brush swept across a layer touches thousands of them.
function stamp(texels) {
  const part = targetPart();
  const mask = targetMask();
  const region = mask.region(part);
  const { stroke } = session;
  const painting = session.tool === 'paint';
  const indices = new Set();
  for (const { u, v } of texels) {
    for (const index of brushIndices(u, v)) {
      if (painting ? !region.has(index) : region.has(index)) indices.add(index);
    }
  }
  if (indices.size === 0) return;

  for (const index of indices) if (!stroke.touched.has(index)) stroke.touched.set(index, !painting);
  mask.write(part.id, [...indices], painting);
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
    token: history.capture(session.tool === 'paint'
      ? `Paint ${targetMask().label} region`
      : `Erase ${targetMask().label} region`),
    partId: targetPart().id,
    // Which mask this stroke wrote into, so abandoning it puts the texels
    // back where they came from. Two of the three masks live on the same
    // layer, so the part id alone does not say.
    target: session.target,
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
// its history entry, so a two-finger gesture never leaves a stray mark.
function abandonStroke() {
  const stroke = session.stroke;
  session.stroke = null;
  if (!stroke) return;
  const wasOn = [];
  const wasOff = [];
  for (const [index, wasMarked] of stroke.touched) (wasMarked ? wasOn : wasOff).push(index);
  const write = (MASKS[stroke.target] || MASKS.area).write;
  if (wasOn.length) write(stroke.partId, wasOn, true);
  if (wasOff.length) write(stroke.partId, wasOff, false);
  history.commitCapture(stroke.token, false);
  render();
}

function onPointerDown(event) {
  if (!session) return;
  event.preventDefault();
  // Capture keeps a stroke delivering when the finger leaves the canvas; a
  // synthetic event (tests) has no active pointer to capture, which is
  // fine -- the gesture logic below works either way.
  try { els.pierceCanvas.setPointerCapture(event.pointerId); } catch { /* no-op */ }
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
export function pierceToolDebug() {
  if (!session) return null;
  return {
    zoom: session.cam.zoom,
    panX: session.cam.panX,
    panY: session.cam.panY,
    piercerAt: { ...session.piercerAt },
    interactiveAt: { ...session.interactiveAt },
    target: session.target,
    tool: session.tool,
    brush: session.brush,
    brushMenuOpen: session.brushMenuOpen,
  };
}

// ---------------------------------------------------------------------------
// Wiring

export function initPierceTool() {
  cacheElements();

  els.pierceWindowDoneBtn.addEventListener('click', endSession);
  els.pierceTargetTipBtn.addEventListener('click', () => {
    if (!session) return;
    session.target = 'tip';
    renderTools();
    render();
  });
  els.pierceTargetAreaBtn.addEventListener('click', () => {
    if (!session) return;
    session.target = 'area';
    renderTools();
    render();
  });
  els.pierceTargetDeformBtn.addEventListener('click', () => {
    if (!session) return;
    session.target = 'deform';
    renderTools();
    render();
  });
  els.pierceTargetBarrierBtn.addEventListener('click', () => {
    if (!session) return;
    session.target = 'barrier';
    renderTools();
    render();
  });
  els.pierceToolPaintBtn.addEventListener('click', () => {
    if (session) { session.tool = 'paint'; renderTools(); }
  });
  els.pierceToolEraseBtn.addEventListener('click', () => {
    if (session) { session.tool = 'erase'; renderTools(); }
  });
  els.pierceBrushBtn.addEventListener('click', () => {
    if (!session) return;
    session.brushMenuOpen = !session.brushMenuOpen;
    renderTools();
  });

  els.piercePiercerOpacity.addEventListener('input', () => {
    if (!session) return;
    session.piercerOpacity = Number(els.piercePiercerOpacity.value) / 100;
    els.piercePiercerOpacityValue.textContent = `${els.piercePiercerOpacity.value}%`;
    render();
  });
  els.pierceInteractiveOpacity.addEventListener('input', () => {
    if (!session) return;
    session.interactiveOpacity = Number(els.pierceInteractiveOpacity.value) / 100;
    els.pierceInteractiveOpacityValue.textContent = `${els.pierceInteractiveOpacity.value}%`;
    render();
  });

  els.pierceCanvas.addEventListener('pointerdown', onPointerDown);
  els.pierceCanvas.addEventListener('pointermove', onPointerMove);
  els.pierceCanvas.addEventListener('pointerup', onPointerUp);
  els.pierceCanvas.addEventListener('pointercancel', onPointerUp);

  window.addEventListener('resize', () => {
    if (!session) return;
    sizeCanvas();
    render();
  });
}
