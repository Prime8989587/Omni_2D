// The Home screen: the app's actual entry point.
//
// A drifting field of sakura petals behind the wordmark and the two places
// the app can take you. The petals are decorative and that is the whole
// point of them -- but they are also the first thing anyone sees, so they
// are built to the same rules as the rest of the app rather than as an
// exception to them.
//
// DRAWN ON A CANVAS, NOT AS ELEMENTS
//
// Dozens of petals move every frame and each one has to be individually
// hit-testable for dragging. As DOM nodes that is dozens of elements being
// re-positioned every frame and a layout pass each time; on a canvas it is
// one element and a loop. The canvas also makes "no smoothing" enforceable:
// each petal is drawn as whole-pixel rectangles on an integer grid, so they
// are genuinely hard-edged pixel art rather than smooth shapes that happen
// to be small.
//
// EVERY PETAL DRIFTS DIFFERENTLY
//
// Same speed and heading for all of them reads instantly as a screensaver.
// Each petal gets its own fall speed, its own sideways sway amplitude and
// period, its own spin rate and its own phase, so the field never lines up
// with itself.

import { playEnter } from './transitions.js';
import { shouldRenderFrame } from './settings.js';

const SAKURA = '#FFB7C5'; // the light pink the visual identity specifies
const PETAL_COUNT = 34;
const MIN_SCALE = 2; // device-independent pixels per petal "pixel"
const MAX_SCALE = 4;

// The petal, as a pixel-art sprite: one row per line, each entry a run of
// [startColumn, length]. Drawn as filled rectangles on a whole-pixel grid,
// which is what keeps the edges hard at any scale.
// Narrow at the stem end, widening out, with the notch at the wide end
// that makes a cherry-blossom petal read as one rather than as a generic
// blob. Six by six is the smallest grid that still carries the notch.
const PETAL_ROWS = [
  [[2, 2]],
  [[1, 4]],
  [[0, 6]],
  [[0, 6]],
  [[0, 6]],
  [[0, 2], [4, 2]], // the notch
];
const PETAL_W = 6;
const PETAL_H = 6;

const els = {};
let petals = [];
let frame = null;
let lastTime = 0;
let started = false;
// pointerId -> the petal that pointer grabbed
const dragging = new Map();

function random(min, max) {
  return min + Math.random() * (max - min);
}

function makePetal(width, height, fromTop = false) {
  const scale = Math.round(random(MIN_SCALE, MAX_SCALE));
  return {
    x: random(0, Math.max(1, width)),
    // On the FIRST fill, petals are scattered across the whole screen so
    // the field is already full the moment Home appears. Spawning them
    // above the top edge instead -- which is right for recycling a petal
    // that has fallen off the bottom -- would leave the landing screen
    // visibly bare for the first several seconds, which is the one moment
    // it most needs to look alive.
    y: fromTop ? random(-40, Math.max(1, height)) : random(-60, -10),
    scale,
    // Bigger petals fall slightly faster: a cheap depth cue that costs
    // nothing and stops the field looking flat.
    fall: random(8, 20) * (scale / MAX_SCALE) + 6,
    drift: random(-10, 10),
    swayAmplitude: random(6, 22),
    swayPeriod: random(2.5, 6),
    phase: random(0, Math.PI * 2),
    spin: random(-0.5, 0.5),
    angle: random(0, Math.PI * 2),
    alpha: random(0.55, 1),
    // Set while a finger holds it, and for a moment after release.
    held: false,
    vx: 0,
    vy: 0,
  };
}

function petalSize(petal) {
  return { w: PETAL_W * petal.scale, h: PETAL_H * petal.scale };
}

function resize() {
  const canvas = els.canvas;
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(rect.width * dpr));
  canvas.height = Math.max(1, Math.round(rect.height * dpr));
  els.cssWidth = rect.width;
  els.cssHeight = rect.height;
  els.dpr = dpr;

  if (petals.length === 0) {
    petals = Array.from({ length: PETAL_COUNT }, () => makePetal(rect.width, rect.height, true));
  }
}

function drawPetal(ctx, petal) {
  const { w, h } = petalSize(petal);
  ctx.save();
  ctx.globalAlpha = petal.alpha;
  ctx.translate(petal.x + w / 2, petal.y + h / 2);
  ctx.rotate(petal.angle);
  ctx.fillStyle = SAKURA;
  // Whole-pixel rectangles, drawn from the sprite table. No paths, no
  // curves, no smoothing -- the same "a texel is filled or it is not" rule
  // the drawing tools follow.
  for (let row = 0; row < PETAL_ROWS.length; row++) {
    for (const [start, length] of PETAL_ROWS[row]) {
      ctx.fillRect(
        Math.round(-w / 2 + start * petal.scale),
        Math.round(-h / 2 + row * petal.scale),
        length * petal.scale,
        petal.scale
      );
    }
  }
  ctx.restore();
}

// The token the Screen Rate governor keys this loop's pacing off. Any
// object the module owns will do; `els` is one that already exists and
// outlives every individual animation frame.
const rateToken = els;

function step(time) {
  frame = requestAnimationFrame(step);
  // Screen Rate. The loop keeps running at the display's rate and simply
  // declines to do work on frames outside the budget -- note that lastTime
  // is NOT advanced on a skipped frame, so the physics below still
  // integrates the full elapsed time and petals fall at the same real
  // speed at 30Hz as at 120Hz, just in fewer, larger steps.
  if (!shouldRenderFrame(rateToken, time)) return;
  if (!lastTime) lastTime = time;
  // Clamped: coming back to a backgrounded tab hands over a delta of many
  // seconds, which would teleport the whole field off the bottom at once.
  const dt = Math.min(0.05, (time - lastTime) / 1000);
  lastTime = time;

  const width = els.cssWidth || 1;
  const height = els.cssHeight || 1;

  for (const petal of petals) {
    if (!petal.held) {
      petal.phase += dt / petal.swayPeriod * Math.PI * 2;
      // A released petal keeps whatever momentum the finger gave it, bled
      // off quickly, so letting go mid-flick feels like letting go of a
      // real thing rather than the petal stopping dead.
      petal.x += (petal.drift + Math.cos(petal.phase) * petal.swayAmplitude + petal.vx) * dt;
      petal.y += (petal.fall + petal.vy) * dt;
      petal.vx *= 0.94;
      petal.vy *= 0.94;
      petal.angle += petal.spin * dt;

      const { w, h } = petalSize(petal);
      // Off the bottom: recycled to the top, keeping its own character.
      if (petal.y > height + h) {
        petal.y = -h - random(0, 40);
        petal.x = random(0, width);
        petal.vx = 0;
        petal.vy = 0;
      }
      // Wrap sideways rather than letting the field thin out at the edges.
      if (petal.x < -w) petal.x = width;
      if (petal.x > width + w) petal.x = -w;
    }
  }

  render();
}

function render() {
  const ctx = els.canvas.getContext('2d');
  ctx.setTransform(els.dpr, 0, 0, els.dpr, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, els.cssWidth, els.cssHeight);
  for (const petal of petals) drawPetal(ctx, petal);
}

// ---------------------------------------------------------------------------
// Dragging
//
// Topmost-first so a petal drawn over another is the one that gets picked,
// matching what the eye would expect to grab. The hit box is the petal's
// own bounding box, padded a little: these are small targets and a finger
// is not precise, so being slightly generous is the difference between
// "playful" and "fiddly".

const GRAB_PADDING = 10;

function petalAt(x, y) {
  for (let i = petals.length - 1; i >= 0; i--) {
    const petal = petals[i];
    const { w, h } = petalSize(petal);
    if (x >= petal.x - GRAB_PADDING && x <= petal.x + w + GRAB_PADDING
      && y >= petal.y - GRAB_PADDING && y <= petal.y + h + GRAB_PADDING) {
      return petal;
    }
  }
  return null;
}

function localPoint(event) {
  const rect = els.canvas.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

function onPointerDown(event) {
  const point = localPoint(event);
  const petal = petalAt(point.x, point.y);
  if (!petal) return; // a miss falls through; nothing to grab here
  event.preventDefault();
  try { els.canvas.setPointerCapture(event.pointerId); } catch { /* no-op in tests */ }
  const { w, h } = petalSize(petal);
  petal.held = true;
  petal.vx = 0;
  petal.vy = 0;
  dragging.set(event.pointerId, {
    petal,
    // Held from where it was actually grabbed, so it does not jump to
    // centre itself under the finger.
    offsetX: point.x - petal.x - w / 2,
    offsetY: point.y - petal.y - h / 2,
    lastX: point.x,
    lastY: point.y,
    lastTime: performance.now(),
  });
  // Drawn last from now on, so the held petal is on top of the field.
  petals.splice(petals.indexOf(petal), 1);
  petals.push(petal);
}

function onPointerMove(event) {
  const drag = dragging.get(event.pointerId);
  if (!drag) return;
  event.preventDefault();
  const point = localPoint(event);
  const { w, h } = petalSize(drag.petal);
  drag.petal.x = point.x - drag.offsetX - w / 2;
  drag.petal.y = point.y - drag.offsetY - h / 2;

  const now = performance.now();
  const dt = Math.max(0.001, (now - drag.lastTime) / 1000);
  // Remembered so the release can carry the flick through.
  drag.petal.vx = (point.x - drag.lastX) / dt;
  drag.petal.vy = (point.y - drag.lastY) / dt;
  drag.lastX = point.x;
  drag.lastY = point.y;
  drag.lastTime = now;
  render();
}

function onPointerUp(event) {
  const drag = dragging.get(event.pointerId);
  if (!drag) return;
  dragging.delete(event.pointerId);
  const petal = drag.petal;
  petal.held = false;
  // It carries on drifting FROM HERE rather than snapping back to a path.
  // The sway is re-phased so it continues from its current position
  // instead of jerking sideways to catch up with where its old cycle says
  // it should have been.
  petal.phase = Math.random() * Math.PI * 2;
  // Flick velocity is clamped: a hard swipe should give a petal a shove,
  // not fire it off the screen instantly.
  petal.vx = Math.max(-260, Math.min(260, petal.vx));
  petal.vy = Math.max(-260, Math.min(260, petal.vy));
}

// ---------------------------------------------------------------------------

export function startPetals() {
  if (started) return;
  started = true;
  resize();
  lastTime = 0;
  frame = requestAnimationFrame(step);
}

export function stopPetals() {
  started = false;
  if (frame) cancelAnimationFrame(frame);
  frame = null;
}

export function initHome({ onRigging, onPCreate }) {
  els.home = document.getElementById('homeScreen');
  els.canvas = document.getElementById('homePetals');
  els.rigging = document.getElementById('homeRiggingBtn');
  els.pcreate = document.getElementById('homePcreateBtn');
  if (!els.home || !els.canvas) return;

  els.canvas.addEventListener('pointerdown', onPointerDown);
  els.canvas.addEventListener('pointermove', onPointerMove);
  els.canvas.addEventListener('pointerup', onPointerUp);
  els.canvas.addEventListener('pointercancel', onPointerUp);

  window.addEventListener('resize', () => {
    resize();
    render();
  });

  els.rigging.addEventListener('click', () => onRigging());
  els.pcreate.addEventListener('click', () => onPCreate());

  playEnter(els.home);
  startPetals();
}

export function isHomeVisible() {
  return Boolean(els.home) && !els.home.hidden;
}

// Test window into the petal field: proving a petal actually moved, that a
// drag put it somewhere specific, and that it kept drifting afterwards,
// without a test having to read pixels off a canvas.
export function petalsDebug() {
  return {
    count: petals.length,
    running: Boolean(frame),
    dragging: dragging.size,
    positions: petals.map((p) => ({ x: Math.round(p.x), y: Math.round(p.y), held: p.held })),
  };
}

export function grabPetalForTest(index) {
  const petal = petals[index];
  if (!petal) return null;
  const { w, h } = petalSize(petal);
  return { x: Math.round(petal.x + w / 2), y: Math.round(petal.y + h / 2) };
}
