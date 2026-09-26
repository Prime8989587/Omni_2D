// Named checkpoints: snapshots of the current session you can jump back to.
//
// "Before risky physics tuning", "arms bound", "try the long hair": as many
// as you like, each the ENTIRE project at the moment it was taken --
// layers and their pixels, bones and every physics setting, weights, pins,
// pierce regions, links -- held in memory for this session. That is the
// line between these and the app's other ways of keeping work:
//
//   * PSaver / Save project write a file or a database record, and loading
//     one is a round trip through a picker;
//   * Save state is ONE slot, kept across restarts;
//   * a checkpoint is instant, named, one of many, and gone when the app
//     closes -- a bookmark in this session's history, not an archive.
//
// Reverting runs through the undo history like any other edit, so a revert
// that turns out to be the wrong one is one Undo away from being taken
// back. A checkpoint itself is never changed by reverting to it: jump back
// to "before tuning" twice and you land on the same state both times.
//
// The snapshot is the same serialised project undo and autosave already
// use (project.js), so a checkpoint restores exactly what those do, with no
// second notion of "the state of the app" to keep in step.

import { serializeProject, applyProject } from './project.js';
import { history } from './history.js';
import { createIcon } from './pixelIcons.js';

let checkpoints = [];
let nextNumber = 1;
const listeners = new Set();

function emit() {
  listeners.forEach((fn) => fn(checkpoints));
}

export function listCheckpoints() {
  return checkpoints.map(({ id, name, createdAt, summary }) => ({ id, name, createdAt, summary }));
}

export function subscribeCheckpoints(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function saveCheckpoint(name) {
  const data = serializeProject({ copyPixels: true });
  const number = nextNumber++;
  const clean = String(name || '').trim().slice(0, 40) || `Checkpoint ${number}`;
  const checkpoint = {
    id: `checkpoint_${number}`,
    name: clean,
    createdAt: Date.now(),
    data,
    summary: {
      layers: (data.parts || []).length,
      bones: (data.bones || []).length,
      links: (data.pxlinks || []).length,
    },
  };
  checkpoints = [checkpoint, ...checkpoints];
  emit();
  return checkpoint;
}

export function revertToCheckpoint(id) {
  const checkpoint = checkpoints.find((c) => c.id === id);
  if (!checkpoint) return false;
  // A fresh copy each time: applying a snapshot hands its objects to the
  // stores, and the checkpoint has to stay exactly as it was taken.
  const data = JSON.parse(JSON.stringify(checkpoint.data));
  history.run(`Revert to "${checkpoint.name}"`, () => applyProject(data));
  return true;
}

export function deleteCheckpoint(id) {
  const before = checkpoints.length;
  checkpoints = checkpoints.filter((c) => c.id !== id);
  if (checkpoints.length !== before) emit();
  return checkpoints.length !== before;
}

// ---------------------------------------------------------------------------
// The dialog

const els = {};
let onToast = () => {};
let onReverted = () => {};
let armedDelete = null;

function timeOf(ms) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function render() {
  if (!els.list) return;
  els.list.replaceChildren();
  els.empty.hidden = checkpoints.length > 0;
  for (const cp of checkpoints) {
    const li = document.createElement('li');
    li.className = 'checkpoint-row';
    li.dataset.checkpointId = cp.id;
    const info = document.createElement('div');
    info.className = 'checkpoint-row__info';
    const name = document.createElement('span');
    name.className = 'checkpoint-row__name';
    name.append(createIcon('flag'), document.createTextNode(` ${cp.name}`));
    const meta = document.createElement('small');
    const { layers, bones, links } = cp.summary;
    meta.textContent = `${timeOf(cp.createdAt)} · ${layers} layer${layers === 1 ? '' : 's'} · ${bones} bone${bones === 1 ? '' : 's'}${links ? ` · ${links} link${links === 1 ? '' : 's'}` : ''}`;
    info.append(name, meta);

    const revert = document.createElement('button');
    revert.type = 'button';
    revert.className = 'btn btn--sm';
    revert.dataset.revert = cp.id;
    revert.append(createIcon('undo'), document.createTextNode('Revert'));
    revert.addEventListener('click', () => {
      revertToCheckpoint(cp.id);
      close();
      onReverted();
      onToast(`Back to "${cp.name}". Undo takes it back.`);
    });

    // Deleting is permanent (a checkpoint is not part of the undo history),
    // so it takes a second tap on the same button to confirm.
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'btn btn--sm btn--danger';
    del.dataset.delete = cp.id;
    if (armedDelete === cp.id) del.textContent = 'Delete?';
    else del.appendChild(createIcon('trash'));
    del.setAttribute('aria-label', `Delete checkpoint ${cp.name}`);
    del.addEventListener('click', () => {
      if (armedDelete !== cp.id) { armedDelete = cp.id; render(); return; }
      armedDelete = null;
      deleteCheckpoint(cp.id);
      onToast(`Checkpoint "${cp.name}" deleted.`);
    });

    li.append(info, revert, del);
    els.list.appendChild(li);
  }
}

export function openCheckpoints() {
  if (!els.modal) return;
  armedDelete = null;
  els.name.value = '';
  render();
  els.modal.hidden = false;
}

function close() {
  els.modal.hidden = true;
  armedDelete = null;
}

function saveFromDialog() {
  const cp = saveCheckpoint(els.name.value);
  els.name.value = '';
  onToast(`Checkpoint "${cp.name}" saved.`);
}

export function initCheckpoints({ toast, afterRevert } = {}) {
  if (toast) onToast = toast;
  if (afterRevert) onReverted = afterRevert;
  els.modal = document.getElementById('checkpointsModal');
  els.name = document.getElementById('checkpointNameInput');
  els.save = document.getElementById('checkpointSaveBtn');
  els.list = document.getElementById('checkpointList');
  els.empty = document.getElementById('checkpointEmpty');
  els.close = document.getElementById('checkpointCloseBtn');
  if (!els.modal) return;
  els.save.addEventListener('click', saveFromDialog);
  els.name.addEventListener('keydown', (event) => { if (event.key === 'Enter') saveFromDialog(); });
  els.close.addEventListener('click', close);
  subscribeCheckpoints(render);
}
