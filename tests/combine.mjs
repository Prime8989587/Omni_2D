// Combine Layers, headlessly: the flattened picture of two layers is exactly
// what the renderer would draw for them stacked, and the store swaps the two
// for one clean layer in the upper one's place.
//
//   node tests/combine.mjs

import { strict as assert } from 'node:assert';
import { Part, partsStore } from '../www/js/parts.js';
import { combinedArtwork, stackOrder } from '../www/js/combine.js';
import { rasterizeTriangle, layerClaims } from '../www/js/raster.js';
import { partQuad } from '../www/js/mesh.js';

let passed = 0;
let total = 0;
function check(name, fn) {
  total++;
  try {
    fn();
    passed++;
    console.log(`  ok    ${name}`);
  } catch (error) {
    console.log(`  FAIL  ${name}\n          ${error.message}`);
  }
}

function image(w, h, paint) {
  const pixels = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = paint(x, y);
      if (c) pixels.set(c.length === 4 ? c : [...c, 255], (y * w + x) * 4);
    }
  }
  return pixels;
}

const at = (art, x, y) => {
  const u = x - art.x; const v = y - art.y;
  if (u < 0 || v < 0 || u >= art.width || v >= art.height) return [0, 0, 0, 0];
  return Array.from(art.pixels.slice((v * art.width + u) * 4, (v * art.width + u) * 4 + 4));
};

console.log('\nCombine Layers');

const disc = new Part({ name: 'Disc', pixels: image(30, 30, (x, y) => (Math.hypot(x + 0.5 - 15, y + 0.5 - 15) <= 15 ? [40, 90, 220] : null)), width: 30, height: 30, x: 20, y: 24 });
const square = new Part({ name: 'Square', pixels: image(24, 24, (x) => (x >= 12 ? [240, 140, 30, 128] : [240, 140, 30])), width: 24, height: 24, x: 34, y: 30 });

check('the picture covers both layers, cropped to their artwork', () => {
  const art = combinedArtwork(disc, square);
  assert.deepEqual([art.x, art.y, art.width, art.height], [20, 24, 38, 30]);
});
check('the upper layer is drawn over the lower: opaque over opaque keeps the upper', () => {
  const art = combinedArtwork(disc, square);
  assert.deepEqual(at(art, 40, 38), [240, 140, 30, 255]);
  assert.deepEqual(at(art, 25, 38), [40, 90, 220, 255]);
});
check('a half see-through pixel over the lower layer is blended 50/50; over nothing it stays half see-through', () => {
  const art = combinedArtwork(disc, square);
  const over = at(art, 48, 34);
  assert.ok(Math.abs(over[0] - 140) <= 1 && Math.abs(over[1] - 115) <= 1 && Math.abs(over[2] - 125) <= 1 && over[3] === 255, JSON.stringify(over));
  assert.deepEqual(at(art, 56, 50), [240, 140, 30, 128]);
});
check('every see-through pixel is blended ONCE -- none twice along the quad\'s diagonal', () => {
  const art = combinedArtwork(disc, square);
  for (let y = 30; y < 54; y++) for (let x = 51; x < 58; x++) assert.equal(at(art, x, y)[3], 128, `(${x}, ${y})`);
});
check('the order is the stack, not the selection', () => {
  disc.zIndex = 1; square.zIndex = 2;
  assert.deepEqual(stackOrder(square, disc).map((p) => p.name), ['Disc', 'Square']);
});
check('the store swaps the two for one clean layer, in the upper one\'s place', () => {
  partsStore.replaceAll([], null);
  const below = partsStore.add(new Part({ name: 'Below', pixels: image(4, 4, () => [1, 2, 3]), width: 4, height: 4, x: 0, y: 0 }));
  const a = partsStore.add(new Part({ name: 'A', pixels: image(4, 4, () => [9, 9, 9]), width: 4, height: 4, x: 0, y: 0 }));
  const b = partsStore.add(new Part({ name: 'B', pixels: image(4, 4, () => [5, 5, 5]), width: 4, height: 4, x: 2, y: 0 }));
  const above = partsStore.add(new Part({ name: 'Above', pixels: image(4, 4, () => [7, 7, 7]), width: 4, height: 4, x: 0, y: 0 }));
  a.pins = new Set([1, 2]);
  const art = combinedArtwork(a, b);
  const made = partsStore.combine(a.id, b.id, { ...art, name: 'AB' });
  assert.deepEqual(partsStore.partsBottomFirst.map((p) => p.name), ['Below', 'AB', 'Above']);
  assert.equal(made.mesh, null);
  assert.equal(made.pins.size, 0);
  assert.equal(made.scale, 1);
  assert.equal(partsStore.selected, made);
  assert.ok(!partsStore.parts.includes(a) && !partsStore.parts.includes(b) && partsStore.parts.includes(below) && partsStore.parts.includes(above));
});

console.log('\nThe rasterizer decides each pixel once per layer');
check('without claims a see-through quad is blended twice along its diagonal; with them, once', () => {
  const part = new Part({ name: 'Glass', pixels: image(8, 8, () => [100, 100, 100, 128]), width: 8, height: 8, x: 0, y: 0 });
  const draw = (claims) => {
    const target = new Uint8ClampedArray(8 * 8 * 4);
    const { positions: P, uvs: U, triangles: T } = partQuad(part);
    const claim = claims ? layerClaims().begin(8, 8) : null;
    for (let t = 0; t < T.length; t += 3) {
      rasterizeTriangle(target, 8, 8, part.pixels, 8, 8, P[T[t]], P[T[t + 1]], P[T[t + 2]], U[T[t]], U[T[t + 1]], U[T[t + 2]], null, claim);
    }
    const alphas = new Set();
    for (let i = 0; i < 64; i++) alphas.add(target[i * 4 + 3]);
    return [...alphas].sort((x, y) => x - y);
  };
  assert.ok(draw(false).length > 1, `without: ${draw(false)}`);
  assert.deepEqual(draw(true), [128]);
});

console.log(`\n${passed}/${total} checks passed`);
if (passed !== total) process.exit(1);
