// The PLink window: pick layers, draw where they meet, link them.
//
// The same full-screen tool-window pattern as Mesh Trim and Px Pin: a private
// camera (one finger places, two fingers pan and pinch), nothing in here
// moving any layer. It shows the scene exactly as the renderer draws it --
// through the renderer's own layer geometry -- with the chosen layers lit and
// everything else dimmed, so the joint is drawn where the layers really meet
// right now, whatever pose they are in.
//
// The point is placed like the dent handles in the Pierce window: a round
// grip, grabbed from a fingertip's distance away. Tap to drop it, drag to
// adjust it -- one gesture, so a tap that lands a pixel off can be walked
// onto the joint without lifting.

import { partsStore } from './parts.js';
import { history } from './history.js';
import { rasterizeTriangle } from './raster.js';
import { sceneStore } from './scene.js';
import { layerDrawGeometry } from './canvas.js';
import {
  plinkStore, sceneToTexel, defaultAnchor, distanceToArtwork, linkPositions, currentTransforms,
} from './plink.js';
import { playEnter } from './transitions.js';
import { fitBackingStore, watchCanvasBox, snapCamera, pinchMidpoint } from './pixelCanvas.js';

const TEAL = '#2EE6C8';
const HANDLE_RADIUS = 9;
const HANDLE_GRAB_PX = 30; // a fingertip, as the Pierce window's handles
const MAX_ZOOM = 64;
const DIM_ALPHA = 0.28;
// How far from a layer's artwork a link point may be before the tool says so.
const FAR_FROM_ART_TEXELS = 2;

const els = {};
let session = null;
let toastTimer = null;
let pendingDeleteId = null;

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
    'plinkScreen', 'plinkCanvas', 'plinkStatus', 'plinkDoneBtn', 'plinkLayerChips',
    'plinkAnchorSelect', 'plinkClearBtn', 'plinkCreateBtn', 'plinkHint', 'plinkList',
    'plinkListEmpty', 'plinkCount', 'plinkOpenBtn', 'plinkDeleteModal', 'plinkDeleteMessage',
    'plinkDeleteConfirmBtn', 'plinkDeleteCancelBtn',
  ]) els[id] = document.getElementById(id);
}

const partById = (id) => partsStore.parts.find((part) => part.id === id) || null;
const nameOf = (id) => (partById(id) || { name: '(deleted)' }).name;

export function linkName(link) {
  return link.members.map((m) => nameOf(m.partId)).join(' + ');
}

// ---------------------------------------------------------------------------
// The scene, drawn once per change into two bitmaps: every visible layer (to
// be shown dimmed) and the chosen ones (lit), each through the renderer's own
// geometry so what the window shows is what the canvas shows.

function rasterize(parts, transforms) {
  const W = sceneStore.width;
  const H = sceneStore.height;
  const target = new Uint8ClampedArray(W * H * 4);
  for (const part of parts) {
    const { positions, uvs, triangles } = layerDrawGeometry(part, transforms);
    for (let i = 0; i < triangles.length; i += 3) {
      const a = triangles[i], b = triangles[i + 1], c = triangles[i + 2];
      rasterizeTriangle(target, W, H, part.pixels, part.naturalWidth, part.naturalHeight,
        positions[a], positions[b], positions[c], uvs[a], uvs[b], uvs[c]);
    }
  }
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  const image = ctx.createImageData(W, H);
  image.data.set(target);
  ctx.putImageData(image, 0, 0);
  return canvas;
}

function redrawScene() {
  if (!session) return;
  const transforms = currentTransforms();
  const visible = partsStore.partsBottomFirst.filter((part) => part.visible);
  const lit = visible.filter((part) => session.selected.includes(part.id) || focusedMembers().includes(part.id));
  session.dimBitmap = rasterize(visible, transforms);
  session.litBitmap = rasterize(lit, transforms);
  session.links = linkPositions(transforms);
}

function focusedMembers() {
  const link = session && session.focusId ? plinkStore.byId(session.focusId) : null;
  return link ? link.members.map((m) => m.partId) : [];
}

// ---------------------------------------------------------------------------
// Camera

// The backing store follows the canvas's own box -- see pixelCanvas.js.
// Here it mattered from the first frame: the canvas is measured as the
// window opens, and the layer chips, anchor row and link list rendered
// straight afterwards take their height out of it.
function sizeCanvas() {
  const box = fitBackingStore(els.plinkCanvas);
  if (!box) return;
  session.dpr = box.dpr;
  session.viewWidth = box.width;
  session.viewHeight = box.height;
}

function fitCamera() {
  if (!session.viewWidth || !session.viewHeight) return;
  const W = sceneStore.width;
  const H = sceneStore.height;
  const zoom = Math.max(0.25, Math.min(session.viewWidth / W, session.viewHeight / H) * 0.95);
  session.cam.zoom = zoom;
  session.cam.panX = (session.viewWidth - W * zoom) / 2;
  session.cam.panY = (session.viewHeight - H * zoom) / 2;
  session.minZoom = Math.min(zoom, 1) * 0.5;
  // Whole device pixels per scene pixel, so every pixel draws the same size.
  snapCamera(session.cam, session.dpr, session.viewWidth / 2, session.viewHeight / 2, { maxZoom: MAX_ZOOM });
}

const toScreen = (x, y) => ({ x: session.cam.panX + x * session.cam.zoom, y: session.cam.panY + y * session.cam.zoom });
const toScene = (p) => ({ x: (p.x - session.cam.panX) / session.cam.zoom, y: (p.y - session.cam.panY) / session.cam.zoom });

function canvasPoint(event) {
  const rect = els.plinkCanvas.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

// ---------------------------------------------------------------------------
// Rendering

function render() {
  if (!session) return;
  const ctx = els.plinkCanvas.getContext('2d');
  ctx.setTransform(session.dpr, 0, 0, session.dpr, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = '#101014';
  ctx.fillRect(0, 0, session.viewWidth, session.viewHeight);

  const { zoom, panX, panY } = session.cam;
  const W = sceneStore.width * zoom;
  const H = sceneStore.height * zoom;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
  ctx.lineWidth = 1;
  ctx.strokeRect(panX - 0.5, panY - 0.5, W + 1, H + 1);
  ctx.globalAlpha = DIM_ALPHA;
  ctx.drawImage(session.dimBitmap, panX, panY, W, H);
  ctx.globalAlpha = 1;
  ctx.drawImage(session.litBitmap, panX, panY, W, H);

  // Existing links, at their solved positions -- where every member meets.
  for (const link of session.links) {
    if (link.members.length === 0) continue;
    const p = toScreen(link.members[0].x, link.members[0].y);
    const focused = link.id === session.focusId;
    ctx.beginPath();
    ctx.arc(p.x, p.y, focused ? 8 : 5, 0, Math.PI * 2);
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 4;
    ctx.stroke();
    ctx.strokeStyle = TEAL;
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  // The point being placed: the Pierce window's grip, in PLink's teal.
  if (session.point) {
    const p = toScreen(session.point.x, session.point.y);
    ctx.beginPath();
    ctx.moveTo(p.x - HANDLE_RADIUS - 6, p.y); ctx.lineTo(p.x + HANDLE_RADIUS + 6, p.y);
    ctx.moveTo(p.x, p.y - HANDLE_RADIUS - 6); ctx.lineTo(p.x, p.y + HANDLE_RADIUS + 6);
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.strokeStyle = TEAL;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(p.x, p.y, HANDLE_RADIUS, 0, Math.PI * 2);
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 4;
    ctx.stroke();
    ctx.strokeStyle = TEAL;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = '#FFFFFF';
    ctx.font = '12px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('joint', p.x, p.y - HANDLE_RADIUS - 8);
  }

  renderChrome();
}

function renderChrome() {
  const count = plinkStore.links.length;
  els.plinkStatus.textContent = `${count} link${count === 1 ? '' : 's'} · ${Math.round(session.cam.zoom * 100)}%`;
  els.plinkCount.textContent = String(count);

  const ready = session.selected.length >= 2 && session.point;
  els.plinkCreateBtn.disabled = !ready;
  els.plinkClearBtn.disabled = session.selected.length === 0 && !session.point;
  els.plinkHint.textContent = session.selected.length < 2
    ? 'Pick two or more layers to join.'
    : !session.point
      ? 'Tap where they meet. Two fingers pan, pinch to zoom.'
      : 'Drag the marker onto the joint, then Link.';
}

function renderChips() {
  els.plinkLayerChips.replaceChildren();
  for (const part of partsStore.partsTopFirst) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'toggle-chip';
    chip.textContent = part.name;
    chip.dataset.partId = part.id;
    chip.setAttribute('aria-pressed', String(session.selected.includes(part.id)));
    chip.addEventListener('click', () => toggleLayer(part.id));
    els.plinkLayerChips.appendChild(chip);
  }
}

function renderAnchorSelect() {
  const select = els.plinkAnchorSelect;
  select.replaceChildren();
  const auto = defaultAnchor(session.selected);
  const add = (value, label) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    select.appendChild(option);
  };
  add('auto', auto ? `Auto — ${nameOf(auto)}` : 'Auto — shared');
  for (const id of session.selected) add(id, nameOf(id));
  add('shared', 'Shared — all give way equally');
  if (session.anchor !== 'auto' && session.anchor !== 'shared' && !session.selected.includes(session.anchor)) {
    session.anchor = 'auto';
  }
  select.value = session.anchor;
  select.disabled = session.selected.length < 2;
}

// The links already in the project: name, who holds still, delete.
function renderList() {
  els.plinkList.replaceChildren();
  const links = plinkStore.links;
  els.plinkListEmpty.hidden = links.length > 0;
  for (const link of links) {
    const li = document.createElement('li');
    li.className = 'plink__row';
    li.dataset.linkId = link.id;

    const row = document.createElement('div');
    row.className = 'list-row';
    const show = document.createElement('button');
    show.type = 'button';
    show.className = 'scene-part';
    show.setAttribute('aria-pressed', String(session.focusId === link.id));
    show.textContent = linkName(link);
    const sub = document.createElement('small');
    sub.textContent = link.anchorId ? `${nameOf(link.anchorId)} holds still` : 'shared — all give way';
    show.appendChild(sub);
    show.addEventListener('click', () => focusLink(link.id));
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'row-btn';
    del.textContent = '✕';
    del.dataset.deleteLink = link.id;
    del.setAttribute('aria-label', `Delete link ${linkName(link)}`);
    del.addEventListener('click', () => askDelete(link.id));
    row.append(show, del);

    const anchor = document.createElement('select');
    anchor.className = 'select-input';
    anchor.dataset.anchorFor = link.id;
    anchor.setAttribute('aria-label', `Which layer holds still for ${linkName(link)}`);
    for (const m of link.members) {
      const option = document.createElement('option');
      option.value = m.partId;
      option.textContent = `${nameOf(m.partId)} holds still`;
      anchor.appendChild(option);
    }
    const shared = document.createElement('option');
    shared.value = '';
    shared.textContent = 'Shared — all give way equally';
    anchor.appendChild(shared);
    anchor.value = link.anchorId || '';
    anchor.addEventListener('change', () => {
      history.run('Change PLink anchor', () => plinkStore.setAnchor(link.id, anchor.value || null));
    });

    li.append(row, anchor);
    els.plinkList.appendChild(li);
  }
}

function renderAll() {
  if (!session) return;
  renderChips();
  renderAnchorSelect();
  renderList();
  redrawScene();
  render();
}

// ---------------------------------------------------------------------------
// Actions

function toggleLayer(partId) {
  const i = session.selected.indexOf(partId);
  if (i >= 0) session.selected.splice(i, 1);
  else session.selected.push(partId);
  session.focusId = null;
  renderAll();
}

function focusLink(id) {
  session.focusId = session.focusId === id ? null : id;
  renderAll();
}

function clearDraft() {
  session.selected = [];
  session.point = null;
  session.anchor = 'auto';
  renderAll();
}

function createLink() {
  if (!session || session.selected.length < 2 || !session.point) return;
  const transforms = currentTransforms();
  const members = [];
  const far = [];
  for (const id of session.selected) {
    const part = partById(id);
    if (!part) continue;
    const texel = sceneToTexel(part, session.point, transforms);
    if (!texel) continue;
    // Inverting the layer's mesh leaves float dust (0.9999999999999989 for a
    // point exactly one texel in); a millionth of a texel is far below
    // anything drawable, and keeps saved files readable.
    members.push({ partId: id, u: tidy(texel.u), v: tidy(texel.v) });
    const gap = distanceToArtwork(part, texel.u, texel.v);
    if (gap > FAR_FROM_ART_TEXELS) far.push(`${part.name} (${Math.round(gap)} px away)`);
  }
  if (members.length < 2) { showToast('Those layers could not be linked.'); return; }
  const anchorId = session.anchor === 'shared' ? null
    : session.anchor === 'auto' ? defaultAnchor(members.map((m) => m.partId))
      : session.anchor;
  let link = null;
  history.run('Add PLink', () => { link = plinkStore.add({ members, anchorId }); });
  if (!link) { showToast('Those layers could not be linked.'); return; }
  const where = `(${session.point.x}, ${session.point.y})`;
  session.focusId = link.id;
  session.selected = [];
  session.point = null;
  session.anchor = 'auto';
  renderAll();
  showToast(far.length
    ? `Linked ${linkName(link)} at ${where} — note: the point is off the artwork of ${far.join(', ')}.`
    : `Linked ${linkName(link)} at ${where}.`);
}

function askDelete(id) {
  const link = plinkStore.byId(id);
  if (!link) return;
  pendingDeleteId = id;
  els.plinkDeleteMessage.textContent =
    `"${linkName(link)}" will no longer be held together at this point. ` +
    'The layers keep all their own artwork, bones and weights, and every other link stays as it is.';
  els.plinkDeleteModal.hidden = false;
}

function confirmDelete() {
  const id = pendingDeleteId;
  pendingDeleteId = null;
  els.plinkDeleteModal.hidden = true;
  if (!id) return;
  history.run('Delete PLink', () => plinkStore.remove(id));
  if (session && session.focusId === id) session.focusId = null;
  renderAll();
  showToast('Link deleted.');
}

function cancelDelete() {
  pendingDeleteId = null;
  els.plinkDeleteModal.hidden = true;
}

// ---------------------------------------------------------------------------
// Pointer: one finger places or drags the joint, two fingers move the view.

// Half-pixel steps: a joint usually sits ON the boundary between two layers'
// pixels, which is a pixel edge, not a pixel centre -- so both are reachable.
const snapHalf = (value) => Math.round(value * 2) / 2;
const tidy = (value) => Math.round(value * 1e6) / 1e6;

function placeAt(point) {
  const scene = toScene(point);
  session.point = { x: snapHalf(scene.x), y: snapHalf(scene.y) };
  render();
}

function onPointerDown(event) {
  if (!session) return;
  event.preventDefault();
  try { els.plinkCanvas.setPointerCapture(event.pointerId); } catch { /* synthetic events */ }
  const point = canvasPoint(event);
  session.pointers.set(event.pointerId, point);
  if (session.pointers.size === 2) {
    session.dragging = false;
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
  // Grab the grip if the finger is on it -- the offset keeps it from jumping
  // to the fingertip -- otherwise drop it where the finger is.
  if (session.point) {
    const grip = toScreen(session.point.x, session.point.y);
    if (Math.hypot(point.x - grip.x, point.y - grip.y) <= HANDLE_GRAB_PX) {
      session.dragging = true;
      session.grabOffset = { x: grip.x - point.x, y: grip.y - point.y };
      return;
    }
  }
  session.dragging = true;
  session.grabOffset = { x: 0, y: 0 };
  placeAt(point);
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
  if (session.pointers.size === 1 && session.dragging) {
    placeAt({ x: point.x + session.grabOffset.x, y: point.y + session.grabOffset.y });
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
  if (session.pointers.size === 0) session.dragging = false;
  renderChrome();
}

// ---------------------------------------------------------------------------

export function openPLink() {
  cacheElements();
  if (partsStore.parts.length < 2) {
    showToast('PLink joins two or more layers — import another layer first.');
    return;
  }
  session = {
    // Starts from the layer the user is on, if it can be seen -- a hidden
    // layer is not something anyone means to join by default.
    selected: partsStore.selected && partsStore.selected.visible ? [partsStore.selected.id] : [],
    anchor: 'auto',
    point: null,
    focusId: null,
    cam: { zoom: 1, panX: 0, panY: 0 },
    minZoom: 0.25,
    pointers: new Map(),
    pinch: null,
    dragging: false,
    grabOffset: { x: 0, y: 0 },
    links: [],
  };
  els.plinkScreen.hidden = false;
  playEnter(els.plinkScreen);
  sizeCanvas();
  fitCamera();
  renderAll();
}

export function closePLink() {
  if (!session) return;
  session = null;
  els.plinkScreen.hidden = true;
}

export function isPLinkOpen() {
  return session !== null;
}

export function initPLinkTool() {
  cacheElements();
  if (!els.plinkScreen) return;
  els.plinkCanvas.addEventListener('pointerdown', onPointerDown);
  els.plinkCanvas.addEventListener('pointermove', onPointerMove);
  els.plinkCanvas.addEventListener('pointerup', onPointerUp);
  els.plinkCanvas.addEventListener('pointercancel', onPointerUp);
  els.plinkDoneBtn.addEventListener('click', closePLink);
  els.plinkClearBtn.addEventListener('click', clearDraft);
  els.plinkCreateBtn.addEventListener('click', createLink);
  els.plinkAnchorSelect.addEventListener('change', () => {
    if (session) session.anchor = els.plinkAnchorSelect.value;
  });
  els.plinkDeleteConfirmBtn.addEventListener('click', confirmDelete);
  els.plinkDeleteCancelBtn.addEventListener('click', cancelDelete);
  if (els.plinkOpenBtn) els.plinkOpenBtn.addEventListener('click', openPLink);
  // Undo, redo, a load, or a layer deleted elsewhere can change what the
  // window lists -- it follows the stores rather than its own copy.
  plinkStore.subscribe(() => { if (session) renderAll(); });
  watchCanvasBox(els.plinkCanvas, () => {
    if (!session) return;
    const unmeasured = !session.viewWidth;
    sizeCanvas();
    if (unmeasured) fitCamera();
    render();
  });
}

// Test window onto the session, and where a scene point is in the window.
export function plinkToolDebug() {
  if (!session) return null;
  return {
    selected: [...session.selected],
    point: session.point ? { ...session.point } : null,
    anchor: session.anchor,
    focusId: session.focusId,
    zoom: session.cam.zoom,
    links: plinkStore.links.length,
  };
}

export function plinkWindowPoint(x, y) {
  if (!session) return null;
  const rect = els.plinkCanvas.getBoundingClientRect();
  const p = toScreen(x, y);
  return { x: rect.left + p.x, y: rect.top + p.y };
}
