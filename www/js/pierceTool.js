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

import { PixelPen, cellEdge, gridStrips } from './pixelDraw.js';
import { partsStore, WedgeWidthMode } from './parts.js';
import { bonesStore } from './bones.js';
import { history } from './history.js';
import { pinCarriageOffset } from './mesh.js';
import { pxlinkMove, applyPxLinkMove } from './pxlinkState.js';
import { pierceDentIssue, pierceOpeningPreview, pierceMeshOf, pierceMasks, markPierceStale } from './pierce.js';
import { openingPlacement, openingMarker, openingGeometry, openingSides, openingMirror, onMirror } from './opening.js';
import { rasterizeTriangle, layerClaims } from './raster.js';
import { renderBrushPresets, SQUARE_FORMAT, renderBrushButton } from './brushpresets.js';
import { createIcon } from './pixelIcons.js';
import { fitBackingStore, watchCanvasBox, snapCamera, pinchMidpoint, keepCentred } from './pixelCanvas.js';
import { noteToolUsed } from './recentTools.js';
import { getSetting, setSetting } from './settings.js';

// The tip is the app's accent; the pierceable area is deliberately NOT,
// because the two are painted in the same window and confusing them would
// put the flesh region on the needle.
//
// Deformable is a SUBSET of pierceable and is drawn on top of it, so it
// needs a colour that reads clearly against cyan rather than blending
// into it -- amber, the warm opposite of both the other two. It marks the
// material that GIVES WAY as the seam opens, so amber reading as "this is
// the part that moves" is exactly right. Walls are near-white. The
// opening's marker is violet: the one hue not already spoken for by a
// mask, so the marker never reads as a fifth region.
//
// HOW SOLID EACH PAINT IS, IS THE ARTIST'S
//
// Each target's fill is drawn at its own opacity (settings.js,
// piercePaintOpacity*), set on the slider under the targets while that
// target is chosen: low to see the artwork through the paint, high to see
// exactly what is painted. The cell outlines, drawn once zoomed in, stay
// at full strength, so even at 0% what is painted can still be told.
const PAINT = {
  tip: { rgb: [255, 46, 147], edge: '#FF2E93', key: 'piercePaintOpacityTip', label: 'Tip paint' },
  area: { rgb: [46, 230, 255], edge: '#2EE6FF', key: 'piercePaintOpacityArea', label: 'Pierceable paint' },
  deform: { rgb: [255, 176, 46], edge: '#FFB02E', key: 'piercePaintOpacityDeform', label: 'Deformable paint' },
  barrier: { rgb: [236, 238, 248], edge: '#FFFFFF', key: 'piercePaintOpacityBarrier', label: 'Barrier paint' },
  dent: { rgb: [160, 120, 255], edge: '#A078FF', key: 'piercePaintOpacityDent', label: 'Dent marker' },
};
const paintOpacity = (target) => Number(getSetting(PAINT[target].key)) / 100;
const paintFill = (target) => `rgba(${PAINT[target].rgb.join(', ')}, ${paintOpacity(target)})`;
const DENT_EDGE = PAINT.dent.edge;
// The mirror line: mint, the one colour no mask or marker uses, so it reads
// as a construction line rather than as anything painted.
const MIRROR_EDGE = '#4DFFB8';

// How near a handle a touch counts as grabbing it, in css px. Generous:
// this is a fingertip on a phone, and the three handles are deliberately
// never closer together than the marker's own size.
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
    'pierceBrushPresets',
    'piercePiercerOpacity', 'piercePiercerOpacityValue',
    'piercePiercedOpacity', 'piercePiercedOpacityValue',
    'piercePaintOpacity', 'piercePaintOpacityValue', 'piercePaintOpacityLabel',
    'pierceWindowDilationRow', 'pierceWindowDilation', 'pierceWindowDilationValue',
    'pierceDentStepRow', 'pierceDentStepMirrorBtn', 'pierceDentStepTriangleBtn',
    'pierceWindowWedgeModeRow', 'pierceWindowWedgeAutoBtn', 'pierceWindowWedgeManualBtn',
    'pierceWindowWedgeWidthRow', 'pierceWindowWedgeWidth', 'pierceWindowWedgeWidthValue',
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
  // A layer attached to another by PxLinks is moved as a whole onto it; this
  // flat view takes that move's shift (at the layer's middle), so the two
  // layers sit here as they meet in the scene. A joint adds nothing.
  const move = pxlinkMove(part, transforms);
  const middle = { x: part.x + offset.x + part.sceneWidth / 2, y: part.y + offset.y + part.sceneHeight / 2 };
  const moved = applyPxLinkMove(move, middle);
  return { x: part.x + offset.x + (moved.x - middle.x), y: part.y + offset.y + (moved.y - middle.y) };
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
  noteToolUsed('pierce', { partId, partnerId });

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
    // The Dent is placed in two steps: the mirror line first, then the
    // triangle along it. A layer whose line is already placed opens on the
    // triangle; one without starts at the line.
    dentStep: pierced.pierceMirrorPlaced ? 'triangle' : 'mirror',
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
  for (const index of region) {
    const u = index % part.naturalWidth;
    const v = Math.floor(index / part.naturalWidth);
    const x = (at.x + u * part.scale) * cam.zoom + cam.panX;
    const y = (at.y + v * part.scale) * cam.zoom + cam.panY;
    if (x + size < 0 || y + size < 0 || x > session.cssWidth || y > session.cssHeight) continue;
    // Set for every cell: cellEdge leaves the context on the solid EDGE
    // colour, and every fill after the first was drawn solid with it -- so,
    // zoomed in, paint hid the artwork whatever its opacity.
    ctx.fillStyle = fill;
    ctx.fillRect(x, y, size, size);
    if (size >= 6) cellEdge(ctx, x, y, size, Math.min(2, Math.max(1, size / 10)), edge, session.dpr);
  }
}

// ---------------------------------------------------------------------------
// The opening's marker, placed by hand
//
// The other four targets paint texels. This one does not paint anything: it
// puts a triangle marker on the artwork and lets the artist drag it, which
// is the only way to answer "where should this seam open" by looking at the
// drawing rather than by typing coordinates at it. The triangle is never
// cut out of anything; it says where the seam is (its centreline), how far
// in it runs, and how far apart its edges bow at full depth (opening.js).
//
// Three handles, because a triangle pinned to a surface has exactly three
// degrees of freedom worth exposing:
//
//   BASE   where on the artwork the seam opens       -- moves the whole marker
//   APEX   how far in it runs, and which way it goes -- depth and direction
//   WIDTH  how far apart the edges bow at the tip   -- width alone
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
// the artist is configuring the opening at the End Point, not whatever
// fraction of it some live contact happens to be at. The marker is a
// placement tool and nothing more: its centreline is the seam, its depth how
// far the seam runs in, its width how far the edges part at the tip.
function dentHandles(part) {
  const place = openingPlacement(part);
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

// THE MIRROR LINE, PLACED FIRST
//
// Its two ENDS are grips (each swings the line about the other, landing on
// texel corners), and the LINE ITSELF is one: grab it anywhere along its
// length to move it whole, by whole texels, keeping its angle. (A grip in
// its middle sat right on the triangle's depth grip.) It is drawn right
// across the layer, not just between its ends, because the whole of it is
// the wedge's centre. In the Mirror line step a touch that misses everything
// picks the line up where the finger is, so placing it is one drag. It stays
// draggable in the Triangle step too, with the triangle's grips first.
function mirrorHandles(part) {
  const m = openingMirror(part);
  return {
    m,
    m1: m.p1,
    m2: m.p2,
    // A point on the line clear of both ends and of the triangle's middle,
    // for anything that needs to aim at the line itself (tests).
    mline: { x: m.p1.x + (m.p2.x - m.p1.x) * 0.3, y: m.p1.y + (m.p2.y - m.p1.y) * 0.3 },
  };
}

// How far a window point is from the mirror line's drawn span, in window px.
function distanceToMirror(part, at, point) {
  const [a, b] = mirrorSpan(part, openingMirror(part)).map((p) => texelToWindow(part, at, p.x, p.y));
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length2 = dx * dx + dy * dy;
  const t = length2 > 0 ? Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / length2)) : 0;
  return Math.hypot(point.x - (a.x + dx * t), point.y - (a.y + dy * t));
}

// The line clipped to the layer's rectangle, two texels proud of it.
function mirrorSpan(part, m) {
  let lo = -Infinity;
  let hi = Infinity;
  const clip = (p, d, min, max) => {
    if (Math.abs(d) < 1e-12) { if (p < min || p > max) { lo = 1; hi = 0; } return; }
    let a = (min - p) / d;
    let b = (max - p) / d;
    if (a > b) [a, b] = [b, a];
    lo = Math.max(lo, a);
    hi = Math.min(hi, b);
  };
  clip(m.p1.x, m.dir.x, -2, part.naturalWidth + 2);
  clip(m.p1.y, m.dir.y, -2, part.naturalHeight + 2);
  if (!(hi > lo)) return [m.p1, m.p2];
  return [
    { x: m.p1.x + m.dir.x * lo, y: m.p1.y + m.dir.y * lo },
    { x: m.p1.x + m.dir.x * hi, y: m.p1.y + m.dir.y * hi },
  ];
}

function drawMirror(pen, part, at) {
  const { m, m1, m2 } = mirrorHandles(part);
  const { dpr } = session;
  const point = (p) => {
    const w = texelToWindow(part, at, p.x, p.y);
    return { x: w.x * dpr, y: w.y * dpr };
  };
  const [from, to] = mirrorSpan(part, m).map(point);
  // Solid once placed; dashed while it is only following the triangle.
  pen.line(from.x, from.y, to.x, to.y, MIRROR_EDGE, m.placed ? {} : { dash: 3 });
  const active = session.dentStep === 'mirror';
  const r = (active ? HANDLE_RADIUS : HANDLE_RADIUS * 0.7) * dpr;
  for (const end of [m1, m2]) {
    const p = point(end);
    pen.disc(p.x, p.y, r + pen.u, '#000000');
    pen.disc(p.x, p.y, r, MIRROR_EDGE);
  }
  // Labelled beside whichever end is further from the triangle's base, off
  // to the line's side, so it never lands on the triangle's own labels.
  const base = openingPlacement(part);
  const far = Math.hypot(m1.x - base.x, m1.y - base.y) >= Math.hypot(m2.x - base.x, m2.y - base.y) ? m1 : m2;
  const end = point(far);
  const side = { x: -m.dir.y, y: m.dir.x };
  const reach = r + 6 * dpr;
  const label = m.placed ? 'mirror' : 'mirror (drag to place)';
  const align = side.x > 0.4 ? 'left' : side.x < -0.4 ? 'right' : 'center';
  pen.text(label, end.x + side.x * reach, end.y + side.y * reach - 2.5 * pen.u, '#FFFFFF', { align, background: '#000000' });
}

function drawDent(ctx, part, at) {
  const handles = dentHandles(part);
  const tri = openingMarker(part);
  const { dpr } = session;
  // Pixel art on the interface grid (pixelDraw.js), in device pixels.
  const pen = new PixelPen(ctx, dpr).begin();
  const point = (p) => {
    const w = texelToWindow(part, at, p.x, p.y);
    return { x: w.x * dpr, y: w.y * dpr };
  };

  // The mirror line first, under the triangle that sits on it.
  drawMirror(pen, part, at);

  if (tri) {
    const marker = [point(tri.b1), point(tri.b2), point(tri.apex)];
    pen.polygon(marker, paintFill('dent'));
    pen.polyline(marker, DENT_EDGE);
  }

  // The seam itself, base to apex: the line the two edges part along. Drawn
  // even when the marker is too narrow to read as a triangle.
  const base = point(handles.base);
  const apex = point(handles.apex);
  pen.line(base.x, base.y, apex.x, apex.y, DENT_EDGE, { dash: 2 });

  // Each label sits just past its grip in the direction that handle points
  // AWAY from the others: base outside the layer, apex deeper in, width off
  // the far end of the mouth. Stacked above their grips, as they used to
  // be, the base and width labels ran into each other ("width 14ase") on
  // any marker narrower than its two labels.
  const grip = (p, label, fill, dir) => {
    const r = HANDLE_RADIUS * dpr;
    pen.disc(p.x, p.y, r + pen.u, '#000000');
    pen.disc(p.x, p.y, r, fill);
    const reach = r + 6 * dpr;
    const x = p.x + dir.x * reach;
    const y = p.y + dir.y * reach;
    const height = 5 * pen.u;
    const align = dir.x > 0.4 ? 'left' : dir.x < -0.4 ? 'right' : 'center';
    const top = dir.y > 0.4 ? y : dir.y < -0.4 ? y - height : y - height / 2;
    pen.text(label, x, top, '#FFFFFF', { align, background: '#000000' });
  };
  const { inward, across } = handles;
  const baseGrip = (() => { const w = handleWindowPoint(part, at, handles, 'base'); return { x: w.x * dpr, y: w.y * dpr }; })();
  pen.line(base.x, base.y, baseGrip.x, baseGrip.y, DENT_EDGE);
  grip(baseGrip, 'base', '#A078FF', { x: -inward.x, y: -inward.y });
  grip(apex, `depth ${part.pierceDentDepth}`, '#FFB02E', inward);
  grip(point(handles.width), `width ${part.pierceDentWidth}`, '#2EE6FF', across);
  pen.end();
}

// Where each grip is drawn and grabbed, in window coordinates. The apex and
// width grips sit on their points; the BASE grip sits just outside the
// surface, on a short leader to the base itself, because the base is where
// the wedge opens and a grip on it would cover the very opening the preview
// is showing.
const BASE_GRIP_OFFSET = 2.2; // handle radii, outward along the seam

function handleWindowPoint(part, at, handles, which) {
  if (which === 'm1' || which === 'm2' || which === 'mline') {
    const p = mirrorHandles(part)[which];
    return texelToWindow(part, at, p.x, p.y);
  }
  const point = handles[which];
  const w = texelToWindow(part, at, point.x, point.y);
  if (which !== 'base') return w;
  const reach = BASE_GRIP_OFFSET * HANDLE_RADIUS;
  return { x: w.x - handles.inward.x * reach, y: w.y - handles.inward.y * reach };
}

// Which handle a touch is going for, or null for none. Base is tested last
// so that a marker collapsed to nothing -- every handle stacked on one spot --
// still gives up its apex and width rather than only ever moving as a whole.
function grabDentHandle(point) {
  const part = session.pierced;
  const at = session.piercedAt;
  const handles = dentHandles(part);
  const near = (which) => {
    const w = handleWindowPoint(part, at, handles, which);
    return Math.hypot(point.x - w.x, point.y - w.y);
  };
  const triangle = [
    ['apex', near('apex')],
    ['width', near('width')],
    ['base', near('base')],
  ];
  const mirror = [['m1', near('m1')], ['m2', near('m2')]];
  const onLine = distanceToMirror(part, at, point) <= HANDLE_GRAB_PX * 0.6 ? 'mline' : null;
  const nearest = (candidates) => {
    let best = null;
    for (const [which, distance] of candidates) {
      if (distance > HANDLE_GRAB_PX) continue;
      if (!best || distance < best[1]) best = [which, distance];
    }
    return best ? best[0] : null;
  };
  // The step being worked on gets first claim on a touch.
  return session.dentStep === 'mirror'
    ? nearest(mirror) || onLine || nearest(triangle)
    : nearest(triangle) || nearest(mirror) || onLine;
}

function dragDentHandle(which, point) {
  const part = session.pierced;
  const target = windowToTexel(part, session.piercedAt, point);
  const handles = dentHandles(part);
  const place = handles.place;
  const mirror = openingMirror(part);

  if (which === 'm1' || which === 'm2') {
    // One end follows the finger; the other stays. Both on texel corners.
    const other = which === 'm1' ? mirror.p2 : mirror.p1;
    const [a, b] = which === 'm1' ? [target, other] : [other, target];
    partsStore.setPierceMirror(part.id, a.x, a.y, b.x, b.y);
  } else if (which === 'mline') {
    // The whole line, by whole texels, keeping its angle.
    const start = session.dentDrag && session.dentDrag.start;
    if (start) {
      const dx = Math.round(target.x - start.finger.x);
      const dy = Math.round(target.y - start.finger.y);
      partsStore.setPierceMirror(part.id, start.p1.x + dx, start.p1.y + dy, start.p2.x + dx, start.p2.y + dy);
    }
  } else if (which === 'base') {
    // The grip is drawn outside the surface (handleWindowPoint): the base is
    // that far back in along the seam from the finger. With a mirror line
    // placed, carried square onto it: the triangle slides ALONG the line.
    const reach = (BASE_GRIP_OFFSET * HANDLE_RADIUS) / (session.cam.zoom * part.scale);
    let at = { x: target.x + handles.inward.x * reach, y: target.y + handles.inward.y * reach };
    if (mirror.placed) at = onMirror(mirror, at);
    partsStore.setPierceDentPlacement(part.id, at.x, at.y, place.angle);
  } else if (which === 'apex') {
    // The apex sets the direction AND the depth: dragging it around the
    // base swings the marker, dragging it away from the base deepens it.
    // With a mirror line placed it can only point along the line: the depth
    // is how far along it the finger is, and dragging past the base turns
    // it to point the other way.
    const dx = target.x - place.x;
    const dy = target.y - place.y;
    if (mirror.placed) {
      const along = dx * mirror.dir.x + dy * mirror.dir.y;
      const lineAngle = Math.atan2(mirror.dir.y, mirror.dir.x);
      const angle = Math.abs(along) < 0.5 ? place.angle : lineAngle + (along < 0 ? Math.PI : 0);
      partsStore.setPierceDentPlacement(part.id, place.x, place.y, angle);
      partsStore.setPierceDent(part.id, Math.abs(along), part.pierceDentWidth);
    } else {
      const depth = Math.hypot(dx, dy);
      // Too close to the base to read an angle from: keep the one it has
      // rather than letting the marker spin under a fingertip.
      const angle = depth < 0.5 ? place.angle : Math.atan2(dy, dx);
      partsStore.setPierceDentPlacement(part.id, place.x, place.y, angle);
      partsStore.setPierceDent(part.id, depth, part.pierceDentWidth);
    }
  } else {
    // Width alone: only the component across the marker counts, so dragging
    // at any angle widens it without dragging it off its own axis.
    const dx = target.x - place.x;
    const dy = target.y - place.y;
    const half = Math.abs(dx * handles.across.x + dy * handles.across.y);
    partsStore.setPierceDent(part.id, part.pierceDentDepth, half * 2);
  }
  render();
}

function beginDentDrag(point) {
  let which = grabDentHandle(point);
  const part = session.pierced;
  const m = openingMirror(part);
  // In the Mirror line step a touch on nothing picks the line up there: it
  // jumps so its middle is under the finger, and the drag carries on.
  const jump = !which && session.dentStep === 'mirror';
  if (jump) which = 'mline';
  if (!which) return false;
  const finger = windowToTexel(part, session.piercedAt, point);
  const middle = { x: (m.p1.x + m.p2.x) / 2, y: (m.p1.y + m.p2.y) / 2 };
  const corner = (p) => ({ x: Math.round(p.x), y: Math.round(p.y) });
  const mirrorDrag = which === 'm1' || which === 'm2' || which === 'mline';
  session.dentDrag = {
    which,
    token: history.capture(mirrorDrag ? 'Place mirror line' : which === 'base' ? 'Place dent' : `Resize dent (${which})`),
    changed: false,
    // Where the line and the finger started, for moving it whole.
    start: { finger: jump ? middle : finger, p1: corner(m.p1), p2: corner(m.p2) },
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

// ---------------------------------------------------------------------------
// The wedge, live, while the triangle is placed
//
// On the Dent target the pierced layer is drawn OPENED, exactly as the
// scene will draw it at the Wedge Lock Point -- the shape the wedge keeps --
// with the paired piercer in it as the stand-in contact. Nothing here is a
// second opening: pierce.js (pierceOpeningPreview) makes the contact and
// calls the same openingFor the live solver does, and the layer goes through
// the same two passes (openingGeometry, split by openingSides) and the same
// rasterizer as the scene, with the piercer's painted tip beneath it and the
// rest of the piercer on top, as in a real contact. It is rebuilt whenever
// the marker, the opening's settings or the piercer's change -- every step
// of a handle drag -- and reused while only the camera moves.
const previewClaims = layerClaims();
const MAX_PREVIEW_PX = 1024;

function previewKey() {
  const { piercer: a, pierced: b } = session;
  return [
    b.pierceDentDepth, b.pierceDentWidth, b.pierceDentDilation, b.pierceDentPlaced,
    b.pierceDentX, b.pierceDentY, b.pierceDentAngle, b.pierceRegionVersion, b.pierceRegion.size,
    b.pierceMirrorPlaced, b.pierceMirrorX1, b.pierceMirrorY1, b.pierceMirrorX2, b.pierceMirrorY2,
    b.pierceWedgeMode, b.pierceWedgeWidthPx,
    b.pierceDeformRegionVersion, b.pinsVersion || 0, b.mesh ? b.mesh.vertices.length : 0,
    a.pierceRegionVersion, a.pierceRegion.size, a.pierceEnter, a.pierceEnd, a.pierceDentStart,
    a.pierceWedgeLock, a.scale, b.scale,
  ].join('|');
}

function wedgePreview() {
  const key = previewKey();
  if (session.preview && session.preview.key === key) return session.preview;
  session.preview = { key, layers: null, built: null };
  const { piercer, pierced, piercedAt } = session;
  const built = pierceOpeningPreview(piercer, pierced);
  if (!built || !built.opening) return session.preview;
  const o = built.opening;
  const mesh = pierceMeshOf(pierced);
  const s = pierced.scale;

  // The piercer's sprite, carried to where the stand-in is: its texels into
  // the pierced layer's (built.map), then onto the window's flat placement.
  const flat = (t) => ({ x: piercedAt.x + t.u * s, y: piercedAt.y + t.v * s });
  const corners = built.map ? [
    { x: 0, y: 0 }, { x: piercer.naturalWidth, y: 0 },
    { x: piercer.naturalWidth, y: piercer.naturalHeight }, { x: 0, y: piercer.naturalHeight },
  ].map((c) => flat(built.map(c))) : [];

  // The buffer: the layer's own footprint, room for the swelling, and the
  // stand-in -- in whole scene pixels, so it lands on the pixel grid.
  const margin = Math.ceil(o.lateral * s) + 2;
  let x0 = piercedAt.x - margin;
  let y0 = piercedAt.y - margin;
  let x1 = piercedAt.x + pierced.sceneWidth + margin;
  let y1 = piercedAt.y + pierced.sceneHeight + margin;
  for (const c of corners) { x0 = Math.min(x0, c.x); y0 = Math.min(y0, c.y); x1 = Math.max(x1, c.x); y1 = Math.max(y1, c.y); }
  x0 = Math.floor(x0); y0 = Math.floor(y0);
  const W = Math.min(MAX_PREVIEW_PX, Math.ceil(x1) - x0);
  const H = Math.min(MAX_PREVIEW_PX, Math.ceil(y1) - y0);
  if (W <= 0 || H <= 0) return session.preview;
  const local = (p) => ({ x: p.x - x0, y: p.y - y0 });

  const draw = (part, geometry, mask) => {
    const buffer = new Uint8ClampedArray(W * H * 4);
    const claims = previewClaims.begin(W, H);
    const { positions, uvs, triangles } = geometry;
    for (let i = 0; i < triangles.length; i += 3) {
      const a = triangles[i]; const b = triangles[i + 1]; const c = triangles[i + 2];
      rasterizeTriangle(buffer, W, H, part.pixels, part.naturalWidth, part.naturalHeight,
        positions[a], positions[b], positions[c], uvs[a], uvs[b], uvs[c], mask, claims);
    }
    return buffer;
  };
  const toCanvas = (buffers) => {
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const context = canvas.getContext('2d');
    const image = context.createImageData(W, H);
    // Several passes of one layer, each over the one before.
    for (const buffer of buffers) {
      for (let i = 0; i < buffer.length; i += 4) {
        if (buffer[i + 3] === 0) continue;
        image.data[i] = buffer[i]; image.data[i + 1] = buffer[i + 1];
        image.data[i + 2] = buffer[i + 2]; image.data[i + 3] = buffer[i + 3];
      }
    }
    context.putImageData(image, 0, 0);
    return canvas;
  };

  // The pierced layer, opened: its own mesh at its flat placement, then the
  // two passes.
  const coarse = {
    positions: mesh.vertices.map((t) => local(flat({ u: t.u, v: t.v }))),
    uvs: mesh.vertices,
    triangles: mesh.triangles,
  };
  const sides = openingSides(pierced, o);
  const opened = toCanvas([
    draw(pierced, openingGeometry(pierced, coarse, o, -1), sides.a),
    draw(pierced, openingGeometry(pierced, coarse, o, 1), sides.b),
  ]);
  // The stand-in: its painted tip beneath the layer, the rest on top.
  let tip = null;
  let rest = null;
  if (corners.length) {
    const quad = {
      positions: corners.map(local),
      uvs: [{ u: 0, v: 0 }, { u: piercer.naturalWidth, v: 0 },
        { u: piercer.naturalWidth, v: piercer.naturalHeight }, { u: 0, v: piercer.naturalHeight }],
      triangles: [0, 1, 2, 0, 2, 3],
    };
    const masks = pierceMasks(piercer);
    tip = toCanvas([draw(piercer, quad, masks ? masks.region : null)]);
    rest = masks ? toCanvas([draw(piercer, quad, masks.rest)]) : null;
  }
  session.preview.layers = { x: x0, y: y0, W, H, tip, opened, rest };
  session.preview.built = built;
  return session.preview;
}

function drawPreviewCanvas(ctx, canvas, layers, opacity) {
  if (!canvas) return;
  const { cam } = session;
  ctx.globalAlpha = opacity;
  ctx.drawImage(canvas, layers.x * cam.zoom + cam.panX, layers.y * cam.zoom + cam.panY,
    layers.W * cam.zoom, layers.H * cam.zoom);
  ctx.globalAlpha = 1;
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

  // On the Dent target, the wedge as it will be (see wedgePreview); the
  // piercer is drawn as its stand-in there, not where it happens to sit.
  const preview = session.target === 'dent' ? wedgePreview() : null;
  const layers = preview && preview.layers;
  if (layers) {
    drawPreviewCanvas(ctx, layers.tip, layers, session.piercerOpacity);
    drawPreviewCanvas(ctx, layers.opened, layers, session.piercedOpacity);
    drawPreviewCanvas(ctx, layers.rest, layers, session.piercerOpacity);
  } else {
    drawLayer(ctx, session.piercedCanvas, piercedAt, pierced, session.piercedOpacity);
    drawLayer(ctx, session.piercerCanvas, piercerAt, piercer, session.piercerOpacity);
  }

  // The texel grid of the layer being painted, once its cells are big
  // enough to aim at.
  const part = targetPart();
  const at = targetPlacement();
  const cell = part.scale * cam.zoom;
  if (cell >= GRID_MIN_CELL_PX) {
    gridStrips(ctx, at.x * cam.zoom + cam.panX, at.y * cam.zoom + cam.panY,
      part.naturalWidth, part.naturalHeight, cell, 'rgba(255, 255, 255, 0.12)', session.dpr);
  }

  // The painted regions sit on the layers as painted, flat -- so not over the
  // opened preview, which they would no longer line up with.
  if (!layers) {
    drawRegion(ctx, pierced, piercedAt, paintFill('area'), PAINT.area.edge);
    // On top of the pierceable area, because it is a part of it.
    drawRegion(ctx, pierced, piercedAt, paintFill('deform'), PAINT.deform.edge, pierced.pierceDeformRegion);
    // Walls last: they are what the tip is stopped by, so they belong on top
    // of whatever they are bounding.
    drawRegion(ctx, pierced, piercedAt, paintFill('barrier'), PAINT.barrier.edge, pierced.pierceBarrierRegion);
    drawRegion(ctx, piercer, piercerAt, paintFill('tip'), PAINT.tip.edge);
  }
  // Only while it is the thing being edited: the marker is a big opaque
  // shape and would hide the paint underneath it the rest of the time.
  if (session.target === 'dent') drawDent(ctx, pierced, piercedAt);

  els.pierceWindowTarget.textContent = session.target === 'tip'
    ? `${piercer.name} · tip`
    : `${pierced.name} · ${session.target === 'dent' ? 'dent' : targetMask().label}`;
  // An opening that cannot happen is called out here rather than left to
  // look like it took: the numbers alone would say a depth and a width are
  // stored, which they are, while nothing on the canvas ever moved.
  const issue = pierceDentIssue(pierced);
  const where = openingPlacement(pierced);
  const status = `tip ${piercer.pierceRegion.size} px · flesh ${pierced.pierceRegion.size} px · ` +
      `gives ${pierced.pierceDeformRegion.size || 'all'} · ` +
      `wall ${pierced.pierceBarrierRegion.size} · ` +
      `seam ${pierced.pierceDentDepth}×${pierced.pierceDentWidth} ` +
      `@ ${where.x.toFixed(0)},${where.y.toFixed(0)}` +
      `${pierced.pierceDentPlaced ? '' : ' (unplaced)'} · ` +
      `${pierced.pierceMirrorPlaced ? 'mirror placed' : 'mirror follows the triangle'} · ` +
      `${Math.round(cam.zoom * 100)}%`;
  if (issue) {
    els.pierceWindowStatus.replaceChildren(createIcon('warning'), document.createTextNode(` no opening — ${issue}`));
  } else if (layers && preview.built) {
    // What the preview is showing, in the numbers it was built from.
    const o = preview.built.opening;
    const how = pierced.pierceWedgeMode === WedgeWidthMode.MANUAL ? 'manual' : `${pierced.pierceDentDilation}% of the tip`;
    const gap = o.sides ? `gap ${o.sides.px} px = ${Math.floor(o.sides.px / 2)} + ${o.sides.px - Math.floor(o.sides.px / 2)} mirrored (${how}) · ` : '';
    els.pierceWindowStatus.textContent = `preview at the Lock ${Math.round(preview.built.lock * 100)}% · ${gap}` +
      `seam ${pierced.pierceDentDepth}×${pierced.pierceDentWidth} · ${Math.round(cam.zoom * 100)}%`;
  } else {
    els.pierceWindowStatus.textContent = status;
  }
}

// What the selected target is for, said where it is being used. The
// Deformable one earns its length: its meaning has changed with the
// pierce model more than once (2.5.1's meant "the pixels that pile up
// round the notch, unpainted meaning none"), and somebody who learned an
// old meaning will read the same button and get the wrong answer unless it
// says so.
const TARGET_HINT = {
  deform: 'Which pixels GIVE WAY as the seam opens — the edges bow outward '
    + 'round the tip and carry these with them. Unpainted means all of the '
    + 'layer gives; paint some to keep the movement to just those.',
  barrier: 'Solid: the tip cannot cross these, however hard it is pushed.',
  area: 'Where a pierce registers at all on this layer.',
  tip: 'The part of the piercer that goes in.',
  dent: 'Drag the triangle onto the spot the seam should open: base on the '
    + 'surface, point aimed the way the piercer goes in. It slides along the '
    + 'mirror line, which is the seam. It stays there — the piercer decides how '
    + 'far it opens, not where.',
  mirror: 'Step 1: drag the mirror line onto where the wedge\u2019s centre should be '
    + '(touch anywhere to pick it up there; drag an end to turn it). The wedge '
    + 'opens as two exact mirror images about it. Then step 2, the triangle.',
};

function renderTools() {
  const paint = PAINT[session.target] || PAINT.area;
  const percent = Math.round(paintOpacity(session.target) * 100);
  els.piercePaintOpacityLabel.textContent = paint.label;
  els.piercePaintOpacity.value = String(percent);
  els.piercePaintOpacityValue.textContent = `${percent}%`;
  const hint = session.target === 'dent' && session.dentStep === 'mirror'
    ? TARGET_HINT.mirror : TARGET_HINT[session.target];
  els.pierceTargetHint.textContent = hint || '';
  els.pierceTargetHint.hidden = !hint;
  els.pierceTargetTipBtn.setAttribute('aria-pressed', String(session.target === 'tip'));
  els.pierceTargetAreaBtn.setAttribute('aria-pressed', String(session.target === 'area'));
  els.pierceTargetDeformBtn.setAttribute('aria-pressed', String(session.target === 'deform'));
  els.pierceTargetBarrierBtn.setAttribute('aria-pressed', String(session.target === 'barrier'));
  els.pierceTargetDentBtn.setAttribute('aria-pressed', String(session.target === 'dent'));
  els.pierceToolPaintBtn.setAttribute('aria-pressed', String(session.tool === 'paint'));
  els.pierceToolEraseBtn.setAttribute('aria-pressed', String(session.tool === 'erase'));
  renderBrushButton(els.pierceBrushBtn, session.brush);
  els.pierceBrushBtn.setAttribute('aria-expanded', String(session.brushMenuOpen));
  els.pierceBrushMenu.hidden = !session.brushMenuOpen;
  // Nothing is painted on the dent target, so the brush and the paint/erase
  // pair go away rather than sitting there greyed: an active-looking Paint
  // button on a target that cannot paint is a worse lie than no button.
  const painting = session.target !== 'dent';
  // The opening's width, beside the marker it belongs to, so it can be tuned
  // against the preview (the Pierce panel has the same control).
  const manual = Boolean(session.pierced) && session.pierced.pierceWedgeMode === WedgeWidthMode.MANUAL;
  els.pierceDentStepRow.hidden = painting;
  els.pierceDentStepMirrorBtn.setAttribute('aria-pressed', String(session.dentStep === 'mirror'));
  els.pierceDentStepTriangleBtn.setAttribute('aria-pressed', String(session.dentStep === 'triangle'));
  els.pierceWindowWedgeModeRow.hidden = painting;
  els.pierceWindowWedgeAutoBtn.setAttribute('aria-pressed', String(!manual));
  els.pierceWindowWedgeManualBtn.setAttribute('aria-pressed', String(manual));
  els.pierceWindowDilationRow.hidden = painting || manual;
  els.pierceWindowWedgeWidthRow.hidden = painting || !manual;
  if (session.pierced) {
    els.pierceWindowDilation.value = String(session.pierced.pierceDentDilation);
    els.pierceWindowDilationValue.textContent = `${session.pierced.pierceDentDilation}% of the tip`;
    els.pierceWindowWedgeWidth.value = String(session.pierced.pierceWedgeWidthPx);
    els.pierceWindowWedgeWidthValue.textContent = `${session.pierced.pierceWedgeWidthPx} px`;
  }
  els.pierceToolRow.hidden = !painting;
  els.pierceBrushPresets.hidden = !painting;
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

// The brush's square of texel indices, centred on (u, v) -- only the ones
// that are artwork of the layer being painted (artwork.js). A region
// outside the silhouette would be a tip, a pierceable area or a wall made
// of nothing, so a brush past the edge paints only what it overlaps.
function brushIndices(u, v) {
  const part = targetPart();
  const size = session.brush;
  const origin = Math.floor((size - 1) / 2);
  const indices = [];
  for (let dv = 0; dv < size; dv++) {
    for (let du = 0; du < size; du++) {
      const index = part.texelIndex(u - origin + du, v - origin + dv);
      if (index >= 0 && part.isOpaqueIndex(index)) indices.push(index);
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
    dentStep: session.dentStep,
    mirror: session.pierced ? mirrorHandles(session.pierced) : null,
    // The Dent target's preview buffers (scene pixels, origin x/y in the
    // window's flat placement), so a test can read the opened layer itself,
    // without the marker and grips drawn over it.
    preview: session.preview && session.preview.layers ? session.preview.layers : null,
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
  if (which === 'm1' || which === 'm2' || which === 'mline') return handleWindowPoint(session.pierced, session.piercedAt, handles, which);
  return handles[which] ? handleWindowPoint(session.pierced, session.piercedAt, handles, which) : null;
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
  // One undo step per drag of the slider, however many values it passes.
  let dilationToken = null;
  let dilationTimer = null;
  const commitDilation = () => {
    clearTimeout(dilationTimer);
    if (dilationToken) history.commitCapture(dilationToken, true);
    dilationToken = null;
  };
  els.pierceWindowDilation.addEventListener('input', () => {
    if (!session || !session.pierced) return;
    if (!dilationToken) dilationToken = history.capture('Change opening width');
    clearTimeout(dilationTimer);
    dilationTimer = setTimeout(commitDilation, 500);
    partsStore.setPierceDentDilation(session.pierced.id, Number(els.pierceWindowDilation.value));
    els.pierceWindowDilationValue.textContent = `${els.pierceWindowDilation.value}% of the tip`;
    render();
  });
  els.pierceWindowDilation.addEventListener('change', commitDilation);

  // The Dent's two steps.
  const step = (which) => {
    if (!session) return;
    session.dentStep = which;
    renderTools();
    render();
  };
  els.pierceDentStepMirrorBtn.addEventListener('click', () => step('mirror'));
  els.pierceDentStepTriangleBtn.addEventListener('click', () => step('triangle'));

  // Automatic or a fixed pixel width -- one undo step each switch.
  const wedgeMode = (mode) => {
    if (!session || !session.pierced || session.pierced.pierceWedgeMode === mode) return;
    history.run(mode === WedgeWidthMode.MANUAL ? 'Wedge width: manual' : 'Wedge width: automatic',
      () => partsStore.setPierceWedgeMode(session.pierced.id, mode));
    markPierceStale();
    renderTools();
    render();
  };
  els.pierceWindowWedgeAutoBtn.addEventListener('click', () => wedgeMode(WedgeWidthMode.AUTO));
  els.pierceWindowWedgeManualBtn.addEventListener('click', () => wedgeMode(WedgeWidthMode.MANUAL));
  let widthToken = null;
  let widthTimer = null;
  const commitWidth = () => {
    clearTimeout(widthTimer);
    if (widthToken) history.commitCapture(widthToken, true);
    widthToken = null;
  };
  els.pierceWindowWedgeWidth.addEventListener('input', () => {
    if (!session || !session.pierced) return;
    if (!widthToken) widthToken = history.capture('Change wedge width');
    clearTimeout(widthTimer);
    widthTimer = setTimeout(commitWidth, 500);
    partsStore.setPierceWedgeWidth(session.pierced.id, Number(els.pierceWindowWedgeWidth.value));
    els.pierceWindowWedgeWidthValue.textContent = `${els.pierceWindowWedgeWidth.value} px`;
    markPierceStale();
    render();
  });
  els.pierceWindowWedgeWidth.addEventListener('change', commitWidth);
  els.piercePaintOpacity.addEventListener('input', () => {
    if (!session) return;
    setSetting((PAINT[session.target] || PAINT.area).key, Number(els.piercePaintOpacity.value));
    els.piercePaintOpacityValue.textContent = `${els.piercePaintOpacity.value}%`;
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
    const before = { width: session.cssWidth, height: session.cssHeight };
    sizeCanvas();
    if (unmeasured) fitCamera();
    else keepCentred(session.cam, before, { width: session.cssWidth, height: session.cssHeight }, session.dpr);
    render();
  });
}
