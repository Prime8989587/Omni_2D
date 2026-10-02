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
// artwork".
//
// WHERE THE LAYERS ARE DRAWN: EXACTLY WHERE THE SCENE DRAWS THEM
//
// Both layers are drawn through the very triangles the main canvas draws
// them through (canvas.js's layerDrawGeometry) -- their bones, springs,
// pins, and any PxLink that holds them in place -- so this window shows the
// two exactly as the scene does, and a tap is mapped back to the texel
// under the finger through those same triangles. It used to draw each
// layer flat at its own origin plus its bones' carriage, which is not
// where a layer the links had put in place is drawn: the reference layer
// and the one being pinned could sit a whole feature apart here while
// meeting perfectly in the scene.
//
// One finger paints, two fingers move the view. Pressing down starts a
// stroke and every texel the finger crosses is pinned (or erased) as it
// goes -- pinning a collar by tapping each pixel was the wrong amount of
// work. That leaves the camera to two fingers, which is where pinch
// already lived, so navigation still needs no mode switch. A second finger
// arriving mid-stroke means the user meant to pinch all along and simply
// landed one finger first, so the stroke is UNDONE rather than left behind
// as a stray pin. A whole stroke is one undo step.

import { cellEdge, gridStrips } from './pixelDraw.js';
import { partsStore } from './parts.js';
import { bonesStore } from './bones.js';
import { history } from './history.js';
import { layerDrawGeometry } from './canvas.js';
import { rasterizeTriangle } from './raster.js';
import { texelNearest } from './artwork.js';
import { locateTexel, landTexel } from './pxlinkState.js';
import { getSetting } from './settings.js';
import { haptic } from './haptics.js';
import { renderBrushPresets, SQUARE_FORMAT, renderBrushButton } from './brushpresets.js';
import { fitBackingStore, watchCanvasBox, snapCamera, pinchMidpoint, keepCentred } from './pixelCanvas.js';
import { noteToolUsed } from './recentTools.js';
import { showToast } from './toast.js';

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
    'pxpinToolEraseBtn', 'pxpinBrushBtn', 'pxpinBrushMenu', 'pxpinBrushPresets', 'pxpinAboveOpacity',
    'pxpinBelowOpacity', 'pxpinAboveOpacityValue', 'pxpinBelowOpacityValue',
  ]) {
    els[id] = document.getElementById(id);
  }
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

// Straight back into a session on the same two layers (Recent tools), or
// the picker if either has gone.
export function openPxPinWith({ aboveId, belowId } = {}) {
  const ok = [aboveId, belowId].every((id) => partsStore.parts.some((part) => part.id === id));
  if (!ok || aboveId === belowId) { openPxPinPicker(); return; }
  fillSelect(els.pxpinAboveSelect, aboveId);
  fillSelect(els.pxpinBelowSelect, belowId);
  startSession();
}

function closePicker() {
  els.pxpinPickerModal.hidden = true;
}

// ---------------------------------------------------------------------------
// Session

// A layer exactly as the scene draws it right now, captured once on entry --
// the main scene cannot change underneath a full-screen window -- and used
// for BOTH drawing and tap mapping, so what you see is exactly what you hit.
//
// Its drawn triangles are rasterised, by the scene's own rasterizer, into a
// bitmap covering their bounds; drawImage with smoothing off then scales it
// losslessly at any zoom. The texel corners' drawn positions are worked out
// once too, so pins -- possibly thousands -- are drawn without a search each.
function captureLayer(part) {
  const transforms = bonesStore.isEmpty ? null : bonesStore.snapshotTransforms();
  const { positions, uvs, triangles } = layerDrawGeometry(part, transforms);
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  for (const p of positions) {
    x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
  }
  x0 = Math.floor(x0); y0 = Math.floor(y0);
  const width = Math.max(1, Math.ceil(x1) - x0);
  const height = Math.max(1, Math.ceil(y1) - y0);
  const buffer = new Uint8ClampedArray(width * height * 4);
  const local = positions.map((p) => ({ x: p.x - x0, y: p.y - y0 }));
  for (let t = 0; t < triangles.length; t += 3) {
    const a = triangles[t]; const b = triangles[t + 1]; const c = triangles[t + 2];
    rasterizeTriangle(buffer, width, height, part.pixels, part.naturalWidth, part.naturalHeight,
      local[a], local[b], local[c], uvs[a], uvs[b], uvs[c]);
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  const image = context.createImageData(width, height);
  image.data.set(buffer);
  context.putImageData(image, 0, 0);
  return {
    canvas, x0, y0, width, height, positions, uvs, triangles,
    corners: cornerPositions(part, positions, uvs, triangles),
  };
}

// Where every texel CORNER of a layer is drawn: a grid of (W+1) x (H+1)
// scene points, NaN where the layer has no triangle (trimmed-away margin).
function cornerPositions(part, positions, uvs, triangles) {
  const W = part.naturalWidth;
  const H = part.naturalHeight;
  const out = new Float64Array((W + 1) * (H + 1) * 2).fill(NaN);
  for (let t = 0; t < triangles.length; t += 3) {
    const ia = triangles[t]; const ib = triangles[t + 1]; const ic = triangles[t + 2];
    const A = uvs[ia]; const B = uvs[ib]; const C = uvs[ic];
    const den = (B.v - C.v) * (A.u - C.u) + (C.u - B.u) * (A.v - C.v);
    if (Math.abs(den) < 1e-12) continue;
    const u0 = Math.max(0, Math.floor(Math.min(A.u, B.u, C.u)));
    const u1 = Math.min(W, Math.ceil(Math.max(A.u, B.u, C.u)));
    const v0 = Math.max(0, Math.floor(Math.min(A.v, B.v, C.v)));
    const v1 = Math.min(H, Math.ceil(Math.max(A.v, B.v, C.v)));
    for (let v = v0; v <= v1; v++) {
      for (let u = u0; u <= u1; u++) {
        const i = (v * (W + 1) + u) * 2;
        if (!Number.isNaN(out[i])) continue;
        const l0 = ((B.v - C.v) * (u - C.u) + (C.u - B.u) * (v - C.v)) / den;
        const l1 = ((C.v - A.v) * (u - C.u) + (A.u - C.u) * (v - C.v)) / den;
        const l2 = 1 - l0 - l1;
        if (l0 < -1e-9 || l1 < -1e-9 || l2 < -1e-9) continue;
        const pa = positions[ia]; const pb = positions[ib]; const pc = positions[ic];
        out[i] = l0 * pa.x + l1 * pb.x + l2 * pc.x;
        out[i + 1] = l0 * pa.y + l1 * pb.y + l2 * pc.y;
      }
    }
  }
  return out;
}

function cornerAt(part, layer, u, v) {
  const i = (v * (part.naturalWidth + 1) + u) * 2;
  const x = layer.corners[i];
  return Number.isNaN(x) ? null : { x, y: layer.corners[i + 1] };
}

// A texel point (not just a corner) to where the scene draws it.
function drawnPoint(layer, u, v) {
  const located = locateTexel(layer.uvs, layer.triangles, u, v);
  return located ? landTexel(layer.positions, located) : null;
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
  noteToolUsed('pxpin', { aboveId: above.id, belowId: below.id });

  // The two layers are held BY ID, not by reference: undo and project load
  // rebuild every Part from a snapshot, so a cached object would quietly go
  // stale and read pins that are no longer in the scene.
  session = {
    aboveId: above.id,
    belowId: below.id,
    get above() { return partsStore.parts.find((part) => part.id === this.aboveId); },
    get below() { return partsStore.parts.find((part) => part.id === this.belowId); },
    aboveLayer: captureLayer(above),
    belowLayer: captureLayer(below),
    cam: { zoom: 1, panX: 0, panY: 0 },
    tool: 'pin',
    // The Rig section's remembered default, rather than a hardcoded 1, so
    // an artist who works at 4x4 does not reset the brush every session.
    brush: getSetting('pxPinBrush'),
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

// The backing store follows the canvas's own box -- see pixelCanvas.js.
function sizeCanvas() {
  const box = fitBackingStore(els.pxpinCanvas);
  if (!box) return;
  session.cssWidth = box.width;
  session.cssHeight = box.height;
  session.dpr = box.dpr;
}

// Fit both layers on screen with a margin; that zoom is also the floor,
// so the user can always come back out to the overview.
function fitCamera() {
  if (!session.cssWidth || !session.cssHeight) return;
  const { aboveLayer: a, belowLayer: b, cam } = session;
  const x0 = Math.min(a.x0, b.x0);
  const y0 = Math.min(a.y0, b.y0);
  const x1 = Math.max(a.x0 + a.width, b.x0 + b.width);
  const y1 = Math.max(a.y0 + a.height, b.y0 + b.height);
  const spanX = Math.max(1, x1 - x0);
  const spanY = Math.max(1, y1 - y0);
  const zoom = Math.min(session.cssWidth / spanX, session.cssHeight / spanY) * 0.9;
  cam.zoom = Math.min(MAX_ZOOM, zoom);
  session.minZoom = Math.min(cam.zoom, zoom) * 0.5;
  cam.panX = (session.cssWidth - spanX * cam.zoom) / 2 - x0 * cam.zoom;
  cam.panY = (session.cssHeight - spanY * cam.zoom) / 2 - y0 * cam.zoom;
  // Whole device pixels per texel, so every texel draws the same size.
  snapCamera(cam, session.dpr, session.cssWidth / 2, session.cssHeight / 2, { maxZoom: MAX_ZOOM });
}

// ---------------------------------------------------------------------------
// Rendering

function drawLayer(ctx, layer, opacity) {
  if (opacity <= 0) return;
  const { cam } = session;
  ctx.globalAlpha = opacity;
  ctx.drawImage(
    layer.canvas,
    layer.x0 * cam.zoom + cam.panX,
    layer.y0 * cam.zoom + cam.panY,
    layer.width * cam.zoom,
    layer.height * cam.zoom
  );
  ctx.globalAlpha = 1;
}

// The texel grid can be drawn as straight strips only where the layer is
// drawn square-on: its texel (0, 0), (W, 0) and (0, H) corners exactly
// where an unturned, unbent sprite would put them.
function squareOn(part, layer) {
  const o = cornerAt(part, layer, 0, 0);
  const r = cornerAt(part, layer, part.naturalWidth, 0);
  const d = cornerAt(part, layer, 0, part.naturalHeight);
  if (!o || !r || !d) return null;
  const s = part.scale;
  const ok = Math.abs(r.x - o.x - part.naturalWidth * s) < 1e-6 && Math.abs(r.y - o.y) < 1e-6
    && Math.abs(d.y - o.y - part.naturalHeight * s) < 1e-6 && Math.abs(d.x - o.x) < 1e-6;
  return ok ? o : null;
}

function render() {
  if (!session) return;
  const canvas = els.pxpinCanvas;
  const ctx = canvas.getContext('2d');
  const { cam, above, below, aboveLayer } = session;
  if (!above || !below) { endSession(); return; } // a layer went away under us

  ctx.setTransform(session.dpr, 0, 0, session.dpr, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = '#101014';
  ctx.fillRect(0, 0, session.cssWidth, session.cssHeight);

  drawLayer(ctx, session.belowLayer, session.belowOpacity);
  drawLayer(ctx, aboveLayer, session.aboveOpacity);

  // Texel grid over the ABOVE layer once cells are big enough to aim at --
  // where it is drawn square-on, which is the usual case.
  const cell = above.scale * cam.zoom;
  const origin = squareOn(above, aboveLayer);
  if (cell >= GRID_MIN_CELL_PX && origin) {
    gridStrips(ctx, origin.x * cam.zoom + cam.panX, origin.y * cam.zoom + cam.panY,
      above.naturalWidth, above.naturalHeight, cell, 'rgba(255, 255, 255, 0.12)', session.dpr);
  }

  // Pinned pixels: solid pink corner marks + translucent fill, so the pin
  // reads clearly without completely hiding the artwork under it -- each on
  // its texel's four corners as drawn.
  const toScreen = (p) => ({ x: p.x * cam.zoom + cam.panX, y: p.y * cam.zoom + cam.panY });
  for (const index of above.pins) {
    const u = index % above.naturalWidth;
    const v = Math.floor(index / above.naturalWidth);
    const c = [[u, v], [u + 1, v], [u + 1, v + 1], [u, v + 1]].map(([cu, cv]) => cornerAt(above, aboveLayer, cu, cv));
    if (c.some((p) => !p)) continue;
    const s = c.map(toScreen);
    const left = Math.min(...s.map((p) => p.x)); const right = Math.max(...s.map((p) => p.x));
    const top = Math.min(...s.map((p) => p.y)); const bottom = Math.max(...s.map((p) => p.y));
    // Skip the ones off-screen: a wide brush can leave thousands of pins,
    // and at the zoom that makes single pixels aimable most are outside.
    if (right < 0 || bottom < 0 || left > session.cssWidth || top > session.cssHeight) continue;
    ctx.fillStyle = 'rgba(255, 46, 147, 0.45)';
    const square = Math.abs(s[1].y - s[0].y) < 1e-6 && Math.abs(s[3].x - s[0].x) < 1e-6;
    if (square) {
      const size = right - left;
      ctx.fillRect(left, top, size, bottom - top);
      if (size >= 6) cellEdge(ctx, left, top, size, Math.min(2, Math.max(1, size / 10)), ACCENT, session.dpr);
    } else {
      ctx.beginPath();
      ctx.moveTo(s[0].x, s[0].y);
      for (let k = 1; k < 4; k++) ctx.lineTo(s[k].x, s[k].y);
      ctx.closePath();
      ctx.fill();
    }
  }

  els.pxpinStatus.textContent =
    `${above.pins.size} pinned · ${Math.round(cam.zoom * 100)}%`;
}

function renderTools() {
  els.pxpinToolPinBtn.setAttribute('aria-pressed', String(session.tool === 'pin'));
  els.pxpinToolEraseBtn.setAttribute('aria-pressed', String(session.tool === 'erase'));
  renderBrushButton(els.pxpinBrushBtn, session.brush);
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

  renderBrushPresets(els.pxpinBrushPresets, {
    key: 'pxPinBrushPresets',
    current: () => session.brush,
    apply: (size) => { session.brush = size; session.brushMenuOpen = false; renderTools(); },
    format: SQUARE_FORMAT,
  });
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

// The ABOVE layer's texel under a point in the window: through the very
// triangles it is drawn with, so the texel picked is the one drawn under the
// finger. Off the layer it is carried on from the nearest triangle, so a
// brush overhanging the edge still reaches the texels it covers.
function texelAt(point) {
  const { aboveLayer, cam } = session;
  const scene = { x: (point.x - cam.panX) / cam.zoom, y: (point.y - cam.panY) / cam.zoom };
  const t = texelNearest(aboveLayer.uvs, aboveLayer.positions, aboveLayer.triangles, scene);
  return t ? { u: Math.floor(t.u), v: Math.floor(t.v) } : { u: -1, v: -1 };
}

// The brush's square of texel indices, centred on (u, v) -- only the ones
// that are artwork. A brush overhanging the edge of the layer pins the
// part of it that is on the layer and nothing past it (artwork.js), so a
// stroke run off the silhouette, or begun outside it, registers nothing
// there.
function brushIndices(u, v) {
  const size = session.brush;
  const origin = Math.floor((size - 1) / 2);
  const indices = [];
  for (let dv = 0; dv < size; dv++) {
    for (let du = 0; du < size; du++) {
      const index = session.above.texelIndex(u - origin + du, v - origin + dv);
      if (index >= 0 && session.above.isOpaqueIndex(index)) indices.push(index);
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
  // Confirmation that the pin landed on the texel that was aimed at. The
  // eye is on the artwork here, not on a counter, and haptics.js throttles
  // this so a stroke across many texels ticks rather than buzzing.
  haptic(pinning ? 'pin' : 'snap');
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
  // Where the pinch was as it ends: the point it settles onto the pixel grid about.
  const settleAt = session.pinch ? pinchMidpoint(session.pointers) : null;
  session.pointers.delete(event.pointerId);
  if (session.pointers.size < 2) {
    if (settleAt) {
      snapCamera(session.cam, session.dpr, settleAt.x, settleAt.y, { maxZoom: MAX_ZOOM });
      render();
    }
    session.pinch = null;
  }
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
    // Where each layer's texel (0, 0) is drawn -- with drawnTexel, where any
    // texel point is drawn, in scene px. The same mapping the window draws
    // and maps taps with.
    aboveAt: drawnPoint(session.aboveLayer, 0, 0),
    belowAt: drawnPoint(session.belowLayer, 0, 0),
    drawnTexel: (u, v) => drawnPoint(session.aboveLayer, u, v),
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

  watchCanvasBox(els.pxpinCanvas, () => {
    if (!session) return;
    const unmeasured = !session.cssWidth;
    const before = { width: session.cssWidth, height: session.cssHeight };
    sizeCanvas();
    if (unmeasured) fitCamera();
    else keepCentred(session.cam, before, { width: session.cssWidth, height: session.cssHeight }, session.dpr);
    render();
  });
}
