// PCreate: a dedicated window for painting a layer from scratch.
//
// THIS FILE IS THE FOUNDATION ONLY
//
// No drawing tools live here yet -- no brush, no shapes, no Shadow, no
// Select, no Rotate/Flip, no Pick Color, no Blend Colors. Those are a
// separate, later task. What this builds is everything they will need
// under them: the window itself, two ways in (a blank canvas or an
// imported picture), the full colour-picking and palette system, and a
// proven path for the canvas to become a real Scene Parts layer. A
// drawing tool added later has a camera, a colour, a palette and a save
// button already working; it only has to decide what a stroke writes.
//
// A DEDICATED SCREEN, NOT A SCENE TOOL
//
// Same reasoning as CLayer: a blank canvas is not part of any project
// until it is explicitly saved as one, and an imported picture is "any PNG
// the user selects", not necessarily anything already in Scene Parts. So
// this owns its own decoded (or freshly allocated) pixels, its own camera,
// and the only thing that ever writes to partsStore is a completed Save.
//
// THE CAMERA HERE IS NOT THE APP'S CAMERA
//
// Same rule as Px Pin, the Pierce painter and CLayer: this window owns its
// own {zoom, pan}, touches nothing in view.js, and cannot move, scale or
// rotate anything by being zoomed or panned.
//
// THE CHECKERBOARD IS THE MAIN CANVAS'S OWN CHECKERBOARD
//
// PCreate is a real drawing surface with real transparency to look at --
// closer in spirit to the main scene than to CLayer's "paint over an
// existing picture" or Px Pin's "compare two flattened layers" windows,
// neither of which needed the full always-visible grid. So the pattern
// here is the SAME algorithm canvas.js's drawGrid()/checkerPattern() use --
// dense at every zoom, floored to one device pixel rather than resampled
// below it -- just built against this window's own camera instead of
// view.js's.

import { Part, partsStore } from './parts.js';
import { sceneStore, SCENE_PRESETS, MIN_SCENE_SIZE, MAX_SCENE_SIZE } from './scene.js';
import { history } from './history.js';
import { isPng, loadImage, readPixels, displayName } from './importer.js';
import * as storage from './storage.js';
import { hsvToRgb, rgbToHsv, rgbToHex, hexToRgb } from './color.js';

const MAX_ZOOM = 64; // css px per canvas px -- far past single-pixel work
const GRID_DARK = '#000000';
const GRID_LIGHT = '#262626';
const GRID_EDGE = 'rgba(255, 255, 255, 0.28)';

// Cascading placement for layers dropped into the current project, the
// same two numbers CLayer's own cascade uses -- a session that saves
// several canvases one after another should not stack them exactly on top
// of each other.
const CASCADE_STEP = 8;
const CASCADE_WRAP = 6;

// Whether PCreate edits a COPY of an imported image or the image's own
// data directly. See setEditMode() for what this actually governs today
// and what it is wired for.
const EDIT_MODE_KEY = 'omni2d.pcreate.editInPlace';

const WHEEL_SIZE = 200;
const WHEEL_RADIUS = 96; // leaves room for the marker ring at full saturation

const els = {};
let session = null;
let blankMirror = false;
let editInPlace = false; // false = always work on a copy (the safer default)

// The wheel's own hue/saturation raster, at V = 1. Built once; a
// full-brightness colour wheel does not depend on the picked value, only
// the marker drawn on top of it does, so there is nothing to redraw here
// as the user picks.
let wheelBitmap = null;

// Palettes loaded from storage for the lifetime of one PCreate session,
// refreshed every time the palette modal opens -- see loadPaletteList().
let paletteCache = [];
let pendingPaletteDeleteName = null;
let nameModalMode = null; // 'new-palette' | 'rename-palette'
let renamingPaletteName = null;

function cacheElements() {
  for (const id of [
    'pcreateOpenBtn', 'pcreateFileInput', 'pcreateEntryModal', 'pcreateBlankBtn',
    'pcreateImportBtn', 'pcreateEntryCancelBtn',
    'pcreateSizeModal', 'pcreateSizePresets', 'pcreateWidthInput', 'pcreateHeightInput',
    'pcreateMirrorToggle', 'pcreateSizeCreateBtn', 'pcreateSizeCancelBtn',
    'pcreateWindow', 'pcreateCanvasLabel', 'pcreateStatus', 'pcreateDoneBtn', 'pcreateCanvas',
    'pcreateWheelCanvas', 'pcreateSwatch', 'pcreateValueSlider', 'pcreateValueLabel', 'pcreateHexInput',
    'pcreateLoadedPaletteName', 'pcreateSaveColorBtn', 'pcreatePalettesBtn', 'pcreateSwatchStrip',
    'pcreateEditModeToggle', 'pcreateSaveLayerBtn',
    'pcreatePaletteModal', 'pcreatePaletteEmpty', 'pcreatePaletteList', 'pcreateNewPaletteBtn', 'pcreatePaletteDoneBtn',
    'pcreateNameModal', 'pcreateNameTitle', 'pcreateNameInput', 'pcreateNameConfirmBtn', 'pcreateNameCancelBtn',
    'pcreateLayerNameModal', 'pcreateLayerNameInput', 'pcreateLayerNameConfirmBtn', 'pcreateLayerNameCancelBtn',
    'pcreateDeleteModal', 'pcreateDeleteMessage', 'pcreateDeleteConfirmBtn', 'pcreateDeleteCancelBtn',
  ]) {
    els[id] = document.getElementById(id);
  }
}

function showToast(message) {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = message;
  toast.hidden = false;
  setTimeout(() => { toast.hidden = true; }, 4500);
}

// ---------------------------------------------------------------------------
// Entry: blank canvas, or import

export function openPCreate() {
  els.pcreateEntryModal.hidden = false;
}

function closeEntryModal() {
  els.pcreateEntryModal.hidden = true;
}

// ---- Blank canvas: same width/height/Mirror/preset pattern the main
// project's own Canvas size dialog uses, kept entirely separate from
// sceneStore -- this is PCreate's own canvas, not the project's, until
// Save as Layer says otherwise.

function openSizeModal() {
  closeEntryModal();
  els.pcreateWidthInput.value = String(session ? session.width : 64);
  els.pcreateHeightInput.value = String(session ? session.height : 64);
  renderMirrorToggle();
  renderSizePresets();
  els.pcreateSizeModal.hidden = false;
}

function closeSizeModal() {
  els.pcreateSizeModal.hidden = true;
}

function renderMirrorToggle() {
  els.pcreateMirrorToggle.setAttribute('aria-pressed', String(blankMirror));
  els.pcreateMirrorToggle.textContent = `⇄ Mirror: ${blankMirror ? 'On' : 'Off'}`;
}

function handleMirrorToggle() {
  blankMirror = !blankMirror;
  renderMirrorToggle();
  if (blankMirror) {
    els.pcreateHeightInput.value = els.pcreateWidthInput.value;
    renderSizePresets();
  }
}

function handleWidthInput() {
  if (blankMirror) els.pcreateHeightInput.value = els.pcreateWidthInput.value;
  renderSizePresets();
}

function handleHeightInput() {
  if (blankMirror) els.pcreateWidthInput.value = els.pcreateHeightInput.value;
  renderSizePresets();
}

function renderSizePresets() {
  const width = Number(els.pcreateWidthInput.value);
  const height = Number(els.pcreateHeightInput.value);
  els.pcreateSizePresets.replaceChildren();
  for (const preset of SCENE_PRESETS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'segmented__btn';
    button.textContent = preset.label;
    button.classList.toggle('is-active', preset.width === width && preset.height === height);
    button.addEventListener('click', () => {
      els.pcreateWidthInput.value = String(preset.width);
      els.pcreateHeightInput.value = String(preset.height);
      renderSizePresets();
    });
    els.pcreateSizePresets.appendChild(button);
  }
}

function clampCanvasDim(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return MIN_SCENE_SIZE;
  return Math.min(MAX_SCENE_SIZE, Math.max(MIN_SCENE_SIZE, n));
}

function createBlankCanvas() {
  const width = clampCanvasDim(els.pcreateWidthInput.value);
  const height = clampCanvasDim(els.pcreateHeightInput.value);
  closeSizeModal();
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  startSession({
    kind: 'blank',
    name: `${width}×${height}`,
    width,
    height,
    pixels: new Uint8ClampedArray(width * height * 4), // all zero: fully transparent
    bitmap: canvas,
  });
}

// ---- Import: the same decode-only pattern CLayer's own picker uses --
// never the app's main #fileInput, which would hand the pick straight to
// partsStore.

function openImportPicker() {
  closeEntryModal();
  els.pcreateFileInput.value = '';
  els.pcreateFileInput.click();
}

async function onImportPicked(event) {
  const file = (event.target.files || [])[0];
  event.target.value = '';
  if (!file) return;
  if (!isPng(file)) {
    showToast(`${file.name} is not a PNG.`);
    return;
  }

  let image;
  let objectUrl;
  try {
    ({ image, objectUrl } = await loadImage(file));
  } catch (error) {
    showToast(`Could not open ${file.name}.`);
    return;
  }
  // Decoded once, straight into PCreate's own buffer. Nothing keeps this
  // tied to the picked File: the objectUrl is revoked immediately, and the
  // pixel array below is PCreate's own copy from the moment it exists --
  // there is no live object anywhere else in the app whose data this could
  // ever be said to be editing "in place". See setEditMode() for what the
  // destructive-vs-copy setting is actually for.
  const pixels = readPixels(image);
  URL.revokeObjectURL(objectUrl);

  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const ctx = canvas.getContext('2d');
  const imageData = ctx.createImageData(image.naturalWidth, image.naturalHeight);
  imageData.data.set(pixels);
  ctx.putImageData(imageData, 0, 0);

  startSession({
    kind: 'import',
    name: displayName(file.name),
    width: image.naturalWidth,
    height: image.naturalHeight,
    pixels,
    bitmap: canvas,
  });
}

// ---------------------------------------------------------------------------
// Session

function startSession({ kind, name, width, height, pixels, bitmap }) {
  session = {
    kind,
    sourceName: name,
    width,
    height,
    pixels,
    bitmap,
    cam: { zoom: 1, panX: 0, panY: 0 },
    pointers: new Map(),
    pinch: null,
    pan: null,
    hsv: { h: 0, s: 0, v: 1 }, // starts at white, same as an unset picker anywhere else
    loadedPaletteName: null,
    savedCount: 0,
  };

  els.pcreateCanvasLabel.textContent = name;
  els.pcreateWindow.hidden = false;

  sizeCanvas();
  fitCamera();
  renderEditModeToggle();
  drawWheel(); // builds wheelBitmap on first use -- must run before renderColorControls() paints onto it
  renderColorControls();
  renderSwatchStrip();
  render();
}

function endSession() {
  els.pcreateWindow.hidden = true;
  session = null;
}

function sizeCanvas() {
  const canvas = els.pcreateCanvas;
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(rect.width * dpr));
  canvas.height = Math.max(1, Math.round(rect.height * dpr));
  session.cssWidth = rect.width;
  session.cssHeight = rect.height;
  session.dpr = dpr;
}

function fitCamera() {
  const { width, height, cam } = session;
  const zoom = Math.min(session.cssWidth / width, session.cssHeight / height) * 0.9;
  cam.zoom = Math.min(MAX_ZOOM, zoom);
  session.minZoom = cam.zoom * 0.5;
  cam.panX = (session.cssWidth - width * cam.zoom) / 2;
  cam.panY = (session.cssHeight - height * cam.zoom) / 2;
}

// ---------------------------------------------------------------------------
// Rendering: the canvas, and the always-visible checkerboard behind it
//
// Ported from canvas.js's checkerPattern()/drawGrid() rather than shared
// with them: those read the MAIN camera (view.js) and this window
// deliberately has its own. The algorithm is identical -- a 2x2-cell tile
// rebuilt only when the zoom changes, floored to one device pixel once a
// cell would otherwise fall below the screen's own resolution, so the
// pattern stays dense and correctly scaled instead of aliasing into a
// false moire (see canvas.js's own comment on exactly that bug).

let checkerTile = null;
let checkerTileZoom = 0;

function checkerPattern(ctx) {
  const { cam, dpr } = session;
  const zoom = cam.zoom;
  if (!checkerTile || checkerTileZoom !== zoom) {
    const cell = Math.max(1, Math.round(zoom * dpr));
    checkerTile = document.createElement('canvas');
    checkerTile.width = cell * 2;
    checkerTile.height = cell * 2;
    const tileCtx = checkerTile.getContext('2d');
    tileCtx.fillStyle = GRID_DARK;
    tileCtx.fillRect(0, 0, cell * 2, cell * 2);
    tileCtx.fillStyle = GRID_LIGHT;
    tileCtx.fillRect(cell, 0, cell, cell);
    tileCtx.fillRect(0, cell, cell, cell);
    checkerTileZoom = zoom;
  }

  const pattern = ctx.createPattern(checkerTile, 'repeat');
  const rawCell = zoom * dpr;
  const cell = Math.max(1, Math.round(rawCell));
  const correction = rawCell >= 1 ? rawCell / cell : 1;
  pattern.setTransform(new DOMMatrix([1 / dpr, 0, 0, 1 / dpr, cam.panX, cam.panY]).scale(correction));
  return pattern;
}

function drawGrid(ctx) {
  const { cam, width, height } = session;
  const w = width * cam.zoom;
  const h = height * cam.zoom;
  ctx.fillStyle = checkerPattern(ctx);
  ctx.fillRect(cam.panX, cam.panY, w, h);
  ctx.strokeStyle = GRID_EDGE;
  ctx.lineWidth = 1;
  ctx.strokeRect(cam.panX - 0.5, cam.panY - 0.5, w + 1, h + 1);
}

function render() {
  if (!session) return;
  const canvas = els.pcreateCanvas;
  const ctx = canvas.getContext('2d');
  const { cam, width, height } = session;

  ctx.setTransform(session.dpr, 0, 0, session.dpr, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = '#101014';
  ctx.fillRect(0, 0, session.cssWidth, session.cssHeight);

  drawGrid(ctx);
  ctx.drawImage(session.bitmap, cam.panX, cam.panY, width * cam.zoom, height * cam.zoom);

  els.pcreateStatus.textContent =
    `${width}×${height} · ${Math.round(cam.zoom * 100)}%`;
}

// ---------------------------------------------------------------------------
// Camera input: one finger pans, two fingers pinch-zoom -- there is no
// drawing tool yet to reserve the single finger for, so both gestures are
// camera-only, the same as the main canvas's own Home-mode behaviour
// before anything is selected.

function canvasPoint(event) {
  const rect = els.pcreateCanvas.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

function onPointerDown(event) {
  if (!session) return;
  event.preventDefault();
  try { els.pcreateCanvas.setPointerCapture(event.pointerId); } catch { /* no-op: no live pointer in tests */ }
  session.pointers.set(event.pointerId, canvasPoint(event));

  if (session.pointers.size === 1) {
    session.pinch = null;
    session.pan = { last: canvasPoint(event) };
  } else if (session.pointers.size === 2) {
    session.pan = null;
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
    const scale = zoom / session.pinch.zoom;
    session.cam.zoom = zoom;
    session.cam.panX = mid.x - (session.pinch.mid.x - session.pinch.panX) * scale;
    session.cam.panY = mid.y - (session.pinch.mid.y - session.pinch.panY) * scale;
    render();
    return;
  }

  if (session.pointers.size === 1 && session.pan) {
    const dx = point.x - session.pan.last.x;
    const dy = point.y - session.pan.last.y;
    session.cam.panX += dx;
    session.cam.panY += dy;
    session.pan.last = point;
    render();
  }
}

function onPointerUp(event) {
  if (!session || !session.pointers.has(event.pointerId)) return;
  session.pointers.delete(event.pointerId);
  if (session.pointers.size < 2) session.pinch = null;
  if (session.pointers.size === 0) session.pan = null;
}

// ---------------------------------------------------------------------------
// Colour wheel: hue/saturation on the wheel (drawn once, always at full
// value so the surface stays legible), a separate Value slider, and a hex
// field -- three views of the same session.hsv, kept in sync however the
// user changes it.

function drawWheel() {
  if (!wheelBitmap) {
    wheelBitmap = document.createElement('canvas');
    wheelBitmap.width = WHEEL_SIZE;
    wheelBitmap.height = WHEEL_SIZE;
    const wctx = wheelBitmap.getContext('2d');
    const image = wctx.createImageData(WHEEL_SIZE, WHEEL_SIZE);
    const cx = WHEEL_SIZE / 2;
    const cy = WHEEL_SIZE / 2;
    for (let y = 0; y < WHEEL_SIZE; y++) {
      for (let x = 0; x < WHEEL_SIZE; x++) {
        const dx = x + 0.5 - cx;
        const dy = y + 0.5 - cy;
        const dist = Math.hypot(dx, dy);
        const o = (y * WHEEL_SIZE + x) * 4;
        if (dist > WHEEL_RADIUS) continue; // left transparent: a round wheel on a square canvas
        const hue = (Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360;
        const sat = Math.min(1, dist / WHEEL_RADIUS);
        const { r, g, b } = hsvToRgb(hue, sat, 1);
        image.data[o] = r;
        image.data[o + 1] = g;
        image.data[o + 2] = b;
        image.data[o + 3] = 255;
      }
    }
    wctx.putImageData(image, 0, 0);
  }
  paintWheel();
}

function paintWheel() {
  const canvas = els.pcreateWheelCanvas;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, WHEEL_SIZE, WHEEL_SIZE);
  ctx.drawImage(wheelBitmap, 0, 0);
  if (!session) return;

  const { h, s } = session.hsv;
  const cx = WHEEL_SIZE / 2;
  const cy = WHEEL_SIZE / 2;
  const rad = (h * Math.PI) / 180;
  const dist = s * WHEEL_RADIUS;
  const mx = cx + Math.cos(rad) * dist;
  const my = cy + Math.sin(rad) * dist;

  ctx.beginPath();
  ctx.arc(mx, my, 6, 0, Math.PI * 2);
  ctx.strokeStyle = '#FFFFFF';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(mx, my, 6, 0, Math.PI * 2);
  ctx.strokeStyle = '#000000';
  ctx.lineWidth = 1;
  ctx.stroke();
}

function wheelPoint(event) {
  const rect = els.pcreateWheelCanvas.getBoundingClientRect();
  const scale = WHEEL_SIZE / rect.width; // the element can be CSS-scaled from its 200x200 backing store
  return {
    x: (event.clientX - rect.left) * scale,
    y: (event.clientY - rect.top) * scale,
  };
}

// A tap outside the wheel's own circle is clamped to its edge rather than
// ignored, so dragging slightly past the rim still reads as "fully
// saturated at this hue" instead of doing nothing.
function pickFromWheel(point) {
  const cx = WHEEL_SIZE / 2;
  const cy = WHEEL_SIZE / 2;
  const dx = point.x - cx;
  const dy = point.y - cy;
  const dist = Math.hypot(dx, dy);
  const hue = (Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360;
  const sat = Math.min(1, dist / WHEEL_RADIUS);
  session.hsv.h = hue;
  session.hsv.s = sat;
  renderColorControls();
}

function onWheelPointerDown(event) {
  if (!session) return;
  event.preventDefault();
  try { els.pcreateWheelCanvas.setPointerCapture(event.pointerId); } catch { /* no-op */ }
  session.wheelDragging = true;
  pickFromWheel(wheelPoint(event));
}

function onWheelPointerMove(event) {
  if (!session || !session.wheelDragging) return;
  event.preventDefault();
  pickFromWheel(wheelPoint(event));
}

function onWheelPointerUp() {
  if (session) session.wheelDragging = false;
}

// The one place all three colour inputs (wheel, Value slider, hex field)
// agree: called after ANY of them changes session.hsv, so the other two
// are never left showing a stale value.
function renderColorControls() {
  if (!session) return;
  const { h, s, v } = session.hsv;
  const { r, g, b } = hsvToRgb(h, s, v);
  els.pcreateSwatch.style.background = `rgb(${r}, ${g}, ${b})`;
  els.pcreateValueSlider.value = String(Math.round(v * 100));
  els.pcreateValueLabel.textContent = `${Math.round(v * 100)}%`;
  // Only when the field is not currently focused: overwriting a hex value
  // the user is mid-way through typing (e.g. "#a" while aiming for
  // "#a0a0a0") would fight every keystroke.
  if (document.activeElement !== els.pcreateHexInput) {
    els.pcreateHexInput.value = rgbToHex(r, g, b);
  }
  paintWheel();
  renderSwatchStrip(); // the "currently selected" ring can move
}

function handleValueSlider() {
  if (!session) return;
  session.hsv.v = Number(els.pcreateValueSlider.value) / 100;
  renderColorControls();
}

function handleHexInput() {
  if (!session) return;
  const rgb = hexToRgb(els.pcreateHexInput.value);
  if (!rgb) return; // not yet a complete hex value -- wait for more typing
  session.hsv = rgbToHsv(rgb.r, rgb.g, rgb.b);
  renderColorControls();
}

function currentRgb() {
  const { h, s, v } = session.hsv;
  return hsvToRgb(h, s, v);
}

function currentHex() {
  const { r, g, b } = currentRgb();
  return rgbToHex(r, g, b);
}

// ---------------------------------------------------------------------------
// Palettes -- global, named, persisted (storage.js), never scoped to one
// project or one PCreate session. Loaded fresh every time the management
// modal opens, so a palette saved on a previous visit is always current.

async function refreshPaletteCache() {
  try {
    paletteCache = await storage.listPalettes();
  } catch (error) {
    console.warn(error);
    paletteCache = [];
  }
  return paletteCache;
}

function findLoadedPalette() {
  if (!session || !session.loadedPaletteName) return null;
  return paletteCache.find((p) => p.name === session.loadedPaletteName) || null;
}

function renderSwatchStrip() {
  els.pcreateSwatchStrip.replaceChildren();
  const palette = findLoadedPalette();
  els.pcreateLoadedPaletteName.textContent = palette ? palette.name : 'No palette loaded';

  if (!palette || palette.colors.length === 0) {
    const empty = document.createElement('span');
    empty.className = 'pcreate-swatch-strip__empty';
    empty.textContent = palette ? 'This palette has no colours yet.' : 'Open Palettes… to load or create one.';
    els.pcreateSwatchStrip.appendChild(empty);
    return;
  }

  const currentHexValue = session ? currentHex() : null;
  for (const hex of palette.colors) {
    const entry = document.createElement('span');
    entry.className = 'pcreate-swatch-strip__entry';

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'pcreate-swatch-strip__item';
    button.style.background = hex;
    button.setAttribute('aria-label', `Pick ${hex}`);
    button.setAttribute('aria-pressed', String(hex.toLowerCase() === currentHexValue));
    button.addEventListener('click', () => {
      const rgb = hexToRgb(hex);
      if (!rgb || !session) return;
      session.hsv = rgbToHsv(rgb.r, rgb.g, rgb.b);
      renderColorControls();
    });
    entry.appendChild(button);

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'pcreate-swatch-strip__remove';
    remove.textContent = '×';
    remove.setAttribute('aria-label', `Remove ${hex} from ${palette.name}`);
    remove.addEventListener('click', (event) => {
      event.stopPropagation();
      removeColorFromPalette(palette.name, hex);
    });
    entry.appendChild(remove);

    els.pcreateSwatchStrip.appendChild(entry);
  }
}

// ---- Save current colour into the loaded palette ------------------------

function handleSaveColor() {
  if (!session) return;
  if (!session.loadedPaletteName) {
    showToast('Open Palettes… and load or create one first.');
    openPaletteModal();
    return;
  }
  addColorToPalette(session.loadedPaletteName, currentHex());
}

async function addColorToPalette(name, hex) {
  const palette = paletteCache.find((p) => p.name === name);
  if (!palette) return;
  if (palette.colors.includes(hex)) {
    showToast(`${hex} is already in "${name}".`);
    return;
  }
  palette.colors = [...palette.colors, hex];
  try {
    await storage.savePalette(name, palette.colors);
    renderSwatchStrip();
    showToast(`Added ${hex} to "${name}".`);
  } catch (error) {
    console.warn(error);
    showToast(`Could not save the palette: ${error.message}`);
  }
}

async function removeColorFromPalette(name, hex) {
  const palette = paletteCache.find((p) => p.name === name);
  if (!palette) return;
  palette.colors = palette.colors.filter((c) => c !== hex);
  try {
    await storage.savePalette(name, palette.colors);
    renderSwatchStrip();
    renderPaletteList();
  } catch (error) {
    console.warn(error);
    showToast(`Could not update the palette: ${error.message}`);
  }
}

// ---- Palette management modal -------------------------------------------

async function openPaletteModal() {
  await refreshPaletteCache();
  renderPaletteList();
  els.pcreatePaletteModal.hidden = false;
}

function closePaletteModal() {
  els.pcreatePaletteModal.hidden = true;
}

function renderPaletteList() {
  els.pcreatePaletteList.replaceChildren();
  els.pcreatePaletteEmpty.hidden = paletteCache.length > 0;

  for (const palette of paletteCache) {
    const item = document.createElement('li');
    const row = document.createElement('div');
    row.className = 'project-row';

    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'project-open';
    const name = document.createElement('span');
    name.className = 'project-open__name';
    name.textContent = palette.name;
    const date = document.createElement('span');
    date.className = 'project-open__date';
    const count = palette.colors.length;
    date.textContent = `${count} colour${count === 1 ? '' : 's'}${
      session && session.loadedPaletteName === palette.name ? ' · loaded' : ''
    }`;
    open.append(name, date);
    open.addEventListener('click', () => {
      if (!session) return;
      session.loadedPaletteName = palette.name;
      renderSwatchStrip();
      renderPaletteList();
      showToast(`Loaded "${palette.name}".`);
    });
    row.appendChild(open);

    row.appendChild(smallIconButton('icon-pencil', `Rename ${palette.name}`, () => {
      renamingPaletteName = palette.name;
      nameModalMode = 'rename-palette';
      els.pcreateNameTitle.textContent = 'Rename palette';
      els.pcreateNameInput.value = palette.name;
      els.pcreateNameModal.hidden = false;
    }));
    row.appendChild(smallIconButton('icon-trash', `Delete ${palette.name}`, () => {
      pendingPaletteDeleteName = palette.name;
      els.pcreateDeleteMessage.textContent =
        `"${palette.name}" and its ${palette.colors.length} colour${palette.colors.length === 1 ? '' : 's'} ` +
        'will be permanently removed. This cannot be undone.';
      els.pcreateDeleteModal.hidden = false;
    }));

    item.appendChild(row);
    els.pcreatePaletteList.appendChild(item);
  }
}

// A tiny local stand-in for ui.js's iconButton(): PCreate is its own
// module and does not reach into ui.js's private helpers, but the two
// icons it needs (rename, delete) are already shipped pixel-art assets --
// reusing the files keeps this visually identical without duplicating
// ui.js's whole emoji-to-icon table for two entries.
function smallIconButton(iconName, label, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'row-btn';
  const img = document.createElement('img');
  img.className = 'pixel-icon';
  img.src = `icons/${iconName}.png`;
  img.alt = '';
  img.setAttribute('aria-hidden', 'true');
  button.appendChild(img);
  button.setAttribute('aria-label', label);
  button.title = label;
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    onClick();
  });
  return button;
}

function openNewPaletteModal() {
  nameModalMode = 'new-palette';
  renamingPaletteName = null;
  els.pcreateNameTitle.textContent = 'Name this palette';
  els.pcreateNameInput.value = '';
  els.pcreateNameModal.hidden = false;
  els.pcreateNameInput.focus();
}

function closeNameModal() {
  els.pcreateNameModal.hidden = true;
  nameModalMode = null;
  renamingPaletteName = null;
}

function sanitizePaletteName(raw) {
  return String(raw || '').trim().replace(/[\\/:*?"<>|]/g, '').slice(0, 60);
}

async function confirmNameModal() {
  const typed = sanitizePaletteName(els.pcreateNameInput.value);
  if (!typed) { showToast('Type a name for the palette.'); return; }

  if (nameModalMode === 'new-palette') {
    if (paletteCache.some((p) => p.name === typed)) {
      showToast(`"${typed}" already exists — pick a different name.`);
      return;
    }
    try {
      await storage.savePalette(typed, []);
      await refreshPaletteCache();
      if (session) session.loadedPaletteName = typed;
      renderPaletteList();
      renderSwatchStrip();
      showToast(`Created "${typed}".`);
      closeNameModal();
    } catch (error) {
      console.warn(error);
      showToast(`Could not create the palette: ${error.message}`);
    }
    return;
  }

  if (nameModalMode === 'rename-palette' && renamingPaletteName) {
    const oldName = renamingPaletteName;
    if (typed === oldName) { closeNameModal(); return; }
    if (paletteCache.some((p) => p.name === typed)) {
      showToast(`"${typed}" already exists — pick a different name.`);
      return;
    }
    const palette = paletteCache.find((p) => p.name === oldName);
    try {
      // IndexedDB has no rename: write the new key, then delete the old
      // one, so a crash between the two leaves the data under ONE name or
      // the other rather than losing it outright.
      await storage.savePalette(typed, palette ? palette.colors : []);
      await storage.deletePalette(oldName);
      await refreshPaletteCache();
      if (session && session.loadedPaletteName === oldName) session.loadedPaletteName = typed;
      renderPaletteList();
      renderSwatchStrip();
      showToast(`Renamed to "${typed}".`);
      closeNameModal();
    } catch (error) {
      console.warn(error);
      showToast(`Could not rename the palette: ${error.message}`);
    }
  }
}

function closeDeleteModal() {
  pendingPaletteDeleteName = null;
  els.pcreateDeleteModal.hidden = true;
}

async function confirmDeletePalette() {
  const name = pendingPaletteDeleteName;
  closeDeleteModal();
  if (!name) return;
  try {
    await storage.deletePalette(name);
    await refreshPaletteCache();
    if (session && session.loadedPaletteName === name) session.loadedPaletteName = null;
    renderPaletteList();
    renderSwatchStrip();
    showToast(`Deleted "${name}".`);
  } catch (error) {
    console.warn(error);
    showToast(`Could not delete the palette: ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// Destructive-vs-copy setting
//
// TODAY, this cannot actually be observed either way: Import decodes a
// FRESH Uint8ClampedArray (readPixels(), above) that has never been shared
// with anything else in the app, and a blank canvas starts from a freshly
// allocated buffer too -- there is no live object anywhere else whose data
// PCreate's own pixels could be said to alias. It exists now, persisted
// and wired into the session, because the drawing tools task after this
// one needs an already-working, already-persisted answer to "may a stroke
// write straight into this buffer, or does a live Part somewhere else need
// protecting from it" rather than having to invent the setting from
// scratch once that question actually has teeth -- e.g. a future "edit
// this Scene Parts layer in PCreate" entry point that hands PCreate a
// Part's OWN pixels array by reference instead of a freshly decoded one.
//
// Defaults to the SAFER reading, off (always work on a copy): a stray
// stroke undoing hours of work on a layer that was never meant to be
// touched outside its own tools is a strictly worse failure than PCreate
// occasionally holding a redundant clone it didn't strictly need to.
function loadEditMode() {
  try {
    editInPlace = window.localStorage.getItem(EDIT_MODE_KEY) === '1';
  } catch {
    editInPlace = false;
  }
}

function setEditMode(value) {
  editInPlace = value;
  try {
    window.localStorage.setItem(EDIT_MODE_KEY, value ? '1' : '0');
  } catch { /* no-op: a device with storage disabled just keeps the default each session */ }
  renderEditModeToggle();
}

function renderEditModeToggle() {
  els.pcreateEditModeToggle.setAttribute('aria-pressed', String(editInPlace));
  els.pcreateEditModeToggle.textContent = editInPlace
    ? 'Edit the original directly'
    : 'Always edit a copy';
}

// ---------------------------------------------------------------------------
// Save as Layer
//
// Reuses the exact placement rule CLayer's own save proved out: an empty
// project has its canvas resized to match THIS canvas, so the layer lands
// filling the frame at the origin instead of centred on whatever the
// project's canvas happened to be; a project with anything already in it
// is never resized, and the layer either lands at the origin (if the
// existing canvas already happens to be this exact size) or falls back to
// the ordinary cascade placement -- the same two-way split Import itself
// makes for a same-size PNG.
//
// No cropping: unlike CLayer, which pulls one piece out of a larger
// source, PCreate's own canvas typically IS the artwork's whole intended
// size (chosen deliberately, or imported whole), so the entire buffer is
// saved as-is, blank canvas or not.

function openLayerNameModal() {
  if (!session) return;
  els.pcreateLayerNameInput.value = session.savedCount === 0
    ? session.sourceName
    : `${session.sourceName}_${session.savedCount + 1}`;
  els.pcreateLayerNameModal.hidden = false;
  els.pcreateLayerNameInput.focus();
}

function closeLayerNameModal() {
  els.pcreateLayerNameModal.hidden = true;
}

function nextPlacement() {
  const offset = (session.savedCount % CASCADE_WRAP) * CASCADE_STEP;
  return {
    x: Math.floor((sceneStore.width - session.width) / 2) + offset,
    y: Math.floor((sceneStore.height - session.height) / 2) + offset,
  };
}

function saveAsLayer() {
  if (!session) return;
  const typed = els.pcreateLayerNameInput.value.trim();
  const name = typed || els.pcreateLayerNameInput.placeholder || session.sourceName;
  closeLayerNameModal();

  // The pixels are copied out here regardless of the destructive-vs-copy
  // setting: whatever PCreate does to its OWN working buffer in the future,
  // the Part that lands in the project is always an independent snapshot
  // at the moment of saving, exactly like every other layer-creating
  // action in the app (duplicate(), CLayer's own extraction).
  const pixels = new Uint8ClampedArray(session.pixels);
  const width = session.width;
  const height = session.height;

  // Checked fresh on every single save, not once when the window opened --
  // the same reason CLayer's own save reads partsStore.isEmpty inline: one
  // PCreate canvas could in principle be saved more than once, and only
  // the FIRST such save can land in a project that is still empty.
  const wasEmpty = partsStore.isEmpty;

  let created = null;
  history.run('PCreate: save as layer', () => {
    if (wasEmpty) sceneStore.setSize(width, height);
    const matchesCanvas = sceneStore.width === width && sceneStore.height === height;
    const placement = matchesCanvas ? { x: 0, y: 0 } : nextPlacement();

    created = partsStore.add(new Part({
      name,
      image: null,
      pixels,
      width,
      height,
      objectUrl: null,
      x: placement.x,
      y: placement.y,
      scale: 1,
      placement: matchesCanvas ? 'auto' : 'manual',
    }));
    partsStore.select(created.id);
  });

  session.savedCount += 1;
  showToast(`Saved "${created.name}" — ${width}×${height} px as a new layer.`);
}

// ---------------------------------------------------------------------------
// Test window: the same reason clayerDebug()/pxpinDebug() exist -- proving
// the camera, the colour state and the palette wiring live HERE, and that
// a completed save reaches partsStore, without a test reaching past this
// module's own boundary.
export function pcreateDebug() {
  if (!session) return null;
  return {
    kind: session.kind,
    width: session.width,
    height: session.height,
    zoom: session.cam.zoom,
    panX: session.cam.panX,
    panY: session.cam.panY,
    hsv: { ...session.hsv },
    hex: currentHex(),
    loadedPaletteName: session.loadedPaletteName,
    savedCount: session.savedCount,
    editInPlace,
  };
}

export async function pcreateListPalettes() {
  return refreshPaletteCache();
}

// The CURRENT working buffer's own colour at one texel, for tests --
// proving a camera move (zoom/pan) never touches the pixels themselves,
// the same non-destructive guarantee Px Pin, the Pierce painter and CLayer
// all already give their own camera.
export function pcreatePixelAt(u, v) {
  if (!session) return null;
  const index = (v * session.width + u) * 4;
  return [session.pixels[index], session.pixels[index + 1], session.pixels[index + 2], session.pixels[index + 3]];
}

// ---------------------------------------------------------------------------
// Wiring

export function initPCreate() {
  cacheElements();
  loadEditMode();

  els.pcreateBlankBtn.addEventListener('click', openSizeModal);
  els.pcreateImportBtn.addEventListener('click', openImportPicker);
  els.pcreateEntryCancelBtn.addEventListener('click', closeEntryModal);
  els.pcreateFileInput.addEventListener('change', onImportPicked);

  els.pcreateWidthInput.addEventListener('input', handleWidthInput);
  els.pcreateHeightInput.addEventListener('input', handleHeightInput);
  els.pcreateMirrorToggle.addEventListener('click', handleMirrorToggle);
  els.pcreateSizeCreateBtn.addEventListener('click', createBlankCanvas);
  els.pcreateSizeCancelBtn.addEventListener('click', closeSizeModal);

  els.pcreateDoneBtn.addEventListener('click', endSession);
  els.pcreateCanvas.addEventListener('pointerdown', onPointerDown);
  els.pcreateCanvas.addEventListener('pointermove', onPointerMove);
  els.pcreateCanvas.addEventListener('pointerup', onPointerUp);
  els.pcreateCanvas.addEventListener('pointercancel', onPointerUp);

  els.pcreateWheelCanvas.addEventListener('pointerdown', onWheelPointerDown);
  els.pcreateWheelCanvas.addEventListener('pointermove', onWheelPointerMove);
  els.pcreateWheelCanvas.addEventListener('pointerup', onWheelPointerUp);
  els.pcreateWheelCanvas.addEventListener('pointercancel', onWheelPointerUp);
  els.pcreateValueSlider.addEventListener('input', handleValueSlider);
  els.pcreateHexInput.addEventListener('input', handleHexInput);

  els.pcreateSaveColorBtn.addEventListener('click', handleSaveColor);
  els.pcreatePalettesBtn.addEventListener('click', openPaletteModal);
  els.pcreatePaletteDoneBtn.addEventListener('click', closePaletteModal);
  els.pcreateNewPaletteBtn.addEventListener('click', openNewPaletteModal);
  els.pcreateNameConfirmBtn.addEventListener('click', confirmNameModal);
  els.pcreateNameCancelBtn.addEventListener('click', closeNameModal);
  els.pcreateDeleteConfirmBtn.addEventListener('click', confirmDeletePalette);
  els.pcreateDeleteCancelBtn.addEventListener('click', closeDeleteModal);

  els.pcreateEditModeToggle.addEventListener('click', () => setEditMode(!editInPlace));

  els.pcreateSaveLayerBtn.addEventListener('click', openLayerNameModal);
  els.pcreateLayerNameConfirmBtn.addEventListener('click', saveAsLayer);
  els.pcreateLayerNameCancelBtn.addEventListener('click', closeLayerNameModal);

  window.addEventListener('resize', () => {
    if (!session) return;
    sizeCanvas();
    render();
  });
}
