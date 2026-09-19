// Automatic recovery saves.
//
// Separate from the named projects the user saves deliberately: this
// writes to a single recovery slot, so a crash costs at most the last few
// edits rather than everything since the last manual save. On the next
// launch the app compares the recovery slot against the newest manual save
// and offers to restore it if it is newer.
//
// Two triggers, because either alone leaves a gap:
//   * a timer, so a long editing session is covered even mid-gesture; and
//   * a short debounce after any change, so the common case (make an edit,
//     put the phone down, app is killed) is already safe.

import { history } from './history.js';
import { serializeProject } from './project.js';
import { saveRecovery } from './storage.js';

// The DEFAULT period. The Main settings section overrides it through
// setAutoSaveInterval() below, which is why this is a mutable starting
// value rather than a constant: the timer has to be re-armed at the new
// period the moment the preference changes, not at the next launch.
const DEFAULT_PERIODIC_MS = 2 * 60 * 1000; // every two minutes while dirty
const DEBOUNCE_MS = 8 * 1000; // ...and shortly after any change settles

let periodicMs = DEFAULT_PERIODIC_MS;
let timer = null;
let debounce = null;
let currentName = null; // the named project this session came from, if any
let onError = () => {};

// Told after every successful recovery write, so the last-saved indicator
// can report an auto-save without this module knowing the indicator exists.
let onWritten = () => {};

export function onAutoSaveWritten(listener) {
  onWritten = listener || (() => {});
}

async function write(reason) {
  if (!history.isDirty) return false;
  try {
    await saveRecovery(serializeProject({ copyPixels: false }), currentName);
    onWritten(reason);
    return true;
  } catch (error) {
    console.warn(`Auto-save (${reason}) failed`, error);
    onError(error);
    return false;
  }
}

function scheduleDebounced() {
  clearTimeout(debounce);
  debounce = setTimeout(() => write('change'), DEBOUNCE_MS);
}

// Called after a manual save or a load, so the recovery slot knows which
// project it belongs to.
export function setAutoSaveSource(name) {
  currentName = name;
}

export function autoSaveNow(reason = 'manual') {
  return write(reason);
}

// Re-arms the periodic timer at a new interval. Called on boot and on every
// change to the Main section's Auto-save interval, so shortening it takes
// effect within one period rather than at the next launch. Safe before
// initAutoSave(): there is simply no timer to clear yet, and the interval
// this records is the one initAutoSave will arm with.
export function setAutoSaveInterval(ms) {
  const next = Math.max(5000, Number(ms) || DEFAULT_PERIODIC_MS);
  if (next === periodicMs && timer) return;
  periodicMs = next;
  if (timer) {
    clearInterval(timer);
    timer = setInterval(() => write('timer'), periodicMs);
  }
}

export function autoSaveIntervalMs() {
  return periodicMs;
}

export function initAutoSave({ onFailure } = {}) {
  if (onFailure) onError = onFailure;
  history.subscribe(() => {
    if (history.isDirty) scheduleDebounced();
  });
  clearInterval(timer);
  timer = setInterval(() => write('timer'), periodicMs);

  // Backgrounding an app on a phone is the moment before it gets killed.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') write('background');
  });
}
