// Hard-edged drawing for every overlay the app paints on a canvas.
//
// Canvas 2D anti-aliases every path it strokes or fills -- a bone's wedge,
// a joint's disc, a ring around a link point, a wireframe edge -- and there
// is no switch to turn that off: imageSmoothingEnabled governs how IMAGES
// are sampled, not how shapes are rasterised. So overlays are not drawn as
// shapes at all. Each primitive here works out which cells of a pixel grid
// it covers and fills exactly those cells with fillRect, at whole device
// pixels, with the context's transform reset to the identity. What reaches
// the screen is squares of solid colour: no partial coverage anywhere, at
// any zoom, any camera angle, any device pixel ratio.
//
// THE GRID
//
// One cell is one art pixel of the interface -- PIXEL (2) CSS pixels,
// rounded to whole device pixels -- so a line on the canvas is exactly as
// heavy as a line in an icon beside it, and every overlay on every canvas
// in the app sits on the same grid. Cells are anchored at device pixel 0,
// so two primitives that touch meet exactly.
//
// Callers pass DEVICE-pixel coordinates (CSS position x effectiveDpr(),
// camera rotation already applied), because that is the only space where
// "a whole pixel" has a meaning the screen agrees with.

import { PIXEL } from './pixelIcons.js';
import { effectiveDpr } from './pixelScale.js';

// Device pixels per art pixel on this screen.
export function artPixel(dpr = effectiveDpr()) {
  return Math.max(1, Math.round(PIXEL * dpr));
}

// A 3x5 bitmap font for the few words drawn ON a canvas (handle labels).
// Text drawn with fillText would be anti-aliased like any other path.
const GLYPHS = {
  a: ['.#.', '#.#', '###', '#.#', '#.#'], b: ['##.', '#.#', '##.', '#.#', '##.'],
  c: ['.##', '#..', '#..', '#..', '.##'], d: ['##.', '#.#', '#.#', '#.#', '##.'],
  e: ['###', '#..', '##.', '#..', '###'], f: ['###', '#..', '##.', '#..', '#..'],
  g: ['.##', '#..', '#.#', '#.#', '.##'], h: ['#.#', '#.#', '###', '#.#', '#.#'],
  i: ['###', '.#.', '.#.', '.#.', '###'], j: ['..#', '..#', '..#', '#.#', '.#.'],
  k: ['#.#', '#.#', '##.', '#.#', '#.#'], l: ['#..', '#..', '#..', '#..', '###'],
  m: ['#.#', '###', '###', '#.#', '#.#'], n: ['##.', '#.#', '#.#', '#.#', '#.#'],
  o: ['.#.', '#.#', '#.#', '#.#', '.#.'], p: ['##.', '#.#', '##.', '#..', '#..'],
  q: ['.#.', '#.#', '#.#', '##.', '.##'], r: ['##.', '#.#', '##.', '#.#', '#.#'],
  s: ['.##', '#..', '.#.', '..#', '##.'], t: ['###', '.#.', '.#.', '.#.', '.#.'],
  u: ['#.#', '#.#', '#.#', '#.#', '###'], v: ['#.#', '#.#', '#.#', '#.#', '.#.'],
  w: ['#.#', '#.#', '###', '###', '#.#'], x: ['#.#', '#.#', '.#.', '#.#', '#.#'],
  y: ['#.#', '#.#', '.#.', '.#.', '.#.'], z: ['###', '..#', '.#.', '#..', '###'],
  0: ['###', '#.#', '#.#', '#.#', '###'], 1: ['.#.', '##.', '.#.', '.#.', '###'],
  2: ['##.', '..#', '.#.', '#..', '###'], 3: ['##.', '..#', '.#.', '..#', '##.'],
  4: ['#.#', '#.#', '###', '..#', '..#'], 5: ['###', '#..', '##.', '..#', '##.'],
  6: ['.##', '#..', '###', '#.#', '###'], 7: ['###', '..#', '.#.', '.#.', '.#.'],
  8: ['###', '#.#', '###', '#.#', '###'], 9: ['###', '#.#', '###', '..#', '##.'],
  ' ': ['...', '...', '...', '...', '...'], '.': ['...', '...', '...', '...', '.#.'],
  '-': ['...', '...', '###', '...', '...'], '%': ['#.#', '..#', '.#.', '#..', '#.#'],
  ':': ['...', '.#.', '...', '.#.', '...'], '/': ['..#', '..#', '.#.', '#..', '#..'],
  '+': ['...', '.#.', '###', '.#.', '...'], '°': ['.#.', '#.#', '.#.', '...', '...'],
};

export class PixelPen {
  constructor(ctx, dpr) {
    this.ctx = ctx;
    this.u = artPixel(dpr);
    this.depth = 0;
  }

  // Everything between begin() and end() draws in raw device pixels.
  begin() {
    this.ctx.save();
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.imageSmoothingEnabled = false;
    this.depth++;
    return this;
  }

  end() {
    if (this.depth === 0) return;
    this.ctx.restore();
    this.depth--;
  }

  cellOf(v) {
    return Math.floor(v / this.u);
  }

  fillCell(cx, cy, color) {
    const { u, ctx } = this;
    if (color) ctx.fillStyle = color;
    ctx.fillRect(cx * u, cy * u, u, u);
  }

  // A straight line of cells between two device points (Bresenham), with an
  // optional dash: `dash` cells on, `dash` cells off.
  line(ax, ay, bx, by, color, { dash = 0, thickness = 1 } = {}) {
    let x = this.cellOf(ax);
    let y = this.cellOf(ay);
    const x1 = this.cellOf(bx);
    const y1 = this.cellOf(by);
    const dx = Math.abs(x1 - x);
    const dy = -Math.abs(y1 - y);
    const sx = x < x1 ? 1 : -1;
    const sy = y < y1 ? 1 : -1;
    let err = dx + dy;
    let n = 0;
    this.ctx.fillStyle = color;
    const half = Math.floor((thickness - 1) / 2);
    for (;;) {
      if (!dash || Math.floor(n / dash) % 2 === 0) {
        if (thickness === 1) this.fillCell(x, y);
        else this.ctx.fillRect((x - half) * this.u, (y - half) * this.u, thickness * this.u, thickness * this.u);
      }
      if (x === x1 && y === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x += sx; }
      if (e2 <= dx) { err += dx; y += sy; }
      n++;
    }
  }

  // A closed outline through device points.
  polyline(points, color, options) {
    for (let i = 0; i < points.length; i++) {
      const a = points[i];
      const b = points[(i + 1) % points.length];
      this.line(a.x, a.y, b.x, b.y, color, options);
    }
  }

  // A filled polygon: every cell whose centre is inside.
  polygon(points, color) {
    const { u } = this;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const p of points) { minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); }
    this.ctx.fillStyle = color;
    for (let cy = this.cellOf(minY); cy <= this.cellOf(maxY); cy++) {
      const y = (cy + 0.5) * u;
      const xs = [];
      for (let i = 0; i < points.length; i++) {
        const a = points[i];
        const b = points[(i + 1) % points.length];
        if ((a.y <= y && b.y > y) || (b.y <= y && a.y > y)) xs.push(a.x + ((y - a.y) / (b.y - a.y)) * (b.x - a.x));
      }
      xs.sort((p, q) => p - q);
      for (let i = 0; i + 1 < xs.length; i += 2) {
        const c0 = Math.ceil(xs[i] / u - 0.5);
        const c1 = Math.floor(xs[i + 1] / u - 0.5);
        if (c1 >= c0) this.ctx.fillRect(c0 * u, cy * u, (c1 - c0 + 1) * u, u);
      }
    }
  }

  // Midpoint circle: a ring `r` device pixels out from a device point.
  ring(x, y, r, color) {
    const cx = this.cellOf(x);
    const cy = this.cellOf(y);
    const rc = Math.max(1, Math.round(r / this.u));
    this.ctx.fillStyle = color;
    let px = rc;
    let py = 0;
    let err = 1 - rc;
    while (px >= py) {
      for (const [ox, oy] of [[px, py], [py, px], [-py, px], [-px, py], [-px, -py], [-py, -px], [py, -px], [px, -py]]) {
        this.fillCell(cx + ox, cy + oy);
      }
      py++;
      if (err < 0) err += 2 * py + 1;
      else { px--; err += 2 * (py - px) + 1; }
    }
  }

  // A filled disc: every cell whose centre is within r.
  disc(x, y, r, color) {
    const cx = this.cellOf(x);
    const cy = this.cellOf(y);
    const rc = Math.max(0.5, r / this.u);
    const reach = Math.ceil(rc);
    this.ctx.fillStyle = color;
    for (let oy = -reach; oy <= reach; oy++) {
      if (rc * rc - oy * oy < 0) continue;
      const span = Math.floor(Math.sqrt(rc * rc - oy * oy));
      this.ctx.fillRect((cx - span) * this.u, (cy + oy) * this.u, (2 * span + 1) * this.u, this.u);
    }
  }

  // A filled square `half` cells out from a device point's cell (a handle).
  square(x, y, half, color) {
    const cx = this.cellOf(x);
    const cy = this.cellOf(y);
    this.ctx.fillStyle = color;
    this.ctx.fillRect((cx - half) * this.u, (cy - half) * this.u, (2 * half + 1) * this.u, (2 * half + 1) * this.u);
  }

  // The outline of an axis-aligned box between two device points.
  box(x0, y0, x1, y1, color, options) {
    this.polyline([{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }], color, options);
  }

  // Words in the 3x5 bitmap font, `x` the anchor per `align`, `y` the top.
  text(str, x, y, color, { align = 'center', background = null } = {}) {
    const chars = [...String(str).toLowerCase()].map((ch) => GLYPHS[ch] || GLYPHS[' ']);
    const width = chars.length * 4 - 1;
    let cx = this.cellOf(x);
    if (align === 'center') cx -= Math.floor(width / 2);
    else if (align === 'right') cx -= width;
    const cy = this.cellOf(y);
    if (background) {
      this.ctx.fillStyle = background;
      this.ctx.fillRect((cx - 1) * this.u, (cy - 1) * this.u, (width + 2) * this.u, 7 * this.u);
    }
    this.ctx.fillStyle = color;
    chars.forEach((glyph, i) => {
      glyph.forEach((row, gy) => {
        for (let gx = 0; gx < 3; gx++) if (row[gx] === '#') this.fillCell(cx + i * 4 + gx, cy + gy);
      });
    });
  }
}

// ---------------------------------------------------------------------------
// Helpers for canvases drawn in CSS px under a devicePixelRatio transform
// (the tool windows' texel grids and painted-cell highlights).
//
// strokeRect and a 1 px stroked line are centred ON the coordinate given, so
// half of their width lands on a half device pixel and is blended. These
// fill whole device pixels instead.

// The thinnest line that is still whole device pixels, in CSS px.
export function hairline(dpr) {
  return Math.max(1, Math.round(dpr)) / dpr;
}

// A cell's border drawn INSIDE the cell as four filled strips, `weight` CSS
// px thick rounded to whole device pixels.
export function cellEdge(ctx, x, y, size, weight, color, dpr) {
  const w = Math.max(1, Math.round(weight * dpr)) / dpr;
  ctx.fillStyle = color;
  ctx.fillRect(x, y, size, w);
  ctx.fillRect(x, y + size - w, size, w);
  ctx.fillRect(x, y, w, size);
  ctx.fillRect(x + size - w, y, w, size);
}

// A texel grid: `cols` x `rows` cells of `step` CSS px from (x0, y0), its
// lines one hairline wide.
export function gridStrips(ctx, x0, y0, cols, rows, step, color, dpr) {
  const w = hairline(dpr);
  ctx.fillStyle = color;
  for (let u = 0; u <= cols; u++) ctx.fillRect(x0 + u * step, y0, w, rows * step);
  for (let v = 0; v <= rows; v++) ctx.fillRect(x0, y0 + v * step, cols * step + w, w);
}

// A rectangle's outline, one hairline wide, just OUTSIDE the rectangle.
export function frameOutside(ctx, x, y, width, height, color, dpr) {
  const w = hairline(dpr);
  ctx.fillStyle = color;
  ctx.fillRect(x - w, y - w, width + 2 * w, w);
  ctx.fillRect(x - w, y + height, width + 2 * w, w);
  ctx.fillRect(x - w, y, w, height);
  ctx.fillRect(x + width, y, w, height);
}
