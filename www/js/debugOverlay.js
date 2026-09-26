// Debug overlay: one switch for every diagnostic view in the app.
//
// The app grew its testing aids one at a time, each where it was first
// needed: the pierce region tint and its contact readout behind a toggle in
// a layer's Pierce popup, the mesh wireframe drawn unconditionally in Bind
// mode and in Mesh Trim, a raw "Debug: rotate" slider under the bone
// controls in Rig and again in Bind. Finding one meant remembering which
// menu it lived in, and none of them could be put away together.
//
// Now there is ONE master switch -- the bug button in the top bar, and in
// the tool windows that have views of their own -- and a panel behind it
// that lists the views, but only the ones that mean something where you
// are: Mesh Trim offers its wireframe, not the pierce readout; Rig offers
// the rotate slider, Free Move does not. Master off hides every view at
// once; each view also has its own switch, so "the readout but not the
// tint" is one tap, and both settings are remembered between sessions.
//
// This module owns only the switches. Whatever draws a view asks
// debugViewOn(name) when it draws, and subscribes to redraw on a change;
// ui.js tells it where the user is. Nothing here knows how a view is drawn.

const STORAGE_KEY = 'omni2d.debugOverlay';
// The pierce overlay's own switch, from before it was folded in here. A
// user who had it on keeps it on.
const LEGACY_PIERCE_KEY = 'omni2d.pierce.overlay';

// Where each view means something. The contexts are the main canvas's app
// states plus the tool windows that draw a view of their own.
export const VIEWS = {
  pierceRegions: {
    label: 'Pierce regions',
    hint: 'Tints every painted pierce region on the canvas: tips pink, pierceable cyan, seams violet, walls white.',
    where: ['home', 'rig', 'bind', 'animating', 'recording'],
    needsPierce: true,
  },
  pierceReadout: {
    label: 'Pierce depth readout',
    hint: 'The live contact reading for each pierced layer: gap, depth, Enter / End, and how open the V is.',
    where: ['home', 'rig', 'bind', 'animating', 'recording'],
    needsPierce: true,
  },
  meshWireframe: {
    label: 'Mesh wireframe',
    hint: 'The triangle edges of the mesh each layer deforms by. In Bind, the selected layer; in Mesh Trim, the layer being edited.',
    where: ['home', 'rig', 'bind', 'animating', 'recording', 'meshtrim'],
  },
  rotateSliders: {
    label: 'Bone rotate slider',
    hint: 'A raw rotation slider for the selected bone, under the bone controls.',
    where: ['rig', 'bind'],
  },
};

const CONTEXT_NAMES = {
  home: 'Layers',
  rig: 'Rig',
  bind: 'Bind',
  animating: 'Free Move',
  recording: 'Free Move',
  meshtrim: 'Mesh Trim',
};

let state = load();
const listeners = new Set();
let contextOf = () => 'home';
let hasPierceLayers = () => true;

function defaults() {
  return {
    master: false,
    views: Object.fromEntries(Object.keys(VIEWS).map((k) => [k, true])),
  };
}

function load() {
  const base = defaults();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const saved = JSON.parse(raw);
      base.master = Boolean(saved.master);
      for (const key of Object.keys(VIEWS)) {
        if (saved.views && key in saved.views) base.views[key] = Boolean(saved.views[key]);
      }
    } else if (window.localStorage.getItem(LEGACY_PIERCE_KEY) === '1') {
      base.master = true;
    }
  } catch { /* storage blocked: defaults for this session */ }
  return base;
}

function persist() {
  try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* no-op */ }
}

function emit() {
  persist();
  listeners.forEach((fn) => fn(state));
  render();
}

export function debugMasterOn() {
  return state.master;
}

// The one question a drawing routine asks. A view is shown when the master
// is on AND its own switch is on; it does not check the context, because a
// view that is drawn somewhere is by definition relevant there -- the
// context decides only what the panel OFFERS.
export function debugViewOn(name) {
  return state.master && Boolean(state.views[name]);
}

export function setDebugMaster(on) {
  if (state.master === Boolean(on)) return;
  state = { ...state, master: Boolean(on) };
  emit();
}

export function setDebugView(name, on) {
  if (!(name in VIEWS)) return;
  state = { ...state, views: { ...state.views, [name]: Boolean(on) } };
  emit();
}

export function debugOverlayState() {
  return { master: state.master, views: { ...state.views } };
}

export function subscribeDebugOverlay(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function relevantViews(context = contextOf()) {
  return Object.keys(VIEWS).filter((key) => VIEWS[key].where.includes(context));
}

// ---------------------------------------------------------------------------
// The panel

const els = {};

function switchButton(label, pressed, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'toggle-chip toggle-chip--wide toggle-chip--switch';
  button.setAttribute('aria-pressed', String(pressed));
  button.textContent = label;
  button.addEventListener('click', onClick);
  return button;
}

function render() {
  // Every bug button reads the master, wherever it is.
  for (const button of document.querySelectorAll('[data-debug-toggle]')) {
    button.setAttribute('aria-pressed', String(state.master));
    button.classList.toggle('is-on', state.master);
  }
  if (!els.modal || els.modal.hidden) return;

  const context = contextOf();
  els.where.textContent = CONTEXT_NAMES[context] || context;
  els.master.setAttribute('aria-pressed', String(state.master));
  els.master.textContent = state.master ? 'Debug overlay: On' : 'Debug overlay: Off';

  els.list.replaceChildren();
  const views = relevantViews(context);
  const pierceAvailable = hasPierceLayers();
  for (const key of views) {
    const view = VIEWS[key];
    const li = document.createElement('li');
    li.className = 'debug-view';
    li.dataset.debugView = key;
    const button = switchButton(view.label, state.views[key], () => setDebugView(key, !state.views[key]));
    // Off under a master that is off, so the list never claims a view is
    // showing when nothing is.
    button.classList.toggle('is-muted', !state.master);
    const hint = document.createElement('small');
    hint.className = 'debug-view__hint';
    hint.textContent = view.needsPierce && !pierceAvailable
      ? `${view.hint} (No layer has a Pierce role yet, so there is nothing to show.)`
      : view.hint;
    li.append(button, hint);
    els.list.appendChild(li);
  }
  els.empty.hidden = views.length > 0;
}

export function openDebugOverlay() {
  if (!els.modal) return;
  els.modal.hidden = false;
  render();
}

export function closeDebugOverlay() {
  if (els.modal) els.modal.hidden = true;
}

export function isDebugOverlayOpen() {
  return Boolean(els.modal && !els.modal.hidden);
}

// ui.js supplies where the user is and whether any pierce layer exists;
// this module has no business importing the stores to find out.
export function initDebugOverlay({ context, pierceLayers } = {}) {
  if (context) contextOf = context;
  if (pierceLayers) hasPierceLayers = pierceLayers;
  els.modal = document.getElementById('debugModal');
  els.master = document.getElementById('debugMasterBtn');
  els.list = document.getElementById('debugViewList');
  els.empty = document.getElementById('debugViewEmpty');
  els.where = document.getElementById('debugWhere');
  els.close = document.getElementById('debugCloseBtn');
  if (els.master) els.master.addEventListener('click', () => setDebugMaster(!state.master));
  if (els.close) els.close.addEventListener('click', closeDebugOverlay);
  if (els.modal) {
    els.modal.addEventListener('click', (event) => { if (event.target === els.modal) closeDebugOverlay(); });
  }
  document.addEventListener('click', (event) => {
    const opener = event.target.closest && event.target.closest('[data-debug-toggle]');
    if (opener) openDebugOverlay();
  });
  render();
}
