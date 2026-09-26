// The V: two halves swinging apart to let a piercer in.
//
// WHAT THE MOTION IS
//
// Picture a closed fist with the thumb pressed into the seam between the
// index and middle fingers. As the thumb goes in, the two fingers each turn
// away from the seam about their own base, and a V opens exactly as far as
// the thumb has gone. The thumb is the piercer; the fingers are the two
// halves of the pierced layer; and there is ONE number behind the whole
// picture -- how deep the piercer is. pierce.js measures it, turns it into an
// opening fraction t (0 shut, 1 fully open) and publishes t. Everything here
// is a pure function of t and the artwork, so a given depth always looks the
// same, and backing out runs the same numbers backwards to shut.
//
// THE TWO HALVES
//
// Either two separate layers the artist paired (PAIR), or the two sides of
// ONE layer split by a seam the artist drew on it (SEAM). Each half has a
// HINGE -- a point in its own texel space, found on the deformed layer every
// frame with the same lookup PxLink uses for its link points -- and turns
// about it. The turn is a rigid rotation {cos, sin, from, to} with
// from = to = the hinge (carryByCorrection), so the hinge is a fixed point by
// construction: it never moves and never separates, exactly like a PxLink
// connection. And because the turn is applied BEFORE PxLink's own solve, a
// half that is PxLinked to a palm at its hinge stays joined to it.
//
// WHICH WAY, AND HOW FAR
//
// Each half turns away from the seam's centreline: the side of the seam it
// is on decides the sign. How far is set by the artist as the V's full width
// at its mouth -- each half turns by the angle that carries its own mouth
// corner half that width away from the seam, so the two together open
// exactly that wide at the End Point however long or short each half is.
//
// ONE LAYER, TWO HALVES
//
// A seam-split layer has one mesh, and a mesh whose vertices straddle the
// seam can stretch but never open. So it is drawn as TWO copies of itself:
// copy A deformed as if the whole layer were half A, drawn only where the
// texels are on side A; copy B likewise. Each copy is one continuous
// deformation, so neither can tear; the V is the gap between them. Near its
// hinge each half turns progressively (a bend band a few texels long), and
// at and behind the hinge neither copy turns at all -- so there the two are
// identical and the layer stays whole below the V's apex.

import { partsStore, SpreadMode } from './parts.js';
import { localToWorld } from './layerSpace.js';
import { spreadOpen } from './pierceState.js';
import { carryByCorrection, locateTexel, landTexel } from './pxlinkState.js';

// No half may swing past this. A V wider than the halves are long would
// need an angle past a right angle, which is two fingers folding back on
// themselves rather than parting.
const MAX_SWING = Math.asin(0.95);
// The bend band behind a seam half's rigid part, in texels: a quarter of the
// seam's length, between these.
const MIN_BAND = 2;
const MAX_BAND = 8;
// Two separate halves "touch" where their texels are this close at rest.
const CONTACT_RADIUS = 1.6;

// ---------------------------------------------------------------------------
// Which layers make a V

// The V a pierced layer is half of, or null. A pair counts only when both
// layers are pierced and point at each other; a seam only once there is a
// seam to split along.
export function spreadTargetOf(part) {
  if (!part || !part.isPierced) return null;
  if (part.pierceSpreadMode === SpreadMode.PAIR) {
    const other = partsStore.partnerOf(part);
    if (!other || !other.isPierced || other.pierceSpreadMode !== SpreadMode.PAIR) return null;
    const layers = [part, other].sort((a, b) => (a.id < b.id ? -1 : 1));
    return { mode: SpreadMode.PAIR, key: `pair:${layers[0].id}|${layers[1].id}`, layers };
  }
  if (part.pierceSpreadMode === SpreadMode.SEAM && part.pierceSeam.size >= 2) {
    return { mode: SpreadMode.SEAM, key: `seam:${part.id}`, layers: [part] };
  }
  return null;
}

// Every pierced "thing" a piercer can go into, once each: a pair is one
// target of two layers; any other pierced layer is a target of its own
// (with a V to open, or none).
export function pierceTargets() {
  const seen = new Set();
  const targets = [];
  for (const layer of partsStore.piercedLayers) {
    if (seen.has(layer.id)) continue;
    const target = spreadTargetOf(layer);
    if (target) {
      for (const member of target.layers) seen.add(member.id);
      targets.push(target);
    } else {
      seen.add(layer.id);
      targets.push({ mode: SpreadMode.OFF, key: `off:${layer.id}`, layers: [layer] });
    }
  }
  return targets;
}

// ---------------------------------------------------------------------------
// Small geometry

const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
const dot = (a, b) => a.x * b.x + a.y * b.y;
const len = (a) => Math.hypot(a.x, a.y);
const unit = (a) => { const l = len(a); return l > 1e-12 ? { x: a.x / l, y: a.y / l } : null; };
const perp = (a) => ({ x: -a.y, y: a.x });
const smooth = (x) => { const t = Math.max(0, Math.min(1, x)); return t * t * (3 - 2 * t); };

function texelScene(part, u, v) {
  return localToWorld(part, { x: u - part.naturalWidth / 2, y: v - part.naturalHeight / 2 });
}

// Principal direction of a point cloud (2D PCA), and its centre.
function principal(points) {
  let cx = 0; let cy = 0;
  for (const p of points) { cx += p.x; cy += p.y; }
  cx /= points.length; cy /= points.length;
  let xx = 0; let xy = 0; let yy = 0;
  for (const p of points) {
    const dx = p.x - cx; const dy = p.y - cy;
    xx += dx * dx; xy += dx * dy; yy += dy * dy;
  }
  const angle = 0.5 * Math.atan2(2 * xy, xx - yy);
  return { centre: { x: cx, y: cy }, dir: { x: Math.cos(angle), y: Math.sin(angle) } };
}

// The two extremes of a point cloud along a direction, each the average of
// the points within half a texel of it (so a thick stroke's end is its
// middle, not a corner).
function ends(points, dir) {
  let lo = Infinity; let hi = -Infinity;
  for (const p of points) { const s = dot(p, dir); lo = Math.min(lo, s); hi = Math.max(hi, s); }
  const avg = (target) => {
    let x = 0; let y = 0; let n = 0;
    for (const p of points) {
      if (Math.abs(dot(p, dir) - target) > 0.5) continue;
      x += p.x; y += p.y; n++;
    }
    return { x: x / n, y: y / n };
  };
  return [avg(lo), avg(hi)];
}

function opaque(part, u, v) {
  if (u < 0 || v < 0 || u >= part.naturalWidth || v >= part.naturalHeight) return false;
  return part.pixels[(v * part.naturalWidth + u) * 4 + 3] > 0;
}

// How far (texels) a point is from the nearest transparent texel or the
// layer's edge -- how deep inside the artwork it sits.
function depthInside(part, p) {
  const u0 = Math.floor(p.x); const v0 = Math.floor(p.y);
  for (let r = 0; r <= 48; r++) {
    for (let dv = -r; dv <= r; dv++) {
      for (let du = -r; du <= r; du++) {
        if (Math.max(Math.abs(du), Math.abs(dv)) !== r) continue;
        if (!opaque(part, u0 + du, v0 + dv)) return r;
      }
    }
  }
  return 48;
}

function regionCentroid(part, region) {
  if (!region || region.size === 0) return null;
  let x = 0; let y = 0;
  for (const index of region) {
    x += (index % part.naturalWidth) + 0.5;
    y += Math.floor(index / part.naturalWidth) + 0.5;
  }
  return { x: x / region.size, y: y / region.size };
}

// Which end of a seam is its MOUTH -- where the piercer comes in -- when the
// artist has not placed the hinges to say so. In order: the end nearer the
// painted Pierceable area (that paint marks where contact happens), then the
// end nearer the outside of the artwork (a seam runs from the gap between
// two fingertips inward), then the upper end.
function chooseMouth(endA, endB, { pierceable, insideA, insideB }) {
  if (pierceable) {
    const da = len(sub(endA, pierceable));
    const db = len(sub(endB, pierceable));
    if (Math.abs(da - db) > 0.5) return da < db ? 0 : 1;
  }
  if (insideA !== undefined && Math.abs(insideA - insideB) >= 1) return insideA < insideB ? 0 : 1;
  return endA.y <= endB.y ? 0 : 1;
}

// ---------------------------------------------------------------------------
// SEAM: one layer, split along a drawn line. Everything in its texel space.

const seamCache = new WeakMap();

function seamKey(part) {
  const h = (p) => (p ? `${p.u},${p.v}` : '-');
  return `${part.pierceSeamVersion}|${part.pierceSeam.size}|${h(part.pierceHingeA)}|${h(part.pierceHingeB)}|` +
    `${part.pierceSpread}|${part.naturalWidth}x${part.naturalHeight}|${part.scale}|` +
    `${part.pierceRegionVersion || 0}`;
}

function seamGeometry(part) {
  const key = seamKey(part);
  const cached = seamCache.get(part);
  if (cached && cached.key === key && cached.pixels === part.pixels) return cached.geometry;

  const W = part.naturalWidth;
  const pts = [...part.pierceSeam].map((i) => ({ x: (i % W) + 0.5, y: Math.floor(i / W) + 0.5 }));
  let geometry = null;
  if (pts.length >= 2) {
    const { dir } = principal(pts);
    const [e0, e1] = ends(pts, dir);
    let mouth;
    let closed;
    const placedA = part.pierceHingeA ? { x: part.pierceHingeA.u, y: part.pierceHingeA.v } : null;
    const placedB = part.pierceHingeB ? { x: part.pierceHingeB.u, y: part.pierceHingeB.v } : null;
    if (placedA || placedB) {
      const mid = placedA && placedB
        ? { x: (placedA.x + placedB.x) / 2, y: (placedA.y + placedB.y) / 2 }
        : (placedA || placedB);
      const far0 = len(sub(e0, mid)) >= len(sub(e1, mid));
      mouth = far0 ? e0 : e1;
      closed = far0 ? e1 : e0;
    } else {
      const which = chooseMouth(e0, e1, {
        pierceable: regionCentroid(part, part.pierceRegion),
        insideA: depthInside(part, e0),
        insideB: depthInside(part, e1),
      });
      mouth = which === 0 ? e0 : e1;
      closed = which === 0 ? e1 : e0;
    }
    const hingeA = placedA || closed;
    const hingeB = placedB || closed;
    const origin = { x: (hingeA.x + hingeB.x) / 2, y: (hingeA.y + hingeB.y) / 2 };
    const axis = unit(sub(mouth, origin)) || { x: 0, y: -1 };
    const normal = perp(axis);

    // The seam's own line, as offset-across-the-axis per unit along it:
    // curved seams are followed, not straightened.
    const bins = new Map();
    for (const p of pts) {
      const s = Math.round(dot(sub(p, origin), axis));
      const q = dot(sub(p, origin), normal);
      const bin = bins.get(s) || { q: 0, n: 0 };
      bin.q += q; bin.n++;
      bins.set(s, bin);
    }
    const profile = [...bins.entries()].map(([s, b]) => ({ s, q: b.q / b.n })).sort((a, b) => a.s - b.s);
    const seamQ = (s) => {
      if (s <= profile[0].s) return profile[0].q;
      const last = profile[profile.length - 1];
      if (s >= last.s) return last.q;
      let i = 1;
      while (profile[i].s < s) i++;
      const a = profile[i - 1]; const b = profile[i];
      return a.q + ((b.q - a.q) * (s - a.s)) / (b.s - a.s);
    };
    // Side of a texel-space point: +1 (half A) or -1 (half B).
    const sideOf = (p) => {
      const d = sub(p, origin);
      return dot(d, normal) >= seamQ(dot(d, axis)) ? 1 : -1;
    };
    const H = part.naturalHeight;
    const maskA = new Uint8Array(W * H);
    const maskB = new Uint8Array(W * H);
    for (let v = 0; v < H; v++) {
      for (let u = 0; u < W; u++) {
        if (sideOf({ x: u + 0.5, y: v + 0.5 }) > 0) maskA[v * W + u] = 1; else maskB[v * W + u] = 1;
      }
    }
    const seamLength = Math.max(1, profile[profile.length - 1].s - profile[0].s);
    const band = Math.max(MIN_BAND, Math.min(MAX_BAND, seamLength / 4));
    const half = (side, sigma, hinge) => ({
      part, side, sigma,
      hinge: { u: hinge.x, v: hinge.y },
      // Hinge to mouth, in scene pixels: the lever the V's width is set on.
      lever: len(sub(mouth, hinge)) * part.scale,
    });
    geometry = {
      mode: SpreadMode.SEAM,
      cacheKey: `seam:${part.id}:${key}`,
      axis, normal, origin, mouth, closed, band, sideOf, maskA, maskB,
      halves: [half('a', 1, hingeA), half('b', -1, hingeB)],
    };
  }
  seamCache.set(part, { key, pixels: part.pixels, geometry });
  return geometry;
}

// ---------------------------------------------------------------------------
// PAIR: two layers. The seam between them is where they touch.

const pairCache = new Map();

function opaqueScenePoints(part) {
  const out = [];
  for (let v = 0; v < part.naturalHeight; v++) {
    for (let u = 0; u < part.naturalWidth; u++) {
      if (opaque(part, u, v)) out.push({ ...texelScene(part, u + 0.5, v + 0.5), u: u + 0.5, v: v + 0.5 });
    }
  }
  return out;
}

function pairKey(p, q) {
  const h = (x) => (x ? `${x.u},${x.v}` : '-');
  // Relative placement only: the two halves carried together (a whole-body
  // drag) is the same V, and must not rebuild it every frame.
  return [p.id, q.id, q.x - p.x, q.y - p.y, p.rotation, q.rotation, p.scale, q.scale,
    p.naturalWidth, p.naturalHeight, q.naturalWidth, q.naturalHeight,
    h(p.pierceHingeA), h(q.pierceHingeA), p.pierceSpread,
    p.pierceRegionVersion || 0, q.pierceRegionVersion || 0].join('|');
}

function pairGeometry(p, q) {
  const key = pairKey(p, q);
  const cached = pairCache.get(`${p.id}|${q.id}`);
  const origin0 = { x: p.centerX, y: p.centerY };
  if (cached && cached.key === key && cached.pixelsP === p.pixels && cached.pixelsQ === q.pixels) {
    return rebase(cached.geometry, origin0);
  }

  // Everything below is computed relative to p's centre, so the cached
  // answer can be carried wherever the pair is moved as a whole.
  const rel = (pt) => ({ ...pt, x: pt.x - origin0.x, y: pt.y - origin0.y });
  const P = opaqueScenePoints(p).map(rel);
  const Q = opaqueScenePoints(q).map(rel);
  let geometry = null;
  if (P.length > 0 && Q.length > 0) {
    const grid = new Map();
    const cell = (x, y) => `${Math.floor(x)},${Math.floor(y)}`;
    for (const pt of Q) {
      const k = cell(pt.x, pt.y);
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(pt);
    }
    const near = (pt) => {
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          for (const o of grid.get(cell(pt.x + dx, pt.y + dy)) || []) {
            if (Math.hypot(o.x - pt.x, o.y - pt.y) <= CONTACT_RADIUS) return o;
          }
        }
      }
      return null;
    };
    const contact = [];
    for (const pt of P) {
      const o = near(pt);
      if (o) contact.push({ x: (pt.x + o.x) / 2, y: (pt.y + o.y) / 2 });
    }
    const centroid = (list) => {
      let x = 0; let y = 0;
      for (const pt of list) { x += pt.x; y += pt.y; }
      return { x: x / list.length, y: y / list.length };
    };
    const cP = centroid(P);
    const cQ = centroid(Q);
    let e0;
    let e1;
    if (contact.length >= 2) {
      const { dir } = principal(contact);
      [e0, e1] = ends(contact, dir);
    } else {
      // Not touching: the seam is the line midway between them, across the
      // line joining their middles, as long as they are.
      const across = unit(sub(cQ, cP)) || { x: 1, y: 0 };
      const dir = perp(across);
      const mid = { x: (cP.x + cQ.x) / 2, y: (cP.y + cQ.y) / 2 };
      let lo = Infinity; let hi = -Infinity;
      for (const pt of [...P, ...Q]) { const s = dot(sub(pt, mid), dir); lo = Math.min(lo, s); hi = Math.max(hi, s); }
      e0 = { x: mid.x + dir.x * lo, y: mid.y + dir.y * lo };
      e1 = { x: mid.x + dir.x * hi, y: mid.y + dir.y * hi };
    }

    const placedP = p.pierceHingeA ? rel(texelScene(p, p.pierceHingeA.u, p.pierceHingeA.v)) : null;
    const placedQ = q.pierceHingeA ? rel(texelScene(q, q.pierceHingeA.u, q.pierceHingeA.v)) : null;
    let mouth;
    let closed;
    if (placedP || placedQ) {
      const mid = placedP && placedQ
        ? { x: (placedP.x + placedQ.x) / 2, y: (placedP.y + placedQ.y) / 2 }
        : (placedP || placedQ);
      const far0 = len(sub(e0, mid)) >= len(sub(e1, mid));
      mouth = far0 ? e0 : e1;
      closed = far0 ? e1 : e0;
    } else {
      const paint = [];
      for (const part of [p, q]) {
        for (const index of part.pierceRegion) {
          paint.push(rel(texelScene(part, (index % part.naturalWidth) + 0.5,
            Math.floor(index / part.naturalWidth) + 0.5)));
        }
      }
      const which = chooseMouth(e0, e1, { pierceable: paint.length ? centroid(paint) : null });
      mouth = which === 0 ? e0 : e1;
      closed = which === 0 ? e1 : e0;
    }
    const baseAxis = unit(sub(mouth, closed)) || { x: 0, y: -1 };
    const baseNormal = perp(baseAxis);

    // A half's default hinge: on its inner edge (the texels nearest the seam
    // line), at the end furthest from the mouth -- the inside corner of a
    // finger's base, where the V's point belongs.
    const defaultHinge = (points) => {
      let best = Infinity;
      for (const pt of points) best = Math.min(best, Math.abs(dot(sub(pt, closed), baseNormal)));
      // Nearest the base first; among texels level with it, the innermost.
      let pick = null;
      let pickS = Infinity;
      let pickQ = Infinity;
      for (const pt of points) {
        const q = Math.abs(dot(sub(pt, closed), baseNormal));
        if (q > best + 1.5) continue;
        const s = dot(sub(pt, closed), baseAxis);
        if (s < pickS - 0.5 || (Math.abs(s - pickS) <= 0.5 && q < pickQ)) {
          pickS = Math.min(pickS, s); pickQ = q; pick = pt;
        }
      }
      return pick;
    };
    const hingeP = placedP || defaultHinge(P);
    const hingeQ = placedQ || defaultHinge(Q);
    const origin = { x: (hingeP.x + hingeQ.x) / 2, y: (hingeP.y + hingeQ.y) / 2 };
    const axis = unit(sub(mouth, origin)) || baseAxis;
    const normal = perp(axis);
    let sigmaP = Math.sign(dot(sub(cP, origin), normal)) || 1;
    let sigmaQ = Math.sign(dot(sub(cQ, origin), normal)) || -sigmaP;
    if (sigmaP === sigmaQ) sigmaQ = -sigmaP;
    const toTexel = (part, pt, placed) => (placed
      ? { u: part.pierceHingeA.u, v: part.pierceHingeA.v }
      : { u: pt.u, v: pt.v });
    geometry = {
      mode: SpreadMode.PAIR,
      cacheKey: `pair:${key}`,
      axis, normal, origin, mouth, closed,
      halves: [
        { part: p, side: 'whole', sigma: sigmaP, hinge: toTexel(p, hingeP, placedP), lever: len(sub(mouth, hingeP)), sceneHinge: hingeP },
        { part: q, side: 'whole', sigma: sigmaQ, hinge: toTexel(q, hingeQ, placedQ), lever: len(sub(mouth, hingeQ)), sceneHinge: hingeQ },
      ],
    };
  }
  pairCache.set(`${p.id}|${q.id}`, { key, pixelsP: p.pixels, pixelsQ: q.pixels, geometry });
  return rebase(geometry, origin0);
}

// A pair's cached geometry is relative to its first layer's centre; this
// puts it back in the scene.
function rebase(geometry, origin0) {
  if (!geometry) return null;
  const at = (pt) => ({ x: pt.x + origin0.x, y: pt.y + origin0.y });
  return {
    ...geometry,
    origin: at(geometry.origin),
    mouth: at(geometry.mouth),
    closed: at(geometry.closed),
    halves: geometry.halves.map((h) => ({ ...h, sceneHinge: at(h.sceneHinge) })),
  };
}

// ---------------------------------------------------------------------------
// The public geometry

// The V a target makes: its halves (each with its part, side, sign, hinge in
// texels and lever), its seam axis, and -- for one layer -- the side masks.
export function spreadGeometry(target) {
  if (!target) return null;
  if (target.mode === SpreadMode.SEAM) return seamGeometry(target.layers[0]);
  if (target.mode === SpreadMode.PAIR) return pairGeometry(target.layers[0], target.layers[1]);
  return null;
}

// Each half's full swing, in radians: the angle that carries its mouth
// corner half the V's width away from the seam.
export function fullSwing(half) {
  const width = half.part.pierceSpread;
  if (!(width > 0) || !(half.lever > 0)) return 0;
  return Math.asin(Math.min(Math.sin(MAX_SWING), width / 2 / half.lever));
}

// How far each half of a target is turned at opening fraction t: signed,
// away from the seam. Exactly proportional to t -- the V and the depth are
// one number.
export function swingAt(half, t) {
  return half.sigma * Math.max(0, Math.min(1, t)) * fullSwing(half);
}

// The opening this layer's V is at right now (0..1), as published by the
// pierce solver from the piercer's depth.
export function openFraction(part) {
  const target = spreadTargetOf(part);
  return target ? spreadOpen(target.key) : 0;
}

// Whether this layer is being spread at all this frame.
export function spreadActive(part) {
  return openFraction(part) > 0;
}

// Draw masks for a seam-split layer that is open: side A's texels and side
// B's, so the renderer can draw the layer as its two halves. Null for
// anything else -- a pair's halves are separate layers already, and a shut
// V is drawn whole.
export function spreadMasks(part) {
  if (!spreadActive(part)) return null;
  const target = spreadTargetOf(part);
  if (!target || target.mode !== SpreadMode.SEAM) return null;
  const geometry = spreadGeometry(target);
  return geometry ? { a: geometry.maskA, b: geometry.maskB } : null;
}

// How much of a half's turn a texel-space point of a SEAM layer takes: none
// at or behind the hinge, all of it once past the bend band.
function bendWeight(geometry, half, point) {
  const s = dot(sub(point, { x: half.hinge.u, y: half.hinge.v }), geometry.axis);
  return smooth(s / geometry.band);
}

// The turn applying at one texel of a layer -- which half it belongs to, the
// angle (weighted, for a seam) and that half's hinge. For points that have to
// move with the artwork outside the mesh: the Barrier's walls.
export function swingAtTexel(part, u, v, t) {
  const target = spreadTargetOf(part);
  if (!target || !(t > 0)) return null;
  const geometry = spreadGeometry(target);
  if (!geometry) return null;
  if (geometry.mode === SpreadMode.PAIR) {
    const half = geometry.halves.find((h) => h.part === part);
    return half ? { angle: swingAt(half, t), hinge: half.hinge } : null;
  }
  const point = { x: u, y: v };
  const k = geometry.sideOf(point) > 0 ? 0 : 1;
  const half = geometry.halves[k];
  // As much of the turn as the artwork AT this texel takes: its triangle's
  // corner weights, blended -- the same numbers the drawn layer turns by.
  let weight = bendWeight(geometry, half, point);
  if (part.mesh) {
    const facts = vertexFacts(part.mesh, part, geometry);
    const located = locateTexel(part.mesh.vertices, part.mesh.triangles, u, v);
    const weights = facts.halves[k].weights;
    if (located && weights) {
      weight = located.bary.reduce((sum, b, c) => sum + b * weights[located.ids[c]], 0);
    }
  }
  return { angle: swingAt(half, t) * weight, hinge: half.hinge };
}

// ---------------------------------------------------------------------------
// The deformation

const vertexCache = new WeakMap();

// Per-vertex facts that only change with the mesh or the seam: which side
// each vertex is on, how much of each half's turn it takes, and where each
// hinge sits in the mesh.
function vertexFacts(mesh, part, geometry) {
  const key = geometry.cacheKey;
  const cached = vertexCache.get(mesh);
  if (cached && cached.key === key) return cached;
  const halves = geometry.halves.filter((h) => h.part === part);
  const facts = {
    key,
    halves: halves.map((half) => {
      const located = locateTexel(mesh.vertices, mesh.triangles, half.hinge.u, half.hinge.v);
      let weights = null;
      if (geometry.mode === SpreadMode.SEAM) {
        weights = Float64Array.from(mesh.vertices, (t) => bendWeight(geometry, half, { x: t.u, y: t.v }));
        // THE ARTWORK IS DRAWN THROUGH TRIANGLES, NOT VERTICES
        //
        // A texel at or behind the hinge sits in a triangle whose far corner
        // may be just AHEAD of it. If that corner took any of the turn, the
        // texel would move -- differently in each half's copy -- and the
        // layer would crack behind the V's point by a fraction of a pixel
        // (measured: 0.74 px at full opening). And the hinge itself, found on
        // the mesh by its triangle, would drift off its fixed point the same
        // way. So every triangle that reaches back to the hinge is held still
        // entirely; the bend starts where the triangles are wholly ahead.
        const T = mesh.triangles;
        const V = mesh.vertices;
        const behind = (i) => dot(sub({ x: V[i].u, y: V[i].v }, { x: half.hinge.u, y: half.hinge.v }), geometry.axis) <= 0;
        const still = new Uint8Array(V.length);
        for (let t = 0; t < T.length; t += 3) {
          if (behind(T[t]) || behind(T[t + 1]) || behind(T[t + 2])) {
            still[T[t]] = 1; still[T[t + 1]] = 1; still[T[t + 2]] = 1;
          }
        }
        if (located) for (const id of located.ids) still[id] = 1;
        for (let i = 0; i < V.length; i++) if (still[i]) weights[i] = 0;
      }
      return { half, located, weights };
    }),
    side: geometry.mode === SpreadMode.SEAM
      ? Int8Array.from(mesh.vertices, (t) => geometry.sideOf({ x: t.u, y: t.v }))
      : null,
  };
  vertexCache.set(mesh, facts);
  return facts;
}

// Opens a pierced layer's V on its deformed vertices. `half` picks which copy
// of a seam-split layer this is: 'a' or 'b' turns every vertex as that half
// (the renderer draws each through its side's mask), null gives every vertex
// its own side's turn (one best-effort answer for anything that wants a
// single set of positions). A pair's halves are whole layers and ignore it.
export function applySpread(mesh, part, positions, half = null) {
  const t = openFraction(part);
  if (!(t > 0) || !mesh) return positions;
  const target = spreadTargetOf(part);
  const geometry = spreadGeometry(target);
  if (!geometry) return positions;
  const facts = vertexFacts(mesh, part, geometry);
  const turns = facts.halves.map(({ half: h, located, weights }) => ({
    angle: swingAt(h, t),
    // The hinge where the layer is RIGHT NOW -- bones, pins and all -- so
    // the turn is about the point of the artwork the hinge was placed on,
    // wherever that has been carried.
    at: located ? landTexel(positions, located) : null,
    weights,
  }));
  const rotate = (p, angle, at) => carryByCorrection(
    { cos: Math.cos(angle), sin: Math.sin(angle), from: at, to: at }, p);

  if (geometry.mode === SpreadMode.PAIR) {
    const { angle, at } = turns[0];
    if (!at || angle === 0) return positions;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const turn = { cos, sin, from: at, to: at };
    return positions.map((p) => carryByCorrection(turn, p));
  }

  const pick = half === 'a' ? 0 : half === 'b' ? 1 : null;
  return positions.map((p, i) => {
    const k = pick ?? (facts.side[i] > 0 ? 0 : 1);
    const turn = turns[k];
    if (!turn.at) return p;
    const angle = turn.angle * turn.weights[i];
    return angle === 0 ? p : rotate(p, angle, turn.at);
  });
}
