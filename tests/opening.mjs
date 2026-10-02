// The opening, verified headlessly against the real modules: the shape of
// the seam's bulge, the refined mesh it is drawn through, the two passes,
// and the live contact that drives it.
//
// Every module the pierce solver touches is plain ES with no DOM in it, so
// the whole thing runs in Node against the real code rather than against a
// re-implementation of it.

import { strict as assert } from 'node:assert';
import {
  Part, partsStore, PierceRole, DEFAULT_PIERCE_ENTER, DEFAULT_PIERCE_END,
  DEFAULT_WEDGE_LOCK, clampWedgeLock,
} from '../www/js/parts.js';
import {
  contactOf, pierceOpeningOf, markPierceStale, resetPierceContainment, pierceDentIssue,
} from '../www/js/pierce.js';
import {
  openingFor, openingAmplitude, openingShift, openingSides, openingGeometry,
  refinedMesh, openingMarker, seamCoordinates, resetOpeningCaches, openingRim, openingCover,
  openingDisplacement,
} from '../www/js/opening.js';
import { generateMesh, defaultDensity, deformVertices } from '../www/js/mesh.js';

let checks = 0;
let failures = 0;
const results = [];
function check(name, fn) {
  checks++;
  try { fn(); results.push(`  ok    ${name}`); } catch (error) { failures++; results.push(`  FAIL  ${name}\n          ${error.message}`); }
}
const section = (title) => results.push(`\n${title}`);

function makePart(name, { w, h, x, y }) {
  const pixels = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) { pixels[i * 4] = 200; pixels[i * 4 + 1] = 200; pixels[i * 4 + 2] = 200; pixels[i * 4 + 3] = 255; }
  return new Part({ name, image: null, pixels, width: w, height: h, x, y, scale: 1 });
}

// A 40x48 pierced layer with its seam running straight down the middle from
// the top edge: base (20, 0), pointing down, 28 texels long, opening 12 wide.
function seamPart() {
  const part = makePart('flesh', { w: 40, h: 48, x: 100, y: 100 });
  part.pierceRole = PierceRole.PIERCED;
  for (let i = 0; i < 40 * 48; i++) part.pierceRegion.add(i);
  part.pierceRegionVersion++;
  part.pierceDentDepth = 28;
  part.pierceDentWidth = 12;
  part.pierceDentPlaced = true;
  part.pierceDentX = 20;
  part.pierceDentY = 0;
  part.pierceDentAngle = Math.PI / 2;
  part.mesh = generateMesh(part, defaultDensity(part));
  return part;
}

const open = (part, fraction, s, halfWidth = 3) => openingFor(part, {
  fraction, tip: { u: 20, v: s }, tipHalfWidth: halfWidth,
});
const profile = (o, from = -4, to = 34, step = 0.05) => {
  const out = [];
  for (let s = from; s <= to + 1e-9; s += step) out.push({ s, a: openingAmplitude(o, s) });
  return out;
};

// ---------------------------------------------------------------------------
section('1. The shape: a soft bulge that tracks the tip');
{
  resetOpeningCaches();
  const part = seamPart();

  check('closed at the Dent Trigger Distance (fraction 0), and with no marker size', () => {
    assert.equal(open(part, 0, 5), null);
    const flat = seamPart(); flat.pierceDentWidth = 0;
    assert.equal(open(flat, 0.5, 5), null);
  });

  check('at shallow depth only a small, local bulge appears at the contact point', () => {
    const o = open(part, 0.1, 0);
    const p = profile(o);
    const peak = Math.max(...p.map((x) => x.a));
    assert.ok(peak > 0 && peak <= 0.1 * 6 + 1e-9, `peak ${peak}`);
    const reached = Math.max(...p.filter((x) => x.a > 1e-6).map((x) => x.s));
    assert.ok(reached < 12, `deformed out to s=${reached.toFixed(2)} of a 28-texel seam`);
    assert.equal(openingAmplitude(o, 20), 0);
  });

  check('the widest point follows the tip down the seam', () => {
    for (const s of [3, 8, 13, 18]) {
      const p = profile(open(part, 0.6, s));
      const top = p.reduce((a, b) => (b.a > a.a ? b : a));
      assert.ok(Math.abs(top.s - s) <= 0.06, `tip at ${s}, widest at ${top.s.toFixed(2)}`);
    }
  });

  check('deeper means wider, and the deformed stretch of edge reaches further', () => {
    let lastPeak = -1;
    let lastReach = -1;
    for (const f of [0.2, 0.4, 0.6, 0.8, 1]) {
      const o = open(part, f, 8);
      const p = profile(o);
      const peak = Math.max(...p.map((x) => x.a));
      const reach = Math.max(...p.filter((x) => x.a > 0.02).map((x) => x.s));
      assert.ok(peak > lastPeak && reach >= lastReach, `f ${f}: peak ${peak.toFixed(2)} reach ${reach.toFixed(2)}`);
      lastPeak = peak; lastReach = reach;
    }
  });

  check('ahead of the tip it eases back to the closed seam; behind it, it rests against the piercer', () => {
    const o = open(part, 1, 10, 3);
    assert.equal(openingAmplitude(o, 10 + o.ahead), 0);
    const behind = openingAmplitude(o, 2);
    assert.ok(behind > 0.4 * o.peak && behind < o.peak, `behind ${behind.toFixed(2)} vs peak ${o.peak}`);
  });

  check('closed at both ends of the seam: nothing at the apex, nothing outside the surface', () => {
    const o = open(part, 1, 27);
    assert.equal(openingAmplitude(o, 28), 0);
    assert.equal(openingAmplitude(o, 30), 0);
    assert.equal(openingAmplitude(o, -o.closeOut), 0);
  });

  // A corner is a jump in SLOPE that stays the same size however finely the
  // curve is sampled; on a smooth curve the change in slope between
  // neighbouring samples shrinks in step with the spacing. So the slope
  // change is measured at two spacings, ten times apart.
  const slopeJump = (o, h) => {
    const p = profile(o, -4, 32, h);
    let worst = 0;
    for (let i = 1; i < p.length - 1; i++) {
      worst = Math.max(worst, Math.abs((p[i + 1].a - p[i].a) - (p[i].a - p[i - 1].a)) / h);
    }
    return worst;
  };
  check('smooth: no jumps and no corners along the seam, at any depth', () => {
    for (const f of [0.15, 0.5, 1]) {
      for (const s0 of [0, 9, 20, 27]) {
        const o = open(part, f, s0);
        const p = profile(o, -4, 32, 0.01);
        let jump = 0;
        for (let i = 1; i < p.length; i++) jump = Math.max(jump, Math.abs(p[i].a - p[i - 1].a));
        const coarse = slopeJump(o, 0.01);
        const fine = slopeJump(o, 0.001);
        assert.ok(jump < 0.02 && fine < 0.2 * coarse + 1e-6, `f ${f} tip ${s0}: step ${jump.toExponential(2)}, slope change ${coarse.toExponential(2)} -> ${fine.toExponential(2)}`);
      }
    }
  });

  // Each pass moves every point along `across` by its field. Folding is
  // that map running backwards somewhere: a point further out landing
  // nearer in. So, along every row across the seam, where each point ends
  // up must keep increasing -- and, the other way, the material may stretch
  // but never more than about double. Over the whole row, both sides of the
  // line, in both passes.
  check('never folds, and stretches no more than about double, in either pass', () => {
    for (const f of [0.15, 0.3, 1]) {
      for (const tip of [0, 12, 27]) {
        const o = open(part, f, tip);
        let least = Infinity;
        let most = 0;
        for (const pass of [-1, 1]) {
          for (let v = 0; v < 48; v += 0.5) {
            for (let u = 0; u < 40; u += 0.05) {
              // t runs along -x here (across is (-1, 0)), so step u backwards.
              const at = (x) => seamCoordinates(o, x, v).t + openingDisplacement(o, x, v, pass);
              const rate = (at(u) - at(u + 0.05)) / 0.05;
              least = Math.min(least, rate);
              most = Math.max(most, rate);
            }
          }
        }
        assert.ok(least > 0.3 && most < 2.4, `f ${f} tip ${tip}: ${least.toFixed(3)}..${most.toFixed(3)}`);
      }
    }
  });

  check('each pass is the true push on its own side, and continuous -- in value and slope -- across the line', () => {
    const o = open(part, 0.8, 12);
    for (let v = 0; v < 30; v += 0.5) {
      for (const pass of [-1, 1]) {
        // Own side: exactly the side's outward push.
        const own = 20 - pass * 3; // 3 texels into that side (side B is smaller u)
        assert.ok(Math.abs(openingDisplacement(o, own, v, pass) - pass * openingShift(o, own, v, pass)) < 1e-12);
        // Across the line: no jump, no kink.
        const e = 1e-4;
        const l = openingDisplacement(o, 20 - e, v, pass);
        const r = openingDisplacement(o, 20 + e, v, pass);
        const l2 = openingDisplacement(o, 20 - 2 * e, v, pass);
        const r2 = openingDisplacement(o, 20 + 2 * e, v, pass);
        assert.ok(Math.abs(l - r) < 1e-3 && Math.abs((l2 - l) - (r - r2)) < 1e-3, `v ${v} pass ${pass}: ${l} vs ${r}`);
      }
    }
  });

  check('the seam\'s edges part only round the tip: closed ahead of it, and never past its outline', () => {
    for (const f of [0.2, 0.6, 1]) {
      for (const tip of [2, 12, 22]) {
        const o = open(part, f, tip, 3);
        for (let s = -3; s <= 30; s += 0.05) {
          for (const side of [-1, 1]) {
            const rim = openingRim(o, s, side);
            assert.ok(rim <= openingCover(o, s, side) + 1e-12 && rim <= openingAmplitude(o, s) + 1e-12, `f ${f} tip ${tip} s ${s.toFixed(2)}`);
            if (s >= tip) assert.equal(rim, 0, `open ahead of the tip at s ${s.toFixed(2)}`);
          }
        }
      }
    }
  });

  check('a tip still outside the surface swells it without opening it', () => {
    const o = openingFor(part, { fraction: 0.4, tip: { u: 20, v: -3 }, tipHalfWidth: 3 });
    assert.ok(openingAmplitude(o, 0) > 0.5, `swelling ${openingAmplitude(o, 0)}`);
    for (let s = -2; s <= 28; s += 0.1) assert.equal(openingRim(o, s, 1) + openingRim(o, s, -1), 0);
  });

  check('the rim follows the real outline on each side: an off-centre tip opens one side further', () => {
    // A tip 6 texels wide whose middle is 2 texels to side B of the seam
    // (across is -x, so side B is smaller u).
    const points = [];
    for (let v = 0; v <= 10; v++) for (let u = 15; u <= 20; u++) points.push({ u: u + 0.5 - 0.5, v: v + 0.5 });
    const o = openingFor(part, { fraction: 1, tip: { u: 18, v: 10.5 }, tipHalfWidth: 3, tipPoints: points });
    const a = openingRim(o, 5, -1);
    const b = openingRim(o, 5, 1);
    assert.ok(b > a + 1 && b <= openingCover(o, 5, 1) && a <= openingCover(o, 5, -1), `side A ${a.toFixed(2)}, side B ${b.toFixed(2)}`);
  });

  check('pure: the same contact gives exactly the same opening, so backing out retraces it', () => {
    const a = open(part, 0.7, 9);
    const b = open(part, 0.7, 9);
    assert.deepEqual(profile(a), profile(b));
  });
}

// ---------------------------------------------------------------------------
section('2. The refined mesh and the two passes');
{
  resetOpeningCaches();
  const part = seamPart();
  const mesh = part.mesh;
  const refined = refinedMesh(mesh, part);

  // A deliberately non-affine pose: every coarse vertex nudged its own way.
  const coarse = { positions: mesh.vertices.map((vx, i) => ({ x: 100 + vx.u + Math.sin(i * 1.7) * 0.8, y: 100 + vx.v + Math.cos(i * 2.3) * 0.8 })) };
  const mapThrough = (positions, uvs, triangles, u, v) => {
    for (let t = 0; t < triangles.length; t += 3) {
      const [a, b, c] = [triangles[t], triangles[t + 1], triangles[t + 2]];
      const A = uvs[a]; const B = uvs[b]; const C = uvs[c];
      const den = (B.v - C.v) * (A.u - C.u) + (C.u - B.u) * (A.v - C.v);
      if (Math.abs(den) < 1e-12) continue;
      const l0 = ((B.v - C.v) * (u - C.u) + (C.u - B.u) * (v - C.v)) / den;
      const l1 = ((C.v - A.v) * (u - C.u) + (A.u - C.u) * (v - C.v)) / den;
      const l2 = 1 - l0 - l1;
      if (l0 < -1e-9 || l1 < -1e-9 || l2 < -1e-9) continue;
      return { x: l0 * positions[a].x + l1 * positions[b].x + l2 * positions[c].x, y: l0 * positions[a].y + l1 * positions[b].y + l2 * positions[c].y };
    }
    return null;
  };

  check(`refined ${refined.k}x${refined.k}: ${mesh.triangles.length / 3} triangles became ${refined.triangles.length / 3}`, () => {
    assert.ok(refined.k >= 2 && refined.triangles.length / 3 === (mesh.triangles.length / 3) * refined.k * refined.k);
  });

  check('closed, the refined mesh draws every texel EXACTLY where the layer\'s own mesh does, in any pose', () => {
    const o = { ...open(part, 1, 10), peak: 0 }; // an opening with no push at all
    const flat = openingGeometry(part, coarse, o, 1);
    let worst = 0;
    for (let v = 0.25; v < 48; v += 1.5) {
      for (let u = 0.25; u < 40; u += 1.5) {
        const a = mapThrough(coarse.positions, mesh.vertices, mesh.triangles, u, v);
        const b = mapThrough(flat.positions, flat.uvs, flat.triangles, u, v);
        if (!a || !b) continue;
        worst = Math.max(worst, Math.hypot(a.x - b.x, a.y - b.y));
      }
    }
    assert.ok(worst < 1e-9, `worst ${worst}`);
  });

  check('no T-junctions: every refined edge is shared by at most two triangles, and the outline is the original\'s', () => {
    const count = new Map();
    const T = refined.triangles;
    for (let t = 0; t < T.length; t += 3) {
      for (const [a, b] of [[T[t], T[t + 1]], [T[t + 1], T[t + 2]], [T[t + 2], T[t]]]) {
        const key = a < b ? `${a}-${b}` : `${b}-${a}`;
        count.set(key, (count.get(key) || 0) + 1);
      }
    }
    assert.ok([...count.values()].every((n) => n <= 2));
    const edgeLength = (uvs, keys) => keys.reduce((sum, key) => { const [a, b] = key.split('-').map(Number); return sum + Math.hypot(uvs[a].u - uvs[b].u, uvs[a].v - uvs[b].v); }, 0);
    const coarseCount = new Map();
    const C = mesh.triangles;
    for (let t = 0; t < C.length; t += 3) {
      for (const [a, b] of [[C[t], C[t + 1]], [C[t + 1], C[t + 2]], [C[t + 2], C[t]]]) {
        const key = a < b ? `${a}-${b}` : `${b}-${a}`;
        coarseCount.set(key, (coarseCount.get(key) || 0) + 1);
      }
    }
    const outline = edgeLength(refined.uvs, [...count].filter(([, n]) => n === 1).map(([k]) => k));
    const coarseOutline = edgeLength(mesh.vertices, [...coarseCount].filter(([, n]) => n === 1).map(([k]) => k));
    assert.ok(Math.abs(outline - coarseOutline) < 1e-6, `${outline} vs ${coarseOutline}`);
  });

  check('the two sides are complementary: every texel is drawn by exactly one pass', () => {
    const o = open(part, 1, 10);
    const { a, b } = openingSides(part, o);
    for (let i = 0; i < 40 * 48; i++) assert.equal(a[i] + b[i], 1);
  });

  const atRest = { positions: mesh.vertices.map((vx) => ({ x: 100 + vx.u, y: 100 + vx.v })) };
  const o = open(part, 1, 12);
  const passA = openingGeometry(part, atRest, o, -1);
  const passB = openingGeometry(part, atRest, o, 1);

  check('each pass moves every point exactly by its field, straight along the seam\'s across direction', () => {
    const along = (p, q) => (p.x - q.x) * o.across.x + (p.y - q.y) * o.across.y;
    const sideways = (p, q) => (p.x - q.x) * o.inward.x + (p.y - q.y) * o.inward.y;
    let worst = 0;
    refined.uvs.forEach((uv, i) => {
      const rest = { x: 100 + uv.u, y: 100 + uv.v };
      for (const [pass, g] of [[-1, passA], [1, passB]]) {
        worst = Math.max(worst,
          Math.abs(along(g.positions[i], rest) - openingDisplacement(o, uv.u, uv.v, pass)),
          Math.abs(sideways(g.positions[i], rest)));
      }
    });
    assert.ok(worst < 1e-9, `worst ${worst}`);
  });

  check('on the seam the two sides part by exactly their two rims, each outward', () => {
    let widest = 0;
    for (let v = 0; v <= 30; v += 0.25) {
      // Just to side B of the line (smaller u) in pass B, just to side A in pass A.
      const b = openingDisplacement(o, 20 - 1e-9, v, 1);
      const a = openingDisplacement(o, 20 + 1e-9, v, -1);
      const { s } = seamCoordinates(o, 20, v);
      const rims = openingRim(o, s, -1) + openingRim(o, s, 1);
      assert.ok(b >= -1e-9 && a <= 1e-9 && Math.abs(b - a - rims) < 1e-6, `v ${v}: ${b} - ${a} vs ${rims}`);
      widest = Math.max(widest, rims);
    }
    assert.ok(widest > 4, `widest ${widest}`);
  });

  check('beside the seam the material swells outward further than the rim, widest round the tip (within its half-width of the leading point)', () => {
    // Four texels to side B (smaller u), along the seam.
    let best = { s: 0, d: 0 };
    for (let s = 0; s <= 27; s += 0.25) {
      const d = openingShift(o, 20 - 4, s, 1);
      if (d > best.d) best = { s, d };
    }
    assert.ok(best.d > openingRim(o, best.s, 1) + 0.5 && Math.abs(best.s - o.sTip) <= 3.5, `widest ${best.d.toFixed(2)} at s ${best.s} (tip ${o.sTip})`);
  });

  check('away from the seam, and past its far end, neither pass moves anything', () => {
    refined.uvs.forEach((uv, i) => {
      const { s, t } = seamCoordinates(o, uv.u, uv.v);
      if (Math.abs(t) < o.lateral && s < o.length && s > -o.closeOut) return;
      assert.ok(Math.abs(passA.positions[i].x - (100 + uv.u)) < 1e-9 && Math.abs(passB.positions[i].x - (100 + uv.u)) < 1e-9);
    });
  });

  check('no triangle turns inside out in either pass, at full depth anywhere along the seam', () => {
    for (const sTip of [0, 6, 14, 27]) {
      const oo = open(part, 1, sTip);
      for (const side of [-1, 1]) {
        const g = openingGeometry(part, atRest, oo, side);
        const T = g.triangles;
        for (let t = 0; t < T.length; t += 3) {
          const [a, b, c] = [g.positions[T[t]], g.positions[T[t + 1]], g.positions[T[t + 2]]];
          const [A, B, C] = [g.uvs[T[t]], g.uvs[T[t + 1]], g.uvs[T[t + 2]]];
          const before = (B.u - A.u) * (C.v - A.v) - (B.v - A.v) * (C.u - A.u);
          const after = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
          assert.ok(Math.sign(before) === Math.sign(after) && Math.abs(after) > 1e-9, `tip ${sTip} side ${side} triangle ${t / 3}`);
        }
      }
    }
  });

  // Every triangle of both passes keeps its winding, and none is squeezed
  // to less than a fifth of its area: what a fold, or the brink of one,
  // would show.
  const foldFree = (part, oo) => {
    const rest = { positions: part.mesh.vertices.map((vx) => ({ x: 100 + vx.u, y: 100 + vx.v })) };
    let thinnest = Infinity;
    for (const side of [-1, 1]) {
      const pass = openingGeometry(part, rest, oo, side);
      const T = pass.triangles;
      for (let t = 0; t < T.length; t += 3) {
        const [a, b, c] = [pass.positions[T[t]], pass.positions[T[t + 1]], pass.positions[T[t + 2]]];
        const [A, B, C] = [pass.uvs[T[t]], pass.uvs[T[t + 1]], pass.uvs[T[t + 2]]];
        const before = (B.u - A.u) * (C.v - A.v) - (B.v - A.v) * (C.u - A.u);
        const after = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
        thinnest = Math.min(thinnest, after / before);
      }
    }
    return thinnest;
  };

  check('a pin right beside a deep, wide opening bends the material round it -- never folds it', () => {
    const wide = seamPart();
    wide.pierceDentWidth = 24; // a 12-texel swelling
    // 14 texels off the seam, where the swelling is at its height. (With the
    // pin's ordinary one-cell band this folds: -0.10 of a triangle's area.)
    for (let v = 4; v < 16; v++) for (let u = 34; u < 38; u++) wide.pins.add(v * 40 + u);
    wide.pinsVersion++;
    for (const tip of [4, 9, 14]) {
      const thinnest = foldFree(wide, openingFor(wide, { fraction: 1, tip: { u: 20, v: tip }, tipHalfWidth: 3 }));
      assert.ok(thinnest > 0.3, `tip ${tip}: thinnest triangle kept ${thinnest.toFixed(3)} of its area`);
    }
  });

  check('a painted Deformable region limits the opening to itself, eased over its edge -- never a fold at the edge', () => {
    const limited = seamPart();
    limited.pierceDentWidth = 24;
    // Only a band 8 texels either side of the seam gives.
    for (let v = 0; v < 48; v++) for (let u = 12; u < 28; u++) limited.pierceDeformRegion.add(v * 40 + u);
    limited.pierceDeformRegionVersion = (limited.pierceDeformRegionVersion || 0) + 1;
    const oo = openingFor(limited, { fraction: 1, tip: { u: 20, v: 10 }, tipHalfWidth: 3 });
    const thinnest = foldFree(limited, oo);
    const g = openingGeometry(limited, { positions: limited.mesh.vertices.map((vx) => ({ x: 100 + vx.u, y: 100 + vx.v })) }, oo, 1);
    const r = refinedMesh(limited.mesh, limited);
    let outside = 0;
    let inside = 0;
    r.uvs.forEach((uv, i) => {
      const moved = Math.abs(g.positions[i].x - (100 + uv.u));
      if (uv.u <= 11.5 || uv.u >= 28.5) outside = Math.max(outside, moved);
      if (uv.u >= 17 && uv.u <= 19 && uv.v >= 6 && uv.v <= 12) inside = Math.max(inside, moved);
    });
    assert.ok(thinnest > 0.2 && outside < 1e-9 && inside > 1, `thinnest ${thinnest.toFixed(3)}, outside moved ${outside}, inside ${inside.toFixed(2)}`);
  });

  check('pinned artwork holds against the opening (Px Pin\'s own smooth influence)', () => {
    // Pins across the seam just ahead of the tip, where the bulge would
    // otherwise be; the stretch behind the tip is left free.
    const pinned = seamPart();
    for (let v = 16; v < 26; v++) for (let u = 6; u < 34; u++) pinned.pins.add(v * 40 + u);
    const r = refinedMesh(pinned.mesh, pinned);
    const rest = { positions: pinned.mesh.vertices.map((vx) => ({ x: 100 + vx.u, y: 100 + vx.v })) };
    const oo = open(pinned, 1, 14);
    const g = openingGeometry(pinned, rest, oo, 1);
    const bare = openingGeometry(seamPart(), rest, oo, 1);
    let held = 0;
    let wouldHave = 0;
    let free = 0;
    r.uvs.forEach((uv, i) => {
      const moved = Math.hypot(g.positions[i].x - (100 + uv.u), g.positions[i].y - (100 + uv.v));
      if (uv.u >= 10 && uv.u <= 30 && uv.v >= 18 && uv.v <= 22) {
        held = Math.max(held, moved);
        wouldHave = Math.max(wouldHave, Math.hypot(bare.positions[i].x - (100 + uv.u), bare.positions[i].y - (100 + uv.v)));
      }
      if (uv.u >= 17 && uv.u <= 23 && uv.v >= 4 && uv.v <= 8) free = Math.max(free, moved);
    });
    assert.ok(held < 0.05 && wouldHave > 0.5 && free > 0.5, `pinned moved ${held.toFixed(3)} (unpinned it would move ${wouldHave.toFixed(3)}), free ${free.toFixed(3)}`);
  });
}

// ---------------------------------------------------------------------------
section('3. Driven by the live contact');
{
  partsStore._parts.length = 0;
  resetPierceContainment();
  resetOpeningCaches();
  const pierced = seamPart();
  // A needle centred over the seam, tip at the bottom of its sprite.
  const piercer = makePart('needle', { w: 8, h: 24, x: 116, y: 40 });
  piercer.pierceRole = PierceRole.PIERCER;
  for (let v = 20; v < 24; v++) for (let u = 1; u < 7; u++) piercer.pierceRegion.add(v * 8 + u);
  piercer.pierceRegionVersion++;
  piercer.pierceEnter = DEFAULT_PIERCE_ENTER;
  piercer.pierceEnd = DEFAULT_PIERCE_END;
  // Unlocked for the growth checks: the shape follows the needle all the way
  // to the End Point. The Wedge Lock Point is checked on its own below.
  check('a new piercer\'s Wedge Lock Point is half way', () => {
    assert.equal(piercer.pierceWedgeLock, DEFAULT_WEDGE_LOCK);
    assert.equal(DEFAULT_WEDGE_LOCK, 50);
  });
  piercer.pierceWedgeLock = 100;
  partsStore.add(pierced);
  partsStore.add(piercer);

  const read = (y) => {
    piercer.y = y;
    markPierceStale();
    resetPierceContainment();
    const contact = contactOf(piercer, pierced, null);
    markPierceStale();
    return { contact, opening: pierceOpeningOf(pierced) };
  };

  const sweep = [];
  for (let y = 50; y <= 110; y += 2) sweep.push({ y, ...read(y) });
  const opened = sweep.filter((r) => r.opening);

  check('no marker issue on a seam placed over artwork', () => {
    assert.equal(pierceDentIssue(pierced), null);
  });

  check('closed until the Dent Trigger Distance, then opening as the needle comes in', () => {
    assert.ok(sweep[0].opening === null && opened.length > 5, `${opened.length} open frames`);
  });

  check('how open grows with depth and never shrinks on the way in', () => {
    for (let i = 1; i < opened.length; i++) assert.ok(opened[i].opening.fraction >= opened[i - 1].opening.fraction - 1e-12);
  });

  check('the bulge travels down the seam with the tip, and stays on the placed seam', () => {
    const along = opened.map((r) => r.opening.sTip);
    for (let i = 1; i < along.length; i++) assert.ok(along[i] >= along[i - 1] - 1e-9);
    assert.ok(along[along.length - 1] > along[0] + 4, `from ${along[0].toFixed(1)} to ${along[along.length - 1].toFixed(1)}`);
    const m = openingMarker(pierced);
    assert.ok(opened.every((r) => r.opening.base.x === m.base.x && r.opening.base.y === m.base.y));
  });

  check('behind the tip the edges rest against the needle\'s own width', () => {
    const last = opened[opened.length - 1].opening;
    assert.ok(last.hug > 0.3 && last.hug <= 0.85, `hug ${last.hug}`);
  });

  check('backing out retraces it exactly, and closes completely', () => {
    const back = [];
    for (let y = 110; y >= 50; y -= 2) back.push({ y, ...read(y) });
    for (const r of back) {
      const fwd = sweep.find((x) => x.y === r.y);
      assert.equal(Boolean(r.opening), Boolean(fwd.opening));
      if (r.opening) assert.ok(Math.abs(r.opening.fraction - fwd.opening.fraction) < 1e-12 && Math.abs(r.opening.sTip - fwd.opening.sTip) < 1e-12);
    }
    assert.equal(back[back.length - 1].opening, null);
  });

  check('the contact is measured on the CLOSED layer: opening it never moves the flesh it measures', () => {
    read(100);
    const flesh = deformVertices(pierced.mesh, pierced, {});
    assert.ok(flesh.every((p, i) => p.x === 100 + pierced.mesh.vertices[i].u && p.y === 100 + pierced.mesh.vertices[i].v));
  });

  check('a marker dragged off the artwork is reported, and opens nothing', () => {
    pierced.pierceDentX = -60;
    assert.ok(/no artwork/.test(pierceDentIssue(pierced) || ''));
    assert.equal(read(100).opening, null);
    pierced.pierceDentX = 20;
  });

  // --- The Wedge Lock Point.
  //
  // 75% of the way from the trigger (gap 12) to the End Point (gap -12) is a
  // gap of -6: the needle's tip 6 texels in.
  const both = (opening) => {
    if (!opening) return null;
    const rest = { positions: pierced.mesh.vertices.map((vx) => ({ x: 100 + vx.u, y: 100 + vx.v })) };
    return [-1, 1].map((side) => openingGeometry(pierced, rest, opening, side).positions);
  };
  const lockSweep = (lock) => {
    piercer.pierceWedgeLock = lock;
    const rows = [];
    for (let y = 50; y <= 110; y += 1) rows.push({ y, ...read(y) });
    return rows;
  };
  const locked = lockSweep(75);
  const unlocked = lockSweep(100);
  const past = locked.filter((r) => r.contact && r.contact.dentT > 0.75 + 1e-9);
  const before = locked.filter((r) => r.contact && r.contact.dentT > 0 && r.contact.dentT <= 0.75);

  check('up to the Wedge Lock Point the opening grows exactly as it does with no lock at all', () => {
    assert.ok(before.length > 10, `${before.length} frames before the lock`);
    for (const r of before) {
      const free = unlocked.find((x) => x.y === r.y).opening;
      assert.equal(r.opening.fraction, free.fraction);
      assert.equal(r.opening.sTip, free.sTip);
      assert.deepEqual(both(r.opening), both(free));
    }
  });

  check('past it the shape is FROZEN: every frame from the lock to the End Point and beyond draws the identical opening', () => {
    assert.ok(past.length > 10, `${past.length} frames past the lock`);
    const first = both(past[0].opening);
    for (const r of past) {
      assert.equal(r.opening.fraction, 0.75);
      const g = both(r.opening);
      let worst = 0;
      for (let side = 0; side < 2; side++) {
        for (let i = 0; i < g[side].length; i++) {
          worst = Math.max(worst, Math.hypot(g[side][i].x - first[side][i].x, g[side][i].y - first[side][i].y));
        }
      }
      assert.ok(worst < 1e-9, `y ${r.y}: moved ${worst}`);
    }
  });

  check('and it is the very shape the opening had AT the lock -- not a different one it jumps to', () => {
    // Exactly at the lock: the needle placed so the gap is -6.
    const atLock = locked.find((r) => r.contact && Math.abs(r.contact.dentT - 0.75) < 1e-9);
    assert.ok(atLock, 'a frame exactly at the lock');
    assert.deepEqual(both(atLock.opening), both(past[0].opening));
    const free = unlocked.find((x) => x.y === atLock.y).opening;
    assert.deepEqual(both(atLock.opening), both(free));
  });

  check('the needle itself keeps going in past the lock, in step with the depth', () => {
    const tips = past.map((r) => r.contact.tip.y);
    for (let i = 1; i < tips.length; i++) assert.ok(tips[i] >= tips[i - 1]);
    const inPast = past.filter((r) => r.contact.dentT < 1);
    assert.ok(inPast.length > 3 && inPast.at(-1).contact.tip.y - inPast[0].contact.tip.y > 3, `the tip moved ${(inPast.at(-1).contact.tip.y - inPast[0].contact.tip.y).toFixed(1)} px past the lock`);
    assert.ok(inPast.at(-1).contact.dentT > inPast[0].contact.dentT, 'and the depth kept climbing');
  });

  check('backing out: held while past the lock, then closing through the same shapes it opened through', () => {
    piercer.pierceWedgeLock = 75;
    const back = [];
    for (let y = 110; y >= 50; y -= 1) back.push({ y, ...read(y) });
    for (const r of back) {
      const fwd = locked.find((x) => x.y === r.y);
      assert.equal(Boolean(r.opening), Boolean(fwd.opening));
      if (r.opening) assert.deepEqual(both(r.opening), both(fwd.opening));
    }
    assert.equal(back.at(-1).opening, null);
  });

  check('the lock is saved with the piercer, and a project from before it loads at half way', () => {
    assert.equal(clampWedgeLock(0), 1);
    assert.equal(clampWedgeLock(250), 100);
    assert.equal(clampWedgeLock('x'), DEFAULT_WEDGE_LOCK);
    partsStore.setPierceDepths(piercer.id, 12, 24, 12, 65);
    assert.equal(piercer.pierceWedgeLock, 65);
    partsStore.setPierceDepths(piercer.id, 12, 24, 12);
    assert.equal(piercer.pierceWedgeLock, 65, 'left alone when not given');
  });
}

console.log(results.join('\n'));
console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
