// Headless verification of settings.js: the schema, the coercion that
// guards against stale or malformed stored values, the change
// notification features rely on, and the Screen Rate frame governor.
//
// Runs without a browser. The durable write-through is inert here (there is
// no IndexedDB in Node, and persist() declines until initSettings() has
// run), which is what makes the in-memory behaviour testable on its own --
// persistence itself is proven end-to-end in the browser suite instead.

import {
  SCHEMA, SECTIONS, APP_VERSION,
  defaultSettings, getSetting, setSetting, allSettings, settingEntry,
  subscribeSettings, resetSettings, frameBudgetMs, shouldRenderFrame,
} from '../www/js/settings.js';

const report = [];
const say = (ok, name, detail = '') => report.push({ ok, name, detail });
const eq = (a, b, name, detail) => say(a === b, name, detail || `expected ${b}, got ${a}`);

// ---------------------------------------------------------------------------
// The schema itself

{
  const keys = SCHEMA.map((e) => e.key);
  eq(new Set(keys).size, keys.length, 'every setting key is unique');
  // Brush presets are real settings -- same store, same persistence, same
  // wipe -- but they carry no section on purpose, which is exactly what
  // keeps them off the Settings screen: renderBody only draws entries whose
  // section matches the open tab. So "every setting is rendered somewhere"
  // is now a claim about the SHOWN ones, and the hidden ones get their own
  // checks below rather than being waved through.
  const shown = SCHEMA.filter((e) => e.section !== undefined);
  say(shown.every((e) => SECTIONS.some((s) => s.key === e.section)),
    'every setting with a section belongs to one of the three declared sections');
  say(SCHEMA.filter((e) => e.kind === 'presets').every((e) => e.section === undefined),
    'and the preset settings carry no section, so the Settings screen never draws them');
  say(SECTIONS.every((s) => SCHEMA.some((e) => e.section === s.key)),
    'every section has at least one setting in it');
  eq(SECTIONS.length, 3, 'there are exactly three sections');
  eq(SECTIONS.map((s) => s.key).join(','), 'main,pcreate,rig',
    'the sections are Main, PCreate and Rig, in that order');

  say(shown.every((e) => typeof e.label === 'string' && e.label.length > 0),
    'every setting that is rendered has a label to render');
  say(SCHEMA.filter((e) => e.kind === 'presets').every((e) =>
    Array.isArray(e.default)
    && e.default.length > 0
    && e.default.length <= e.slots
    && e.default.every((v) => Number.isInteger(v) && v >= e.min && v <= e.max)
    && new Set(e.default).size === e.default.length),
    'every preset setting ships defaults that are unique, in range and within its slot count');
  say(SCHEMA.filter((e) => e.kind === 'choice').every(
    (e) => Array.isArray(e.options) && e.options.some((o) => o.value === e.default)
  ), 'every choice setting\'s default is one of its own options');
  say(SCHEMA.filter((e) => e.kind === 'slider').every(
    (e) => e.default >= e.min && e.default <= e.max
  ), 'every slider setting\'s default is inside its own range');
  say(/^\d+\.\d+\.\d+$/.test(APP_VERSION), 'the app version reads as a version number', APP_VERSION);
}

// ---------------------------------------------------------------------------
// Defaults

{
  const d = defaultSettings();
  eq(Object.keys(d).length, SCHEMA.length, 'defaults cover every setting in the schema');
  eq(d.backConfirm, true, 'Back-to-Menu confirmation defaults ON, the safer choice');
  eq(d.gridSnap, true, 'Grid snap defaults ON');
  eq(d.doubleTapFill, false, 'Double-tap to Fill defaults OFF (it misfires on a routine gesture)');
  eq(d.longPressPick, true, 'Long-press to Pick Color defaults ON (it cannot change a pixel)');
  eq(d.contourMode, 'off', 'Contour mode defaults OFF');
  eq(d.checkerStrength, 'normal', 'Checkerboard strength defaults to Normal, the previous appearance');
  eq(d.boneListDefault, 'expanded', 'the bone hierarchy list defaults to Expanded');
  eq(d.defaultEditInPlace, false, 'PCreate still defaults to working on a copy');
}

// ---------------------------------------------------------------------------
// Coercion: a stored value this build does not recognise falls back rather
// than reaching the feature that reads it.

{
  setSetting('screenRate', 999);
  eq(getSetting('screenRate'), 60, 'a screen rate outside the options is refused, keeping the default');

  setSetting('screenRate', 30);
  eq(getSetting('screenRate'), 30, 'a valid screen rate is accepted');

  setSetting('contourThickness', 9999);
  eq(getSetting('contourThickness'), 6, 'a slider value above its maximum is clamped to the maximum');
  setSetting('contourThickness', -4);
  eq(getSetting('contourThickness'), 1, 'a slider value below its minimum is clamped to the minimum');
  setSetting('contourThickness', 'banana');
  eq(getSetting('contourThickness'), 1, 'a non-numeric slider value is refused');

  setSetting('contourColor', 'not-a-colour');
  eq(getSetting('contourColor'), '#FF2E93', 'a malformed colour falls back to the pink accent');
  setSetting('contourColor', '#00ff00');
  eq(getSetting('contourColor'), '#00ff00', 'a well-formed colour is accepted');

  setSetting('backConfirm', 0);
  eq(getSetting('backConfirm'), false, 'a toggle coerces a falsy value to false');
  setSetting('backConfirm', 'yes');
  eq(getSetting('backConfirm'), true, 'a toggle coerces a truthy value to true');

  setSetting('autoPaletteRefresh', 'sometimes');
  eq(getSetting('autoPaletteRefresh'), 'open', 'an unknown choice string is refused');

  setSetting('noSuchSetting', 1);
  eq(getSetting('noSuchSetting'), undefined, 'writing an unknown key is ignored entirely');
}

// ---------------------------------------------------------------------------
// Notification: this is how a feature learns to re-apply itself.

{
  const seen = [];
  const unsubscribe = subscribeSettings((key) => seen.push(key));
  eq(seen.length, 1, 'subscribing fires immediately, so a subscriber has one apply path');
  eq(seen[0], null, 'that first call carries a null key, meaning "everything"');

  setSetting('gridSnap', false);
  eq(seen.length, 2, 'a change notifies subscribers');
  eq(seen[1], 'gridSnap', 'the notification names the key that changed');

  setSetting('gridSnap', false);
  eq(seen.length, 2, 'setting a value it already has notifies nobody');

  unsubscribe();
  setSetting('gridSnap', true);
  eq(seen.length, 2, 'unsubscribing really stops the notifications');
}

// ---------------------------------------------------------------------------
// Reading back

{
  setSetting('defaultBrush', 6);
  const all = allSettings();
  eq(all.defaultBrush, 6, 'allSettings reflects a change');
  all.defaultBrush = 99;
  eq(getSetting('defaultBrush'), 6, 'allSettings hands back a copy, not the live object');

  eq(settingEntry('gridSnap').section, 'rig', 'settingEntry finds a setting\'s declaration');
  eq(settingEntry('nope'), undefined, 'settingEntry returns nothing for an unknown key');
}

// ---------------------------------------------------------------------------
// The Screen Rate frame governor

{
  setSetting('screenRate', 120);
  eq(frameBudgetMs(), 0, '120Hz asks the governor to get out of the way entirely');

  const token = {};
  say(shouldRenderFrame(token, 0) && shouldRenderFrame(token, 0.1),
    'at 120Hz every frame is allowed through, however close together');

  setSetting('screenRate', 30);
  say(Math.abs(frameBudgetMs() - 1000 / 30) < 1e-9,
    '30Hz budgets 33.3ms per frame', String(frameBudgetMs()));

  const t30 = {};
  say(shouldRenderFrame(t30, 1000), 'the first frame is always allowed');
  say(!shouldRenderFrame(t30, 1005), 'a frame 5ms later is skipped at 30Hz');
  say(!shouldRenderFrame(t30, 1020), 'a frame 20ms later is still skipped at 30Hz');
  say(shouldRenderFrame(t30, 1040), 'a frame 40ms later is allowed at 30Hz');

  // Two loops must pace independently, or the petals and the physics would
  // steal frames from each other.
  const a = {};
  const b = {};
  say(shouldRenderFrame(a, 2000) && shouldRenderFrame(b, 2000),
    'two separate loops each get their own pacing, not a shared one');
  say(!shouldRenderFrame(a, 2005) && !shouldRenderFrame(b, 2005),
    'and each is throttled on its own timeline');

  setSetting('screenRate', 60);
  const t60 = {};
  say(shouldRenderFrame(t60, 5000), 'first frame at 60Hz');
  say(!shouldRenderFrame(t60, 5008), 'half a frame later is skipped at 60Hz');
  say(shouldRenderFrame(t60, 5016),
    '16ms later is allowed at 60Hz -- the tolerance stops a 60Hz panel losing every other frame');
}

// ---------------------------------------------------------------------------
// Reset

{
  setSetting('gridSnap', false);
  setSetting('contourThickness', 5);
  resetSettings();
  eq(getSetting('gridSnap'), true, 'reset restores a toggle to its default');
  eq(getSetting('contourThickness'), 1, 'reset restores a slider to its default');
  const d = defaultSettings();
  say(Object.keys(d).every((k) => getSetting(k) === d[k]),
    'reset restores EVERY setting, not just the ones that were touched');
}

console.log('\nsettings.js:\n');
let pass = 0;
for (const r of report) {
  console.log(`  ${r.ok ? 'ok  ' : 'FAIL'}  ${r.name}`);
  if (!r.ok && r.detail) console.log(`          ${r.detail}`);
  if (r.ok) pass++;
}
console.log(`\n${pass}/${report.length} checks passed`);
process.exit(report.every((r) => r.ok) ? 0 : 1);
