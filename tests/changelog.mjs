// The version and its log agree with each other, with the scheme, and with
// every place the build reads a version from. A release that forgets its
// changelog entry -- or bumps one number and not the others -- fails here.
import fs from 'node:fs';
import { RELEASES, APP_VERSION, nextVersion, versionCode } from '../www/js/changelog.js';
import { APP_VERSION as SETTINGS_VERSION } from '../www/js/settings.js';

let passed = 0;
let total = 0;
const say = (ok, name, detail = '') => {
  total++;
  if (ok) passed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}`);
  if (detail) console.log(`          ${detail}`);
};

console.log('\nThe scheme');
const steps = [
  ['1.0.0', 'patch', '1.0.1'], ['1.0.8', 'patch', '1.0.9'], ['1.0.9', 'patch', '1.1.0'],
  ['1.1.0', 'minor', '1.2.0'], ['1.1.7', 'minor', '1.2.0'], ['1.8.4', 'minor', '1.9.0'],
  ['1.9.0', 'minor', '2.0.0'], ['1.9.9', 'patch', '2.0.0'], ['2.4.3', 'minor', '2.5.0'],
];
for (const [from, kind, to] of steps) say(nextVersion(from, kind) === to, `${from} + ${kind} = ${to}`, nextVersion(from, kind));
let threw = false;
try { nextVersion('1.0.0', 'major'); } catch { threw = true; }
say(threw, 'there is no third kind of step');

console.log('\nThe log');
const oldestFirst = [...RELEASES].reverse();
say(oldestFirst[0].version === '1.0.0' && oldestFirst[0].kind === 'first', 'the history starts at 1.0.0');
let broken = null;
for (let i = 1; i < oldestFirst.length; i++) {
  const prev = oldestFirst[i - 1];
  const next = oldestFirst[i];
  if (nextVersion(prev.version, next.kind) !== next.version) { broken = `${prev.version} + ${next.kind} is not ${next.version}`; break; }
  if (next.date < prev.date) { broken = `${next.version} is dated before ${prev.version}`; break; }
}
say(!broken, `every one of ${RELEASES.length} releases is exactly one step on from the one before, in date order`, broken || '');
say(RELEASES.every((r) => r.title && r.notes.length > 0), 'every release says what changed');
say(APP_VERSION === RELEASES[0].version && SETTINGS_VERSION === APP_VERSION, `the app reports the newest release (${APP_VERSION})`);

console.log('\nThe build agrees');
const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url)));
say(pkg.version === APP_VERSION, 'package.json', pkg.version);
const gradle = fs.readFileSync(new URL('../android/app/build.gradle', import.meta.url), 'utf8');
const name = (gradle.match(/versionName "([^"]+)"/) || [])[1];
const code = Number((gradle.match(/versionCode (\d+)/) || [])[1]);
say(name === APP_VERSION && code === versionCode(APP_VERSION), 'the Android versionName and versionCode', `${name} / ${code}`);

console.log(`\n${passed}/${total} checks passed`);
if (passed !== total) process.exit(1);
