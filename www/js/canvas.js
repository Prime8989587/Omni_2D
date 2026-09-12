// Canvas renderer for the pixel grid.
//
// The scene is an integer W x H bitmap. Every frame the parts are
// rasterized INTO that bitmap by raster.js -- one decision per scene
// pixel, nearest-neighbour, no antialiasing -- and the bitmap is then
// blown up onto the screen through the camera with smoothing off. The
// result is that the artwork is composed only of whole grid cells, at any
// zoom, in any pose.
//
// Everything that is not artwork (bones, handles, the selection outline,
// the weight heatmap) is drawn straight onto the screen in CSS pixels, so
// it keeps a constant size however far the user zooms in.

import { partsStore } from './parts.js';
import { bonesStore } from './bones.js';
import { appState, AppState } from './state.js';
import { getPlacement, getSnapCell, subscribeRig } from './rigTool.js';
import { deformVerticesSnapped, partQuad } from './mesh.js';
import { sceneStore } from './scene.js';
import { view } from './view.js';
import { rasterizeTriangle, clearRegion } from './raster.js';
import {
  pierceOcclusion, pierceMasks, pierceOverlayEnabled, pierceOverlayTexture, pierceOffsets,
  pierceReadout, pierceHold,
} from './pierce.js';

const ACCENT = '#FF2E93';
const SELECTION_OUTLINE_PX = 2;

// Child bones are drawn in a lighter pink than roots, so the hierarchy is
// readable at a glance without consulting the list.
const ROOT_STROKE = ACCENT;
const CHILD_STROKE = '#FF8FC4';
const ROOT_FILL = 'rgba(255, 46, 147, 0.35)';
const CHILD_FILL = 'rgba(255, 143, 196, 0.28)';

// The grid: alternating black and dark grey cells, one per scene pixel,
// at every zoom level -- there is no threshold below which this becomes a
// flat fill. Zoomed out far enough that a cell is under a device pixel,
// checkerPattern() floors it to one device pixel wide rather than fading
// it out, so the pattern is dense there instead of hidden.
const CHECKER_DARK = '#000000';
const CHECKER_LIGHT = '#262626';
const GRID_EDGE = 'rgba(255, 255, 255, 0.28)';

// Rig mode veils the character art so bright pink bones stay readable on
// top of colourful pixel art.
const RIG_VEIL = 'rgba(0, 0, 0, 0.45)';
const MESH_WIRE = 'rgba(255, 143, 196, 0.4)';
const SNAP_CELL_FILL = 'rgba(255, 46, 147, 0.45)';

let canvasEl = null;
let probeEl = null;
let ctx = null;
let viewWidth = 0;
let viewHeight = 0;
let dpr = 1;
let frameRequested = false;

// The scene bitmap and the region of it that currently holds pixels.
let sceneCanvas = null;
let sceneCtx = null;
let sceneImage = null;
let sceneWidth = 0;
let sceneHeight = 0;
let dirty = null; // { x0, y0, x1, y1 } written last frame, cleared next frame

// The checkerboard tile, rebuilt only when the zoom changes.
let checkerTile = null;
let checkerTileZoom = 0;

// ---------------------------------------------------------------------------
// Scene bitmap

function ensureSceneBuffer() {
  if (sceneCanvas && sceneWidth === sceneStore.width && sceneHeight === sceneStore.height) return;

  sceneWidth = sceneStore.width;
  sceneHeight = sceneStore.height;
  sceneCanvas = document.createElement('canvas');
  sceneCanvas.width = sceneWidth;
  sceneCanvas.height = sceneHeight;
  sceneCtx = sceneCanvas.getContext('2d');
  sceneImage = sceneCtx.createImageData(sceneWidth, sceneHeight);
  dirty = null;
}

function boundsOf(positions) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of positions) {
    if (p.x < x0) x0 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.x > x1) x1 = p.x;
    if (p.y > y1) y1 = p.y;
  }
  return { x0: Math.floor(x0) - 1, y0: Math.floor(y0) - 1, x1: Math.ceil(x1) + 1, y1: Math.ceil(y1) + 1 };
}

function unionBounds(a, b) {
  if (!a) return b;
  if (!b) return a;
  return {
    x0: Math.min(a.x0, b.x0),
    y0: Math.min(a.y0, b.y0),
    x1: Math.max(a.x1, b.x1),
    y1: Math.max(a.y1, b.y1),
  };
}

// A part's geometry for this frame: snapped vertex positions, the UVs
// they carry, and the triangle list. Bound parts come from the mesh and
// the skinning; unbound ones are a plain quad. Either way the positions
// are already whole grid coordinates.
function partGeometry(part, boneTransforms) {
  // A piercer driven past its End Point is drawn short of where the drag
  // put it, by exactly the distance the depth refused to go (see
  // pierceHold). The whole sprite moves together -- a needle is rigid, and
  // holding only the painted tip would stretch it -- and the shift lands
  // on whole grid cells like every other position in this renderer.
  const back = part.isPiercer ? pierceHold().get(part.id) : null;
  const place = (positions) => (back
    ? positions.map((p) => ({ x: Math.round(p.x - back.x), y: Math.round(p.y - back.y) }))
    : positions);

  const through = (transforms) => ({
    positions: place(deformVerticesSnapped(part.mesh, part, transforms)),
    uvs: part.mesh.vertices,
    triangles: part.mesh.triangles,
  });

  if (part.mesh && part.mesh.isBound && boneTransforms) return through(boneTransforms);

  // A pierceable layer deforms whether or not it was ever bound to a
  // skeleton -- the solver gives it a mesh precisely so it can -- so it is
  // drawn through that mesh too. Skinning with no transforms is the
  // identity (every weight finds no bone and the vertex falls back to its
  // rest position), which leaves the pierce offsets as the only thing
  // moving it. An EMPTY set rather than the null above, because a layer
  // bound to bones that have since been deleted still reports isBound and
  // would otherwise read a bone out of null.
  if (part.mesh && pierceOffsets(part)) return through(boneTransforms || {});

  const quad = partQuad(part);
  return back ? { ...quad, positions: place(quad.positions) } : quad;
}

// The draw order, with any piercer currently inside a layer split in two:
// its painted tip moved down beneath that layer, the rest of it left where
// it was. Both halves keep the SAME geometry and differ only by which
// texels they are allowed to touch, so the split cannot open a seam.
function buildDrawList(boneTransforms) {
  const entries = partsStore.partsBottomFirst
    .filter((part) => part.visible)
    .map((part) => {
      const geometry = partGeometry(part, boneTransforms);
      return { part, geometry, mask: null, bounds: boundsOf(geometry.positions) };
    });

  for (const [piercerId, pierced] of pierceOcclusion()) {
    const from = entries.findIndex((entry) => entry.part.id === piercerId);
    const to = entries.findIndex((entry) => entry.part.id === pierced.id);
    // Already below the flesh: the stack is doing the job unaided, and
    // moving anything would be a change with nothing to show for it.
    if (from < 0 || to < 0 || from < to) continue;
    const masks = pierceMasks(entries[from].part);
    if (!masks) continue;
    entries[from].mask = masks.rest;
    entries.splice(to, 0, { ...entries[from], mask: masks.region });
  }
  return entries;
}

// Rasterizes every part into the scene bitmap, bottom-first so a higher
// part overwrites a lower one -- z-order IS the collision rule between
// parts. Only the region that changed is cleared and re-uploaded.
function renderScene(boneTransforms) {
  ensureSceneBuffer();
  const buffer = sceneImage.data;

  // Hidden layers keep all their data but are not drawn. Their previous
  // footprint is still cleared, because last frame's bounds are carried in
  // `dirty` and unioned into the region wiped below.
  const drawList = buildDrawList(boneTransforms);

  let touched = dirty;
  for (const entry of drawList) touched = unionBounds(touched, entry.bounds);
  if (!touched) return;

  clearRegion(buffer, sceneWidth, sceneHeight, touched.x0, touched.y0, touched.x1, touched.y1);

  const overlay = pierceOverlayEnabled();
  for (const { part, geometry, mask } of drawList) {
    const { positions, uvs, triangles } = geometry;
    // The region tint rides the same triangles and the same mask, drawn
    // straight after the artwork it belongs to -- so a sunk tip's overlay
    // is occluded exactly as the tip is, and the overlay never claims a
    // pixel the artwork did not.
    const tint = overlay && part.hasPierceRole ? pierceOverlayTexture(part) : null;
    for (const source of tint ? [part.pixels, tint] : [part.pixels]) {
      for (let i = 0; i < triangles.length; i += 3) {
        const a = triangles[i];
        const b = triangles[i + 1];
        const c = triangles[i + 2];
        rasterizeTriangle(
          buffer, sceneWidth, sceneHeight,
          source, part.naturalWidth, part.naturalHeight,
          positions[a], positions[b], positions[c],
          uvs[a], uvs[b], uvs[c], mask
        );
      }
    }
  }

  dirty = null;
  for (const entry of drawList) dirty = unionBounds(dirty, entry.bounds);

  const x0 = Math.max(0, touched.x0);
  const y0 = Math.max(0, touched.y0);
  const x1 = Math.min(sceneWidth, touched.x1);
  const y1 = Math.min(sceneHeight, touched.y1);
  if (x1 > x0 && y1 > y0) sceneCtx.putImageData(sceneImage, 0, 0, x0, y0, x1 - x0, y1 - y0);
}

// ---------------------------------------------------------------------------
// Grid

// A 2x2-cell tile at the current zoom, in whole device pixels so the
// pattern tiles with no seams and no resampling.
function checkerPattern() {
  const zoom = view.zoom;
  if (!checkerTile || checkerTileZoom !== zoom) {
    const cell = Math.max(1, Math.round(zoom * dpr));
    checkerTile = document.createElement('canvas');
    checkerTile.width = cell * 2;
    checkerTile.height = cell * 2;
    const tileCtx = checkerTile.getContext('2d');
    tileCtx.fillStyle = CHECKER_DARK;
    tileCtx.fillRect(0, 0, cell * 2, cell * 2);
    tileCtx.fillStyle = CHECKER_LIGHT;
    tileCtx.fillRect(cell, 0, cell, cell);
    tileCtx.fillRect(0, cell, cell, cell);
    checkerTileZoom = zoom;
  }

  const pattern = ctx.createPattern(checkerTile, 'repeat');
  // The tile is in device pixels; the context draws in CSS pixels. Scaling
  // by 1/dpr lands each tile pixel on exactly one device pixel.
  const rawCell = zoom * dpr;
  const cell = Math.max(1, Math.round(rawCell));
  // The extra zoom*dpr/cell factor nudges the tile back toward the TRUE
  // fractional size Math.round() discarded, so cell boundaries don't
  // creep out of step with the artwork's over a large grid. That only
  // makes sense while cell is tracking rawCell -- once rawCell drops
  // below 1 and cell is pinned at its Math.max(1, ...) floor instead,
  // the same factor pushes the tile to a size SMALLER than one device
  // pixel, which the browser then has to resample. What that produced
  // was not a smaller checkerboard: sampling a sub-pixel repeat against
  // a whole-pixel grid aliases into a moire beat with its own unrelated
  // period (measured: a 0.6-device-px checker came out with a period of
  // 3 device px, not 1). Below one device pixel there is nothing finer
  // to preserve, so the correction is simply skipped and the checker
  // stays at exactly one crisp device pixel -- dense, but real.
  const correction = rawCell >= 1 ? rawCell / cell : 1;
  pattern.setTransform(new DOMMatrix([1 / dpr, 0, 0, 1 / dpr, view.panX, view.panY]).scale(correction));
  return pattern;
}

function drawGrid() {
  const origin = view.toScreen(0, 0);
  const width = sceneStore.width * view.zoom;
  const height = sceneStore.height * view.zoom;

  ctx.fillStyle = checkerPattern();
  ctx.fillRect(origin.x, origin.y, width, height);

  ctx.strokeStyle = GRID_EDGE;
  ctx.lineWidth = 1;
  ctx.strokeRect(origin.x - 0.5, origin.y - 0.5, width + 1, height + 1);
}

// Highlights one grid cell -- the pixel a bone endpoint is snapped to --
// so it is unmistakable that snapping happened.
function drawSnapCell(cell) {
  const p = view.toScreen(cell.x, cell.y);
  ctx.fillStyle = SNAP_CELL_FILL;
  ctx.fillRect(p.x, p.y, view.zoom, view.zoom);
  ctx.strokeStyle = ACCENT;
  ctx.lineWidth = 1.5;
  ctx.strokeRect(p.x, p.y, view.zoom, view.zoom);
}

// ---------------------------------------------------------------------------
// Screen-space overlays

function drawPartOutline(part) {
  // The quad where the part is DRAWN, not where its coordinates say it is.
  // A piercer held back at its End Point is the one case where those differ,
  // and an outline left behind at the raw dragged position would be ringing
  // empty grid several cells away from the artwork it is selecting.
  const back = part.isPiercer ? pierceHold().get(part.id) : null;
  const quad = partQuad(part).positions;
  const placed = back
    ? quad.map((p) => ({ x: Math.round(p.x - back.x), y: Math.round(p.y - back.y) }))
    : quad;
  const corners = placed.map((p) => view.toScreen(p.x, p.y));
  ctx.beginPath();
  ctx.moveTo(corners[0].x, corners[0].y);
  for (let i = 1; i < corners.length; i++) ctx.lineTo(corners[i].x, corners[i].y);
  ctx.closePath();
  ctx.lineWidth = SELECTION_OUTLINE_PX;
  ctx.strokeStyle = ACCENT;
  ctx.stroke();
}

// A bone is drawn as a tapered wedge: widest just past the head, tapering
// to a point at the tail, so its direction is obvious at a glance.
function drawBone(bone, isSelected) {
  const head = view.toScreen(...Object.values(bonesStore.worldHead(bone)));
  const tail = view.toScreen(...Object.values(bonesStore.worldTail(bone)));
  const length = Math.hypot(tail.x - head.x, tail.y - head.y);
  if (length < 0.5) return;

  const dirX = (tail.x - head.x) / length;
  const dirY = (tail.y - head.y) / length;
  const width = Math.min(Math.max(length * 0.14, 3), 11);
  const shoulder = Math.min(length * 0.25, width * 2);

  const shoulderX = head.x + dirX * shoulder;
  const shoulderY = head.y + dirY * shoulder;
  const perpX = -dirY * width;
  const perpY = dirX * width;

  ctx.beginPath();
  ctx.moveTo(head.x, head.y);
  ctx.lineTo(shoulderX + perpX, shoulderY + perpY);
  ctx.lineTo(tail.x, tail.y);
  ctx.lineTo(shoulderX - perpX, shoulderY - perpY);
  ctx.closePath();

  ctx.fillStyle = bone.isRoot ? ROOT_FILL : CHILD_FILL;
  ctx.fill();
  ctx.strokeStyle = bone.isRoot ? ROOT_STROKE : CHILD_STROKE;
  ctx.lineWidth = isSelected ? 3 : 1.5;
  ctx.stroke();

  if (isSelected) {
    for (const [point, radius] of [[head, 7], [tail, 5]]) {
      ctx.beginPath();
      ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
      ctx.fillStyle = ACCENT;
      ctx.fill();
    }
  }
}

// When a child's head has been dragged away from its parent's tail, a
// dashed line keeps the relationship visible.
function drawParentLink(bone) {
  const parent = bonesStore.parentOf(bone);
  if (!parent) return;

  const parentTail = bonesStore.worldTail(parent);
  const head = bonesStore.worldHead(bone);
  if (Math.hypot(head.x - parentTail.x, head.y - parentTail.y) < 0.5) return;

  const from = view.toScreen(parentTail.x, parentTail.y);
  const to = view.toScreen(head.x, head.y);
  ctx.save();
  ctx.beginPath();
  ctx.setLineDash([4, 4]);
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x, to.y);
  ctx.strokeStyle = CHILD_STROKE;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.restore();
}

function drawSkeleton() {
  const origin = view.toScreen(0, 0);
  ctx.fillStyle = RIG_VEIL;
  ctx.fillRect(origin.x, origin.y, sceneStore.width * view.zoom, sceneStore.height * view.zoom);

  for (const bone of bonesStore.bones) drawParentLink(bone);

  const selectedId = bonesStore.selectedId;
  for (const bone of bonesStore.bones) {
    if (!bonesStore.isVisible(bone)) continue;
    drawBone(bone, bone.id === selectedId);
  }

  const cell = getSnapCell();
  if (cell) drawSnapCell(cell);

  // A bone mid-placement: ring the head while we wait for the tail tap.
  const placement = getPlacement();
  if (placement && placement.head) {
    const p = view.toScreen(placement.head.x, placement.head.y);
    ctx.beginPath();
    ctx.arc(p.x, p.y, 8, 0, Math.PI * 2);
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = 2;
    ctx.stroke();
  }
}

// Bind mode overlay: the mesh wireframe plus a per-vertex heatmap of how
// strongly the selected bone influences each vertex.
function drawMeshOverlay(part, boneTransforms, boneId) {
  const { vertices, triangles } = part.mesh;
  const points = deformVerticesSnapped(part.mesh, part, boneTransforms).map((p) => view.toScreen(p.x, p.y));

  ctx.save();
  ctx.beginPath();
  for (let i = 0; i < triangles.length; i += 3) {
    const a = points[triangles[i]];
    const b = points[triangles[i + 1]];
    const c = points[triangles[i + 2]];
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.lineTo(c.x, c.y);
    ctx.closePath();
  }
  ctx.strokeStyle = MESH_WIRE;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.restore();

  if (!boneId) return;

  for (let i = 0; i < vertices.length; i++) {
    const weight = vertices[i].weights[boneId] || 0;
    // Unweighted vertices get no dot at all, so "this bone controls
    // nothing here" reads as clearly as full influence does.
    if (weight <= 0.01) continue;

    ctx.beginPath();
    ctx.arc(points[i].x, points[i].y, 2 + weight * 3, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(255, 46, 147, ${0.15 + weight * 0.85})`;
    ctx.fill();
  }
}

// ---------------------------------------------------------------------------
// Frame

function render() {
  if (!ctx || !canvasEl) return;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  // Reset per frame: setting canvas.width during a resize clears this.
  ctx.imageSmoothingEnabled = false;

  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, viewWidth, viewHeight);

  drawGrid();

  const isRig = appState.state === AppState.RIG;
  const isBind = appState.state === AppState.BIND;
  // One snapshot per frame drives every bound part's skinning.
  const boneTransforms = bonesStore.isEmpty ? null : bonesStore.snapshotTransforms();

  renderScene(boneTransforms);
  captureFrame();
  if (sceneCanvas) {
    ctx.drawImage(
      sceneCanvas,
      0, 0, sceneWidth, sceneHeight,
      view.panX, view.panY, sceneWidth * view.zoom, sceneHeight * view.zoom
    );
  }

  if (isRig) drawSkeleton();

  // Free Move draws NOTHING but the character: no bone bodies, no
  // handles, no parent links, no gizmo of any kind. A drag anywhere moves
  // it, so there is nothing to aim at and nothing to get in the way of
  // watching it move.

  if (isBind) {
    const part = partsStore.selected;
    if (part && part.mesh && part.mesh.isBound && boneTransforms) {
      drawMeshOverlay(part, boneTransforms, bonesStore.selectedId);
    }
    // Bones draw on top so the user can see what they are painting toward.
    for (const bone of bonesStore.bones) {
      if (!bonesStore.isVisible(bone)) continue;
      drawBone(bone, bone.id === bonesStore.selectedId);
    }
  }

  // The selection outline belongs to the Home screen, where layers are
  // what you manipulate. Rig, Bind and Free Move are all about the
  // skeleton, so the outline would just be noise over the artwork.
  const selected = appState.state === AppState.HOME ? partsStore.selected : null;
  if (selected) drawPartOutline(selected);

  drawPierceProbe();

  // FUTURE HOOK: animation playback draws here.
}

// The contact readout, in the same frame as the pixels it describes.
// Reports the gap whether or not it is close enough to do anything -- the
// case worth being able to check is "the tip is 14 px out and nothing is
// moving", which needs the 14 on screen to be distinguishable from a
// solver that is not running at all.
function drawPierceProbe() {
  if (!probeEl) return;
  if (!pierceOverlayEnabled()) {
    probeEl.hidden = true;
    return;
  }
  const lines = pierceReadout().map((r) => {
    if (!r.piercer) return `${r.pierced}: no piercer with a painted tip`;
    const gap = r.inPath ? `${r.gap.toFixed(1)}px` : `${r.gap.toFixed(1)}px off-axis`;
    const zone = r.engaged ? (r.depth >= r.end ? 'AT END' : 'IN') : 'OUT';
    const held = r.held > 0.05
      ? `  held ${r.held.toFixed(1)}px${r.walled > 0.05 ? ` (wall ${r.walled.toFixed(1)}px)` : ''}`
      : '';
    // The press is only worth a line when there is one, and it is worth a
    // line then because a press with nothing visibly reacting is a lever
    // problem rather than a missing force, and this is what says so.
    const press = r.press > 0.005 ? `  press ${(r.press * 100).toFixed(0)}%` : '';
    return `${r.piercer} -> ${r.pierced}\n` +
      `  gap ${gap}  enter ${r.enter}  end ${r.end}\n` +
      `  depth ${r.depth.toFixed(1)}  blend ${(r.t * 100).toFixed(0)}%${press}  ` +
      `${zone}${r.sunk ? '  tip sunk' : ''}${held}`;
  });
  probeEl.textContent = lines.length ? lines.join('\n') : 'pierce: no pierced layer';
  probeEl.hidden = false;
}

export function requestRender() {
  if (frameRequested) return;
  frameRequested = true;
  requestAnimationFrame(() => {
    frameRequested = false;
    render();
  });
}

function resize() {
  if (!canvasEl) return;
  dpr = window.devicePixelRatio || 1;
  // The canvas's own box, not the wrapper's: the wrapper's rect includes
  // its border, which would leave the backing store a few pixels larger
  // than the element and skew every touch coordinate.
  const rect = canvasEl.getBoundingClientRect();

  viewWidth = rect.width;
  viewHeight = rect.height;
  canvasEl.width = Math.round(rect.width * dpr);
  canvasEl.height = Math.round(rect.height * dpr);

  view.setViewport(viewWidth, viewHeight, dpr);
  render();
}

export function initCanvas(canvas) {
  canvasEl = canvas;
  probeEl = document.getElementById('pierceProbe');
  ctx = canvasEl.getContext('2d');

  // Watch the container, not just the window: the canvas also changes size
  // whenever a mode's panels appear or collapse, and a window listener
  // misses that. If the backing store lags behind the element's CSS box,
  // the browser rescales the drawing and every touch coordinate lands in
  // the wrong place.
  new ResizeObserver(resize).observe(canvasEl.parentElement);
  partsStore.subscribe(requestRender);
  bonesStore.subscribe(requestRender);
  appState.subscribe(requestRender);
  sceneStore.subscribe(requestRender);
  view.subscribe(requestRender);
  // Placing a bone's head changes what to draw without touching a store.
  subscribeRig(requestRender);
  resize();
}

export function onEnterAnimateMode() {
  // FUTURE HOOK: show skeleton overlay, enable joint drag handles.
}

export function onExitAnimateMode() {
  // FUTURE HOOK: hide skeleton overlay, cancel any in-progress drag.
}

// ---------------------------------------------------------------------------
// Recording
//
// Frames are taken off the SCENE BITMAP, not off the canvas the user is
// looking at. That buffer is the character at its own resolution on
// transparency -- no checkerboard, no grid, no bone handles, no selection
// outline -- which is exactly what belongs in an exported animation and
// nothing that does not. Reading the display canvas instead would bake the
// whole editor into the file.
//
// Two limits keep a recording from eating the device: frames are sampled
// at a capped rate rather than once per redraw, and there is a hard
// ceiling on how many are kept. A 512x512 frame is a megabyte, so an
// uncapped recording at display rate would be gigabytes within a minute.
const CAPTURE_HZ = 20;
const MAX_FRAMES = 240; // 12 seconds at the capture rate

let recording = false;
let capturedFrames = [];
let captureWidth = 0;
let captureHeight = 0;
let lastCaptureAt = 0;
let captureLoop = null;
let hitFrameLimit = false;

function captureFrame() {
  if (!recording || !sceneImage) return;
  const now = performance.now();
  if (capturedFrames.length > 0 && now - lastCaptureAt < 1000 / CAPTURE_HZ) return;
  if (capturedFrames.length >= MAX_FRAMES) {
    hitFrameLimit = true;
    return;
  }
  lastCaptureAt = now;
  captureWidth = sceneWidth;
  captureHeight = sceneHeight;
  // A copy, not a reference: the buffer is written in place every frame.
  capturedFrames.push(new Uint8ClampedArray(sceneImage.data));
}

export function onStartRecording() {
  recording = true;
  capturedFrames = [];
  hitFrameLimit = false;
  lastCaptureAt = 0;
  // The renderer only draws when something asks it to, so a still moment
  // during a recording would otherwise capture nothing at all and the
  // finished animation would skip over it. Asking for a frame every tick
  // keeps the recording's timeline honest: a pause records as a pause.
  const tick = () => {
    if (!recording) return;
    requestRender();
    captureLoop = requestAnimationFrame(tick);
  };
  captureLoop = requestAnimationFrame(tick);
}

export function onStopRecording() {
  recording = false;
  if (captureLoop !== null) cancelAnimationFrame(captureLoop);
  captureLoop = null;
}

// What was recorded, for the export flow to preview and encode. The frames
// are handed over as they are rather than copied again -- the caller reads
// them and does not write to them.
export function recordedAnimation() {
  return {
    width: captureWidth,
    height: captureHeight,
    frames: capturedFrames,
    captureHz: CAPTURE_HZ,
    truncated: hitFrameLimit,
    maxFrames: MAX_FRAMES,
  };
}

// Dropped once an export is saved or discarded: a megabyte a frame is not
// something to hold on to for a recording nobody is going to use.
export function clearRecording() {
  capturedFrames = [];
  hitFrameLimit = false;
}
