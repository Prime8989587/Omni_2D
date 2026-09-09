// The camera: how the scene's pixel grid maps onto the phone screen.
//
// Scene units are pixels of the grid; screen units are CSS pixels of the
// canvas element. zoom is how many CSS pixels one scene pixel occupies,
// and (panX, panY) is where scene pixel (0,0) lands on screen.
//
//   screen = scene * zoom + pan
//
// Every tool converts pointer positions through toScene() on the way in,
// and the renderer converts through toScreen() on the way out, so the
// model code in between never knows a camera exists.

import { sceneStore } from './scene.js';

const MIN_ZOOM = 0.05;
const MAX_ZOOM = 48;
const FIT_MARGIN = 0.94; // a little air around the grid when fitted

// Checker cells (and therefore artwork pixels) only look crisp when they
// are a whole number of device pixels wide. Below this many CSS pixels per
// cell the checkerboard collapses into moiré, so the renderer draws a flat
// tone instead.
export const MIN_VISIBLE_CELL_PX = 3;

let zoom = 1;
let panX = 0;
let panY = 0;
let viewWidth = 0;
let viewHeight = 0;
let dpr = 1;

// Pointers currently down on the canvas, tracked so the single-finger
// tools can tell when a second finger has arrived and step aside for a
// pinch.
const activePointerIds = new Set();

const listeners = new Set();

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function emit() {
  listeners.forEach((listener) => listener());
}

export const view = {
  get zoom() {
    return zoom;
  },
  get panX() {
    return panX;
  },
  get panY() {
    return panY;
  },
  get viewWidth() {
    return viewWidth;
  },
  get viewHeight() {
    return viewHeight;
  },
  get activePointerCount() {
    return activePointerIds.size;
  },

  subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },

  toScene(screenX, screenY) {
    return { x: (screenX - panX) / zoom, y: (screenY - panY) / zoom };
  },

  toScreen(sceneX, sceneY) {
    return { x: sceneX * zoom + panX, y: sceneY * zoom + panY };
  },

  setViewport(width, height, devicePixelRatio) {
    const firstLayout = viewWidth === 0 || viewHeight === 0;
    viewWidth = width;
    viewHeight = height;
    dpr = devicePixelRatio || 1;
    if (firstLayout) this.fit();
    else emit();
  },

  // Shows the whole grid, centred.
  fit() {
    if (!viewWidth || !viewHeight) return;
    const sceneWidth = sceneStore.width;
    const sceneHeight = sceneStore.height;
    zoom = clamp(Math.min(viewWidth / sceneWidth, viewHeight / sceneHeight) * FIT_MARGIN, MIN_ZOOM, MAX_ZOOM);
    panX = (viewWidth - sceneWidth * zoom) / 2;
    panY = (viewHeight - sceneHeight * zoom) / 2;
    this.snapToDevicePixels();
  },

  // Scales about a screen point, so whatever is under the fingers stays
  // under the fingers.
  zoomAround(factor, screenX, screenY) {
    const next = clamp(zoom * factor, MIN_ZOOM, MAX_ZOOM);
    const applied = next / zoom;
    panX = screenX - (screenX - panX) * applied;
    panY = screenY - (screenY - panY) * applied;
    zoom = next;
    emit();
  },

  panBy(dx, dy) {
    panX += dx;
    panY += dy;
    emit();
  },

  // One frame of a two-finger gesture: zoom by how much the fingers spread
  // and pan by how much their midpoint moved.
  pinch(prevA, prevB, currentA, currentB) {
    const prevDistance = Math.hypot(prevB.x - prevA.x, prevB.y - prevA.y);
    const currentDistance = Math.hypot(currentB.x - currentA.x, currentB.y - currentA.y);
    const prevCenterX = (prevA.x + prevB.x) / 2;
    const prevCenterY = (prevA.y + prevB.y) / 2;
    const centerX = (currentA.x + currentB.x) / 2;
    const centerY = (currentA.y + currentB.y) / 2;

    if (prevDistance > 0) this.zoomAround(currentDistance / prevDistance, centerX, centerY);
    this.panBy(centerX - prevCenterX, centerY - prevCenterY);
  },

  // Called when a gesture ends. A whole number of device pixels per scene
  // pixel keeps every cell the same crisp size; pan is snapped too so the
  // grid's edges never straddle a device pixel.
  snapToDevicePixels() {
    if (zoom * dpr >= 1) zoom = Math.round(zoom * dpr) / dpr;
    panX = Math.round(panX * dpr) / dpr;
    panY = Math.round(panY * dpr) / dpr;
    emit();
  },

  trackPointer(pointerId) {
    activePointerIds.add(pointerId);
  },

  releasePointer(pointerId) {
    activePointerIds.delete(pointerId);
  },
};

// A resized grid gets refitted so it is never left half off-screen.
sceneStore.subscribe(() => view.fit());
