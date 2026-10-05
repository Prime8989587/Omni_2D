// Interactive: outlines that touch, push, and spring back.
//
// Every check runs the real step (stepInteractive) frame by frame, the way
// physics.js runs it, against layers measured where they are DRAWN (mesh.js
// deformVertices, and the renderer's own drawing for the fold check). What
// has to hold, each tested on its own:
//
//   * the contact: only the faces the movement runs into are pushed; sliding
//     along a layer pushes nothing; pulling back lets go;
//   * the push: in the direction the toucher is actually moving, 0.8 of the
//     way it presses in, and back to exactly nothing when the touch ends --
//     on the spring of a physics bone with the same stiffness and damping;
//   * the structure: seven pieces linked into one, one of them touched, all
//     seven moved by the same amount and all seven home again;
//   * the holds: a waistband painted onto a body that holds its ground lifts
//     round the hand and stays on the body at both ends; a body on rigid
//     bones holds, a breast on a spring bone follows; never a fold;
//   * brush vs points: painted glue peels smoothly, point rivets kink;
//   * saving, loading and the shared contact measure Pierce still uses.

import { Part, partsStore, InteractiveResponse } from '../www/js/parts.js';
import { bonesStore, DEFAULT_STIFFNESS, DEFAULT_DAMPING } from '../www/js/bones.js';
import { bindPart, deformVertices } from '../www/js/mesh.js';
import { pxlinkStore, initPxLink, sceneToTexel, ensureLinkMesh, linkPositions } from '../www/js/pxlink.js';
import {
  initInteractive, stepInteractive, interactiveDebug, describeStructure, resetInteractive,
  holdsGround, interactiveFieldOf, CONTACT_GAIN,
} from '../www/js/interactive.js';
import { pushAt } from '../www/js/interactState.js';
import {
  frontPress, elongation, isThinElongated, outlineSamples, pressOf, axialGap,
} from '../www/js/contact.js';
import { layerDrawGeometry } from '../www/js/canvas.js';
import { serializeProject, applyProject } from '../www/js/project.js';
import { PierceRole } from '../www/js/parts.js';
import { pierceReadout, pierceOpenings, pierceOcclusion, markPierceStale } from '../www/js/pierce.js';

initPxLink();
initInteractive();

let passed = 0;
let total = 0;
const say = (ok, name, detail = '') => {
  total++;
  if (ok) passed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}`);
  if (detail) console.log(`          ${detail}`);
};
const f2 = (v) => v.toFixed(2);

function image(w, h, rgb, inside = () => true) {
  const pixels = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (inside(x, y)) pixels.set([...rgb, 255], (y * w + x) * 4);
  return pixels;
}
function layer(name, w, h, x, y, rgb = [200, 100, 100], inside) {
  const part = new Part({ name, pixels: image(w, h, rgb, inside), width: w, height: h, x, y });
  partsStore.add(part);
  return part;
}
function reset() {
  pxlinkStore.replaceAll([]);
  partsStore.replaceAll([], null);
  bonesStore.replaceAll([], null);
  resetInteractive();
}
const T = () => (bonesStore.isEmpty ? {} : bonesStore.snapshotTransforms());
const DT = 1 / 60;
function frames(n, each = () => {}) {
  for (let i = 0; i < n; i++) { each(i); stepInteractive(DT); }
}
// Where a layer is drawn: the middle of its deformed vertices (selected).
function middle(part, keep = () => true) {
  ensureLinkMesh(part);
  const P = deformVertices(part.mesh, part, T()).filter((p, i) => keep(part.mesh.vertices[i]));
  return { x: P.reduce((s, p) => s + p.x, 0) / P.length, y: P.reduce((s, p) => s + p.y, 0) / P.length };
}
const moved = (a, b) => ({ x: b.x - a.x, y: b.y - a.y });
function nearestVertex(part, u, v) {
  ensureLinkMesh(part);
  return part.mesh.vertices.reduce((best, w) => (Math.hypot(w.u - u, w.v - v) < Math.hypot(best.u - u, best.v - v) ? w : best));
}
function gives(part) {
  partsStore.setInteractive(part.id, true);
  partsStore.setInteractiveResponse(part.id, InteractiveResponse.GIVES);
}
function solid(part) {
  partsStore.setInteractive(part.id, true);
}
// Links painted where layers overlap: every listed scene cell's centre, as a
// texel of each layer -- what the PxLink window's brush records.
function brushLink(a, b, cells, anchor) {
  const pa = [];
  const pb = [];
  for (const [x, y] of cells) {
    const ta = sceneToTexel(a, { x: x + 0.5, y: y + 0.5 }, T());
    const tb = sceneToTexel(b, { x: x + 0.5, y: y + 0.5 }, T());
    pa.push({ u: ta.u, v: ta.v });
    pb.push({ u: tb.u, v: tb.v });
  }
  return pxlinkStore.add({ kind: 'brush', members: [{ partId: a.id, points: pa }, { partId: b.id, points: pb }], anchorId: anchor ? anchor.id : null });
}
function pointLink(a, b, x, y, anchor) {
  const ta = sceneToTexel(a, { x, y }, T());
  const tb = sceneToTexel(b, { x, y }, T());
  return pxlinkStore.add({ members: [{ partId: a.id, u: ta.u, v: ta.v }, { partId: b.id, u: tb.u, v: tb.v }], anchorId: anchor ? anchor.id : null });
}
// Triangles drawn turned over (signed area against the texture's): a fold.
function folds(part) {
  const g = layerDrawGeometry(part, T());
  let flipped = 0;
  for (let t = 0; t < g.triangles.length; t += 3) {
    const [a, b, c] = [0, 1, 2].map((k) => g.triangles[t + k]);
    const area = (p, q, r) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
    const uv = (i) => ({ x: g.uvs[i].u, y: g.uvs[i].v });
    const rest = area(uv(a), uv(b), uv(c));
    const drawn = area(g.positions[a], g.positions[b], g.positions[c]);
    if (Math.abs(rest) > 1e-9 && rest * drawn <= 0) flipped++;
  }
  return flipped;
}

// ---------------------------------------------------------------------------
console.log('Contact: the shared measure');
{
  const bar = { naturalWidth: 20, naturalHeight: 2, pixels: image(20, 2, [1, 1, 1]) };
  const shape = elongation(bar);
  say(Math.abs(shape.length - 20) < 1e-9 && Math.abs(shape.thickness - 2) < 1e-9 && isThinElongated(bar),
    'a 20x2 band reads 20 long, 2 thick, and long-and-thin', `${f2(shape.length)} x ${f2(shape.thickness)}`);
  const diagonal = { naturalWidth: 30, naturalHeight: 30, pixels: image(30, 30, [1, 1, 1], (x, y) => Math.abs(x - y) <= 1) };
  say(isThinElongated(diagonal), 'a diagonal strap is long and thin too (measured along its own length)',
    `${f2(elongation(diagonal).length)} x ${f2(elongation(diagonal).thickness)}`);
  const square = { naturalWidth: 12, naturalHeight: 12, pixels: image(12, 12, [1, 1, 1]) };
  say(!isThinElongated(square), 'a square is not');
  say(outlineSamples({ naturalWidth: 3, naturalHeight: 1, pixels: image(3, 1, [1, 1, 1]) }).count === 8,
    'a one-pixel line has an outline sample on every exposed side (3 above, 3 below, 2 ends)');
  // Pierce's press, from the module both now import it from.
  say(pressOf({ engaged: true, t: 1, overshoot: 30, end: 12 }) === 2 && pressOf({ engaged: false, t: 1 }) === 0,
    'pressOf is Pierce\'s: capped at 2, nothing when not engaged');
  const gap = axialGap([{ x: 0, y: 5 }], [{ x: 0, y: 10 }], { x: 0, y: 5 }, 1, { x: 0, y: 1 });
  say(gap && gap.gap === 5, 'axialGap is Pierce\'s: 5 px still to go along the axis');

  // A hand (square outline) and a band's top face.
  const hand = [];
  for (let x = 0; x <= 6; x++) { hand.push({ x, y: 0 }); hand.push({ x, y: 6 }); }
  for (let y = 0; y <= 6; y++) { hand.push({ x: 0, y }); hand.push({ x: 6, y }); }
  const band = [];
  for (let x = -10; x <= 16; x++) {
    band.push({ x, y: 4, nx: 0, ny: -1 });
    band.push({ x, y: 6, nx: 0, ny: 1 });
  }
  band.push({ x: -10, y: 5, nx: -1, ny: 0 });
  band.push({ x: 16, y: 5, nx: 1, ny: 0 });
  const down = frontPress(hand, band, { x: 0, y: 1 }, { x: 3, y: 3 });
  say(down && Math.abs(down.depth - 2) < 1e-9, 'moving down into the band\'s top face: pressed 2 px', down ? `depth ${down.depth}` : 'no press');
  const along = frontPress(hand, band, { x: 1, y: 0 }, { x: 3, y: 3 });
  say(along === null, 'sliding along the band: nothing pressed (its faces are side-on to the movement)');
  const up = frontPress(hand, band, { x: 0, y: -1 }, { x: 3, y: 3 });
  say(up === null, 'pulling back up out of it: nothing pressed (what it pressed is behind it)');
}

// ---------------------------------------------------------------------------
console.log('One band, one hand');
{
  reset();
  const band = layer('Band', 24, 2, 40, 60);
  const hand = layer('Hand', 8, 8, 48, 40);
  gives(band);
  solid(hand);
  say(band.interactiveStiffness === DEFAULT_STIFFNESS && band.interactiveDamping === DEFAULT_DAMPING,
    'a layer\'s push spring starts as a physics bone\'s (180, 8)');
  frames(2);
  const rest = middle(band);
  frames(60, (i) => { if (i < 20) hand.y += 1; });
  const pushed = moved(rest, middle(band));
  const intrusion = hand.y + 8 - 60;
  say(Math.abs(pushed.x) < 1e-6 && Math.abs(pushed.y - intrusion * CONTACT_GAIN / (1 + CONTACT_GAIN)) < 0.05,
    `pushed straight down, 0.8 of the ${intrusion} px the hand pressed in`, `(${f2(pushed.x)}, ${f2(pushed.y)})`);
  const dbg = interactiveDebug();
  say(dbg.contacts.length === 1 && dbg.contacts[0].axis.y === 1, 'the push points the way the hand moved', JSON.stringify(dbg.contacts[0].axis));
  say(!holdsGround(band) && holdsGround(hand), 'Gives way follows, Solid holds its ground');
  const swing = [];
  frames(120, (i) => { if (i < 20) hand.y -= 1; swing.push(middle(band).y - rest.y); });
  const crossings = swing.slice(1).filter((v, i) => Math.sign(v) !== Math.sign(swing[i]) && Math.abs(v) > 0.01).length;
  const back = moved(rest, middle(band));
  say(crossings >= 2 && Math.hypot(back.x, back.y) < 1e-9 && interactiveDebug().structures.length === 0,
    'hand withdrawn: it springs back -- overshooting like a spring bone -- and comes to rest exactly home',
    `${crossings} overshoots, home within ${Math.hypot(back.x, back.y).toExponential(1)} px`);

  // A diagonal approach pushes diagonally.
  frames(5);
  hand.x = 36; hand.y = 44;
  frames(3);
  const rest2 = middle(band);
  frames(40, (i) => { if (i < 12) { hand.x += 1; hand.y += 1; } });
  const diag = moved(rest2, middle(band));
  say(diag.x > 0.5 && diag.y > 0.5 && Math.abs(diag.x - diag.y) < 0.05,
    'moving down and to the right into it pushes it down and to the right', `(${f2(diag.x)}, ${f2(diag.y)})`);

  // A layer that is not Interactive is never touched.
  reset();
  const plain = layer('Plain', 24, 2, 40, 60);
  const hand2 = layer('Hand', 8, 8, 48, 40);
  solid(hand2);
  frames(40, (i) => { if (i < 20) hand2.y += 1; });
  say(!plain.mesh && !interactiveFieldOf(plain), 'a layer that is not Interactive is not pushed');
}

// ---------------------------------------------------------------------------
console.log('Seven pieces, one structure');
{
  reset();
  const pieces = [];
  for (let i = 0; i < 7; i++) pieces.push(layer(`Piece ${i + 1}`, 10, 6, 10 + i * 8, 80, [100 + i * 20, 80, 160]));
  for (let i = 0; i < 6; i++) pointLink(pieces[i], pieces[i + 1], 19.5 + i * 8, 83);
  gives(pieces[3]);
  const hand = layer('Hand', 6, 6, 37, 60);
  solid(hand);
  const s = describeStructure(pieces[3]);
  say(s.moves.length === 6 && s.heldBy.length === 0, 'touching piece 4 pushes all six others with it, held by nothing', s.moves.join(', '));
  frames(2);
  const rest = pieces.map((p) => middle(p));
  frames(50, (i) => { if (i < 22) hand.y += 1; });
  const pushed = pieces.map((p, i) => moved(rest[i], middle(p)));
  const spread = Math.max(...pushed.map((d) => Math.hypot(d.x - pushed[3].x, d.y - pushed[3].y)));
  say(pushed[3].y > 5 && spread < 1e-9, 'all seven moved together, by exactly the same amount',
    pushed.map((d) => f2(d.y)).join(' '));
  frames(150, (i) => { if (i < 22) hand.y -= 1; });
  const back = pieces.map((p, i) => Math.hypot(...Object.values(moved(rest[i], middle(p)))));
  say(Math.max(...back) < 1e-9, 'and all seven sprang back home together', `worst ${Math.max(...back).toExponential(1)} px`);
}

// ---------------------------------------------------------------------------
console.log('A waistband on a body');
function waistband(mode) {
  reset();
  const body = layer('Body', 40, 30, 20, 50, [240, 200, 180]);
  const band = layer('Band', 24, 2, 28, 56, [200, 60, 120]);
  const root = bonesStore.addBone({ head: { x: 40.5, y: 51.5 }, tail: { x: 40.5, y: 78.5 }, name: 'root' });
  bonesStore.setAttachedPart(root.id, body.id);
  bindPart(body, bonesStore);
  gives(band);
  const hand = layer('Hand', 6, 6, 37, 40, [120, 90, 200]);
  solid(hand);
  const cells = [];
  if (mode === 'brush') {
    for (let x = 28; x < 52; x++) for (let y = 56; y < 58; y++) cells.push([x, y]);
    brushLink(body, band, cells, body);
  } else if (mode === 'ends') {
    pointLink(body, band, 28.5, 57, body);
    pointLink(body, band, 51.5, 57, body);
  } else {
    for (const x of [28.5, 36.5, 44.5, 51.5]) pointLink(body, band, x, 57, body);
  }
  frames(2);
  frames(60, (i) => { if (i < 20) hand.y += 1; });
  // The band's middle line as drawn, texel by texel.
  const field = interactiveFieldOf(band);
  const row = [];
  for (let u = 0; u < 24; u++) row.push(field ? pushAt(field, 28 + u + 0.5, 57).y : 0);
  const slope = Math.max(...row.slice(1).map((v, i) => Math.abs(v - row[i])));
  const lifted = row.filter((v) => v > 1).length / row.length;
  return { body, band, hand, row, slope, lifted, flips: folds(band), structure: describeStructure(band) };
}
{
  const brush = waistband('brush');
  say(brush.structure.heldBy[0] === 'Body' && brush.structure.brushHolds === 1,
    'painted on with Brush along its length; the body (rigid bone) holds it');
  say(holdsGround(brush.body), 'a body on rigid bones holds its ground');
  const peak = Math.max(...brush.row);
  say(peak > 5 && brush.row[0] < 0.5 && brush.row[23] < 0.5,
    'pulled by the hand it lifts round it, and stays on the body at both ends', brush.row.map(f2).join(' '));
  say(brush.flips === 0, 'drawn without a single folded triangle', `${brush.flips} flipped`);
  const ends = waistband('ends');
  say(ends.structure.pointHolds === 2 && ends.structure.thin, 'the same band held by a point at each end');
  say(brush.lifted < 0.75 && ends.lifted > 0.75,
    'Brush keeps it on the body along its length, lifting only round the hand; held at its ends, the whole span lifts',
    `lifted over 1 px: brush ${Math.round(brush.lifted * 100)}%, ends ${Math.round(ends.lifted * 100)}% -- ${ends.row.map(f2).join(' ')}`);
  const rivets = waistband('rivets');
  say(rivets.structure.pointHolds === 4, 'the same band riveted at four points along it');
  say(Math.max(...rivets.row) < Math.max(...brush.row) / 2,
    'Brush glue peels round the pull; a rivet beside the hand does not let go, so the band barely lifts there',
    `peak: brush ${f2(Math.max(...brush.row))} px, rivets ${f2(Math.max(...rivets.row))} px -- ${rivets.row.map(f2).join(' ')}`);
  say(rivets.flips === 0 && ends.flips === 0, 'neither folds', `${rivets.flips} / ${ends.flips} flipped`);
  frames(150, (i) => { if (i < 20) rivets.hand.y -= 1; });
  say(interactiveDebug().structures.length === 0 && !interactiveFieldOf(rivets.band), 'and lies back down when the hand lets go');
}

// ---------------------------------------------------------------------------
console.log('A strap pulls its cup, the cup the breast');
{
  reset();
  const body = layer('Body', 60, 90, 20, 20, [240, 200, 180]);
  const breast = layer('Breast', 22, 26, 39, 56, [230, 180, 165], (x, y) => ((x - 11) / 11) ** 2 + ((y - 13) / 13) ** 2 <= 1);
  const cup = layer('Cup', 24, 14, 38, 68, [200, 60, 120]);
  const strap = layer('Strap', 20, 38, 50, 30, [200, 60, 120], (x, y) => Math.abs(x - (16 - (y * 16) / 36)) <= 1.5);
  const hand = layer('Hand', 8, 8, 62, 62, [120, 90, 200]);
  const root = bonesStore.addBone({ head: { x: 50.5, y: 25.5 }, tail: { x: 50.5, y: 105.5 }, name: 'root' });
  bonesStore.setAttachedPart(root.id, body.id);
  const spring = bonesStore.addBone({ parentId: root.id, head: { x: 50.5, y: 58.5 }, tail: { x: 50.5, y: 78.5 }, name: 'breast' });
  bonesStore.setAttachedPart(spring.id, breast.id);
  bindPart(body, bonesStore);
  bindPart(breast, bonesStore);
  bonesStore.setJointType(spring.id, 'physics');
  pointLink(body, strap, 66.5, 31.5, body);
  const ends = [];
  for (let x = 49; x <= 53; x++) for (let y = 64; y <= 67; y++) if (strap.pixels[((y - 30) * 20 + (x - 50)) * 4 + 3]) ends.push([x, y]);
  brushLink(strap, cup, ends, strap);
  const over = [];
  for (let x = 42; x <= 57; x++) for (let y = 70; y <= 76; y++) over.push([x, y]);
  brushLink(cup, breast, over, cup);
  const top = [];
  for (let x = 44; x <= 56; x++) for (let y = 57; y <= 58; y++) if (breast.pixels[((y - 56) * 22 + (x - 39)) * 4 + 3]) top.push([x, y]);
  brushLink(body, breast, top, body);
  gives(strap);
  solid(hand);
  const s = describeStructure(strap);
  say(s.moves.join() === 'Cup,Breast' && s.heldBy.join() === 'Body',
    'the strap takes the cup and the breast (on a spring bone) with it; the body holds them', JSON.stringify(s));
  say(!holdsGround(breast) && holdsGround(body), 'a breast on a spring bone follows, the body on its rigid bone holds');
  frames(2);
  const sel = {
    shoulder: [strap, (v) => v === nearestVertex(strap, 16.5, 1.5)],
    cup: [cup, () => true],
    breastLow: [breast, (v) => v.v > 18],
    body: [body, () => true],
  };
  const rest = Object.fromEntries(Object.entries(sel).map(([k, [p, keep]]) => [k, middle(p, keep)]));
  frames(70, (i) => { if (i < 12) { hand.y -= 1; if (i % 3 === 0) hand.x -= 1; } });
  const d = Object.fromEntries(Object.entries(sel).map(([k, [p, keep]]) => [k, moved(rest[k], middle(p, keep))]));
  say(d.cup.y < -1 && Math.abs(d.cup.y - d.breastLow.y) < 0.05,
    'lifting the strap lifts the cup, and the breast under it by the same amount',
    `cup (${f2(d.cup.x)}, ${f2(d.cup.y)}), breast (${f2(d.breastLow.x)}, ${f2(d.breastLow.y)})`);
  say(Math.hypot(d.body.x, d.body.y) < 1e-9, 'the body does not move', `(${f2(d.body.x)}, ${f2(d.body.y)})`);
  const rivet = linkPositions(T()).find((entry) => entry.kind === 'point').members.find((m) => m.partId === strap.id);
  const atRivet = pushAt(interactiveFieldOf(strap), rivet.x, rivet.y);
  say(Math.hypot(atRivet.x, atRivet.y) < 1e-9 && Math.hypot(d.shoulder.x, d.shoulder.y) < Math.hypot(d.cup.x, d.cup.y) / 2,
    'the strap stays on at the shoulder: not pushed at all at its rivet, less than half as far a few texels off it',
    `at the rivet ${Math.hypot(atRivet.x, atRivet.y).toExponential(1)} px, nearest vertex (${f2(d.shoulder.x)}, ${f2(d.shoulder.y)})`);
  const flips = [strap, cup, breast].map(folds);
  say(flips.every((n) => n === 0), 'nothing folds', `flipped: strap ${flips[0]}, cup ${flips[1]}, breast ${flips[2]}`);
  frames(180, (i) => { if (i < 12) hand.y += 1; });
  const home = Object.entries(sel).map(([k, [p, keep]]) => Math.hypot(...Object.values(moved(rest[k], middle(p, keep)))));
  say(Math.max(...home) < 1e-9, 'let go, all of it settles home', `worst ${Math.max(...home).toExponential(1)} px`);
}

// ---------------------------------------------------------------------------
console.log('A wedge at a body seam: Pierce, configured for clothing');
{
  reset();
  // Two halves meeting at x = 60; panties below, the gusset their tip.
  const left = layer('LeftHalf', 30, 40, 30, 40, [235, 190, 170]);
  const right = layer('RightHalf', 30, 40, 60, 40, [225, 180, 160]);
  const pants = layer('Panties', 30, 30, 45, 86, [90, 140, 220], (x, y) => y >= 18 || Math.abs(x + 0.5 - 15) <= 3.5);
  for (const half of [left, right]) {
    partsStore.setPierceRole(half.id, PierceRole.PIERCED);
    const cells = [];
    for (let v = 20; v < 40; v++) for (let u = 0; u < 30; u++) if (Math.abs(half.x + u + 0.5 - 60) <= 6) cells.push(v * 30 + u);
    partsStore.setPierceRegion(half.id, cells, true);
    const mu = 60 - half.x;
    partsStore.setPierceMirror(half.id, mu, 0, mu, 40);
    partsStore.setPierceDent(half.id, 16, 8);
    partsStore.setPierceDentPlacement(half.id, mu, 40, -Math.PI / 2);
  }
  partsStore.setPierceRole(pants.id, PierceRole.PIERCER);
  partsStore.setPierceDepths(pants.id, 4, 18, 4, 100);
  const tip = [];
  for (let v = 0; v < 18; v++) for (let u = 0; u < 30; u++) if (pants.pixels[(v * 30 + u) * 4 + 3]) tip.push(v * 30 + u);
  partsStore.setPierceRegion(pants.id, tip, true);
  pants.y -= 20;
  markPierceStale();
  const read = pierceReadout();
  const openings = pierceOpenings();
  const [a, b] = [left, right].map((half) => openings.get(half.id));
  say(read.every((r) => r.engaged) && a && b,
    'the panties pulled up engage BOTH halves, and both open', read.map((r) => `${r.pierced} depth ${f2(r.depth)}`).join(', '));
  const tipWidth = read[0].tipWidth;
  const want = Math.round(tipWidth * 0.75);
  say(a.sides.px === want && b.sides.px === want && a.sides.a + a.sides.b === want && Math.abs(a.sides.a - a.sides.b) <= 1,
    `one gap at the seam they share, each half opening its own side: ${a.sides.a} + ${a.sides.b} = ${want} px (75% of the ${tipWidth} px gusset)`,
    `left ${JSON.stringify(a.sides)}, right ${JSON.stringify(b.sides)}`);
  say(pierceOcclusion().get(pants.id) && pierceOcclusion().get(pants.id).name === 'LeftHalf',
    'the gusset is drawn beneath the halves it is pressed into');
}

// ---------------------------------------------------------------------------
console.log('Saving');
{
  reset();
  const a = layer('A', 8, 8, 0, 0);
  gives(a);
  partsStore.setInteractiveSpring(a.id, 'stiffness', 260);
  partsStore.setInteractiveSpring(a.id, 'damping', 999);
  const saved = JSON.parse(JSON.stringify(serializeProject()));
  reset();
  applyProject(saved);
  const back = partsStore.parts[0];
  say(back.interactive && back.givesWay && back.interactiveStiffness === 260 && back.interactiveDamping === 40,
    'Interactive, Gives way and the spring survive a save (damping clamped to the bone range)',
    `${back.interactive} ${back.interactiveResponse} ${back.interactiveStiffness} ${back.interactiveDamping}`);
  delete saved.parts[0].interactive;
  delete saved.parts[0].interactiveResponse;
  delete saved.parts[0].interactiveStiffness;
  delete saved.parts[0].interactiveDamping;
  applyProject(saved);
  const old = partsStore.parts[0];
  say(!old.interactive && !old.givesWay && old.interactiveStiffness === DEFAULT_STIFFNESS,
    'a project saved before Interactive existed loads with it off');
}

console.log(`\n${passed}/${total} checks passed`);
if (passed !== total) process.exit(1);
