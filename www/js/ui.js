// Wires DOM elements to the app state machine (state.js), the scene model
// (parts.js), and the canvas facade (canvas.js). All button handlers,
// disabled-state logic, and the Scene Parts panel live here. No rendering
// or animation logic belongs in this file -- that lives in canvas.js.

import { appState, AppState } from './state.js';
import { partsStore } from './parts.js';
import { bonesStore, PHYSICS_RANGES } from './bones.js';
import { initPhysics } from './physics.js';
import { sceneStore, SCENE_PRESETS } from './scene.js';
import { view } from './view.js';
import { initViewGestures } from './viewGestures.js';
import { importFiles } from './importer.js';
import { initGestures } from './gestures.js';
import { initRigTool, beginPlaceBone, cancelPlacement, getRigStatus, subscribeRig } from './rigTool.js';
import { initBindTool, setBrushRadius, setBrushStrength, getBrush } from './bindTool.js';
import { bindPart, defaultDensity } from './mesh.js';
import { history } from './history.js';
import { serializeProject, applyProject } from './project.js';
import * as storage from './storage.js';
import { initAutoSave, setAutoSaveSource, autoSaveNow } from './autosave.js';
import * as canvasEngine from './canvas.js';

const TOAST_DURATION_MS = 4000;
const NUDGE_STEP_PX = 1; // one grid cell
const NUDGE_STEP_RADIANS = (2 * Math.PI) / 180;

const els = {};
let currentState = AppState.HOME;
let scenePanelOpen = true;
let skeletonPanelOpen = true;
let toastTimer = null;
let pendingDeleteBoneId = null;
let bindListTab = 'parts'; // which list the Bind panel is showing
let densitySyncedFor = null; // part id the density slider currently reflects
let pendingDeletePartId = null;
let currentProjectName = null; // the named project this session is editing

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
  els.fitViewBtn = document.getElementById('fitViewBtn');
  els.homeCanvasRow = document.getElementById('homeCanvasRow');
  els.canvasSizeBtn = document.getElementById('canvasSizeBtn');
  els.canvasSizeModal = document.getElementById('canvasSizeModal');
  els.canvasPresets = document.getElementById('canvasPresets');
  els.canvasWidthInput = document.getElementById('canvasWidthInput');
  els.canvasHeightInput = document.getElementById('canvasHeightInput');
  els.applyCanvasSizeBtn = document.getElementById('applyCanvasSizeBtn');
  els.cancelCanvasSizeBtn = document.getElementById('cancelCanvasSizeBtn');
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
  els.duplicatePartBtn = document.getElementById('duplicatePartBtn');
  els.deletePartBtn = document.getElementById('deletePartBtn');
  els.toast = document.getElementById('toast');

  els.undoBtn = document.getElementById('undoBtn');
  els.redoBtn = document.getElementById('redoBtn');

  els.deletePartModal = document.getElementById('deletePartModal');
  els.deletePartMessage = document.getElementById('deletePartMessage');
  els.deletePartKeepBonesBtn = document.getElementById('deletePartKeepBonesBtn');
  els.deletePartWithBonesBtn = document.getElementById('deletePartWithBonesBtn');
  els.deletePartCancelBtn = document.getElementById('deletePartCancelBtn');

  els.saveProjectBtn = document.getElementById('saveProjectBtn');
  els.openProjectBtn = document.getElementById('openProjectBtn');
  els.saveProjectModal = document.getElementById('saveProjectModal');
  els.projectNameInput = document.getElementById('projectNameInput');
  els.saveProjectHint = document.getElementById('saveProjectHint');
  els.confirmSaveProjectBtn = document.getElementById('confirmSaveProjectBtn');
  els.cancelSaveProjectBtn = document.getElementById('cancelSaveProjectBtn');
  els.openProjectModal = document.getElementById('openProjectModal');
  els.projectList = document.getElementById('projectList');
  els.openProjectEmpty = document.getElementById('openProjectEmpty');
  els.cancelOpenProjectBtn = document.getElementById('cancelOpenProjectBtn');
  els.recoveryModal = document.getElementById('recoveryModal');
  els.recoveryMessage = document.getElementById('recoveryMessage');
  els.restoreRecoveryBtn = document.getElementById('restoreRecoveryBtn');
  els.discardRecoveryBtn = document.getElementById('discardRecoveryBtn');

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
  els.boneLayerSelect = document.getElementById('boneLayerSelect');
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

  const importToken = history.capture('Import layers');
  const result = await importFiles(files);
  history.commitCapture(importToken, result.imported > 0);
  // Importing artwork is the most expensive thing to lose, so it does not
  // wait for the debounce.
  if (result.imported > 0) autoSaveNow('import');

  // Reset so picking the same file again still fires a change event.
  els.fileInput.value = '';

  const problems = [
    ...result.rejected.map((name) => `${name} is not a PNG`),
    ...result.failed.map((name) => `${name} could not be decoded`),
    ...result.wrongSize,
    ...result.blank,
  ];

  const notes = [];
  if (problems.length > 0) {
    notes.push(`Skipped ${problems.length} file(s): ${problems.join('; ')}`);
  }
  // A file that is not exactly canvas-sized carries no position, so it was
  // placed the ordinary way. Say so, with both real sizes, rather than
  // leaving the user to wonder why a layer did not land where it belongs.
  if (result.manualPlacement.length > 0) {
    notes.push(
      `Placed by hand — auto-position needs an exact canvas match: ${result.manualPlacement.join('; ')}`
    );
  } else if (result.autoPlaced > 0) {
    const layers = result.autoPlaced === 1 ? 'layer' : 'layers';
    notes.push(`Positioned ${result.autoPlaced} ${layers} from the transparent padding.`);
  }

  if (notes.length > 0) showToast(notes.join(' · '));
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
    history.run('Delete bone', () => bonesStore.deleteBone(bone.id));
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
  if (pendingDeleteBoneId) {
    const id = pendingDeleteBoneId;
    history.run('Delete bone', () => bonesStore.deleteBone(id));
  }
  pendingDeleteBoneId = null;
  els.confirmModal.hidden = true;
}

function cancelDeleteBone() {
  pendingDeleteBoneId = null;
  els.confirmModal.hidden = true;
}

function nudgeSelectedBone(dx, dy) {
  const bone = bonesStore.selected;
  if (bone) history.run('Move bone', () => bonesStore.nudgePosition(bone, dx, dy));
}

function rotateSelectedBone(delta) {
  const bone = bonesStore.selected;
  if (bone) history.run('Rotate bone', () => bonesStore.nudgeRotation(bone, delta));
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
    const attachedPart = bone.attachedPartId
      ? partsStore.parts.find((part) => part.id === bone.attachedPartId)
      : null;
    if (attachedPart || !bone.visible) {
      const tag = document.createElement('span');
      tag.className = 'scene-part__tag';
      const bits = [];
      if (attachedPart) bits.push(`→ ${attachedPart.name}`);
      if (!bone.visible) bits.push('hidden');
      tag.textContent = `  ${bits.join(' · ')}`;
      button.appendChild(tag);
    }
    button.classList.toggle('is-hidden', !bonesStore.isVisible(bone));
    button.addEventListener('click', () => bonesStore.select(bone.id));

    const row = document.createElement('div');
    row.className = 'list-row';
    row.appendChild(button);
    // Hiding a bone hides everything under it, so one tap can clear a
    // whole limb off the screen while you work on another.
    row.appendChild(iconButton({
      label: bone.visible ? `Hide ${bone.name} and its children` : `Show ${bone.name}`,
      glyph: bone.visible ? '👁' : '🚫',
      pressed: !bone.visible,
      onClick: () => history.run(bone.visible ? 'Hide bone' : 'Show bone',
        () => bonesStore.setVisible(bone.id, !bone.visible)),
    }));

    item.appendChild(row);
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
    renderBoneLayerSelect(bone);
    renderPhysicsControls(bone);
  }

  els.rigHint.textContent = rigHintText(status);
}

// Which layer a bone drives is the user's call, never inferred from
// whatever happens to sit under it, so the editor always asks. The same
// control edits the assignment later -- it is not fixed at creation.
function renderBoneLayerSelect(bone) {
  const select = els.boneLayerSelect;
  select.replaceChildren();

  const none = document.createElement('option');
  none.value = '';
  none.textContent = partsStore.isEmpty ? 'No layers imported' : 'Not assigned';
  select.appendChild(none);

  for (const part of partsStore.partsTopFirst) {
    const option = document.createElement('option');
    option.value = part.id;
    option.textContent = part.name;
    select.appendChild(option);
  }

  select.value = bone.attachedPartId || '';
  select.disabled = partsStore.isEmpty;
}

function handleBoneLayerChange() {
  const bone = bonesStore.selected;
  if (!bone) return;
  const partId = els.boneLayerSelect.value || null;
  history.run('Assign bone to layer', () => bonesStore.setAttachedPart(bone.id, partId));
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

// ---- Canvas size & view ------------------------------------------------

function openCanvasSizeModal() {
  els.canvasWidthInput.value = String(sceneStore.width);
  els.canvasHeightInput.value = String(sceneStore.height);
  renderCanvasPresets();
  els.canvasSizeModal.hidden = false;
}

function closeCanvasSizeModal() {
  els.canvasSizeModal.hidden = true;
}

// The store clamps to the 8..3072 limits; what the user typed is echoed
// back as the size that was actually applied.
function applyCanvasSize() {
  history.run('Change canvas size',
    () => sceneStore.setSize(els.canvasWidthInput.value, els.canvasHeightInput.value));
  closeCanvasSizeModal();
  showToast(`Canvas is ${sceneStore.width} × ${sceneStore.height} pixels.`);
}

// Preset buttons fill the width/height fields; Apply commits them. The
// highlighted preset follows the fields, so a custom size shows none.
function renderCanvasPresets() {
  const width = Number(els.canvasWidthInput.value);
  const height = Number(els.canvasHeightInput.value);
  els.canvasPresets.replaceChildren();

  for (const preset of SCENE_PRESETS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'segmented__btn';
    button.textContent = preset.label;
    button.classList.toggle('is-active', preset.width === width && preset.height === height);
    button.addEventListener('click', () => {
      els.canvasWidthInput.value = String(preset.width);
      els.canvasHeightInput.value = String(preset.height);
      renderCanvasPresets();
    });
    els.canvasPresets.appendChild(button);
  }
}

// ---- Bone physics ------------------------------------------------------

function handlePhysicsToggle() {
  const bone = bonesStore.selected;
  if (!bone) return;
  history.run(bone.physicsEnabled ? 'Disable physics' : 'Enable physics',
    () => bonesStore.setPhysicsEnabled(bone.id, !bone.physicsEnabled));
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

  history.run('Auto-weight', () => {
    bindPart(part, bonesStore, Number(els.densitySlider.value));
    partsStore.notifyTransformed();
  });
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
  // The density slider's own capture (registered first in bindEvents)
  // already brackets this interaction, so the rebuild must not open a
  // second entry of its own.
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

function iconButton({ label, glyph, pressed = null, disabled = false, onClick }) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'row-btn';
  button.textContent = glyph;
  button.setAttribute('aria-label', label);
  button.title = label;
  if (pressed !== null) button.setAttribute('aria-pressed', String(pressed));
  button.disabled = disabled;
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    onClick();
  });
  return button;
}

// Rebuilt only on structural/selection changes, never mid-drag. Each row
// carries the controls that belong to that one layer: move it through the
// stack, hide it, lock it.
function renderPartsList() {
  els.scenePartsList.replaceChildren();

  const ordered = partsStore.partsTopFirst;
  ordered.forEach((part, index) => {
    const item = document.createElement('li');
    const row = document.createElement('div');
    row.className = 'list-row';

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'scene-part';
    button.classList.toggle('is-selected', part.id === partsStore.selectedId);
    button.classList.toggle('is-hidden', !part.visible);
    button.appendChild(document.createTextNode(part.name));
    if (!part.visible || part.locked) {
      const tag = document.createElement('span');
      tag.className = 'scene-part__tag';
      tag.textContent = ` — ${[!part.visible ? 'hidden' : null, part.locked ? 'locked' : null]
        .filter(Boolean)
        .join(', ')}`;
      button.appendChild(tag);
    }
    button.addEventListener('click', () => partsStore.select(part.id));
    row.appendChild(button);

    // The list runs top-of-stack first, so "up" in the list is +1 in z.
    row.appendChild(iconButton({
      label: `Move ${part.name} up`, glyph: '▲', disabled: index === 0,
      onClick: () => history.run('Reorder layer', () => partsStore.moveBy(part.id, 1)),
    }));
    row.appendChild(iconButton({
      label: `Move ${part.name} down`, glyph: '▼', disabled: index === ordered.length - 1,
      onClick: () => history.run('Reorder layer', () => partsStore.moveBy(part.id, -1)),
    }));
    row.appendChild(iconButton({
      label: part.visible ? `Hide ${part.name}` : `Show ${part.name}`,
      glyph: part.visible ? '👁' : '🚫', pressed: !part.visible,
      onClick: () => history.run(part.visible ? 'Hide layer' : 'Show layer',
        () => partsStore.setVisible(part.id, !part.visible)),
    }));
    row.appendChild(iconButton({
      label: part.locked ? `Unlock ${part.name}` : `Lock ${part.name}`,
      glyph: part.locked ? '🔒' : '🔓', pressed: part.locked,
      onClick: () => history.run(part.locked ? 'Unlock layer' : 'Lock layer',
        () => partsStore.setLocked(part.id, !part.locked)),
    }));

    item.appendChild(row);
    els.scenePartsList.appendChild(item);
  });
}

// ---- Layer actions -----------------------------------------------------

function handleDuplicatePart() {
  const part = partsStore.selected;
  if (!part) return;
  const copy = history.run('Duplicate layer', () => {
    const made = partsStore.duplicate(part.id);
    // Inside the action, so redo re-selects it exactly as the first run did.
    if (made) partsStore.select(made.id);
    return made;
  });
  if (copy) showToast(`Duplicated as "${copy.name}".`);
}

// Deleting a layer that bones are attached to would orphan those bones,
// so it asks first and defaults to keeping them: losing rig work must be
// an explicit choice, never a side effect.
function handleDeletePart() {
  const part = partsStore.selected;
  if (!part) return;

  const attached = bonesStore.bonesAttachedTo(part.id);
  if (attached.length === 0) {
    history.run('Delete layer', () => partsStore.remove(part.id));
    return;
  }

  pendingDeletePartId = part.id;
  const names = attached.map((bone) => `"${bone.name}"`).join(', ');
  els.deletePartMessage.textContent =
    `${attached.length} bone(s) are attached to "${part.name}": ${names}. ` +
    'Keeping them leaves them in the skeleton with no layer assigned, ready to ' +
    'point at another one. Deleting them also removes any bones beneath them ' +
    'from the skeleton, which cannot be undone by hand.';
  els.deletePartModal.hidden = false;
}

function completeDeletePart(alsoDeleteBones) {
  const partId = pendingDeletePartId;
  pendingDeletePartId = null;
  els.deletePartModal.hidden = true;
  if (!partId) return;

  const part = partsStore.parts.find((candidate) => candidate.id === partId);
  const attached = bonesStore.bonesAttachedTo(partId);
  history.run(alsoDeleteBones ? 'Delete layer and bones' : 'Delete layer', () => {
    if (alsoDeleteBones) {
      for (const bone of attached) bonesStore.deleteBone(bone.id);
    } else {
      bonesStore.detachPart(partId);
    }
    partsStore.remove(partId);
  });
  autoSaveNow('delete-layer');
  showToast(alsoDeleteBones
    ? `Deleted "${part ? part.name : 'layer'}" and ${attached.length} bone(s).`
    : `Deleted "${part ? part.name : 'layer'}". Its ${attached.length} bone(s) are now unassigned.`);
}

function cancelDeletePart() {
  pendingDeletePartId = null;
  els.deletePartModal.hidden = true;
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
  els.homeCanvasRow.hidden = !isHome;
  els.canvasSizeBtn.textContent = `Canvas ${sceneStore.width} × ${sceneStore.height} px`;

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

// ---- Undo / redo -------------------------------------------------------

function renderHistoryChrome() {
  els.undoBtn.disabled = !history.canUndo;
  els.redoBtn.disabled = !history.canRedo;
  els.undoBtn.title = history.canUndo ? `Undo ${history.undoLabel}` : 'Nothing to undo';
  els.redoBtn.title = history.canRedo ? `Redo ${history.redoLabel}` : 'Nothing to redo';
}

function handleUndo() {
  const label = history.undo();
  if (label) showToast(`Undid: ${label}`);
}

function handleRedo() {
  const label = history.redo();
  if (label) showToast(`Redid: ${label}`);
}

// Sliders and text fields fire a stream of input events; each interaction
// should still be ONE undo step. Snapshot on the first event, commit when
// the control settles.
function attachContinuousHistory(element, label) {
  let token = null;
  let timer = null;
  const finish = () => {
    clearTimeout(timer);
    timer = null;
    if (!token) return;
    history.commitCapture(token, true);
    token = null;
  };
  element.addEventListener('pointerdown', () => { if (!token) token = history.capture(label); });
  element.addEventListener('input', () => {
    if (!token) token = history.capture(label);
    clearTimeout(timer);
    timer = setTimeout(finish, 500);
  });
  element.addEventListener('change', finish);
  element.addEventListener('blur', finish);
}

// ---- Save / load / recovery -------------------------------------------

function formatTimestamp(ms) {
  const date = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function sanitizeProjectName(raw) {
  return String(raw || '').trim().replace(/[\\/:*?"<>|]/g, '').slice(0, 60);
}

function openSaveProjectModal() {
  els.projectNameInput.value = currentProjectName || '';
  els.saveProjectHint.textContent = currentProjectName
    ? `Saving over "${currentProjectName}" unless you change the name.`
    : 'Saved on this device. Loading a project replaces what is on the canvas.';
  els.saveProjectModal.hidden = false;
}

function closeSaveProjectModal() {
  els.saveProjectModal.hidden = true;
}

async function handleConfirmSaveProject() {
  const name = sanitizeProjectName(els.projectNameInput.value) || 'untitled';
  try {
    await storage.saveProject(name, serializeProject({ copyPixels: true }));
    currentProjectName = name;
    setAutoSaveSource(name);
    history.markSaved();
    await storage.clearRecovery(); // the manual save supersedes the recovery slot
    closeSaveProjectModal();
    showToast(`Saved "${name}".`);
  } catch (error) {
    console.warn(error);
    showToast(`Could not save: ${error.message}`);
  }
}

async function openProjectPicker() {
  els.projectList.replaceChildren();
  let projects = [];
  try {
    projects = await storage.listProjects();
  } catch (error) {
    console.warn(error);
    showToast(`Could not read saved projects: ${error.message}`);
    return;
  }

  els.openProjectEmpty.hidden = projects.length > 0;
  for (const project of projects) {
    const item = document.createElement('li');
    const row = document.createElement('div');
    row.className = 'project-row';

    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'project-open';
    const name = document.createElement('span');
    name.className = 'project-open__name';
    name.textContent = project.name;
    const date = document.createElement('span');
    date.className = 'project-open__date';
    date.textContent = `Last saved ${formatTimestamp(project.savedAt)}`;
    open.append(name, date);
    open.addEventListener('click', () => loadNamedProject(project.name));
    row.appendChild(open);

    row.appendChild(iconButton({
      label: `Delete project ${project.name}`, glyph: '🗑',
      onClick: async () => {
        await storage.deleteProject(project.name);
        if (currentProjectName === project.name) currentProjectName = null;
        openProjectPicker();
        showToast(`Deleted project "${project.name}".`);
      },
    }));

    item.appendChild(row);
    els.projectList.appendChild(item);
  }
  els.openProjectModal.hidden = false;
}

function closeProjectPicker() {
  els.openProjectModal.hidden = true;
}

async function loadNamedProject(name) {
  try {
    const record = await storage.loadProject(name);
    if (!record) {
      showToast(`"${name}" is no longer saved on this device.`);
      return;
    }
    applyProject(record.data);
    // A loaded project starts a fresh timeline: undoing back into the
    // previous project's edits would be nonsense.
    history.reset();
    currentProjectName = name;
    setAutoSaveSource(name);
    closeProjectPicker();
    view.fit();
    showToast(`Opened "${name}".`);
  } catch (error) {
    console.warn(error);
    showToast(`Could not open "${name}": ${error.message}`);
  }
}

// On launch, an auto-save newer than the newest manual save means the app
// went away with unsaved work in it.
async function offerRecovery() {
  let recovery = null;
  let projects = [];
  try {
    [recovery, projects] = await Promise.all([storage.loadRecovery(), storage.listProjects()]);
  } catch (error) {
    console.warn('Recovery check failed', error);
    return;
  }
  if (!recovery || !recovery.data) return;

  const contents = recovery.data;
  const hasContent = (contents.parts || []).length > 0 || (contents.bones || []).length > 0;
  const newestSave = projects.reduce((newest, project) => Math.max(newest, project.savedAt), 0);
  if (!hasContent || recovery.savedAt <= newestSave) return;

  pendingRecovery = recovery;
  const source = recovery.sourceName ? `"${recovery.sourceName}"` : 'an unsaved project';
  els.recoveryMessage.textContent =
    `Auto-saved work from ${source} at ${formatTimestamp(recovery.savedAt)} is newer than ` +
    `your last manual save. It has ${(contents.parts || []).length} layer(s) and ` +
    `${(contents.bones || []).length} bone(s).`;
  els.recoveryModal.hidden = false;
}

let pendingRecovery = null;

function restoreRecovery() {
  if (pendingRecovery) {
    applyProject(pendingRecovery.data);
    history.reset();
    currentProjectName = pendingRecovery.sourceName || null;
    setAutoSaveSource(currentProjectName);
    view.fit();
    showToast('Restored your auto-saved work.');
  }
  pendingRecovery = null;
  els.recoveryModal.hidden = true;
}

async function discardRecovery() {
  pendingRecovery = null;
  els.recoveryModal.hidden = true;
  try {
    await storage.clearRecovery();
  } catch (error) {
    console.warn(error);
  }
}

function bindEvents() {
  // FIRST, before the handlers that actually mutate: listeners on one
  // element fire in registration order, so the snapshot has to be taken
  // ahead of the change it is meant to record. One undo step per
  // interaction, not one per input event.
  attachContinuousHistory(els.rigDebugSlider, 'Rotate bone');
  attachContinuousHistory(els.debugRotateSlider, 'Rotate bone');
  attachContinuousHistory(els.boneNameInput, 'Rename bone');
  attachContinuousHistory(els.stiffnessSlider, 'Change stiffness');
  attachContinuousHistory(els.dampingSlider, 'Change damping');
  attachContinuousHistory(els.gravitySlider, 'Change gravity');
  attachContinuousHistory(els.densitySlider, 'Change mesh density');

  els.importBtn.addEventListener('click', handleImport);
  els.fitViewBtn.addEventListener('click', () => view.fit());
  els.canvasSizeBtn.addEventListener('click', openCanvasSizeModal);
  els.applyCanvasSizeBtn.addEventListener('click', applyCanvasSize);
  els.cancelCanvasSizeBtn.addEventListener('click', closeCanvasSizeModal);
  els.canvasWidthInput.addEventListener('input', renderCanvasPresets);
  els.canvasHeightInput.addEventListener('input', renderCanvasPresets);
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
  els.toFrontBtn.addEventListener('click', () =>
    history.run('Bring layer to front', () => partsStore.bringToFront(partsStore.selectedId)));
  els.toBackBtn.addEventListener('click', () =>
    history.run('Send layer to back', () => partsStore.sendToBack(partsStore.selectedId)));
  els.duplicatePartBtn.addEventListener('click', handleDuplicatePart);
  els.deletePartBtn.addEventListener('click', handleDeletePart);
  els.deletePartKeepBonesBtn.addEventListener('click', () => completeDeletePart(false));
  els.deletePartWithBonesBtn.addEventListener('click', () => completeDeletePart(true));
  els.deletePartCancelBtn.addEventListener('click', cancelDeletePart);

  els.undoBtn.addEventListener('click', handleUndo);
  els.redoBtn.addEventListener('click', handleRedo);
  els.boneLayerSelect.addEventListener('change', handleBoneLayerChange);

  els.saveProjectBtn.addEventListener('click', openSaveProjectModal);
  els.confirmSaveProjectBtn.addEventListener('click', handleConfirmSaveProject);
  els.cancelSaveProjectBtn.addEventListener('click', closeSaveProjectModal);
  els.openProjectBtn.addEventListener('click', openProjectPicker);
  els.cancelOpenProjectBtn.addEventListener('click', closeProjectPicker);
  els.restoreRecoveryBtn.addEventListener('click', restoreRecovery);
  els.discardRecoveryBtn.addEventListener('click', discardRecovery);


  els.saveGifBtn.addEventListener('click', () => handleSave('gif'));
  els.saveMp4Btn.addEventListener('click', () => handleSave('mp4'));
  els.cancelExportBtn.addEventListener('click', handleCancelExport);
}

export function initUI() {
  cacheElements();
  canvasEngine.initCanvas(els.canvas);
  // First, so its pointer bookkeeping runs before any tool sees the event.
  initViewGestures(els.canvas);
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
  sceneStore.subscribe(renderChrome);
  history.subscribe(renderHistoryChrome);

  initAutoSave({ onFailure: (error) => showToast(`Auto-save failed: ${error.message}`) });
  offerRecovery();
}
