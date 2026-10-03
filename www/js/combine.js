// Combine Layers: two layers flattened into ONE new layer, the way they look.
//
// The two are drawn exactly as the scene draws them at rest -- each one's
// own position, scale and rotation, through the same rasterizer the canvas
// uses -- the lower of the two first and the upper over it, with standard
// alpha compositing (raster.js blends a part-transparent texel over what is
// beneath it). The result is cropped to the artwork both of them cover and
// becomes an ordinary new layer at scale 1, positioned so every pixel lands
// where it was drawn before.
//
// It is a picture, nothing more: no bones, weights, mesh, pins, links or
// pierce role come with it, so it is ready to be rigged fresh. The store
// half (partsStore.combine) puts it where the upper layer was in the stack
// and removes the two originals; the UI asks first, because that is
// destructive.

import { partQuad } from './mesh.js';
import { rasterizeTriangle, layerClaims } from './raster.js';

// The flattened artwork of `lower` and `upper` (lower drawn first), in scene
// pixels: { pixels, width, height, x, y }, or null when neither has a single
// opaque pixel.
export function combinedArtwork(lower, upper) {
  const parts = [lower, upper].filter(Boolean);
  const quads = parts.map((part) => partQuad(part));
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  for (const quad of quads) {
    for (const p of quad.positions) {
      x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y);
      x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
    }
  }
  x0 = Math.floor(x0); y0 = Math.floor(y0);
  const W = Math.max(1, Math.ceil(x1) - x0);
  const H = Math.max(1, Math.ceil(y1) - y0);
  const buffer = new Uint8ClampedArray(W * H * 4);
  const claims = layerClaims();
  parts.forEach((part, k) => {
    const { positions, uvs, triangles } = quads[k];
    const local = positions.map((p) => ({ x: p.x - x0, y: p.y - y0 }));
    const claim = claims.begin(W, H);
    for (let t = 0; t < triangles.length; t += 3) {
      const a = triangles[t]; const b = triangles[t + 1]; const c = triangles[t + 2];
      rasterizeTriangle(buffer, W, H, part.pixels, part.naturalWidth, part.naturalHeight,
        local[a], local[b], local[c], uvs[a], uvs[b], uvs[c], null, claim);
    }
  });

  // Cropped to the artwork: an empty margin would only be something to
  // trim later.
  let cx0 = W; let cy0 = H; let cx1 = -1; let cy1 = -1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (buffer[(y * W + x) * 4 + 3] === 0) continue;
      if (x < cx0) cx0 = x;
      if (x > cx1) cx1 = x;
      if (y < cy0) cy0 = y;
      if (y > cy1) cy1 = y;
    }
  }
  if (cx1 < 0) return null;
  const width = cx1 - cx0 + 1;
  const height = cy1 - cy0 + 1;
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    const from = ((cy0 + y) * W + cx0) * 4;
    pixels.set(buffer.subarray(from, from + width * 4), y * width * 4);
  }
  return { pixels, width, height, x: x0 + cx0, y: y0 + cy0 };
}

// The two chosen layers in stacking order: [lower, upper].
export function stackOrder(a, b) {
  return a.zIndex <= b.zIndex ? [a, b] : [b, a];
}
