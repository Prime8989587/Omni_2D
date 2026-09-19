// When this project was last written to disk.
//
// The Save/Load system already records a savedAt on every record it
// writes -- named projects, the recovery slot, restore points. What was
// missing was somewhere to SEE it without opening a picker: the question
// "have I saved recently?" is asked constantly while working and answered
// by a dialog you have to close again.
//
// So this is a tiny clock, not a second source of truth. Everything that
// writes reports here; this formats the age and tells its subscribers when
// the wording would change. No timestamp is invented: if nothing has been
// written this session and nothing was loaded, there is nothing to show.

let savedAt = null;
let kind = null; // 'manual' | 'auto' | 'load'
const listeners = new Set();

export function subscribeSaveClock(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit() {
  listeners.forEach((listener) => listener());
}

// Every write path calls this. `kind` is carried so the label can say
// "Saved" for a deliberate save and "Auto-saved" for the recovery slot --
// a user who sees "Saved 10s ago" should not be misled into thinking their
// named project is current when only the crash-recovery copy is.
export function markSavedAt(at = Date.now(), which = 'manual') {
  savedAt = at;
  kind = which;
  emit();
}

export function markLoadedAt(at = Date.now()) {
  savedAt = at;
  kind = 'load';
  emit();
}

export function clearSaveClock() {
  if (savedAt === null) return;
  savedAt = null;
  kind = null;
  emit();
}

export function lastSavedAt() {
  return savedAt;
}

// Rounded DOWN throughout, because a save 59 seconds old is not "1 min
// ago" -- rounding up would be the one direction that overstates how long
// the work has been at risk.
export function formatAge(ms) {
  if (ms < 0) return 'just now';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 10) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

const VERB = { manual: 'Saved', auto: 'Auto-saved', load: 'Loaded' };

export function saveClockLabel(now = Date.now()) {
  if (savedAt === null) return 'Not saved yet';
  return `${VERB[kind] || 'Saved'} ${formatAge(now - savedAt)}`;
}

// How long until the label's WORDING would change, so the indicator can be
// refreshed on that boundary rather than on a fixed tick. Under a minute
// the seconds are shown and it has to update every second; past that only
// the minute matters, so once a minute is enough, and past an hour, once a
// minute is already far more often than needed but costs nothing.
export function msUntilLabelChanges(now = Date.now()) {
  if (savedAt === null) return 60_000;
  const age = now - savedAt;
  if (age < 60_000) return 1000;
  return 60_000 - (age % 60_000);
}
