// App settings: ONE store, ONE screen, three sections.
//
// WHY ONE STORE RATHER THAN THREE
//
// Settings arrive in three groups -- Main, PCreate, Rig -- and the obvious
// build is three little preference objects owned by the three subsystems
// that use them. That is the wrong shape. A preference is only ever read by
// the feature it governs, but it is WRITTEN from one shared screen, has to
// persist through the same storage, and has to survive "clear all app data"
// together. Three stores means three load paths, three save paths and three
// chances for one of them to be the one that forgot to persist. So there is
// a single record with every preference in it, loaded once at boot, read
// synchronously from memory everywhere, and written through to IndexedDB on
// every change.
//
// SYNCHRONOUS READS, ASYNCHRONOUS WRITES
//
// getSetting() is called from inside pointer handlers and render loops --
// places that cannot await anything. So the durable copy is pulled into a
// plain object once during boot and every read after that hits memory. A
// write updates memory first (so the effect is immediate), notifies
// subscribers, and only then persists in the background: a device with
// storage disabled still behaves correctly for the rest of the session, it
// just forgets on next launch.
//
// THE SCHEMA IS THE UI
//
// Every setting declares its section, label, kind and options right here,
// and the Settings screen is rendered FROM that declaration. Adding a
// preference is one entry in one table rather than an entry plus a block of
// hand-written markup plus a hand-written event listener that has to be
// kept in step with it. It also makes "does every setting actually
// persist?" answerable by iterating the schema instead of by remembering.

import { loadSettings, saveSettings } from './storage.js';

export const APP_VERSION = '1.0.0';

// The eight compass directions, matching PCreate's own shadow table so a
// default set here means exactly what it means in the drawing window.
export const SHADOW_DIRECTION_KEYS = ['nw', 'n', 'ne', 'w', 'e', 'sw', 's', 'se'];

export const SECTIONS = [
  { key: 'main', label: 'Main' },
  { key: 'pcreate', label: 'PCreate' },
  { key: 'rig', label: 'Rig' },
];

const range = (min, max) => Array.from({ length: max - min + 1 }, (_, i) => ({
  value: min + i,
  label: String(min + i),
}));

export const SCHEMA = [
  // ---- Main ---------------------------------------------------------------
  {
    key: 'screenRate',
    section: 'main',
    kind: 'choice',
    label: 'Screen Rate',
    hint: 'How often the app redraws. Lower rates use less battery.',
    default: 60,
    options: [
      { value: 120, label: 'Super Smooth', note: '120Hz' },
      { value: 60, label: 'Smooth', note: '60Hz' },
      { value: 30, label: 'Battery Economic', note: '30Hz' },
    ],
  },
  {
    key: 'autoSaveInterval',
    section: 'main',
    kind: 'choice',
    label: 'Auto-save interval',
    hint: 'How often unsaved work is written to the recovery slot.',
    default: 120,
    options: [
      { value: 30, label: '30s' },
      { value: 60, label: '1 min' },
      { value: 120, label: '2 min' },
      { value: 300, label: '5 min' },
    ],
  },
  {
    key: 'backConfirm',
    section: 'main',
    kind: 'toggle',
    label: 'Back-to-Menu confirmation',
    // Defaults ON, and the reason is asymmetry of harm: a confirmation you
    // did not need costs one tap, and a confirmation you did need is the
    // only thing standing between a mis-tap and an afternoon's work.
    hint: 'Ask before leaving a screen that has unsaved changes.',
    default: true,
  },

  // ---- PCreate ------------------------------------------------------------
  {
    key: 'doubleTapFill',
    section: 'pcreate',
    kind: 'toggle',
    // Defaults OFF, unlike its long-press sibling below, and the difference
    // is not caution for its own sake. Two quick taps in one spot is a
    // routine drawing action -- dotting a pixel, correcting a stroke -- so
    // binding a flood fill to it misfires often rather than rarely, and the
    // misfire repaints a whole region. Long-pressing, by contrast, is not
    // something a hand does by accident mid-stroke, and Pick Color changes
    // no pixels at all, so that one is safe to have on from the start.
    label: 'Double-tap to Fill',
    hint: 'Double-tap a pixel with any drawing tool to flood-fill there.',
    default: false,
  },
  {
    key: 'longPressPick',
    section: 'pcreate',
    kind: 'toggle',
    label: 'Long-press to Pick Color',
    hint: 'Hold a pixel with any drawing tool to pick its colour.',
    default: true,
  },
  {
    key: 'defaultBrush',
    section: 'pcreate',
    kind: 'choice',
    label: 'Default brush size',
    hint: 'The brush a new PCreate canvas starts on.',
    default: 1,
    options: range(1, 10).map((o) => ({ ...o, label: `${o.value}×${o.value}` })),
  },
  {
    key: 'defaultEditInPlace',
    section: 'pcreate',
    kind: 'choice',
    label: 'Default edit behaviour',
    hint: 'Whether new sessions edit the original or always work on a copy.',
    default: false,
    options: [
      { value: false, label: 'Always edit a copy' },
      { value: true, label: 'Edit the original' },
    ],
  },
  {
    key: 'autoPaletteRefresh',
    section: 'pcreate',
    kind: 'choice',
    label: 'Auto Palette refresh',
    hint: 'When the Auto Palette rescans the artwork for its colours.',
    default: 'open',
    options: [
      { value: 'open', label: 'On open' },
      { value: 'manual', label: 'Manual only' },
    ],
  },
  {
    key: 'shadowDirection',
    section: 'pcreate',
    kind: 'choice',
    label: 'Shadow direction',
    hint: 'Which way the generated shadow falls, before you adjust it.',
    default: 'se',
    options: [
      { value: 'nw', label: '↖' }, { value: 'n', label: '↑' }, { value: 'ne', label: '↗' },
      { value: 'w', label: '←' }, { value: 'e', label: '→' },
      { value: 'sw', label: '↙' }, { value: 's', label: '↓' }, { value: 'se', label: '↘' },
    ],
  },
  {
    key: 'shadowOffset',
    section: 'pcreate',
    kind: 'slider',
    label: 'Shadow offset',
    hint: 'How far the generated shadow starts out from the artwork.',
    default: 2,
    min: 1,
    max: 8,
    step: 1,
    format: (v) => `${v} px`,
  },

  // ---- Rig ----------------------------------------------------------------
  {
    key: 'pxPinBrush',
    section: 'rig',
    kind: 'choice',
    label: 'Default Px Pin brush size',
    hint: 'The brush a new Px Pin session starts on.',
    default: 1,
    options: range(1, 10).map((o) => ({ ...o, label: `${o.value}×${o.value}` })),
  },
  {
    key: 'weightBrushRadius',
    section: 'rig',
    kind: 'slider',
    label: 'Default weight brush size',
    hint: 'Radius of the weight-painting brush, in screen pixels.',
    default: 45,
    min: 10,
    max: 120,
    step: 1,
    format: (v) => `${v} px`,
  },
  {
    key: 'weightBrushStrength',
    section: 'rig',
    kind: 'slider',
    label: 'Default weight brush strength',
    hint: 'How much one pass of the weight brush moves a vertex.',
    default: 0.35,
    min: 0.05,
    max: 1,
    step: 0.05,
    format: (v) => v.toFixed(2),
  },
  {
    key: 'gridSnap',
    section: 'rig',
    kind: 'toggle',
    label: 'Grid snap',
    hint: 'Snap bones and poses to the pixel grid. Off allows free placement.',
    default: true,
  },
  {
    key: 'contourMode',
    section: 'rig',
    kind: 'choice',
    label: 'Contour mode',
    hint: 'Draw an outline around the artwork while rigging.',
    default: 'off',
    options: [
      { value: 'off', label: 'Off' },
      { value: 'layer', label: 'Per-layer outline' },
      { value: 'silhouette', label: 'Full silhouette' },
    ],
  },
  {
    key: 'contourColor',
    section: 'rig',
    kind: 'color',
    label: 'Contour colour',
    hint: 'The colour that outline is drawn in.',
    default: '#FF2E93', // the app's pink accent
  },
  {
    key: 'contourThickness',
    section: 'rig',
    kind: 'slider',
    label: 'Contour thickness',
    hint: 'How heavy that outline is, in scene pixels.',
    default: 1,
    min: 1,
    max: 6,
    step: 1,
    format: (v) => `${v} px`,
  },
  {
    key: 'checkerStrength',
    section: 'rig',
    kind: 'choice',
    label: 'Checkerboard strength',
    hint: 'How visible the transparency checkerboard is behind the artwork.',
    default: 'normal',
    options: [
      { value: 'subtle', label: 'Subtle' },
      { value: 'normal', label: 'Normal' },
      { value: 'bold', label: 'Bold' },
    ],
  },
  {
    key: 'boneListDefault',
    section: 'rig',
    kind: 'choice',
    label: 'Bone hierarchy list',
    hint: 'Whether the bone list starts open when Rig mode is entered.',
    default: 'expanded',
    options: [
      { value: 'expanded', label: 'Expanded' },
      { value: 'collapsed', label: 'Collapsed' },
    ],
  },
];

const BY_KEY = new Map(SCHEMA.map((entry) => [entry.key, entry]));

export function defaultSettings() {
  const out = {};
  for (const entry of SCHEMA) out[entry.key] = entry.default;
  return out;
}

let values = defaultSettings();
let loaded = false;
const listeners = new Set();

// A stored value is only accepted if it is still one this build recognises.
// A preference written by an older version whose options have since changed
// -- or a record tampered with by hand -- falls back to the default rather
// than putting an impossible value into the feature that reads it.
function coerce(entry, raw) {
  if (raw === undefined || raw === null) return entry.default;
  if (entry.kind === 'toggle') return Boolean(raw);
  if (entry.kind === 'slider') {
    const n = Number(raw);
    if (!Number.isFinite(n)) return entry.default;
    return Math.min(entry.max, Math.max(entry.min, n));
  }
  if (entry.kind === 'color') {
    return /^#[0-9a-fA-F]{6}$/.test(String(raw)) ? String(raw) : entry.default;
  }
  // choice
  return entry.options.some((o) => o.value === raw) ? raw : entry.default;
}

export function getSetting(key) {
  return values[key];
}

export function allSettings() {
  return { ...values };
}

export function settingEntry(key) {
  return BY_KEY.get(key);
}

// Fires on every change, with the key that changed. Called immediately on
// subscribe with a null key, so a subscriber can do its initial apply and
// its update through exactly one code path rather than two that can drift.
export function subscribeSettings(listener) {
  listeners.add(listener);
  listener(null, values);
  return () => listeners.delete(listener);
}

function notify(key) {
  for (const listener of listeners) {
    try {
      listener(key, values);
    } catch (error) {
      console.warn('A settings listener failed', error);
    }
  }
}

function persist() {
  if (!loaded) return Promise.resolve(false);
  return saveSettings({ ...values }).catch((error) => {
    console.warn('Settings could not be saved', error);
    return false;
  });
}

export function setSetting(key, raw) {
  const entry = BY_KEY.get(key);
  if (!entry) return;
  const value = coerce(entry, raw);
  if (values[key] === value) return;
  values[key] = value;
  notify(key); // effect lands before the write, so the UI never waits on disk
  persist();
}

export function resetSettings() {
  values = defaultSettings();
  notify(null);
  return persist();
}

export async function initSettings() {
  try {
    const record = await loadSettings();
    const stored = record && record.values ? record.values : {};
    for (const entry of SCHEMA) values[entry.key] = coerce(entry, stored[entry.key]);
  } catch (error) {
    console.warn('Settings could not be loaded; using defaults', error);
  }
  loaded = true;
  notify(null);
  return values;
}

// ---------------------------------------------------------------------------
// The frame-rate governor
//
// Screen Rate has to reach every animation in the app, and those live in
// separate modules that know nothing about each other -- the Home petals,
// the physics solver, the recording capture loop. Rather than teach each of
// them about settings, they each wrap their own requestAnimationFrame in
// this one gate.
//
// It THROTTLES rather than schedules: rAF still fires at whatever rate the
// display runs at, and a callback whose turn has not come simply returns
// without doing work. That keeps the caller's loop structure untouched,
// costs nothing but a subtraction on skipped frames, and degrades correctly
// on a 60Hz panel asked for 120Hz (the panel wins, as it must).
//
// 120 is treated as "no cap" on purpose. Gating on a 8.33ms budget against a
// display that is already delivering 8.33ms frames turns a rounding error
// into a dropped frame roughly every other frame, so the highest setting
// asks the gate to get out of the way entirely.

const rates = new WeakMap();

export function frameBudgetMs() {
  const rate = getSetting('screenRate');
  return rate >= 120 ? 0 : 1000 / rate;
}

// `token` is any object the caller owns -- its own state object is ideal --
// so several independent loops each keep their own last-frame time without
// this module having to hand out handles.
export function shouldRenderFrame(token, now = performance.now()) {
  const budget = frameBudgetMs();
  if (budget <= 0) return true;
  const last = rates.get(token);
  // A budget minus half a display frame, so a 60Hz target on a 60Hz panel
  // does not lose every other frame to a fraction of a millisecond of
  // jitter in when rAF happens to fire.
  if (last !== undefined && now - last < budget - 2) return false;
  rates.set(token, now);
  return true;
}
