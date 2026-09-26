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
import { isLinked, ensureLinkMesh, linkPositions } from './pxlink.js';
import { sceneStore } from './scene.js';
import { view } from './view.js';
import { rasterizeTriangle, clearRegion } from './raster.js';
import { outlineRing } from './contour.js';
import { getSetting, shouldRenderFrame } from './settings.js';
import {
  pierceOcclusion, pierceMasks, pierceOverlayEnabled, pierceOverlayTexture,
  pierceReadout, pierceHold,
} from './pierce.js';
import { spreadActive, spreadMasks } from './spread.js';
import { effectiveDpr } from './pixelScale.js';
import { debugViewOn, subscribeDebugOverlay } from './debugOverlay.js';
import { PixelPen } from './pixelDraw.js';
import { NearestRotator } from './pixelRotate.js';

const ACCENT = '#FF2E93';

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
let checkerTileLight = null;

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
function partGeometry(part, boneTransforms, half = null) {
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
    positions: place(deformVerticesSnapped(part.mesh, part, transforms, half)),
    uvs: part.mesh.vertices,
    triangles: part.mesh.triangles,
  });

  if (part.mesh && part.mesh.isBound && boneTransforms) return through(boneTransforms);

  // A pierced layer whose V is open deforms whether or not it was ever bound
  // to a skeleton -- the solver gives it a mesh precisely so its halves can
  // swing -- so it is drawn through that mesh too. Skinning with no
  // transforms is the identity (every weight finds no bone and the vertex
  // falls back to its rest position), which leaves the V as the only thing
  // moving it. An EMPTY set rather than the null above, because a layer
  // bound to bones that have since been deleted still reports isBound and
  // would otherwise read a bone out of null. One SHARED empty set, so every
  // layer this frame is asked about the same transforms and a PxLink solve
  // covering several of them runs once.
  if (part.mesh && spreadActive(part)) return through(boneTransforms || NO_BONES);
  // A layer in a PxLink is drawn through a mesh, bound or not, even in a scene
  // with no bones left: its link is a local weld, and a weld needs vertices
  // to bend. An unbound one gets an unbound mesh, whose skinning is the
  // identity, so it is drawn exactly where its quad would be.
  if (isLinked(part)) {
    ensureLinkMesh(part);
    return through(boneTransforms || NO_BONES);
  }

  const quad = partQuad(part);
  return back ? { ...quad, positions: place(quad.positions) } : quad;
}

// The same geometry, for a tool window that draws layers exactly as the scene
// does (the PxLink window) -- one function, so the two can never disagree.
export function layerDrawGeometry(part, boneTransforms) {
  return partGeometry(part, boneTransforms);
}

const NO_BONES = Object.freeze({});

// The draw order. Two things can split one layer into two draw entries,
// each the SAME layer drawn through a mask of which texels it may touch:
//
//   * a layer split by a seam, while its V is open: its two halves, each
//     drawn through its own deformation (see spread.js) and its own side's
//     texels -- the V is the gap between them;
//   * a piercer in contact: its painted tip moved in the stack -- beneath a
//     plain pierced layer it has entered, or in front of the halves of a V it
//     is going between -- and the rest of it left where it was.
function buildDrawList(boneTransforms) {
  const entries = [];
  for (const part of partsStore.partsBottomFirst) {
    if (!part.visible) continue;
    const halves = spreadMasks(part);
    if (halves) {
      for (const [half, mask] of [['a', halves.a], ['b', halves.b]]) {
        const geometry = partGeometry(part, boneTransforms, half);
        entries.push({ part, geometry, mask, bounds: boundsOf(geometry.positions) });
      }
      continue;
    }
    const geometry = partGeometry(part, boneTransforms);
    entries.push({ part, geometry, mask: null, bounds: boundsOf(geometry.positions) });
  }

  for (const [piercerId, { mode, layers }] of pierceOcclusion()) {
    const from = entries.findIndex((entry) => entry.part.id === piercerId);
    if (from < 0) continue;
    const ids = new Set(layers.map((layer) => layer.id));
    const indices = entries.map((entry, i) => (ids.has(entry.part.id) ? i : -1)).filter((i) => i >= 0);
    if (indices.length === 0) continue;
    const masks = pierceMasks(entries[from].part);
    if (!masks) continue;
    if (mode === 'lift') {
      // Already above every half: the stack is doing the job unaided.
      const top = Math.max(...indices);
      if (from > top) continue;
      const tip = { ...entries[from], mask: masks.region };
      entries[from].mask = masks.rest;
      entries.splice(top + 1, 0, tip);
    } else {
      // Already below the flesh: nothing to do.
      const to = Math.min(...indices);
      if (from < to) continue;
      entries[from].mask = masks.rest;
      entries.splice(to, 0, { ...entries[from], mask: masks.region });
    }
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
  // Returned even when there is nothing to redraw: the contour and the
  // wireframe view are built from it every frame, whether or not the scene
  // bitmap changed.
  if (!touched) return drawList;

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
  return drawList;
}

// ---------------------------------------------------------------------------
// Contour
//
// The outline is the ring of pixels just OUTSIDE the artwork (contour.js
// outlineRing), `thickness` scene pixels deep, painted into a bitmap of its
// own on the SCENE's pixel grid and composited exactly the way the artwork
// is. So it is pixel art in the same sense the character is: whole scene
// pixels, hard edges, growing with the zoom like the thing it outlines,
// and never painted over the artist's own edge pixels. It stays out of the
// scene bitmap itself so captureFrame(), which reads that bitmap, keeps
// exporting the character alone with no rigging aid drawn into the GIF.
//
// Per-layer mode outlines the SELECTED layer only -- the one being worked
// on -- re-rasterized on its own into a scratch buffer, so it is outlined
// as its own shape even where other layers cover it. Full silhouette
// outlines the composed scene: overlapping layers read as ONE shape, which
// is the whole difference between the two modes.

let contourScratch = null;
let contourScratchSize = 0;
let contourScratchUsed = null; // the rectangle last frame's layer was drawn into
let contourCanvas = null;
let contourCtx = null;
let contourRect = null; // where this frame's ring sits, in scene pixels

function contourScratchBuffer() {
  const needed = sceneWidth * sceneHeight * 4;
  if (!contourScratch || contourScratchSize !== needed) {
    contourScratch = new Uint8ClampedArray(needed);
    contourScratchSize = needed;
    contourScratchUsed = null;
  }
  return contourScratch;
}

function contourRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex));
  const n = m ? parseInt(m[1], 16) : 0xFF2E93;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function clampBounds(bounds) {
  const x0 = Math.max(0, Math.floor(bounds.x0));
  const y0 = Math.max(0, Math.floor(bounds.y0));
  const x1 = Math.min(sceneWidth, Math.ceil(bounds.x1));
  const y1 = Math.min(sceneHeight, Math.ceil(bounds.y1));
  return x1 > x0 && y1 > y0 ? { x0, y0, x1, y1 } : null;
}

// The ring for this frame, as a list of scene-pixel indices.
function contourRing(drawList) {
  const mode = getSetting('contourMode');
  if (mode === 'off' || !sceneImage) return [];
  const thickness = getSetting('contourThickness');

  if (mode === 'silhouette') {
    let bounds = null;
    for (const entry of drawList) if (entry.bounds) bounds = unionBounds(bounds, entry.bounds);
    const area = bounds && clampBounds(bounds);
    return area ? outlineRing(sceneImage.data, sceneWidth, sceneHeight, { thickness, bounds: area }) : [];
  }

  const selected = partsStore.selected;
  const entry = selected ? drawList.find((e) => e.part === selected) : null;
  const area = entry && entry.bounds ? clampBounds(entry.bounds) : null;
  if (!area) return [];
  const scratch = contourScratchBuffer();
  const used = contourScratchUsed;
  if (used) clearRegion(scratch, sceneWidth, sceneHeight, used.x0, used.y0, used.x1, used.y1);
  clearRegion(scratch, sceneWidth, sceneHeight, area.x0, area.y0, area.x1, area.y1);
  contourScratchUsed = area;
  const { positions, uvs, triangles } = entry.geometry;
  for (let i = 0; i < triangles.length; i += 3) {
    const a = triangles[i];
    const b = triangles[i + 1];
    const c = triangles[i + 2];
    rasterizeTriangle(
      scratch, sceneWidth, sceneHeight,
      selected.pixels, selected.naturalWidth, selected.naturalHeight,
      positions[a], positions[b], positions[c],
      uvs[a], uvs[b], uvs[c], entry.mask
    );
  }
  return outlineRing(scratch, sceneWidth, sceneHeight, { thickness, bounds: area });
}

function buildContour(drawList) {
  contourRect = null;
  const ring = contourRing(drawList);
  if (ring.length === 0) return;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const index of ring) {
    const x = index % sceneWidth;
    const y = (index - x) / sceneWidth;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const w = maxX - minX + 1;
  const h = maxY - minY + 1;
  if (!contourCanvas) {
    contourCanvas = document.createElement('canvas');
    contourCtx = contourCanvas.getContext('2d');
  }
  if (contourCanvas.width !== w || contourCanvas.height !== h) {
    contourCanvas.width = w;
    contourCanvas.height = h;
  }
  const image = contourCtx.createImageData(w, h);
  const [r, g, b] = contourRgb(getSetting('contourColor'));
  for (const index of ring) {
    const x = index % sceneWidth;
    const y = (index - x) / sceneWidth;
    const o = ((y - minY) * w + (x - minX)) * 4;
    image.data[o] = r;
    image.data[o + 1] = g;
    image.data[o + 2] = b;
    image.data[o + 3] = 255;
  }
  contourCtx.putImageData(image, 0, 0);
  contourRect = { x: minX, y: minY, w, h, pixels: ring.length };
}

// Composited with the same transform as the scene bitmap -- same zoom,
// same pan, same camera angle -- so ring and artwork share one grid.
function drawContour() {
  if (!contourRect) return;
  const p = view.toCanvas(contourRect.x, contourRect.y);
  ctx.drawImage(
    contourCanvas,
    0, 0, contourRect.w, contourRect.h,
    p.x, p.y, contourRect.w * view.zoom, contourRect.h * view.zoom
  );
}

// Test window: what the contour drew this frame.
export function contourDebug() {
  return contourRect ? { ...contourRect, mode: getSetting('contourMode') } : { pixels: 0, mode: getSetting('contourMode') };
}

// ---------------------------------------------------------------------------
// Grid

// The Rig setting's three strengths, as the LIGHT square of the pair. The
// dark square stays black throughout, so what the setting actually changes
// is the contrast between the two -- which is what "how visible is the
// checkerboard" means. CHECKER_LIGHT is the Normal step, unchanged, so the
// default setting reproduces exactly the previous appearance.
const CHECKER_STRENGTHS = {
  subtle: '#1A1A1A',
  normal: CHECKER_LIGHT,
  bold: '#404040',
};

// A 2x2-cell tile at the current zoom, in whole device pixels so the
// pattern tiles with no seams and no resampling.
function checkerPattern() {
  const zoom = view.zoom;
  const light = CHECKER_STRENGTHS[getSetting('checkerStrength')] || CHECKER_LIGHT;
  // The tile is cached against BOTH the zoom it was built for and the
  // strength it was built at, so changing the setting rebuilds it
  // immediately instead of leaving the old contrast on screen until the
  // next time the user happens to zoom.
  if (!checkerTile || checkerTileZoom !== zoom || checkerTileLight !== light) {
    const cell = Math.max(1, Math.round(zoom * dpr));
    checkerTile = document.createElement('canvas');
    checkerTile.width = cell * 2;
    checkerTile.height = cell * 2;
    const tileCtx = checkerTile.getContext('2d');
    tileCtx.fillStyle = CHECKER_DARK;
    tileCtx.fillRect(0, 0, cell * 2, cell * 2);
    tileCtx.fillStyle = light;
    tileCtx.fillRect(cell, 0, cell, cell);
    tileCtx.fillRect(0, cell, cell, cell);
    checkerTileZoom = zoom;
    checkerTileLight = light;
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
  const origin = view.toCanvas(0, 0);
  ctx.fillStyle = checkerPattern();
  ctx.fillRect(origin.x, origin.y, sceneStore.width * view.zoom, sceneStore.height * view.zoom);
}

// Rig mode's veil over the character, in the scene's own frame like the
// checkerboard it sits on, so the two always cover exactly the same area.
function drawVeil() {
  const origin = view.toCanvas(0, 0);
  ctx.fillStyle = RIG_VEIL;
  ctx.fillRect(origin.x, origin.y, sceneStore.width * view.zoom, sceneStore.height * view.zoom);
}

// ---------------------------------------------------------------------------
// The turned view

const rotator = new NearestRotator();
let pictureCanvas = null;
let pictureCtx = null;
let checkerScene = null;
let checkerSceneKey = '';

// The checkerboard at one cell per scene pixel -- exactly what the straight-on
// pattern shows, dark on the scene's (0, 0).
function sceneChecker() {
  const light = CHECKER_STRENGTHS[getSetting('checkerStrength')] || CHECKER_LIGHT;
  const key = `${sceneWidth}x${sceneHeight}:${light}`;
  if (checkerScene && checkerSceneKey === key) return checkerScene;
  checkerScene = document.createElement('canvas');
  checkerScene.width = sceneWidth;
  checkerScene.height = sceneHeight;
  const c = checkerScene.getContext('2d');
  c.fillStyle = CHECKER_DARK;
  c.fillRect(0, 0, sceneWidth, sceneHeight);
  c.fillStyle = light;
  for (let y = 0; y < sceneHeight; y++) {
    for (let x = (y + 1) % 2; x < sceneWidth; x += 2) c.fillRect(x, y, 1, 1);
  }
  checkerSceneKey = key;
  return checkerScene;
}

function drawTurnedPicture(isRig, angle) {
  if (!sceneCanvas) return false;
  if (!pictureCanvas) {
    pictureCanvas = document.createElement('canvas');
    pictureCtx = pictureCanvas.getContext('2d');
  }
  if (pictureCanvas.width !== sceneWidth || pictureCanvas.height !== sceneHeight) {
    pictureCanvas.width = sceneWidth;
    pictureCanvas.height = sceneHeight;
  }
  const c = pictureCtx;
  c.imageSmoothingEnabled = false;
  c.clearRect(0, 0, sceneWidth, sceneHeight);
  c.drawImage(sceneChecker(), 0, 0);
  c.drawImage(sceneCanvas, 0, 0);
  if (contourRect) c.drawImage(contourCanvas, 0, 0, contourRect.w, contourRect.h, contourRect.x, contourRect.y, contourRect.w, contourRect.h);
  if (isRig) {
    c.fillStyle = RIG_VEIL;
    c.fillRect(0, 0, sceneWidth, sceneHeight);
  }
  return rotator.draw(ctx, pictureCanvas, {
    x: view.panX * dpr,
    y: view.panY * dpr,
    width: sceneWidth * view.zoom * dpr,
    height: sceneHeight * view.zoom * dpr,
    angle,
    cx: (viewWidth / 2) * dpr,
    cy: (viewHeight / 2) * dpr,
  });
}

// ---------------------------------------------------------------------------
// Screen-space overlays
//
// EVERY OVERLAY IS PIXEL ART. Canvas paths are anti-aliased with no way to
// turn that off, so nothing below strokes or fills a path: each shape is
// worked out as cells of the interface's pixel grid (pixelDraw.js -- one
// cell is one art pixel, the same 2 px an icon's pixel is) and filled as
// solid squares in raw device pixels. Bones, handles, rings, dashed links,
// wireframes: all hard-edged at any zoom, any camera angle, any screen.
//
// Positions go through view.toScreen, which applies the camera's rotation,
// then onto device pixels -- the only space where "a whole pixel" is a
// promise the screen keeps.

function toDevice(x, y) {
  const p = view.toScreen(x, y);
  return { x: p.x * dpr, y: p.y * dpr };
}

// The canvas border, one cell wide and just OUTSIDE the scene so it never
// sits on a pixel of artwork.
function drawGridEdge(pen) {
  const out = pen.u / dpr / view.zoom / 2;
  const W = sceneStore.width;
  const H = sceneStore.height;
  pen.polyline([
    toDevice(-out, -out), toDevice(W + out, -out), toDevice(W + out, H + out), toDevice(-out, H + out),
  ], GRID_EDGE);
}

// Highlights one grid cell -- the pixel a bone endpoint is snapped to --
// so it is unmistakable that snapping happened.
function drawSnapCell(pen, cell) {
  const corners = [
    toDevice(cell.x, cell.y), toDevice(cell.x + 1, cell.y),
    toDevice(cell.x + 1, cell.y + 1), toDevice(cell.x, cell.y + 1),
  ];
  pen.polygon(corners, SNAP_CELL_FILL);
  pen.polyline(corners, ACCENT);
}

function drawPartOutline(pen, part) {
  // The quad where the part is DRAWN, not where its coordinates say it is.
  // A piercer held back at its End Point is the one case where those differ,
  // and an outline left behind at the raw dragged position would be ringing
  // empty grid several cells away from the artwork it is selecting.
  const back = part.isPiercer ? pierceHold().get(part.id) : null;
  // (A PxLink only welds around its link point, so a linked layer's own quad
  // is still where it is.)
  const quad = partQuad(part).positions;
  const placed = back
    ? quad.map((p) => ({ x: Math.round(p.x - back.x), y: Math.round(p.y - back.y) }))
    : quad;
  pen.polyline(placed.map((p) => toDevice(p.x, p.y)), ACCENT);
}

// A bone is drawn as a tapered wedge: widest just past the head, tapering
// to a point at the tail, so its direction is obvious at a glance.
function drawBone(pen, bone, isSelected) {
  const headScene = bonesStore.worldHead(bone);
  const tailScene = bonesStore.worldTail(bone);
  const head = toDevice(headScene.x, headScene.y);
  const tail = toDevice(tailScene.x, tailScene.y);
  const length = Math.hypot(tail.x - head.x, tail.y - head.y);
  if (length < 0.5 * dpr) return;

  const dirX = (tail.x - head.x) / length;
  const dirY = (tail.y - head.y) / length;
  const width = Math.min(Math.max(length * 0.14, 3 * dpr), 11 * dpr);
  const shoulder = Math.min(length * 0.25, width * 2);
  const shoulderX = head.x + dirX * shoulder;
  const shoulderY = head.y + dirY * shoulder;
  const perpX = -dirY * width;
  const perpY = dirX * width;
  const wedge = [
    head,
    { x: shoulderX + perpX, y: shoulderY + perpY },
    tail,
    { x: shoulderX - perpX, y: shoulderY - perpY },
  ];

  pen.polygon(wedge, bone.isRoot ? ROOT_FILL : CHILD_FILL);
  // Selected reads heavier: a two-cell outline instead of one.
  pen.polyline(wedge, bone.isRoot ? ROOT_STROKE : CHILD_STROKE, { thickness: isSelected ? 2 : 1 });

  if (isSelected) {
    pen.disc(head.x, head.y, 7 * dpr, ACCENT);
    pen.disc(tail.x, tail.y, 5 * dpr, ACCENT);
  }
}

// When a child's head has been dragged away from its parent's tail, a
// dashed line keeps the relationship visible.
function drawParentLink(pen, bone) {
  const parent = bonesStore.parentOf(bone);
  if (!parent) return;

  const parentTail = bonesStore.worldTail(parent);
  const head = bonesStore.worldHead(bone);
  if (Math.hypot(head.x - parentTail.x, head.y - parentTail.y) < 0.5) return;

  const from = toDevice(parentTail.x, parentTail.y);
  const to = toDevice(head.x, head.y);
  pen.line(from.x, from.y, to.x, to.y, CHILD_STROKE, { dash: 2 });
}

function drawSkeleton(pen) {
  for (const bone of bonesStore.bones) drawParentLink(pen, bone);

  const selectedId = bonesStore.selectedId;
  for (const bone of bonesStore.bones) {
    if (!bonesStore.isVisible(bone)) continue;
    drawBone(pen, bone, bone.id === selectedId);
  }

  const cell = getSnapCell();
  if (cell) drawSnapCell(pen, cell);

  // A bone mid-placement: ring the head while we wait for the tail tap.
  const placement = getPlacement();
  if (placement && placement.head) {
    const p = toDevice(placement.head.x, placement.head.y);
    pen.ring(p.x, p.y, 8 * dpr, ACCENT);
  }
}

// A mesh's triangle edges, each drawn once however many triangles share it.
function drawWireframe(pen, points, triangles, color) {
  const seen = new Set();
  const edge = (i, j) => {
    const key = i < j ? `${i}:${j}` : `${j}:${i}`;
    if (seen.has(key)) return;
    seen.add(key);
    pen.line(points[i].x, points[i].y, points[j].x, points[j].y, color);
  };
  for (let t = 0; t < triangles.length; t += 3) {
    edge(triangles[t], triangles[t + 1]);
    edge(triangles[t + 1], triangles[t + 2]);
    edge(triangles[t + 2], triangles[t]);
  }
}

// Bind mode overlay: the selected layer's wireframe (a Debug overlay view)
// plus a per-vertex heatmap of how strongly the selected bone influences
// each vertex -- the heatmap is the weight painter's own readout, not a
// debug view, so it is always drawn.
function drawMeshOverlay(pen, part, boneTransforms, boneId) {
  const { vertices, triangles } = part.mesh;
  const points = deformVerticesSnapped(part.mesh, part, boneTransforms).map((p) => toDevice(p.x, p.y));

  if (debugViewOn('meshWireframe')) drawWireframe(pen, points, triangles, MESH_WIRE);

  if (!boneId) return;
  for (let i = 0; i < vertices.length; i++) {
    const weight = vertices[i].weights[boneId] || 0;
    // Unweighted vertices get no dot at all, so "this bone controls
    // nothing here" reads as clearly as full influence does.
    if (weight <= 0.01) continue;
    // Stepped to four strengths, so the dots are four flat colours rather
    // than a continuous blend.
    const step = Math.ceil(weight * 4) / 4;
    pen.disc(points[i].x, points[i].y, (2 + step * 3) * dpr, `rgba(255, 46, 147, ${0.25 + step * 0.75})`);
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

  const isRig = appState.state === AppState.RIG;
  const isBind = appState.state === AppState.BIND;
  // One snapshot per frame drives every bound part's skinning.
  const boneTransforms = bonesStore.isEmpty ? null : bonesStore.snapshotTransforms();

  const drawList = renderScene(boneTransforms);
  captureFrame();
  // After captureFrame(), which is what keeps the contour out of exported
  // animations.
  if (drawList) buildContour(drawList);

  // THE PICTURE: checkerboard, artwork, then the outline (it belongs to the
  // character, so bone handles stay on top of it and remain grabbable),
  // then Rig mode's veil. All of it is IMAGES on the scene's own pixel grid.
  //
  // Straight on, they are drawn at whole device pixels per scene pixel and
  // nothing is resampled. With the camera turned, they are composed at
  // scene resolution and turned by pixelRotate.js -- nearest sampling, so a
  // turned view is still made of the artwork's own unblended pixels. (The
  // 2D context's own rotate() is only the fallback for a device with no
  // WebGL: it blends.) The black backdrop above is outside all this, so a
  // turned view has no unpainted corners.
  const angle = view.rotation;
  const turned = angle !== 0 && drawTurnedPicture(isRig, angle);
  if (!turned) {
    if (angle !== 0) {
      ctx.translate(viewWidth / 2, viewHeight / 2);
      ctx.rotate(angle);
      ctx.translate(-viewWidth / 2, -viewHeight / 2);
    }
    drawGrid();
    if (sceneCanvas) {
      ctx.drawImage(
        sceneCanvas,
        0, 0, sceneWidth, sceneHeight,
        view.panX, view.panY, sceneWidth * view.zoom, sceneHeight * view.zoom
      );
    }
    drawContour();
    if (isRig) drawVeil();
  }

  // Everything after this is an overlay, drawn cell by cell in device space
  // (toDevice applies the camera's angle to each point), which is what
  // keeps them hard-edged when the view is turned.
  const pen = new PixelPen(ctx, dpr).begin();
  drawGridEdge(pen);

  if (isRig) drawSkeleton(pen);

  // Free Move draws NOTHING but the character: no bone bodies, no
  // handles, no parent links, no gizmo of any kind. A drag anywhere moves
  // it, so there is nothing to aim at and nothing to get in the way of
  // watching it move. (The Debug overlay's views are the exception, and
  // only when asked for.)

  if (isBind) {
    const part = partsStore.selected;
    if (part && part.mesh && part.mesh.isBound && boneTransforms) {
      drawMeshOverlay(pen, part, boneTransforms, bonesStore.selectedId);
    }
    // Bones draw on top so the user can see what they are painting toward.
    for (const bone of bonesStore.bones) {
      if (!bonesStore.isVisible(bone)) continue;
      drawBone(pen, bone, bone.id === bonesStore.selectedId);
    }
  } else if (drawList && debugViewOn('meshWireframe')) {
    // Everywhere else the wireframe is every layer's: the geometry each one
    // is actually drawn with this frame, deformed, split or plain quad.
    for (const { geometry } of drawList) {
      const points = geometry.positions.map((p) => toDevice(p.x, p.y));
      drawWireframe(pen, points, geometry.triangles, MESH_WIRE);
    }
  }

  // PxLink points, where the rig is being built -- so the joints that hold
  // separate layers together are visible alongside the bones. Not in Free
  // Move, which draws nothing but the character.
  if (isRig || isBind) drawPxLinkMarkers(pen, boneTransforms);

  // The selection outline belongs to the Home screen, where layers are
  // what you manipulate. Rig, Bind and Free Move are all about the
  // skeleton, so the outline would just be noise over the artwork.
  const selected = appState.state === AppState.HOME ? partsStore.selected : null;
  if (selected) drawPartOutline(pen, selected);
  pen.end();

  drawPierceProbe();

  // FUTURE HOOK: animation playback draws here.
}

// A ring at each PxLink point, at the SOLVED position -- where every member
// of the link actually meets. Teal, like nothing else on the canvas, and one
// ring however many layers the link joins, since they all meet there. A
// black ring either side keeps it readable over any artwork.
const PXLINK_RING = '#2EE6C8';
function drawPxLinkMarkers(pen, boneTransforms) {
  const links = linkPositions(boneTransforms || NO_BONES);
  for (const link of links) {
    if (link.members.length === 0) continue;
    const at = link.members[0];
    const p = toDevice(at.x, at.y);
    pen.ring(p.x, p.y, 7 * dpr + pen.u, '#000000');
    pen.ring(p.x, p.y, 7 * dpr - pen.u, '#000000');
    pen.ring(p.x, p.y, 7 * dpr, PXLINK_RING);
    pen.square(p.x, p.y, 0, PXLINK_RING);
  }
}

// The contact readout, in the same frame as the pixels it describes.
// Reports the gap whether or not it is close enough to do anything -- the
// case worth being able to check is "the tip is 14 px out and nothing is
// moving", which needs the 14 on screen to be distinguishable from a
// solver that is not running at all.
function drawPierceProbe() {
  if (!probeEl) return;
  if (!debugViewOn('pierceReadout')) {
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
    // The V's trigger is printed next to its opening because the two
    // together are the only way to tell "not opening yet" from "not working".
    const swings = r.swings.length
      ? `  halves ${r.swings.map((deg) => `${deg >= 0 ? '+' : ''}${deg.toFixed(1)}°`).join(' ')}`
      : '';
    const v = r.mode === 'off' ? '  (no V)' : `  V ${(r.open * 100).toFixed(0)}%${swings}`;
    return `${r.piercer} -> ${r.pierced}\n` +
      `  gap ${gap}  enter ${r.enter}  end ${r.end}  dent at ${r.dentStart}\n` +
      `  depth ${r.depth.toFixed(1)}${v}${press}  ` +
      `${zone}${r.inFront ? '  tip in front' : ''}${r.sunk ? '  tip sunk' : ''}${held}`;
  });
  probeEl.textContent = lines.length ? lines.join('\n') : 'pierce: no pierced layer';
  probeEl.hidden = false;
}

// The scene render is already coalesced -- many stores can each ask for a
// frame and only one is drawn -- so Screen Rate is applied by DEFERRING a
// frame whose turn has not come rather than dropping it. Dropping would be
// wrong here: unlike the petals or the physics loop, this is edge-driven,
// and a dropped request is not a slightly coarser animation, it is a real
// change that never reaches the screen at all.
const renderRateToken = { name: 'scene' };

// ONE FRAME, IN ORDER: simulate, THEN draw.
//
// The springs and the pierce solver used to run in a requestAnimationFrame
// loop of their own, separate from this one. Two rAF callbacks in one frame
// run in the order they were registered, and the render's was registered
// first -- by the pointermove that started the frame -- so every frame drew
// BEFORE it simulated. Measured during a live Free-Move drag: in 16 frames
// out of 16 the renderer read the bones before that frame's physics step.
// What reached the screen was this frame's rigid bones, moved by the
// finger, wearing LAST frame's spring angles: the simulation's answer for a
// frame was never shown in that frame, only in the next, by which time the
// rigid bones had moved on again. A stale pose every frame, stitched onto a
// current one.
//
// So there is one driver. physics.js registers its step here, and each
// frame runs it first and renders second, both inside the same callback:
// bone transforms, including spring settling and contact, are fully
// resolved before skinning reads them, and skinning is resolved before a
// pixel is drawn. Nothing in a frame reads anything from the frame before.
let frameStep = null;

export function setFrameStep(step) {
  frameStep = step;
}

export function requestRender() {
  if (frameRequested) return;
  frameRequested = true;
  const attempt = (timestamp) => {
    if (!shouldRenderFrame(renderRateToken, timestamp)) {
      requestAnimationFrame(attempt);
      return;
    }
    frameRequested = false;
    const stillMoving = frameStep ? frameStep(timestamp) : false;
    render();
    // A simulation still settling needs the next frame whether or not
    // anything else asks for one.
    if (stillMoving) requestRender();
  };
  requestAnimationFrame(attempt);
}

function resize() {
  if (!canvasEl) return;
  dpr = effectiveDpr();
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
  subscribeDebugOverlay(requestRender);
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
