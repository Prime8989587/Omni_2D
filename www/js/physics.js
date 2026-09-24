// The physics step, and when it runs.
//
// Spring bones have to keep integrating after the input that disturbed
// them stops -- that lingering settle is the whole point -- so they advance
// every frame rather than once per input event. They do it INSIDE the
// renderer's frame, immediately before it draws (canvas.js, setFrameStep),
// so a frame always shows the simulation as of that frame.
//
// The simulation sleeps as soon as every physics bone has come to rest, and
// any change to the skeleton wakes it again. Without that a phone would
// burn battery redrawing a completely static character.

import { bonesStore } from './bones.js';
import { partsStore } from './parts.js';
import { stepPierce, markPierceStale } from './pierce.js';
import { requestRender, setFrameStep } from './canvas.js';

const FALLBACK_DT = 1 / 60;

// Whether a simulation is live, and the clock it last advanced at.
let active = false;
let lastTimestamp = 0;

// ONE PHYSICS STEP, run by the frame driver in canvas.js immediately BEFORE
// that frame's render -- never in a requestAnimationFrame callback of its
// own. This used to be its own loop, and because its callback ran after the
// renderer's in every frame, every frame drew the springs as they were the
// frame before. See canvas.js, setFrameStep.
//
// Screen Rate needs no separate handling here any more: the driver only
// calls this on frames it is going to draw, and dt is measured from the
// last step actually taken, so a lower rate makes the simulation coarser
// but not slower. The cap on dt inside stepPhysics still stops a long stall
// from exploding the integration.
//
// Returns whether anything is still moving, which is how the driver knows
// to ask for the next frame.
function step(timestamp) {
  if (!active) return false;
  const dt = lastTimestamp ? (timestamp - lastTimestamp) / 1000 : FALLBACK_DT;
  lastTimestamp = timestamp;

  // Both simulations advance every frame, independently. A piercer being
  // dragged into a character does not pause that character's own springs,
  // and its flesh springing back does not pause them either -- they are
  // separate systems sharing only the clock.
  const bonesMoving = bonesStore.stepPhysics(dt);
  const fleshMoving = stepPierce();
  const stillMoving = bonesMoving || fleshMoving;
  if (!stillMoving) {
    active = false;
    lastTimestamp = 0;
  }
  return stillMoving;
}

// Starts the simulation if it isn't already running and there is anything
// to simulate. Safe to call as often as you like.
export function wakePhysics() {
  if (active) return;
  // Either simulation is reason enough to run: a scene with no spring
  // bones at all still has to animate flesh giving way and springing back.
  if (!bonesStore.hasPhysicsBones && !partsStore.hasPierce) return;
  active = true;
  lastTimestamp = 0;
  // The pivot history deliberately survives this: during a drag the loop
  // sleeps and wakes every frame until a spring actually starts moving,
  // and clearing it here would wipe the measurement each time. bones.js
  // discards it on a real pause instead, by elapsed time.
  requestRender();
}

export function initPhysics() {
  setFrameStep(step);
  // Any skeleton change -- a debug slider moving a parent, a parameter
  // being tuned, physics being switched on -- may have disturbed a spring.
  // The loop deliberately does NOT emit store changes itself, so this
  // cannot feed back into an endless wake cycle.
  bonesStore.subscribe(wakePhysics);
  // And any layer change may have moved a piercer, which is what starts
  // and ends contact. Same reasoning: the loop emits nothing itself.
  partsStore.subscribe(wakePhysics);

  // The renderer reads the solver's contact state to decide whether a tip
  // is drawn under the flesh. The step now runs BEFORE the render in every
  // frame, so that state is already this frame's; marking it stale on the
  // same changes that wake the loop is kept as a second guard, for a frame
  // in which the simulation was asleep and the step did nothing.
  bonesStore.subscribe(markPierceStale);
  partsStore.subscribe(markPierceStale);
}
