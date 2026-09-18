// PCreate's drawing arithmetic, verified headlessly against the real module.
//
// Every check here runs the SHIPPED functions against fixtures small enough
// to work out by hand, rather than re-implementing the algorithm and
// comparing two versions of the same mistake. The things being pinned down
// are the ones that look fine at a glance on pixel art and are wrong
// anyway: an outline thicker on one side than another, a rotation that
// drops a column, a free-angle rotation that quietly invents in-between
// colours, and a blend that reports success without producing a genuinely
// new shade.

import { strict as assert } from 'node:assert';
import {
  squareIndices, lineTexels, paintIndices, clearIndices,
  squareShape, circleShape, triangleShape, outlineOf,
  rotate90, flipPixels, rotateFree,
  regionBounds, extractRegion, blitRegion, offsetIndices,
  blendAt, midpointColor, samplePixel, sameColor,
  silhouetteIndices, shadowIndices, suggestShadowColor,
} from '../www/js/pixelops.js';

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

// A tiny fixture builder: one character per texel, '.' transparent and any
// other character a distinct opaque colour, so a picture can be written out
// in the test and read back the same way.
const PALETTE = {
  r: [220, 40, 40, 255],
  g: [40, 200, 90, 255],
  b: [40, 90, 220, 255],
  w: [255, 255, 255, 255],
  k: [0, 0, 0, 255],
  '.': [0, 0, 0, 0],
};

function fixture(rows) {
  const height = rows.length;
  const width = rows[0].length;
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let v = 0; v < height; v++) {
    for (let u = 0; u < width; u++) {
      const colour = PALETTE[rows[v][u]];
      if (!colour) throw new Error(`unknown fixture character "${rows[v][u]}"`);
      const o = (v * width + u) * 4;
      pixels[o] = colour[0];
      pixels[o + 1] = colour[1];
      pixels[o + 2] = colour[2];
      pixels[o + 3] = colour[3];
    }
  }
  return { pixels, width, height };
}

// Render an index set as ASCII, for checks that are far clearer as a
// picture than as a list of indices.
function renderSet(set, width, height, on = '#', off = '.') {
  const rows = [];
  for (let v = 0; v < height; v++) {
    let row = '';
    for (let u = 0; u < width; u++) row += set.has(v * width + u) ? on : off;
    rows.push(row);
  }
  return rows;
}

function blank(width, height) {
  return { pixels: new Uint8ClampedArray(width * height * 4), width, height };
}

// ---------------------------------------------------------------------------

section('The brush: square stamps, centred the same way every other brush in the app centres');

check('a 1x1 brush covers exactly the texel it was given', () => {
  const indices = squareIndices(5, 5, 1, 16, 16);
  assert.deepEqual(indices, [5 * 16 + 5]);
});

check('a 3x3 brush covers a full ring around its centre', () => {
  const indices = squareIndices(5, 5, 3, 16, 16);
  assert.equal(indices.length, 9);
  assert.ok(indices.includes(5 * 16 + 5), 'the centre itself must be covered');
  assert.ok(indices.includes(4 * 16 + 4), 'the up-left corner must be covered');
  assert.ok(indices.includes(6 * 16 + 6), 'the down-right corner must be covered');
});

check('an even brush biases down-and-right, matching CLayer and Px Pin', () => {
  const indices = squareIndices(5, 5, 2, 16, 16);
  assert.equal(indices.length, 4);
  assert.ok(indices.includes(5 * 16 + 5));
  assert.ok(indices.includes(6 * 16 + 6));
  assert.ok(!indices.includes(4 * 16 + 4), 'must not extend up-left of the touch point');
});

check('the largest brush is a full 10x10 and no larger', () => {
  assert.equal(squareIndices(20, 20, 10, 64, 64).length, 100);
});

check('a brush at the canvas edge is clipped, never wrapped to the other side', () => {
  const indices = squareIndices(0, 0, 3, 16, 16);
  // Only the 2x2 quadrant that is actually on the canvas survives.
  assert.equal(indices.length, 4);
  for (const index of indices) {
    const u = index % 16;
    assert.ok(u <= 1, `texel at u=${u} wrapped around the left edge`);
  }
});

section('Drag interpolation: a fast stroke stays unbroken');

check('a diagonal drag produces a step for every texel between the endpoints', () => {
  const run = lineTexels({ u: 0, v: 0 }, { u: 5, v: 5 });
  assert.equal(run.length, 5);
  assert.deepEqual(run[run.length - 1], { u: 5, v: 5 });
});

check('consecutive texels of an awkward-slope drag are always at least diagonally adjacent', () => {
  const run = lineTexels({ u: 2, v: 3 }, { u: 19, v: 9 });
  let previous = { u: 2, v: 3 };
  for (const texel of run) {
    const gap = Math.max(Math.abs(texel.u - previous.u), Math.abs(texel.v - previous.v));
    assert.ok(gap <= 1, `a gap of ${gap} texels would draw a dotted line`);
    previous = texel;
  }
});

check('a drag that never left its starting texel still stamps once', () => {
  assert.deepEqual(lineTexels({ u: 4, v: 4 }, { u: 4, v: 4 }), [{ u: 4, v: 4 }]);
});

section('Shapes: hard-edged by construction, in both Filled and Outline modes');

check('a filled square covers its whole drag box exactly', () => {
  const set = squareShape({ u: 2, v: 1 }, { u: 5, v: 4 }, 10, 10, true);
  assert.equal(set.size, 16); // 4x4
  assert.ok(set.has(1 * 10 + 2) && set.has(4 * 10 + 5));
});

check('a square outline is a one-texel ring with a genuinely empty middle', () => {
  const rows = renderSet(squareShape({ u: 1, v: 1 }, { u: 5, v: 5 }, 8, 8, false), 8, 8);
  assert.deepEqual(rows, [
    '........',
    '.#####..',
    '.#...#..',
    '.#...#..',
    '.#...#..',
    '.#####..',
    '........',
    '........',
  ]);
});

check('a filled circle is round, not a square with the corners nicked off', () => {
  const rows = renderSet(circleShape({ u: 0, v: 0 }, { u: 6, v: 6 }, 7, 7, true), 7, 7);
  assert.deepEqual(rows, [
    '..###..',
    '.#####.',
    '#######',
    '#######',
    '#######',
    '.#####.',
    '..###..',
  ]);
});

check('a circle outline is hollow, closed, and exactly one texel thick', () => {
  const rows = renderSet(circleShape({ u: 0, v: 0 }, { u: 6, v: 6 }, 7, 7, false), 7, 7);
  assert.deepEqual(rows, [
    '..###..',
    '.#...#.',
    '#.....#',
    '#.....#',
    '#.....#',
    '.#...#.',
    '..###..',
  ]);
});

check('a circle outline has no diagonal gap a fill could escape through', () => {
  // Every outline texel must have another outline texel among its eight
  // neighbours on each side it continues toward -- otherwise the ring looks
  // closed but is not, which matters because Select's own boundary uses the
  // same kind of ring.
  const set = circleShape({ u: 0, v: 0 }, { u: 10, v: 10 }, 11, 11, false);
  for (const index of set) {
    const u = index % 11;
    const v = (index - u) / 11;
    let neighbours = 0;
    for (let dv = -1; dv <= 1; dv++) {
      for (let du = -1; du <= 1; du++) {
        if (du === 0 && dv === 0) continue;
        if (set.has((v + dv) * 11 + (u + du))) neighbours++;
      }
    }
    assert.ok(neighbours >= 2, `outline texel (${u},${v}) has only ${neighbours} neighbours — the ring is broken`);
  }
});

check('a filled triangle narrows to an apex at the top and a full base at the bottom', () => {
  const rows = renderSet(triangleShape({ u: 0, v: 0 }, { u: 6, v: 4 }, 7, 5, true), 7, 5);
  assert.deepEqual(rows, [
    '...#...',
    '..###..',
    '.#####.',
    '.#####.',
    '#######',
  ]);
});

check('a triangle outline keeps its diagonal sides exactly one texel thick', () => {
  const rows = renderSet(triangleShape({ u: 0, v: 0 }, { u: 6, v: 4 }, 7, 5, false), 7, 5);
  assert.deepEqual(rows, [
    '...#...',
    '..#.#..',
    '.#...#.',
    '.#...#.',
    '#######',
  ]);
});

check('a triangle does not grow a two-texel needle above its apex', () => {
  // Sampling each row's TOP edge rather than its body gives both the apex
  // row and the one below it a sub-single-texel half-width, so the shape
  // comes out with a spike on it. Every row below the apex must be strictly
  // wider than the apex row.
  for (const boxHeight of [4, 6, 9, 12]) {
    const rows = renderSet(triangleShape({ u: 0, v: 0 }, { u: 12, v: boxHeight }, 13, boxHeight + 1, true), 13, boxHeight + 1);
    const widthOf = (row) => [...row].filter((c) => c === '#').length;
    // Not "the apex is exactly one texel" -- a short, wide triangle has a
    // genuinely blunt top and should. The defect being ruled out is the
    // apex row REPEATING itself before the sides start widening.
    assert.ok(
      widthOf(rows[1]) > widthOf(rows[0]),
      `rows 0 and 1 are both ${widthOf(rows[0])} texels wide at height ${boxHeight + 1} — that is a needle`
    );
    assert.equal(widthOf(rows[rows.length - 1]), 13, 'the base row should span the full drag box');
  }
});

for (const [name, shape] of [['square', squareShape], ['circle', circleShape], ['triangle', triangleShape]]) {
  check(`an ${name} outline is always a strict subset of the same ${name} filled`, () => {
    const a = { u: 1, v: 2 };
    const b = { u: 12, v: 9 };
    const filled = shape(a, b, 20, 20, true);
    const outline = shape(a, b, 20, 20, false);
    for (const index of outline) {
      assert.ok(filled.has(index), `outline texel ${index} is not inside the filled shape`);
    }
    assert.ok(outline.size < filled.size, 'an outline that equals its fill has no interior');
  });
}

check('a shape dragged hard against the canvas edge keeps that side of its outline', () => {
  // The left column is at u=0, so its left neighbour is off-canvas. That
  // must still count as an edge, or the shape would lose a whole side.
  const rows = renderSet(squareShape({ u: 0, v: 0 }, { u: 3, v: 3 }, 4, 4, false), 4, 4);
  assert.deepEqual(rows, ['####', '#..#', '#..#', '####']);
});

check('a shape dragged to a single texel still produces that texel', () => {
  assert.equal(circleShape({ u: 3, v: 3 }, { u: 3, v: 3 }, 8, 8, true).size, 1);
  assert.equal(triangleShape({ u: 3, v: 3 }, { u: 3, v: 3 }, 8, 8, true).size, 1);
});

check('a drag in any direction produces the same shape as the reverse drag', () => {
  const forward = circleShape({ u: 2, v: 2 }, { u: 9, v: 7 }, 12, 12, true);
  const backward = circleShape({ u: 9, v: 7 }, { u: 2, v: 2 }, 12, 12, true);
  assert.deepEqual([...forward].sort((x, y) => x - y), [...backward].sort((x, y) => x - y));
});

section('Painting and erasing');

check('painting writes the exact colour asked for, with no blending against what was there', () => {
  const { pixels, width } = fixture(['rr', 'rr']);
  paintIndices(pixels, [0, 3], [40, 90, 220, 255]);
  assert.deepEqual(samplePixel(pixels, width, 0, 0), [40, 90, 220, 255]);
  assert.deepEqual(samplePixel(pixels, width, 1, 0), [220, 40, 40, 255], 'an untouched texel must not change');
});

check('erasing returns a texel to fully transparent, not to white or a dimmed colour', () => {
  const { pixels, width } = fixture(['rr', 'rr']);
  clearIndices(pixels, [0]);
  assert.deepEqual(samplePixel(pixels, width, 0, 0), [0, 0, 0, 0]);
});

section('Rotation');

check('a quarter turn swaps a non-square canvas\'s width and height', () => {
  const { pixels, width, height } = fixture(['rgb.', '....']); // 4x2
  const out = rotate90(pixels, width, height, 1);
  assert.equal(out.width, 2);
  assert.equal(out.height, 4);
});

check('a quarter turn clockwise puts the top-left corner at the top-right', () => {
  const { pixels, width, height } = fixture(['rg', 'bw']);
  const out = rotate90(pixels, width, height, 1);
  // r g      b r
  // b w  ->  w g
  assert.deepEqual(samplePixel(out.pixels, out.width, 1, 0), PALETTE.r);
  assert.deepEqual(samplePixel(out.pixels, out.width, 0, 0), PALETTE.b);
  assert.deepEqual(samplePixel(out.pixels, out.width, 1, 1), PALETTE.g);
});

check('four quarter turns return the original picture byte for byte', () => {
  const { pixels, width, height } = fixture(['rgb.', 'wk.r', '.grb']);
  let current = { pixels, width, height };
  for (let i = 0; i < 4; i++) current = rotate90(current.pixels, current.width, current.height, 1);
  assert.equal(current.width, width);
  assert.equal(current.height, height);
  assert.deepEqual([...current.pixels], [...pixels]);
});

check('no texel is lost by a quarter turn of an awkward, non-square canvas', () => {
  const { pixels, width, height } = fixture(['rgbwk', '.....', 'kwbgr']);
  const out = rotate90(pixels, width, height, 1);
  const before = silhouetteIndices(pixels, width, height).size;
  const after = silhouetteIndices(out.pixels, out.width, out.height).size;
  assert.equal(after, before, 'a rotation dropped or duplicated opaque texels');
});

section('Free-angle rotation stays crisp: nearest-neighbour, never interpolated');

check('a free 90-degree rotation agrees with the exact quarter-turn on a square canvas', () => {
  const { pixels, width, height } = fixture(['rg..', 'bw..', '....', '....']);
  const exact = rotate90(pixels, width, height, 1);
  const free = rotateFree(pixels, width, height, 90);
  assert.deepEqual([...free.pixels], [...exact.pixels]);
});

check('free rotation invents no colour that was not already in the source', () => {
  // The whole point of nearest-neighbour here. A smoothed rotation would
  // produce blended edge colours; every output texel must be one of the
  // inputs, exactly.
  const { pixels, width, height } = fixture([
    '..rrrr..',
    '.rrrrrr.',
    'rrrrrrrr',
    'rrggggrr',
    'rrggggrr',
    'rrrrrrrr',
    '.rrrrrr.',
    '..rrrr..',
  ]);
  const allowed = [PALETTE.r, PALETTE.g, PALETTE['.']];
  const out = rotateFree(pixels, width, height, 37);
  for (let index = 0; index < out.width * out.height; index++) {
    const u = index % out.width;
    const v = (index - u) / out.width;
    const colour = samplePixel(out.pixels, out.width, u, v);
    assert.ok(
      allowed.some((candidate) => sameColor(candidate, colour)),
      `rotation produced rgba(${colour.join(',')}), which is not a source colour`
    );
  }
});

check('free rotation produces no half-transparent edge texels', () => {
  const { pixels, width, height } = fixture(['rrrr', 'rrrr', 'rrrr', 'rrrr']);
  const out = rotateFree(pixels, width, height, 22);
  for (let i = 3; i < out.pixels.length; i += 4) {
    assert.ok(out.pixels[i] === 0 || out.pixels[i] === 255, `alpha ${out.pixels[i]} is a soft edge`);
  }
});

check('an expanded frame is always big enough that nothing is CLIPPED by its edges', () => {
  // The guarantee expanding can actually make. It is not "no texel is
  // lost": a nearest-neighbour rotation at an angle like 45 degrees maps
  // the source lattice onto the output lattice unevenly, so some source
  // texels have no output texel that rounds to them no matter how large
  // the frame is. That is inherent to sampling without interpolation and
  // is the trade this app makes everywhere -- crisp over complete.
  //
  // What the frame size IS responsible for is the rotated picture fitting
  // inside it. A clear transparent margin all the way around proves it
  // does; content touching the border would mean it had been cut off.
  const { pixels, width, height } = fixture(['rrrr', 'rrrr', 'rrrr', 'rrrr']);
  for (const degrees of [0, 15, 30, 45, 60, 90, 137, 225, 315]) {
    const out = rotateFree(pixels, width, height, degrees, true);
    for (let u = 0; u < out.width; u++) {
      assert.equal(out.pixels[(0 * out.width + u) * 4 + 3], 0, `content touches the top edge at ${degrees} degrees`);
      assert.equal(out.pixels[((out.height - 1) * out.width + u) * 4 + 3], 0, `content touches the bottom edge at ${degrees} degrees`);
    }
    for (let v = 0; v < out.height; v++) {
      assert.equal(out.pixels[(v * out.width) * 4 + 3], 0, `content touches the left edge at ${degrees} degrees`);
      assert.equal(out.pixels[(v * out.width + out.width - 1) * 4 + 3], 0, `content touches the right edge at ${degrees} degrees`);
    }
  }
});

check('a same-size free rotation runs off its own edges, which is what expanding is for', () => {
  const { pixels, width, height } = fixture(['rrrr', 'rrrr', 'rrrr', 'rrrr']);
  const clipped = rotateFree(pixels, width, height, 45, false);
  const expanded = rotateFree(pixels, width, height, 45, true);
  assert.equal(clipped.width, width, 'a non-expanded rotation must keep the original dimensions');
  assert.ok(expanded.width > clipped.width, 'the expanded frame should be larger');
  // Content sitting ON the border is the signature of having been cut off
  // by it -- the expanded version is checked for the opposite above.
  let touchesBorder = false;
  for (let u = 0; u < clipped.width; u++) {
    if (clipped.pixels[u * 4 + 3] !== 0) touchesBorder = true;
  }
  assert.ok(touchesBorder, 'a square rotated 45 degrees should overflow its own bounding box');
});

check('exact quarter turns go through rotate90, which IS lossless, rather than the sampler', () => {
  // The reason PCreate wires its 90-degree buttons to rotate90 and only the
  // free-angle slider to rotateFree: the sampler is lossy at odd angles by
  // nature, so the common case must not go through it.
  const { pixels, width, height } = fixture(['rgbw', 'kr.g', 'bwkr', '.gbw']);
  const turned = rotate90(pixels, width, height, 1);
  const back = rotate90(turned.pixels, turned.width, turned.height, 3);
  assert.deepEqual([...back.pixels], [...pixels], 'a quarter turn and back must be byte-identical');
});

section('Flip: four named directions, two real transforms');

check('a horizontal flip mirrors left to right', () => {
  const { pixels, width, height } = fixture(['rg.', '...']);
  const out = flipPixels(pixels, width, height, 'horizontal');
  assert.deepEqual(samplePixel(out, width, 2, 0), PALETTE.r);
  assert.deepEqual(samplePixel(out, width, 1, 0), PALETTE.g);
});

check('a vertical flip mirrors top to bottom', () => {
  const { pixels, width, height } = fixture(['rr', '..', 'gg']);
  const out = flipPixels(pixels, width, height, 'vertical');
  assert.deepEqual(samplePixel(out, width, 0, 0), PALETTE.g);
  assert.deepEqual(samplePixel(out, width, 0, 2), PALETTE.r);
});

check('flipping twice on the same axis is the identity -- which is why Up and Down cannot differ', () => {
  const { pixels, width, height } = fixture(['rgb', 'wk.', '.rg']);
  const once = flipPixels(pixels, width, height, 'vertical');
  const twice = flipPixels(once, width, height, 'vertical');
  assert.deepEqual([...twice], [...pixels]);
});

check('the two axes are genuinely different transforms, not the same one twice', () => {
  const { pixels, width, height } = fixture(['rg', 'b.']);
  const horizontal = flipPixels(pixels, width, height, 'horizontal');
  const vertical = flipPixels(pixels, width, height, 'vertical');
  assert.notDeepEqual([...horizontal], [...vertical]);
});

section('Selections: lifting an irregular region and putting it back down');

check('bounds are the tight box around the selected texels, not the whole canvas', () => {
  const indices = new Set([2 * 10 + 3, 2 * 10 + 4, 3 * 10 + 3]);
  assert.deepEqual(regionBounds(indices, 10), { x: 3, y: 2, width: 2, height: 2 });
});

check('an empty selection has no bounds rather than a zero-size box', () => {
  assert.equal(regionBounds(new Set(), 10), null);
});

check('lifting a lasso carries its real shape, not its bounding rectangle', () => {
  const { pixels, width } = fixture(['rrr', 'rrr', 'rrr']);
  // An L-shape inside a 2x2 box: three of the four corners.
  const indices = new Set([0, 1, width]);
  const bounds = regionBounds(indices, width);
  const region = extractRegion(pixels, width, indices, bounds);
  assert.deepEqual(samplePixel(region, bounds.width, 0, 0), PALETTE.r);
  assert.deepEqual(samplePixel(region, bounds.width, 1, 0), PALETTE.r);
  assert.deepEqual(samplePixel(region, bounds.width, 0, 1), PALETTE.r);
  assert.deepEqual(
    samplePixel(region, bounds.width, 1, 1), PALETTE['.'],
    'the unselected corner of the bounding box must come out transparent'
  );
});

check('stamping a region down skips its transparent texels rather than punching holes', () => {
  const target = fixture(['ggg', 'ggg', 'ggg']);
  const stamp = fixture(['r.', '.r']);
  blitRegion(target.pixels, target.width, target.height, stamp.pixels, 2, 2, 0, 0);
  assert.deepEqual(samplePixel(target.pixels, target.width, 0, 0), PALETTE.r);
  assert.deepEqual(
    samplePixel(target.pixels, target.width, 1, 0), PALETTE.g,
    'a transparent texel in the region erased what was underneath it'
  );
  assert.deepEqual(samplePixel(target.pixels, target.width, 1, 1), PALETTE.r);
});

check('stamping reports exactly the texels the region landed on', () => {
  const target = blank(4, 4);
  const stamp = fixture(['rr', 'rr']);
  const landed = blitRegion(target.pixels, target.width, target.height, stamp.pixels, 2, 2, 1, 1);
  assert.deepEqual(renderSet(landed, 4, 4), ['....', '.##.', '.##.', '....']);
});

check('a region stamped partly off-canvas keeps only the part that fits', () => {
  const target = blank(4, 4);
  const stamp = fixture(['rr', 'rr']);
  // Placed at the bottom-right corner, only the region's own top-left texel
  // is still on the canvas.
  const landed = blitRegion(target.pixels, target.width, target.height, stamp.pixels, 2, 2, 3, 3);
  assert.equal(landed.size, 1, 'only the one in-bounds texel should land');
  assert.ok(landed.has(3 * 4 + 3));
});

check('offsetting a selection drops the texels that would leave the canvas', () => {
  const indices = new Set([0, 1, 2]);
  const moved = offsetIndices(indices, 4, 4, 2, 0);
  assert.equal(moved.size, 2, 'the texel pushed past the right edge should be dropped, not wrapped');
});

section('Blend Colors: one new texel, or an honest refusal');

check('two genuinely different neighbours produce their exact midpoint', () => {
  const { pixels, width, height } = fixture(['rb']);
  const result = blendAt(pixels, width, height, 0, 0, 1, 0);
  assert.ok(result.ok, 'a red/blue pair should be blendable');
  assert.deepEqual(result.color, midpointColor(PALETTE.r, PALETTE.b));
  assert.deepEqual(result.color, [130, 65, 130, 255]);
});

check('two identical neighbours blend to nothing, and say so', () => {
  const { pixels, width, height } = fixture(['rr']);
  const result = blendAt(pixels, width, height, 0, 0, 1, 0);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'identical');
});

check('neighbours one unit apart are refused too -- the midpoint would not be a NEW shade', () => {
  // The case that a plain equality test would wave through: 10 and 11
  // average to 11 (rounded), which is just the neighbour again.
  const width = 2;
  const pixels = new Uint8ClampedArray(8);
  pixels.set([10, 10, 10, 255], 0);
  pixels.set([11, 11, 11, 255], 4);
  const result = blendAt(pixels, width, 1, 0, 0, 1, 0);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no-distinct-midpoint');
});

check('a midpoint that IS distinct from both is accepted, even for a close pair', () => {
  const width = 2;
  const pixels = new Uint8ClampedArray(8);
  pixels.set([10, 10, 10, 255], 0);
  pixels.set([14, 14, 14, 255], 4);
  const result = blendAt(pixels, width, 1, 0, 0, 1, 0);
  assert.ok(result.ok);
  assert.deepEqual(result.color, [12, 12, 12, 255]);
});

check('blending an opaque texel against an empty one gives a real half-alpha midpoint', () => {
  const { pixels, width, height } = fixture(['r.']);
  const result = blendAt(pixels, width, height, 0, 0, 1, 0);
  assert.ok(result.ok);
  assert.equal(result.color[3], 128);
});

check('a neighbour off the edge of the canvas is refused rather than read as transparent', () => {
  const { pixels, width, height } = fixture(['rb']);
  assert.equal(blendAt(pixels, width, height, 0, 0, -1, 0).ok, false);
  assert.equal(blendAt(pixels, width, height, 0, 0, -1, 0).reason, 'out-of-bounds');
});

check('the blend never writes anything itself -- it reports, the caller commits', () => {
  const { pixels, width, height } = fixture(['rb']);
  const before = [...pixels];
  blendAt(pixels, width, height, 0, 0, 1, 0);
  assert.deepEqual([...pixels], before);
});

section('Shadow: behind the artwork, never over it');

check('the silhouette is every texel with any alpha at all', () => {
  const { pixels, width, height } = fixture(['r.r', '.g.']);
  assert.equal(silhouetteIndices(pixels, width, height).size, 3);
});

check('a shadow lands offset from the art in the light\'s direction', () => {
  const { pixels, width, height } = fixture(['r...', '....', '....', '....']);
  const shadow = shadowIndices(pixels, width, height, 1, 1);
  assert.deepEqual(renderSet(shadow, 4, 4), ['....', '.#..', '....', '....']);
});

check('a shadow never covers the artwork casting it', () => {
  const { pixels, width, height } = fixture(['rr..', 'rr..', '....', '....']);
  const shadow = shadowIndices(pixels, width, height, 1, 1);
  const art = silhouetteIndices(pixels, width, height);
  for (const index of shadow) {
    assert.ok(!art.has(index), `shadow texel ${index} landed on top of the art`);
  }
});

check('a shadow pushed past the canvas edge simply loses those texels', () => {
  const { pixels, width, height } = fixture(['...r', '....']);
  assert.equal(shadowIndices(pixels, width, height, 2, 0).size, 0);
});

check('a shadow restricted to a selection ignores art outside it', () => {
  const { pixels, width, height } = fixture(['r.r.', '....', '....', '....']);
  const onlyTheLeftOne = new Set([0]);
  const shadow = shadowIndices(pixels, width, height, 0, 1, onlyTheLeftOne);
  assert.deepEqual(renderSet(shadow, 4, 4), ['....', '#...', '....', '....']);
});

check('the suggested shadow colour is a darker relative of what is on the canvas', () => {
  const { pixels, width, height } = fixture(['rr', 'rr']);
  const shade = suggestShadowColor(pixels, width, height);
  const luminance = (c) => c[0] * 0.299 + c[1] * 0.587 + c[2] * 0.114;
  assert.ok(luminance(shade) < luminance(PALETTE.r), 'the shadow should be darker than the art');
  assert.equal(shade[3], 255, 'the suggested shadow should be fully opaque');
});

check('the suggested shadow colour is less saturated than the art it came from', () => {
  const { pixels, width, height } = fixture(['rr', 'rr']);
  const shade = suggestShadowColor(pixels, width, height);
  const spread = (c) => Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2]);
  // Compared against the source scaled to the same brightness, so this
  // measures desaturation rather than just the darkening.
  const scale = Math.max(shade[0], shade[1], shade[2]) / Math.max(...PALETTE.r.slice(0, 3));
  assert.ok(spread(shade) < spread(PALETTE.r.slice(0, 3).map((c) => c * scale)) + 1e-9);
});

check('an empty canvas suggests no shadow colour rather than a default grey', () => {
  const { pixels, width, height } = blank(4, 4);
  assert.equal(suggestShadowColor(pixels, width, height), null);
});

section('outlineOf, used by all three shapes, on its own');

check('a solid block\'s outline is its border ring', () => {
  const inside = new Set();
  for (let v = 1; v <= 3; v++) for (let u = 1; u <= 3; u++) inside.add(v * 6 + u);
  const rows = renderSet(outlineOf(inside, 6, 6), 6, 6);
  assert.deepEqual(rows, ['......', '.###..', '.#.#..', '.###..', '......', '......']);
});

check('a shape one texel thick is entirely its own outline', () => {
  const inside = new Set([1 * 6 + 1, 1 * 6 + 2, 1 * 6 + 3]);
  assert.equal(outlineOf(inside, 6, 6).size, 3);
});

console.log(results.join('\n'));
console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
