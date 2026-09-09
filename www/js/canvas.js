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
import { view, MIN_VISIBLE_CELL_PX } from './view.js';
import { rasterizeTriangle, clearRegion } from './raster.js';

const ACCENT = '#FF2E93';
const SELECTION_OUTLINE_PX = 2;

// Child bones are drawn in a lighter pink than roots, so the hierarchy is
// readable at a glance without consulting the list.
const ROOT_STROKE = ACCENT;
const CHILD_STROKE = '#FF8FC4';
const ROOT_FILL = 'rgba(255, 46, 147, 0.35)';
const CHILD_FILL = 'rgba(255, 143, 196, 0.28)';

// The grid: alternating black and dark grey cells, one per scene pixel.
const CHECKER_DARK = '#000000';
const CHECKER_LIGHT = '#262626';
// When cells are too small to resolve, the grid is a flat tone instead of
// a moiré pattern.
const GRID_FLAT = '#161616';
const GRID_EDGE = 'rgba(255, 255, 255, 0.28)';

// Rig mode veils the character art so bright pink bones stay readable on
// top of colourful pixel art.
const RIG_VEIL = 'rgba(0, 0, 0, 0.45)';
const MESH_WIRE = 'rgba(255, 143, 196, 0.4)';
const SNAP_CELL_FILL = 'rgba(255, 46, 147, 0.45)';

let canvasEl = null;
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
  if (part.mesh && part.mesh.isBound && boneTransforms) {
    return {
      positions: deformVerticesSnapped(part.mesh, part, boneTransforms),
      uvs: part.mesh.vertices,
      triangles: part.mesh.triangles,
    };
  }
  return partQuad(part);
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
  const drawList = partsStore.partsBottomFirst.filter((part) => part.visible).map((part) => {
    const geometry = partGeometry(part, boneTransforms);
    return { part, geometry, bounds: boundsOf(geometry.positions) };
  });

  let touched = dirty;
  for (const entry of drawList) touched = unionBounds(touched, entry.bounds);
  if (!touched) return;

  clearRegion(buffer, sceneWidth, sceneHeight, touched.x0, touched.y0, touched.x1, touched.y1);

  for (const { part, geometry } of drawList) {
    const { positions, uvs, triangles } = geometry;
    for (let i = 0; i < triangles.length; i += 3) {
      const a = triangles[i];
      const b = triangles[i + 1];
      const c = triangles[i + 2];
      rasterizeTriangle(
        buffer, sceneWidth, sceneHeight,
        part.pixels, part.naturalWidth, part.naturalHeight,
        positions[a], positions[b], positions[c],
        uvs[a], uvs[b], uvs[c]
      );
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
  const cell = Math.max(1, Math.round(zoom * dpr));
  pattern.setTransform(new DOMMatrix([1 / dpr, 0, 0, 1 / dpr, view.panX, view.panY]).scale(zoom * dpr / cell));
  return pattern;
}

function drawGrid() {
  const origin = view.toScreen(0, 0);
  const width = sceneStore.width * view.zoom;
  const height = sceneStore.height * view.zoom;

  ctx.fillStyle = view.zoom >= MIN_VISIBLE_CELL_PX ? checkerPattern() : GRID_FLAT;
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
  const corners = partQuad(part).positions.map((p) => view.toScreen(p.x, p.y));
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
  if (sceneCanvas) {
    ctx.drawImage(
      sceneCanvas,
      0, 0, sceneWidth, sceneHeight,
      view.panX, view.panY, sceneWidth * view.zoom, sceneHeight * view.zoom
    );
  }

  if (isRig) drawSkeleton();

  // Free Move: the bones are the handles, so they have to be visible --
  // but without the rig veil, since this screen is for watching the
  // character move rather than for building the skeleton.
  if (appState.state === AppState.ANIMATING) {
    for (const bone of bonesStore.bones) {
      if (!bonesStore.isVisible(bone)) continue;
      drawParentLink(bone);
      drawBone(bone, bone.id === bonesStore.selectedId);
    }
  }

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

  // FUTURE HOOK: animation playback draws here.
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

// Placeholder no-ops mirroring the app's state transitions. ui.js already
// calls these at the right moments, so wiring in real behavior later is a
// matter of filling them in.

export function onEnterAnimateMode() {
  // FUTURE HOOK: show skeleton overlay, enable joint drag handles.
}

export function onExitAnimateMode() {
  // FUTURE HOOK: hide skeleton overlay, cancel any in-progress drag.
}

export function onStartRecording() {
  // FUTURE HOOK: begin capturing frames for GIF/MP4 export.
}

export function onStopRecording() {
  // FUTURE HOOK: stop capturing frames and hand the captured data off to
  // the export flow (see ui.js's handleSave) once real encoding exists.
}
