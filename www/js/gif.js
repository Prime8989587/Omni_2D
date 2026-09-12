// A GIF89a encoder, written out by hand.
//
// There is no bundler here and no network at runtime -- the app is plain
// ES modules served straight into a WebView -- so an npm GIF library is
// not an option, and neither is a CDN. This is the format written
// directly: palette, LZW, and the block structure the spec lays out.
//
// It suits pixel art especially well. GIF is a palette format capped at
// 256 colours, which is a real constraint for photographs and no
// constraint at all for the kind of artwork this app exists to animate --
// so the common case here is an EXACT palette, with every colour landing
// in the file unchanged rather than approximated.

// Anything below this is written as the transparent index; anything at or
// above it becomes an opaque palette colour. GIF has no partial
// transparency to blend into, so this is a threshold rather than a ramp.
const ALPHA_THRESHOLD = 128;

// One slot of the 256 is spent on transparency, leaving this many for
// actual colours.
const MAX_COLORS = 255;

// A growable byte sink. Building a multi-megabyte file by pushing onto a
// plain array and converting at the end is measurably slower and spikes
// memory; this doubles a typed array instead.
class ByteWriter {
  constructor(capacity = 1 << 16) {
    this.bytes = new Uint8Array(capacity);
    this.length = 0;
  }

  _room(extra) {
    if (this.length + extra <= this.bytes.length) return;
    let size = this.bytes.length * 2;
    while (size < this.length + extra) size *= 2;
    const grown = new Uint8Array(size);
    grown.set(this.bytes.subarray(0, this.length));
    this.bytes = grown;
  }

  byte(value) {
    this._room(1);
    this.bytes[this.length++] = value & 0xFF;
  }

  // GIF stores multi-byte numbers little-endian throughout.
  short(value) {
    this.byte(value);
    this.byte(value >> 8);
  }

  string(text) {
    for (let i = 0; i < text.length; i++) this.byte(text.charCodeAt(i));
  }

  raw(source, from = 0, count = source.length - from) {
    this._room(count);
    this.bytes.set(source.subarray(from, from + count), this.length);
    this.length += count;
  }

  done() {
    return this.bytes.slice(0, this.length);
  }
}

// ---------------------------------------------------------------------------
// Palette

function packRgb(r, g, b) {
  return (r << 16) | (g << 8) | b;
}

// Every distinct opaque colour across every frame, with how often each
// occurs -- the counts only matter if there turn out to be too many and
// the set has to be reduced.
function collectColors(frames) {
  const counts = new Map();
  for (const frame of frames) {
    for (let i = 0; i < frame.length; i += 4) {
      if (frame[i + 3] < ALPHA_THRESHOLD) continue;
      const key = packRgb(frame[i], frame[i + 1], frame[i + 2]);
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  return counts;
}

// Median cut, for the rare artwork that really does carry more than 255
// colours. Repeatedly split the box with the widest channel spread at that
// channel's median, then take each surviving box's average as one palette
// entry. Chosen over a plain popularity count because popularity drops
// whole regions of colour space when a large flat area dominates.
function medianCut(counts, wanted) {
  const entries = [...counts.keys()].map((key) => ({
    r: (key >> 16) & 0xFF, g: (key >> 8) & 0xFF, b: key & 0xFF,
    n: counts.get(key),
  }));

  let boxes = [entries];
  while (boxes.length < wanted) {
    // Split the box with the widest single-channel spread; if every box is
    // already a single colour there is nothing left to divide.
    let bestIndex = -1;
    let bestSpread = 0;
    let bestChannel = 'r';
    for (let i = 0; i < boxes.length; i++) {
      if (boxes[i].length < 2) continue;
      for (const channel of ['r', 'g', 'b']) {
        let low = 255;
        let high = 0;
        for (const e of boxes[i]) {
          if (e[channel] < low) low = e[channel];
          if (e[channel] > high) high = e[channel];
        }
        if (high - low > bestSpread) {
          bestSpread = high - low;
          bestIndex = i;
          bestChannel = channel;
        }
      }
    }
    if (bestIndex < 0) break;

    const box = boxes[bestIndex].slice().sort((a, b) => a[bestChannel] - b[bestChannel]);
    const half = box.length >> 1;
    boxes.splice(bestIndex, 1, box.slice(0, half), box.slice(half));
  }

  return boxes.filter((box) => box.length > 0).map((box) => {
    let r = 0;
    let g = 0;
    let b = 0;
    let n = 0;
    for (const e of box) { r += e.r * e.n; g += e.g * e.n; b += e.b * e.n; n += e.n; }
    return { r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n) };
  });
}

// The palette, plus the index reserved for transparency. Exact whenever
// the artwork allows it, which for pixel art is nearly always.
function buildPalette(frames) {
  const counts = collectColors(frames);
  const exact = counts.size <= MAX_COLORS;
  const colors = exact
    ? [...counts.keys()].map((key) => ({
      r: (key >> 16) & 0xFF, g: (key >> 8) & 0xFF, b: key & 0xFF,
    }))
    : medianCut(counts, MAX_COLORS);

  // The transparent entry sits immediately after the real colours, and the
  // table is then padded to a power of two because the format's size field
  // only expresses those.
  const transparentIndex = colors.length;
  let size = 2;
  while (size < colors.length + 1) size *= 2;

  return { colors, transparentIndex, size, exact };
}

// A colour to its palette index. Exact palettes look straight up; reduced
// ones search, but only once per distinct colour rather than per pixel --
// the cache is what keeps that from being the expensive part of an export.
function indexer(palette) {
  const cache = new Map();
  if (palette.exact) {
    palette.colors.forEach((c, i) => cache.set(packRgb(c.r, c.g, c.b), i));
    return (key) => cache.get(key);
  }
  return (key) => {
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    const r = (key >> 16) & 0xFF;
    const g = (key >> 8) & 0xFF;
    const b = key & 0xFF;
    let best = 0;
    let bestDistance = Infinity;
    for (let i = 0; i < palette.colors.length; i++) {
      const c = palette.colors[i];
      // Squared distance is enough to rank, and skips a square root per
      // candidate colour.
      const d = (c.r - r) ** 2 + (c.g - g) ** 2 + (c.b - b) ** 2;
      if (d < bestDistance) { bestDistance = d; best = i; }
    }
    cache.set(key, best);
    return best;
  };
}

function toIndices(frame, palette, lookup) {
  const out = new Uint8Array(frame.length / 4);
  for (let i = 0, p = 0; i < frame.length; i += 4, p++) {
    if (frame[i + 3] < ALPHA_THRESHOLD) {
      out[p] = palette.transparentIndex;
      continue;
    }
    out[p] = lookup(packRgb(frame[i], frame[i + 1], frame[i + 2]));
  }
  return out;
}

// ---------------------------------------------------------------------------
// LZW

// GIF's variable-width LZW. The one thing that has to be exactly right is
// WHEN the code width grows, and it is subtler than it looks: the DECODER
// learns each dictionary entry one code later than the encoder creates it,
// because it cannot know the entry's last symbol until the following code
// arrives. So the two are permanently one entry out of step, and an
// encoder that widens when its own next code reaches 1 << codeSize widens
// one code too early -- every later code is then read at the wrong width
// and the image decodes to noise from that point on. Written the naive
// way first, this produced a file Chromium rejected outright with
// "unexpected end of image"; the stream decoded 22 of 32 indices and the
// first wrong one was exactly where the width diverged.
//
// Allowing for the skew, the encoder widens one step later: when its next
// code EXCEEDS 1 << codeSize, which is the moment the decoder's own next
// code reaches it.
function lzwEncode(indices, minCodeSize) {
  const clearCode = 1 << minCodeSize;
  const endCode = clearCode + 1;

  const out = new ByteWriter(indices.length >> 1 || 16);
  let codeSize = minCodeSize + 1;
  let nextCode = endCode + 1;
  let dictionary = new Map();

  // Codes are packed least-significant-bit first and run across byte
  // boundaries, so they are accumulated in an integer and drained a byte
  // at a time.
  let bitBuffer = 0;
  let bitCount = 0;
  const emit = (code) => {
    bitBuffer |= code << bitCount;
    bitCount += codeSize;
    while (bitCount >= 8) {
      out.byte(bitBuffer);
      bitBuffer >>>= 8;
      bitCount -= 8;
    }
  };

  emit(clearCode);
  if (indices.length === 0) {
    emit(endCode);
    if (bitCount > 0) out.byte(bitBuffer);
    return out.done();
  }

  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const next = indices[i];
    // prefix is at most 4095 and next at most 255, so this packs the pair
    // into one integer key with no collisions.
    const key = prefix * 256 + next;
    const known = dictionary.get(key);
    if (known !== undefined) {
      prefix = known;
      continue;
    }

    emit(prefix);
    if (nextCode < 4096) {
      dictionary.set(key, nextCode++);
      if (nextCode > (1 << codeSize) && codeSize < 12) codeSize++;
    } else {
      // The table is full. Clear at the CURRENT width -- the decoder is
      // still reading at that width until it sees this code -- then start
      // over from an empty dictionary.
      emit(clearCode);
      dictionary = new Map();
      nextCode = endCode + 1;
      codeSize = minCodeSize + 1;
    }
    prefix = next;
  }

  emit(prefix);
  emit(endCode);
  if (bitCount > 0) out.byte(bitBuffer);
  return out.done();
}

// The compressed stream goes into the file as length-prefixed sub-blocks
// of at most 255 bytes, ended by a zero-length one.
function writeSubBlocks(writer, bytes) {
  for (let i = 0; i < bytes.length; i += 255) {
    const count = Math.min(255, bytes.length - i);
    writer.byte(count);
    writer.raw(bytes, i, count);
  }
  writer.byte(0);
}

// ---------------------------------------------------------------------------
// The file

// GIF counts delays in hundredths of a second, so the frame rate that
// actually lands in the file is quantised. Below 2 centiseconds many
// viewers historically substituted 10, so that is the floor.
export function delayFor(fps) {
  const safe = Math.max(1, Math.min(50, Math.round(fps) || 1));
  return Math.max(2, Math.round(100 / safe));
}

// What a given request will really play at, once quantised -- worth being
// able to show the user rather than promising a rate the format cannot
// hold.
export function effectiveFps(fps) {
  return 100 / delayFor(fps);
}

// frames: RGBA byte arrays, all width * height * 4 long, in order.
// Returns the finished file as bytes.
export function encodeGif({ width, height, frames, fps = 12, loop = true }) {
  if (!frames || frames.length === 0) throw new Error('A GIF needs at least one frame.');
  if (!width || !height) throw new Error('A GIF needs a non-zero size.');

  const palette = buildPalette(frames);
  const lookup = indexer(palette);
  const delay = delayFor(fps);

  // The size field holds log2(entries) - 1, which is why the table was
  // padded to a power of two.
  const sizeField = Math.log2(palette.size) - 1;
  const minCodeSize = Math.max(2, Math.ceil(Math.log2(palette.size)));

  const out = new ByteWriter();
  out.string('GIF89a');

  // Logical screen descriptor.
  out.short(width);
  out.short(height);
  out.byte(0x80 | (0x07 << 4) | sizeField); // global table present, 8-bit source
  out.byte(palette.transparentIndex);       // background: nothing, i.e. transparent
  out.byte(0);                              // no pixel aspect ratio

  // Global colour table, padded out to its declared size.
  for (let i = 0; i < palette.size; i++) {
    const c = palette.colors[i];
    out.byte(c ? c.r : 0);
    out.byte(c ? c.g : 0);
    out.byte(c ? c.b : 0);
  }

  // The Netscape extension is how a GIF says "loop": it is not part of the
  // original spec, but it is universally understood, and without it every
  // viewer plays the animation exactly once.
  if (loop) {
    out.byte(0x21); out.byte(0xFF); out.byte(0x0B);
    out.string('NETSCAPE2.0');
    out.byte(0x03); out.byte(0x01);
    out.short(0); // 0 = forever
    out.byte(0);
  }

  for (const frame of frames) {
    // Graphic control extension: how long this frame is held, which index
    // is see-through, and what to do with the frame afterwards. Disposal 2
    // ("restore to background") clears each frame before the next, so
    // transparent areas do not keep whatever the previous frame left
    // behind -- the ghosting every hand-rolled GIF hits first.
    out.byte(0x21); out.byte(0xF9); out.byte(0x04);
    out.byte((2 << 2) | 0x01); // disposal 2, transparency on
    out.short(delay);
    out.byte(palette.transparentIndex);
    out.byte(0);

    // Image descriptor: full-frame, no local table, not interlaced.
    out.byte(0x2C);
    out.short(0); out.short(0);
    out.short(width); out.short(height);
    out.byte(0);

    out.byte(minCodeSize);
    writeSubBlocks(out, lzwEncode(toIndices(frame, palette, lookup), minCodeSize));
  }

  out.byte(0x3B); // trailer
  return out.done();
}

// Everything the caller might want to say about an export before running
// it, without encoding anything.
export function describeGif({ frames, fps }) {
  const count = frames ? frames.length : 0;
  const delay = delayFor(fps);
  return {
    frames: count,
    fps: +(100 / delay).toFixed(2),
    seconds: +((count * delay) / 100).toFixed(2),
  };
}
