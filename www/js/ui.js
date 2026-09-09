// Wires DOM elements to the app state machine (state.js), the scene model
// (parts.js), and the canvas facade (canvas.js). All button handlers,
// disabled-state logic, and the Scene Parts panel live here. No rendering
// or animation logic belongs in this file -- that lives in canvas.js.

import { appState, AppState } from './state.js';
import { partsStore } from './parts.js';
import { bonesStore } from './bones.js';
import { importFiles } from './importer.js';
import { initGestures } from './gestures.js';
import { initRigTool, beginPlaceBone, cancelPlacement, getRigStatus, subscribeRig } from './rigTool.js';
import * as canvasEngine from './canvas.js';

const TOAST_DURATION_MS = 4000;
const NUDGE_STEP_PX = 2;
const NUDGE_STEP_RADIANS = (2 * Math.PI) / 180;

const els = {};
let currentState = AppState.HOME;
let scenePanelOpen = true;
let skeletonPanelOpen = true;
let toastTimer = null;
let pendingDeleteBoneId = null;

function cacheElements() {
  els.canvas = document.getElementById('canvas');
  els.canvasWrap = document.getElementById('canvasWrap');

  els.importBtn = document.getElementById('importBtn');
  els.animateBtn = document.getElementById('animateBtn');
  els.exitBtn = document.getElementById('exitBtn');
  els.startBtn = document.getElementById('startBtn');
  els.stopBtn = document.getElementById('stopBtn');

  els.homeControls = document.getElementById('homeControls');
  els.animateControls = document.getElementById('animateControls');
  els.modeLabel = document.getElementById('modeLabel');
  els.modeLabelText = document.getElementById('modeLabelText');
  els.logo = document.getElementById('logo');
  els.canvasEmptyHint = document.getElementById('canvasEmptyHint');

  els.fileInput = document.getElementById('fileInput');
  els.scenePanel = document.getElementById('scenePanel');
  els.scenePanelToggle = document.getElementById('scenePanelToggle');
  els.scenePanelChevron = document.getElementById('scenePanelChevron');
  els.scenePartsList = document.getElementById('scenePartsList');
  els.scenePartsCount = document.getElementById('scenePartsCount');
  els.selectionBar = document.getElementById('selectionBar');
  els.selectedPartName = document.getElementById('selectedPartName');
  els.toFrontBtn = document.getElementById('toFrontBtn');
  els.toBackBtn = document.getElementById('toBackBtn');
  els.toast = document.getElementById('toast');

  els.rigBtn = document.getElementById('rigBtn');
  els.rigControls = document.getElementById('rigControls');
  els.rigExitBtn = document.getElementById('rigExitBtn');
  els.addBoneBtn = document.getElementById('addBoneBtn');
  els.rigHint = document.getElementById('rigHint');
  els.rigPanel = document.getElementById('rigPanel');
  els.skeletonToggle = document.getElementById('skeletonToggle');
  els.skeletonChevron = document.getElementById('skeletonChevron');
  els.boneList = document.getElementById('boneList');
  els.boneCount = document.getElementById('boneCount');
  els.boneEditor = document.getElementById('boneEditor');
  els.boneNameInput = document.getElementById('boneNameInput');
  els.boneReadout = document.getElementById('boneReadout');
  els.deleteBoneBtn = document.getElementById('deleteBoneBtn');
  els.nudgeLeftBtn = document.getElementById('nudgeLeftBtn');
  els.nudgeRightBtn = document.getElementById('nudgeRightBtn');
  els.nudgeUpBtn = document.getElementById('nudgeUpBtn');
  els.nudgeDownBtn = document.getElementById('nudgeDownBtn');
  els.rotateCcwBtn = document.getElementById('rotateCcwBtn');
  els.rotateCwBtn = document.getElementById('rotateCwBtn');

  els.confirmModal = document.getElementById('confirmModal');
  els.confirmMessage = document.getElementById('confirmMessage');
  els.confirmDeleteBtn = document.getElementById('confirmDeleteBtn');
  els.confirmCancelBtn = document.getElementById('confirmCancelBtn');

  els.exportModal = document.getElementById('exportModal');
  els.filenameInput = document.getElementById('filenameInput');
  els.saveGifBtn = document.getElementById('saveGifBtn');
  els.saveMp4Btn = document.getElementById('saveMp4Btn');
  els.cancelExportBtn = document.getElementById('cancelExportBtn');
}

function showToast(message) {
  els.toast.textContent = message;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    els.toast.hidden = true;
  }, TOAST_DURATION_MS);
}

function openExportModal() {
  els.filenameInput.value = '';
  els.exportModal.hidden = false;
  els.filenameInput.focus();
}

function closeExportModal() {
  els.exportModal.hidden = true;
}

function resolvedFilename() {
  const typed = els.filenameInput.value.trim();
  return typed.length > 0 ? typed : els.filenameInput.placeholder;
}

// Opens the native file chooser. Capacitor's Android bridge turns this
// into the system picker, and `multiple` lets the user grab every body
// part in one go.
function handleImport() {
  els.fileInput.click();
}

async function handleFilesPicked(event) {
  const files = event.target.files;
  if (!files || files.length === 0) return;

  const result = await importFiles(files, canvasEngine.getViewSize());

  // Reset so picking the same file again still fires a change event.
  els.fileInput.value = '';

  const problems = [...result.rejected, ...result.failed];
  if (problems.length > 0) {
    showToast(`Skipped ${problems.length} file(s) -- PNG only: ${problems.join(', ')}`);
  }
}

function handleRigTapped() {
  appState.enterRigMode();
}

function handleRigExit() {
  cancelPlacement();
  bonesStore.select(null);
  appState.exitRigMode();
}

// Deleting a bone that has children re-parents them rather than removing
// them too, so the user is warned about what will happen but never loses
// a whole limb to one tap.
function handleDeleteBone() {
  const bone = bonesStore.selected;
  if (!bone) return;

  const children = bonesStore.childrenOf(bone.id);
  if (children.length === 0) {
    bonesStore.deleteBone(bone.id);
    return;
  }

  const parent = bonesStore.parentOf(bone);
  const destination = parent ? `"${parent.name}"` : 'the top level';
  pendingDeleteBoneId = bone.id;
  els.confirmMessage.textContent =
    `"${bone.name}" has ${children.length} child bone(s). They will be re-attached to ` +
    `${destination} and keep their current positions on the canvas.`;
  els.confirmModal.hidden = false;
}

function confirmDeleteBone() {
  if (pendingDeleteBoneId) bonesStore.deleteBone(pendingDeleteBoneId);
  pendingDeleteBoneId = null;
  els.confirmModal.hidden = true;
}

function cancelDeleteBone() {
  pendingDeleteBoneId = null;
  els.confirmModal.hidden = true;
}

function nudgeSelectedBone(dx, dy) {
  const bone = bonesStore.selected;
  if (bone) bonesStore.nudgePosition(bone, dx, dy);
}

function rotateSelectedBone(delta) {
  const bone = bonesStore.selected;
  if (bone) bonesStore.nudgeRotation(bone, delta);
}

function handleBoneRename(event) {
  const bone = bonesStore.selected;
  if (bone) bonesStore.rename(bone.id, event.target.value);
}

// Indented depth-first list of the whole skeleton, so overlapping bones
// are still selectable and the tree structure is legible.
function renderBoneList() {
  els.boneList.replaceChildren();

  for (const { bone, depth } of bonesStore.toTreeList()) {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'scene-part';
    button.style.paddingLeft = `${14 + depth * 18}px`;
    button.classList.toggle('is-selected', bone.id === bonesStore.selectedId);

    if (depth > 0) {
      const marker = document.createElement('span');
      marker.className = 'scene-part__depth';
      marker.textContent = '└ ';
      button.appendChild(marker);
    }
    button.appendChild(document.createTextNode(bone.name));
    button.addEventListener('click', () => bonesStore.select(bone.id));

    item.appendChild(button);
    els.boneList.appendChild(item);
  }
}

function renderRigChrome() {
  const isRig = currentState === AppState.RIG;
  els.rigPanel.hidden = !isRig;
  els.rigControls.hidden = !isRig;
  els.rigHint.hidden = !isRig;
  if (!isRig) return;

  const status = getRigStatus();
  const bone = bonesStore.selected;

  els.boneCount.textContent = String(bonesStore.bones.length);
  els.boneList.hidden = !skeletonPanelOpen;
  els.skeletonToggle.setAttribute('aria-expanded', String(skeletonPanelOpen));
  els.skeletonChevron.textContent = skeletonPanelOpen ? '▾' : '▴';

  els.addBoneBtn.disabled = status.placing || !status.canAddBone;
  els.boneEditor.hidden = !bone || status.placing;

  if (bone && !status.placing) {
    if (els.boneNameInput.value !== bone.name) els.boneNameInput.value = bone.name;
    const head = bonesStore.worldHead(bone);
    const degrees = Math.round((bonesStore.worldRotation(bone) * 180) / Math.PI);
    els.boneReadout.textContent =
      `x ${Math.round(head.x)} · y ${Math.round(head.y)} · ${degrees}° · length ${Math.round(bone.length)}`;
  }

  els.rigHint.textContent = rigHintText(status);
}

function rigHintText(status) {
  if (status.placing) {
    if (status.stage === 'head') return 'Tap the canvas to place the root bone’s head.';
    return status.parentName
      ? `Tap to set the tail. The head is attached to "${status.parentName}".`
      : 'Tap again to set the root bone’s tail.';
  }
  if (bonesStore.isEmpty) return 'Tap Add Bone to place the root bone.';
  if (!bonesStore.selected) return 'Tap a bone to select it as the parent for the next bone.';
  return `Add Bone will attach to "${bonesStore.selected.name}". Drag the handles to adjust.`;
}

function handleAnimateTapped() {
  appState.enterAnimateMode();
  canvasEngine.onEnterAnimateMode();
}

function handleExit() {
  if (appState.state === AppState.RECORDING) {
    console.log('Recording cancelled - exiting Animate mode');
  }
  appState.exitAnimateMode();
  canvasEngine.onExitAnimateMode();
}

function handleStart() {
  appState.startRecording();
  canvasEngine.onStartRecording();
}

function handleStop() {
  appState.stopRecording();
  canvasEngine.onStopRecording();
  openExportModal();
}

function handleSave(format) {
  const filename = resolvedFilename();
  console.log(`Export triggered: ${filename}.${format} (placeholder - no encoding yet)`);
  closeExportModal();
}

function handleCancelExport() {
  console.log('Export cancelled');
  closeExportModal();
}

function toggleScenePanel() {
  scenePanelOpen = !scenePanelOpen;
  renderChrome();
}

// Rebuilt only on structural/selection changes, never mid-drag.
function renderPartsList() {
  els.scenePartsList.replaceChildren();

  for (const part of partsStore.partsTopFirst) {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'scene-part';
    button.textContent = part.name;
    button.classList.toggle('is-selected', part.id === partsStore.selectedId);
    button.addEventListener('click', () => partsStore.select(part.id));
    item.appendChild(button);
    els.scenePartsList.appendChild(item);
  }
}

// Reflects app state + scene contents onto the DOM: which control row is
// visible, which buttons are enabled, the canvas border, and the panel.
function renderChrome() {
  const isHome = currentState === AppState.HOME;
  const isRig = currentState === AppState.RIG;
  const isAnimating = currentState === AppState.ANIMATING;
  const isRecording = currentState === AppState.RECORDING;
  const isAnimateMode = isAnimating || isRecording;

  els.homeControls.hidden = !isHome;
  els.animateControls.hidden = !isAnimateMode;

  els.modeLabel.hidden = isHome;
  els.modeLabelText.textContent = isRecording
    ? 'Recording...'
    : isRig ? 'Rig Mode' : 'Animate Mode';
  els.modeLabel.classList.toggle('is-recording', isRecording);
  els.logo.hidden = !isHome;
  els.canvasEmptyHint.hidden = !isHome || !partsStore.isEmpty;

  els.canvasWrap.classList.toggle('is-animate-mode', isAnimateMode);
  els.canvasWrap.classList.toggle('is-rig-mode', isRig);
  els.canvasWrap.classList.toggle('is-recording', isRecording);

  els.startBtn.disabled = !isAnimating;
  els.stopBtn.disabled = !isRecording;

  // Assembly controls belong to the Home screen, and only once there is
  // something to assemble.
  const showPanel = isHome && !partsStore.isEmpty;
  els.scenePanel.hidden = !showPanel;
  els.scenePartsCount.textContent = String(partsStore.parts.length);
  els.scenePartsList.hidden = !scenePanelOpen;
  els.scenePanelToggle.setAttribute('aria-expanded', String(scenePanelOpen));
  els.scenePanelChevron.textContent = scenePanelOpen ? '▾' : '▴';

  const selected = partsStore.selected;
  els.selectionBar.hidden = !showPanel || !selected;
  if (selected) {
    els.selectedPartName.textContent = selected.name;
  }

  renderRigChrome();
}

function bindEvents() {
  els.importBtn.addEventListener('click', handleImport);
  els.fileInput.addEventListener('change', handleFilesPicked);
  els.animateBtn.addEventListener('click', handleAnimateTapped);
  els.exitBtn.addEventListener('click', handleExit);
  els.startBtn.addEventListener('click', handleStart);
  els.stopBtn.addEventListener('click', handleStop);

  els.rigBtn.addEventListener('click', handleRigTapped);
  els.rigExitBtn.addEventListener('click', handleRigExit);
  els.addBoneBtn.addEventListener('click', beginPlaceBone);
  els.skeletonToggle.addEventListener('click', () => {
    skeletonPanelOpen = !skeletonPanelOpen;
    renderChrome();
  });
  els.boneNameInput.addEventListener('input', handleBoneRename);
  els.deleteBoneBtn.addEventListener('click', handleDeleteBone);
  els.confirmDeleteBtn.addEventListener('click', confirmDeleteBone);
  els.confirmCancelBtn.addEventListener('click', cancelDeleteBone);

  els.nudgeLeftBtn.addEventListener('click', () => nudgeSelectedBone(-NUDGE_STEP_PX, 0));
  els.nudgeRightBtn.addEventListener('click', () => nudgeSelectedBone(NUDGE_STEP_PX, 0));
  els.nudgeUpBtn.addEventListener('click', () => nudgeSelectedBone(0, -NUDGE_STEP_PX));
  els.nudgeDownBtn.addEventListener('click', () => nudgeSelectedBone(0, NUDGE_STEP_PX));
  els.rotateCcwBtn.addEventListener('click', () => rotateSelectedBone(-NUDGE_STEP_RADIANS));
  els.rotateCwBtn.addEventListener('click', () => rotateSelectedBone(NUDGE_STEP_RADIANS));

  els.scenePanelToggle.addEventListener('click', toggleScenePanel);
  els.toFrontBtn.addEventListener('click', () => partsStore.bringToFront(partsStore.selectedId));
  els.toBackBtn.addEventListener('click', () => partsStore.sendToBack(partsStore.selectedId));

  els.saveGifBtn.addEventListener('click', () => handleSave('gif'));
  els.saveMp4Btn.addEventListener('click', () => handleSave('mp4'));
  els.cancelExportBtn.addEventListener('click', handleCancelExport);
}

export function initUI() {
  cacheElements();
  canvasEngine.initCanvas(els.canvas);
  initGestures(els.canvas);
  initRigTool(els.canvas);
  bindEvents();

  appState.subscribe((state) => {
    currentState = state;
    renderChrome();
  });

  partsStore.subscribe((changeType) => {
    if (changeType === 'transform') return;
    renderPartsList();
    renderChrome();
  });

  bonesStore.subscribe((changeType) => {
    // Nudges and handle drags change the readout but not the tree, so
    // only rebuild the list when the structure or selection changed.
    if (changeType !== 'transform') renderBoneList();
    renderChrome();
  });

  // Placement progresses without any store change (head placed, awaiting
  // the tail tap), so the hint line listens to the tool directly.
  subscribeRig(renderChrome);
}
