// PCreate's colour math, verified headlessly against the real module:
// HSV<->RGB round trips at known reference points, and hex parsing that
// must distinguish a complete colour from one still being typed.

import { strict as assert } from 'node:assert';
import { hsvToRgb, rgbToHsv, rgbToHex, hexToRgb } from '../www/js/color.js';

let checks = 0;
let failures = 0;
const results = [];

function check(name, fn) {
  checks++;
  try {
    fn();
    results.push(`  ok    ${name}`);
  } catch (error) {
    failures++;
    results.push(`  FAIL  ${name}\n          ${error.message}`);
  }
}

function section(title) {
  results.push(`\n${title}`);
}

function closeRgb(a, b, tolerance = 1) {
  return Math.abs(a.r - b.r) <= tolerance && Math.abs(a.g - b.g) <= tolerance && Math.abs(a.b - b.b) <= tolerance;
}

// ---------------------------------------------------------------------------

section('hsvToRgb: known reference points');

const REFERENCE = [
  { rgb: { r: 255, g: 0, b: 0 }, hsv: { h: 0, s: 1, v: 1 }, name: 'pure red' },
  { rgb: { r: 255, g: 255, b: 0 }, hsv: { h: 60, s: 1, v: 1 }, name: 'pure yellow' },
  { rgb: { r: 0, g: 255, b: 0 }, hsv: { h: 120, s: 1, v: 1 }, name: 'pure green' },
  { rgb: { r: 0, g: 255, b: 255 }, hsv: { h: 180, s: 1, v: 1 }, name: 'pure cyan' },
  { rgb: { r: 0, g: 0, b: 255 }, hsv: { h: 240, s: 1, v: 1 }, name: 'pure blue' },
  { rgb: { r: 255, g: 0, b: 255 }, hsv: { h: 300, s: 1, v: 1 }, name: 'pure magenta' },
  { rgb: { r: 255, g: 255, b: 255 }, hsv: { h: 0, s: 0, v: 1 }, name: 'white' },
  { rgb: { r: 0, g: 0, b: 0 }, hsv: { h: 0, s: 0, v: 0 }, name: 'black' },
  { rgb: { r: 128, g: 128, b: 128 }, hsv: { h: 0, s: 0, v: 128 / 255 }, name: 'mid grey' },
];

for (const { rgb, hsv, name } of REFERENCE) {
  check(`hsvToRgb(${hsv.h}, ${hsv.s}, ${hsv.v}) is ${name}`, () => {
    const out = hsvToRgb(hsv.h, hsv.s, hsv.v);
    assert.ok(closeRgb(out, rgb, 0), `got rgb(${out.r},${out.g},${out.b}), expected rgb(${rgb.r},${rgb.g},${rgb.b})`);
  });
}

section('rgbToHsv: the same points, the other direction');

for (const { rgb, hsv, name } of REFERENCE) {
  check(`rgbToHsv(${rgb.r}, ${rgb.g}, ${rgb.b}) is ${name}`, () => {
    const out = rgbToHsv(rgb.r, rgb.g, rgb.b);
    // Hue is meaningless at zero saturation (grey/white/black): only check
    // it where the reference colour actually specifies one.
    if (hsv.s > 0) assert.ok(Math.abs(out.h - hsv.h) < 0.01, `hue ${out.h} !== ${hsv.h}`);
    assert.ok(Math.abs(out.s - hsv.s) < 1e-6, `sat ${out.s} !== ${hsv.s}`);
    assert.ok(Math.abs(out.v - hsv.v) < 1e-6, `val ${out.v} !== ${hsv.v}`);
  });
}

section('Round trips across the full wheel, not just the six named points');

check('every 5 degrees of hue at full saturation and value round-trips within 1 unit per channel', () => {
  let worst = 0;
  for (let h = 0; h < 360; h += 5) {
    const rgb = hsvToRgb(h, 1, 1);
    const hsv = rgbToHsv(rgb.r, rgb.g, rgb.b);
    const back = hsvToRgb(hsv.h, hsv.s, hsv.v);
    worst = Math.max(worst, Math.abs(back.r - rgb.r), Math.abs(back.g - rgb.g), Math.abs(back.b - rgb.b));
  }
  assert.ok(worst <= 1, `worst channel drift was ${worst}`);
});

check('a grid of arbitrary saturation/value pairs round-trips the same way', () => {
  let worst = 0;
  for (let h = 0; h < 360; h += 37) { // an odd step so it does not line up with any special angle
    for (let s = 0; s <= 10; s++) {
      for (let v = 0; v <= 10; v++) {
        const rgb = hsvToRgb(h, s / 10, v / 10);
        const hsv = rgbToHsv(rgb.r, rgb.g, rgb.b);
        const back = hsvToRgb(hsv.h, hsv.s, hsv.v);
        worst = Math.max(worst, Math.abs(back.r - rgb.r), Math.abs(back.g - rgb.g), Math.abs(back.b - rgb.b));
      }
    }
  }
  assert.ok(worst <= 1, `worst channel drift was ${worst}`);
});

check('hue wraps rather than producing a discontinuity at 360/0', () => {
  const a = hsvToRgb(359.9, 1, 1);
  const b = hsvToRgb(0, 1, 1);
  const c = hsvToRgb(-0.1, 1, 1); // negative input: must behave like 359.9, not throw or go black
  assert.ok(closeRgb(a, b, 2), `359.9deg and 0deg should be nearly identical, got rgb(${a.r},${a.g},${a.b}) vs rgb(${b.r},${b.g},${b.b})`);
  assert.ok(closeRgb(c, a, 2), `negative hue did not wrap correctly: rgb(${c.r},${c.g},${c.b})`);
});

section('hex conversion');

check('rgbToHex produces a lowercase 6-digit hex string', () => {
  assert.equal(rgbToHex(255, 165, 0), '#ffa500');
  assert.equal(rgbToHex(0, 0, 0), '#000000');
  assert.equal(rgbToHex(255, 255, 255), '#ffffff');
});

check('rgbToHex clamps and rounds out-of-range or fractional input', () => {
  assert.equal(rgbToHex(-10, 300, 127.6), '#00ff80');
});

check('hexToRgb accepts 6-digit hex, with or without a leading #, any case', () => {
  assert.deepEqual(hexToRgb('#FFA500'), { r: 255, g: 165, b: 0 });
  assert.deepEqual(hexToRgb('ffa500'), { r: 255, g: 165, b: 0 });
  assert.deepEqual(hexToRgb('#ffA500'), { r: 255, g: 165, b: 0 });
});

check('hexToRgb expands 3-digit shorthand the standard way (each digit doubled)', () => {
  assert.deepEqual(hexToRgb('#fa0'), { r: 255, g: 170, b: 0 });
  assert.deepEqual(hexToRgb('abc'), { r: 170, g: 187, b: 204 });
});

check('hexToRgb rejects anything not yet a complete colour, rather than guessing', () => {
  assert.equal(hexToRgb(''), null);
  assert.equal(hexToRgb('#'), null);
  assert.equal(hexToRgb('#f'), null);
  assert.equal(hexToRgb('#fa'), null);
  assert.equal(hexToRgb('#fa05'), null);
  assert.equal(hexToRgb('#fa050'), null);
  assert.equal(hexToRgb('#zzzzzz'), null);
  assert.equal(hexToRgb(null), null);
  assert.equal(hexToRgb(undefined), null);
});

check('rgbToHex -> hexToRgb is exact for every reference colour', () => {
  for (const { rgb } of REFERENCE) {
    const hex = rgbToHex(rgb.r, rgb.g, rgb.b);
    assert.deepEqual(hexToRgb(hex), rgb, `${hex} did not round-trip to rgb(${rgb.r},${rgb.g},${rgb.b})`);
  }
});

console.log(results.join('\n'));
console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
