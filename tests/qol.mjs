// The pure core of the QoL batch: multi-select, the batch writes, the
// save clock, haptic throttling, and the brush-preset store.
//
// The claim that matters most here is INDEPENDENCE: batching writes the
// same value onto each item's own field, and nothing links them
// afterward. That is checked by doing the batch and then moving ONE of the
// items and watching the others not follow -- which is the only version of
// that claim a shared reference could not also pass.

import { BonesStore } from '../www/js/bones.js';
import { boneSelection, partSelection, matchesFilter } from '../www/js/multiselect.js';
import {
  markSavedAt, markLoadedAt, clearSaveClock, saveClockLabel, formatAge,
  msUntilLabelChanges, lastSavedAt,
} from '../www/js/saveclock.js';
import { haptic, hapticsDebug, resetHapticsDebug, setHapticsEnabled } from '../www/js/haptics.js';
import { getSetting, setSetting, togglePreset, hasPreset, SCHEMA } from '../www/js/settings.js';

let passed = 0;
let total = 0;
const say = (ok, name, detail = '') => {
  total++;
  if (ok) passed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}`);
  if (detail) console.log(`          ${detail}`);
};
const eq = (a, b, name) => say(a === b, name, a === b ? '' : `got ${JSON.stringify(a)}, wanted ${JSON.stringify(b)}`);

// ---------------------------------------------------------------------------
// Multi-select

{
  boneSelection.setActive(false);
  say(!boneSelection.active && boneSelection.size === 0, 'selection starts off and empty');

  boneSelection.setActive(true);
  boneSelection.toggle('a');
  boneSelection.toggle('b');
  boneSelection.toggle('c');
  eq(boneSelection.size, 3, 'three taps select three items');
  boneSelection.toggle('b');
  eq(boneSelection.size, 2, 'tapping a selected item again removes it');
  say(boneSelection.has('a') && !boneSelection.has('b'), 'and the right one came out');

  boneSelection.prune(['a']);
  eq(boneSelection.size, 1, 'pruning drops ids that no longer exist');

  boneSelection.setActive(false);
  eq(boneSelection.size, 0, 'leaving selection mode empties the set, so no invisible selection survives');

  // The two lists are genuinely separate.
  boneSelection.setActive(true);
  boneSelection.toggle('bone_1');
  say(!partSelection.active && partSelection.size === 0,
    'arming the bone list does not arm the layer list', `parts active=${partSelection.active}`);
  boneSelection.setActive(false);
}

// ---------------------------------------------------------------------------
// Filter

{
  say(matchesFilter('hairFront', 'hair'), 'filter matches a substring');
  say(matchesFilter('hairFront', 'HAIR'), 'and is case-insensitive');
  say(matchesFilter('hairFront', 'Front'), 'matching anywhere in the name, not just the start');
  say(!matchesFilter('hairFront', 'leg'), 'and does not match what is not there');
  say(matchesFilter('anything', ''), 'an empty query matches everything');
  say(matchesFilter('anything', '   '), 'and so does a whitespace-only one, so clearing the field restores the list');
}

// ---------------------------------------------------------------------------
// Batch physics onto bones -- and the independence claim

{
  const store = new BonesStore();
  const ids = [];
  for (let i = 0; i < 6; i++) {
    store.addBone({ head: { x: 10 + i, y: 10 }, tail: { x: 10 + i, y: 30 } });
    ids.push(store.bones[store.bones.length - 1].id);
  }
  eq(store.bones.length, 6, 'a six-bone rig to batch over');

  const changed = store.batchSetPhysicsParam(ids, 'stiffness', 300);
  eq(changed, 6, 'batching stiffness reports six bones affected');
  say(ids.every((id) => store.byId(id).stiffness === 300),
    'and every one of them now reads 300',
    ids.map((id) => store.byId(id).stiffness).join(', '));

  // THE INDEPENDENCE TEST. If the batch had linked them -- one shared
  // object, or the same reference on each bone -- moving one would move
  // all. Each bone holds its own number, so only the one touched changes.
  store.setPhysicsParam(ids[2], 'stiffness', 55);
  eq(store.byId(ids[2]).stiffness, 55, 'editing one batched bone afterward changes that bone');
  const others = ids.filter((_, i) => i !== 2).map((id) => store.byId(id).stiffness);
  say(others.every((v) => v === 300),
    'and leaves the other five exactly where the batch put them -- independent values, not a shared reference',
    `others: ${others.join(', ')}`);

  // Fields are own properties on each bone, not inherited from anything.
  say(ids.every((id) => Object.prototype.hasOwnProperty.call(store.byId(id), 'stiffness')),
    'each bone carries stiffness as its OWN property');

  store.batchSetPhysicsParam(ids, 'damping', 12);
  store.batchSetPhysicsParam(ids, 'gravityInfluence', 30);
  say(ids.every((id) => {
    const b = store.byId(id);
    return b.damping === 12 && b.gravityInfluence === 30;
  }), 'all three physics parameters batch the same way');

  // Out-of-range values are clamped, exactly as the single-bone slider is.
  store.batchSetPhysicsParam(ids, 'stiffness', 99999);
  eq(store.byId(ids[0]).stiffness, 600, 'a batch cannot write past the range the slider enforces');
  eq(store.batchSetPhysicsParam(ids, 'notAParam', 5), 0, 'an unknown parameter is refused outright');
  eq(store.batchSetPhysicsParam(['nope'], 'stiffness', 100), 0, 'and ids that do not exist affect nothing');
}

// ---------------------------------------------------------------------------
// Batch joint type

{
  const store = new BonesStore();
  const ids = [];
  for (let i = 0; i < 4; i++) {
    store.addBone({ head: { x: 10, y: 10 + i * 5 }, tail: { x: 10, y: 20 + i * 5 } });
    ids.push(store.bones[store.bones.length - 1].id);
  }
  const n = store.batchSetJointType(ids, 'physics');
  eq(n, 4, 'batching a joint type reports four bones affected');
  say(ids.every((id) => store.byId(id).jointType === 'physics'), 'and all four are physics bones now');
  say(ids.every((id) => store.byId(id).physicsEnabled), 'with physics genuinely enabled on each');

  eq(store.batchSetJointType(ids, 'physics'), 0,
    're-applying the same type reports zero, because nothing was affected');

  store.setJointType(ids[1], 'rigid');
  eq(store.byId(ids[1]).jointType, 'rigid', 'one of them can go back to rigid on its own');
  say(ids.filter((_, i) => i !== 1).every((id) => store.byId(id).jointType === 'physics'),
    'without dragging the others back with it');

  eq(store.batchSetJointType(ids, 'nonsense'), 0, 'an unknown joint type is refused');
}

// ---------------------------------------------------------------------------
// The save clock

{
  clearSaveClock();
  eq(lastSavedAt(), null, 'the clock starts with nothing to report');
  eq(saveClockLabel(), 'Not saved yet', 'and says so plainly rather than inventing a time');

  const t = 1_000_000;
  markSavedAt(t, 'manual');
  eq(saveClockLabel(t + 2000), 'Saved just now', 'a fresh save reads "just now"');
  eq(saveClockLabel(t + 25_000), 'Saved 25s ago', 'then counts seconds');
  eq(saveClockLabel(t + 3 * 60_000), 'Saved 3 min ago', 'then minutes -- the wording the request asked for');
  eq(saveClockLabel(t + 2 * 3_600_000), 'Saved 2h ago', 'then hours');
  eq(saveClockLabel(t + 3 * 86_400_000), 'Saved 3d ago', 'then days');

  // Rounding DOWN matters: 59s is not yet a minute.
  eq(formatAge(59_000), '59s ago', '59 seconds is still counted in seconds');
  eq(formatAge(60_000), '1 min ago', 'and 60 is the first minute');
  eq(formatAge(119_000), '1 min ago', 'with 1:59 still reading as one minute, never rounded up');

  markSavedAt(t, 'auto');
  eq(saveClockLabel(t + 60_000), 'Auto-saved 1 min ago',
    'an auto-save says so, so it is not mistaken for a saved project');
  markLoadedAt(t);
  eq(saveClockLabel(t + 60_000), 'Loaded 1 min ago', 'and a load reads as a load');

  markSavedAt(t, 'manual');
  eq(msUntilLabelChanges(t + 5_000), 1000, 'under a minute the label refreshes every second');
  eq(msUntilLabelChanges(t + 90_000), 30_000,
    'past that it waits for the exact moment the minute count ticks over');

  let notified = 0;
  const off = (await import('../www/js/saveclock.js')).subscribeSaveClock(() => { notified++; });
  markSavedAt(t + 1, 'manual');
  eq(notified, 1, 'saving notifies the indicator');
  off();
  clearSaveClock();
}

// ---------------------------------------------------------------------------
// Haptics

{
  resetHapticsDebug();
  setHapticsEnabled(true);
  const t = 500_000;
  say(haptic('pin', t) !== undefined, 'a pin pulse is accepted');
  const afterPin = hapticsDebug();
  eq(afterPin.counts.pin, 1, 'and recorded once');

  haptic('pin', t + 5); // inside the throttle window
  eq(hapticsDebug().counts.pin, 1, 'a second pin 5ms later is throttled, so a stroke ticks rather than buzzes');
  haptic('pin', t + 100);
  eq(hapticsDebug().counts.pin, 2, 'but a pin 100ms later is its own tick');

  // Throttles are per pattern: a barrier contact must not be swallowed
  // just because a pin fired a moment ago.
  haptic('barrier', t + 101);
  eq(hapticsDebug().counts.barrier, 1, 'a barrier pulse is not suppressed by a recent pin');

  haptic('snap', t + 102);
  haptic('record', t + 103);
  const all = hapticsDebug();
  say(all.counts.snap === 1 && all.counts.record === 1,
    'all four of the specified patterns exist and fire',
    JSON.stringify(all.counts));
  say(haptic('nonsense', t + 200) === false, 'an unknown pattern is refused rather than guessed at');
  resetHapticsDebug();
}

// ---------------------------------------------------------------------------
// Brush presets

{
  for (const key of ['pxPinBrushPresets', 'pierceBrushPresets', 'weightBrushPresets']) {
    const entry = SCHEMA.find((e) => e.key === key);
    const list = getSetting(key);
    say(Array.isArray(list) && list.length > 0 && list.length <= entry.slots,
      `${key} starts with a usable set of favourites`, JSON.stringify(list));
  }

  setSetting('pxPinBrushPresets', [1, 4, 8]);
  eq(JSON.stringify(togglePreset('pxPinBrushPresets', 6)), '[4,6,8]',
    'saving a new favourite past the last slot drops the lowest, keeping the newest');
  say(hasPreset('pxPinBrushPresets', 6), 'and the new one is there');
  eq(JSON.stringify(togglePreset('pxPinBrushPresets', 6)), '[4,8]',
    'saving the same size again removes it');
  eq(JSON.stringify(togglePreset('pxPinBrushPresets', 99)), '[4,8]',
    'a size outside the tool range is ignored rather than stored');

  setSetting('pxPinBrushPresets', [5]);
  eq(JSON.stringify(togglePreset('pxPinBrushPresets', 5)), '[5]',
    'the last remaining favourite cannot be removed, so the row is never empty');

  // Stored junk is filtered down to what is still valid, not thrown away.
  setSetting('pxPinBrushPresets', [3, 3, 7, 999, -2, 'x']);
  eq(JSON.stringify(getSetting('pxPinBrushPresets')), '[3,7]',
    'a stored list is de-duplicated and range-filtered on the way in');
  setSetting('pxPinBrushPresets', ['x', 999]);
  eq(JSON.stringify(getSetting('pxPinBrushPresets')), '[1,4,8]',
    'and falls back to the defaults only when nothing in it survives');

  setSetting('weightBrushPresets', [20, 45, 90]);
  eq(JSON.stringify(togglePreset('weightBrushPresets', 120)), '[45,90,120]',
    'the weight brush uses its own, much wider range');
  setSetting('weightBrushPresets', [20, 45, 90]);
}

console.log(`\n${passed}/${total} checks passed`);
process.exit(passed === total ? 0 : 1);
