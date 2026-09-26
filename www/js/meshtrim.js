// Mesh Trim: the Bind-mode tool for editing a layer's mesh, and for
// reshaping the layer's own silhouette with a freehand boundary.
//
// TWO CAPABILITIES, ONE WINDOW
//
// The vertex tools (Add / Move / Remove) change the MESH -- the internal
// structure the deformation runs on. Trim Boundary changes the ARTWORK --
// which pixels the layer has at all. They share a window because they share
// a question ("is this layer the right shape?") and because trimming the
// artwork forces the mesh to be rebuilt anyway, so having both here is what
// lets that rebuild happen without the user going anywhere.
//
// WHAT IS REUSED RATHER THAN REBUILT
//
//   * the freehand boundary brush, flood fill and masking -- clayer.js, the
//     same drawing mechanic and the same closed-loop test
//   * vertex editing and re-triangulation -- meshedit.js, pure and tested
//   * mesh generation and auto-weighting -- mesh.js
//   * the destructive-vs-copy setting -- the settings store, alongside
//     PCreate's, defaulting the same safe way
//
// Nothing here re-implements any of those.

import { partsStore } from './parts.js';
import { bonesStore } from './bones.js';
import { view } from './view.js';
import { history } from './history.js';
import { generateMesh, defaultDensity, autoWeightMesh } from './mesh.js';
import {
  addVertex, moveVertex, removeVertex, vertexAt, triangleAt,
  transferWeights, meshProblems, hitRadius,
} from './meshedit.js';
import { floodFillFrom, buildExtractedPixels } from './clayer.js';
import { contentBounds, cropPixels } from './importer.js';
import { getSetting, setSetting } from './settings.js';
import { playEnter } from './transitions.js';
import { pxlinkStore } from './pxlink.js';
import { fitBackingStore, watchCanvasBox, snapCamera, pinchMidpoint } from './pixelCanvas.js';

const WIRE_COLOR = 'rgba(255, 46, 147, 0.75)';
const VERTEX_COLOR = '#FF2E93';
const VERTEX_SELECTED = '#FFFFFF';
const BOUNDARY_COLOR = 'rgba(255, 46, 147, 0.9)';
const MAX_ZOOM = 64;
const VERTEX_DOT = 3; // css px radius at any zoom -- a target, not a texel

const els = {};
let session = null;
let toastTimer = null;
let exitCallback = () => {};

function showToast(message) {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, 4000);
}

function cacheElements() {
  for (const id of [
    'meshTrimScreen', 'meshTrimCanvas', 'meshTrimTitle', 'meshTrimStatus',
    'meshTrimDoneBtn', 'meshTrimToolRow', 'meshTrimAddBtn', 'meshTrimMoveBtn',
    'meshTrimRemoveBtn', 'meshTrimBoundaryBtn', 'meshTrimActionRow',
    'meshTrimRemoveVertexBtn', 'meshTrimClearBoundaryBtn', 'meshTrimTrimBtn',
    'meshTrimEditModeToggle', 'meshTrimHint', 'meshTrimOpenBtn',
  ]) els[id] = document.getElementById(id);
}

// ---------------------------------------------------------------------------
// Camera: the same non-destructive pinch/pan every tool window uses.

function fitCamera() {
  const rect = els.meshTrimCanvas.getBoundingClientRect();
  const zoom = Math.max(1, Math.floor(Math.min(rect.width / session.width, rect.height / session.height)));
  session.cam.zoom = zoom;
  session.cam.panX = Math.round((rect.width - session.width * zoom) / 2);
  session.cam.panY = Math.round((rect.height - session.height * zoom) / 2);
  session.minZoom = Math.max(0.25, Math.min(1, zoom));
}

function canvasPoint(event) {
  const rect = els.meshTrimCanvas.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

// Screen point to source texel. Floating point on purpose -- meshedit snaps
// it, and snapping here first would lose the sub-texel information that
// decides which triangle a tap landed in.
function texelAt(point) {
  return {
    u: (point.x - session.cam.panX) / session.cam.zoom,
    v: (point.y - session.cam.panY) / session.cam.zoom,
  };
}

function texelToScreen(u, v) {
  return { x: session.cam.panX + u * session.cam.zoom, y: session.cam.panY + v * session.cam.zoom };
}

// ---------------------------------------------------------------------------
// Rendering

// The backing store follows the canvas's own box -- see pixelCanvas.js.
// Picking a tool changes the hint and action rows under the canvas, which
// is exactly the change that used to leave this stale.
function sizeCanvas() {
  const box = fitBackingStore(els.meshTrimCanvas);
  if (!box) return;
  session.dpr = box.dpr;
  session.viewWidth = box.width;
  session.viewHeight = box.height;
}

function render() {
  if (!session) return;
  const canvas = els.meshTrimCanvas;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(session.dpr, 0, 0, session.dpr, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, session.viewWidth, session.viewHeight);

  const { zoom, panX, panY } = session.cam;

  // The artwork, from the working copy so a trim shows immediately.
  ctx.drawImage(session.bitmap, panX, panY, session.width * zoom, session.height * zoom);

  // The boundary the user is drawing, in texel blocks.
  if (session.boundary.size > 0) {
    ctx.fillStyle = BOUNDARY_COLOR;
    for (const index of session.boundary) {
      const u = index % session.width;
      const v = (index - u) / session.width;
      ctx.fillRect(panX + u * zoom, panY + v * zoom, zoom, zoom);
    }
  }

  // The wireframe -- only ever drawn here, which is the whole point of the
  // toggle: Bind mode's own canvas is left exactly as it was.
  const mesh = session.part.mesh;
  if (mesh && session.tool !== 'boundary') {
    ctx.strokeStyle = WIRE_COLOR;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i < mesh.triangles.length; i += 3) {
      const a = mesh.vertices[mesh.triangles[i]];
      const b = mesh.vertices[mesh.triangles[i + 1]];
      const c = mesh.vertices[mesh.triangles[i + 2]];
      if (!a || !b || !c) continue;
      const pa = texelToScreen(a.u, a.v);
      const pb = texelToScreen(b.u, b.v);
      const pc = texelToScreen(c.u, c.v);
      ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y);
      ctx.lineTo(pc.x, pc.y); ctx.closePath();
    }
    ctx.stroke();

    mesh.vertices.forEach((vertex, index) => {
      const p = texelToScreen(vertex.u, vertex.v);
      ctx.fillStyle = index === session.selected ? VERTEX_SELECTED : VERTEX_COLOR;
      ctx.beginPath();
      ctx.arc(p.x, p.y, index === session.selected ? VERTEX_DOT + 1.5 : VERTEX_DOT, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  renderChrome();
}

function renderChrome() {
  const mesh = session.part.mesh;
  const counts = mesh ? `${mesh.vertices.length} vertices · ${mesh.triangles.length / 3} triangles` : 'no mesh';
  els.meshTrimStatus.textContent = session.tool === 'boundary'
    ? `${session.boundary.size} px boundary · ${Math.round(session.cam.zoom * 100)}%`
    : `${counts} · ${Math.round(session.cam.zoom * 100)}%`;

  for (const [tool, button] of [
    ['add', els.meshTrimAddBtn], ['move', els.meshTrimMoveBtn],
    ['remove', els.meshTrimRemoveBtn], ['boundary', els.meshTrimBoundaryBtn],
  ]) button.setAttribute('aria-pressed', String(session.tool === tool));

  els.meshTrimRemoveVertexBtn.hidden = session.tool !== 'remove';
  els.meshTrimRemoveVertexBtn.disabled = session.selected === null;
  els.meshTrimClearBoundaryBtn.hidden = session.tool !== 'boundary';
  els.meshTrimTrimBtn.hidden = session.tool !== 'boundary';
  els.meshTrimTrimBtn.disabled = session.boundary.size === 0;

  els.meshTrimEditModeToggle.hidden = session.tool !== 'boundary';
  const inPlace = getSetting('meshTrimInPlace');
  els.meshTrimEditModeToggle.setAttribute('aria-pressed', String(inPlace));
  els.meshTrimEditModeToggle.textContent = inPlace
    ? 'Trim the original directly'
    : 'Trim onto a copy';

  els.meshTrimHint.textContent = {
    add: 'Tap inside the mesh to insert a vertex there. Two fingers pan, pinch to zoom.',
    move: 'Drag a vertex to move it. It snaps to whole pixels.',
    remove: 'Tap a vertex to select it, then Remove. The hole is re-triangulated.',
    boundary: 'Draw a closed loop around what you want to KEEP, then Trim.',
  }[session.tool];
}

// ---------------------------------------------------------------------------
// Pointer handling

function onPointerDown(event) {
  if (!session) return;
  event.preventDefault();
  try { els.meshTrimCanvas.setPointerCapture(event.pointerId); } catch { /* no-op in tests */ }
  const point = canvasPoint(event);
  session.pointers.set(event.pointerId, point);

  if (session.pointers.size === 2) {
    abandonStroke();
    const [a, b] = [...session.pointers.values()];
    session.pinch = {
      distance: Math.hypot(b.x - a.x, b.y - a.y),
      zoom: session.cam.zoom,
      mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      panX: session.cam.panX,
      panY: session.cam.panY,
    };
    return;
  }
  if (session.pointers.size !== 1) return;
  session.pinch = null;

  const texel = texelAt(point);
  if (session.tool === 'boundary') { beginBoundaryStroke(texel); return; }

  const hit = vertexAt(session.part.mesh, texel.u, texel.v, hitRadius(session.part.mesh, session.part));
  if (session.tool === 'move') {
    session.selected = hit >= 0 ? hit : null;
    session.dragging = hit >= 0 ? hit : null;
    render();
    return;
  }
  if (session.tool === 'remove') {
    session.selected = hit >= 0 ? hit : null;
    render();
    return;
  }
  if (session.tool === 'add') {
    const result = addVertex(session.part.mesh, session.part, texel.u, texel.v);
    if (!result.ok) { showToast(result.reason); return; }
    session.selected = result.index;
    session.dirty = true;
    partsStore.notifyTransformed();
    render();
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
  if (session.pointers.size !== 1) return;

  const texel = texelAt(point);
  if (session.tool === 'boundary') { extendBoundaryStroke(texel); return; }
  if (session.tool === 'move' && session.dragging !== null) {
    moveVertex(session.part.mesh, session.part, session.dragging, texel.u, texel.v);
    session.dirty = true;
    partsStore.notifyTransformed();
    render();
  }
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
  if (session.pointers.size === 0) {
    session.dragging = null;
    endBoundaryStroke();
  }
}

// ---------------------------------------------------------------------------
// The freehand boundary -- the same brush mechanic CLayer uses.

function beginBoundaryStroke(texel) {
  session.stroke = { touched: new Map(), last: null };
  extendBoundaryStroke(texel);
}

function stampAt(u, v) {
  const x = Math.floor(u);
  const y = Math.floor(v);
  if (x < 0 || y < 0 || x >= session.width || y >= session.height) return;
  const index = y * session.width + x;
  if (session.boundary.has(index)) return;
  if (!session.stroke.touched.has(index)) session.stroke.touched.set(index, false);
  session.boundary.add(index);
}

// Every step between two samples is stamped, so a fast drag leaves an
// unbroken line -- the seal the closed-loop test depends on.
function stampLine(from, to) {
  const steps = Math.max(1, Math.ceil(Math.hypot(to.u - from.u, to.v - from.v)));
  for (let i = 0; i <= steps; i++) {
    stampAt(from.u + ((to.u - from.u) * i) / steps, from.v + ((to.v - from.v) * i) / steps);
  }
}

function extendBoundaryStroke(texel) {
  if (!session.stroke) return;
  if (session.stroke.last) stampLine(session.stroke.last, texel); else stampAt(texel.u, texel.v);
  session.stroke.last = { u: texel.u, v: texel.v };
  render();
}

function endBoundaryStroke() {
  session.stroke = null;
  render();
}

function abandonStroke() {
  if (!session.stroke) return;
  for (const index of session.stroke.touched.keys()) session.boundary.delete(index);
  session.stroke = null;
  render();
}

function clearBoundary() {
  session.boundary.clear();
  render();
}

// ---------------------------------------------------------------------------
// The trim
//
// A CLOSED loop is exactly the loop a flood fill started inside cannot
// escape from -- clayer.js's own test, reused rather than restated. The fill
// gives the set of texels to KEEP; everything else becomes transparent.

function runTrim() {
  if (!session || session.boundary.size === 0) return;

  // Seed from the first texel inside the loop that is not itself boundary.
  // Scanning for it rather than asking the user to tap one keeps Trim a
  // single action, and a loop with no interior is caught below anyway.
  let filled = null;
  for (let v = 0; v < session.height && !filled; v++) {
    for (let u = 0; u < session.width; u++) {
      if (session.boundary.has(v * session.width + u)) continue;
      const result = floodFillFrom(session.width, session.height, session.boundary, u, v);
      if (result.ok) { filled = result.filled; break; }
    }
  }
  if (!filled) {
    showToast('That loop is not closed — the fill leaks out to the edge.');
    return;
  }

  // The boundary line itself is kept: the user drew it ON the artwork they
  // meant to keep, and discarding it would eat a one-pixel rim off the
  // shape they just drew.
  for (const index of session.boundary) filled.add(index);

  const trimmed = buildExtractedPixels(session.pixels, session.width, session.height, filled);
  let opaque = 0;
  for (let i = 3; i < trimmed.length; i += 4) if (trimmed[i] !== 0) opaque++;
  if (opaque === 0) {
    showToast('That would leave nothing behind.');
    return;
  }

  // Crop to what is actually left. Without this the layer keeps its old
  // dimensions with transparent margins, the mesh regenerates to exactly
  // the grid it already had, and "the boundary was reshaped" would be true
  // of the pixels and false of everything downstream that reads the layer's
  // size. Cropping is what makes the reshape real.
  const bounds = contentBounds(trimmed, session.width, session.height);
  const cropped = cropPixels(trimmed, session.width, bounds);

  const inPlace = getSetting('meshTrimInPlace');
  const sourceMesh = session.part.mesh;
  let landed = null;
  history.run(inPlace ? 'Trim layer' : 'Trim layer to a copy', () => {
    const target = inPlace ? session.part : (partsStore.duplicate(session.part.id) || session.part);
    landed = target;
    applyTrim(target, cropped, bounds, sourceMesh);
  });

  session.boundary.clear();
  // The window follows the layer it was opened on. On the copy path that is
  // still the ORIGINAL, which is now untouched -- so the working copy is put
  // back to the original's pixels rather than left showing a trim that did
  // not happen to it.
  if (inPlace) {
    session.part = landed;
    session.width = landed.naturalWidth;
    session.height = landed.naturalHeight;
    session.pixels = new Uint8ClampedArray(landed.pixels);
    session.bitmap.width = session.width;
    session.bitmap.height = session.height;
    refreshBitmap();
    fitCamera();
  } else {
    session.pixels = new Uint8ClampedArray(session.part.pixels);
    refreshBitmap();
  }
  render();
  showToast(inPlace
    ? `Trimmed — ${opaque} px kept, mesh rebuilt.`
    : `Trimmed onto "${landed.name}" — original untouched.`);
}

// Replace the artwork, then rebuild the mesh against it and carry the
// weights across. Doing the rebuild HERE rather than leaving it to the next
// Auto-weight is the point: a mesh shaped for the old silhouette sitting on
// the new one is exactly the stale state this has to avoid.
//
// `bounds` is where the kept artwork sat inside the OLD image, which is what
// lets the weight transfer compare the same physical pixel on both sides of
// the crop rather than the same index.
function applyTrim(part, cropped, bounds, sourceMesh) {
  part.pixels = cropped;
  // `naturalWidth`/`naturalHeight` are read-only views of these two; the
  // decoded `image` is dropped because it is still the pre-trim size, and
  // Part's own rule is that it is only kept while it matches the pixels.
  part.sourceWidth = bounds.width;
  part.sourceHeight = bounds.height;
  part.image = null;
  // The crop moved the artwork's top-left within the old frame; shifting the
  // layer's own origin by the same amount leaves it exactly where it was on
  // screen instead of jumping by the size of the margin that was cut away.
  part.x += bounds.x;
  part.y += bounds.y;
  // PxLink points are held in the layer's own texel space, so they move with
  // the crop to stay on the same physical pixel.
  pxlinkStore.shiftAnchors(part.id, -bounds.x, -bounds.y);

  const rebuilt = generateMesh(part, (sourceMesh && sourceMesh.density) || defaultDensity(part));
  if (sourceMesh && sourceMesh.isBound) {
    transferWeights(sourceMesh, rebuilt, { offsetU: bounds.x, offsetV: bounds.y });
  } else {
    autoWeightMesh(rebuilt, part, bonesStore);
  }
  part.mesh = rebuilt;
  partsStore.notifyTransformed();
}

function refreshBitmap() {
  const canvas = session.bitmap;
  const ctx = canvas.getContext('2d');
  const image = ctx.createImageData(session.width, session.height);
  image.data.set(session.pixels);
  ctx.putImageData(image, 0, 0);
}

// ---------------------------------------------------------------------------
// Vertex actions

function removeSelected() {
  if (session.selected === null) return;
  const result = removeVertex(session.part.mesh, session.part, session.selected);
  if (!result.ok) { showToast(result.reason); return; }
  session.selected = null;
  session.dirty = true;
  partsStore.notifyTransformed();
  render();
  showToast(`Vertex removed — hole re-filled with ${result.patchTriangles} triangles.`);
}

function setTool(tool) {
  session.tool = tool;
  session.selected = null;
  session.dragging = null;
  abandonStroke();
  render();
}

// ---------------------------------------------------------------------------

export function openMeshTrim(part) {
  if (!part) { showToast('Select a layer first.'); return; }
  cacheElements();

  const bitmap = document.createElement('canvas');
  bitmap.width = part.naturalWidth;
  bitmap.height = part.naturalHeight;

  session = {
    part,
    width: part.naturalWidth,
    height: part.naturalHeight,
    // A working copy, so nothing is written to the layer until Trim runs.
    pixels: new Uint8ClampedArray(part.pixels),
    bitmap,
    cam: { zoom: 1, panX: 0, panY: 0 },
    minZoom: 1,
    pointers: new Map(),
    pinch: null,
    tool: 'move',
    selected: null,
    dragging: null,
    boundary: new Set(),
    stroke: null,
    dirty: false,
  };

  if (!part.mesh) {
    part.mesh = generateMesh(part, defaultDensity(part));
    autoWeightMesh(part.mesh, part, bonesStore);
  }

  els.meshTrimTitle.textContent = part.name;
  els.meshTrimScreen.hidden = false;
  playEnter(els.meshTrimScreen);
  refreshBitmap();
  sizeCanvas();
  fitCamera();
  render();
}

export function closeMeshTrim() {
  if (!session) return;
  session = null;
  els.meshTrimScreen.hidden = true;
  exitCallback();
}

export function isMeshTrimOpen() {
  return session !== null;
}

export function initMeshTrim({ onExit } = {}) {
  cacheElements();
  if (!els.meshTrimScreen) return;
  if (onExit) exitCallback = onExit;

  els.meshTrimCanvas.addEventListener('pointerdown', onPointerDown);
  els.meshTrimCanvas.addEventListener('pointermove', onPointerMove);
  els.meshTrimCanvas.addEventListener('pointerup', onPointerUp);
  els.meshTrimCanvas.addEventListener('pointercancel', onPointerUp);

  els.meshTrimAddBtn.addEventListener('click', () => setTool('add'));
  els.meshTrimMoveBtn.addEventListener('click', () => setTool('move'));
  els.meshTrimRemoveBtn.addEventListener('click', () => setTool('remove'));
  els.meshTrimBoundaryBtn.addEventListener('click', () => setTool('boundary'));
  els.meshTrimRemoveVertexBtn.addEventListener('click', removeSelected);
  els.meshTrimClearBoundaryBtn.addEventListener('click', clearBoundary);
  els.meshTrimTrimBtn.addEventListener('click', runTrim);
  els.meshTrimEditModeToggle.addEventListener('click', () => {
    setSetting('meshTrimInPlace', !getSetting('meshTrimInPlace'));
    renderChrome();
  });
  els.meshTrimDoneBtn.addEventListener('click', closeMeshTrim);
  // Launched from Bind mode on whichever layer is selected there -- the
  // same layer Auto-weight and the weight brush are already acting on, so
  // the tool never needs its own separate idea of "which layer".
  if (els.meshTrimOpenBtn) {
    els.meshTrimOpenBtn.addEventListener('click', () => openMeshTrim(partsStore.selected));
  }

  watchCanvasBox(els.meshTrimCanvas, () => {
    if (!session) return;
    const unmeasured = !session.viewWidth;
    sizeCanvas();
    if (unmeasured) fitCamera();
    render();
  });
}

// Test window: the mesh's real state, and whether it is still valid, without
// a test having to re-derive either from the canvas.
export function meshTrimDebug() {
  if (!session) return null;
  const mesh = session.part.mesh;
  return {
    layer: session.part.name,
    tool: session.tool,
    selected: session.selected,
    zoom: session.cam.zoom,
    panX: session.cam.panX,
    panY: session.cam.panY,
    boundarySize: session.boundary.size,
    vertices: mesh ? mesh.vertices.length : 0,
    triangles: mesh ? mesh.triangles.length / 3 : 0,
    problems: mesh ? meshProblems(mesh) : ['no mesh'],
    inPlace: getSetting('meshTrimInPlace'),
  };
}
