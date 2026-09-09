// Canvas renderer.
//
// Draws the scene's Parts back-to-front with image smoothing disabled, so
// pixel art stays blocky at any scale instead of being blurred by the
// browser's default bilinear interpolation.
//
// This is also where the bone/skeleton renderer and animation playback
// will live in a later part -- see the FUTURE HOOK notes below.

import { partsStore } from './parts.js';
import { bonesStore } from './bones.js';
import { appState, AppState } from './state.js';
import { getPlacement, subscribeRig } from './rigTool.js';
import { deformVertices } from './mesh.js';

const ACCENT = '#FF2E93';
const SELECTION_OUTLINE_PX = 2;

// Child bones are drawn in a lighter pink than roots, so the hierarchy is
// readable at a glance without consulting the list.
const ROOT_STROKE = ACCENT;
const CHILD_STROKE = '#FF8FC4';
const ROOT_FILL = 'rgba(255, 46, 147, 0.35)';
const CHILD_FILL = 'rgba(255, 143, 196, 0.28)';

// Rig mode veils the character art so bright pink bones stay readable on
// top of colorful pixel art.
const RIG_VEIL = 'rgba(0, 0, 0, 0.45)';

// How far each triangle's corners are pushed outward to hide the seams
// between independently-clipped neighbours. Tuned by measurement: at 0.5
// the antialiased clip edges still left ~1px seam lines about 2% darker
// than the flat sprite; 1.2 closes them completely.
const SEAM_EXPAND_PX = 1.2;
const MESH_WIRE = 'rgba(255, 143, 196, 0.4)';

let canvasEl = null;
let ctx = null;
let viewWidth = 0;
let viewHeight = 0;
let frameRequested = false;

export function getViewSize() {
  return { width: viewWidth, height: viewHeight };
}

// Canvas2D cannot draw a textured triangle directly, so each triangle is
// clipped and then filled with the image under the unique affine map that
// carries the triangle's three UVs onto its three deformed positions.
// Solving for that map is standard: it is the 2x3 matrix satisfying
// M*(u,v,1) = (x,y) at all three corners.
function drawTexturedTriangle(image, a, b, c, pa, pb, pc) {
  // Adjacent triangles are clipped independently, and the antialiased
  // clip edges would otherwise leave hairline seams between them. Pushing
  // each corner very slightly outward makes neighbours overlap instead.
  // The image itself is not enlarged: past its edge drawImage produces
  // nothing, so the sprite's outer boundary stays exact.
  const cx = (pa.x + pb.x + pc.x) / 3;
  const cy = (pa.y + pb.y + pc.y) / 3;
  const expand = (p) => {
    const dx = p.x - cx;
    const dy = p.y - cy;
    const length = Math.hypot(dx, dy) || 1;
    return { x: p.x + (dx / length) * SEAM_EXPAND_PX, y: p.y + (dy / length) * SEAM_EXPAND_PX };
  };

  const u1 = b.u - a.u;
  const v1 = b.v - a.v;
  const u2 = c.u - a.u;
  const v2 = c.v - a.v;
  const det = u1 * v2 - u2 * v1;
  if (det === 0) return; // degenerate triangle in UV space

  const x1 = pb.x - pa.x;
  const y1 = pb.y - pa.y;
  const x2 = pc.x - pa.x;
  const y2 = pc.y - pa.y;

  const m11 = (x1 * v2 - x2 * v1) / det;
  const m12 = (y1 * v2 - y2 * v1) / det;
  const m21 = (x2 * u1 - x1 * u2) / det;
  const m22 = (y2 * u1 - y1 * u2) / det;
  const dx = pa.x - m11 * a.u - m21 * a.v;
  const dy = pa.y - m12 * a.u - m22 * a.v;

  const ea = expand(pa);
  const eb = expand(pb);
  const ec = expand(pc);

  ctx.save();
  ctx.beginPath();
  ctx.moveTo(ea.x, ea.y);
  ctx.lineTo(eb.x, eb.y);
  ctx.lineTo(ec.x, ec.y);
  ctx.closePath();
  ctx.clip();
  // transform(), not setTransform(), so the device-pixel-ratio base
  // transform is preserved rather than replaced.
  ctx.transform(m11, m12, m21, m22, dx, dy);
  ctx.drawImage(image, 0, 0);
  ctx.restore();
}

function drawMeshedPart(part, deformed) {
  const { vertices, triangles } = part.mesh;
  for (let i = 0; i < triangles.length; i += 3) {
    const ia = triangles[i];
    const ib = triangles[i + 1];
    const ic = triangles[i + 2];
    drawTexturedTriangle(
      part.image,
      vertices[ia], vertices[ib], vertices[ic],
      deformed[ia], deformed[ib], deformed[ic]
    );
  }
}

function drawPart(part, isSelected, boneTransforms) {
  // A bound part is drawn through its mesh so bone movement deforms it.
  // At rest the skinning collapses to the part's own transform, so this
  // produces the same pixels as the flat path below.
  if (part.mesh && part.mesh.isBound && boneTransforms) {
    drawMeshedPart(part, deformVertices(part.mesh, part, boneTransforms));
  } else {
    ctx.save();
    ctx.translate(part.x, part.y);
    ctx.rotate(part.rotation);
    ctx.scale(part.scale, part.scale);
    ctx.drawImage(part.image, -part.naturalWidth / 2, -part.naturalHeight / 2, part.naturalWidth, part.naturalHeight);
    ctx.restore();
  }

  if (!isSelected) return;

  ctx.save();
  ctx.translate(part.x, part.y);
  ctx.rotate(part.rotation);
  ctx.scale(part.scale, part.scale);
  // Divided by the part's scale so the outline is always the same
  // thickness on screen, however far the part is zoomed in or out.
  ctx.lineWidth = SELECTION_OUTLINE_PX / part.scale;
  ctx.strokeStyle = ACCENT;
  ctx.strokeRect(-part.naturalWidth / 2, -part.naturalHeight / 2, part.naturalWidth, part.naturalHeight);
  ctx.restore();
}

// A bone is drawn as a tapered wedge: widest just past the head, tapering
// to a point at the tail, so its direction is obvious at a glance.
function drawBone(bone, isSelected) {
  const head = bonesStore.worldHead(bone);
  const tail = bonesStore.worldTail(bone);
  const length = Math.hypot(tail.x - head.x, tail.y - head.y);
  if (length < 0.5) return;

  const dirX = (tail.x - head.x) / length;
  const dirY = (tail.y - head.y) / length;
  const width = Math.min(Math.max(length * 0.14, 3), 11);
  const shoulder = Math.min(length * 0.25, width * 2);

  const shoulderX = head.x + dirX * shoulder;
  const shoulderY = head.y + dirY * shoulder;
  // Perpendicular to the bone direction.
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
    // Handles are only shown for the selected bone -- they are what the
    // head/tail drags grab.
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
  if (Math.hypot(head.x - parentTail.x, head.y - parentTail.y) < 2) return;

  ctx.save();
  ctx.beginPath();
  ctx.setLineDash([4, 4]);
  ctx.moveTo(parentTail.x, parentTail.y);
  ctx.lineTo(head.x, head.y);
  ctx.strokeStyle = CHILD_STROKE;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.restore();
}

function drawSkeleton() {
  ctx.fillStyle = RIG_VEIL;
  ctx.fillRect(0, 0, viewWidth, viewHeight);

  for (const bone of bonesStore.bones) drawParentLink(bone);

  const selectedId = bonesStore.selectedId;
  for (const bone of bonesStore.bones) drawBone(bone, bone.id === selectedId);

  // A bone mid-placement: mark where its head landed while we wait for
  // the tap that sets the tail.
  const placement = getPlacement();
  if (placement && placement.head) {
    ctx.beginPath();
    ctx.arc(placement.head.x, placement.head.y, 8, 0, Math.PI * 2);
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = 2;
    ctx.stroke();
  }
}

// Bind mode overlay: the mesh wireframe plus a per-vertex heatmap of how
// strongly the selected bone influences each vertex.
function drawMeshOverlay(part, deformed, boneId) {
  const { vertices, triangles } = part.mesh;

  ctx.save();
  ctx.beginPath();
  for (let i = 0; i < triangles.length; i += 3) {
    const a = deformed[triangles[i]];
    const b = deformed[triangles[i + 1]];
    const c = deformed[triangles[i + 2]];
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
    ctx.arc(deformed[i].x, deformed[i].y, 2 + weight * 3, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(255, 46, 147, ${0.15 + weight * 0.85})`;
    ctx.fill();
  }
}

function render() {
  if (!ctx || !canvasEl) return;

  // Reset per frame: setting canvas.width during a resize clears this.
  ctx.imageSmoothingEnabled = false;

  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, viewWidth, viewHeight);

  const isRig = appState.state === AppState.RIG;
  const isBind = appState.state === AppState.BIND;
  // Parts are not selectable in Rig mode, so their outline would be noise.
  const selectedId = isRig ? null : partsStore.selectedId;
  // One snapshot per frame drives every bound part's skinning.
  const boneTransforms = bonesStore.isEmpty ? null : bonesStore.snapshotTransforms();

  for (const part of partsStore.partsBottomFirst) {
    drawPart(part, !isBind && part.id === selectedId, boneTransforms);
  }

  if (isRig) drawSkeleton();

  if (isBind) {
    const part = partsStore.selected;
    if (part && part.mesh && boneTransforms) {
      drawMeshOverlay(part, deformVertices(part.mesh, part, boneTransforms), bonesStore.selectedId);
    }
    // Bones draw on top so the user can see what they are painting toward.
    for (const bone of bonesStore.bones) drawBone(bone, bone.id === bonesStore.selectedId);
  }

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
  const dpr = window.devicePixelRatio || 1;
  // The canvas's own box, not the wrapper's: the wrapper's rect includes
  // its border, which would leave the backing store a few pixels larger
  // than the element and skew every touch coordinate.
  const rect = canvasEl.getBoundingClientRect();

  viewWidth = rect.width;
  viewHeight = rect.height;
  canvasEl.width = Math.round(rect.width * dpr);
  canvasEl.height = Math.round(rect.height * dpr);

  // Draw in CSS pixels; the backing store carries the extra device pixels.
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
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
