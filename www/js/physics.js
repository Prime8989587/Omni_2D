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
import { partsStore } from './parts.js';
import { stepPierce, markPierceStale } from './pierce.js';
import { requestRender } from './canvas.js';

const FALLBACK_DT = 1 / 60;

let frameId = null;
let lastTimestamp = 0;

function tick(timestamp) {
  const dt = lastTimestamp ? (timestamp - lastTimestamp) / 1000 : FALLBACK_DT;
  lastTimestamp = timestamp;

  // Both simulations advance every frame, independently. A piercer being
  // dragged into a character does not pause that character's own springs,
  // and its flesh springing back does not pause them either -- they are
  // separate systems sharing only the clock.
  const bonesMoving = bonesStore.stepPhysics(dt);
  const fleshMoving = stepPierce(dt);
  const stillMoving = bonesMoving || fleshMoving;
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
  if (frameId !== null) return;
  // Either simulation is reason enough to run: a scene with no spring
  // bones at all still has to animate flesh giving way and springing back.
  if (!bonesStore.hasPhysicsBones && !partsStore.hasPierce) return;
  lastTimestamp = 0;
  // The pivot history deliberately survives this: during a drag the loop
  // sleeps and wakes every frame until a spring actually starts moving,
  // and clearing it here would wipe the measurement each time. bones.js
  // discards it on a real pause instead, by elapsed time.
  frameId = requestAnimationFrame(tick);
}

export function initPhysics() {
  // Any skeleton change -- a debug slider moving a parent, a parameter
  // being tuned, physics being switched on -- may have disturbed a spring.
  // The loop deliberately does NOT emit store changes itself, so this
  // cannot feed back into an endless wake cycle.
  bonesStore.subscribe(wakePhysics);
  // And any layer change may have moved a piercer, which is what starts
  // and ends contact. Same reasoning: the loop emits nothing itself.
  partsStore.subscribe(wakePhysics);

  // The renderer reads the solver's contact state to decide whether a tip
  // is drawn under the flesh. Marking it stale on the same changes that
  // wake the loop means the very first frame after a drag re-measures
  // rather than drawing one frame of the previous answer -- the loop's own
  // step lands after the render in that frame, not before it.
  bonesStore.subscribe(markPierceStale);
  partsStore.subscribe(markPierceStale);
}
