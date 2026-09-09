// The physics frame loop.
//
// Spring bones have to keep integrating after the input that disturbed
// them stops -- that lingering settle is the whole point -- so this runs a
// requestAnimationFrame loop rather than stepping once per input event.
//
// The loop sleeps as soon as every physics bone has come to rest, and any
// change to the skeleton wakes it again. Without that a phone would burn
// battery redrawing a completely static character.

import { bonesStore } from './bones.js';
import { requestRender } from './canvas.js';

const FALLBACK_DT = 1 / 60;

let frameId = null;
let lastTimestamp = 0;

function tick(timestamp) {
  const dt = lastTimestamp ? (timestamp - lastTimestamp) / 1000 : FALLBACK_DT;
  lastTimestamp = timestamp;

  const stillMoving = bonesStore.stepPhysics(dt);
  requestRender();

  if (stillMoving) {
    frameId = requestAnimationFrame(tick);
  } else {
    frameId = null;
    lastTimestamp = 0;
  }
}

// Starts the loop if it isn't already running and there is anything to
// simulate. Safe to call as often as you like.
export function wakePhysics() {
  if (frameId !== null || !bonesStore.hasPhysicsBones) return;
  lastTimestamp = 0;
  frameId = requestAnimationFrame(tick);
}

export function initPhysics() {
  // Any skeleton change -- a debug slider moving a parent, a parameter
  // being tuned, physics being switched on -- may have disturbed a spring.
  // The loop deliberately does NOT emit store changes itself, so this
  // cannot feed back into an endless wake cycle.
  bonesStore.subscribe(wakePhysics);
}
