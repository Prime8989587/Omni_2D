// Pierce region painting: which pixels are the tip, and which are flesh.
//
// A dedicated full-screen window, deliberately built on the same pattern
// as Px Pin's: the layers of the relationship drawn together at their
// REAL relative positions, an opacity slider for each, and a private
// camera. What is painted here is sets of texels --
//
//   on the PIERCER      the tip: the pixels that actually do the piercing
//   on the PIERCED      the pierceable area, the seam that splits one layer
//                       into the two halves of its V, and the barrier walls
//
// -- each stored as texel indices in ITS OWN layer's pixel grid, exactly
// like Px Pin's pins. Local coordinates are the whole point: a region
// stays glued to the artwork it was painted on no matter where the layer
// is afterwards dragged, deformed or re-rigged. The V's HINGES are placed
// here too, by dragging them, in the same texel space.
//
// THE CAMERA HERE IS NOT THE APP'S CAMERA
//
// Same rule as Px Pin, and for the same reason. This window owns its own
// {zoom, pan} and its own <canvas>; nothing in here reads or writes
// view.js, and the ONLY things it ever writes to a part are its pierce
// regions and hinges. Zooming to 800%, panning around and leaving again
// cannot move, scale or rotate any layer.
//
// One finger paints, two fingers move the view -- the same interaction
// Px Pin settled on, so there is one way to paint pixels in this app
// rather than two. The seam is drawn with that same freehand brush: a
// stroke is a continuous line of texels however fast the finger moves.

import { partsStore } from './parts.js';
import { bonesStore } from './bones.js';
import { history } from './history.js';
import { pinCarriageOffset } from './mesh.js';
import { pierceSpreadIssue } from './pierce.js';
import { spreadTargetOf, spreadGeometry, fullSwing } from './spread.js';
import { SpreadMode } from './parts.js';
import { renderBrushPresets, SQUARE_FORMAT } from './brushpresets.js';
import { fitBackingStore, watchCanvasBox, snapCamera, pinchMidpoint } from './pixelCanvas.js';

// The tip is the app's accent; the pierceable area is deliberately NOT,
// because the two are painted in the same window and confusing them would
// put the flesh region on the needle.
const TIP_COLOR = 'rgba(255, 46, 147, 0.55)';
const TIP_EDGE = '#FF2E93';
const AREA_COLOR = 'rgba(46, 230, 255, 0.45)';
const AREA_EDGE = '#2EE6FF';
// The seam that splits one layer into its V's two halves: violet, the one
// hue not already spoken for by a mask.
const SEAM_COLOR = 'rgba(160, 120, 255, 0.6)';
const SEAM_EDGE = '#A078FF';
// Walls. Near-white, and the most opaque: a barrier is not a degree of
// anything, it is solid or it is not.
const BARRIER_COLOR = 'rgba(236, 238, 248, 0.85)';
const BARRIER_EDGE = '#FFFFFF';
// Each half of the V, as a handle colour: the hinge and the line to its
// mouth corner at full opening.
const HALF_COLORS = ['#FFB02E', '#2EE6C8'];

// How near a handle a touch counts as grabbing it, in css px. Generous:
// this is a fingertip on a phone.
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
    'pierceCanvas', 'pierceTargetTipBtn', 'pierceTargetAreaBtn', 'pierceTargetSeamBtn',
    'pierceTargetBarrierBtn', 'pierceTargetHingeBtn', 'pierceSwitchHalfBtn', 'pierceTargetHint',
    'pierceToolPaintBtn',
    'pierceToolEraseBtn', 'pierceToolRow', 'pierceBrushBtn', 'pierceBrushMenu',
    'pierceBrushPresets',
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
  // (A PxLink only welds the neighbourhood of its link point; it never moves
  // a layer as a whole, so it adds nothing to where the layer sits.)
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

  // The other half of a paired V is drawn alongside, so its hinge can be
  // placed and the two halves seen against each other.
  const partner = partsStore.partnerOf(pierced);
  session = {
    piercerId: piercer.id,
    piercedId: pierced.id,
    partnerId: partner ? partner.id : null,
    get piercer() { return partsStore.parts.find((part) => part.id === this.piercerId); },
    get pierced() { return partsStore.parts.find((part) => part.id === this.piercedId); },
    get partner() { return this.partnerId ? partsStore.parts.find((part) => part.id === this.partnerId) : null; },
    piercerAt: layerPlacement(piercer),
    piercedAt: layerPlacement(pierced),
    partnerAt: partner ? layerPlacement(partner) : null,
    piercerCanvas: layerCanvas(piercer),
    piercedCanvas: layerCanvas(pierced),
    partnerCanvas: partner ? layerCanvas(partner) : null,
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
    // Which hinge is under the finger, on the Hinges target only.
    hingeDrag: null,
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
// pierceable, seam and barrier all live on the pierced layer, which
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
  seam: {
    region: (part) => part.pierceSeam,
    write: (id, indices, marked) => partsStore.setPierceSeam(id, indices, marked),
    label: 'seam',
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

// The backing store follows the canvas's own box -- see pixelCanvas.js.
function sizeCanvas() {
  const box = fitBackingStore(els.pierceCanvas);
  if (!box) return;
  session.cssWidth = box.width;
  session.cssHeight = box.height;
  session.dpr = box.dpr;
}

// Fit both layers on screen with a margin; that zoom is also the floor,
// so the user can always come back out to the overview.
function fitCamera() {
  if (!session.cssWidth || !session.cssHeight) return;
  const { piercer, pierced, piercerAt, piercedAt, cam } = session;
  const boxes = [[piercer, piercerAt], [pierced, piercedAt]];
  if (session.partner && session.partnerAt) boxes.push([session.partner, session.partnerAt]);
  const x0 = Math.min(...boxes.map(([, at]) => at.x));
  const y0 = Math.min(...boxes.map(([, at]) => at.y));
  const x1 = Math.max(...boxes.map(([part, at]) => at.x + part.sceneWidth));
  const y1 = Math.max(...boxes.map(([part, at]) => at.y + part.sceneHeight));
  const spanX = Math.max(1, x1 - x0);
  const spanY = Math.max(1, y1 - y0);
  const zoom = Math.min(session.cssWidth / spanX, session.cssHeight / spanY) * 0.9;
  cam.zoom = Math.min(MAX_ZOOM, zoom);
  session.minZoom = cam.zoom * 0.5;
  cam.panX = (session.cssWidth - spanX * cam.zoom) / 2 - x0 * cam.zoom;
  cam.panY = (session.cssHeight - spanY * cam.zoom) / 2 - y0 * cam.zoom;
  // Whole device pixels per texel, so every texel draws the same size.
  snapCamera(cam, session.dpr, session.cssWidth / 2, session.cssHeight / 2, { maxZoom: MAX_ZOOM });
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
// The V's hinges, placed by hand
//
// The other targets paint texels. This one moves the points each half of the
// V turns about. Each is stored in its own layer's texels -- A and B on a
// seam-split layer, one per layer for a pair -- and until one is dragged it
// sits where spread.js derives it: the far end of the seam, the V's point.
//
// Drawn with each half's line from its hinge to its mouth corner, and that
// same line swung to FULL opening (dashed), so the V the halves will make at
// the End Point is on the artwork while the hinges are being placed.

// A point in a layer's texels, in window coordinates, and back.
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

function placementOf(part) {
  if (part.id === session.piercedId) return session.piercedAt;
  if (part.id === session.partnerId) return session.partnerAt;
  return null;
}

// Each half's hinge, where it is on screen, and which stored field it is.
function hingeHandles() {
  const pierced = session.pierced;
  const target = spreadTargetOf(pierced);
  const geometry = target ? spreadGeometry(target) : null;
  if (!geometry) return { geometry: null, handles: [] };
  const handles = geometry.halves.map((half, k) => {
    const at = placementOf(half.part);
    if (!at) return null;
    return {
      k,
      half,
      part: half.part,
      which: target.mode === SpreadMode.SEAM ? half.side : 'a',
      at,
      point: texelToWindow(half.part, at, half.hinge.u, half.hinge.v),
    };
  }).filter(Boolean);
  return { geometry, target, handles };
}

// A scene-space point of a pair (rest placement) in window coordinates:
// shifted by the pierced layer's own carriage, the one this window uses.
function sceneToWindow(point) {
  const { cam } = session;
  const pierced = session.pierced;
  const dx = session.piercedAt.x - pierced.x;
  const dy = session.piercedAt.y - pierced.y;
  return { x: (point.x + dx) * cam.zoom + cam.panX, y: (point.y + dy) * cam.zoom + cam.panY };
}

function drawHinges(ctx) {
  const { geometry, target, handles } = hingeHandles();
  if (!geometry) return;
  const pierced = session.pierced;
  // Where the V's mouth is, on screen.
  const mouth = target.mode === SpreadMode.SEAM
    ? texelToWindow(pierced, session.piercedAt, geometry.mouth.x, geometry.mouth.y)
    : sceneToWindow(geometry.mouth);
  for (const handle of handles) {
    const colour = HALF_COLORS[handle.k % HALF_COLORS.length];
    const h = handle.point;
    // Rest line, hinge to mouth.
    ctx.strokeStyle = colour;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(h.x, h.y);
    ctx.lineTo(mouth.x, mouth.y);
    ctx.stroke();
    // The same line at full opening. Window space is the scene scaled, so
    // the turn is the same angle here.
    const angle = handle.half.sigma * fullSwing(handle.half);
    const dx = mouth.x - h.x;
    const dy = mouth.y - h.y;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    ctx.setLineDash([6, 5]);
    ctx.beginPath();
    ctx.moveTo(h.x, h.y);
    ctx.lineTo(h.x + dx * cos - dy * sin, h.y + dx * sin + dy * cos);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  // The mouth, then the grips on top.
  ctx.beginPath();
  ctx.arc(mouth.x, mouth.y, 5, 0, Math.PI * 2);
  ctx.fillStyle = '#FFFFFF';
  ctx.fill();
  handles.forEach((handle) => {
    const colour = HALF_COLORS[handle.k % HALF_COLORS.length];
    const p = handle.point;
    ctx.beginPath();
    ctx.arc(p.x, p.y, HANDLE_RADIUS, 0, Math.PI * 2);
    ctx.fillStyle = colour;
    ctx.fill();
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = '#FFFFFF';
    ctx.font = '12px monospace';
    ctx.textAlign = 'center';
    const label = target.mode === SpreadMode.SEAM ? `hinge ${handle.half.side.toUpperCase()}` : handle.part.name;
    // Two hinges on one spot (the default) label above and below, so both
    // names can be read.
    ctx.fillText(label, p.x, handle.k === 0 ? p.y - HANDLE_RADIUS - 6 : p.y + HANDLE_RADIUS + 16);
  });
}

// Which hinge a touch is going for, or null for none. On the default setup
// both hinges sit on one spot; the first grabbed is the first dragged off.
function grabHinge(point) {
  let best = null;
  for (const handle of hingeHandles().handles) {
    const d = Math.hypot(point.x - handle.point.x, point.y - handle.point.y);
    if (d > HANDLE_GRAB_PX) continue;
    if (!best || d < best.d) best = { handle, d };
  }
  return best ? best.handle : null;
}

function dragHinge(drag, point) {
  const texel = windowToTexel(drag.part, drag.at, point);
  if (partsStore.setPierceHinge(drag.part.id, drag.which, { u: texel.x, v: texel.y })) drag.changed = true;
  render();
}

function beginHingeDrag(point) {
  const handle = grabHinge(point);
  if (!handle) return false;
  session.hingeDrag = {
    part: handle.part,
    which: handle.which,
    at: handle.at,
    token: history.capture('Place hinge'),
    changed: false,
  };
  dragHinge(session.hingeDrag, point);
  return true;
}

function endHingeDrag() {
  const drag = session.hingeDrag;
  session.hingeDrag = null;
  if (!drag) return;
  history.commitCapture(drag.token, drag.changed);
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
  // The other half of a paired V, at the same opacity as this one: the two
  // are one pierced side.
  if (session.partner && session.partnerCanvas) {
    drawLayer(ctx, session.partnerCanvas, session.partnerAt, session.partner, session.piercedOpacity);
  }
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

  const halves = [[pierced, piercedAt]];
  if (session.partner && session.partnerAt) halves.push([session.partner, session.partnerAt]);
  for (const [part, at] of halves) {
    drawRegion(ctx, part, at, AREA_COLOR, AREA_EDGE);
    drawRegion(ctx, part, at, SEAM_COLOR, SEAM_EDGE, part.pierceSeam);
    // Walls last: they are what the tip is stopped by, so they belong on
    // top of whatever they are bounding.
    drawRegion(ctx, part, at, BARRIER_COLOR, BARRIER_EDGE, part.pierceBarrierRegion);
  }
  drawRegion(ctx, piercer, piercerAt, TIP_COLOR, TIP_EDGE);
  // The hinges and the V they make, whenever there is a V: where it will
  // open is worth seeing while painting anything on its halves.
  drawHinges(ctx);

  els.pierceWindowTarget.textContent = session.target === 'tip'
    ? `${piercer.name} · tip`
    : `${pierced.name} · ${session.target === 'hinge' ? 'hinges' : targetMask().label}`;
  // A V that cannot open is called out here rather than left to look like
  // it took.
  const issue = pierceSpreadIssue(pierced);
  const mode = pierced.pierceSpreadMode;
  const v = mode === SpreadMode.OFF
    ? 'no V'
    : `V ${mode === SpreadMode.PAIR ? 'pair' : `seam ${pierced.pierceSeam.size} px`}, opens ${pierced.pierceSpread} px`;
  els.pierceWindowStatus.textContent = issue
    ? `⚠ ${issue}`
    : `tip ${piercer.pierceRegion.size} px · flesh ${pierced.pierceRegion.size} px · ` +
      `wall ${pierced.pierceBarrierRegion.size} · ${v} · ${Math.round(cam.zoom * 100)}%`;
}

// What the selected target is for, said where it is being used.
const TARGET_HINT = {
  seam: 'Draw the line that splits this layer into the two halves of its V — '
    + 'from the gap between them (where the piercer comes in) inward to where '
    + 'the V should come to its point. Used when this layer\u2019s V is set to Seam.',
  barrier: 'Solid: the tip cannot cross these. Painted down each half\u2019s inner '
    + 'edge, they swing with the halves, so the tip may move sideways only as far '
    + 'as the V has opened.',
  area: 'Where a pierce registers at all: paint it around the mouth of the seam.',
  tip: 'The part of the piercer that goes in.',
  hinge: 'Drag each half\u2019s hinge — the point it turns about, which never moves. '
    + 'The dashed lines show the V at full opening.',
};

function renderTools() {
  const hint = TARGET_HINT[session.target];
  els.pierceTargetHint.textContent = hint || '';
  els.pierceTargetHint.hidden = !hint;
  els.pierceTargetTipBtn.setAttribute('aria-pressed', String(session.target === 'tip'));
  els.pierceTargetAreaBtn.setAttribute('aria-pressed', String(session.target === 'area'));
  els.pierceTargetSeamBtn.setAttribute('aria-pressed', String(session.target === 'seam'));
  els.pierceTargetBarrierBtn.setAttribute('aria-pressed', String(session.target === 'barrier'));
  els.pierceTargetHingeBtn.setAttribute('aria-pressed', String(session.target === 'hinge'));
  els.pierceSwitchHalfBtn.hidden = !session.partner;
  if (session.partner) els.pierceSwitchHalfBtn.textContent = `Paint the other half (${session.partner.name})`;
  els.pierceToolPaintBtn.setAttribute('aria-pressed', String(session.tool === 'paint'));
  els.pierceToolEraseBtn.setAttribute('aria-pressed', String(session.tool === 'erase'));
  els.pierceBrushBtn.textContent = `${session.brush} × ${session.brush} ⌄`;
  els.pierceBrushBtn.setAttribute('aria-expanded', String(session.brushMenuOpen));
  els.pierceBrushMenu.hidden = !session.brushMenuOpen;
  // Nothing is painted on the Hinges target, so the brush and the
  // paint/erase pair go away rather than sitting there greyed: an
  // active-looking Paint button on a target that cannot paint is a worse lie
  // than no button.
  const painting = session.target !== 'hinge';
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

  renderBrushPresets(els.pierceBrushPresets, {
    key: 'pierceBrushPresets',
    current: () => session.brush,
    apply: (size) => { session.brush = size; session.brushMenuOpen = false; renderTools(); },
    format: SQUARE_FORMAT,
  });
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
    // back where they came from. Three of the four masks live on the same
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
    // The Hinges target drags handles; a touch that misses them is a miss
    // rather than a stroke, so nothing is painted and nothing moves.
    if (session.target === 'hinge') beginHingeDrag(canvasPoint(event));
    else beginStroke(canvasPoint(event));
  } else if (session.pointers.size === 2) {
    endHingeDrag();
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
  if (session.hingeDrag) dragHinge(session.hingeDrag, point);
  else if (session.stroke) extendStroke(point);
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
  if (session.pointers.size === 0) { endHingeDrag(); endStroke(); }
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
    partnerAt: session.partnerAt ? { ...session.partnerAt } : null,
    piercedId: session.piercedId,
    partnerId: session.partnerId,
    dragging: session.hingeDrag ? `${session.hingeDrag.part.name}:${session.hingeDrag.which}` : null,
  };
}

// Where each hinge handle is in window coordinates, for tests and for
// anything that needs to aim at one without re-deriving the camera.
export function pierceHingePoints() {
  if (!session) return [];
  return hingeHandles().handles.map((h) => ({ part: h.part.name, which: h.which, x: h.point.x, y: h.point.y }));
}

// A texel of a layer in window coordinates -- for tests drawing a seam or
// painting a region through the real pointer path.
export function pierceTexelPoint(partName, u, v) {
  if (!session) return null;
  const part = [session.pierced, session.partner, session.piercer].find((p) => p && p.name === partName);
  if (!part) return null;
  const at = part === session.piercer ? session.piercerAt : placementOf(part);
  return texelToWindow(part, at, u, v);
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
  els.pierceTargetSeamBtn.addEventListener('click', () => {
    if (!session) return;
    session.target = 'seam';
    renderTools();
    render();
  });
  els.pierceTargetBarrierBtn.addEventListener('click', () => {
    if (!session) return;
    session.target = 'barrier';
    renderTools();
    render();
  });
  els.pierceTargetHingeBtn.addEventListener('click', () => {
    if (!session) return;
    session.target = 'hinge';
    renderTools();
    render();
  });
  // A pair's two halves are two layers: painting moves to the other one,
  // and it becomes the layer the regions are written to.
  els.pierceSwitchHalfBtn.addEventListener('click', () => {
    if (!session || !session.partner) return;
    const was = { id: session.piercedId, at: session.piercedAt, canvas: session.piercedCanvas };
    session.piercedId = session.partnerId;
    session.piercedAt = session.partnerAt;
    session.piercedCanvas = session.partnerCanvas;
    session.partnerId = was.id;
    session.partnerAt = was.at;
    session.partnerCanvas = was.canvas;
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

  // THE CANVAS CAN CHANGE SIZE WITHOUT THE WINDOW DOING SO
  //
  // A hint line under the target row, whose text differs per target, was
  // the first cause found here; pixelCanvas.js now watches the element
  // itself for every window, so every cause is caught, not just that one.
  watchCanvasBox(els.pierceCanvas, () => {
    if (!session) return;
    const unmeasured = !session.cssWidth;
    sizeCanvas();
    if (unmeasured) fitCamera();
    render();
  });
}
