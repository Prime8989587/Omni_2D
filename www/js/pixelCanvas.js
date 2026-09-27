// Keeping a window's pixel-art canvas crisp and its touches honest.
//
// Every full-screen tool window that shows artwork at its own zoom -- Px Pin,
// the Pierce painter, Mesh Trim, PxLink, CLayer, PCreate -- owns a <canvas>
// and a private {zoom, panX, panY}. Each one used to carry its own copy of
// the same few lines for both, copied from the Px Pin window, and the copy
// was missing two things the main canvas has always had (canvas.js and
// view.js). This module is those two things, once, for all of them.
//
// 1. THE BACKING STORE HAS TO FOLLOW THE CANVAS'S OWN BOX
//
// The canvas shares a flex column with the controls under it, so anything
// that changes THEIR height -- a tool's hint line, a row of layer chips, a
// list of links growing -- takes the difference out of the canvas. The
// copies re-measured only when the window opened and when the browser
// window resized, so the backing store kept its old size while the CSS box
// shrank, and the browser stretched the stale bitmap to fit: every texel
// drawn as a rectangle, measured up to 23% taller than wide in Mesh Trim
// after picking Trim Boundary, and 7% in PxLink from the moment it opened.
// Touches read a fresh bounding rect against a camera sized for the old one,
// so they landed off the texel under the finger by the same proportion.
// Watching the element itself catches every cause, not just the one that
// happened to be known (the Pierce painter had already been fixed this way
// on its own; now every window shares it).
//
// 2. ONE SCENE PIXEL HAS TO BE A WHOLE NUMBER OF DEVICE PIXELS
//
// With smoothing off, a texel drawn 3.4 device pixels wide comes out as
// some columns 3 wide and some 4 -- a grid of uneven rectangles that
// shimmers as the zoom changes, which is how "at certain zoom levels the
// pixels turn into rectangles" reads on a phone. The main camera rounds its
// zoom to whole device pixels per scene pixel and its pan to whole device
// pixels (view.snapToDevicePixels); the window cameras never did. They do
// now, when they fit and whenever a pinch ends -- anchored where the fingers
// were, so settling onto the grid does not yank the view.

import { effectiveDpr } from './pixelScale.js';

// Sizes the backing store to the canvas's CSS box at the current device
// pixel ratio. Returns the box (CSS px) and the ratio, or null when the
// canvas has no box -- it is hidden -- in which case nothing is touched.
export function fitBackingStore(canvas) {
  const rect = canvas.getBoundingClientRect();
  if (!(rect.width > 0) || !(rect.height > 0)) return null;
  const dpr = effectiveDpr();
  const width = Math.max(1, Math.round(rect.width * dpr));
  const height = Math.max(1, Math.round(rect.height * dpr));
  // Assigning a canvas's size clears it, so only when it actually changes.
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  return { width: rect.width, height: rect.height, dpr };
}

// Calls onChange whenever the canvas's box changes size, for whatever
// reason, and whenever the window resizes (which also covers a change of
// device pixel ratio). A hidden canvas reports a zero box; that is not a
// size anyone can draw at, so it is skipped rather than passed on.
export function watchCanvasBox(canvas, onChange) {
  const changed = () => {
    const rect = canvas.getBoundingClientRect();
    if (!(rect.width > 0) || !(rect.height > 0)) return;
    onChange();
  };
  if (typeof ResizeObserver === 'function') new ResizeObserver(changed).observe(canvas);
  window.addEventListener('resize', changed);
}

// A tool window's canvas changes size under its camera whenever the rows
// below it do -- a tool with a brush row picked, a hint appearing -- and
// the camera, fitted once when the window opened, used to stay put: the
// artwork slid off-centre and could end up half out of view (Mesh Trim's
// layer lost its bottom third the moment Trim Boundary was chosen). This
// keeps whatever was at the centre of the canvas at its centre, on whole
// device pixels, so a resize never moves the work out from under the user.
export function keepCentred(cam, before, after, dpr = 1) {
  if (!before.width || !before.height) return;
  cam.panX = Math.round((cam.panX + (after.width - before.width) / 2) * dpr) / dpr;
  cam.panY = Math.round((cam.panY + (after.height - before.height) / 2) * dpr) / dpr;
}

// Settles a camera onto the device-pixel grid, holding the screen point
// (anchorX, anchorY) still: zoom becomes a whole number of device pixels per
// scene pixel (when a scene pixel is at least one device pixel -- below that
// there is no crisp size to round to), and pan lands on a device pixel.
// minZoom / maxZoom are kept by rounding inward rather than past them.
export function snapCamera(cam, dpr, anchorX, anchorY, { minZoom = 0, maxZoom = Infinity } = {}) {
  const before = cam.zoom;
  if (before * dpr >= 1) {
    let zoom = Math.round(before * dpr) / dpr;
    if (zoom > maxZoom) zoom = Math.max(1, Math.floor(maxZoom * dpr)) / dpr;
    if (zoom < minZoom) zoom = Math.ceil(minZoom * dpr) / dpr;
    if (zoom > 0 && zoom !== before) {
      const applied = zoom / before;
      cam.panX = anchorX - (anchorX - cam.panX) * applied;
      cam.panY = anchorY - (anchorY - cam.panY) * applied;
      cam.zoom = zoom;
    }
  }
  cam.panX = Math.round(cam.panX * dpr) / dpr;
  cam.panY = Math.round(cam.panY * dpr) / dpr;
}

// The midpoint of the first two points in a pointer map -- where a pinch
// was when it ended, which is the point it should settle about.
export function pinchMidpoint(pointers) {
  const [a, b] = [...pointers.values()];
  if (!a || !b) return null;
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}
