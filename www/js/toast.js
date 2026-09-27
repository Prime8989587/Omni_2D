// The one notification the app shows: a short message near the top of the
// screen that goes away by itself -- or sooner, when you say so.
//
// Every tool used to carry its own four-line copy of "set the text, show it,
// hide it in four seconds", and none of them could be dismissed: a message
// sat over the work for its full time whatever you did. Now there is one,
// shared by every screen, and it can be put away two ways:
//
//   * the X at its right-hand end, a real button;
//   * dragging it sideways -- past about a third of its width, or thrown
//     that way as the finger lets go, it slides off that side; let go short
//     of that and it springs back.
//
// It does not time out while a finger is on it, so reading or dragging it
// is never cut short.
//
// A TOAST THAT CAN BE TOUCHED
//
// For a while the toast ignored touch entirely (pointer-events: none),
// because an invisible-to-input banner that nonetheless covered the top of
// the canvas used to swallow paint strokes started under it. Dismissing it
// means it has to take touches again. What stops that being the old bug is
// that it is no longer an invisible obstacle: it looks and behaves like the
// card it is -- an X, a swipe, gone the moment you ask -- so a touch that
// lands on it is a gesture ON the notification, and one flick clears it off
// whatever was underneath.

import { createIcon } from './pixelIcons.js';

const DEFAULT_DURATION = 4000;
const DISMISS_FRACTION = 0.33; // of the toast's width
// px per ms at the moment of letting go -- 300 px/s, in the range Android's
// own swipe-to-dismiss treats as a throw rather than a drag.
const FLICK_SPEED = 0.3;
const FLICK_WINDOW = 100; // ms: a flick is how fast the finger is going as it lets go

let el = null;
let textEl = null;
let timer = null;
let remaining = 0;
let shownAt = 0;
let drag = null;

function build() {
  if (el) return el;
  el = document.getElementById('toast');
  if (!el) return null;
  el.replaceChildren();
  textEl = document.createElement('span');
  textEl.className = 'toast__text';
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'toast__close';
  close.setAttribute('aria-label', 'Dismiss');
  close.appendChild(createIcon('close'));
  close.addEventListener('click', (event) => {
    event.stopPropagation();
    dismissToast('x');
  });
  el.append(textEl, close);
  el.addEventListener('pointerdown', onDown);
  el.addEventListener('pointermove', onMove);
  el.addEventListener('pointerup', onUp);
  el.addEventListener('pointercancel', onUp);
  return el;
}

function schedule(ms) {
  clearTimeout(timer);
  remaining = ms;
  shownAt = performance.now();
  timer = setTimeout(() => dismissToast('timeout'), ms);
}

function place(dx) {
  // Whole pixels, like everything else on screen.
  el.style.transform = dx ? `translateX(${Math.round(dx)}px)` : '';
  // Fades in steps as it goes, so it reads as leaving.
  const width = el.getBoundingClientRect().width || 1;
  const gone = Math.min(1, Math.abs(dx) / width);
  el.style.opacity = gone > 0 ? String(1 - Math.floor(gone * 4) / 4) : '';
}

export function showToast(message, { duration = DEFAULT_DURATION } = {}) {
  if (!build()) return;
  textEl.textContent = message;
  drag = null;
  place(0);
  el.hidden = false;
  el.dataset.dismissed = '';
  schedule(duration);
}

// How it went, for tests and for anything that wants to know: 'x', 'swipe',
// 'timeout' or '' while it is still up.
export function dismissToast(how = 'x') {
  if (!el || el.hidden) return;
  clearTimeout(timer);
  drag = null;
  el.hidden = true;
  place(0);
  el.dataset.dismissed = how;
}

export function isToastVisible() {
  return Boolean(el && !el.hidden);
}

function onDown(event) {
  if (event.target.closest('.toast__close')) return;
  const now = performance.now();
  drag = { id: event.pointerId, x: event.clientX, t: now, dx: 0, samples: [{ x: event.clientX, t: now }] };
  try { el.setPointerCapture(event.pointerId); } catch { /* synthetic events in tests */ }
  // Held: the clock stops until it is let go.
  clearTimeout(timer);
  remaining = Math.max(800, remaining - (performance.now() - shownAt));
}

function onMove(event) {
  if (!drag || event.pointerId !== drag.id) return;
  drag.dx = event.clientX - drag.x;
  const now = performance.now();
  drag.samples.push({ x: event.clientX, t: now });
  while (drag.samples.length > 2 && now - drag.samples[0].t > FLICK_WINDOW * 2) drag.samples.shift();
  place(drag.dx);
}

// How fast (and which way) the finger was travelling as it let go, from the
// last moments of the drag only. Averaged over the whole gesture instead, a drag
// that dawdled and then flicked read as slow and sprang back, and one that
// flicked and then stopped dead read as a flick.
function releaseVelocity(samples, now) {
  const last = samples[samples.length - 1];
  if (now - last.t > FLICK_WINDOW) return 0; // held still before letting go
  const first = samples.find((sample) => last.t - sample.t <= FLICK_WINDOW) || last;
  return (last.x - first.x) / Math.max(1, last.t - first.t);
}

function onUp(event) {
  if (!drag || event.pointerId !== drag.id) return;
  const { dx, samples } = drag;
  drag = null;
  const width = el.getBoundingClientRect().width || 1;
  // Signed, and it has to agree with where the toast already is: thrown
  // back toward where it started is a change of mind, not a dismissal.
  const velocity = releaseVelocity(samples, performance.now());
  const thrown = Math.abs(dx) > 24 && Math.sign(velocity) === Math.sign(dx) && Math.abs(velocity) > FLICK_SPEED;
  if (Math.abs(dx) > width * DISMISS_FRACTION || thrown) {
    dismissToast('swipe');
    return;
  }
  place(0); // short of the line: back where it was
  schedule(remaining);
}
