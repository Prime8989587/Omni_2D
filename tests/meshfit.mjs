// Headless verification that a generated mesh sits exactly on the layer's
// artwork -- not on its image file -- and maps it at rest without a nudge.

import { generateMesh, artworkBounds, meshGrid, localToWorld } from '../www/js/mesh.js';

const report = [];
const say = (ok, name, detail = '') => report.push({ ok, name, detail });

// A part from a picture: '#' opaque, '.' transparent.
function makePart(rows, { x = 0, y = 0, scale = 1 } = {}) {
  const h = rows.length;
  const w = rows[0].length;
  const pixels = new Uint8ClampedArray(w * h * 4);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) if (rows[j][i] === '#') pixels[(j * w + i) * 4 + 3] = 255;
  return { naturalWidth: w, naturalHeight: h, pixels, x, y, scale, rotation: 0,
    get centerX() { return this.x + (w * this.scale) / 2; }, get centerY() { return this.y + (h * this.scale) / 2; } };
}

// A 20x24 image with a 6x9 figure in its lower right, lots of padding.
const padded = makePart(Array.from({ length: 24 }, (_, j) => Array.from({ length: 20 }, (_, i) => (i >= 11 && i < 17 && j >= 12 && j < 21 ? '#' : '.')).join('')), { x: 30, y: 40, scale: 2 });
const box = artworkBounds(padded);
say(box.x === 11 && box.y === 12 && box.width === 6 && box.height === 9, 'artworkBounds finds the figure, not the file', JSON.stringify(box));

for (const [name, part] of [['padded', padded]]) {
  const mesh = generateMesh(part, 8);
  const used = new Set(mesh.triangles);
  const us = [...used].map((i) => mesh.vertices[i].u);
  const vs = [...used].map((i) => mesh.vertices[i].v);
  say(Math.min(...us) === 11 && Math.max(...us) === 17 && Math.min(...vs) === 12 && Math.max(...vs) === 21,
    `${name}: the mesh spans exactly the artwork's pixel bounds`, `u ${Math.min(...us)}..${Math.max(...us)} v ${Math.min(...vs)}..${Math.max(...vs)}`);
  say(mesh.vertices.every((v) => Number.isInteger(v.u) && Number.isInteger(v.v)), `${name}: every vertex sits on a whole texel`);
  const world = mesh.vertices.map((v) => localToWorld(part, v.restLocal));
  say(world.every((p) => Number.isInteger(p.x) && Number.isInteger(p.y)), `${name}: at rest every vertex lands on a whole scene pixel (the snap moves nothing)`);
  const tl = localToWorld(part, mesh.vertices[0].restLocal);
  say(tl.x === 30 + 11 * 2 && tl.y === 40 + 12 * 2, `${name}: the mesh corner is where the artwork's corner is drawn, at the layer's position and scale`, JSON.stringify(tl));
}

// An L: the mesh follows the silhouette, and still covers every opaque pixel.
const ell = makePart([
  '##......',
  '##......',
  '##......',
  '##......',
  '##......',
  '##......',
  '########',
  '########',
]);
const mesh = generateMesh(ell, 4);
const { us, vs } = meshGrid(mesh, ell);
const area = (t) => {
  const [a, b, c] = [0, 1, 2].map((k) => mesh.vertices[mesh.triangles[t + k]]);
  return Math.abs((b.u - a.u) * (c.v - a.v) - (c.u - a.u) * (b.v - a.v)) / 2;
};
let meshArea = 0;
for (let t = 0; t < mesh.triangles.length; t += 3) meshArea += area(t);
say(meshArea < 64, 'L-shaped art gets an L-shaped mesh, not its whole 8x8 box', `mesh area ${meshArea} of 64`);
// Every opaque pixel's centre is inside some triangle.
const inside = (px, py) => {
  for (let t = 0; t < mesh.triangles.length; t += 3) {
    const [a, b, c] = [0, 1, 2].map((k) => mesh.vertices[mesh.triangles[t + k]]);
    const d = (b.v - c.v) * (a.u - c.u) + (c.u - b.u) * (a.v - c.v);
    const l0 = ((b.v - c.v) * (px - c.u) + (c.u - b.u) * (py - c.v)) / d;
    const l1 = ((c.v - a.v) * (px - c.u) + (a.u - c.u) * (py - c.v)) / d;
    if (l0 >= -1e-9 && l1 >= -1e-9 && 1 - l0 - l1 >= -1e-9) return true;
  }
  return false;
};
let missed = 0;
for (let j = 0; j < 8; j++) for (let i = 0; i < 8; i++) if (ell.pixels[(j * 8 + i) * 4 + 3] && !inside(i + 0.5, j + 0.5)) missed++;
say(missed === 0, 'every opaque pixel is covered by the mesh', `${missed} missed`);
say(us.every((u, k) => k === 0 || u > us[k - 1]) && vs.every((v, k) => k === 0 || v > vs[k - 1]), 'grid edges strictly increase');

// A fully transparent layer still gets a (full-rect) mesh rather than none.
const blank = makePart(['....', '....']);
say(generateMesh(blank, 6).triangles.length > 0, 'a blank layer still gets a mesh');

console.log('\nmesh fit:\n');
let pass = 0;
for (const r of report) { console.log(`  ${r.ok ? 'ok  ' : 'FAIL'}  ${r.name}${r.ok || !r.detail ? '' : `\n          ${r.detail}`}`); if (r.ok) pass++; }
console.log(`\n${pass}/${report.length} checks passed`);
process.exit(report.every((r) => r.ok) ? 0 : 1);
