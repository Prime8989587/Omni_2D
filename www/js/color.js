// Colour conversion: pure functions, no DOM, so the wheel's math can be
// verified headlessly against known reference values rather than by
// screenshotting a canvas and eyeballing pixels -- the same reasoning
// dent.js's and raster.js's own geometry is kept apart from any rendering
// context.
//
// PCreate is the first thing in the app to need general RGB<->HSV
// conversion (everything else works in the artwork's own stored bytes),
// so this is a new, small, self-contained module rather than folded into
// an existing one.

// h in [0, 360), s and v in [0, 1]. Returns integer 0-255 channels.
export function hsvToRgb(h, s, v) {
  const hue = ((h % 360) + 360) % 360; // never negative, never >= 360
  const c = v * s;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = v - c;
  let r1 = 0;
  let g1 = 0;
  let b1 = 0;
  if (hue < 60) { r1 = c; g1 = x; b1 = 0; }
  else if (hue < 120) { r1 = x; g1 = c; b1 = 0; }
  else if (hue < 180) { r1 = 0; g1 = c; b1 = x; }
  else if (hue < 240) { r1 = 0; g1 = x; b1 = c; }
  else if (hue < 300) { r1 = x; g1 = 0; b1 = c; }
  else { r1 = c; g1 = 0; b1 = x; }
  return {
    r: Math.round((r1 + m) * 255),
    g: Math.round((g1 + m) * 255),
    b: Math.round((b1 + m) * 255),
  };
}

// r, g, b in [0, 255]. Returns h in [0, 360), s and v in [0, 1].
export function rgbToHsv(r, g, b) {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const delta = max - min;

  let h = 0;
  if (delta > 1e-9) {
    if (max === rn) h = 60 * (((gn - bn) / delta) % 6);
    else if (max === gn) h = 60 * ((bn - rn) / delta + 2);
    else h = 60 * ((rn - gn) / delta + 4);
    if (h < 0) h += 360;
  }
  const v = max;
  const s = max <= 1e-9 ? 0 : delta / max;
  return { h, s, v };
}

const HEX_DIGITS = '0123456789abcdef';

function toHexByte(n) {
  const clamped = Math.max(0, Math.min(255, Math.round(n)));
  return HEX_DIGITS[Math.floor(clamped / 16)] + HEX_DIGITS[clamped % 16];
}

export function rgbToHex(r, g, b) {
  return `#${toHexByte(r)}${toHexByte(g)}${toHexByte(b)}`;
}

// Accepts "#rgb", "#rrggbb", with or without the leading "#", any case.
// Returns null for anything not yet a COMPLETE valid hex colour -- the
// caller is reading this from a text field as the user types, and "#a0"
// is not a colour yet, it is a colour half-typed; treating it as invalid
// (rather than guessing or erroring) is what lets typing continue without
// the field fighting back on every keystroke.
export function hexToRgb(raw) {
  const value = String(raw || '').trim().replace(/^#/, '').toLowerCase();
  if (!/^[0-9a-f]{3}$/.test(value) && !/^[0-9a-f]{6}$/.test(value)) return null;
  const full = value.length === 3
    ? value.split('').map((c) => c + c).join('')
    : value;
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
  };
}
