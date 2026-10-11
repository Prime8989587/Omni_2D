// The scene's backdrop: what shows where no layer has a pixel -- the
// checkerboard (transparent) or a colour, on the canvas and in recorded
// frames alike -- and that a project keeps it.

import { strict as assert } from 'node:assert';
import { sceneStore, normalizeBackdrop, withBackdrop } from '../www/js/scene.js';
import { serializeProject, applyProject } from '../www/js/project.js';

let checks = 0;
let failures = 0;
const results = [];
function check(name, fn) {
  checks++;
  try { fn(); results.push(`  ok    ${name}`); } catch (error) { failures++; results.push(`  FAIL  ${name}\n          ${error.message}`); }
}

check('a new scene has no backdrop: the checkerboard, transparent', () => {
  assert.equal(sceneStore.backdrop, null);
});

check('a backdrop is a #RRGGBB colour; anything else is the checkerboard', () => {
  assert.equal(normalizeBackdrop('#f8dccd'), '#F8DCCD');
  assert.equal(normalizeBackdrop('#F8DCCD'), '#F8DCCD');
  for (const bad of ['f8dccd', '#fff', 'red', '', null, undefined, 12]) assert.equal(normalizeBackdrop(bad), null, String(bad));
});

check('changing it never re-fits the camera: it tells its own listeners, not the size\'s', () => {
  let size = 0;
  let colour = 0;
  const offSize = sceneStore.subscribe(() => { size++; });
  const offColour = sceneStore.subscribeBackdrop(() => { colour++; });
  size = 0;
  sceneStore.setBackdrop('#102030');
  sceneStore.setBackdrop('#102030');
  sceneStore.setBackdrop(null);
  offSize(); offColour();
  assert.equal(size, 0);
  assert.equal(colour, 2, 'twice: on, and back off -- not for the repeat');
});

check('a recorded frame: empty pixels take the colour, half see-through ones blend onto it, opaque ones untouched', () => {
  const frame = new Uint8ClampedArray([10, 20, 30, 255, 0, 0, 0, 0, 200, 100, 0, 128]);
  const out = withBackdrop(frame, '#F8DCCD');
  assert.deepEqual(Array.from(out.slice(0, 4)), [10, 20, 30, 255]);
  assert.deepEqual(Array.from(out.slice(4, 8)), [248, 220, 205, 255]);
  const k = 128 / 255;
  assert.deepEqual(Array.from(out.slice(8, 12)), [Math.round(200 * k + 248 * (1 - k)), Math.round(100 * k + 220 * (1 - k)), Math.round(205 * (1 - k)), 255]);
});

check('without a backdrop a recorded frame is left exactly as it was: transparent stays transparent', () => {
  const frame = new Uint8ClampedArray([10, 20, 30, 255, 0, 0, 0, 0, 200, 100, 0, 128]);
  const copy = Array.from(frame);
  assert.deepEqual(Array.from(withBackdrop(frame, null)), copy);
});

check('saved with the project and loaded back; a project from before it loads with the checkerboard', () => {
  sceneStore.setBackdrop('#F8DCCD');
  const saved = serializeProject();
  assert.equal(saved.canvas.backdrop, '#F8DCCD');
  sceneStore.setBackdrop(null);
  applyProject(JSON.parse(JSON.stringify(saved)));
  assert.equal(sceneStore.backdrop, '#F8DCCD');
  const older = JSON.parse(JSON.stringify(saved));
  delete older.canvas.backdrop;
  applyProject(older);
  assert.equal(sceneStore.backdrop, null);
});

console.log(`Scene backdrop\n${results.join('\n')}\n\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
