// Headless verification of contour.js -- the outline tracing behind the
// Rig section's Contour mode.
//
// Hand-written alpha grids with known answers, so "does this find the right
// edge" is settled arithmetically rather than by screenshotting a rig.

import { traceAlphaEdges, traceAlphaEdgesInBounds } from '../www/js/contour.js';

const report = [];
const say = (ok, name, detail = '') => report.push({ ok, name, detail });
const eq = (a, b, name, detail) => say(a === b, name, detail || `expected ${b}, got ${a}`);

// Builds an RGBA buffer from a picture: '#' opaque, '.' transparent.
function grid(rows) {
  const height = rows.length;
  const width = rows[0].length;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (rows[y][x] === '#') data[(y * width + x) * 4 + 3] = 255;
    }
  }
  return { data, width, height };
}

const asSet = (edges) => new Set(edges);
const at = (g, x, y) => y * g.width + x;

// ---------------------------------------------------------------------------
// A solid block: every pixel on its rim is an edge, the middle is not.

{
  const g = grid([
    '.....',
    '.###.',
    '.###.',
    '.###.',
    '.....',
  ]);
  const edges = asSet(traceAlphaEdges(g.data, g.width, g.height));
  eq(edges.size, 8, 'a 3x3 block reports its 8 rim pixels as the contour');
  say(!edges.has(at(g, 2, 2)), 'the centre of a 3x3 block is NOT on the contour');
  say(edges.has(at(g, 1, 1)) && edges.has(at(g, 3, 3)),
    'opposite corners of the block are both on the contour');
}

// ---------------------------------------------------------------------------
// A single pixel is entirely its own outline.

{
  const g = grid(['...', '.#.', '...']);
  eq(traceAlphaEdges(g.data, g.width, g.height).length, 1,
    'a lone pixel is its own contour');
}

// ---------------------------------------------------------------------------
// Nothing opaque means nothing to outline.

{
  const g = grid(['...', '...', '...']);
  eq(traceAlphaEdges(g.data, g.width, g.height).length, 0,
    'a fully transparent grid has no contour');
}

// ---------------------------------------------------------------------------
// Artwork running off the buffer edge is still outlined along that edge:
// off-buffer counts as transparent, so a shape flush to the border does not
// silently open up there.

{
  const g = grid(['###', '###', '###']);
  eq(traceAlphaEdges(g.data, g.width, g.height).length, 8,
    'a shape flush to every border is outlined along the border too');
}

// ---------------------------------------------------------------------------
// A hole has an inner rim, and it counts.

{
  const g = grid([
    '#####',
    '#####',
    '##.##',
    '#####',
    '#####',
  ]);
  const edges = asSet(traceAlphaEdges(g.data, g.width, g.height));
  say(edges.has(at(g, 2, 1)) && edges.has(at(g, 1, 2))
    && edges.has(at(g, 3, 2)) && edges.has(at(g, 2, 3)),
    'the four pixels around an interior hole are on the contour');
  say(!edges.has(at(g, 1, 1)),
    'a pixel diagonal to the hole is not, since four-connected is the rule');
}

// ---------------------------------------------------------------------------
// Four-connected, not eight: a diagonal staircase must not thicken.

{
  const g = grid([
    '#...',
    '.#..',
    '..#.',
    '...#',
  ]);
  eq(traceAlphaEdges(g.data, g.width, g.height).length, 4,
    'every pixel of a one-wide diagonal is on the contour, none doubled');
}

// ---------------------------------------------------------------------------
// The bounded trace: same answers, restricted to a rectangle, with the
// neighbour test still reaching outside it.

{
  const g = grid([
    '.....',
    '.###.',
    '.###.',
    '.###.',
    '.....',
  ]);
  const full = asSet(traceAlphaEdges(g.data, g.width, g.height));
  const bounded = asSet(traceAlphaEdgesInBounds(
    g.data, g.width, g.height, { x0: 1, y0: 1, x1: 4, y1: 4 }
  ));
  eq(bounded.size, full.size,
    'bounding the trace to the shape gives the same contour as tracing it all');

  // A rectangle cutting THROUGH the block: the pixels along the cut are
  // interior and must stay interior, because the neighbour test looks
  // beyond the rectangle and finds opaque pixels there.
  const half = asSet(traceAlphaEdgesInBounds(
    g.data, g.width, g.height, { x0: 1, y0: 1, x1: 4, y1: 3 }
  ));
  say(!half.has(at(g, 2, 2)),
    'a pixel on the rectangle\'s inner cut is not reported as an edge',
    'the neighbour test reaches outside the bounds, as it must');
  eq(half.size, 5, 'the cut rectangle reports only genuinely-boundary pixels');
}

// ---------------------------------------------------------------------------
// Per-layer vs silhouette, which is the whole point of having two modes.
//
// Two overlapping squares. Traced together they are one shape with one
// outline; traced separately, the lower square's hidden boundary shows up
// as well -- which is exactly the extra information per-layer mode exists
// to put on screen.

{
  const lower = grid([
    '####..',
    '####..',
    '####..',
    '####..',
    '......',
    '......',
  ]);
  const upper = grid([
    '......',
    '......',
    '..####',
    '..####',
    '..####',
    '..####',
  ]);
  const union = grid([
    '####..',
    '####..',
    '######',
    '######',
    '..####',
    '..####',
  ]);

  const silhouette = traceAlphaEdges(union.data, union.width, union.height).length;
  const perLayer = traceAlphaEdges(lower.data, lower.width, lower.height).length
    + traceAlphaEdges(upper.data, upper.width, upper.height).length;

  say(perLayer > silhouette,
    'per-layer tracing finds MORE outline than the silhouette, for overlapping layers',
    `silhouette ${silhouette}, per-layer ${perLayer}`);
  // 18, not the 16 a quick glance suggests: the two pixels in the step
  // where the squares meet ((4,2) reading up into transparency and (1,3)
  // reading down into it) are boundary too, which is exactly the kind of
  // notch a silhouette outline has to follow rather than cut across.
  eq(silhouette, 18, 'the union of the two squares has an 18-pixel outline');
  // 12 each: a 4x4 square is 16 pixels with a 2x2 interior.
  eq(perLayer, 24, 'the two squares outlined separately total 24 pixels');
}

// ---------------------------------------------------------------------------
// A single-channel alpha plane works too, not just RGBA.

{
  const plane = new Uint8ClampedArray([
    0, 0, 0,
    0, 255, 0,
    0, 0, 0,
  ]);
  eq(traceAlphaEdges(plane, 3, 3, { stride: 1 }).length, 1,
    'a stride-1 alpha plane traces the same as an RGBA buffer');
}

// ---------------------------------------------------------------------------
// Defensive: nothing to trace must not throw.

{
  eq(traceAlphaEdges(null, 4, 4).length, 0, 'a null buffer yields no contour');
  eq(traceAlphaEdges(new Uint8ClampedArray(0), 0, 0).length, 0,
    'a zero-sized buffer yields no contour');
  eq(traceAlphaEdgesInBounds(new Uint8ClampedArray(64), 4, 4, null).length, 0,
    'a missing bounds rectangle yields no contour');
}

console.log('\ncontour.js:\n');
let pass = 0;
for (const r of report) {
  console.log(`  ${r.ok ? 'ok  ' : 'FAIL'}  ${r.name}`);
  if (!r.ok && r.detail) console.log(`          ${r.detail}`);
  if (r.ok) pass++;
}
console.log(`\n${pass}/${report.length} checks passed`);
process.exit(report.every((r) => r.ok) ? 0 : 1);
