// Pierce region painting: which pixels are the tip, and which are flesh.
//
// A dedicated full-screen window, deliberately built on the same pattern
// as Px Pin's: both layers of the relationship drawn together at their
// REAL relative positions, an opacity slider for each, and a private
// camera. What is painted here is two sets of texels --
//
//   on the PIERCER      the tip: the pixels that actually do the piercing
//   on the PIERCED      the pierceable area: the pixels a tip may push into
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
import { pierceDentIssue } from './pierce.js';
import { dentPlacement, dentTriangleAt } from './dent.js';

// The tip is the app's accent; the pierceable area is deliberately NOT,
// because the two are painted in the same window and confusing them would
// put the flesh region on the needle.
const TIP_COLOR = 'rgba(255, 46, 147, 0.55)';
const TIP_EDGE = '#FF2E93';
const AREA_COLOR = 'rgba(46, 230, 255, 0.45)';
const AREA_EDGE = '#2EE6FF';
// Deformable is a SUBSET of pierceable and is drawn on top of it, so it
// needs a colour that reads clearly against cyan rather than blending
// into it -- amber, the warm opposite of both the other two. It marks the
// material that BUNCHES around a dent, so amber reading as "this is the
// part that moves" is exactly right.
const DEFORM_COLOR = 'rgba(255, 176, 46, 0.6)';
const DEFORM_EDGE = '#FFB02E';
// Walls. Near-white, and the most opaque of the four: a barrier is not a
// degree of anything, it is solid or it is not.
const BARRIER_COLOR = 'rgba(236, 238, 248, 0.85)';
const BARRIER_EDGE = '#FFFFFF';
// The dent, drawn as the shape it will cut rather than as painted texels --
// because it is not painted, it is placed. Violet: the one hue not already
// spoken for by a mask, so the wedge never reads as a fifth region.
const DENT_FILL = 'rgba(160, 120, 255, 0.35)';
const DENT_EDGE = '#A078FF';

// How near a handle a touch counts as grabbing it, in css px. Generous:
// this is a fingertip on a phone, and the three handles are deliberately
// never closer together than a dent's own size.
const HANDLE_GRAB_PX = 30;
const HANDLE_RADIUS = 9;

const MAX_ZOOM = 64; // css px per scene px -- far past single-pixel work
const MAX_BRUSH = 10; // the biggest square a single touch-point covers
const GRID_MIN_CELL_PX = 12; // draw the texel grid once cells are this big

const els = {};
let session = null;

function cacheElements() {
  for (const id of [
    'pierceWindow', 'pierceWindowTarget', 'pierceWindowStatus', 'pierceWindowDoneBtn',
    'pierceCanvas', 'pierceTargetTipBtn', 'pierceTargetAreaBtn', 'pierceTargetDeformBtn',
    'pierceTargetBarrierBtn', 'pierceTargetDentBtn', 'pierceTargetHint', 'pierceToolPaintBtn',
    'pierceToolEraseBtn', 'pierceToolRow', 'pierceBrushBtn', 'pierceBrushMenu',
    'piercePiercerOpacity', 'piercePiercerOpacityValue',
    'piercePiercedOpacity', 'piercePiercedOpacityValue',
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
  const pierced = a.isPierced ? a : b;
  if (!piercer || !pierced || piercer.id === pierced.id) return;

  session = {
    piercerId: piercer.id,
    piercedId: pierced.id,
    get piercer() { return partsStore.parts.find((part) => part.id === this.piercerId); },
    get pierced() { return partsStore.parts.find((part) => part.id === this.piercedId); },
    piercerAt: layerPlacement(piercer),
    piercedAt: layerPlacement(pierced),
    piercerCanvas: layerCanvas(piercer),
    piercedCanvas: layerCanvas(pierced),
    cam: { zoom: 1, panX: 0, panY: 0 },
    // Which region the brush writes into: the piercer's tip, or the
    // pierced layer's pierceable area. Opens on the side the user
    // came from, since that is the one they were just configuring.
    target: a.isPiercer ? 'tip' : 'area',
    tool: 'paint',
    brush: 1,
    brushMenuOpen: false,
    piercerOpacity: 1,
    piercedOpacity: 1,
    pointers: new Map(),
    pinch: null,
    stroke: null,
    // Which dent handle is under the finger, on the dent target only.
    dentDrag: null,
  };

  els.piercePiercerOpacity.value = '100';
  els.piercePiercedOpacity.value = '100';
  els.piercePiercerOpacityValue.textContent = '100%';
  els.piercePiercedOpacityValue.textContent = '100%';
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

// The masks the brush can write into. Tip lives on the piercer;
// pierceable, deformable and barrier all live on the pierced layer, which
// is why the target rather than the layer has to decide which Set is being
// edited -- several of them share a part.
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
  return session.target === 'tip' ? session.piercer : session.pierced;
}

function targetPlacement() {
  return session.target === 'tip' ? session.piercerAt : session.piercedAt;
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
  const { piercer, pierced, piercerAt, piercedAt, cam } = session;
  const x0 = Math.min(piercerAt.x, piercedAt.x);
  const y0 = Math.min(piercerAt.y, piercedAt.y);
  const x1 = Math.max(piercerAt.x + piercer.sceneWidth, piercedAt.x + pierced.sceneWidth);
  const y1 = Math.max(piercerAt.y + piercer.sceneHeight, piercedAt.y + pierced.sceneHeight);
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

// ---------------------------------------------------------------------------
// The dent, placed by hand
//
// The other four targets paint texels. This one does not paint anything: it
// puts the wedge itself on the artwork and lets the artist drag it, which is
// the only way to answer "where should this dent happen" by looking at the
// drawing rather than by typing coordinates at it.
//
// Three handles, because a triangle pinned to a surface has exactly three
// degrees of freedom worth exposing:
//
//   BASE   where on the artwork the notch opens     -- moves the whole wedge
//   APEX   how deep it goes, and which way it faces -- depth and direction
//   WIDTH  how wide its mouth is                    -- width alone
//
// The sliders in the Pierce window show the same two numbers and write the
// same fields; neither is the source of truth, the Part is.

// A point in the pierced layer's texels, in window coordinates.
function texelToWindow(part, at, x, y) {
  const { cam } = session;
  return {
    x: (at.x + x * part.scale) * cam.zoom + cam.panX,
    y: (at.y + y * part.scale) * cam.zoom + cam.panY,
  };
}

function windowToTexel(part, at, point) {
  const { cam } = session;
  return {
    x: ((point.x - cam.panX) / cam.zoom - at.x) / part.scale,
    y: ((point.y - cam.panY) / cam.zoom - at.y) / part.scale,
  };
}

// Where the three handles are, in texel space. Always drawn at FULL size --
// the artist is configuring the dent the layer takes at the End Point, not
// whatever fraction of it some live contact happens to be at.
function dentHandles(part) {
  const place = dentPlacement(part);
  const inward = { x: Math.cos(place.angle), y: Math.sin(place.angle) };
  const across = { x: -inward.y, y: inward.x };
  const depth = part.pierceDentDepth;
  const half = part.pierceDentWidth / 2;
  return {
    place,
    inward,
    across,
    base: { x: place.x, y: place.y },
    apex: { x: place.x + inward.x * depth, y: place.y + inward.y * depth },
    width: { x: place.x + across.x * half, y: place.y + across.y * half },
  };
}

function drawDent(ctx, part, at) {
  const handles = dentHandles(part);
  const tri = dentTriangleAt(part, 1);
  const point = (p) => texelToWindow(part, at, p.x, p.y);

  if (tri) {
    const b1 = point(tri.b1);
    const b2 = point(tri.b2);
    const apex = point(tri.apex);
    ctx.beginPath();
    ctx.moveTo(b1.x, b1.y);
    ctx.lineTo(b2.x, b2.y);
    ctx.lineTo(apex.x, apex.y);
    ctx.closePath();
    ctx.fillStyle = DENT_FILL;
    ctx.fill();
    ctx.strokeStyle = DENT_EDGE;
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  // A stem from base to apex, so the direction is legible even when the
  // wedge is too narrow to read as a triangle.
  const base = point(handles.base);
  const apex = point(handles.apex);
  ctx.strokeStyle = DENT_EDGE;
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(base.x, base.y);
  ctx.lineTo(apex.x, apex.y);
  ctx.stroke();
  ctx.setLineDash([]);

  const grip = (p, label, fill) => {
    ctx.beginPath();
    ctx.arc(p.x, p.y, HANDLE_RADIUS, 0, Math.PI * 2);
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = '#FFFFFF';
    ctx.font = '12px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(label, p.x, p.y - HANDLE_RADIUS - 5);
  };
  grip(base, 'base', '#A078FF');
  grip(apex, `depth ${part.pierceDentDepth}`, '#FFB02E');
  grip(point(handles.width), `width ${part.pierceDentWidth}`, '#2EE6FF');
}

// Which handle a touch is going for, or null for none. Base is tested last
// so that a dent collapsed to nothing -- every handle stacked on one spot --
// still gives up its apex and width rather than only ever moving as a whole.
function grabDentHandle(point) {
  const part = session.pierced;
  const at = session.piercedAt;
  const handles = dentHandles(part);
  const near = (p) => {
    const w = texelToWindow(part, at, p.x, p.y);
    return Math.hypot(point.x - w.x, point.y - w.y);
  };
  const candidates = [
    ['apex', near(handles.apex)],
    ['width', near(handles.width)],
    ['base', near(handles.base)],
  ];
  let best = null;
  for (const [which, distance] of candidates) {
    if (distance > HANDLE_GRAB_PX) continue;
    if (!best || distance < best[1]) best = [which, distance];
  }
  return best ? best[0] : null;
}

function dragDentHandle(which, point) {
  const part = session.pierced;
  const target = windowToTexel(part, session.piercedAt, point);
  const handles = dentHandles(part);
  const place = handles.place;

  if (which === 'base') {
    partsStore.setPierceDentPlacement(part.id, target.x, target.y, place.angle);
  } else if (which === 'apex') {
    // The apex sets the direction AND the depth: dragging it around the
    // base swings the wedge, dragging it away from the base deepens it.
    const dx = target.x - place.x;
    const dy = target.y - place.y;
    const depth = Math.hypot(dx, dy);
    // Too close to the base to read an angle from: keep the one it has
    // rather than letting the wedge spin under a fingertip.
    const angle = depth < 0.5 ? place.angle : Math.atan2(dy, dx);
    partsStore.setPierceDentPlacement(part.id, place.x, place.y, angle);
    partsStore.setPierceDent(part.id, depth, part.pierceDentWidth);
  } else {
    // Width alone: only the component across the wedge counts, so dragging
    // at any angle widens it without dragging it off its own axis.
    const dx = target.x - place.x;
    const dy = target.y - place.y;
    const half = Math.abs(dx * handles.across.x + dy * handles.across.y);
    partsStore.setPierceDent(part.id, part.pierceDentDepth, half * 2);
  }
  render();
}

function beginDentDrag(point) {
  const which = grabDentHandle(point);
  if (!which) return false;
  session.dentDrag = {
    which,
    token: history.capture(which === 'base' ? 'Place dent' : `Resize dent (${which})`),
    changed: false,
  };
  dragDentHandle(which, point);
  return true;
}

function endDentDrag() {
  const drag = session.dentDrag;
  session.dentDrag = null;
  if (!drag) return;
  history.commitCapture(drag.token, true);
}

function render() {
  if (!session) return;
  const canvas = els.pierceCanvas;
  const ctx = canvas.getContext('2d');
  const { cam, piercer, pierced, piercerAt, piercedAt } = session;
  if (!piercer || !pierced) { endSession(); return; } // a layer went away under us

  ctx.setTransform(session.dpr, 0, 0, session.dpr, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = '#101014';
  ctx.fillRect(0, 0, session.cssWidth, session.cssHeight);

  drawLayer(ctx, session.piercedCanvas, piercedAt, pierced, session.piercedOpacity);
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

  drawRegion(ctx, pierced, piercedAt, AREA_COLOR, AREA_EDGE);
  // On top of the pierceable area, because it is a part of it.
  drawRegion(ctx, pierced, piercedAt, DEFORM_COLOR, DEFORM_EDGE, pierced.pierceDeformRegion);
  // Walls last: they are what the tip is stopped by, so they belong on top
  // of whatever they are bounding.
  drawRegion(ctx, pierced, piercedAt, BARRIER_COLOR, BARRIER_EDGE, pierced.pierceBarrierRegion);
  drawRegion(ctx, piercer, piercerAt, TIP_COLOR, TIP_EDGE);
  // Only while it is the thing being edited: the wedge is a big opaque
  // shape and would hide the paint underneath it the rest of the time.
  if (session.target === 'dent') drawDent(ctx, pierced, piercedAt);

  els.pierceWindowTarget.textContent = session.target === 'tip'
    ? `${piercer.name} · tip`
    : `${pierced.name} · ${session.target === 'dent' ? 'dent' : targetMask().label}`;
  // A dent that cannot be cut is called out here rather than left to look
  // like it took: the numbers alone would say a depth and a width are
  // stored, which they are, while nothing on the canvas ever moved.
  const issue = pierceDentIssue(pierced);
  const where = dentPlacement(pierced);
  els.pierceWindowStatus.textContent = issue
    ? `⚠ no dent — ${issue}`
    : `tip ${piercer.pierceRegion.size} px · flesh ${pierced.pierceRegion.size} px · ` +
      `bunch ${pierced.pierceDeformRegion.size || 'none'} · ` +
      `wall ${pierced.pierceBarrierRegion.size} · ` +
      `dent ${pierced.pierceDentDepth}×${pierced.pierceDentWidth} ` +
      `@ ${where.x.toFixed(0)},${where.y.toFixed(0)}` +
      `${pierced.pierceDentPlaced ? '' : ' (unplaced)'} · ` +
      `${Math.round(cam.zoom * 100)}%`;
}

// What the selected target is for, said where it is being used. The
// Deformable one earns its length: it used to mean "which pixels are
// allowed to give way", with unpainted meaning all of them, and it now
// means very nearly the opposite -- the pixels that pile up around the
// notch, with unpainted meaning none. Somebody who learned the old meaning
// will read the same button and get the wrong answer unless it says so.
const TARGET_HINT = {
  deform: 'Which pixels BUNCH UP around the dent — they push outward as the '
    + 'notch grows, and never inward. They never cut anything: the notch is '
    + 'the Dent’s job. Unpainted means none of them react.',
  barrier: 'Solid: the tip cannot cross these, however hard it is pushed.',
  area: 'Where a pierce registers at all on this layer.',
  tip: 'The part of the piercer that goes in.',
  dent: 'Drag the wedge to where the notch should happen. It stays there — '
    + 'the piercer decides how much of it appears, not where.',
};

function renderTools() {
  const hint = TARGET_HINT[session.target];
  els.pierceTargetHint.textContent = hint || '';
  els.pierceTargetHint.hidden = !hint;
  els.pierceTargetTipBtn.setAttribute('aria-pressed', String(session.target === 'tip'));
  els.pierceTargetAreaBtn.setAttribute('aria-pressed', String(session.target === 'area'));
  els.pierceTargetDeformBtn.setAttribute('aria-pressed', String(session.target === 'deform'));
  els.pierceTargetBarrierBtn.setAttribute('aria-pressed', String(session.target === 'barrier'));
  els.pierceTargetDentBtn.setAttribute('aria-pressed', String(session.target === 'dent'));
  els.pierceToolPaintBtn.setAttribute('aria-pressed', String(session.tool === 'paint'));
  els.pierceToolEraseBtn.setAttribute('aria-pressed', String(session.tool === 'erase'));
  els.pierceBrushBtn.textContent = `${session.brush} × ${session.brush} ⌄`;
  els.pierceBrushBtn.setAttribute('aria-expanded', String(session.brushMenuOpen));
  els.pierceBrushMenu.hidden = !session.brushMenuOpen;
  // Nothing is painted on the dent target, so the brush and the paint/erase
  // pair go away rather than sitting there greyed: an active-looking Paint
  // button on a target that cannot paint is a worse lie than no button.
  const painting = session.target !== 'dent';
  els.pierceToolRow.hidden = !painting;
  if (!painting) {
    session.brushMenuOpen = false;
    els.pierceBrushMenu.hidden = true;
  }

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
    // The dent target drags handles; a touch that misses all three is a
    // miss rather than a stroke, so nothing is painted and nothing moves.
    if (session.target === 'dent') beginDentDrag(canvasPoint(event));
    else beginStroke(canvasPoint(event));
  } else if (session.pointers.size === 2) {
    endDentDrag();
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

  if (session.pointers.size !== 1) return;
  if (session.dentDrag) dragDentHandle(session.dentDrag.which, point);
  else if (session.stroke) extendStroke(point);
}

function onPointerUp(event) {
  if (!session || !session.pointers.has(event.pointerId)) return;
  session.pointers.delete(event.pointerId);
  if (session.pointers.size < 2) session.pinch = null;
  if (session.pointers.size === 0) { endDentDrag(); endStroke(); }
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
    piercedAt: { ...session.piercedAt },
    target: session.target,
    tool: session.tool,
    brush: session.brush,
    brushMenuOpen: session.brushMenuOpen,
    // Where the dent's handles currently are, so a test can drive them
    // through the same coordinates a finger would land on.
    dent: session.pierced ? {
      ...dentHandles(session.pierced),
      depth: session.pierced.pierceDentDepth,
      width: session.pierced.pierceDentWidth,
      placed: session.pierced.pierceDentPlaced,
    } : null,
    dragging: session.dentDrag ? session.dentDrag.which : null,
  };
}

// The window coordinates of one dent handle, for tests and for anything
// that needs to aim at a handle without re-deriving the camera.
export function pierceDentHandlePoint(which) {
  if (!session || !session.pierced) return null;
  const handles = dentHandles(session.pierced);
  const point = handles[which];
  return point ? texelToWindow(session.pierced, session.piercedAt, point.x, point.y) : null;
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
  els.pierceTargetDentBtn.addEventListener('click', () => {
    if (!session) return;
    session.target = 'dent';
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
  els.piercePiercedOpacity.addEventListener('input', () => {
    if (!session) return;
    session.piercedOpacity = Number(els.piercePiercedOpacity.value) / 100;
    els.piercePiercedOpacityValue.textContent = `${els.piercePiercedOpacity.value}%`;
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

  // THE CANVAS CAN CHANGE SIZE WITHOUT THE WINDOW DOING SO
  //
  // It shares a flex column with the controls below it, so anything that
  // changes THEIR height takes the difference out of the canvas -- and a
  // window resize is the only thing that used to re-measure. A hint line
  // under the target row, whose text differs per target, was enough to
  // break it: the backing store kept the old size while the CSS box
  // shrank, so the texels drew as stretched rectangles, and the pointer
  // mapping (which reads a fresh rect) landed somewhere other than where
  // the finger was. Reopening the window fixed it, until the next target
  // change. An observer on the element itself catches every cause rather
  // than the one that happened to be known.
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(() => {
      if (!session) return;
      const rect = els.pierceCanvas.getBoundingClientRect();
      if (rect.width === session.cssWidth && rect.height === session.cssHeight) return;
      sizeCanvas();
      render();
    }).observe(els.pierceCanvas);
  }
}
