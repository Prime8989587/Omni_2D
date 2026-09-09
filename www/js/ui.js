// Wires DOM elements to the app state machine (state.js), the scene model
// (parts.js), and the canvas facade (canvas.js). All button handlers,
// disabled-state logic, and the Scene Parts panel live here. No rendering
// or animation logic belongs in this file -- that lives in canvas.js.

import { appState, AppState } from './state.js';
import { partsStore } from './parts.js';
import { bonesStore, PHYSICS_RANGES } from './bones.js';
import { initPhysics } from './physics.js';
import { importFiles } from './importer.js';
import { initGestures } from './gestures.js';
import { initRigTool, beginPlaceBone, cancelPlacement, getRigStatus, subscribeRig } from './rigTool.js';
import { initBindTool, setBrushRadius, setBrushStrength, getBrush } from './bindTool.js';
import { bindPart, defaultDensity } from './mesh.js';
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
let bindListTab = 'parts'; // which list the Bind panel is showing
let densitySyncedFor = null; // part id the density slider currently reflects

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

  els.bindBtn = document.getElementById('bindBtn');
  els.bindPanel = document.getElementById('bindPanel');
  els.bindControls = document.getElementById('bindControls');
  els.bindExitBtn = document.getElementById('bindExitBtn');
  els.bindHint = document.getElementById('bindHint');
  els.bindStatus = document.getElementById('bindStatus');
  els.bindList = document.getElementById('bindList');
  els.autoWeightBtn = document.getElementById('autoWeightBtn');
  els.densitySlider = document.getElementById('densitySlider');
  els.densityValue = document.getElementById('densityValue');
  els.brushSlider = document.getElementById('brushSlider');
  els.brushValue = document.getElementById('brushValue');
  els.strengthSlider = document.getElementById('strengthSlider');
  els.strengthValue = document.getElementById('strengthValue');
  els.debugRotateField = document.getElementById('debugRotateField');
  els.debugRotateSlider = document.getElementById('debugRotateSlider');
  els.debugRotateValue = document.getElementById('debugRotateValue');
  els.debugBoneName = document.getElementById('debugBoneName');
  els.showPartsTab = document.getElementById('showPartsTab');
  els.showBonesTab = document.getElementById('showBonesTab');

  els.rigDebugSlider = document.getElementById('rigDebugSlider');
  els.rigDebugValue = document.getElementById('rigDebugValue');
  els.physicsToggle = document.getElementById('physicsToggle');
  els.physicsParams = document.getElementById('physicsParams');
  els.stiffnessSlider = document.getElementById('stiffnessSlider');
  els.stiffnessValue = document.getElementById('stiffnessValue');
  els.dampingSlider = document.getElementById('dampingSlider');
  els.dampingValue = document.getElementById('dampingValue');
  els.gravitySlider = document.getElementById('gravitySlider');
  els.gravityValue = document.getElementById('gravityValue');

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

    const localDegrees = Math.round((bone.rotation * 180) / Math.PI);
    els.rigDebugSlider.value = String(localDegrees);
    els.rigDebugValue.textContent = `${localDegrees}°`;
    renderPhysicsControls(bone);
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

// ---- Bone physics ------------------------------------------------------

function handlePhysicsToggle() {
  const bone = bonesStore.selected;
  if (!bone) return;
  bonesStore.setPhysicsEnabled(bone.id, !bone.physicsEnabled);
}

function handlePhysicsParam(key, slider, readout, decimals = 0) {
  const bone = bonesStore.selected;
  if (!bone) return;
  const value = Number(slider.value);
  readout.textContent = value.toFixed(decimals);
  bonesStore.setPhysicsParam(bone.id, key, value);
}

// Drives the selected bone's rotation directly, so a parent can be swung
// back and forth to watch its physics children lag behind and settle.
// Temporary scaffolding until Part 6 brings real touch-drag posing.
function handleRigDebugRotate() {
  const bone = bonesStore.selected;
  if (!bone) return;
  const degrees = Number(els.rigDebugSlider.value);
  bone.rotation = (degrees * Math.PI) / 180;
  els.rigDebugValue.textContent = `${degrees}°`;
  bonesStore.notifyTransformed();
}

function applySliderRange(slider, range) {
  slider.min = String(range.min);
  slider.max = String(range.max);
  slider.step = String(range.step);
}

function renderPhysicsControls(bone) {
  els.physicsToggle.classList.toggle('is-active', bone.physicsEnabled);
  els.physicsToggle.setAttribute('aria-pressed', String(bone.physicsEnabled));
  els.physicsToggle.textContent = bone.physicsEnabled ? 'Physics On' : 'Enable Physics';
  els.physicsParams.hidden = !bone.physicsEnabled;

  if (!bone.physicsEnabled) return;
  els.stiffnessSlider.value = String(bone.stiffness);
  els.stiffnessValue.textContent = String(bone.stiffness);
  els.dampingSlider.value = String(bone.damping);
  els.dampingValue.textContent = bone.damping.toFixed(1);
  els.gravitySlider.value = String(bone.gravityInfluence);
  els.gravityValue.textContent = String(bone.gravityInfluence);
}

// ---- Bind mode ---------------------------------------------------------

function handleBindTapped() {
  appState.enterBindMode();
}

function handleBindExit() {
  appState.exitBindMode();
}

// Binds (or re-binds) the selected part: rebuilds its mesh at the current
// density and auto-weights every vertex to its nearest bones. This is also
// the "start over" button when hand-painting has gone wrong.
function handleAutoWeight() {
  const part = partsStore.selected;
  if (!part) {
    showToast('Select a Part first (Parts tab below).');
    return;
  }
  if (bonesStore.isEmpty) {
    showToast('Build a skeleton in Rig mode first — there are no bones to bind to.');
    return;
  }

  bindPart(part, bonesStore, Number(els.densitySlider.value));
  partsStore.notifyTransformed();
  renderChrome();
  showToast(`Auto-weighted "${part.name}" (${part.mesh.vertices.length} vertices).`);
}

function handleDensityInput() {
  els.densityValue.textContent = els.densitySlider.value;
}

// Changing density has to rebuild the grid, which discards painted
// weights, so it only re-binds a part that was already bound.
function handleDensityChange() {
  const part = partsStore.selected;
  if (!part || !part.mesh || !part.mesh.isBound) return;
  bindPart(part, bonesStore, Number(els.densitySlider.value));
  partsStore.notifyTransformed();
  showToast('Mesh rebuilt at the new density — weights were auto-assigned again.');
}

function handleBrushInput() {
  setBrushRadius(Number(els.brushSlider.value));
  els.brushValue.textContent = els.brushSlider.value;
}

function handleStrengthInput() {
  setBrushStrength(Number(els.strengthSlider.value));
  els.strengthValue.textContent = Number(els.strengthSlider.value).toFixed(2);
}

// Temporary rig-testing control: drives the selected bone's rotation so
// the skinned deformation can be checked by hand. Real drag-driven
// animation replaces this in a later part.
function handleDebugRotate() {
  const bone = bonesStore.selected;
  if (!bone) return;
  const degrees = Number(els.debugRotateSlider.value);
  bone.rotation = (degrees * Math.PI) / 180;
  bonesStore.notifyTransformed();
  els.debugRotateValue.textContent = `${degrees}°`;
}

function setBindTab(tab) {
  bindListTab = tab;
  renderBindList();
  renderChrome();
}

function renderBindList() {
  els.bindList.replaceChildren();

  const rows = bindListTab === 'parts'
    ? partsStore.partsTopFirst.map((part) => ({
        id: part.id,
        label: part.mesh && part.mesh.isBound ? `${part.name} — bound` : part.name,
        selected: part.id === partsStore.selectedId,
        onSelect: () => partsStore.select(part.id),
        depth: 0,
      }))
    : bonesStore.toTreeList().map(({ bone, depth }) => ({
        id: bone.id,
        label: bone.name,
        selected: bone.id === bonesStore.selectedId,
        onSelect: () => bonesStore.select(bone.id),
        depth,
      }));

  for (const row of rows) {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'scene-part';
    button.style.paddingLeft = `${14 + row.depth * 18}px`;
    button.classList.toggle('is-selected', row.selected);
    button.textContent = row.label;
    button.addEventListener('click', row.onSelect);
    item.appendChild(button);
    els.bindList.appendChild(item);
  }
}

function renderBindChrome() {
  const isBind = currentState === AppState.BIND;
  els.bindPanel.hidden = !isBind;
  els.bindControls.hidden = !isBind;
  els.bindHint.hidden = !isBind;
  if (!isBind) return;

  const part = partsStore.selected;
  const bone = bonesStore.selected;
  const bound = Boolean(part && part.mesh && part.mesh.isBound);

  els.showPartsTab.classList.toggle('is-active', bindListTab === 'parts');
  els.showBonesTab.classList.toggle('is-active', bindListTab === 'bones');

  // Show the density that belongs to whichever part is selected: its own
  // if bound, otherwise the size-based default it would get.
  if (part && densitySyncedFor !== part.id) {
    const density = bound ? part.mesh.density : defaultDensity(part);
    els.densitySlider.value = String(density);
    els.densityValue.textContent = String(density);
    densitySyncedFor = part.id;
  }

  els.debugRotateField.hidden = !bone;
  if (bone) {
    els.debugBoneName.textContent = bone.name;
    const degrees = Math.round((bone.rotation * 180) / Math.PI);
    els.debugRotateSlider.value = String(degrees);
    els.debugRotateValue.textContent = `${degrees}°`;
  }

  els.bindStatus.textContent = part
    ? `${part.name}${bound ? ` · ${part.mesh.vertices.length} verts` : ' · not bound'}`
    : 'No part selected';

  if (!part) {
    els.bindHint.textContent = 'Pick a Part below to bind it to the skeleton.';
  } else if (bonesStore.isEmpty) {
    els.bindHint.textContent = 'No bones yet — build a skeleton in Rig mode first.';
  } else if (!bound) {
    els.bindHint.textContent = `Tap Auto-weight Part to bind "${part.name}" to the skeleton.`;
  } else if (!bone) {
    els.bindHint.textContent = 'Pick a bone (Bones tab) to see its influence and paint weights.';
  } else {
    els.bindHint.textContent = `Drag on the mesh to paint "${bone.name}" influence. Slider rotates it to test.`;
  }
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
  const isBind = currentState === AppState.BIND;
  const isAnimating = currentState === AppState.ANIMATING;
  const isRecording = currentState === AppState.RECORDING;
  const isAnimateMode = isAnimating || isRecording;

  els.homeControls.hidden = !isHome;
  els.animateControls.hidden = !isAnimateMode;

  els.modeLabel.hidden = isHome;
  els.modeLabelText.textContent = isRecording
    ? 'Recording...'
    : isRig ? 'Rig Mode' : isBind ? 'Bind Mode' : 'Animate Mode';
  els.modeLabel.classList.toggle('is-recording', isRecording);
  els.logo.hidden = !isHome;
  els.canvasEmptyHint.hidden = !isHome || !partsStore.isEmpty;

  els.canvasWrap.classList.toggle('is-animate-mode', isAnimateMode);
  els.canvasWrap.classList.toggle('is-rig-mode', isRig || isBind);
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
  renderBindChrome();
}

function bindEvents() {
  els.importBtn.addEventListener('click', handleImport);
  els.fileInput.addEventListener('change', handleFilesPicked);
  els.animateBtn.addEventListener('click', handleAnimateTapped);
  els.exitBtn.addEventListener('click', handleExit);
  els.startBtn.addEventListener('click', handleStart);
  els.stopBtn.addEventListener('click', handleStop);

  els.bindBtn.addEventListener('click', handleBindTapped);
  els.bindExitBtn.addEventListener('click', handleBindExit);
  els.autoWeightBtn.addEventListener('click', handleAutoWeight);
  els.densitySlider.addEventListener('input', handleDensityInput);
  els.densitySlider.addEventListener('change', handleDensityChange);
  els.brushSlider.addEventListener('input', handleBrushInput);
  els.strengthSlider.addEventListener('input', handleStrengthInput);
  els.debugRotateSlider.addEventListener('input', handleDebugRotate);
  els.showPartsTab.addEventListener('click', () => setBindTab('parts'));
  els.showBonesTab.addEventListener('click', () => setBindTab('bones'));

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

  els.rigDebugSlider.addEventListener('input', handleRigDebugRotate);
  els.physicsToggle.addEventListener('click', handlePhysicsToggle);
  els.stiffnessSlider.addEventListener('input', () =>
    handlePhysicsParam('stiffness', els.stiffnessSlider, els.stiffnessValue));
  els.dampingSlider.addEventListener('input', () =>
    handlePhysicsParam('damping', els.dampingSlider, els.dampingValue, 1));
  els.gravitySlider.addEventListener('input', () =>
    handlePhysicsParam('gravityInfluence', els.gravitySlider, els.gravityValue));

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
  initBindTool(els.canvas);
  bindEvents();
  initPhysics();

  applySliderRange(els.stiffnessSlider, PHYSICS_RANGES.stiffness);
  applySliderRange(els.dampingSlider, PHYSICS_RANGES.damping);
  applySliderRange(els.gravitySlider, PHYSICS_RANGES.gravityInfluence);

  const brush = getBrush();
  els.brushSlider.value = String(brush.radius);
  els.brushValue.textContent = String(brush.radius);
  els.strengthSlider.value = String(brush.strength);
  els.strengthValue.textContent = brush.strength.toFixed(2);
  els.densitySlider.value = '8';
  els.densityValue.textContent = '8';

  appState.subscribe((state) => {
    currentState = state;
    renderChrome();
  });

  partsStore.subscribe((changeType) => {
    if (changeType === 'transform') return;
    renderPartsList();
    renderBindList();
    renderChrome();
  });

  bonesStore.subscribe((changeType) => {
    // Nudges and handle drags change the readout but not the tree, so
    // only rebuild the list when the structure or selection changed.
    if (changeType !== 'transform') {
      renderBoneList();
      renderBindList();
    }
    renderChrome();
  });

  // Placement progresses without any store change (head placed, awaiting
  // the tail tap), so the hint line listens to the tool directly.
  subscribeRig(renderChrome);
}
