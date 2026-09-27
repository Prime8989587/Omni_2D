// Headless verification of the one rule every drawing tool shares: a mark
// lands only on the layer's own artwork (artwork.js), and the boundary
// tools' fill treats the artwork's transparent edge as a wall, so a line
// drawn only on the artwork still closes.

import { opaqueAt, opaqueIndex, pointOnArtwork, texelUnder } from '../www/js/artwork.js';
import { floodFillFrom } from '../www/js/clayer.js';

const report = [];
const say = (ok, name, detail = '') => report.push({ ok, name, detail });

// RGBA from a picture: '#' opaque, '.' transparent.
function picture(rows) {
  const height = rows.length;
  const width = rows[0].length;
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let v = 0; v < height; v++) {
    for (let u = 0; u < width; u++) if (rows[v][u] === '#') pixels[(v * width + u) * 4 + 3] = 255;
  }
  return { width, height, pixels };
}

// --- Texels and points.
const blob = picture([
  '........',
  '..####..',
  '..####..',
  '........',
]);
say(opaqueAt(blob.pixels, blob.width, blob.height, 2, 1) && !opaqueAt(blob.pixels, blob.width, blob.height, 1, 1),
  'a texel is artwork when it has any alpha, and not when it has none');
say(!opaqueAt(blob.pixels, blob.width, blob.height, -1, 1) && !opaqueAt(blob.pixels, blob.width, blob.height, 8, 1),
  'nothing past the image is artwork');
say(opaqueIndex(blob.pixels, blob.width, blob.height, 1 * 8 + 3) && !opaqueIndex(blob.pixels, blob.width, blob.height, 0),
  'the same by flat index');
say(opaqueAt(null, 4, 4, 1, 1), 'a layer with no pixel data is treated as solid, so no tool locks itself out');
say(pointOnArtwork(blob.pixels, blob.width, blob.height, 2, 1) && pointOnArtwork(blob.pixels, blob.width, blob.height, 6, 3),
  'a point on the artwork\'s edge or corner is on it (a joint sits on a pixel edge)');
say(!pointOnArtwork(blob.pixels, blob.width, blob.height, 1.5, 1.5) && !pointOnArtwork(blob.pixels, blob.width, blob.height, 6.5, 2),
  'a point in the transparent margin, even right beside the art, is not');

// --- The texel under a point on a deformed mesh.
const vertices = [{ u: 0, v: 0 }, { u: 4, v: 0 }, { u: 0, v: 4 }, { u: 4, v: 4 }];
const triangles = [0, 1, 2, 1, 3, 2];
// Drawn at twice the size and moved to (10, 20).
const positions = vertices.map((p) => ({ x: 10 + p.u * 2, y: 20 + p.v * 2 }));
const hit = texelUnder(vertices, positions, triangles, { x: 13, y: 25 });
say(hit && Math.abs(hit.u - 1.5) < 1e-9 && Math.abs(hit.v - 2.5) < 1e-9,
  'a point on a moved, scaled layer maps back to the texel drawn under it', JSON.stringify(hit));
say(texelUnder(vertices, positions, triangles, { x: 9, y: 25 }) === null && texelUnder(vertices, positions, triangles, { x: 13, y: 29 }) === null,
  'a point off the layer maps to nothing');

// --- The fill, with the artwork's edge as a wall.
// A wide blob with a margin all round, and a line drawn only on the art
// right across it at column 5. Before, the fill would have leaked round
// both ends of the line through the margin.
const slab = picture([
  '............',
  '.##########.',
  '.##########.',
  '.##########.',
  '............',
]);
const cut = new Set([1, 2, 3].map((v) => v * 12 + 5));
const leaky = floodFillFrom(slab.width, slab.height, cut, 2, 2);
say(leaky.leaked, 'without the walls, a line only on the art leaks round its ends (the old test)');
const left = floodFillFrom(slab.width, slab.height, cut, 2, 2, { pixels: slab.pixels });
say(left.ok && left.filled.size === 12 && [...left.filled].every((i) => i % 12 >= 1 && i % 12 <= 4),
  'with them, the silhouette closes the cut: the left piece fills, and only it', `${left.filled ? left.filled.size : 0} px`);
const right = floodFillFrom(slab.width, slab.height, cut, 8, 2, { pixels: slab.pixels });
say(right.ok && right.filled.size === 15, 'and the right piece is its own', `${right.filled ? right.filled.size : 0} px`);
const onGlass = floodFillFrom(slab.width, slab.height, cut, 0, 0, { pixels: slab.pixels });
say(!onGlass.ok && onGlass.transparent, 'a fill started on a transparent pixel is refused as such, not as a leak');

// Artwork running right to the image edge (every cropped or trimmed layer).
const full = picture([
  '######',
  '######',
  '######',
]);
const line = new Set([0, 1, 2].map((v) => v * 6 + 2));
const edgeLeak = floodFillFrom(full.width, full.height, line, 4, 1, { pixels: full.pixels });
say(edgeLeak.leaked, 'with the edge test on, a piece reaching the image edge still counts as not closed (CLayer on a picture)');
const picked = floodFillFrom(full.width, full.height, line, 4, 1, { pixels: full.pixels, leak: false });
say(picked.ok && picked.filled.size === 9 && [...picked.filled].every((i) => i % 6 >= 3),
  'pointed at directly, the same piece is picked whole, edge and all (Mesh Trim\'s "tap the piece to keep")', `${picked.filled ? picked.filled.size : 0} px`);

// A hole in the art is a wall too: it holds nothing to take.
const ring = picture([
  '#####',
  '#...#',
  '#####',
]);
const around = floodFillFrom(ring.width, ring.height, new Set(), 0, 0, { pixels: ring.pixels, leak: false });
say(around.ok && around.filled.size === 12, 'a transparent hole inside the art is never filled into', `${around.filled ? around.filled.size : 0} px`);

console.log('\nartwork:\n');
let pass = 0;
for (const r of report) { console.log(`  ${r.ok ? 'ok  ' : 'FAIL'}  ${r.name}${r.ok || !r.detail ? '' : `\n          ${r.detail}`}`); if (r.ok) pass++; }
console.log(`\n${pass}/${report.length} checks passed`);
process.exit(report.every((r) => r.ok) ? 0 : 1);
