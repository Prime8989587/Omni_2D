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
// The camera's own ceiling. A checker cell (and so an artwork pixel) is
// always exactly one scene pixel, at any zoom -- this renderer has no
// notion of anything smaller to subdivide into -- so capping zoom here is
// the only cap the "how big can one real pixel get" question needs. 48
// CSS px per scene pixel is comfortably past the size where a single
// pixel is still meaningfully "one square", so there is no reason to let
// the camera go further.
const MAX_ZOOM = 48;
const FIT_MARGIN = 0.94; // a little air around the grid when fitted

let zoom = 1;
let panX = 0;
let panY = 0;
// Camera-only viewport angle, in radians. It turns how the scene is LOOKED
// at, never what the scene is: no part's rotation, no bone's angle and no
// stored coordinate changes with it, exactly like zoom and pan. The
// renderer applies it as one transform on the context, so the grid, the
// artwork, the skeleton and every overlay turn together as one picture.
let rotation = 0;
// A twist has to be meant. Fingers rolling a few degrees while pinching is
// ordinary hand noise, so nothing turns until the gesture has clearly
// asked for it -- after which the whole accumulated twist applies, so the
// view does not lurch by the dead zone's worth at the moment it engages.
const ROTATE_DEAD_ZONE = 0.14; // ~8 degrees
// Two fingers close together give a wildly unstable angle between them.
const ROTATE_MIN_SPAN_PX = 40;
let pinchTwist = 0;
let twisting = false;
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

function rotatePoint(x, y, angle) {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return { x: x * cos - y * sin, y: x * sin + y * cos };
}

// Shortest way round, so a twist across the +/-pi seam is a few degrees
// rather than most of a turn the other way.
function shortestAngle(radians) {
  let angle = radians;
  while (angle > Math.PI) angle -= Math.PI * 2;
  while (angle < -Math.PI) angle += Math.PI * 2;
  return angle;
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
  get rotation() {
    return rotation;
  },

  subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },

  // THE TWO FRAMES, once the camera can turn.
  //
  // toCanvas is the plain scene*zoom + pan mapping, which is the frame the
  // renderer draws in: it turns the CONTEXT once per frame, so everything
  // it draws is already carried round together and must not be turned a
  // second time on the way in.
  //
  // toScreen is where a scene point really lands on the glass, rotation
  // included, and toScene is its exact inverse. Those are the two the
  // tools want -- a tap is on the glass, and hit-testing has to agree with
  // what the user can see.
  toCanvas(sceneX, sceneY) {
    return { x: sceneX * zoom + panX, y: sceneY * zoom + panY };
  },

  toScene(screenX, screenY) {
    let x = screenX;
    let y = screenY;
    if (rotation !== 0) {
      const p = rotatePoint(screenX - viewWidth / 2, screenY - viewHeight / 2, -rotation);
      x = p.x + viewWidth / 2;
      y = p.y + viewHeight / 2;
    }
    return { x: (x - panX) / zoom, y: (y - panY) / zoom };
  },

  toScreen(sceneX, sceneY) {
    const x = sceneX * zoom + panX;
    const y = sceneY * zoom + panY;
    if (rotation === 0) return { x, y };
    const p = rotatePoint(x - viewWidth / 2, y - viewHeight / 2, rotation);
    return { x: p.x + viewWidth / 2, y: p.y + viewHeight / 2 };
  },

  setViewport(width, height, devicePixelRatio) {
    const firstLayout = viewWidth === 0 || viewHeight === 0;
    viewWidth = width;
    viewHeight = height;
    dpr = devicePixelRatio || 1;
    if (firstLayout) this.fit();
    else emit();
  },

  // Shows the whole grid, centred -- and straight. Fit is the one control
  // that means "put the view back", so it is also the way out of a
  // rotation: there is no separate reset to go hunting for.
  fit() {
    if (!viewWidth || !viewHeight) return;
    rotation = 0;
    const sceneWidth = sceneStore.width;
    const sceneHeight = sceneStore.height;
    zoom = clamp(Math.min(viewWidth / sceneWidth, viewHeight / sceneHeight) * FIT_MARGIN, MIN_ZOOM, MAX_ZOOM);
    // Snap zoom to a whole number of device pixels per scene pixel BEFORE
    // centring on it. snapToDevicePixels() rounds zoom too, but doing that
    // AFTER computing pan centres the content for one zoom value and then
    // renders it at a different one -- the content stays sized to the
    // rounded zoom while pan was measured for the unrounded one, so the
    // two disagree by however far the rounding moved zoom. At typical
    // fit-to-screen ratios that gap is a large fraction of the zoom step,
    // which is why the symptom was the character parked in the top-left
    // rather than a sub-pixel wobble.
    if (zoom * dpr >= 1) zoom = Math.round(zoom * dpr) / dpr;
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
    if (rotation !== 0) {
      // A drag is given in screen deltas, but pan lives in the unrotated
      // frame, so it has to be turned back before it is added -- otherwise
      // a rotated view slides off at an angle to the finger.
      const p = rotatePoint(dx, dy, -rotation);
      panX += p.x;
      panY += p.y;
    } else {
      panX += dx;
      panY += dy;
    }
    emit();
  },

  // Called when a second finger lands, so a twist is measured per gesture
  // rather than leaking its dead zone across separate pinches.
  beginPinch() {
    pinchTwist = 0;
    twisting = false;
  },

  // ONE FRAME OF A TWO-FINGER GESTURE, as a single statement of intent:
  // whatever scene point was under the fingers stays under the fingers.
  //
  // That one rule covers all three things two fingers can ask for. Spread
  // them and it scales about them; twist them and it turns about them;
  // move them and it follows. Written as three separate steps -- scale
  // here, rotate there, then pan by the midpoint's travel -- each step has
  // to undo the drift the previous one introduced, and the anchor ends up
  // being whatever survives. Solving for pan LAST, from the point that has
  // to be held, means there is no drift to undo.
  pinch(prevA, prevB, currentA, currentB) {
    const prevDistance = Math.hypot(prevB.x - prevA.x, prevB.y - prevA.y);
    const currentDistance = Math.hypot(currentB.x - currentA.x, currentB.y - currentA.y);
    const prevCenterX = (prevA.x + prevB.x) / 2;
    const prevCenterY = (prevA.y + prevB.y) / 2;
    const centerX = (currentA.x + currentB.x) / 2;
    const centerY = (currentA.y + currentB.y) / 2;

    // The scene point under the fingers BEFORE this frame: the thing that
    // has to be under them after it.
    const held = this.toScene(prevCenterX, prevCenterY);

    if (prevDistance > 0 && currentDistance > 0) {
      zoom = clamp(zoom * (currentDistance / prevDistance), MIN_ZOOM, MAX_ZOOM);
    }

    // The twist, once the gesture has clearly asked for one.
    if (prevDistance >= ROTATE_MIN_SPAN_PX && currentDistance >= ROTATE_MIN_SPAN_PX) {
      const delta = shortestAngle(
        Math.atan2(currentB.y - currentA.y, currentB.x - currentA.x) -
        Math.atan2(prevB.y - prevA.y, prevB.x - prevA.x)
      );
      pinchTwist += delta;
      if (!twisting && Math.abs(pinchTwist) >= ROTATE_DEAD_ZONE) {
        twisting = true;
        // Apply everything accumulated so far, so engaging the rotation
        // does not jump by the dead zone.
        rotation = shortestAngle(rotation + pinchTwist);
      } else if (twisting) {
        rotation = shortestAngle(rotation + delta);
      }
    }

    // Now put `held` back under the fingers. toScreen is
    //   screen = R(rotation) * (scene*zoom + pan - c) + c
    // so pan is whatever makes that come out at the current midpoint.
    const back = rotatePoint(centerX - viewWidth / 2, centerY - viewHeight / 2, -rotation);
    panX = back.x + viewWidth / 2 - held.x * zoom;
    panY = back.y + viewHeight / 2 - held.y * zoom;
    emit();
  },

  // Called when a gesture ends. A whole number of device pixels per scene
  // pixel keeps every cell the same crisp size; pan is snapped too so the
  // grid's edges never straddle a device pixel.
  //
  // ANCHORED, and that is not a detail. Rounding zoom without touching pan
  // rescales about scene (0,0), because pan IS where scene (0,0) lands. So
  // every pinch ended with a jump whose size was the scene coordinate under
  // the fingers times the rounding -- nothing near the scene origin, tens of
  // pixels out at the far corner. Fingers 46 scene px from the origin drifted
  // 8px; fingers 466 px out drifted 90px, which reads exactly as "zoom snaps
  // to some fixed anchor instead of my fingers". Holding one screen point
  // still across the rounding removes it: the anchor is where the gesture
  // actually was, and the view centre when nothing says otherwise.
  snapToDevicePixels(anchorX = viewWidth / 2, anchorY = viewHeight / 2) {
    const before = zoom;
    if (zoom * dpr >= 1) zoom = Math.round(zoom * dpr) / dpr;
    if (zoom !== before) {
      const applied = zoom / before;
      panX = anchorX - (anchorX - panX) * applied;
      panY = anchorY - (anchorY - panY) * applied;
    }
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
