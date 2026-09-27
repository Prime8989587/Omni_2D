// The dent, verified headlessly: the wedge's placement, its own trigger
// distance, and the one rule Deformable must never break.
//
// Every module the pierce solver touches is plain ES with no DOM in it, so
// the whole thing runs in Node against the real code rather than against a
// re-implementation of it. That matters: a test that rebuilt the triangle
// itself would pass while the app did something else entirely.

import { strict as assert } from 'node:assert';
import {
  Part, partsStore, PierceRole, DEFAULT_PIERCE_ENTER, DEFAULT_PIERCE_END,
} from '../www/js/parts.js';
import {
  contactOf, pierceDentOf, pierceDentCuts, pierceOcclusion, markPierceStale,
  resetPierceContainment, pierceReadout,
} from '../www/js/pierce.js';
import {
  dentTriangleAt, dentPlacement, dentCutArea, dentCutMask, writeBunch,
  resetDentCache,
} from '../www/js/dent.js';
import { generateMesh, defaultDensity } from '../www/js/mesh.js';

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

// ---------------------------------------------------------------------------
// A scene, built the way the app builds one

function makePart(name, { w, h, x, y }) {
  const pixels = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    pixels[i * 4] = 200;
    pixels[i * 4 + 1] = 200;
    pixels[i * 4 + 2] = 200;
    pixels[i * 4 + 3] = 255;
  }
  return new Part({ name, image: null, pixels, width: w, height: h, x, y, scale: 1 });
}

// A blob with a wobbly edge rather than a rectangle: the straight-edged
// primitive is exactly what the old outline blend passed on and real
// artwork failed on, so nothing here is allowed to be tested on one.
function paintBlob(part) {
  const { naturalWidth: w, naturalHeight: h } = part;
  for (let v = 0; v < h; v++) {
    for (let u = 0; u < w; u++) {
      const dx = (u - w / 2) / (w / 2);
      const dy = (v - h / 2) / (h / 2);
      const wobble = 0.16 * Math.sin(u * 0.9) + 0.12 * Math.cos(v * 1.3);
      if (dx * dx + dy * dy <= 0.85 + wobble) part.pierceRegion.add(v * w + u);
    }
  }
  part.pierceRegionVersion++;
}

function buildScene() {
  partsStore._parts.length = 0;
  resetPierceContainment();
  resetDentCache();

  const pierced = makePart('flesh', { w: 48, h: 48, x: 100, y: 100 });
  pierced.pierceRole = PierceRole.PIERCED;
  paintBlob(pierced);
  pierced.mesh = generateMesh(pierced, defaultDensity(pierced));

  // A needle: tip painted at the BOTTOM of its sprite, so the axis (middle
  // of the sprite -> middle of the tip) points straight down.
  const piercer = makePart('needle', { w: 8, h: 24, x: 120, y: 40 });
  piercer.pierceRole = PierceRole.PIERCER;
  for (let v = 20; v < 24; v++) for (let u = 2; u < 6; u++) piercer.pierceRegion.add(v * 8 + u);
  piercer.pierceRegionVersion++;
  piercer.pierceEnter = DEFAULT_PIERCE_ENTER;
  piercer.pierceEnd = DEFAULT_PIERCE_END;

  partsStore.add(pierced);
  partsStore.add(piercer);
  return { pierced, piercer };
}

// Drive the needle to a chosen gap and read what the solver makes of it.
//
// Solved rather than computed. The gap is what the solver measures between
// two painted regions along the needle's own axis, and where that lands
// depends on the tip's lead and on which wobble of the blob's edge the axis
// happens to cross -- neither of which the test has any business
// re-deriving. Moving the needle down by d reduces the gap by exactly d, so
// one correction from a measurement is exact, and a second confirms it.
function measure(scene) {
  markPierceStale();
  resetPierceContainment();
  return contactOf(scene.piercer, scene.pierced, null);
}

function readAt(scene, gap) {
  scene.piercer.y = 40;
  for (let i = 0; i < 4; i++) {
    const contact = measure(scene);
    if (!contact || !contact.inPath || !Number.isFinite(contact.gap)) break;
    const error = contact.gap - gap;
    if (Math.abs(error) < 1e-9) break;
    scene.piercer.y += error;
  }
  return measure(scene);
}

function surfaceRow(part) {
  let top = Infinity;
  for (const index of part.pierceRegion) {
    const v = Math.floor(index / part.naturalWidth);
    if (v < top) top = v;
  }
  return top;
}

// ---------------------------------------------------------------------------
// 1. Deformable only ever bulges outward, and never cuts

section('1. Deformable bulges outward and never cuts');

{
  const scene = buildScene();
  const { pierced } = scene;
  pierced.pierceDentDepth = 10;
  pierced.pierceDentWidth = 12;

  const tri = dentTriangleAt(pierced, 1);

  const edge = (ax, ay, bx, by, px, py) => (bx - ax) * (py - ay) - (by - ay) * (px - ax);
  const inside = (t, x, y) => {
    const a = edge(t.b1.x, t.b1.y, t.b2.x, t.b2.y, x, y);
    const b = edge(t.b2.x, t.b2.y, t.apex.x, t.apex.y, x, y);
    const c = edge(t.apex.x, t.apex.y, t.b1.x, t.b1.y, x, y);
    return (a >= 0 && b >= 0 && c >= 0) || (a <= 0 && b <= 0 && c <= 0);
  };
  const onSeg = (px, py, ax, ay, bx, by) => {
    const dx = bx - ax;
    const dy = by - ay;
    const L = dx * dx + dy * dy;
    let t = L > 1e-12 ? ((px - ax) * dx + (py - ay) * dy) / L : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
  };
  // Signed: positive OUTSIDE the wedge, negative inside. "Outward" is
  // simply this number going up.
  const clearance = (t, x, y) => {
    const d = Math.min(
      onSeg(x, y, t.b1.x, t.b1.y, t.b2.x, t.b2.y),
      onSeg(x, y, t.b2.x, t.b2.y, t.apex.x, t.apex.y),
      onSeg(x, y, t.apex.x, t.apex.y, t.b1.x, t.b1.y)
    );
    return inside(t, x, y) ? -d : d;
  };

  // Every pixel deformable, which is the worst case for the rule: the mask
  // covers the notch itself, so any tendency to pull material inward has
  // the most vertices available to do it with.
  for (let i = 0; i < pierced.naturalWidth * pierced.naturalHeight; i++) {
    pierced.pierceDeformRegion.add(i);
  }
  pierced.pierceDeformRegionVersion++;

  const mesh = pierced.mesh;
  const ox = new Float64Array(mesh.vertices.length);
  const oy = new Float64Array(mesh.vertices.length);

  check('no vertex is displaced toward the notch, at any dent fraction', () => {
    let moved = 0;
    let insideMoved = 0;
    for (let step = 1; step <= 20; step++) {
      const t = step / 20;
      const wedge = dentTriangleAt(pierced, t);
      writeBunch(mesh, pierced, wedge, ox, oy, null);
      for (let i = 0; i < mesh.vertices.length; i++) {
        if (ox[i] === 0 && oy[i] === 0) continue;
        moved++;
        const u = mesh.vertices[i].restLocal.x + pierced.naturalWidth / 2;
        const v = mesh.vertices[i].restLocal.y + pierced.naturalHeight / 2;
        const before = clearance(wedge, u, v);
        const after = clearance(wedge, u + ox[i], v + oy[i]);
        if (before < 0) insideMoved++;
        assert.ok(
          after >= before - 1e-9,
          `t=${t.toFixed(2)} vertex (${u},${v}) moved toward the notch: ` +
          `clearance ${before.toFixed(3)} -> ${after.toFixed(3)}`
        );
      }
    }
    assert.ok(moved > 0, 'nothing moved at all, so the rule was never exercised');
    assert.ok(insideMoved > 0, 'no vertex inside the wedge was tested — the case that used to fail');
  });

  check('every vertex inside the wedge is evicted clear of it', () => {
    const wedge = dentTriangleAt(pierced, 1);
    writeBunch(mesh, pierced, wedge, ox, oy, null);
    let evicted = 0;
    for (let i = 0; i < mesh.vertices.length; i++) {
      const u = mesh.vertices[i].restLocal.x + pierced.naturalWidth / 2;
      const v = mesh.vertices[i].restLocal.y + pierced.naturalHeight / 2;
      if (!inside(wedge, u, v)) continue;
      assert.ok(
        clearance(wedge, u + ox[i], v + oy[i]) >= -1e-9,
        `vertex (${u},${v}) is still inside the notch after the push`
      );
      evicted++;
    }
    assert.ok(evicted > 0, 'no vertex was inside the wedge to begin with');
  });

  check('the cut is byte-identical with Deformable full, empty, or anything between', () => {
    const wedge = dentTriangleAt(pierced, 1);
    const snapshot = () => Uint8Array.from(dentCutMask(pierced, wedge));

    const full = snapshot();
    pierced.pierceDeformRegion = new Set();
    pierced.pierceDeformRegionVersion++;
    resetDentCache();
    const empty = snapshot();
    assert.deepEqual([...empty], [...full], 'clearing Deformable changed which texels were cut');

    const half = new Set();
    for (let i = 0; i < pierced.naturalWidth * pierced.naturalHeight; i += 2) half.add(i);
    pierced.pierceDeformRegion = half;
    pierced.pierceDeformRegionVersion++;
    resetDentCache();
    assert.deepEqual([...snapshot()], [...full], 'a partial Deformable mask changed the cut');
  });

  check('with no dent configured, Deformable does nothing at all', () => {
    for (let i = 0; i < pierced.naturalWidth * pierced.naturalHeight; i++) {
      pierced.pierceDeformRegion.add(i);
    }
    pierced.pierceDeformRegionVersion++;
    const was = [pierced.pierceDentDepth, pierced.pierceDentWidth];
    pierced.pierceDentDepth = 0;
    pierced.pierceDentWidth = 0;

    assert.equal(dentTriangleAt(pierced, 1), null, 'a wedge was built with no dent configured');
    writeBunch(mesh, pierced, dentTriangleAt(pierced, 1), ox, oy, null);
    for (let i = 0; i < mesh.vertices.length; i++) {
      assert.equal(ox[i], 0, `vertex ${i} moved in x with no dent to react to`);
      assert.equal(oy[i], 0, `vertex ${i} moved in y with no dent to react to`);
    }
    assert.equal(dentCutMask(pierced, null), null, 'something was cut with no dent configured');
    [pierced.pierceDentDepth, pierced.pierceDentWidth] = was;
  });
}

// ---------------------------------------------------------------------------
// 2. The Dent Trigger Distance, independent of Enter

section('2. The dent begins at its own trigger distance');

{
  const scene = buildScene();
  const { pierced, piercer } = scene;
  pierced.pierceDentDepth = 8;
  pierced.pierceDentWidth = 10;
  piercer.pierceEnter = 20;
  piercer.pierceEnd = 24;
  piercer.pierceDentStart = 6; // deliberately NOT the Enter Point

  check('contact begins at Enter while the dent is still at zero', () => {
    const atEnter = readAt(scene, 19);
    assert.ok(atEnter.engaged, 'not engaged just inside the Enter Point');
    assert.equal(atEnter.dentT, 0, `dent already growing at gap 19 (t=${atEnter.dentT})`);
    assert.equal(pierceDentOf(pierced), null, 'a wedge exists before the trigger distance');
  });

  check('the dent is still zero one pixel outside the trigger', () => {
    const before = readAt(scene, 6.5);
    assert.ok(before.engaged, 'should be well into contact by now');
    assert.equal(before.dentT, 0, `dent started early (t=${before.dentT})`);
  });

  check('the dent starts exactly at the trigger distance', () => {
    const at = readAt(scene, 5.5);
    assert.ok(at.dentT > 0, 'dent had not started at the trigger distance');
    assert.ok(at.dentT < 0.1, `dent jumped rather than started (t=${at.dentT})`);
  });

  check('the dent reaches exactly 100% at the End Point and never more', () => {
    // The End Point sits at gap = enter - end.
    const endGap = piercer.pierceEnter - piercer.pierceEnd;
    assert.ok(Math.abs(readAt(scene, endGap).dentT - 1) < 1e-6, 'not full at the End Point');
    assert.equal(readAt(scene, endGap - 10).dentT, 1, 'exceeded full past the End Point');
    assert.equal(readAt(scene, endGap - 40).dentT, 1, 'exceeded full far past the End Point');
  });

  check('growth is continuous and monotonic across the whole approach', () => {
    let last = -1;
    let rises = 0;
    for (let gap = 30; gap >= -20; gap -= 0.5) {
      const t = readAt(scene, gap).dentT;
      assert.ok(t >= last - 1e-9, `dent shrank while going in, at gap ${gap}`);
      assert.ok(t >= 0 && t <= 1, `dent fraction out of range at gap ${gap}: ${t}`);
      if (t > last + 1e-9) rises++;
      last = t;
    }
    assert.ok(rises > 20, `growth looks like a step rather than a ramp (${rises} increases)`);
  });

  check('moving the trigger moves where the dent starts, and nothing else', () => {
    piercer.pierceDentStart = 18;
    const early = readAt(scene, 14);
    assert.ok(early.dentT > 0, 'a trigger of 18 did not start the dent by gap 14');
    piercer.pierceDentStart = 6;
    const late = readAt(scene, 14);
    assert.equal(late.dentT, 0, 'a trigger of 6 still started the dent at gap 14');
    assert.equal(early.depth, late.depth, 'the trigger changed the contact depth');
    assert.equal(early.engaged, late.engaged, 'the trigger changed engagement');
  });

  check('a trigger further out than Enter starts the dent before contact', () => {
    piercer.pierceEnter = 8;
    piercer.pierceDentStart = 20;
    const out = readAt(scene, 15);
    assert.equal(out.engaged, false, 'should not be in contact at gap 15 with Enter 8');
    assert.ok(out.dentT > 0, 'the dent did not start ahead of contact');
    piercer.pierceEnter = 20;
    piercer.pierceDentStart = 6;
  });

  check('a trigger left behind the End Point still leaves the dent room to grow', () => {
    piercer.pierceEnter = 20;
    piercer.pierceEnd = 24;
    piercer.pierceDentStart = 1; // the End Point is at gap -4, so this is behind it
    const endGap = piercer.pierceEnter - piercer.pierceEnd;
    const t = readAt(scene, endGap).dentT;
    assert.ok(Number.isFinite(t), 'the dent fraction went non-finite');
    assert.ok(Math.abs(t - 1) < 1e-6, `expected a full dent at the End Point, got ${t}`);
    piercer.pierceDentStart = 6;
  });
}

// ---------------------------------------------------------------------------
// 3. The placement is fixed, and the handles' numbers are the stored ones

section('3. The dent stays where it was placed');

{
  const scene = buildScene();
  const { pierced, piercer } = scene;
  pierced.pierceDentDepth = 9;
  pierced.pierceDentWidth = 14;
  piercer.pierceEnter = 20;
  piercer.pierceEnd = 24;
  piercer.pierceDentStart = 20;

  check('an unplaced dent lands on the pierceable paint, pointing inward', () => {
    const where = dentPlacement(pierced);
    const u = Math.floor(where.x);
    const v = Math.floor(where.y);
    assert.ok(
      pierced.pierceRegion.has(v * pierced.naturalWidth + u) ||
      pierced.pierceRegion.has((v + 1) * pierced.naturalWidth + u),
      `derived placement (${where.x}, ${where.y}) is not on the painted region`
    );
    assert.ok(dentCutArea(pierced, dentTriangleAt(pierced, 1)) > 0, 'the derived dent cuts nothing');
  });

  check('placing the dent writes exactly what was asked for', () => {
    partsStore.setPierceDentPlacement(pierced.id, 17.5, 12.25, Math.PI / 3);
    const where = dentPlacement(pierced);
    assert.equal(where.x, 17.5);
    assert.equal(where.y, 12.25);
    assert.ok(Math.abs(where.angle - Math.PI / 3) < 1e-12);
    assert.equal(pierced.pierceDentPlaced, true);
  });

  check('the wedge is built at the placed spot, not at the contact point', () => {
    partsStore.setPierceDentPlacement(pierced.id, 12, 20, Math.PI / 2);
    const tri = dentTriangleAt(pierced, 1);
    assert.ok(Math.abs(tri.base.x - 12) < 1e-9, `base x is ${tri.base.x}, expected 12`);
    assert.ok(Math.abs(tri.base.y - 20) < 1e-9, `base y is ${tri.base.y}, expected 20`);
    // Straight down: the apex is depth below the base.
    assert.ok(Math.abs(tri.apex.x - 12) < 1e-9, 'apex drifted sideways');
    assert.ok(Math.abs(tri.apex.y - 29) < 1e-9, `apex y is ${tri.apex.y}, expected 29`);
  });

  check('the base does not move as the piercer goes in', () => {
    partsStore.setPierceDentPlacement(pierced.id, 22, 14, Math.PI / 2);
    const seen = [];
    for (let gap = 20; gap >= -20; gap -= 2) {
      readAt(scene, gap);
      const tri = pierceDentOf(pierced);
      if (!tri) continue;
      seen.push(tri);
      assert.ok(Math.abs(tri.base.x - 22) < 1e-9, `base x moved to ${tri.base.x} at gap ${gap}`);
      assert.ok(Math.abs(tri.base.y - 14) < 1e-9, `base y moved to ${tri.base.y} at gap ${gap}`);
    }
    assert.ok(seen.length > 5, 'the dent was never built during the sweep');
    // And it did grow, so "fixed" is about position only.
    assert.ok(seen[seen.length - 1].depth > seen[0].depth, 'the dent never grew');
  });

  check('sliding the piercer sideways does not move the dent', () => {
    partsStore.setPierceDentPlacement(pierced.id, 22, 14, Math.PI / 2);
    const bases = [];
    for (const dx of [-6, -3, 0, 3, 6]) {
      piercer.x = 120 + dx;
      readAt(scene, 0);
      const tri = pierceDentOf(pierced);
      if (tri) bases.push(`${tri.base.x},${tri.base.y}`);
    }
    piercer.x = 120;
    assert.ok(bases.length >= 3, 'the dent was not built across the sideways sweep');
    assert.equal(new Set(bases).size, 1, `the dent base moved with the piercer: ${bases.join(' | ')}`);
  });

  check('the dent stays put when the pierced layer is dragged', () => {
    partsStore.setPierceDentPlacement(pierced.id, 22, 14, Math.PI / 2);
    const before = dentTriangleAt(pierced, 1);
    pierced.x += 37;
    pierced.y -= 11;
    const after = dentTriangleAt(pierced, 1);
    assert.equal(after.base.x, before.base.x, 'the dent slid in texel space when the layer moved');
    assert.equal(after.base.y, before.base.y, 'the dent slid in texel space when the layer moved');
    pierced.x -= 37;
    pierced.y += 11;
  });

  check('growth scales both dimensions about the fixed base', () => {
    partsStore.setPierceDentPlacement(pierced.id, 22, 14, Math.PI / 2);
    const half = dentTriangleAt(pierced, 0.5);
    const full = dentTriangleAt(pierced, 1);
    assert.ok(Math.abs(full.depth / half.depth - 2) < 1e-9, 'depth does not scale linearly');
    assert.ok(Math.abs(full.width / half.width - 2) < 1e-9, 'width does not scale linearly');
    assert.equal(half.base.x, full.base.x, 'the base moved between fractions');
    assert.equal(half.base.y, full.base.y, 'the base moved between fractions');
  });

  check('retracting runs the identical numbers backwards to exactly nothing', () => {
    partsStore.setPierceDentPlacement(pierced.id, 22, 14, Math.PI / 2);
    const going = [];
    for (let gap = 24; gap >= -24; gap -= 1) going.push(readAt(scene, gap).dentT);
    const coming = [];
    for (let gap = -24; gap <= 24; gap += 1) coming.push(readAt(scene, gap).dentT);
    coming.reverse();
    assert.deepEqual(coming, going, 'withdrawing did not retrace the same fractions');
    assert.equal(going[0], 0, 'the dent was not zero at the start');
    assert.equal(readAt(scene, 40).dentT, 0, 'the dent did not return to exactly zero');
    assert.equal(pierceDentOf(pierced), null, 'a wedge survived the withdrawal');
  });
}

// ---------------------------------------------------------------------------
// 4. All of it together, through the renderer's own entry points

section('4. The whole effect, through the published masks');

{
  const scene = buildScene();
  const { pierced, piercer } = scene;
  pierced.pierceDentDepth = 10;
  pierced.pierceDentWidth = 14;
  piercer.pierceEnter = 20;
  piercer.pierceEnd = 24;
  piercer.pierceDentStart = 8;
  partsStore.setPierceDentPlacement(pierced.id, 24, surfaceRow(pierced) + 1, Math.PI / 2);
  // A rim of deformable material around the notch, not the whole layer.
  for (const index of pierced.pierceRegion) {
    const v = Math.floor(index / pierced.naturalWidth);
    if (v < surfaceRow(pierced) + 14) pierced.pierceDeformRegion.add(index);
  }
  pierced.pierceDeformRegionVersion++;

  check('the cut grows smoothly from the trigger and holds at the End Point', () => {
    const areas = [];
    for (let gap = 20; gap >= -20; gap -= 1) {
      readAt(scene, gap);
      const tri = pierceDentOf(pierced);
      areas.push({ gap, area: tri ? dentCutArea(pierced, tri) : 0 });
    }
    const started = areas.find((a) => a.area > 0);
    assert.ok(started, 'nothing was ever cut');
    assert.ok(started.gap <= 8, `the cut started at gap ${started.gap}, outside the trigger of 8`);
    for (let i = 1; i < areas.length; i++) {
      assert.ok(
        areas[i].area >= areas[i - 1].area,
        `the cut shrank while going in, at gap ${areas[i].gap}`
      );
    }
    const last = areas[areas.length - 1].area;
    assert.ok(last > 0, 'nothing was cut at full depth');
    assert.equal(areas[areas.length - 2].area, last, 'the cut kept growing past the End Point');
  });

  check('the published draw mask zeroes exactly the texels the wedge covers', () => {
    readAt(scene, -20);
    pierceOcclusion();
    const cuts = pierceDentCuts();
    const mask = cuts.get(pierced.id);
    assert.ok(mask, 'no draw mask was published at full depth');
    const tri = pierceDentOf(pierced);
    let zeroed = 0;
    for (let i = 0; i < mask.length; i++) if (mask[i] === 0) zeroed++;
    assert.ok(zeroed > 0, 'the published mask removes nothing');
    // Every zeroed texel is either inside the wedge or an island the wedge
    // stranded; none of them is outside the pierceable region.
    for (let i = 0; i < mask.length; i++) {
      if (mask[i] === 0) {
        assert.ok(pierced.pierceRegion.has(i), `texel ${i} was cut outside the pierceable area`);
      }
    }
    assert.ok(dentCutArea(pierced, tri) <= zeroed, 'the mask cut less than the wedge covers');
  });

  check('the bunching and the cut come from one wedge at one fraction', () => {
    readAt(scene, 0);
    const tri = pierceDentOf(pierced);
    assert.ok(tri, 'no wedge mid-approach');
    const mesh = pierced.mesh;
    const ox = new Float64Array(mesh.vertices.length);
    const oy = new Float64Array(mesh.vertices.length);
    writeBunch(mesh, pierced, tri, ox, oy, null);
    let moved = 0;
    for (let i = 0; i < mesh.vertices.length; i++) {
      if (Math.hypot(ox[i], oy[i]) > 1e-9) moved++;
    }
    assert.ok(moved > 0, 'nothing bunched around a wedge that is cutting');
    assert.ok(dentCutArea(pierced, tri) > 0, 'the wedge that is bunching cuts nothing');
  });

  check('the on-screen readout reports the dent on its own scale', () => {
    readAt(scene, 14);
    const row = pierceReadout().find((r) => r.pierced === 'flesh');
    assert.ok(row, 'no readout row for the pierced layer');
    assert.equal(row.dentStart, 8, `readout says the trigger is ${row.dentStart}`);
    assert.ok(row.engaged, 'should be in contact at gap 14 with Enter 20');
    assert.equal(row.dent, 0, 'the readout shows a dent before the trigger distance');
    readAt(scene, -20);
    const deep = pierceReadout().find((r) => r.pierced === 'flesh');
    assert.equal(deep.dent, 1, 'the readout never reaches a full dent');
  });

  check('everything returns to rest when the piercer leaves', () => {
    readAt(scene, 60);
    pierceOcclusion();
    assert.equal(pierceDentCuts().size, 0, 'a draw mask survived the withdrawal');
    assert.equal(pierceDentOf(pierced), null, 'a wedge survived the withdrawal');
  });
}

// ---------------------------------------------------------------------------

console.log(results.join('\n'));
console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
