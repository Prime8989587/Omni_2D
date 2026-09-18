// CLayer: manually extract one piece of an existing picture as its own
// independent layer, by hand-drawing a boundary and filling it in.
//
// WHY NOT AUTO-SEGMENTATION
//
// An AI-based cutout is a guess, and a guess is exactly the wrong tool for
// pulling a precise, riggable piece -- an arm, a strand of hair, a single
// bead -- out of hand-drawn artwork. Whatever it gets slightly wrong (a
// stray fringe of background, a bitten-off fingertip) becomes a permanent
// defect baked into a Part someone will later stretch and pin. So CLayer is
// the deterministic alternative: the artist draws exactly where the line
// is, a well-understood flood fill decides exactly which pixels are inside
// it, and the extraction is a plain crop-and-mask with no resampling and
// nothing probabilistic anywhere in the path.
//
// A DEDICATED SCREEN, NOT A SCENE TOOL
//
// The source picture is not necessarily anything in the current project --
// "any PNG the user selects" -- so this cannot be one more mode layered on
// the main canvas, which only knows about Scene Parts. It is its own
// window with its own decoded image, its own camera, and its own masks,
// and the only thing that ever crosses back into the project is the
// finished extraction, added as a Part exactly the way an import is.
//
// THE CAMERA HERE IS NOT THE APP'S CAMERA
//
// Same rule as Px Pin and the Pierce painter, and for the same reason:
// zooming in to trace a fiddly outline and panning around while doing it
// must never be confused with moving anything. This window owns its own
// {zoom, pan}, touches nothing in view.js, and the ONLY thing that ever
// writes to partsStore is a completed Save.
//
// ONE FINGER DRAWS OR TAPS, TWO FINGERS MOVE THE VIEW -- the same input
// model Px Pin and the Pierce painter already settled on, so there is one
// way to work a canvas in this app rather than three slightly different
// ones.

import { Part, partsStore } from './parts.js';
import { sceneStore } from './scene.js';
import { history } from './history.js';
import { isPng, loadImage, readPixels, displayName, contentBounds, cropPixels } from './importer.js';

const BOUNDARY_COLOR = 'rgba(255, 46, 147, 0.85)';
const FILL_COLOR = 'rgba(58, 219, 126, 0.4)';
const FILL_EDGE = '#3ADB6E';

const MAX_ZOOM = 64; // css px per source px -- far past single-pixel tracing
const MAX_BRUSH = 10; // the biggest square a single touch-point covers
const GRID_MIN_CELL_PX = 12; // draw the pixel grid once cells are this big

// Cascading placement for extractions dropped into the current project,
// mirroring importer.js's own cascade -- a session that pulls out "head",
// "hair" and "hand" one after another should not stack them exactly on
// top of each other.
const CASCADE_STEP = 8;
const CASCADE_WRAP = 6;

const els = {};
let session = null;

function cacheElements() {
  for (const id of [
    'clayerOpenBtn', 'clayerFileInput', 'clayerWindow', 'clayerSourceName',
    'clayerStatus', 'clayerDoneBtn', 'clayerCanvas',
    'clayerToolBoundaryBtn', 'clayerToolFillBtn', 'clayerBoundaryRow',
    'clayerDrawBtn', 'clayerEraseBtn', 'clayerBrushBtn', 'clayerBrushMenu',
    'clayerFillHint', 'clayerClearBtn', 'clayerSaveBtn',
    'clayerNameModal', 'clayerNameInput', 'clayerNameConfirmBtn', 'clayerNameCancelBtn',
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
// Entry: pick a source image
//
// A picker of CLayer's own rather than the app's main #fileInput, because
// that one hands whatever is picked straight to partsStore -- exactly the
// step CLayer must NOT take until the user has drawn a boundary, filled it,
// and named the result. Same accept type, same single-purpose <input>, just
// not wired to the same consequence.

export function openClayer() {
  els.clayerFileInput.value = '';
  els.clayerFileInput.click();
}

async function onSourcePicked(event) {
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
  const pixels = readPixels(image);
  URL.revokeObjectURL(objectUrl); // the pixels are already copied out

  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const ctx = canvas.getContext('2d');
  const imageData = ctx.createImageData(image.naturalWidth, image.naturalHeight);
  imageData.data.set(pixels);
  ctx.putImageData(imageData, 0, 0);

  startSession({
    name: displayName(file.name),
    width: image.naturalWidth,
    height: image.naturalHeight,
    pixels,
    bitmap: canvas,
  });
}

// ---------------------------------------------------------------------------
// Session

function startSession({ name, width, height, pixels, bitmap }) {
  session = {
    sourceName: name,
    width,
    height,
    // The WORKING copy. Untouched by drawing a boundary or running a fill
    // -- both of those only ever write to index sets alongside it -- but a
    // SUCCESSFUL SAVE does erase the pixels it just took, to fully
    // transparent, so the source shown in this window keeps reflecting
    // what is actually still there to extract. See
    // eraseExtractedFromWorkingCopy(). The decoded File itself is never
    // touched: it was read once in onSourcePicked and nothing here ever
    // reaches back into it.
    pixels,
    bitmap,
    cam: { zoom: 1, panX: 0, panY: 0 },
    tool: 'boundary', // 'boundary' | 'fill'
    boundaryTool: 'draw', // 'draw' | 'erase'
    brush: 1,
    brushMenuOpen: false,
    // Boundary and fill are both sets of pixel indices (v * width + u),
    // the same representation every other mask in the app already uses
    // (pierceRegion, pins, ...) -- sparse, and cheap to hand-test.
    boundary: new Set(),
    fillMask: null,
    pointers: new Map(),
    pinch: null,
    stroke: null,
    savedCount: 0, // how many extractions this session has saved so far
  };

  els.clayerSourceName.textContent = name;
  els.clayerWindow.hidden = false;

  sizeCanvas();
  fitCamera();
  renderTools();
  render();
}

function endSession() {
  els.clayerWindow.hidden = true;
  session = null;
}

function sizeCanvas() {
  const canvas = els.clayerCanvas;
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(rect.width * dpr));
  canvas.height = Math.max(1, Math.round(rect.height * dpr));
  session.cssWidth = rect.width;
  session.cssHeight = rect.height;
  session.dpr = dpr;
}

// Fit the whole source image on screen with a margin; that zoom is also
// the floor, so the user can always zoom back out to the overview.
function fitCamera() {
  const { width, height, cam } = session;
  const zoom = Math.min(session.cssWidth / width, session.cssHeight / height) * 0.9;
  cam.zoom = Math.min(MAX_ZOOM, zoom);
  session.minZoom = cam.zoom * 0.5;
  cam.panX = (session.cssWidth - width * cam.zoom) / 2;
  cam.panY = (session.cssHeight - height * cam.zoom) / 2;
}

// ---------------------------------------------------------------------------
// Rendering

function drawIndexSet(ctx, indices, width, fill, edge) {
  const { cam } = session;
  const size = cam.zoom;
  ctx.fillStyle = fill;
  for (const index of indices) {
    const u = index % width;
    const v = Math.floor(index / width);
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

function render() {
  if (!session) return;
  const canvas = els.clayerCanvas;
  const ctx = canvas.getContext('2d');
  const { cam, width, height } = session;

  ctx.setTransform(session.dpr, 0, 0, session.dpr, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = '#101014';
  ctx.fillRect(0, 0, session.cssWidth, session.cssHeight);

  ctx.drawImage(session.bitmap, cam.panX, cam.panY, width * cam.zoom, height * cam.zoom);

  // The pixel grid, once cells are big enough to aim at -- the same
  // threshold every other precise-painting window in the app uses.
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

  // The fill highlight sits BENEATH the boundary line, so a boundary drawn
  // right at the edge of the filled area still reads as a crisp pink line
  // rather than being half-swallowed by the green underneath it.
  if (session.fillMask) drawIndexSet(ctx, session.fillMask, width, FILL_COLOR, FILL_EDGE);
  drawIndexSet(ctx, session.boundary, width, BOUNDARY_COLOR, null);

  const fillNote = session.fillMask ? `${session.fillMask.size} px filled` : 'not filled yet';
  els.clayerStatus.textContent =
    `${session.boundary.size} px boundary · ${fillNote} · ${Math.round(cam.zoom * 100)}%`;
  els.clayerSaveBtn.disabled = !session.fillMask;
}

function renderTools() {
  els.clayerToolBoundaryBtn.setAttribute('aria-pressed', String(session.tool === 'boundary'));
  els.clayerToolFillBtn.setAttribute('aria-pressed', String(session.tool === 'fill'));
  els.clayerBoundaryRow.hidden = session.tool !== 'boundary';
  els.clayerFillHint.hidden = session.tool !== 'fill';

  els.clayerDrawBtn.setAttribute('aria-pressed', String(session.boundaryTool === 'draw'));
  els.clayerEraseBtn.setAttribute('aria-pressed', String(session.boundaryTool === 'erase'));
  els.clayerBrushBtn.textContent = `${session.brush} × ${session.brush} ⌄`;
  els.clayerBrushBtn.setAttribute('aria-expanded', String(session.brushMenuOpen));
  els.clayerBrushMenu.hidden = !session.brushMenuOpen;

  els.clayerBrushMenu.replaceChildren();
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
    els.clayerBrushMenu.appendChild(button);
  }
}

// ---------------------------------------------------------------------------
// The boundary brush

function canvasPoint(event) {
  const rect = els.clayerCanvas.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

function texelAt(point) {
  const { cam } = session;
  return {
    u: Math.floor((point.x - cam.panX) / cam.zoom),
    v: Math.floor((point.y - cam.panY) / cam.zoom),
  };
}

function texelIndex(u, v) {
  if (u < 0 || v < 0 || u >= session.width || v >= session.height) return -1;
  return v * session.width + u;
}

function brushIndices(u, v) {
  const size = session.brush;
  const origin = Math.floor((size - 1) / 2);
  const indices = [];
  for (let dv = 0; dv < size; dv++) {
    for (let du = 0; du < size; du++) {
      const index = texelIndex(u - origin + du, v - origin + dv);
      if (index >= 0) indices.push(index);
    }
  }
  return indices;
}

function stamp(texels) {
  const { boundary, stroke } = session;
  const drawing = session.boundaryTool === 'draw';
  for (const { u, v } of texels) {
    for (const index of brushIndices(u, v)) {
      if (drawing ? boundary.has(index) : !boundary.has(index)) continue;
      if (!stroke.touched.has(index)) stroke.touched.set(index, !drawing);
      if (drawing) boundary.add(index); else boundary.delete(index);
      stroke.changed = true;
    }
  }
}

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

function beginBoundaryStroke(point) {
  session.stroke = { touched: new Map(), last: null, changed: false };
  const texel = texelAt(point);
  stamp([texel]);
  session.stroke.last = texel;
  render();
}

function extendBoundaryStroke(point) {
  const texel = texelAt(point);
  const last = session.stroke.last;
  if (last && texel.u === last.u && texel.v === last.v) return;
  if (last) stampLine(last, texel); else stamp([texel]);
  session.stroke.last = texel;
  render();
}

// THE FILL GOES STALE THE MOMENT THE LINE THAT PRODUCED IT MOVES
//
// A fillMask is only ever a true report of "what THIS boundary encloses".
// The instant the boundary changes -- one more stroke, one erased notch --
// that report may no longer be true, and saving it anyway would extract
// pixels the current line does not actually agree with. So any edit that
// actually changed something drops the fill and puts Save back out of
// reach until Fill is run again against the boundary as it now stands.
function endBoundaryStroke() {
  const stroke = session.stroke;
  session.stroke = null;
  if (!stroke) return;
  if (stroke.changed && session.fillMask) {
    session.fillMask = null;
    showToast('Boundary changed — fill it again before saving.');
  }
  render();
}

function abandonBoundaryStroke() {
  const stroke = session.stroke;
  session.stroke = null;
  if (!stroke) return;
  for (const [index, wasOn] of stroke.touched) {
    if (wasOn) session.boundary.add(index); else session.boundary.delete(index);
  }
  render();
}

function clearBoundary() {
  if (!session) return;
  session.boundary.clear();
  session.fillMask = null;
  render();
}

// ---------------------------------------------------------------------------
// The fill
//
// A CLOSED boundary is exactly the boundary that a flood fill, started
// anywhere inside it, cannot escape from -- and "escape" for a fill
// confined to a finite decoded image means reaching the image's own outer
// edge. That single test does the work of two separate rules at once: a
// boundary with a gap lets the fill leak out to the border and is caught
// as "not closed yet" (the fill tool's precondition), and a tap dropped in
// open space with no enclosing line anywhere near it leaks immediately for
// the same reason and is caught as "that point is not inside anything"
// (the mistaken-tap case). Neither needs an arbitrary size cutoff to catch
// a fill that got away from itself, because reaching the border already
// means it did.
//
// 4-connected, deliberately: a boundary brush stroke is drawn as a run of
// touching pixels (stampLine fills in every step of a fast drag), so
// consecutive boundary pixels are always at least diagonally adjacent to
// each other. That is already enough to block a 4-connected fill -- two
// pixels that are only diagonal neighbours of each other are never
// 4-adjacent to each other, so a fill cannot pass between them without
// first landing ON one of them. Allowing the FILL itself to move
// diagonally would undo exactly that seal.
export function floodFillFrom(width, height, boundary, startU, startV) {
  const start = startV * width + startU;
  if (boundary.has(start)) return { ok: false, onBoundary: true, leaked: false };

  const visited = new Set([start]);
  const stack = [start];
  while (stack.length) {
    const index = stack.pop();
    const u = index % width;
    const v = (index - u) / width;
    if (u === 0 || v === 0 || u === width - 1 || v === height - 1) {
      return { ok: false, onBoundary: false, leaked: true };
    }
    // u and v are both strictly interior here (checked above), so all four
    // neighbours below stay in bounds without a per-neighbour edge test.
    const neighbours = [index - 1, index + 1, index - width, index + width];
    for (const n of neighbours) {
      if (visited.has(n) || boundary.has(n)) continue;
      visited.add(n);
      stack.push(n);
    }
  }
  return { ok: true, onBoundary: false, leaked: false, filled: visited };
}

function attemptFill(point) {
  const { u, v } = texelAt(point);
  if (u < 0 || v < 0 || u >= session.width || v >= session.height) {
    showToast('Tap on the image to fill an area.');
    return;
  }

  const result = floodFillFrom(session.width, session.height, session.boundary, u, v);
  if (result.onBoundary) {
    showToast('That point is on the boundary line itself — tap inside the shape you want to fill.');
    return;
  }
  if (result.leaked) {
    showToast(
      'The boundary isn’t a closed loop yet — the fill escaped to the edge of the image. ' +
      'Draw one unbroken line all the way around the area, then try Fill again.'
    );
    return;
  }

  session.fillMask = result.filled;
  render();
}

// ---------------------------------------------------------------------------
// Save: crop the fill out of the WORKING pixels and add it as a Part
//
// The masked buffer is built from session.pixels as it stands AT THIS
// MOMENT. Drawing a boundary or running a fill never touches it -- both of
// those only ever write to index sets alongside it -- so on a session's
// first save this is exactly what the source PNG decoded to, pixel for
// pixel, with nothing resampled and nothing smoothed: a texel is either
// copied whole or left fully transparent, and there is no third option. A
// successful save then erases the texels it just took (see
// eraseExtractedFromWorkingCopy, called after this one lands), so a LATER
// save in the same session reads a working copy with that hole already in
// it -- correctly, since those pixels are already spoken for.

export function buildExtractedPixels(pixels, width, height, fillMask) {
  const masked = new Uint8ClampedArray(width * height * 4);
  for (const index of fillMask) {
    const o = index * 4;
    masked[o] = pixels[o];
    masked[o + 1] = pixels[o + 1];
    masked[o + 2] = pixels[o + 2];
    masked[o + 3] = pixels[o + 3];
  }
  return masked;
}

// THE SOURCE SHOWS WHAT'S LEFT, NOT WHAT USED TO BE THERE
//
// Once a fill is actually saved, those pixels are spoken for. Leaving them
// looking untouched in the working copy would let a second boundary be
// drawn right back over ground already given away -- exactly the
// accidental overlap this is meant to make impossible to miss. So the
// texels the save just took are cleared to fully transparent here, and the
// on-screen bitmap is rebuilt from the same buffer buildExtractedPixels()
// read from, so the two can never disagree about what is left.
//
// This can only ever make a LATER extraction smaller, never wrong: a
// second boundary that happens to cross into an already-erased hole simply
// finds nothing opaque there for contentBounds() to keep, the same as if
// that patch of the source had always been blank.
function eraseExtractedFromWorkingCopy(fillMask) {
  for (const index of fillMask) {
    const o = index * 4;
    session.pixels[o] = 0;
    session.pixels[o + 1] = 0;
    session.pixels[o + 2] = 0;
    session.pixels[o + 3] = 0;
  }
  const ctx = session.bitmap.getContext('2d');
  const imageData = ctx.createImageData(session.width, session.height);
  imageData.data.set(session.pixels);
  ctx.putImageData(imageData, 0, 0);
}

function nextPlacement(width, height) {
  const offset = (session.savedCount % CASCADE_WRAP) * CASCADE_STEP;
  return {
    x: Math.floor((sceneStore.width - width) / 2) + offset,
    y: Math.floor((sceneStore.height - height) / 2) + offset,
  };
}

function openNamePrompt() {
  if (!session || !session.fillMask) return;
  const suggestion = session.savedCount === 0
    ? session.sourceName
    : `${session.sourceName}_${session.savedCount + 1}`;
  els.clayerNameInput.value = suggestion;
  els.clayerNameModal.hidden = false;
  els.clayerNameInput.focus();
}

function closeNamePrompt() {
  els.clayerNameModal.hidden = true;
}

// Extracting from a filled region that turns out to be fully transparent
// in the source (the user filled a blank part of the picture) has nothing
// to save -- reported rather than silently producing a zero-pixel layer.
function saveExtraction() {
  if (!session || !session.fillMask) return;
  const masked = buildExtractedPixels(session.pixels, session.width, session.height, session.fillMask);
  const bounds = contentBounds(masked, session.width, session.height);
  if (!bounds) {
    showToast('The filled area has no visible pixels in the source image.');
    closeNamePrompt();
    return;
  }
  const cropped = cropPixels(masked, session.width, bounds);
  const typed = els.clayerNameInput.value.trim();
  const name = typed || els.clayerNameInput.placeholder || session.sourceName;
  closeNamePrompt();

  // CHECKED FRESH ON EVERY SAVE, NOT ONCE PER CLAYER SESSION
  //
  // One session can extract "head", then "hair", then "hand" without ever
  // re-importing. The FIRST of those can land in an empty project; the
  // second cannot, because the first just populated it -- so this has to
  // be read again right here, not cached from when the window opened.
  const wasEmpty = partsStore.isEmpty;

  let created = null;
  history.run('CLayer: extract layer', () => {
    // An empty project has no canvas size worth respecting yet, so it is
    // set to match this extraction's ORIGINAL SOURCE image -- not the
    // cropped piece's own smaller bounding box -- so the piece lands at
    // the exact position it held in that source and the grid-snapping /
    // position-preserving machinery both work against a canvas that
    // actually matches it. A project that already has layers keeps
    // whatever size it has, unconditionally: that size is presumed
    // intentional, and nothing here may disturb it -- not by resizing it,
    // and not even by asking.
    if (wasEmpty) sceneStore.setSize(session.width, session.height);

    // The same rule Import already applies to a same-size PNG: once the
    // canvas matches this extraction's source dimensions exactly -- true
    // by construction just above whenever the project was empty, or true
    // by plain coincidence otherwise -- the crop is placed at the offset
    // it actually held in that source. Any other canvas size falls back
    // to the ordinary cascade-centred placement, unchanged.
    const matchesSource = sceneStore.width === session.width && sceneStore.height === session.height;
    const placement = matchesSource
      ? { x: bounds.x, y: bounds.y, kind: 'auto' }
      : { ...nextPlacement(bounds.width, bounds.height), kind: 'manual' };

    created = partsStore.add(new Part({
      name,
      image: null,
      pixels: cropped,
      width: bounds.width,
      height: bounds.height,
      objectUrl: null,
      x: placement.x,
      y: placement.y,
      scale: 1,
      placement: placement.kind,
    }));
    partsStore.select(created.id);
  });

  session.savedCount += 1;
  eraseExtractedFromWorkingCopy(session.fillMask);
  // A finished piece is spoken for; the next one starts from a blank
  // boundary on the SAME source image rather than one drawn half over it.
  session.boundary.clear();
  session.fillMask = null;
  renderTools();
  render();
  showToast(`Saved "${created.name}" — ${bounds.width}×${bounds.height} px. Draw the next boundary, or Done.`);
}

// ---------------------------------------------------------------------------
// Input
//
// ONE FINGER DRAWS (Boundary tool) OR TAPS (Fill tool); TWO FINGERS PAN
// AND ZOOM. A second finger arriving mid boundary-stroke means the user
// meant to pinch all along, so that stroke is rolled back exactly like
// Px Pin's and the Pierce painter's strokes are.

function onPointerDown(event) {
  if (!session) return;
  event.preventDefault();
  try { els.clayerCanvas.setPointerCapture(event.pointerId); } catch { /* no-op: no live pointer in tests */ }
  session.pointers.set(event.pointerId, canvasPoint(event));

  if (session.pointers.size === 1) {
    session.pinch = null;
    if (session.tool === 'fill') attemptFill(canvasPoint(event));
    else beginBoundaryStroke(canvasPoint(event));
  } else if (session.pointers.size === 2) {
    if (session.tool === 'boundary') abandonBoundaryStroke(); // two fingers is the camera, never a stroke
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

  if (session.pointers.size === 1 && session.tool === 'boundary' && session.stroke) {
    extendBoundaryStroke(point);
  }
}

function onPointerUp(event) {
  if (!session || !session.pointers.has(event.pointerId)) return;
  session.pointers.delete(event.pointerId);
  if (session.pointers.size < 2) session.pinch = null;
  if (session.pointers.size === 0 && session.tool === 'boundary') endBoundaryStroke();
}

// The CURRENT working copy's own colour at one texel, for tests -- proving
// a saved extraction's source pixels actually went transparent (and stayed
// that way for the rest of the session) without needing to screenshot the
// canvas and guess at colours from pixel art.
export function clayerSourcePixelAt(u, v) {
  if (!session) return null;
  const index = (v * session.width + u) * 4;
  return [session.pixels[index], session.pixels[index + 1], session.pixels[index + 2], session.pixels[index + 3]];
}

// Read-only window into the private session, for tests: the same reason
// pxpinDebug() and pierceToolDebug() exist -- proving the camera and the
// masks live HERE, and that a completed save reaches partsStore, without
// the test needing to reach past this module's own boundary.
export function clayerDebug() {
  if (!session) return null;
  return {
    zoom: session.cam.zoom,
    panX: session.cam.panX,
    panY: session.cam.panY,
    width: session.width,
    height: session.height,
    tool: session.tool,
    boundaryTool: session.boundaryTool,
    brush: session.brush,
    boundarySize: session.boundary.size,
    fillSize: session.fillMask ? session.fillMask.size : null,
    savedCount: session.savedCount,
  };
}

// ---------------------------------------------------------------------------
// Wiring

export function initClayer() {
  cacheElements();

  els.clayerFileInput.addEventListener('change', onSourcePicked);
  els.clayerDoneBtn.addEventListener('click', endSession);

  els.clayerToolBoundaryBtn.addEventListener('click', () => {
    if (!session) return;
    session.tool = 'boundary';
    renderTools();
  });
  els.clayerToolFillBtn.addEventListener('click', () => {
    if (!session) return;
    session.tool = 'fill';
    renderTools();
  });
  els.clayerDrawBtn.addEventListener('click', () => {
    if (session) { session.boundaryTool = 'draw'; renderTools(); }
  });
  els.clayerEraseBtn.addEventListener('click', () => {
    if (session) { session.boundaryTool = 'erase'; renderTools(); }
  });
  els.clayerBrushBtn.addEventListener('click', () => {
    if (!session) return;
    session.brushMenuOpen = !session.brushMenuOpen;
    renderTools();
  });
  els.clayerClearBtn.addEventListener('click', clearBoundary);
  els.clayerSaveBtn.addEventListener('click', openNamePrompt);

  els.clayerNameConfirmBtn.addEventListener('click', saveExtraction);
  els.clayerNameCancelBtn.addEventListener('click', closeNamePrompt);

  els.clayerCanvas.addEventListener('pointerdown', onPointerDown);
  els.clayerCanvas.addEventListener('pointermove', onPointerMove);
  els.clayerCanvas.addEventListener('pointerup', onPointerUp);
  els.clayerCanvas.addEventListener('pointercancel', onPointerUp);

  window.addEventListener('resize', () => {
    if (!session) return;
    sizeCanvas();
    render();
  });
}
