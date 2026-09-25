// CLayer's deterministic core, verified headlessly against the real
// module: the flood fill that decides "is this boundary actually closed"
// and the mask/crop math that turns a fill into extracted pixels.
//
// No DOM is touched by any of this -- floodFillFrom and
// buildExtractedPixels are plain functions over typed arrays and a Set of
// indices, exactly like spread.js's pure geometry, so the whole algorithm
// runs in Node against the shipped code rather than a re-implementation
// of it.

import { strict as assert } from 'node:assert';
import { floodFillFrom, buildExtractedPixels } from '../www/js/clayer.js';
import { contentBounds, cropPixels } from '../www/js/importer.js';

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

// A boundary Set from an ASCII map: '#' is a boundary pixel, anything else
// is open. This is the whole point of testing the raster algorithm rather
// than a description of it -- the map IS the picture, pixel for pixel.
function boundaryFromMap(rows) {
  const height = rows.length;
  const width = rows[0].length;
  const boundary = new Set();
  for (let v = 0; v < height; v++) {
    for (let u = 0; u < width; u++) {
      if (rows[v][u] === '#') boundary.add(v * width + u);
    }
  }
  return { boundary, width, height };
}

// ---------------------------------------------------------------------------

section('A genuinely closed loop');

{
  // 7x7, an 8-connected ring with a plain open interior.
  const rows = [
    '#######',
    '#.....#',
    '#.###.#',
    '#.#.#.#',
    '#.###.#',
    '#.....#',
    '#######',
  ];
  const { boundary, width, height } = boundaryFromMap(rows);

  check('the outer ring encloses its interior ring without leaking', () => {
    const result = floodFillFrom(width, height, boundary, 1, 1);
    assert.equal(result.ok, true, 'a closed ring was reported as leaking');
    assert.equal(result.leaked, false);
    assert.equal(result.onBoundary, false);
    // Everything between the two rings: the 5x5 minus its own 3x3 ring.
    assert.equal(result.filled.size, 16, `expected 16 px between the rings, got ${result.filled.size}`);
  });

  check('the innermost pocket is its own separate closed region', () => {
    const result = floodFillFrom(width, height, boundary, 3, 3);
    assert.equal(result.ok, true, 'the inner pocket was reported as leaking');
    assert.equal(result.filled.size, 1, `expected the single centre pixel, got ${result.filled.size}`);
    assert.ok(result.filled.has(3 * width + 3));
  });

  check('tapping exactly on the line is reported as such, not filled', () => {
    const result = floodFillFrom(width, height, boundary, 0, 0);
    assert.equal(result.ok, false);
    assert.equal(result.onBoundary, true);
    assert.equal(result.leaked, false);
  });

  check('the same boundary, same tap, gives the same answer every time', () => {
    const a = floodFillFrom(width, height, boundary, 1, 1);
    const b = floodFillFrom(width, height, boundary, 1, 1);
    assert.deepEqual([...a.filled].sort(), [...b.filled].sort());
  });
}

section('A gap in the line -- the case Fill has to catch, not paper over');

{
  // The same ring with one pixel of the top edge missing: (3,0) is open.
  const rows = [
    '###.###',
    '#.....#',
    '#.###.#',
    '#.#.#.#',
    '#.###.#',
    '#.....#',
    '#######',
  ];
  const { boundary, width, height } = boundaryFromMap(rows);

  check('a one-pixel gap lets the fill reach the border, and it is reported', () => {
    const result = floodFillFrom(width, height, boundary, 1, 1);
    assert.equal(result.ok, false, 'a gapped ring was filled as if it were closed');
    assert.equal(result.leaked, true);
    assert.equal(result.onBoundary, false);
    assert.equal(result.filled, undefined, 'a leaked result should not carry a fill region');
  });

  check('a single missing wall pixel leaks the whole interior, caught before covering the canvas', () => {
    // A large open field around a 5x5 box, otherwise fully sealed except
    // for ONE missing pixel in its left wall (row 30, column 28). Tapped
    // from a DIFFERENT row than the gap, to prove a hole anywhere in the
    // loop compromises the whole enclosure, not just the row it sits on.
    // The fill must also bail out at the image border long before it could
    // have visited every one of the field's pixels, or the "rather than
    // filling the entire canvas" requirement is not actually met.
    const big = [];
    const W = 61;
    const H = 61;
    for (let v = 0; v < H; v++) big.push('.'.repeat(W));
    const put = (v, s) => { big[v] = big[v].slice(0, 28) + s + big[v].slice(28 + s.length); };
    put(28, '#####');
    put(29, '#...#');
    put(30, '....#'); // the left wall's pixel at column 28 is missing here
    put(31, '#...#');
    put(32, '#####');
    const scene = boundaryFromMap(big);
    const result = floodFillFrom(scene.width, scene.height, scene.boundary, 30, 29);
    assert.equal(result.ok, false, 'a box with a real gap in its wall was not caught');
    assert.equal(result.leaked, true);
  });
}

section('Tapping in open space, nowhere near any loop');

{
  const rows = [
    '.........',
    '..#####..',
    '..#...#..',
    '..#...#..',
    '..#...#..',
    '..#####..',
    '.........',
  ];
  const { boundary, width, height } = boundaryFromMap(rows);

  check('a tap outside every loop leaks to the border and is reported', () => {
    const result = floodFillFrom(width, height, boundary, 0, 0);
    assert.equal(result.ok, false);
    assert.equal(result.leaked, true);
  });

  check('the same picture still fills correctly INSIDE the loop', () => {
    const result = floodFillFrom(width, height, boundary, 3, 3);
    assert.equal(result.ok, true);
    assert.equal(result.filled.size, 9, `expected the 3x3 interior, got ${result.filled.size}`);
  });
}

section('Diagonally-touching boundary pixels still seal (the airtight case)');

{
  // A diamond made of pixels that only touch each other corner-to-corner.
  // This is the shape a freehand diagonal brush stroke actually produces,
  // and it is the case that would leak if the FILL were allowed to move
  // diagonally -- it must not, and this proves it does not.
  const rows = [
    '..#..',
    '.#.#.',
    '#...#',
    '.#.#.',
    '..#..',
  ];
  const { boundary, width, height } = boundaryFromMap(rows);

  check('a diagonal diamond boundary seals a 4-connected fill', () => {
    const result = floodFillFrom(width, height, boundary, 2, 2);
    assert.equal(result.ok, true, 'a diagonally-connected boundary leaked');
    // The open interior: (2,1),(1,2),(2,2),(3,2),(2,3) -- a plus shape.
    assert.equal(result.filled.size, 5, `expected 5 interior px, got ${result.filled.size}`);
  });
}

section('The extraction: mask, crop, and no resampling');

{
  // A 6x4 source with a distinct value in every channel of every pixel, so
  // any mixing, resampling or off-by-one copy would change a value that a
  // byte-for-byte comparison would catch.
  const width = 6;
  const height = 4;
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    pixels[i * 4] = (i * 7) % 256;
    pixels[i * 4 + 1] = (i * 13) % 256;
    pixels[i * 4 + 2] = (i * 19) % 256;
    pixels[i * 4 + 3] = 255;
  }

  // Fill a 2x2 block at (2,1)-(3,2).
  const fillMask = new Set([
    1 * width + 2, 1 * width + 3,
    2 * width + 2, 2 * width + 3,
  ]);

  check('masked pixels are copied byte-for-byte from the source', () => {
    const masked = buildExtractedPixels(pixels, width, height, fillMask);
    for (const index of fillMask) {
      const o = index * 4;
      assert.equal(masked[o], pixels[o]);
      assert.equal(masked[o + 1], pixels[o + 1]);
      assert.equal(masked[o + 2], pixels[o + 2]);
      assert.equal(masked[o + 3], pixels[o + 3]);
    }
  });

  check('everything outside the fill is fully transparent, not dimmed or blended', () => {
    const masked = buildExtractedPixels(pixels, width, height, fillMask);
    for (let i = 0; i < width * height; i++) {
      if (fillMask.has(i)) continue;
      const o = i * 4;
      assert.equal(masked[o], 0);
      assert.equal(masked[o + 1], 0);
      assert.equal(masked[o + 2], 0);
      assert.equal(masked[o + 3], 0, `texel ${i} outside the fill is not transparent`);
    }
  });

  check('the crop is exactly the fill\'s bounding box, no wider', () => {
    const masked = buildExtractedPixels(pixels, width, height, fillMask);
    const bounds = contentBounds(masked, width, height);
    assert.deepEqual(bounds, { x: 2, y: 1, width: 2, height: 2 });
    const cropped = cropPixels(masked, width, bounds);
    assert.equal(cropped.length, 2 * 2 * 4);
    // Cropped (0,0) is source (2,1); cropped (1,1) is source (3,2).
    const srcA = (1 * width + 2) * 4;
    const srcB = (2 * width + 3) * 4;
    assert.equal(cropped[0], pixels[srcA]);
    assert.equal(cropped[1], pixels[srcA + 1]);
    assert.equal(cropped[2], pixels[srcA + 2]);
    assert.equal(cropped[(1 * 2 + 1) * 4], pixels[srcB]);
    assert.equal(cropped[(1 * 2 + 1) * 4 + 1], pixels[srcB + 1]);
    assert.equal(cropped[(1 * 2 + 1) * 4 + 2], pixels[srcB + 2]);
  });

  check('filling a region that is transparent in the source has no content bounds', () => {
    const blank = new Uint8ClampedArray(width * height * 4); // all zero: fully transparent
    const masked = buildExtractedPixels(blank, width, height, fillMask);
    assert.equal(contentBounds(masked, width, height), null);
  });
}

console.log(results.join('\n'));
console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
