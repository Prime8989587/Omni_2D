// PCreate: a dedicated window for painting a layer from scratch.
//
// WHAT LIVES HERE
//
// The window, two ways in (a blank canvas or an imported picture), the
// colour-picking and palette system, the full drawing toolkit -- brush,
// eraser, manual shading, three shapes, freehand Select with move/copy/
// delete, Rotate, Flip, Pick Color and Blend Colors -- and the path that
// turns the finished canvas into a real Scene Parts layer.
//
// THE ARITHMETIC IS NOT IN THIS FILE
//
// Every operation that actually touches texels lives in pixelops.js as a
// pure function, verified headlessly in tests/pixelops.mjs. This file's job
// is to decide WHICH operation a gesture means, hand it the buffer, and
// redraw -- never to do the pixel maths itself. That split is what lets a
// shape's outline or a rotation's exactness be checked against a hand-built
// fixture instead of squinted at on screen.
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
// ONE FINGER USES THE TOOL, TWO FINGERS MOVE THE VIEW -- the same input
// model Px Pin, the Pierce painter and CLayer already settled on, so there
// is one way to work a canvas in this app rather than four slightly
// different ones. A second finger arriving mid-stroke means the user meant
// to pinch all along, so that stroke is rolled back rather than left as a
// stray mark.
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
import { playEnter } from './transitions.js';
import { sceneStore, SCENE_PRESETS, MIN_SCENE_SIZE, MAX_SCENE_SIZE } from './scene.js';
import { history } from './history.js';
import { isPng, loadImage, readPixels, displayName } from './importer.js';
import * as storage from './storage.js';
import { hsvToRgb, rgbToHsv, rgbToHex, hexToRgb } from './color.js';
import {
  squareIndices, lineTexels, paintIndices, clearIndices,
  squareShape, circleShape, triangleShape,
  rotate90, flipPixels, rotateFree,
  regionBounds, extractRegion, blitRegion,
  blendAt, samplePixel,
  shadowIndices, suggestShadowColor,
  floodFillColor, uniqueColorsByHue,
} from './pixelops.js';
// The SAME undo/redo implementation the main canvas uses, as a second
// instance rather than a second mechanism -- see history.js's own comment
// on why a workspace that is not part of the project needs its own
// timeline rather than a place on the project's.
import { createHistory } from './history.js';
import { getSetting, setSetting, subscribeSettings } from './settings.js';

const MAX_ZOOM = 64; // css px per canvas px -- far past single-pixel work
const MAX_BRUSH = 10; // the biggest square a single touch-point covers
const GRID_MIN_CELL_PX = 12; // draw the pixel grid once cells are this big
const SELECTION_TINT = 'rgba(58, 219, 126, 0.28)';
const SELECTION_EDGE = '#3ADB6E';
const BOUNDARY_COLOR = 'rgba(255, 46, 147, 0.85)';
const SHAPE_PREVIEW = 'rgba(255, 255, 255, 0.45)';
const COPY_OFFSET = 4; // where a duplicate lands, so it is visibly its own thing

// The eight compass directions a drop shadow can fall in, as unit steps.
const SHADOW_DIRECTIONS = [
  { key: 'nw', dx: -1, dy: -1, label: '↖' },
  { key: 'n', dx: 0, dy: -1, label: '↑' },
  { key: 'ne', dx: 1, dy: -1, label: '↗' },
  { key: 'w', dx: -1, dy: 0, label: '←' },
  { key: 'e', dx: 1, dy: 0, label: '→' },
  { key: 'sw', dx: -1, dy: 1, label: '↙' },
  { key: 's', dx: 0, dy: 1, label: '↓' },
  { key: 'se', dx: 1, dy: 1, label: '↘' },
];

const TOOLS = [
  { key: 'brush', label: 'Brush' },
  { key: 'eraser', label: 'Eraser' },
  { key: 'fill', label: 'Fill' },
  { key: 'shade', label: 'Shade' },
  { key: 'circle', label: 'Circle' },
  { key: 'triangle', label: 'Triangle' },
  { key: 'square', label: 'Square' },
  { key: 'select', label: 'Select' },
  { key: 'pick', label: 'Pick Color' },
  { key: 'blend', label: 'Blend' },
];

const BRUSH_TOOLS = new Set(['brush', 'eraser', 'shade']);
const SHAPE_TOOLS = new Set(['circle', 'triangle', 'square']);
const SHAPE_FUNCTIONS = { circle: circleShape, triangle: triangleShape, square: squareShape };

// Above this many texels, the Auto Palette is only rebuilt when asked for
// rather than after every action. Scanning 256x256 is a fraction of a
// millisecond; scanning the 3072x3072 maximum is nine million texels and
// would be felt on every single brush stroke.
const AUTO_PALETTE_LIVE_LIMIT = 256 * 256;

// How much memory PCreate's undo stack may hold. The project's history can
// keep 60 entries cheaply because its pixel buffers are immutable and every
// snapshot shares them; a paint canvas is mutated in place, so each entry
// owns a full copy. At the 3072x3072 maximum that is 36 MB per step, and a
// flat 60-entry limit would be over two gigabytes. The depth is therefore
// derived from the canvas size instead: generous for the small canvases
// pixel art actually uses, and still a usable few steps at the extreme.
const UNDO_BYTE_BUDGET = 64 * 1024 * 1024;
const UNDO_MAX_STEPS = 60;
const UNDO_MIN_STEPS = 4;
const GRID_DARK = '#000000';
const GRID_LIGHT = '#262626';
const GRID_EDGE = 'rgba(255, 255, 255, 0.28)';

// Cascading placement for layers dropped into the current project, the
// same two numbers CLayer's own cascade uses -- a session that saves
// several canvases one after another should not stack them exactly on top
// of each other.
const CASCADE_STEP = 8;
const CASCADE_WRAP = 6;

const WHEEL_SIZE = 200;
const WHEEL_RADIUS = 96; // leaves room for the marker ring at full saturation

const els = {};
let session = null;
let blankMirror = false;
let toastTimer = null;
// Called whenever PCreate hands control back to the rest of the app --
// Back to Menu, Done, and Cancel on the entry dialog all funnel through
// here. PCreate has nowhere else of its own to fall back to now that it is
// a top-level destination reached straight from Home, so all three roads
// lead to the same place; ui.js supplies what that place actually is.
let exitCallback = () => {};
let settingsCallback = () => {};
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
    'pcreateFileInput', 'pcreateEntryModal', 'pcreateBlankBtn',
    'pcreateImportBtn', 'pcreateEntryCancelBtn',
    'pcreateSizeModal', 'pcreateSizePresets', 'pcreateWidthInput', 'pcreateHeightInput',
    'pcreateMirrorToggle', 'pcreateSizeCreateBtn', 'pcreateSizeCancelBtn',
    'pcreateWindow', 'pcreateBackToMenuBtn', 'pcreateSettingsBtn', 'pcreateCanvasLabel', 'pcreateStatus', 'pcreateDoneBtn', 'pcreateCanvas',
    'pcreateWheelCanvas', 'pcreateSwatch', 'pcreateValueSlider', 'pcreateValueLabel', 'pcreateHexInput',
    'pcreateLoadedPaletteName', 'pcreateSaveColorBtn', 'pcreatePalettesBtn', 'pcreateSwatchStrip',
    'pcreateEditModeToggle', 'pcreateSaveLayerBtn',
    'pcreateToolStrip', 'pcreateBrushRow', 'pcreateBrushBtn', 'pcreateBrushMenu',
    'pcreateShapeRow', 'pcreateShapeFilledBtn', 'pcreateShapeOutlineBtn',
    'pcreateFillHint', 'pcreatePickHint', 'pcreateBlendHint', 'pcreateSelectHint',
    'pcreateSelectionRow', 'pcreateSelectionStatus', 'pcreateSelCopyBtn',
    'pcreateSelDeleteBtn', 'pcreateSelDeselectBtn',
    'pcreateShadowDirs', 'pcreateShadowOffset', 'pcreateShadowOffsetLabel',
    'pcreateShadowSwatch', 'pcreateShadowUseCurrentBtn', 'pcreateShadowAutoBtn', 'pcreateShadowApplyBtn',
    'pcreateShadowToggleBtn', 'pcreateAutoStrip', 'pcreateAutoCount', 'pcreateAutoRefreshBtn',
    'pcreateUndoBtn', 'pcreateRedoBtn', 'pcreateSaveWorkBtn', 'pcreateResumeBtn',
    'pcreateTransformTarget', 'pcreateRotateCcwBtn', 'pcreateRotateCwBtn',
    'pcreateFlipHBtn', 'pcreateFlipVBtn', 'pcreateAngleSlider', 'pcreateAngleLabel', 'pcreateRotateFreeBtn',
    'pcreatePaletteModal', 'pcreatePaletteEmpty', 'pcreatePaletteList', 'pcreateNewPaletteBtn', 'pcreatePaletteDoneBtn',
    'pcreateNameModal', 'pcreateNameTitle', 'pcreateNameInput', 'pcreateNameConfirmBtn', 'pcreateNameCancelBtn',
    'pcreateLayerList', 'pcreateLayerCount', 'pcreateAddLayerBtn',
    'pcreateLayerDeleteModal', 'pcreateLayerDeleteMessage', 'pcreateLayerDeleteConfirmBtn', 'pcreateLayerDeleteCancelBtn',
    'pcreateExportModal', 'pcreateExportList', 'pcreateExportAllBtn', 'pcreateExportNoneBtn',
    'pcreateExportConfirmBtn', 'pcreateExportCancelBtn',
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
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, 4500);
}

// ---------------------------------------------------------------------------
// Entry: blank canvas, or import

export function openPCreate() {
  els.pcreateEntryModal.hidden = false;
  refreshResumeButton();
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
  // One empty layer to start on; makeLayer allocates its buffer (all zero,
  // so fully transparent) and its own bitmap.
  startSession({ kind: 'blank', name: `${width}×${height}`, width, height });
}

// ---- Import: the same decode-only pattern CLayer's own picker uses --
// never the app's main #fileInput, which would hand the pick straight to
// partsStore.

function openImportPicker() {
  closeEntryModal();
  els.pcreateFileInput.value = '';
  els.pcreateFileInput.click();
}

// MULTI-FILE, because already-layered artwork is normally handed over as
// one PNG per layer -- that is what every editor exports and what the main
// app's own import already accepts. A true layered container (PSD, ORA)
// would need a parser this app has no dependency for and no way to add
// offline, so several PNGs at once IS the layered-import path here rather
// than a lesser substitute for one.
async function onImportPicked(event) {
  const files = [...(event.target.files || [])];
  event.target.value = '';
  if (files.length === 0) return;

  const rejected = files.filter((f) => !isPng(f));
  const pngs = files.filter((f) => isPng(f));
  if (pngs.length === 0) {
    showToast(`${files[0].name} is not a PNG.`);
    return;
  }

  const decoded = [];
  for (const file of pngs) {
    try {
      const { image, objectUrl } = await loadImage(file);
      decoded.push({
        name: displayName(file.name),
        pixels: readPixels(image),
        width: image.naturalWidth,
        height: image.naturalHeight,
      });
      URL.revokeObjectURL(objectUrl); // the pixels are already copied out
    } catch (error) {
      console.warn(error);
      showToast(`Could not open ${file.name}.`);
    }
  }
  if (decoded.length === 0) return;

  // The canvas is sized to hold the LARGEST piece, and each piece keeps its
  // position relative to that frame. This is the same rule Import and
  // CLayer's save already follow: a picture that matches the canvas exactly
  // is position-preserving and lands at the origin, so a set of layers
  // exported at one common size reassembles itself precisely. Anything
  // smaller is centred, which is the only defensible guess when the file
  // itself carries no offset.
  const width = Math.max(...decoded.map((d) => d.width));
  const height = Math.max(...decoded.map((d) => d.height));

  // Sorted by name so a set exported as "01-body", "02-head" stacks in the
  // order the artist numbered them rather than in whatever order the file
  // picker happened to hand them over.
  decoded.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

  const layers = decoded.map((piece) => {
    const buffer = new Uint8ClampedArray(width * height * 4);
    const offsetX = piece.width === width ? 0 : Math.floor((width - piece.width) / 2);
    const offsetY = piece.height === height ? 0 : Math.floor((height - piece.height) / 2);
    for (let v = 0; v < piece.height; v++) {
      for (let u = 0; u < piece.width; u++) {
        const from = (v * piece.width + u) * 4;
        const to = ((v + offsetY) * width + (u + offsetX)) * 4;
        buffer[to] = piece.pixels[from];
        buffer[to + 1] = piece.pixels[from + 1];
        buffer[to + 2] = piece.pixels[from + 2];
        buffer[to + 3] = piece.pixels[from + 3];
      }
    }
    return makeLayer({ name: piece.name, width, height, pixels: buffer });
  });

  startSession({
    kind: 'import',
    name: decoded.length === 1 ? decoded[0].name : `${decoded.length} layers`,
    width,
    height,
    layers,
  });

  if (rejected.length) showToast(`Skipped ${rejected.length} file(s) that were not PNGs.`);
  else if (decoded.length > 1) showToast(`Imported ${decoded.length} pieces as separate layers.`);
}

// ---------------------------------------------------------------------------
// The layer stack
//
// PCreate's canvas is a stack of independent layers sharing one set of
// dimensions, the same shape the main scene's Parts list has. Every layer
// owns its own pixel buffer, its own on-screen bitmap, an opacity, and its
// own generated shadow -- a drop shadow belongs to the thing casting it, so
// it belongs to a layer rather than to the window.
//
// HOW EVERY EXISTING TOOL BECAME LAYER-AWARE WITHOUT BEING REWRITTEN
//
// The tools were all written against session.pixels, session.bitmap and
// session.shadow. Rather than editing every one of them to look up the
// active layer first -- dozens of call sites, each an opportunity to miss
// one and have a tool silently keep painting the old flat buffer --
// those three names are now ACCESSORS that forward to whichever layer is
// active. A brush stroke, a fill, a rotation and a shadow all land on the
// selected layer because there is no longer any other buffer for them to
// land on. Missing a call site is not possible, because there are no call
// sites to miss.
const LAYER_LIMIT = 24; // past this a phone-sized layer list stops being usable

let nextLayerId = 1;

function makeLayer({ name, width, height, pixels = null, opacity = 1 }) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const layer = {
    id: `L${nextLayerId++}`,
    name,
    pixels: pixels || new Uint8ClampedArray(width * height * 4),
    bitmap: canvas,
    opacity,
    shadow: null,
    shadowVisible: true,
    artworkDirty: true,
  };
  paintLayerBitmap(layer, width, height);
  return layer;
}

function paintLayerBitmap(layer, width, height) {
  const ctx = layer.bitmap.getContext('2d');
  const data = ctx.createImageData(width, height);
  data.data.set(layer.pixels);
  ctx.putImageData(data, 0, 0);
}

function activeLayer() {
  if (!session || !session.layers) return null;
  return session.layers.find((l) => l.id === session.activeLayerId) || session.layers[0] || null;
}

// layers[0] is the BOTTOM of the stack and is drawn first. The list in the
// UI runs top-first, matching the Scene Parts list, so it iterates this
// array reversed -- "up" in the list is later in the array.
function defineActiveLayerAccessors(target) {
  for (const key of ['pixels', 'bitmap', 'shadow', 'shadowVisible', 'artworkDirty']) {
    Object.defineProperty(target, key, {
      configurable: true,
      get() {
        const layer = activeLayer();
        return layer ? layer[key] : null;
      },
      set(value) {
        const layer = activeLayer();
        if (layer) layer[key] = value;
      },
    });
  }
}

function uniqueLayerName(base) {
  const taken = new Set(session.layers.map((l) => l.name));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base} ${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

// ---------------------------------------------------------------------------
// Session

function startSession({ kind, name, width, height, pixels, bitmap, layers = null }) {
  session = {
    kind,
    sourceName: name,
    width,
    height,
    layers: layers || [makeLayer({ name: 'Layer 1', width, height, pixels })],
    activeLayerId: null,
    openLayerMenuId: null,
    renamingLayerId: null,
    cam: { zoom: 1, panX: 0, panY: 0, rotation: 0 },
    pointers: new Map(),
    pinch: null,
    pan: null,
    hsv: { h: 0, s: 0, v: 1 }, // starts at white, same as an unset picker anywhere else
    loadedPaletteName: null,
    savedCount: 0,

    tool: 'brush',
    // Remembered from the PCreate settings section rather than reset to 1
    // on every canvas.
    brush: getSetting('defaultBrush'),
    brushMenuOpen: false,
    shapeFilled: true,
    stroke: null, // an in-progress brush stroke
    shapeDrag: null, // an in-progress shape drag: { from, to }
    boundary: new Set(), // Select's in-progress lasso line
    selection: null, // the committed selection, as a Set of texel indices
    selectionDrag: null, // an in-progress Move of that selection
    // The generated shadow's starting light direction and distance, from
    // settings, so an artist with a consistent light source configures it
    // once instead of on every canvas.
    shadowDirection: getSetting('shadowDirection'),
    shadowOffset: getSetting('shadowOffset'),
    shadowColor: null, // null means "recompute from the artwork on every apply"
    shadeToneSeeded: false,
    freeAngle: 0,

    // THE GENERATED SHADOW IS ITS OWN LAYER, NOT PAINTED INTO THE ARTWORK.
    //
    // That one decision is what makes the rest of the shadow behaviour fall
    // out for free. Regenerating replaces this set rather than adding to
    // whatever is already on the canvas, so a second press can never shadow
    // the first shadow and compound it. Hiding it is dropping it from the
    // composite for a frame, not erasing anything, so it comes back exactly
    // as it was. And the generator always reads session.pixels -- the
    // artwork alone -- so the silhouette it offsets is never contaminated
    // by a previous run's output.
    // shadow / shadowVisible / artworkDirty are NOT here: they belong to
    // whichever layer is active, and reach this object through the
    // accessors installed just below.
    autoPalette: [],
  };
  defineActiveLayerAccessors(session);
  session.activeLayerId = session.layers[session.layers.length - 1].id;

  els.pcreateCanvasLabel.textContent = name;
  els.pcreateWindow.hidden = false;
  playEnter(els.pcreateWindow); // the same transition every other screen uses

  sizeCanvas();
  fitCamera();
  renderEditModeToggle();
  drawWheel(); // builds wheelBitmap on first use -- must run before renderColorControls() paints onto it
  renderColorControls();
  renderSwatchStrip();
  renderShadowControls();
  pcreateHistory.reset();
  renderUndoRedo();
  rebuildAutoPalette();
  renderLayerList();
  renderTools();
  render();
}

function endSession() {
  els.pcreateWindow.hidden = true;
  session = null;
}

// ---------------------------------------------------------------------------
// Undo / redo
//
// The snapshot pair history.js's History class works in terms of, for
// PCreate's own state rather than the project's. Everything a drawing
// action can change is in here: the artwork, the canvas dimensions (a
// quarter turn swaps them), the generated shadow and whether it is showing,
// the dirty flag that governs regeneration, and the selection.
//
// The pixel buffer is COPIED on the way in. The project can share its
// buffers between snapshots because they are immutable once imported; these
// are painted on in place, so a shared reference would leave every entry on
// the stack pointing at the same, latest artwork -- an undo stack that
// restores exactly what you already have.

function snapshotSession() {
  if (!session) return null;
  return {
    width: session.width,
    height: session.height,
    activeLayerId: session.activeLayerId,
    layers: session.layers.map((layer) => ({
      id: layer.id,
      name: layer.name,
      opacity: layer.opacity,
      pixels: new Uint8ClampedArray(layer.pixels),
      shadow: layer.shadow
        ? { indices: [...layer.shadow.indices], color: [...layer.shadow.color] }
        : null,
      shadowVisible: layer.shadowVisible,
      artworkDirty: layer.artworkDirty,
    })),
    selection: session.selection ? [...session.selection] : null,
  };
}

function restoreSession(snapshot) {
  if (!session || !snapshot) return;
  const sizeChanged = snapshot.width !== session.width || snapshot.height !== session.height;
  session.width = snapshot.width;
  session.height = snapshot.height;

  session.layers = snapshot.layers.map((saved) => {
    const canvas = document.createElement('canvas');
    canvas.width = snapshot.width;
    canvas.height = snapshot.height;
    const layer = {
      id: saved.id,
      name: saved.name,
      opacity: saved.opacity,
      pixels: new Uint8ClampedArray(saved.pixels),
      bitmap: canvas,
      shadow: saved.shadow
        ? { indices: new Set(saved.shadow.indices), color: [...saved.shadow.color] }
        : null,
      shadowVisible: saved.shadowVisible,
      artworkDirty: saved.artworkDirty,
    };
    paintLayerBitmap(layer, snapshot.width, snapshot.height);
    return layer;
  });
  session.activeLayerId = snapshot.activeLayerId;
  if (!activeLayer() && session.layers.length) session.activeLayerId = session.layers[0].id;
  session.selection = snapshot.selection ? new Set(snapshot.selection) : null;

  if (sizeChanged) fitCamera();
  refreshAutoPalette();
  renderLayerList();
  renderTools();
  render();
}

const pcreateHistory = createHistory({
  serialize: snapshotSession,
  apply: restoreSession,
  limit: () => {
    if (!session) return UNDO_MAX_STEPS;
    // Two buffers per entry (History keeps a `before` and an `after`, and
    // they are separate copies even where neighbouring entries hold the
    // same picture) TIMES the number of layers, since a snapshot now
    // carries the whole stack.
    const layerCount = Math.max(1, session.layers ? session.layers.length : 1);
    const bytesPerStep = session.width * session.height * 4 * 2 * layerCount;
    if (bytesPerStep <= 0) return UNDO_MAX_STEPS;
    const affordable = Math.floor(UNDO_BYTE_BUDGET / bytesPerStep);
    return Math.max(UNDO_MIN_STEPS, Math.min(UNDO_MAX_STEPS, affordable));
  },
});

// Every mutating tool goes through here, so there is exactly one place that
// remembers to mark the artwork dirty for the shadow generator and to keep
// the Auto Palette current. A tool that forgot either would be a silent bug
// -- a shadow that refuses to regenerate, or a palette missing a colour.
function runAction(label, mutate) {
  if (!session) return;
  pcreateHistory.run(label, () => {
    mutate();
    session.artworkDirty = true;
  });
  refreshAutoPalette();
  renderUndoRedo();
}

function renderUndoRedo() {
  els.pcreateUndoBtn.disabled = !pcreateHistory.canUndo;
  els.pcreateRedoBtn.disabled = !pcreateHistory.canRedo;
  els.pcreateUndoBtn.title = pcreateHistory.undoLabel ? `Undo ${pcreateHistory.undoLabel}` : 'Nothing to undo';
  els.pcreateRedoBtn.title = pcreateHistory.redoLabel ? `Redo ${pcreateHistory.redoLabel}` : 'Nothing to redo';
}

function undoPCreate() {
  const label = pcreateHistory.undo();
  renderUndoRedo();
  showToast(label ? `Undid ${label}.` : 'Nothing to undo.');
}

function redoPCreate() {
  const label = pcreateHistory.redo();
  renderUndoRedo();
  showToast(label ? `Redid ${label}.` : 'Nothing to redo.');
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

// Two-finger viewport rotation, the same idea as the main canvas's (see
// view.js): camera only, so not one texel of artwork is touched, and the
// context is turned once per frame so everything drawn goes round together.
const ROTATE_DEAD_ZONE = 0.14; // ~8 degrees, so ordinary hand roll is ignored
const ROTATE_MIN_SPAN_PX = 40; // two close fingers give a useless angle
// See view.js's own ZOOM_LOCK_LOG_RATIO for why this exists: a real
// pinch-to-zoom's span changes by a lot while the fingers naturally arc a
// little as the wrist spreads them -- correlated noise, not jitter, so it
// does not average out and can carry an ordinary zoom's angle right past
// the dead zone. Once a gesture's span has moved this far (log-scaled, so
// zooming in or out count the same) from where it started, it reads as an
// intentional zoom and can never engage rotation, however much angle
// keeps piling up.
const ZOOM_LOCK_LOG_RATIO = Math.log(1.4);

function rotateAbout(x, y, angle) {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return { x: x * cos - y * sin, y: x * sin + y * cos };
}

function shortestAngle(radians) {
  let angle = radians;
  while (angle > Math.PI) angle -= Math.PI * 2;
  while (angle < -Math.PI) angle += Math.PI * 2;
  return angle;
}

function fitCamera() {
  const { width, height, cam } = session;
  const zoom = Math.min(session.cssWidth / width, session.cssHeight / height) * 0.9;
  cam.zoom = Math.min(MAX_ZOOM, zoom);
  session.minZoom = cam.zoom * 0.5;
  cam.panX = (session.cssWidth - width * cam.zoom) / 2;
  cam.panY = (session.cssHeight - height * cam.zoom) / 2;
  // Fit means "put the view back", so it straightens it too -- the same
  // way out of a rotation the main canvas offers.
  cam.rotation = 0;
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

  // The camera's angle, applied once to the context so the checkerboard,
  // every layer, the texel grid and the tool previews all turn together.
  // The backdrop above is outside it, so a turned view has no bare corners.
  if (cam.rotation !== 0) {
    ctx.translate(session.cssWidth / 2, session.cssHeight / 2);
    ctx.rotate(cam.rotation);
    ctx.translate(-session.cssWidth / 2, -session.cssHeight / 2);
  }

  drawGrid(ctx);

  // Bottom of the stack first. Each layer's shadow is drawn immediately
  // before that layer's own artwork, so the shadow sits under the thing
  // casting it while still falling over everything below -- which is what
  // a stack of cut-out sheets each casting onto the one beneath looks
  // like.
  for (const layer of session.layers) {
    if (layer.opacity <= 0) continue;
    ctx.globalAlpha = layer.opacity;
    if (layer.shadow && layer.shadowVisible) {
      const [r, g, b, a] = layer.shadow.color;
      drawIndexSet(ctx, layer.shadow.indices, `rgba(${r}, ${g}, ${b}, ${a / 255})`, null);
    }
    ctx.drawImage(layer.bitmap, cam.panX, cam.panY, width * cam.zoom, height * cam.zoom);
  }
  ctx.globalAlpha = 1;

  // The per-texel grid, once cells are big enough to aim a single pixel at
  // -- the same threshold CLayer and the Pierce painter already use.
  if (cam.zoom >= GRID_MIN_CELL_PX) {
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let u = 0; u <= width; u++) {
      const x = u * cam.zoom + cam.panX;
      ctx.moveTo(x, cam.panY);
      ctx.lineTo(x, height * cam.zoom + cam.panY);
    }
    for (let v = 0; v <= height; v++) {
      const y = v * cam.zoom + cam.panY;
      ctx.moveTo(cam.panX, y);
      ctx.lineTo(width * cam.zoom + cam.panX, y);
    }
    ctx.stroke();
  }

  if (session.selection) drawIndexSet(ctx, session.selection, SELECTION_TINT, SELECTION_EDGE);
  if (session.boundary.size) drawIndexSet(ctx, session.boundary, BOUNDARY_COLOR, null);
  if (session.shapeDrag) {
    const preview = SHAPE_FUNCTIONS[session.tool](
      session.shapeDrag.from, session.shapeDrag.to, width, height, session.shapeFilled
    );
    drawIndexSet(ctx, preview, SHAPE_PREVIEW, null);
  }

  const selectionNote = session.selection ? ` · ${session.selection.size} px selected` : '';
  els.pcreateStatus.textContent =
    `${width}×${height} · ${Math.round(cam.zoom * 100)}%${selectionNote}`;
}

function drawIndexSet(ctx, indices, fill, edge) {
  const { cam, width } = session;
  const size = cam.zoom;
  ctx.fillStyle = fill;
  for (const index of indices) {
    const u = index % width;
    const v = (index - u) / width;
    const x = u * size + cam.panX;
    const y = v * size + cam.panY;
    if (x + size < 0 || y + size < 0 || x > session.cssWidth || y > session.cssHeight) continue;
    ctx.fillRect(x, y, size, size);
    if (edge && size >= 6) {
      ctx.strokeStyle = edge;
      ctx.lineWidth = Math.min(2, Math.max(1, size / 10));
      ctx.strokeRect(x + 0.5, y + 0.5, size - 1, size - 1);
    }
  }
}

// The one place the working buffer and the on-screen bitmap are brought
// back into agreement. Every tool writes to session.pixels and then calls
// this; nothing paints onto the bitmap directly, so the two can never
// disagree about what has actually been drawn.
function syncBitmap() {
  const ctx = session.bitmap.getContext('2d');
  const imageData = ctx.createImageData(session.width, session.height);
  imageData.data.set(session.pixels);
  ctx.putImageData(imageData, 0, 0);
}

// The artwork with the shadow layer merged underneath it -- what the canvas
// actually LOOKS like, as opposed to session.pixels, which is the artwork
// alone. Anything leaving PCreate (Save as Layer, a saved session) takes
// this; anything generating a shadow takes session.pixels, so the silhouette
// it reads is never contaminated by a previous shadow.
//
// A hidden shadow is genuinely absent from the result: if the artist has
// toggled it off, it is not part of the picture they are looking at, and
// baking it into an exported layer anyway would be a surprise.
function compositePixels() {
  const total = session.width * session.height;
  const out = new Uint8ClampedArray(total * 4);

  const over = (index, r, g, b, a) => {
    if (a <= 0) return;
    const o = index * 4;
    const dstA = out[o + 3] / 255;
    const srcA = a / 255;
    const outA = srcA + dstA * (1 - srcA);
    if (outA <= 0) return;
    out[o] = Math.round((r * srcA + out[o] * dstA * (1 - srcA)) / outA);
    out[o + 1] = Math.round((g * srcA + out[o + 1] * dstA * (1 - srcA)) / outA);
    out[o + 2] = Math.round((b * srcA + out[o + 2] * dstA * (1 - srcA)) / outA);
    out[o + 3] = Math.round(outA * 255);
  };

  for (const layer of session.layers) {
    if (layer.opacity <= 0) continue;
    if (layer.shadow && layer.shadowVisible) {
      const [sr, sg, sb, sa] = layer.shadow.color;
      for (const index of layer.shadow.indices) {
        if (layer.pixels[index * 4 + 3] !== 0) continue; // the art wins where they meet
        over(index, sr, sg, sb, sa * layer.opacity);
      }
    }
    for (let index = 0; index < total; index++) {
      const o = index * 4;
      const a = layer.pixels[o + 3];
      if (a === 0) continue;
      over(index, layer.pixels[o], layer.pixels[o + 1], layer.pixels[o + 2], a * layer.opacity);
    }
  }
  return out;
}

// One layer on its own, flattened with its own opacity and shadow -- what
// Import to Main hands the project for a single selected layer.
function compositeLayer(layer) {
  const total = session.width * session.height;
  const out = new Uint8ClampedArray(total * 4);
  if (layer.shadow && layer.shadowVisible) {
    const [sr, sg, sb, sa] = layer.shadow.color;
    for (const index of layer.shadow.indices) {
      if (layer.pixels[index * 4 + 3] !== 0) continue;
      const o = index * 4;
      out[o] = sr; out[o + 1] = sg; out[o + 2] = sb;
      out[o + 3] = Math.round(sa * layer.opacity);
    }
  }
  for (let index = 0; index < total; index++) {
    const o = index * 4;
    const a = layer.pixels[o + 3];
    if (a === 0) continue;
    out[o] = layer.pixels[o];
    out[o + 1] = layer.pixels[o + 1];
    out[o + 2] = layer.pixels[o + 2];
    out[o + 3] = Math.round(a * layer.opacity);
  }
  return out;
}

// Rebuild the canvas element and camera after an operation that changed the
// buffer's DIMENSIONS -- only a quarter turn of a non-square canvas does
// that, but it invalidates the bitmap, the zoom fit and the checkerboard
// tile all at once.
function adoptSize(width, height) {
  session.width = width;
  session.height = height;
  for (const layer of session.layers) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    layer.bitmap = canvas;
    paintLayerBitmap(layer, width, height);
  }
  fitCamera();
}

// ---------------------------------------------------------------------------
// Input: one finger uses the tool, two fingers move the view

function canvasPoint(event) {
  const rect = els.pcreateCanvas.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

// texelAt floors to a whole texel, which is what painting wants. The pinch
// anchor needs the exact fractional position instead, or the view creeps by
// up to a texel every frame of a long gesture.
function texelPointAt(point) {
  const { cam } = session;
  let { x, y } = point;
  if (cam.rotation !== 0) {
    const cx = session.cssWidth / 2;
    const cy = session.cssHeight / 2;
    const p = rotateAbout(x - cx, y - cy, -cam.rotation);
    x = p.x + cx;
    y = p.y + cy;
  }
  return { x: (x - cam.panX) / cam.zoom, y: (y - cam.panY) / cam.zoom };
}

function texelAt(point) {
  const { cam } = session;
  let { x, y } = point;
  // A tap is on the glass; the camera's pan and zoom live in the unturned
  // frame the renderer draws in, so the tap is turned back before it is
  // measured. Without this, painting on a rotated view lands somewhere
  // other than under the finger.
  if (cam.rotation !== 0) {
    const cx = session.cssWidth / 2;
    const cy = session.cssHeight / 2;
    const p = rotateAbout(x - cx, y - cy, -cam.rotation);
    x = p.x + cx;
    y = p.y + cy;
  }
  return {
    u: Math.floor((x - cam.panX) / cam.zoom),
    v: Math.floor((y - cam.panY) / cam.zoom),
  };
}

function inCanvas(texel) {
  return texel.u >= 0 && texel.v >= 0 && texel.u < session.width && texel.v < session.height;
}

// ---------------------------------------------------------------------------
// The two gesture shortcuts from the PCreate settings section
//
// Both exist so a drawing tool can reach Fill and Pick Color without a trip
// to the tool strip, and both are off the critical path: with their setting
// off, not one line of this runs and the pointer handlers behave exactly as
// they did before.
//
// DOUBLE-TAP TO FILL HAS TO UNDO THE FIRST TAP
//
// This is the whole subtlety of the feature. By the time a second tap
// identifies the gesture as a double tap, the FIRST tap has already been
// committed as a brush dot -- so the texel under the finger is now painted
// in the current colour, and a flood fill seeded there would find a region
// of exactly the pixels that tap just painted. The user would double-tap a
// large area and watch a single dot change colour.
//
// So the double tap rolls the first tap back through the existing undo
// stack before filling. That restores the texel to whatever it genuinely
// was, which is what the flood fill has to read to find the right region.
// Reusing undo rather than snapshotting the colour by hand also handles a
// wide brush, where the first tap painted a whole square, not one texel.

const DOUBLE_TAP_MS = 320;
const DOUBLE_TAP_SLOP_PX = 24; // a finger never lands twice in exactly one spot
const LONG_PRESS_MS = 500;
const LONG_PRESS_SLOP_PX = 10; // beyond this it is a stroke, not a hold

let lastTap = null; // { u, v, x, y, at }
let longPressTimer = null;
let longPressFired = false;
// Where the current press landed. Tracked separately from lastTap, which
// only exists while double-tap-to-fill is switched on -- the hold has to
// know how far the finger has travelled whatever the other setting says.
let pressOrigin = null;

function cancelLongPress() {
  clearTimeout(longPressTimer);
  longPressTimer = null;
}

function armLongPress(point, texel) {
  cancelLongPress();
  longPressFired = false;
  pressOrigin = { x: point.x, y: point.y };
  if (!getSetting('longPressPick')) return;
  if (!inCanvas(texel)) return;
  // Only from a tool that draws. From Pick Color itself the gesture is
  // already what a plain tap does, and from Select it would fight the
  // lasso the finger is in the middle of laying down.
  if (!BRUSH_TOOLS.has(session.tool) && !SHAPE_TOOLS.has(session.tool)) return;
  longPressTimer = setTimeout(() => {
    longPressTimer = null;
    if (!session || session.pointers.size !== 1) return;
    longPressFired = true;
    // The stroke the hold began is discarded rather than committed: the
    // user asked to sample a colour, not to leave a dot where they sampled.
    abandonGesture();
    pickColorAt(texel);
    render();
  }, LONG_PRESS_MS);
}

// True when this press completes a double tap and the fill has been done,
// in which case the caller must not also start a normal gesture.
function tryDoubleTapFill(point, texel) {
  if (!getSetting('doubleTapFill')) return false;
  if (!inCanvas(texel)) return false;
  if (!BRUSH_TOOLS.has(session.tool) && !SHAPE_TOOLS.has(session.tool)) return false;

  const now = performance.now();
  const previous = lastTap;
  // The undo depth is recorded BEFORE this press does anything, so a press
  // that turns out to be the first of a pair can be told apart from one
  // that committed nothing -- see the undo below.
  lastTap = {
    u: texel.u, v: texel.v, x: point.x, y: point.y, at: now,
    depth: pcreateHistory.undoDepth,
  };
  if (!previous) return false;
  if (now - previous.at > DOUBLE_TAP_MS) return false;
  if (Math.hypot(point.x - previous.x, point.y - previous.y) > DOUBLE_TAP_SLOP_PX) return false;

  lastTap = null; // a third tap starts a fresh pair, not another fill
  // Roll the first tap's mark back, so the fill reads the artwork as it was
  // before this gesture started -- but ONLY if that tap is genuinely what
  // sits on top of the undo stack. A brush dot always commits, so in the
  // common case it is; a tool that declines to (a shape drag that never
  // left its start texel, say) leaves the stack untouched, and undoing then
  // would throw away whatever unrelated action was underneath. Comparing
  // the depth this press recorded against the depth now settles that
  // exactly. A label comparison could not: two brush strokes in a row carry
  // the same label, so an unchanged label proves nothing either way.
  if (pcreateHistory.undoDepth === previous.depth + 1) undoPCreate();
  fillAt(texel);
  return true;
}

function onPointerDown(event) {
  if (!session) return;
  event.preventDefault();
  try { els.pcreateCanvas.setPointerCapture(event.pointerId); } catch { /* no-op: no live pointer in tests */ }
  const point = canvasPoint(event);
  session.pointers.set(event.pointerId, point);

  if (session.pointers.size === 1) {
    session.pinch = null;
    const texel = texelAt(point);
    if (tryDoubleTapFill(point, texel)) return;
    beginToolGesture(point);
    armLongPress(point, texel);
  } else if (session.pointers.size === 2) {
    cancelLongPress();
    // The second finger means the camera, so whatever the first one had
    // started is rolled back rather than committed as a stray mark.
    abandonGesture();
    const [a, b] = [...session.pointers.values()];
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    session.pinch = {
      distance: Math.hypot(b.x - a.x, b.y - a.y),
      angle: Math.atan2(b.y - a.y, b.x - a.x),
      zoom: session.cam.zoom,
      rotation: session.cam.rotation,
      mid,
      panX: session.cam.panX,
      panY: session.cam.panY,
      // The texel under the fingers when the gesture began. Everything the
      // gesture does is then expressed as "keep this one under them".
      held: texelPointAt(mid),
      twist: 0,
      twisting: false,
      rotationLocked: false,
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
    const pinch = session.pinch;
    const distance = Math.hypot(b.x - a.x, b.y - a.y);
    const factor = distance / Math.max(1, pinch.distance);
    const zoom = Math.min(MAX_ZOOM, Math.max(session.minZoom, pinch.zoom * factor));
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    session.cam.zoom = zoom;

    // The twist, once the gesture has clearly asked for one rather than
    // simply rolled a little while spreading.
    if (distance >= ROTATE_MIN_SPAN_PX && pinch.distance >= ROTATE_MIN_SPAN_PX) {
      if (!pinch.twisting
        && Math.abs(Math.log(distance / pinch.distance)) > ZOOM_LOCK_LOG_RATIO) {
        pinch.rotationLocked = true;
      }
      pinch.twist = shortestAngle(Math.atan2(b.y - a.y, b.x - a.x) - pinch.angle);
      if (!pinch.rotationLocked && !pinch.twisting && Math.abs(pinch.twist) >= ROTATE_DEAD_ZONE) {
        pinch.twisting = true;
      }
      if (pinch.twisting) session.cam.rotation = shortestAngle(pinch.rotation + pinch.twist);
    }

    // Solve pan LAST, from the texel that has to stay under the fingers:
    // one statement covers scaling about them, turning about them and
    // following them, with no step left to undo another step's drift.
    const cx = session.cssWidth / 2;
    const cy = session.cssHeight / 2;
    const back = rotateAbout(mid.x - cx, mid.y - cy, -session.cam.rotation);
    session.cam.panX = back.x + cx - pinch.held.x * zoom;
    session.cam.panY = back.y + cy - pinch.held.y * zoom;
    render();
    return;
  }

  if (session.pointers.size === 1) {
    // A finger that has travelled is drawing, not holding. Cancelling on
    // distance rather than on any movement at all is what makes the hold
    // survive the small tremor every real finger has.
    if (longPressTimer && pressOrigin
      && Math.hypot(point.x - pressOrigin.x, point.y - pressOrigin.y) > LONG_PRESS_SLOP_PX) {
      cancelLongPress();
    }
    // Once the hold has sampled a colour the gesture is spent: continuing
    // to paint from it would leave a stroke the user never asked for.
    if (!longPressFired) extendToolGesture(point);
  }
}

function onPointerUp(event) {
  if (!session || !session.pointers.has(event.pointerId)) return;
  cancelLongPress();
  session.pointers.delete(event.pointerId);
  if (session.pointers.size < 2) session.pinch = null;
  if (session.pointers.size === 0) {
    if (longPressFired) {
      longPressFired = false;
      // Already abandoned when the hold fired; ending the gesture again
      // would commit an empty stroke as an undo step.
      return;
    }
    endToolGesture();
  }
}

// ---- Gesture routing ----------------------------------------------------
//
// Three shapes of gesture, and every tool is one of them: a continuous
// stroke (brush, eraser, shade, and Select's lasso), a drag between two
// corners (the three shapes, and moving a selection), or a single tap
// (Pick Color, Blend, and deselecting).

function beginToolGesture(point) {
  const texel = texelAt(point);

  if (BRUSH_TOOLS.has(session.tool)) { beginStroke(texel); return; }
  if (SHAPE_TOOLS.has(session.tool)) { session.shapeDrag = { from: texel, to: texel }; render(); return; }
  if (session.tool === 'fill') { fillAt(texel); return; }
  if (session.tool === 'pick') { pickColorAt(texel); return; }
  if (session.tool === 'blend') { blendNear(point); return; }

  if (session.tool === 'select') {
    // A press INSIDE an existing selection starts moving it; anywhere else
    // drops that selection and starts drawing a new lasso. Tapping outside
    // is how a selection is dismissed without hunting for a button, which
    // is the behaviour the tool was asked for.
    if (session.selection && inCanvas(texel) && session.selection.has(texel.v * session.width + texel.u)) {
      beginSelectionMove(texel);
      return;
    }
    if (session.selection) {
      session.selection = null;
      renderTools();
    }
    beginStroke(texel);
  }
}

function extendToolGesture(point) {
  const texel = texelAt(point);
  if (session.stroke) { extendStroke(texel); return; }
  if (session.shapeDrag) { session.shapeDrag.to = texel; render(); return; }
  if (session.selectionDrag) { extendSelectionMove(texel); return; }
}

function endToolGesture() {
  if (session.stroke) { endStroke(); return; }
  if (session.shapeDrag) { commitShape(); return; }
  if (session.selectionDrag) { endSelectionMove(); return; }
}

function abandonGesture() {
  if (session.stroke) rollBackStroke();
  session.shapeDrag = null;
  if (session.selectionDrag) rollBackSelectionMove();
  render();
}

// ---- Strokes: brush, eraser, manual shading, and Select's lasso ---------
//
// All four are the same gesture over the same interpolated run of texels;
// only what a texel becomes differs. Every stroke records what it
// overwrote, so a second finger arriving mid-stroke can put it back
// exactly -- the same rollback Px Pin, the Pierce painter and CLayer all
// already do.

function beginStroke(texel) {
  session.stroke = {
    last: null,
    before: new Map(), // index -> the four bytes that were there first
    boundaryBefore: new Set(),
    changed: false,
    // A drag across dozens of pointermove frames is ONE undo step. This is
    // the same capture/commit pair the main canvas uses for dragging a
    // layer, for exactly the same reason.
    token: pcreateHistory.capture(session.tool === 'select' ? 'Select' : strokeLabel()),
  };
  applyStrokeAt([texel]);
  session.stroke.last = texel;
  render();
}

function extendStroke(texel) {
  const last = session.stroke.last;
  if (last && texel.u === last.u && texel.v === last.v) return;
  applyStrokeAt(last ? lineTexels(last, texel) : [texel]);
  session.stroke.last = texel;
  render();
}

function applyStrokeAt(texels) {
  const { stroke } = session;
  for (const { u, v } of texels) {
    const indices = squareIndices(u, v, session.brush, session.width, session.height);
    if (session.tool === 'select') {
      // The lasso writes to its own overlay set, never to the artwork.
      for (const index of indices) {
        if (session.boundary.has(index)) continue;
        session.boundary.add(index);
        stroke.boundaryBefore.add(index);
        stroke.changed = true;
      }
      continue;
    }
    for (const index of indices) {
      if (!stroke.before.has(index)) {
        const o = index * 4;
        stroke.before.set(index, [
          session.pixels[o], session.pixels[o + 1], session.pixels[o + 2], session.pixels[o + 3],
        ]);
      }
    }
    if (session.tool === 'eraser') clearIndices(session.pixels, indices);
    else paintIndices(session.pixels, indices, strokeColor());
    stroke.changed = true;
  }
  if (session.tool !== 'select') syncBitmap();
}

// Brush and Shade both paint the current colour. They are still separate
// tools rather than one tool with a modifier, because they are separate
// INTENTIONS -- "put this colour here" and "darken this area by hand" --
// and Shade defaults its colour to the shading tone rather than the
// drawing tone the moment it is picked. See selectTool().
function strokeColor() {
  const { r, g, b } = currentRgb();
  return [r, g, b, 255];
}

function strokeLabel() {
  if (session.tool === 'eraser') return 'Erase';
  if (session.tool === 'shade') return 'Shade';
  return 'Brush';
}

function endStroke() {
  const stroke = session.stroke;
  session.stroke = null;
  if (!stroke) return;
  if (session.tool === 'select') commitLasso();
  // Drawing a lasso changes the SELECTION, not the artwork, so it is an
  // undo step but not a reason for the shadow to regenerate. Moving,
  // deleting or transforming that selection afterwards is, and those go
  // through runAction() like every other artwork edit.
  if (stroke.changed && session.tool !== 'select') session.artworkDirty = true;
  pcreateHistory.commitCapture(stroke.token, stroke.changed);
  if (stroke.changed) refreshAutoPalette();
  renderUndoRedo();
  render();
}

function rollBackStroke() {
  const stroke = session.stroke;
  session.stroke = null;
  if (!stroke) return;
  for (const [index, bytes] of stroke.before) {
    const o = index * 4;
    session.pixels[o] = bytes[0];
    session.pixels[o + 1] = bytes[1];
    session.pixels[o + 2] = bytes[2];
    session.pixels[o + 3] = bytes[3];
  }
  for (const index of stroke.boundaryBefore) session.boundary.delete(index);
  if (stroke.before.size) syncBitmap();
}

// ---- Shapes -------------------------------------------------------------

function commitShape() {
  const drag = session.shapeDrag;
  session.shapeDrag = null;
  if (!drag) return;
  const indices = SHAPE_FUNCTIONS[session.tool](
    drag.from, drag.to, session.width, session.height, session.shapeFilled
  );
  if (indices.size === 0) { render(); return; }
  const label = session.tool.charAt(0).toUpperCase() + session.tool.slice(1);
  runAction(label, () => {
    paintIndices(session.pixels, indices, strokeColor());
    syncBitmap();
  });
  render();
}

// ---- Select: CLayer's lasso, without CLayer's fill-and-extract step ------
//
// CLayer asks the user to draw a boundary and THEN tap inside it to fill,
// because there the fill is the thing being extracted and it matters
// exactly which enclosed area was meant. Here the loop IS the selection, so
// the extra tap would be ceremony: closing the loop is the whole gesture.
//
// That means the interior has to be found without being pointed at. The
// bounding box's own centre is tried first because a lasso is usually drawn
// around something roughly convex, and any other interior texel is tried
// after -- a crescent or an L-shape can easily have its centre sitting
// outside itself. If every candidate leaks to the edge of the canvas, the
// loop genuinely is not closed, which is the same verdict CLayer reaches
// by the same test.
function commitLasso() {
  const boundary = session.boundary;
  if (boundary.size === 0) return;

  const interior = findEnclosedArea(boundary);
  session.boundary = new Set();

  if (!interior) {
    showToast(
      'That loop isn’t closed — the selection escaped to the edge of the canvas. ' +
      'Draw one unbroken line all the way around the area.'
    );
    renderTools();
    return;
  }

  // The traced line belongs to what was circled: a user who draws around a
  // shape means the shape AND the line they drew around it, not the shape
  // with a one-texel gap bitten out of its rim.
  for (const index of boundary) interior.add(index);
  session.selection = interior;
  renderTools();
  showToast(`${interior.size} px selected.`);
}

// THE SAME CLOSEDNESS TEST AS CLAYER'S, RUN FROM THE OUTSIDE IN
//
// CLayer asks "can a fill started HERE reach the edge of the image?" and
// calls the boundary closed when it cannot. That needs a seed, which is why
// CLayer has the user tap one. Select has no tap to spend, so it runs the
// identical test in complement: flood the OUTSIDE, 4-connected, starting
// from every border texel and never stepping onto the boundary. Whatever
// the outside cannot reach is, by exactly CLayer's definition, enclosed.
//
// Two things fall out of doing it this way rather than by trying seeds
// until one works. It is a single pass over the canvas instead of one flood
// per candidate seed -- an open lasso over a large area would otherwise
// re-run a failing fill for every texel in its bounding box, which is slow
// enough to freeze the window. And it finds EVERY enclosed pocket at once,
// so a lasso drawn as a figure-eight selects both of its loops rather than
// whichever one a seed happened to land in.
//
// 4-connected for the same reason CLayer is: a brush stroke's texels are at
// least diagonally adjacent, which already blocks a 4-connected flood, and
// letting the flood move diagonally would unpick that seal.
function findEnclosedArea(boundary) {
  const { width, height } = session;
  const outside = new Set();
  const stack = [];

  const consider = (u, v) => {
    if (u < 0 || v < 0 || u >= width || v >= height) return;
    const index = v * width + u;
    if (outside.has(index) || boundary.has(index)) return;
    outside.add(index);
    stack.push(index);
  };

  for (let u = 0; u < width; u++) { consider(u, 0); consider(u, height - 1); }
  for (let v = 0; v < height; v++) { consider(0, v); consider(width - 1, v); }

  while (stack.length) {
    const index = stack.pop();
    const u = index % width;
    const v = (index - u) / width;
    consider(u - 1, v);
    consider(u + 1, v);
    consider(u, v - 1);
    consider(u, v + 1);
  }

  const interior = new Set();
  const total = width * height;
  for (let index = 0; index < total; index++) {
    if (!outside.has(index) && !boundary.has(index)) interior.add(index);
  }
  return interior.size ? interior : null;
}

// ---- Moving a selection -------------------------------------------------
//
// Lifted on the way down, previewed as it moves, committed on the way up.
// Lifting first is what lets a selection be dragged ACROSS its own former
// position without the trailing copy of itself that a move-by-repeated-
// copy would leave behind.

function beginSelectionMove(texel) {
  // Captured before the lift below clears the source texels, so undo goes
  // back to the selection sitting where it started.
  const token = pcreateHistory.capture('Move selection');
  const bounds = regionBounds(session.selection, session.width);
  const region = extractRegion(session.pixels, session.width, session.selection, bounds);
  clearIndices(session.pixels, session.selection);
  syncBitmap();
  session.selectionDrag = {
    origin: texel,
    bounds,
    region,
    dx: 0,
    dy: 0,
    original: new Set(session.selection),
    token,
  };
  session.selection = null;
  renderPreviewOfDrag();
}

function extendSelectionMove(texel) {
  const drag = session.selectionDrag;
  drag.dx = texel.u - drag.origin.u;
  drag.dy = texel.v - drag.origin.v;
  renderPreviewOfDrag();
}

// The lifted region is drawn straight onto the screen each frame rather
// than into the buffer, so a drag in progress costs nothing to undo and
// leaves no trace if it is abandoned.
function renderPreviewOfDrag() {
  render();
  const drag = session.selectionDrag;
  if (!drag) return;
  const ctx = els.pcreateCanvas.getContext('2d');
  const { cam } = session;
  const size = cam.zoom;
  for (let v = 0; v < drag.bounds.height; v++) {
    for (let u = 0; u < drag.bounds.width; u++) {
      const o = (v * drag.bounds.width + u) * 4;
      if (drag.region[o + 3] === 0) continue;
      const tu = drag.bounds.x + u + drag.dx;
      const tv = drag.bounds.y + v + drag.dy;
      ctx.fillStyle = `rgba(${drag.region[o]}, ${drag.region[o + 1]}, ${drag.region[o + 2]}, ${drag.region[o + 3] / 255})`;
      ctx.fillRect(tu * size + cam.panX, tv * size + cam.panY, size, size);
    }
  }
}

function endSelectionMove() {
  const drag = session.selectionDrag;
  session.selectionDrag = null;
  if (!drag) return;
  const landed = blitRegion(
    session.pixels, session.width, session.height,
    drag.region, drag.bounds.width, drag.bounds.height,
    drag.bounds.x + drag.dx, drag.bounds.y + drag.dy
  );
  syncBitmap();
  session.selection = landed.size ? landed : null;
  session.artworkDirty = true;
  pcreateHistory.commitCapture(drag.token, drag.dx !== 0 || drag.dy !== 0);
  refreshAutoPalette();
  renderUndoRedo();
  renderTools();
  render();
}

function rollBackSelectionMove() {
  const drag = session.selectionDrag;
  session.selectionDrag = null;
  if (!drag) return;
  blitRegion(
    session.pixels, session.width, session.height,
    drag.region, drag.bounds.width, drag.bounds.height,
    drag.bounds.x, drag.bounds.y
  );
  syncBitmap();
  session.selection = drag.original;
  renderTools();
}

// ---- Selection actions --------------------------------------------------

function copySelection() {
  if (!session || !session.selection) return;
  const bounds = regionBounds(session.selection, session.width);
  const region = extractRegion(session.pixels, session.width, session.selection, bounds);
  // Probed against a scratch copy first, so a copy that would land off the
  // canvas is reported without leaving a half-done action on the stack.
  const probe = new Uint8ClampedArray(session.pixels);
  const landed = blitRegion(
    probe, session.width, session.height,
    region, bounds.width, bounds.height,
    bounds.x + COPY_OFFSET, bounds.y + COPY_OFFSET
  );
  if (landed.size === 0) {
    showToast('The copy would land off the canvas — move the selection inward first.');
    return;
  }
  runAction('Copy selection', () => {
    session.pixels = probe;
    syncBitmap();
  });
  // The DUPLICATE becomes the selection, not the original, so it can be
  // dragged straight to where it is wanted without re-selecting anything.
  session.selection = landed;
  renderTools();
  render();
  showToast('Copied — drag the duplicate to place it.');
}

function deleteSelection() {
  if (!session || !session.selection) return;
  const count = session.selection.size;
  runAction('Delete selection', () => {
    clearIndices(session.pixels, session.selection);
    syncBitmap();
  });
  render();
  showToast(`Cleared ${count} px to transparent.`);
}

function deselect() {
  if (!session) return;
  session.selection = null;
  session.boundary = new Set();
  renderTools();
  render();
}

// ---- Pick Color ---------------------------------------------------------

function pickColorAt(texel) {
  if (!inCanvas(texel)) return;
  const [r, g, b, a] = samplePixel(session.pixels, session.width, texel.u, texel.v);
  if (a === 0) {
    showToast('That pixel is empty — there is no colour there to pick up.');
    return;
  }
  session.hsv = rgbToHsv(r, g, b);
  renderColorControls();
  showToast(`Picked ${rgbToHex(r, g, b)}.`);
}

// ---- Blend Colors -------------------------------------------------------
//
// The tap is not "which texel" but "which SEAM": the user is pointing at
// the join between two neighbours, so the neighbour is chosen by which edge
// of the tapped texel the tap actually fell nearest to. Tapping the left
// third of a texel means the seam with the texel on its left.
function blendNear(point) {
  const texel = texelAt(point);
  if (!inCanvas(texel)) return;

  // Through texelPointAt, not the raw point: on a rotated view the screen
  // point and the camera frame no longer share axes, and picking the seam
  // from unturned coordinates would name the wrong neighbour.
  const exact = texelPointAt(point);
  const fracU = exact.x - texel.u;
  const fracV = exact.y - texel.v;
  // Distance to each of the four edges; the nearest one names the neighbour.
  const toLeft = fracU;
  const toRight = 1 - fracU;
  const toTop = fracV;
  const toBottom = 1 - fracV;
  const nearest = Math.min(toLeft, toRight, toTop, toBottom);
  let nu = texel.u;
  let nv = texel.v;
  if (nearest === toLeft) nu -= 1;
  else if (nearest === toRight) nu += 1;
  else if (nearest === toTop) nv -= 1;
  else nv += 1;

  const result = blendAt(session.pixels, session.width, session.height, texel.u, texel.v, nu, nv);
  if (!result.ok) {
    if (result.reason === 'out-of-bounds') {
      showToast('There is no pixel on the other side of that edge to blend with.');
    } else if (result.reason === 'identical') {
      showToast('Those two pixels are already the same colour — there is nothing to blend.');
    } else {
      showToast('Those two shades are too close together — no distinct colour exists between them.');
    }
    return;
  }

  runAction('Blend', () => {
    paintIndices(session.pixels, [texel.v * session.width + texel.u], result.color);
    syncBitmap();
  });
  render();
  showToast(`Blended to ${rgbToHex(result.color[0], result.color[1], result.color[2])}.`);
}

// ---- Shadow -------------------------------------------------------------

// REGENERATING IS A REPLACEMENT, AND ONLY HAPPENS WHEN SOMETHING CHANGED
//
// Two rules, and the layered shadow makes both cheap. Pressing the button
// again with nothing touched since the last run does nothing and says so:
// re-running on an unchanged picture could only produce the identical
// result, and if the previous shadow had been painted INTO the artwork it
// would produce something much worse -- the silhouette would now include
// the old shadow, so the new one would be cast by artwork-plus-shadow,
// darker and further out every press. Because the shadow lives in its own
// layer and the generator always reads session.pixels, that compounding
// cannot happen even in principle; the dirty flag is what stops the
// pointless work and tells the artist why.
//
// When something HAS changed, the new set simply replaces the old one. No
// clean-up step, no stacking.
function applyShadow() {
  if (!session) return;

  if (session.shadow && !session.artworkDirty) {
    showToast('No changes since the last shadow — nothing to regenerate.');
    return;
  }

  const direction = SHADOW_DIRECTIONS.find((d) => d.key === session.shadowDirection);
  const restrictTo = session.selection;
  const indices = shadowIndices(
    session.pixels, session.width, session.height,
    direction.dx * session.shadowOffset, direction.dy * session.shadowOffset,
    restrictTo
  );
  if (indices.size === 0) {
    showToast(restrictTo
      ? 'Nothing in the selection casts a shadow that lands on empty canvas.'
      : 'There is nothing on the canvas to cast a shadow yet.');
    return;
  }
  const colour = session.shadowColor
    || suggestShadowColor(session.pixels, session.width, session.height, restrictTo);
  if (!colour) { showToast('There is nothing on the canvas to take a shadow colour from.'); return; }

  const replaced = Boolean(session.shadow);
  // Undoable like any other action, and deliberately NOT through
  // runAction(): generating a shadow does not make the ARTWORK dirty, it is
  // the thing that clears that flag.
  pcreateHistory.run('Shadow', () => {
    session.shadow = { indices, color: colour };
    session.shadowVisible = true;
    session.artworkDirty = false;
  });
  renderUndoRedo();
  renderTools();
  render();
  showToast(replaced
    ? `Shadow regenerated — ${indices.size} px, replacing the previous one.`
    : `Added a ${indices.size} px shadow.`);
}

// Independent of regeneration on purpose: this hides and shows the shadow
// that was last generated, so the artist can compare with and without, and
// it never recomputes anything. Toggling off and back on returns exactly
// the same shadow, down to the texel.
function toggleShadowVisible() {
  if (!session) return;
  if (!session.shadow) {
    showToast('No shadow has been generated yet.');
    return;
  }
  session.shadowVisible = !session.shadowVisible;
  renderTools();
  render();
  showToast(session.shadowVisible ? 'Shadow shown.' : 'Shadow hidden — its data is kept.');
}

// ---- Fill ---------------------------------------------------------------

function fillAt(texel) {
  if (!inCanvas(texel)) return;
  const target = samplePixel(session.pixels, session.width, texel.u, texel.v);
  const colour = strokeColor();
  if (target[0] === colour[0] && target[1] === colour[1]
    && target[2] === colour[2] && target[3] === colour[3]) {
    showToast('That area is already this colour.');
    return;
  }
  const region = floodFillColor(session.pixels, session.width, session.height, texel.u, texel.v);
  runAction('Fill', () => {
    paintIndices(session.pixels, region, colour);
    syncBitmap();
  });
  render();
  showToast(target[3] === 0
    ? `Filled ${region.size} px of empty canvas.`
    : `Filled ${region.size} px.`);
}

function renderShadowControls() {
  els.pcreateShadowDirs.replaceChildren();
  for (const row of [0, 1, 2]) {
    for (const col of [0, 1, 2]) {
      if (row === 1 && col === 1) {
        const centre = document.createElement('span');
        centre.className = 'pcreate-dir pcreate-dir--centre';
        centre.setAttribute('aria-hidden', 'true');
        els.pcreateShadowDirs.appendChild(centre);
        continue;
      }
      const dx = col - 1;
      const dy = row - 1;
      const direction = SHADOW_DIRECTIONS.find((d) => d.dx === dx && d.dy === dy);
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'pcreate-dir';
      button.textContent = direction.label;
      button.setAttribute('aria-label', `Shadow falls ${direction.key.toUpperCase()}`);
      button.setAttribute('aria-pressed', String(session && session.shadowDirection === direction.key));
      button.addEventListener('click', () => {
        if (!session) return;
        session.shadowDirection = direction.key;
        renderShadowControls();
      });
      els.pcreateShadowDirs.appendChild(button);
    }
  }

  if (!session) return;
  els.pcreateShadowOffset.value = String(session.shadowOffset);
  els.pcreateShadowOffsetLabel.textContent = `${session.shadowOffset} px`;
  const preview = session.shadowColor
    || suggestShadowColor(session.pixels, session.width, session.height, session.selection);
  els.pcreateShadowSwatch.style.background = preview
    ? `rgb(${preview[0]}, ${preview[1]}, ${preview[2]})`
    : 'transparent';
  els.pcreateShadowSwatch.title = session.shadowColor
    ? 'A shadow colour you chose'
    : 'Automatic: a darker, less saturated relative of what is on the canvas';
}

// ---- Rotate and Flip ----------------------------------------------------
//
// One rule decides what every transform applies to: THE SELECTION IF THERE
// IS ONE, THE WHOLE CANVAS OTHERWISE. Keeping that in a single pair of
// helpers rather than repeating it in each button means Rotate and Flip can
// never disagree with each other about what the user is pointing at.

function transformSelection(transform) {
  const bounds = regionBounds(session.selection, session.width);
  const region = extractRegion(session.pixels, session.width, session.selection, bounds);
  const result = transform(region, bounds.width, bounds.height);
  clearIndices(session.pixels, session.selection);

  // Re-centred on the selection's own centre, so a rotated piece turns in
  // place instead of drifting toward the origin as its bounding box changes
  // shape underneath it.
  const centreX = bounds.x + bounds.width / 2;
  const centreY = bounds.y + bounds.height / 2;
  const landed = blitRegion(
    session.pixels, session.width, session.height,
    result.pixels, result.width, result.height,
    Math.round(centreX - result.width / 2), Math.round(centreY - result.height / 2)
  );
  syncBitmap();
  session.selection = landed.size ? landed : null;
  renderTools();
  render();
}

// "The whole canvas" means EVERY layer, not just the active one. It has to:
// a quarter turn of a non-square canvas swaps its width and height, and
// layers in one stack share one set of dimensions -- turning only the
// selected layer would leave the stack holding buffers of two different
// shapes. Flip and free rotation go the same way for consistency, so
// "Applies to the whole canvas" means the same thing whichever transform
// is pressed.
function transformCanvas(transform) {
  let outWidth = session.width;
  let outHeight = session.height;
  for (const layer of session.layers) {
    const result = transform(layer.pixels, session.width, session.height);
    layer.pixels = result.pixels;
    outWidth = result.width;
    outHeight = result.height;
    // A transform invalidates whatever shadow was generated from the old
    // orientation; it would otherwise stay put while the art moved.
    layer.shadow = null;
    layer.artworkDirty = true;
  }
  if (outWidth !== session.width || outHeight !== session.height) {
    adoptSize(outWidth, outHeight);
  } else {
    for (const layer of session.layers) paintLayerBitmap(layer, session.width, session.height);
  }
  render();
}

function applyTransform(label, transform) {
  if (!session) return;
  runAction(label, () => {
    if (session.selection) transformSelection(transform);
    else transformCanvas(transform);
  });
}

function rotateQuarter(turns) {
  applyTransform(turns === 1 ? 'Rotate right' : 'Rotate left',
    (pixels, width, height) => rotate90(pixels, width, height, turns));
}

function flip(axis) {
  applyTransform(axis === 'horizontal' ? 'Flip left/right' : 'Flip up/down',
    (pixels, width, height) => ({
      pixels: flipPixels(pixels, width, height, axis), width, height,
    }));
}

// A free-angle rotation EXPANDS when it is turning a selection (the piece
// can grow into the space around it) and does NOT when it is turning the
// whole canvas (there is no space around that to grow into -- the canvas
// is the space). Both sample nearest-neighbour, so the result is re-snapped
// to the pixel grid rather than left blurred at an angle.
function rotateByAngle() {
  if (!session) return;
  const degrees = session.freeAngle;
  if (degrees === 0) { showToast('Set an angle first.'); return; }
  runAction(`Rotate ${degrees}°`, () => {
    if (session.selection) {
      transformSelection((pixels, width, height) => rotateFree(pixels, width, height, degrees, true));
    } else {
      transformCanvas((pixels, width, height) => rotateFree(pixels, width, height, degrees, false));
    }
  });
  showToast(`Rotated by ${degrees}°, re-snapped to the pixel grid.`);
}

// ---- Tool selection and the contextual rows -----------------------------

function selectTool(key) {
  if (!session) return;
  session.tool = key;
  session.brushMenuOpen = false;
  // Leaving Select with a lasso half-drawn should not leave that line
  // hanging over the artwork for the next tool to paint around.
  session.boundary = new Set();
  // Shade opens on a shading tone rather than whatever was last drawn with,
  // so "paint some shading by hand" does not start by painting the
  // highlight colour into the shadows.
  //
  // ONCE PER SESSION, not on every visit to the tool. Re-seeding each time
  // would throw away a tone the artist had deliberately adjusted the moment
  // they stepped away to the brush and came back, which is exactly the kind
  // of helpfulness that becomes an irritation by the third time.
  if (key === 'shade' && !session.shadeToneSeeded) {
    const suggestion = suggestShadowColor(session.pixels, session.width, session.height, session.selection);
    if (suggestion) {
      session.hsv = rgbToHsv(suggestion[0], suggestion[1], suggestion[2]);
      session.shadeToneSeeded = true;
      renderColorControls();
    }
  }
  renderTools();
  render();
}

function renderTools() {
  if (!session) return;

  els.pcreateToolStrip.replaceChildren();
  for (const tool of TOOLS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'pcreate-tool';
    button.textContent = tool.label;
    button.dataset.tool = tool.key;
    button.setAttribute('aria-pressed', String(session.tool === tool.key));
    button.addEventListener('click', () => selectTool(tool.key));
    els.pcreateToolStrip.appendChild(button);
  }

  const isBrush = BRUSH_TOOLS.has(session.tool) || session.tool === 'select';
  els.pcreateBrushRow.hidden = !isBrush;
  els.pcreateBrushMenu.hidden = !isBrush || !session.brushMenuOpen;
  els.pcreateBrushBtn.textContent = `${session.brush} × ${session.brush} ⌄`;
  els.pcreateBrushBtn.setAttribute('aria-expanded', String(session.brushMenuOpen));

  els.pcreateBrushMenu.replaceChildren();
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
    els.pcreateBrushMenu.appendChild(button);
  }

  els.pcreateShapeRow.hidden = !SHAPE_TOOLS.has(session.tool);
  els.pcreateShapeFilledBtn.setAttribute('aria-pressed', String(session.shapeFilled));
  els.pcreateShapeOutlineBtn.setAttribute('aria-pressed', String(!session.shapeFilled));

  els.pcreateFillHint.hidden = session.tool !== 'fill';
  els.pcreatePickHint.hidden = session.tool !== 'pick';
  els.pcreateBlendHint.hidden = session.tool !== 'blend';
  els.pcreateSelectHint.hidden = session.tool !== 'select' || Boolean(session.selection);

  els.pcreateSelectionRow.hidden = !session.selection;
  if (session.selection) {
    els.pcreateSelectionStatus.textContent = `${session.selection.size} px selected`;
  }

  els.pcreateShadowToggleBtn.disabled = !session.shadow;
  els.pcreateShadowToggleBtn.setAttribute('aria-pressed', String(Boolean(session.shadow) && session.shadowVisible));
  els.pcreateShadowToggleBtn.textContent = !session.shadow
    ? 'Shadow: none yet'
    : (session.shadowVisible ? 'Shadow: ON' : 'Shadow: OFF');

  els.pcreateTransformTarget.textContent = session.selection
    ? 'Applies to the selection'
    : 'Applies to the whole canvas';
  els.pcreateAngleLabel.textContent = `${session.freeAngle}°`;
  renderShadowControls();
}

// ---------------------------------------------------------------------------
// Colour wheel: hue/saturation on the wheel (drawn once, always at full
// value so the surface stays legible), a separate Value slider, and a hex
// field -- three views of the same session.hsv, kept in sync however the
// user changes it.

// THE WHEEL IS A PICKING UI, NOT PIXEL-ART CONTENT -- deliberately the one
// canvas in PCreate that is NOT drawn nearest-neighbour. Everywhere else
// "hard-edged, no smoothing" is the whole point; here it is precisely
// backwards; a colour wheel is read by its gradient, and a blocky one is
// harder to pick a precise shade from, not more honest about what it is.
//
// It was rendered BLURRY rather than hard-edged, though, which is a
// different bug: the bitmap and the on-screen canvas were both a flat
// 200x200 physical pixels regardless of the device's actual pixel density.
// On any screen denser than that -- which is effectively every phone this
// app runs on -- the browser has to stretch a 200x200 image across a much
// larger physical area, and stretching is exactly what produces the soft,
// low-fidelity look. The fix is the same device-pixel-ratio awareness the
// main canvas already has (see sizeCanvas()/render()): the bitmap is built
// at the SCREEN'S OWN pixel density, not a fixed 200, so there is no
// stretching left for the browser to do -- every physical pixel the wheel
// occupies is one this code actually computed a colour for.
function wheelDevicePixelSize() {
  const dpr = window.devicePixelRatio || 1;
  return Math.max(1, Math.round(WHEEL_SIZE * dpr));
}

// The on-screen canvas's own backing store, resized to the current
// device's pixel density. The element's CSS size stays pinned at 200x200
// (see .pcreate-wheel) regardless, so only the sharpness changes, never
// the layout.
function sizeWheelCanvas() {
  const canvas = els.pcreateWheelCanvas;
  const size = wheelDevicePixelSize();
  if (canvas.width === size && canvas.height === size) return;
  canvas.width = size;
  canvas.height = size;
  wheelBitmap = null; // stale at the old resolution -- rebuild it to match
}

function drawWheel() {
  sizeWheelCanvas();
  if (!wheelBitmap) {
    const size = wheelDevicePixelSize();
    const dpr = window.devicePixelRatio || 1;
    wheelBitmap = document.createElement('canvas');
    wheelBitmap.width = size;
    wheelBitmap.height = size;
    const wctx = wheelBitmap.getContext('2d');
    const image = wctx.createImageData(size, size);
    const cx = size / 2;
    const cy = size / 2;
    const radius = WHEEL_RADIUS * dpr;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const dx = x + 0.5 - cx;
        const dy = y + 0.5 - cy;
        const dist = Math.hypot(dx, dy);
        const o = (y * size + x) * 4;
        if (dist > radius) continue; // left transparent: a round wheel on a square canvas
        const hue = (Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360;
        const sat = Math.min(1, dist / radius);
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
  const dpr = window.devicePixelRatio || 1;
  // Everything below this line works in the wheel's ordinary 200-unit
  // logical space, same as before -- this transform is what maps that
  // space onto the now device-resolution backing store, exactly the
  // pattern the main canvas's own render() already uses.
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, WHEEL_SIZE, WHEEL_SIZE);
  // wheelBitmap holds exactly WHEEL_SIZE*dpr physical pixels, and drawing
  // it into a WHEEL_SIZE logical box under this dpr transform lands
  // every one of them on exactly one physical pixel of the canvas -- a
  // 1:1 draw with nothing for the browser to interpolate, which is what
  // actually makes this crisp rather than merely higher-resolution.
  ctx.drawImage(wheelBitmap, 0, 0, WHEEL_SIZE, WHEEL_SIZE);
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

// ---------------------------------------------------------------------------
// The layer list
//
// Built to the same shape as the main scene's Parts list, because it is the
// same job: a row per layer, the selected one highlighted, and the controls
// that would otherwise crowd every row tucked behind a "⋮" that opens one
// aside panel at a time. Reusing the list-row / scene-part / row-aside
// classes means it also inherits that list's spacing, tap targets and
// selected state rather than growing a second look for the same idea.
//
// Top of the stack first, so the row order on screen matches what the eye
// sees on the canvas. layers[] itself runs bottom-first, so "move up" in
// the list is a move toward the END of the array.

function renderLayerList() {
  if (!session) return;
  els.pcreateLayerList.replaceChildren();
  els.pcreateLayerCount.textContent =
    `${session.layers.length} layer${session.layers.length === 1 ? '' : 's'}`;
  els.pcreateAddLayerBtn.disabled = session.layers.length >= LAYER_LIMIT;

  if (session.openLayerMenuId && !session.layers.some((l) => l.id === session.openLayerMenuId)) {
    session.openLayerMenuId = null;
  }
  if (session.renamingLayerId && !session.layers.some((l) => l.id === session.renamingLayerId)) {
    session.renamingLayerId = null;
  }

  const topFirst = [...session.layers].reverse();
  topFirst.forEach((layer, indexFromTop) => {
    const item = document.createElement('li');

    if (session.renamingLayerId === layer.id) {
      item.appendChild(layerRenameRow(layer));
      els.pcreateLayerList.appendChild(item);
      return;
    }

    const row = document.createElement('div');
    row.className = 'list-row';

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'scene-part';
    button.classList.toggle('is-selected', layer.id === session.activeLayerId);
    button.classList.toggle('is-hidden', layer.opacity <= 0);
    button.appendChild(document.createTextNode(layer.name));
    if (layer.opacity < 1) {
      const tag = document.createElement('span');
      tag.className = 'scene-part__tag';
      tag.textContent = ` — ${Math.round(layer.opacity * 100)}%`;
      button.appendChild(tag);
    }
    button.addEventListener('click', () => selectLayer(layer.id));
    row.appendChild(button);

    const isOpen = session.openLayerMenuId === layer.id;
    const kebab = document.createElement('button');
    kebab.type = 'button';
    kebab.className = 'row-btn';
    kebab.textContent = isOpen ? '✕' : '⋮';
    kebab.setAttribute('aria-label', isOpen ? `Close menu for ${layer.name}` : `More actions for ${layer.name}`);
    kebab.setAttribute('aria-pressed', String(isOpen));
    kebab.addEventListener('click', () => {
      // Tapping the open row's button closes it; tapping another row's
      // closes whatever was open and opens that one -- never two at once.
      session.openLayerMenuId = isOpen ? null : layer.id;
      renderLayerList();
    });
    row.appendChild(kebab);

    item.appendChild(row);
    if (isOpen) item.appendChild(layerRowAside(layer, indexFromTop, topFirst.length));
    els.pcreateLayerList.appendChild(item);
  });
}

function layerRowAside(layer, indexFromTop, total) {
  const aside = document.createElement('div');
  aside.className = 'row-aside';

  const action = (label, onClick, disabled = false) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'row-aside__btn';
    button.textContent = label;
    button.disabled = disabled;
    button.addEventListener('click', onClick);
    aside.appendChild(button);
  };

  action('Rename', () => {
    session.openLayerMenuId = null;
    session.renamingLayerId = layer.id;
    renderLayerList();
  });
  action('▲ Move up', () => moveLayer(layer.id, 1), indexFromTop === 0);
  action('▼ Move down', () => moveLayer(layer.id, -1), indexFromTop === total - 1);
  action('Duplicate', () => duplicateLayer(layer.id), session.layers.length >= LAYER_LIMIT);
  action('Delete', () => askDeleteLayer(layer.id), session.layers.length <= 1);

  // Opacity lives in the aside rather than the row: it is the one per-layer
  // control that needs a slider rather than a tap, and a slider in every
  // row would make the list unusable on a phone.
  const field = document.createElement('label');
  field.className = 'slider-field';
  const caption = document.createElement('span');
  caption.textContent = `Opacity ${Math.round(layer.opacity * 100)}%`;
  const slider = document.createElement('input');
  slider.className = 'slider';
  slider.type = 'range';
  slider.min = '0';
  slider.max = '100';
  slider.step = '1';
  slider.value = String(Math.round(layer.opacity * 100));
  // Live while dragging so the canvas responds, but only ONE undo step for
  // the whole drag -- the same capture/commit split strokes use.
  let token = null;
  slider.addEventListener('pointerdown', () => { token = pcreateHistory.capture('Layer opacity'); });
  slider.addEventListener('input', () => {
    layer.opacity = Number(slider.value) / 100;
    caption.textContent = `Opacity ${slider.value}%`;
    render();
  });
  const commit = () => {
    if (!token) return;
    pcreateHistory.commitCapture(token, true);
    token = null;
    renderUndoRedo();
    renderLayerList();
  };
  slider.addEventListener('pointerup', commit);
  slider.addEventListener('change', commit);
  field.append(caption, slider);
  aside.appendChild(field);

  return aside;
}

function layerRenameRow(layer) {
  const row = document.createElement('div');
  row.className = 'list-row';
  const input = document.createElement('input');
  input.className = 'text-input text-input--inline';
  input.type = 'text';
  input.value = layer.name;
  input.setAttribute('aria-label', `Rename ${layer.name}`);

  // Guards against Enter's commit and the blur it causes both firing.
  let settled = false;
  const finish = (save) => {
    if (settled) return;
    settled = true;
    const typed = input.value.trim();
    if (save && typed && typed !== layer.name) {
      runLayerAction('Rename layer', () => { layer.name = typed; });
    }
    session.renamingLayerId = null;
    renderLayerList();
  };
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') finish(true);
    if (event.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
  row.appendChild(input);
  setTimeout(() => input.focus(), 0);
  return row;
}

// Layer structure changes are undoable like any drawing action, but they
// do not dirty the ARTWORK for shadow purposes -- reordering the stack
// does not change what any individual layer looks like.
function runLayerAction(label, mutate) {
  if (!session) return;
  pcreateHistory.run(label, mutate);
  renderUndoRedo();
  renderLayerList();
  renderTools();
  render();
}

function selectLayer(id) {
  if (!session) return;
  session.activeLayerId = id;
  // A selection belongs to the layer it was made on; carrying it to a
  // different layer would let a move or delete act on pixels the marquee
  // was never drawn around.
  session.selection = null;
  session.openLayerMenuId = null;
  refreshAutoPalette();
  renderLayerList();
  renderTools();
  render();
}

function addLayer() {
  if (!session) return;
  if (session.layers.length >= LAYER_LIMIT) {
    showToast(`PCreate holds up to ${LAYER_LIMIT} layers.`);
    return;
  }
  runLayerAction('Add layer', () => {
    const layer = makeLayer({
      name: uniqueLayerName(`Layer ${session.layers.length + 1}`),
      width: session.width,
      height: session.height,
    });
    session.layers.push(layer); // on top of the stack
    session.activeLayerId = layer.id;
    session.selection = null;
  });
  showToast('Added a new empty layer on top.');
}

function duplicateLayer(id) {
  if (!session) return;
  if (session.layers.length >= LAYER_LIMIT) {
    showToast(`PCreate holds up to ${LAYER_LIMIT} layers.`);
    return;
  }
  const index = session.layers.findIndex((l) => l.id === id);
  if (index < 0) return;
  const source = session.layers[index];
  runLayerAction('Duplicate layer', () => {
    const copy = makeLayer({
      name: uniqueLayerName(`${source.name} copy`),
      width: session.width,
      height: session.height,
      pixels: new Uint8ClampedArray(source.pixels), // its own buffer, not a shared reference
      opacity: source.opacity,
    });
    copy.shadow = source.shadow
      ? { indices: new Set(source.shadow.indices), color: [...source.shadow.color] }
      : null;
    copy.shadowVisible = source.shadowVisible;
    copy.artworkDirty = source.artworkDirty;
    session.layers.splice(index + 1, 0, copy); // directly above its original
    session.activeLayerId = copy.id;
    session.openLayerMenuId = null;
  });
  showToast('Duplicated — the copy is independent of the original.');
}

function moveLayer(id, direction) {
  if (!session) return;
  const index = session.layers.findIndex((l) => l.id === id);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= session.layers.length) return;
  runLayerAction('Reorder layer', () => {
    const [layer] = session.layers.splice(index, 1);
    session.layers.splice(target, 0, layer);
  });
}

let pendingLayerDeleteId = null;

function askDeleteLayer(id) {
  if (!session) return;
  if (session.layers.length <= 1) {
    showToast('A canvas needs at least one layer.');
    return;
  }
  const layer = session.layers.find((l) => l.id === id);
  if (!layer) return;
  pendingLayerDeleteId = id;
  const painted = countOpaque(layer.pixels);
  els.pcreateLayerDeleteMessage.textContent =
    `"${layer.name}" and its ${painted} painted pixel${painted === 1 ? '' : 's'} will be removed ` +
    'from this canvas. Undo can bring it back.';
  els.pcreateLayerDeleteModal.hidden = false;
}

function closeLayerDeleteModal() {
  pendingLayerDeleteId = null;
  els.pcreateLayerDeleteModal.hidden = true;
}

function confirmDeleteLayer() {
  const id = pendingLayerDeleteId;
  closeLayerDeleteModal();
  if (!session || !id) return;
  const index = session.layers.findIndex((l) => l.id === id);
  if (index < 0 || session.layers.length <= 1) return;
  const name = session.layers[index].name;
  runLayerAction('Delete layer', () => {
    session.layers.splice(index, 1);
    if (session.activeLayerId === id) {
      const next = session.layers[Math.min(index, session.layers.length - 1)];
      session.activeLayerId = next.id;
    }
    session.selection = null;
    session.openLayerMenuId = null;
  });
  refreshAutoPalette();
  showToast(`Deleted "${name}".`);
}

function countOpaque(pixels) {
  let count = 0;
  for (let i = 3; i < pixels.length; i += 4) if (pixels[i] !== 0) count++;
  return count;
}

// ---------------------------------------------------------------------------
// Auto Palette
//
// Not a palette the artist curates -- a readout of what the picture is
// actually made of right now, rebuilt from the canvas rather than stored.
// It is deliberately a different thing from the saved Custom Palettes
// above: those are named, persist in IndexedDB, and outlive every canvas;
// this one has no name, is never written to storage, and is only ever as
// current as the last refresh. Tapping a swatch in either picks that
// colour, which is the one thing they have in common.

function refreshAutoPalette() {
  if (!session) return;
  // The PCreate settings section's "Manual only" means exactly that: the
  // scan happens when the Auto Palette view is opened or its Refresh
  // button is pressed, and never as a side effect of drawing. Both of
  // those go through rebuildAutoPalette() directly, so declining here
  // suppresses the incidental refreshes without disabling the feature.
  if (getSetting('autoPaletteRefresh') === 'manual') return;
  // Above the live limit this is only rebuilt when explicitly asked for, so
  // a huge canvas does not pay a full scan on every brush stroke.
  if (session.width * session.height > AUTO_PALETTE_LIVE_LIMIT) return;
  rebuildAutoPalette();
}

function rebuildAutoPalette() {
  if (!session) return;
  session.autoPalette = uniqueColorsByHue(compositePixels(), session.width, session.height);
  renderAutoPalette();
}

function renderAutoPalette() {
  if (!session) return;
  els.pcreateAutoStrip.replaceChildren();
  els.pcreateAutoCount.textContent = session.autoPalette.length === 0
    ? 'Nothing on the canvas yet'
    : `${session.autoPalette.length} colour${session.autoPalette.length === 1 ? '' : 's'} in this artwork`;

  const currentHexValue = currentHex();
  for (const colour of session.autoPalette) {
    const hex = rgbToHex(colour.r, colour.g, colour.b);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'pcreate-swatch-strip__item';
    button.style.background = hex;
    button.setAttribute('aria-label', `Pick ${hex} (${colour.count} px)`);
    button.title = `${hex} — ${colour.count} px`;
    button.setAttribute('aria-pressed', String(hex.toLowerCase() === currentHexValue));
    button.addEventListener('click', () => {
      session.hsv = rgbToHsv(colour.r, colour.g, colour.b);
      renderColorControls();
    });
    els.pcreateAutoStrip.appendChild(button);
  }
}

// ---------------------------------------------------------------------------
// Saving the work in progress
//
// Distinct from Save as Layer, which is an export: that hands a finished
// picture to the project and leaves PCreate's own canvas where it was.
// This keeps the canvas ITSELF -- mid-edit, shadow layer and all -- so
// closing the app does not throw away an unfinished drawing.

function sessionRecord() {
  return {
    kind: session.kind,
    sourceName: session.sourceName,
    width: session.width,
    height: session.height,
    activeLayerId: session.activeLayerId,
    layers: session.layers.map((layer) => ({
      id: layer.id,
      name: layer.name,
      opacity: layer.opacity,
      pixels: new Uint8ClampedArray(layer.pixels),
      shadow: layer.shadow
        ? { indices: [...layer.shadow.indices], color: [...layer.shadow.color] }
        : null,
      shadowVisible: layer.shadowVisible,
      artworkDirty: layer.artworkDirty,
    })),
    loadedPaletteName: session.loadedPaletteName,
    savedCount: session.savedCount,
  };
}

async function savePCreateWork(quiet = false) {
  if (!session) return;
  try {
    await storage.savePCreateSession(sessionRecord());
    session.unsavedSince = false;
    if (!quiet) showToast('PCreate work saved — it will be offered when you come back.');
  } catch (error) {
    console.warn(error);
    if (!quiet) showToast(`Could not save: ${error.message}`);
  }
}

async function resumeSavedWork() {
  closeEntryModal();
  let record;
  try {
    record = await storage.loadPCreateSession();
  } catch (error) {
    console.warn(error);
    showToast('Could not read the saved work.');
    return;
  }
  if (!record || !record.data) { showToast('There is no saved PCreate work.'); return; }

  const data = record.data;
  const layers = (data.layers || []).map((saved) => {
    const layer = makeLayer({
      name: saved.name,
      width: data.width,
      height: data.height,
      pixels: new Uint8ClampedArray(saved.pixels),
      opacity: saved.opacity,
    });
    layer.id = saved.id;
    layer.shadow = saved.shadow
      ? { indices: new Set(saved.shadow.indices), color: [...saved.shadow.color] }
      : null;
    layer.shadowVisible = saved.shadowVisible;
    layer.artworkDirty = saved.artworkDirty;
    return layer;
  });
  if (layers.length === 0) { showToast('The saved work had no layers.'); return; }
  // Keep issuing fresh ids above whatever the restored stack already uses,
  // so a layer added after resuming can never collide with a restored one.
  nextLayerId = Math.max(nextLayerId, ...layers.map((l) => Number(String(l.id).slice(1)) || 0)) + 1;

  startSession({
    kind: data.kind || 'blank',
    name: data.sourceName || `${data.width}×${data.height}`,
    width: data.width,
    height: data.height,
    layers,
  });
  if (data.activeLayerId && layers.some((l) => l.id === data.activeLayerId)) {
    session.activeLayerId = data.activeLayerId;
  }
  session.loadedPaletteName = data.loadedPaletteName || null;
  session.savedCount = data.savedCount || 0;
  await refreshPaletteCache();
  rebuildAutoPalette();
  renderSwatchStrip();
  renderLayerList();
  renderTools();
  render();
  showToast('Resumed your saved PCreate work.');
}

// Whether there is anything to offer on the way in. Checked when the entry
// modal opens so the Resume button only appears when it would do something.
async function refreshResumeButton() {
  let record = null;
  try {
    record = await storage.loadPCreateSession();
  } catch { /* no-op: an unreadable slot is the same as an empty one here */ }
  const available = Boolean(record && record.data);
  els.pcreateResumeBtn.hidden = !available;
  if (available) {
    const when = new Date(record.savedAt);
    els.pcreateResumeBtn.textContent =
      `Resume saved work (${record.data.width}×${record.data.height}, ${when.toLocaleDateString()})`;
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
//
// NOW BACKED BY THE SETTINGS STORE, not by a localStorage key of its own.
// The PCreate settings section calls this "the default edit behaviour",
// and the toggle in the drawing window sets it for the session -- but
// those are the same value, deliberately. Splitting them would mean a user
// who flips the in-window toggle finds it reverted next session, which is
// strictly worse than the behaviour this replaces, and it would make the
// settings screen show something other than what PCreate is actually
// doing. One value, two places to change it, both persistent.
function loadEditMode() {
  editInPlace = Boolean(getSetting('defaultEditInPlace'));
}

function setEditMode(value) {
  editInPlace = value;
  setSetting('defaultEditInPlace', value);
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

// IMPORT TO MAIN
//
// The export pathway the foundation task proved out, now working on the
// stack: choose which PCreate layers to push into the project and each one
// becomes an ordinary Part -- the same partsStore.add(new Part(...)) call
// an ordinary import makes, so what lands is draggable, riggable and
// bindable with nothing special about it.
//
// NON-DESTRUCTIVE. The layers stay in PCreate afterwards. This is a copy
// out, not a move: an artist who exports a head to check how it sits in the
// scene must not find it missing from the canvas they were drawing it on.

function openImportToMainModal() {
  if (!session) return;
  els.pcreateExportList.replaceChildren();

  // Top of the stack first, matching the layer list.
  const topFirst = [...session.layers].reverse();
  for (const layer of topFirst) {
    const item = document.createElement('li');
    const row = document.createElement('label');
    row.className = 'list-row pcreate-export-row';

    const box = document.createElement('input');
    box.type = 'checkbox';
    box.className = 'pcreate-export-check';
    box.dataset.layerId = layer.id;
    // The active layer starts ticked: exporting the one you are working on
    // is the common case, and everything else is one tap away.
    box.checked = layer.id === session.activeLayerId;

    const label = document.createElement('span');
    label.className = 'scene-part';
    const painted = countOpaque(layer.pixels);
    label.textContent = `${layer.name} — ${painted} px`;
    if (painted === 0) {
      box.checked = false;
      box.disabled = true;
      label.textContent = `${layer.name} — empty`;
    }

    row.append(box, label);
    item.appendChild(row);
    els.pcreateExportList.appendChild(item);
  }

  els.pcreateExportModal.hidden = false;
}

function closeImportToMainModal() {
  els.pcreateExportModal.hidden = true;
}

function setAllExportChecks(checked) {
  for (const box of els.pcreateExportList.querySelectorAll('.pcreate-export-check')) {
    if (!box.disabled) box.checked = checked;
  }
}

function nextPlacement(index) {
  const offset = ((session.savedCount + index) % CASCADE_WRAP) * CASCADE_STEP;
  return {
    x: Math.floor((sceneStore.width - session.width) / 2) + offset,
    y: Math.floor((sceneStore.height - session.height) / 2) + offset,
  };
}

function importToMain() {
  if (!session) return;
  const chosen = [...els.pcreateExportList.querySelectorAll('.pcreate-export-check')]
    .filter((box) => box.checked)
    .map((box) => session.layers.find((l) => l.id === box.dataset.layerId))
    .filter(Boolean);

  if (chosen.length === 0) {
    showToast('Tick at least one layer to import.');
    return;
  }
  closeImportToMainModal();

  // Each layer is flattened with its own opacity and shadow at the moment
  // of export, so what the project receives is what the layer looked like
  // -- an independent snapshot, exactly like every other layer-creating
  // action in the app.
  const exported = chosen.map((layer) => ({
    name: layer.name,
    pixels: compositeLayer(layer),
  }));

  // Read fresh, for the same reason CLayer's save reads it inline: only the
  // FIRST layer of this batch can land in a project that is still empty.
  const wasEmpty = partsStore.isEmpty;
  const width = session.width;
  const height = session.height;

  let created = [];
  history.run(`PCreate: import ${exported.length} layer${exported.length === 1 ? '' : 's'}`, () => {
    if (wasEmpty) sceneStore.setSize(width, height);
    const matchesCanvas = sceneStore.width === width && sceneStore.height === height;
    exported.forEach((piece, index) => {
      // Every layer shares the PCreate canvas's frame, so when that frame
      // matches the project's they all land at the origin -- which is what
      // keeps a head sitting on its body instead of each piece being
      // cascaded to its own corner.
      const placement = matchesCanvas ? { x: 0, y: 0 } : nextPlacement(index);
      const part = partsStore.add(new Part({
        name: piece.name,
        image: null,
        pixels: piece.pixels,
        width,
        height,
        objectUrl: null,
        x: placement.x,
        y: placement.y,
        scale: 1,
        placement: matchesCanvas ? 'auto' : 'manual',
      }));
      created.push(part);
    });
    if (created.length) partsStore.select(created[created.length - 1].id);
  });

  session.savedCount += exported.length;
  showToast(`Imported ${created.length} layer${created.length === 1 ? '' : 's'} into the project — ` +
    'the originals are still here in PCreate.');
}

// ---------------------------------------------------------------------------
// Test window: the same reason clayerDebug()/pxpinDebug() exist -- proving
// the camera, the colour state and the palette wiring live HERE, and that
// a completed save reaches partsStore, without a test reaching past this
// module's own boundary.
export function pcreateDebug() {
  if (!session) return null;
  const layer = activeLayer();
  return {
    kind: session.kind,
    width: session.width,
    height: session.height,
    zoom: session.cam.zoom,
    panX: session.cam.panX,
    panY: session.cam.panY,
    rotation: session.cam.rotation,
    hsv: { ...session.hsv },
    hex: currentHex(),
    loadedPaletteName: session.loadedPaletteName,
    savedCount: session.savedCount,
    editInPlace,
    tool: session.tool,
    brush: session.brush,
    shapeFilled: session.shapeFilled,
    selectionSize: session.selection ? session.selection.size : null,
    boundarySize: session.boundary.size,
    shadowDirection: session.shadowDirection,
    shadowOffset: session.shadowOffset,
    shadowColorIsAuto: session.shadowColor === null,
    freeAngle: session.freeAngle,
    shadowSize: layer && layer.shadow ? layer.shadow.indices.size : null,
    shadowVisible: layer ? layer.shadowVisible : null,
    artworkDirty: layer ? layer.artworkDirty : null,
    canUndo: pcreateHistory.canUndo,
    canRedo: pcreateHistory.canRedo,
    undoLabel: pcreateHistory.undoLabel,
    redoLabel: pcreateHistory.redoLabel,
    autoPalette: session.autoPalette.map((c) => rgbToHex(c.r, c.g, c.b)),
    autoPaletteHues: session.autoPalette.map((c) => Math.round(c.h)),
    // The stack, bottom-first, exactly as it is stored.
    activeLayerId: session.activeLayerId,
    activeLayerName: layer ? layer.name : null,
    layers: session.layers.map((l) => ({
      id: l.id,
      name: l.name,
      opacity: l.opacity,
      painted: countOpaque(l.pixels),
      shadowSize: l.shadow ? l.shadow.indices.size : null,
    })),
  };
}

// One layer's own pixel, regardless of which layer is active -- for
// proving a tool wrote to the RIGHT layer and left the others alone.
export function pcreateLayerPixelAt(layerId, u, v) {
  if (!session) return null;
  const layer = session.layers.find((l) => l.id === layerId);
  if (!layer) return null;
  const o = (v * session.width + u) * 4;
  return [layer.pixels[o], layer.pixels[o + 1], layer.pixels[o + 2], layer.pixels[o + 3]];
}

// The composited canvas -- artwork plus a visible shadow -- at one texel,
// which is what the eye actually sees, as opposed to pcreatePixelAt()'s
// artwork-only reading.
export function pcreateCompositeAt(u, v) {
  if (!session) return null;
  const pixels = compositePixels();
  const o = (v * session.width + u) * 4;
  return [pixels[o], pixels[o + 1], pixels[o + 2], pixels[o + 3]];
}

export function pcreateUndo() { undoPCreate(); }
export function pcreateRedo() { redoPCreate(); }
export async function pcreateSaveWork() { return savePCreateWork(true); }
export async function pcreateResume() { return resumeSavedWork(); }

// How many texels on the canvas are non-transparent -- the cheapest honest
// answer to "did that tool actually draw anything", without a test having
// to guess at colours from a screenshot.
export function pcreateOpaqueCount() {
  if (!session) return null;
  let count = 0;
  for (let i = 3; i < session.pixels.length; i += 4) {
    if (session.pixels[i] !== 0) count++;
  }
  return count;
}

// Every distinct colour currently on the canvas, as hex, with how many
// texels each covers. Proving a brush stroke is HARD-EDGED means proving
// exactly one new colour appeared and nothing was softened into existence
// around it, which a colour census answers directly.
export function pcreateColorCensus() {
  if (!session) return null;
  const counts = new Map();
  for (let i = 0; i < session.pixels.length; i += 4) {
    const a = session.pixels[i + 3];
    if (a === 0) continue;
    const key = `${rgbToHex(session.pixels[i], session.pixels[i + 1], session.pixels[i + 2])}@${a}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count);
}

export async function pcreateListPalettes() {
  return refreshPaletteCache();
}

// The CURRENT working buffer's own colour at one texel, for tests --
// proving a camera move (zoom/pan) never touches the pixels themselves,
// the same non-destructive guarantee Px Pin, the Pierce painter and CLayer
// all already give their own camera.
// The exact (fractional) texel a canvas-relative point sits over, rotation
// included -- what the tools themselves see, so a test can check that a tap
// on a turned canvas still resolves to the texel under the finger.
export function pcreatePointDebug(x, y) {
  if (!session) return null;
  return texelPointAt({ x, y });
}

export function pcreatePixelAt(u, v) {
  if (!session) return null;
  const index = (v * session.width + u) * 4;
  return [session.pixels[index], session.pixels[index + 1], session.pixels[index + 2], session.pixels[index + 3]];
}

// ---------------------------------------------------------------------------
// Wiring

export function initPCreate({ onExit, onSettings } = {}) {
  cacheElements();
  if (onExit) exitCallback = onExit;
  if (onSettings) settingsCallback = onSettings;

  // Fires once now with the boot defaults and again when the durable
  // settings finish loading, so the in-window toggle shows the user's real
  // preference rather than the default it started the frame on. Keyed on
  // the one setting this mirrors, so unrelated changes do not redraw it.
  subscribeSettings((key) => {
    if (key !== null && key !== 'defaultEditInPlace') return;
    loadEditMode();
    if (els.pcreateEditModeToggle) renderEditModeToggle();
  });

  els.pcreateBlankBtn.addEventListener('click', openSizeModal);
  els.pcreateImportBtn.addEventListener('click', openImportPicker);
  // Cancel on the entry dialog used to just close the modal, leaving
  // whatever was behind it (Rig mode's own chrome) visible -- exactly the
  // bleed-through this dialog is not supposed to have. Now that PCreate is
  // its own screen with nothing of its own behind that dialog, "cancel"
  // can only sensibly mean leaving PCreate altogether.
  els.pcreateEntryCancelBtn.addEventListener('click', () => { closeEntryModal(); exitCallback(); });
  els.pcreateBackToMenuBtn.addEventListener('click', () => { endSession(); exitCallback(); });
  // Settings does NOT end the session: it is a visit, not an exit, so the
  // canvas is exactly where it was left when Back brings the user back.
  els.pcreateSettingsBtn.addEventListener('click', () => settingsCallback());
  els.pcreateFileInput.addEventListener('change', onImportPicked);

  els.pcreateWidthInput.addEventListener('input', handleWidthInput);
  els.pcreateHeightInput.addEventListener('input', handleHeightInput);
  els.pcreateMirrorToggle.addEventListener('click', handleMirrorToggle);
  els.pcreateSizeCreateBtn.addEventListener('click', createBlankCanvas);
  els.pcreateSizeCancelBtn.addEventListener('click', closeSizeModal);

  // Done finishes THIS canvas, same as before; it now also leaves PCreate
  // for the same reason Back to Menu and Cancel do -- there is no
  // Rig-mode chrome sitting underneath to reveal any more.
  els.pcreateDoneBtn.addEventListener('click', () => { endSession(); exitCallback(); });
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

  els.pcreateBrushBtn.addEventListener('click', () => {
    if (!session) return;
    session.brushMenuOpen = !session.brushMenuOpen;
    renderTools();
  });
  els.pcreateShapeFilledBtn.addEventListener('click', () => {
    if (session) { session.shapeFilled = true; renderTools(); }
  });
  els.pcreateShapeOutlineBtn.addEventListener('click', () => {
    if (session) { session.shapeFilled = false; renderTools(); }
  });

  els.pcreateSelCopyBtn.addEventListener('click', copySelection);
  els.pcreateSelDeleteBtn.addEventListener('click', deleteSelection);
  els.pcreateSelDeselectBtn.addEventListener('click', deselect);

  els.pcreateShadowOffset.addEventListener('input', () => {
    if (!session) return;
    session.shadowOffset = Number(els.pcreateShadowOffset.value);
    renderShadowControls();
  });
  els.pcreateShadowUseCurrentBtn.addEventListener('click', () => {
    if (!session) return;
    const { r, g, b } = currentRgb();
    session.shadowColor = [r, g, b, 255];
    renderShadowControls();
  });
  els.pcreateShadowAutoBtn.addEventListener('click', () => {
    if (!session) return;
    session.shadowColor = null; // back to "recompute from the artwork"
    renderShadowControls();
  });
  els.pcreateShadowApplyBtn.addEventListener('click', applyShadow);
  els.pcreateShadowToggleBtn.addEventListener('click', toggleShadowVisible);
  els.pcreateAutoRefreshBtn.addEventListener('click', () => {
    if (!session) return;
    rebuildAutoPalette();
    showToast(`Auto Palette rebuilt — ${session.autoPalette.length} colours.`);
  });
  els.pcreateUndoBtn.addEventListener('click', undoPCreate);
  els.pcreateRedoBtn.addEventListener('click', redoPCreate);
  els.pcreateSaveWorkBtn.addEventListener('click', () => savePCreateWork());
  els.pcreateResumeBtn.addEventListener('click', resumeSavedWork);

  // The moment before a phone kills a backgrounded app -- the same hook
  // autosave.js uses on the project, for the same reason.
  document.addEventListener('visibilitychange', () => {
    if (session && document.visibilityState === 'hidden') savePCreateWork(true);
  });

  els.pcreateRotateCcwBtn.addEventListener('click', () => rotateQuarter(3));
  els.pcreateRotateCwBtn.addEventListener('click', () => rotateQuarter(1));
  els.pcreateFlipHBtn.addEventListener('click', () => flip('horizontal'));
  els.pcreateFlipVBtn.addEventListener('click', () => flip('vertical'));
  els.pcreateAngleSlider.addEventListener('input', () => {
    if (!session) return;
    session.freeAngle = Number(els.pcreateAngleSlider.value);
    els.pcreateAngleLabel.textContent = `${session.freeAngle}°`;
  });
  els.pcreateRotateFreeBtn.addEventListener('click', rotateByAngle);

  els.pcreateSaveLayerBtn.addEventListener('click', openImportToMainModal);
  els.pcreateExportConfirmBtn.addEventListener('click', importToMain);
  els.pcreateExportCancelBtn.addEventListener('click', closeImportToMainModal);
  els.pcreateExportAllBtn.addEventListener('click', () => setAllExportChecks(true));
  els.pcreateExportNoneBtn.addEventListener('click', () => setAllExportChecks(false));

  els.pcreateAddLayerBtn.addEventListener('click', addLayer);
  els.pcreateLayerDeleteConfirmBtn.addEventListener('click', confirmDeleteLayer);
  els.pcreateLayerDeleteCancelBtn.addEventListener('click', closeLayerDeleteModal);

  window.addEventListener('resize', () => {
    if (!session) return;
    sizeCanvas();
    render();
    // A no-op unless the device pixel ratio actually changed (moving the
    // window to a different-density display, folding/unfolding a phone) --
    // sizeWheelCanvas() only rebuilds when the backing store is actually
    // out of date.
    drawWheel();
  });
}
