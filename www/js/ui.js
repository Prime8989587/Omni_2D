// Wires DOM elements to the app state machine (state.js), the scene model
// (parts.js), and the canvas facade (canvas.js). All button handlers,
// disabled-state logic, and the Scene Parts panel live here. No rendering
// or animation logic belongs in this file -- that lives in canvas.js.

import { appState, AppState } from './state.js';
import {
  partsStore, PierceRole, PIERCE_DEPTH_RANGE, clampPierceDepth, PiercePhysics,
} from './parts.js';
import { bonesStore, PHYSICS_RANGES, JointType } from './bones.js';
import { initPhysics } from './physics.js';
import { sceneStore, SCENE_PRESETS } from './scene.js';
import { view } from './view.js';
import { initViewGestures } from './viewGestures.js';
import { importFiles } from './importer.js';
import { initGestures } from './gestures.js';
import { initRigTool, beginPlaceBone, cancelPlacement, getRigStatus, subscribeRig } from './rigTool.js';
import { initBindTool, setBrushRadius, setBrushStrength, getBrush } from './bindTool.js';
import {
  initPoseTool, initMovePad, PoseTarget, getPoseTarget, setPoseTarget, hasPiercerTarget,
} from './poseTool.js';
import { bindPart, defaultDensity } from './mesh.js';
import { history } from './history.js';
import { serializeProject, applyProject } from './project.js';
import * as storage from './storage.js';
import { initAutoSave, setAutoSaveSource, autoSaveNow } from './autosave.js';
import * as canvasEngine from './canvas.js';
import { initPxPin } from './pxpin.js';
import { initPierceTool, openPiercePainter } from './pierceTool.js';
import { pierceOverlayEnabled, setPierceOverlay } from './pierce.js';
import * as psaver from './psaver.js';

const TOAST_DURATION_MS = 4000;
const NUDGE_STEP_PX = 1; // one grid cell
const NUDGE_STEP_RADIANS = (2 * Math.PI) / 180;

// Visual identity pass: every TRUE emoji the app used (colour pictographs
// the OS renders from its own emoji font, immune to CSS `color`) is drawn
// here instead, at the same low resolution and nearest-neighbour rule as
// imported character art. Plain symbol/arrow glyphs elsewhere (✕ ⋮ ▲ ▼ ⌄
// ⌫ ⇄ ↺ ↻ ⤢ ✿ ...) are not emoji -- they already render as flat, colourless
// icon glyphs today -- and are left as text.
const EMOJI_ICONS = {
  '✏️': 'icon-pencil',
  '👁': 'icon-eye',
  '🚫': 'icon-hidden',
  '🔒': 'icon-lock',
  '🔓': 'icon-unlock',
  '🗑': 'icon-trash',
  '📌': 'icon-pin',
};

// Appends `glyph` to `el`: a small pixel-art <img> if it is one of the
// emoji above, or a plain text node otherwise (so callers can pass either
// kind without caring which one they have).
function appendGlyph(el, glyph) {
  const icon = EMOJI_ICONS[glyph];
  if (icon) {
    const img = document.createElement('img');
    img.className = 'pixel-icon';
    img.src = `icons/${icon}.png`;
    img.alt = glyph;
    img.setAttribute('aria-hidden', 'true');
    el.appendChild(img);
  } else {
    el.appendChild(document.createTextNode(glyph));
  }
}

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
let stateMenuOpen = false;
let restorePoint = null; // the state "Reverse" comes back to
let pendingStateAction = null;
let openPartMenuId = null; // which Scene Parts row's "⋮" aside is open, if any
let renamingPartId = null; // which Scene Parts row is mid-rename, if any
let canvasSizeMirror = false; // Canvas size modal: type one side, the other follows
let bindRiggedOnly = false; // Bind Parts tab: hide layers no bone has claimed

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
  els.canvasMirrorToggle = document.getElementById('canvasMirrorToggle');
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
  for (const id of [
    'pierceModal', 'pierceLayerName', 'pierceRoleNoneBtn', 'pierceRolePiercerBtn',
    'pierceRolePiercedBtn', 'pierceRoleHint', 'pierceDepthSummary',
    'piercePhysicsRow', 'piercePhysicsPiercerBtn', 'piercePhysicsPiercedBtn',
    'piercePhysicsBothBtn', 'piercePhysicsHint',
    'pierceDepthReadout', 'pierceEditDepthsBtn', 'piercePaintBtn', 'pierceOverlayBtn', 'pierceRemoveBtn',
    'pierceDoneBtn', 'pierceDepthModal', 'pierceEnterInput', 'pierceEndInput',
    'pierceDepthContact', 'pierceDepthEnterMark', 'pierceDepthEndMark',
    'pierceDepthCanvas', 'pierceDrawHint',
    'pierceDepthLegend', 'pierceDepthOkBtn', 'pierceDepthCancelBtn',
    'pierceTipModal', 'pierceTipOkBtn',
  ]) {
    els[id] = document.getElementById(id);
  }

  for (const id of [
    'psaverExportBtn', 'psaverImportBtn', 'psaverFileInput', 'psaverExportModal',
    'psaverNameInput', 'psaverExportConfirmBtn', 'psaverExportCancelBtn',
    'psaverResultModal', 'psaverResultTitle', 'psaverResultMessage',
    'psaverResultPath', 'psaverResultOkBtn',
  ]) {
    els[id] = document.getElementById(id);
  }
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
  els.bindRiggedOnlyToggle = document.getElementById('bindRiggedOnlyToggle');

  els.rigDebugSlider = document.getElementById('rigDebugSlider');
  els.rigDebugValue = document.getElementById('rigDebugValue');
  els.jointRigidBtn = document.getElementById('jointRigidBtn');
  els.jointPhysicsBtn = document.getElementById('jointPhysicsBtn');
  els.jointPivotBtn = document.getElementById('jointPivotBtn');
  els.jointHint = document.getElementById('jointHint');
  els.physicsParams = document.getElementById('physicsParams');
  els.stiffnessSlider = document.getElementById('stiffnessSlider');
  els.stiffnessValue = document.getElementById('stiffnessValue');
  els.dampingSlider = document.getElementById('dampingSlider');
  els.dampingValue = document.getElementById('dampingValue');
  els.gravitySlider = document.getElementById('gravitySlider');
  els.gravityValue = document.getElementById('gravityValue');
  els.inertiaSlider = document.getElementById('inertiaSlider');
  els.inertiaValue = document.getElementById('inertiaValue');
  els.animateHint = document.getElementById('animateHint');
  els.movePad = document.getElementById('movePad');
  els.poseTargetRow = document.getElementById('poseTargetRow');
  els.poseTargetBodyBtn = document.getElementById('poseTargetBodyBtn');
  els.poseTargetPiercerBtn = document.getElementById('poseTargetPiercerBtn');
  els.appMenuBtn = document.getElementById('appMenuBtn');
  els.appMenu = document.getElementById('appMenu');
  els.stateSaveBtn = document.getElementById('stateSaveBtn');
  els.stateReverseBtn = document.getElementById('stateReverseBtn');
  els.stateDiscardBtn = document.getElementById('stateDiscardBtn');
  els.stateConfirmModal = document.getElementById('stateConfirmModal');
  els.stateConfirmTitle = document.getElementById('stateConfirmTitle');
  els.stateConfirmMessage = document.getElementById('stateConfirmMessage');
  els.stateConfirmOkBtn = document.getElementById('stateConfirmOkBtn');
  els.stateConfirmCancelBtn = document.getElementById('stateConfirmCancelBtn');

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
  if (result.imported > 0) {
    autoSaveNow('import');
    // The first import IS the original state, so Reverse works without
    // anyone having thought to press Save beforehand.
    if (!restorePoint) writeRestorePoint('as imported');
  }

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
    // The bone's REST pose: this readout sits beside the nudge buttons and
    // describes the pose being authored, so it must not flicker with a
    // spring's jiggle (and must match what a nudge actually changes).
    const head = bonesStore.restWorldHead(bone);
    const degrees = Math.round((bonesStore.restWorldRotation(bone) * 180) / Math.PI);
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
    if (status.stage === 'head') {
      return status.parentName
        ? `Tap where on "${status.parentName}" this bone should start.`
        : 'Tap the canvas to place the root bone’s head.';
    }
    return status.parentName
      ? `Now tap the far end of the new bone.`
      : 'Tap again to set the root bone’s tail.';
  }
  if (bonesStore.isEmpty) return 'Tap Add Bone to place the root bone.';
  if (!bonesStore.selected) return 'Tap a bone to select it as the parent for the next bone.';
  return `Add Bone will attach to "${bonesStore.selected.name}" wherever you tap on it.`;
}

// ---- Canvas size & view ------------------------------------------------

function openCanvasSizeModal() {
  els.canvasWidthInput.value = String(sceneStore.width);
  els.canvasHeightInput.value = String(sceneStore.height);
  renderCanvasMirrorToggle();
  renderCanvasPresets();
  els.canvasSizeModal.hidden = false;
}

function closeCanvasSizeModal() {
  els.canvasSizeModal.hidden = true;
}

function renderCanvasMirrorToggle() {
  els.canvasMirrorToggle.setAttribute('aria-pressed', String(canvasSizeMirror));
  els.canvasMirrorToggle.textContent = `⇄ Mirror: ${canvasSizeMirror ? 'On' : 'Off'}`;
}

// OFF (the default) leaves width and height independent, exactly as
// before. ON, typing into either field copies the SAME VALUE the user is
// actually typing into the other -- never a fixed number -- so a square
// canvas only needs entering once.
function handleCanvasMirrorToggle() {
  canvasSizeMirror = !canvasSizeMirror;
  renderCanvasMirrorToggle();
  if (canvasSizeMirror) {
    els.canvasHeightInput.value = els.canvasWidthInput.value;
    renderCanvasPresets();
  }
}

function handleCanvasWidthInput() {
  if (canvasSizeMirror) els.canvasHeightInput.value = els.canvasWidthInput.value;
  renderCanvasPresets();
}

function handleCanvasHeightInput() {
  if (canvasSizeMirror) els.canvasWidthInput.value = els.canvasHeightInput.value;
  renderCanvasPresets();
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

const JOINT_LABELS = {
  [JointType.RIGID]: 'Rigid',
  [JointType.PHYSICS]: 'Physics',
  [JointType.PIVOT]: 'Pivot',
};

const JOINT_HINTS = {
  [JointType.RIGID]: 'Turns with its parent, instantly.',
  [JointType.PHYSICS]: 'Trails behind its parent and settles, like hair or cloth.',
  [JointType.PIVOT]: 'Carried by its parent, but never turned by it — its own angle is yours to set.',
};

function handleJointTypeChange(type) {
  const bone = bonesStore.selected;
  if (!bone || bone.jointType === type) return;
  history.run(`Set ${JOINT_LABELS[type].toLowerCase()} joint`,
    () => bonesStore.setJointType(bone.id, type));

  // A spring bone jiggles the layer it was given and nothing else, so one
  // with no layer has nothing to jiggle. Say so, rather than letting the
  // user switch physics on and watch nothing happen.
  if (type === JointType.PHYSICS && !bone.attachedPartId) {
    showToast(`"${bone.name}" has physics but no layer — set "Controls layer" ` +
      'so it has artwork to move.');
  }
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
  // Three behaviours, so three buttons: an on/off toggle cannot say which
  // of the two "not physics" answers a bone is giving.
  for (const [type, button] of [
    [JointType.RIGID, els.jointRigidBtn],
    [JointType.PHYSICS, els.jointPhysicsBtn],
    [JointType.PIVOT, els.jointPivotBtn],
  ]) {
    const active = bone.jointType === type;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', String(active));
  }
  els.jointHint.textContent = JOINT_HINTS[bone.jointType] || '';
  els.physicsParams.hidden = !bone.physicsEnabled;

  if (!bone.physicsEnabled) return;
  els.stiffnessSlider.value = String(bone.stiffness);
  els.stiffnessValue.textContent = String(bone.stiffness);
  els.dampingSlider.value = String(bone.damping);
  els.dampingValue.textContent = bone.damping.toFixed(1);
  els.gravitySlider.value = String(bone.gravityInfluence);
  els.gravityValue.textContent = String(bone.gravityInfluence);
  els.inertiaSlider.value = String(bone.inertia);
  els.inertiaValue.textContent = bone.inertia.toFixed(1);
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
    ? partsStore.partsTopFirst
        // "Rigged only" hides layers no bone has claimed. Off by default:
        // an unclaimed layer is still a legitimate one to bind (auto-weight
        // falls back to whichever bones are nearest), so this narrows the
        // list on request rather than ever dropping that path silently.
        .filter((part) => !bindRiggedOnly || bonesStore.bonesAttachedTo(part.id).length > 0)
        .map((part) => ({
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

  if (rows.length === 0 && bindListTab === 'parts' && bindRiggedOnly) {
    const item = document.createElement('li');
    const note = document.createElement('p');
    note.className = 'rig-hint';
    note.textContent = 'No layer has a bone attached yet — set "Controls layer" on a bone in Rig mode, or turn this filter off.';
    item.appendChild(note);
    els.bindList.appendChild(item);
    return;
  }

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

function handleBindRiggedOnlyToggle() {
  bindRiggedOnly = !bindRiggedOnly;
  renderBindList();
  renderBindChrome();
}

function renderBindChrome() {
  const isBind = currentState === AppState.BIND;
  els.bindPanel.hidden = !isBind;
  els.bindControls.hidden = !isBind;
  els.bindHint.hidden = !isBind;
  if (!isBind) return;

  // The filter only means anything among layers, so it stays out of the
  // way on the Bones tab rather than sitting there doing nothing.
  els.bindRiggedOnlyToggle.hidden = bindListTab !== 'parts';
  els.bindRiggedOnlyToggle.setAttribute('aria-pressed', String(bindRiggedOnly));
  els.bindRiggedOnlyToggle.textContent = bindRiggedOnly ? 'Show: Rigged only' : 'Show: All layers';

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
    // Say which bones will actually take this layer, because that is now
    // what the result depends on -- and if the answer is "whichever are
    // nearest", say that too rather than letting it be a surprise.
    const assigned = bonesStore.bonesAttachedTo(part.id);
    els.bindHint.textContent = assigned.length
      ? `Auto-weight Part binds "${part.name}" to ${assigned.map((b) => `"${b.name}"`).join(', ')}.`
      : `Auto-weight Part binds "${part.name}" to whichever bones are nearest. ` +
        'To pin it to particular ones, set "Controls layer" on them in Rig mode.';
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
  appendGlyph(button, glyph);
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
// is a name plus a single "⋮" button; the four controls that used to sit
// in the row itself (move up/down, show/hide, lock) plus Rename now live
// in an aside panel the "⋮" opens directly under that row -- at most one
// open at a time, tracked by the part's id so it survives the re-render
// a move/toggle causes and stays open on the SAME row.
function renderPartsList() {
  els.scenePartsList.replaceChildren();

  const ordered = partsStore.partsTopFirst;
  // A row that was open or mid-rename can't stay that way once its part
  // is gone (deleted, or a project/undo replaced the whole list).
  if (openPartMenuId && !ordered.some((part) => part.id === openPartMenuId)) openPartMenuId = null;
  if (renamingPartId && !ordered.some((part) => part.id === renamingPartId)) renamingPartId = null;

  ordered.forEach((part, index) => {
    const item = document.createElement('li');

    if (renamingPartId === part.id) {
      item.appendChild(partRenameRow(part));
      els.scenePartsList.appendChild(item);
      return;
    }

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

    const isOpen = openPartMenuId === part.id;
    row.appendChild(iconButton({
      label: isOpen ? `Close menu for ${part.name}` : `More actions for ${part.name}`,
      glyph: isOpen ? '✕' : '⋮',
      pressed: isOpen,
      onClick: () => {
        // Tapping the open row's own button closes it; tapping any other
        // row's button closes whatever was open and opens this one --
        // never two at once.
        openPartMenuId = isOpen ? null : part.id;
        renderPartsList();
      },
    }));

    item.appendChild(row);
    if (isOpen) item.appendChild(partRowAside(part, index, ordered.length));
    els.scenePartsList.appendChild(item);
  });
}

// The panel a row's "⋮" opens: Rename plus the four controls it replaced,
// unchanged in behavior. Left open after Move/Show/Lock (still anchored
// to this part's id) so several taps in a row don't each need reopening
// it; Rename instead swaps the row into edit mode.
function partRowAside(part, index, total) {
  const aside = document.createElement('div');
  aside.className = 'row-aside';

  const action = (label, glyph, onClick, extra = {}) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'row-aside__btn';
    if (extra.pressed !== undefined) button.setAttribute('aria-pressed', String(extra.pressed));
    button.disabled = Boolean(extra.disabled);
    appendGlyph(button, glyph);
    button.appendChild(document.createTextNode(` ${label}`));
    button.addEventListener('click', onClick);
    aside.appendChild(button);
  };

  action('Rename', '✏️', () => {
    openPartMenuId = null;
    renamingPartId = part.id;
    renderPartsList();
  });
  // The list runs top-of-stack first, so "up" in the list is +1 in z.
  action('Move up', '▲', () => history.run('Reorder layer', () => partsStore.moveBy(part.id, 1)),
    { disabled: index === 0 });
  action('Move down', '▼', () => history.run('Reorder layer', () => partsStore.moveBy(part.id, -1)),
    { disabled: index === total - 1 });
  action(part.visible ? 'Hide' : 'Show', part.visible ? '👁' : '🚫',
    () => history.run(part.visible ? 'Hide layer' : 'Show layer',
      () => partsStore.setVisible(part.id, !part.visible)),
    { pressed: !part.visible });
  action(part.locked ? 'Unlock' : 'Lock', part.locked ? '🔒' : '🔓',
    () => history.run(part.locked ? 'Unlock layer' : 'Lock layer',
      () => partsStore.setLocked(part.id, !part.locked)),
    { pressed: part.locked });
  // Pierce lives with the other per-layer settings rather than in a mode
  // of its own: a role is a property of THIS layer, set where everything
  // else about the layer is set.
  action(part.hasPierceRole ? `Pierce: ${part.pierceRole}` : 'Pierce', '◆', () => {
    openPartMenuId = null;
    renderPartsList();
    openPierceModal(part.id);
  }, { pressed: part.hasPierceRole });

  return aside;
}

// Swaps a row's name button for a text field. Commits on Enter or blur,
// cancels (reverting the typed text) on Escape; a blank or unchanged
// value is treated as a cancel rather than a no-op rename. `settled`
// guards against Enter's commit AND the blur it triggers both firing.
function partRenameRow(part) {
  const row = document.createElement('div');
  row.className = 'list-row';

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'text-input text-input--inline';
  input.value = part.name;
  input.autocomplete = 'off';
  input.setAttribute('aria-label', `Rename ${part.name}`);

  let settled = false;
  const leaveRenameMode = () => {
    renamingPartId = null;
    renderPartsList();
  };
  const commit = () => {
    if (settled) return;
    settled = true;
    // Same validity check partsStore.rename() applies internally -- kept
    // here too so a no-op (blank, or unchanged) never reaches history.run
    // and pushes a pointless undo step for nothing having changed.
    const value = input.value.trim();
    leaveRenameMode();
    if (value && value !== part.name) {
      history.run('Rename layer', () => partsStore.rename(part.id, value));
    }
  };
  const cancel = () => {
    if (settled) return;
    settled = true;
    leaveRenameMode();
  };

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); commit(); }
    else if (event.key === 'Escape') { event.preventDefault(); cancel(); }
  });
  input.addEventListener('blur', commit);

  row.appendChild(input);
  requestAnimationFrame(() => { input.focus(); input.select(); });
  return row;
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

// ---- Pierce ------------------------------------------------------------
//
// A pierce is a relationship between exactly two KINDS of layer: a
// PIERCER (which carries a painted tip and two depths) and a PIERCED
// layer (which carries a painted pierceable area). Both sides are set
// here, by hand, on the layer's own settings panel.
//
// THE ROLE IS ALWAYS READ, NEVER GUESSED. Free Move asks which layers it
// may drag on their own, and the deformation asks whose artwork may be
// displaced; both questions are answered by this stored flag alone. No
// amount of painted region data, overlap or proximity makes a layer a
// piercer -- only the user saying so here.

// Which side's movement may deepen a contact. The measurement itself is
// symmetric -- either layer moving changes the gap by the same amount --
// so this is a choice rather than a capability, and the hints say which
// way round each option leaves it.
const PIERCE_PHYSICS_HINTS = {
  [PiercePhysics.PIERCER]: 'Only this piercer moving deepens the contact. A pierced ' +
    'layer moved onto it keeps whatever contact it has, but cannot push further in.',
  [PiercePhysics.PIERCED]: 'The reverse: only the pierced layer moving deepens the ' +
    'contact. Driving this piercer further in stops having any effect.',
  [PiercePhysics.BOTH]: 'Either one moving deepens the contact, by however much it ' +
    'closed the gap — so the two add up rather than competing.',
};

const PIERCE_TIP_SEEN_KEY = 'omni2d.pierce.tipSeen';
const PIERCE_OVERLAY_KEY = 'omni2d.pierce.overlay';

let pierceModalPartId = null;
// How the depth popup was opened, which decides what Cancel means:
//   'assign' -- mid-assignment, and the role is NOT saved yet. Cancelling
//               leaves the layer at None rather than saving a piercer with
//               no depths, exactly as an unfinished assignment should.
//   'edit'   -- an already-configured piercer. Cancelling changes nothing.
let pierceDepthMode = null;

function piercePart() {
  return partsStore.parts.find((part) => part.id === pierceModalPartId) || null;
}

function openPierceModal(partId) {
  pierceModalPartId = partId;
  renderPierceModal();
  els.pierceModal.hidden = false;
}

function closePierceModal() {
  pierceModalPartId = null;
  els.pierceModal.hidden = true;
}

const PIERCE_ROLE_HINTS = {
  [PierceRole.NONE]: 'Not part of a pierce. This layer behaves exactly as normal.',
  [PierceRole.PIERCER]: 'This layer does the piercing. Paint its tip, and set how ' +
    'close it has to get before the other layer starts to move.',
  [PierceRole.PIERCED]: 'This layer gets pierced. Paint the area a piercer is ' +
    'allowed to push into. Its own bones and physics keep running as normal.',
};

function renderPierceModal() {
  const part = piercePart();
  if (!part) return;

  els.pierceLayerName.textContent = part.name;
  els.pierceRoleNoneBtn.setAttribute('aria-pressed', String(part.pierceRole === PierceRole.NONE));
  els.pierceRolePiercerBtn.setAttribute('aria-pressed', String(part.isPiercer));
  els.pierceRolePiercedBtn.setAttribute('aria-pressed', String(part.isPierced));
  els.pierceRoleHint.textContent = PIERCE_ROLE_HINTS[part.pierceRole];

  // Depths and the physics direction belong to the piercer side of the
  // relationship, so they only appear on a piercer.
  els.pierceDepthSummary.hidden = !part.isPiercer;
  els.piercePhysicsRow.hidden = !part.isPiercer;
  if (part.isPiercer) {
    const physics = part.piercePhysics || PiercePhysics.PIERCER;
    els.piercePhysicsPiercerBtn.setAttribute('aria-pressed', String(physics === PiercePhysics.PIERCER));
    els.piercePhysicsPiercedBtn.setAttribute('aria-pressed', String(physics === PiercePhysics.PIERCED));
    els.piercePhysicsBothBtn.setAttribute('aria-pressed', String(physics === PiercePhysics.BOTH));
    els.piercePhysicsHint.textContent = PIERCE_PHYSICS_HINTS[physics];
  }
  if (part.isPiercer) {
    els.pierceDepthReadout.textContent =
      `Enter ${part.pierceEnter} px · End ${part.pierceEnd} px — contact starts ` +
      `${part.pierceEnter} px out, and the push stops growing ${part.pierceEnd} px deeper.`;
  }

  const painted = part.pierceRegion.size;
  els.piercePaintBtn.hidden = !part.hasPierceRole;
  // On an pierced layer the second number is the one that decides how
  // much of that area actually gives way, and "all" is what an unpainted
  // deformable mask means -- worth saying, because a blank count there
  // would read as "nothing will move".
  const walls = part.pierceBarrierRegion.size;
  const soft = part.isPierced
    ? ` · ${part.pierceDeformRegion.size || 'all'} deformable${walls ? ` · ${walls} wall` : ''}`
    : '';
  els.piercePaintBtn.textContent = painted
    ? `Paint regions… (${painted} px marked${soft})`
    : 'Paint regions…';
  els.pierceOverlayBtn.setAttribute('aria-pressed', String(pierceOverlayEnabled()));
  els.pierceRemoveBtn.hidden = !part.hasPierceRole;
}

// The overlay is a property of the whole scene, not of the layer whose
// popup happens to be open -- it tints every painted region there is, so
// that both halves of a pierce can be checked against each other at once.
function togglePierceOverlay() {
  setPierceOverlay(!pierceOverlayEnabled());
  const on = pierceOverlayEnabled();
  try {
    window.localStorage.setItem(PIERCE_OVERLAY_KEY, on ? '1' : '0');
  } catch { /* storage blocked: the toggle still works for this session */ }
  renderPierceModal();
  canvasEngine.requestRender();
  showToast(on
    ? 'Painted regions are tinted on the canvas — pink tip, cyan pierceable.'
    : 'Region tinting is off.');
}

// Restored on launch so a testing session survives a reload, which is
// exactly when the overlay is most wanted.
function restorePierceOverlay() {
  try {
    setPierceOverlay(window.localStorage.getItem(PIERCE_OVERLAY_KEY) === '1');
  } catch { /* no-op */ }
}

// Assigning PIERCER is not complete until its two depths exist, so the
// role is not written until the popup confirms. Cancel therefore has
// nothing to undo -- the layer simply never left None.
function choosePierceRole(role) {
  const part = piercePart();
  if (!part || part.pierceRole === role) return;

  if (role === PierceRole.NONE) {
    removePierceRole(part.id);
    return;
  }

  if (role === PierceRole.PIERCER) {
    openPierceDepthModal('assign');
    return;
  }

  history.run('Set pierce role', () => partsStore.setPierceRole(part.id, role));
  renderPierceModal();
  showToast(`"${part.name}" is now Pierced. Paint the pierceable area next — Paint regions….`);
}

function removePierceRole(partId) {
  const part = partsStore.parts.find((candidate) => candidate.id === partId);
  if (!part || !part.hasPierceRole) return;
  const was = part.pierceRole;
  // Only pierce data goes. The artwork, position, bones, weights and Px
  // Pin pins on this layer are none of this feature's business.
  history.run('Remove pierce role', () => partsStore.setPierceRole(partId, PierceRole.NONE));
  renderPierceModal();
  showToast(`Removed the ${was} role from "${part.name}". Its artwork, bones and pins are untouched.`);
}

// ---- Enter / End points

function openPierceDepthModal(mode) {
  const part = piercePart();
  if (!part) return;
  pierceDepthMode = mode;
  els.pierceEnterInput.value = String(part.pierceEnter);
  els.pierceEndInput.value = String(part.pierceEnd);
  renderPierceDepthBar();
  // The modal has to be visible before the canvas is measured: a hidden
  // element has no layout box, and the drawing is laid out from one.
  els.pierceDepthModal.hidden = false;
  depthDraw = null;
  renderPierceDepthCanvas();
}

function readPierceDepthInputs() {
  return {
    enter: clampPierceDepth(els.pierceEnterInput.value),
    end: clampPierceDepth(els.pierceEndInput.value),
  };
}

// The bar draws the whole approach in order: a run-up where the tip is
// still too far out to do anything, the Enter mark where contact begins,
// and the stretch beyond it where the push grows to its limit. The run-up
// is drawn Enter long so the mark keeps a sensible place on the bar as the
// two numbers change; it is a proportion, not a second distance reading,
// which is why the legend names distances only where there is one to name.
function renderPierceDepthBar() {
  const { enter, end } = readPierceDepthInputs();
  const span = Math.max(1, enter + end);
  const enterPct = (enter / span) * 100;
  els.pierceDepthEnterMark.style.left = `${enterPct}%`;
  els.pierceDepthEndMark.style.left = '100%';
  els.pierceDepthContact.style.left = `${enterPct}%`;
  els.pierceDepthContact.style.right = '0';
  els.pierceDepthLegend.textContent =
    `Left edge: the tip still approaching, nothing moves. Enter at ${enter} px ` +
    `away: contact begins. Right edge: ${end} px deeper still, maximum push — ` +
    'going deeper than this changes nothing more.';
}

// ---- Placing Enter and End by hand, on the piercer itself
//
// The numbers are the same numbers. This draws the piercer's own artwork
// with its painted tip highlighted and a ruler running out along the
// direction that tip points, and puts the two depths on it as handles --
// so "how far ahead of itself does this needle start pushing" can be
// answered by looking at the needle rather than by guessing at a figure.
// Dragging a handle writes the input; typing in the input moves the
// handle. Neither is the source of truth: the Part is, and both of these
// are views onto it.

const DRAW_MARGIN = 26;      // canvas px kept clear at each end
const DRAW_MIN_SPAN = 48;    // scene px of ruler, however small the depths are
const DRAW_GRAB_PX = 34;     // how near a handle a touch counts as grabbing it

let depthDraw = null;

// The piercer's artwork as something drawImage can scale, built once per
// modal opening rather than per frame.
function piercerBitmap(part) {
  const canvas = document.createElement('canvas');
  canvas.width = part.naturalWidth;
  canvas.height = part.naturalHeight;
  const ctx = canvas.getContext('2d');
  const image = ctx.createImageData(part.naturalWidth, part.naturalHeight);
  image.data.set(part.pixels);
  ctx.putImageData(image, 0, 0);
  return canvas;
}

// Where the tip points, in the layer's OWN space: from the sprite's middle
// to the middle of the painted tip. The same rule the solver uses for the
// real axis, minus the scene transform -- the sprite is drawn here as
// authored, so the ruler has to be too. With nothing painted yet there is
// no direction to read, and straight down is the honest default for a
// needle whose tip the user has not marked.
function localPierceAxis(part) {
  if (part.pierceRegion.size === 0) return { x: 0, y: 1, known: false };
  let sx = 0;
  let sy = 0;
  for (const index of part.pierceRegion) {
    sx += (index % part.naturalWidth) + 0.5 - part.naturalWidth / 2;
    sy += Math.floor(index / part.naturalWidth) + 0.5 - part.naturalHeight / 2;
  }
  const n = part.pierceRegion.size;
  const length = Math.hypot(sx / n, sy / n);
  if (length < 1e-6) return { x: 0, y: 1, known: false };
  return { x: (sx / n) / length, y: (sy / n) / length, known: true };
}

// Rebuilds the whole drawing model: scale, where the ruler starts, how
// long it is. Deliberately NOT recomputed mid-drag -- a ruler that
// rescaled itself as the handle moved would slide out from under the
// finger holding it.
function planPierceDepthDraw() {
  const part = piercePart();
  const canvas = els.pierceDepthCanvas;
  if (!part || !canvas) return null;

  const { enter, end } = readPierceDepthInputs();
  const axis = localPierceAxis(part);
  const span = Math.max(DRAW_MIN_SPAN, (enter + end) * 1.6);

  // Everything in SCENE pixels: the depths are, and the sprite's own
  // texels convert through its integer scale.
  const spriteW = part.naturalWidth * part.scale;
  const spriteH = part.naturalHeight * part.scale;
  // How far the painted tip reaches from the sprite's middle along the
  // axis -- where the ruler starts, because that is the part that arrives.
  let lead = 0;
  if (axis.known) {
    for (const index of part.pierceRegion) {
      const lx = ((index % part.naturalWidth) + 0.5 - part.naturalWidth / 2) * part.scale;
      const ly = (Math.floor(index / part.naturalWidth) + 0.5 - part.naturalHeight / 2) * part.scale;
      lead = Math.max(lead, lx * axis.x + ly * axis.y);
    }
  } else {
    lead = (Math.abs(axis.x) * spriteW + Math.abs(axis.y) * spriteH) / 2;
  }

  // Fit the WHOLE drawing, sprite and ruler together, rather than the
  // sprite alone: the ruler runs along the tip's direction, which for a
  // needle pointing down is the canvas's short axis. Fitting only the
  // sprite put the End handle 62 px below the bottom edge, where it could
  // be neither seen nor dragged.
  const far = lead + span;
  const xs = [-spriteW / 2, spriteW / 2, axis.x * far];
  const ys = [-spriteH / 2, spriteH / 2, axis.y * far];
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);

  const scale = Math.min(
    (canvas.width - DRAW_MARGIN * 2) / Math.max(1, maxX - minX),
    (canvas.height - DRAW_MARGIN * 2) / Math.max(1, maxY - minY)
  );
  // Centre that box, then place the sprite's middle inside it.
  const originX = (canvas.width - (maxX - minX) * scale) / 2 - minX * scale;
  const originY = (canvas.height - (maxY - minY) * scale) / 2 - minY * scale;

  return { part, axis, span, lead, scale, originX, originY, bitmap: piercerBitmap(part) };
}

// A distance along the ruler, in scene px, to a point on the canvas.
function depthDrawPoint(plan, distance) {
  const along = plan.lead + distance;
  return {
    x: plan.originX + plan.axis.x * along * plan.scale,
    y: plan.originY + plan.axis.y * along * plan.scale,
  };
}

function renderPierceDepthCanvas() {
  const canvas = els.pierceDepthCanvas;
  if (!canvas) return;
  if (!depthDraw) depthDraw = planPierceDepthDraw();
  const plan = depthDraw;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!plan) return;

  const { enter, end } = readPierceDepthInputs();
  const { part, axis, scale } = plan;

  ctx.imageSmoothingEnabled = false;

  // The sprite, drawn as authored about its own middle.
  const w = part.naturalWidth * part.scale * scale;
  const h = part.naturalHeight * part.scale * scale;
  ctx.drawImage(plan.bitmap, plan.originX - w / 2, plan.originY - h / 2, w, h);

  // The painted tip, tinted so it is obvious which end is which.
  ctx.fillStyle = 'rgba(255, 46, 147, 0.55)';
  const texel = part.scale * scale;
  for (const index of part.pierceRegion) {
    const u = index % part.naturalWidth;
    const v = Math.floor(index / part.naturalWidth);
    ctx.fillRect(
      plan.originX - w / 2 + u * texel,
      plan.originY - h / 2 + v * texel,
      Math.max(1, texel), Math.max(1, texel)
    );
  }

  // The ruler, from the tip's leading edge outward.
  const from = depthDrawPoint(plan, 0);
  const to = depthDrawPoint(plan, plan.span);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
  ctx.lineWidth = 2;
  ctx.setLineDash([5, 5]);
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x, to.y);
  ctx.stroke();
  ctx.setLineDash([]);

  // The stretch between the two marks is where the push grows.
  const a = depthDrawPoint(plan, enter);
  const b = depthDrawPoint(plan, enter + end);
  // Dimmer than the Enter handle it starts at, so the span reads as the
  // stretch BETWEEN two marks rather than as a third thing to grab.
  ctx.strokeStyle = '#1C8FA6';
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();

  const handle = (point, label, colour) => {
    ctx.beginPath();
    ctx.arc(point.x, point.y, 9, 0, Math.PI * 2);
    ctx.fillStyle = colour;
    ctx.fill();
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = '#FFFFFF';
    ctx.font = '15px monospace';
    ctx.textAlign = 'center';
    // Labels sit clear of the ruler, on whichever side has room.
    ctx.fillText(label, point.x, point.y - 15 + (axis.y < 0 ? 34 : 0));
  };
  // Not the accent pink: the painted tip is already tinted with it just
  // along the ruler, and two pinks a few pixels apart is the one pairing
  // on this canvas that cannot be read at a glance.
  handle(a, `Enter ${enter}`, '#2EE6FF');
  handle(b, `End ${end}`, '#FFB02E');

  els.pierceDrawHint.textContent = plan.axis.known
    ? 'Drag either handle along the needle\u2019s path. Enter is where contact ' +
      'begins; End is how much deeper the push keeps growing.'
    : 'This piercer has no painted tip yet, so the path below is a guess at ' +
      'straight down. Paint the tip and these will follow it.';
}

// Which handle a touch is going for: whichever is nearer, provided it is
// near enough at all. Ties go to End, the one on the outside, because it
// is the one a finger coming in from the open end of the ruler meets first.
function grabPierceHandle(x, y) {
  const plan = depthDraw;
  if (!plan) return null;
  const { enter, end } = readPierceDepthInputs();
  const a = depthDrawPoint(plan, enter);
  const b = depthDrawPoint(plan, enter + end);
  const da = Math.hypot(x - a.x, y - a.y);
  const db = Math.hypot(x - b.x, y - b.y);
  if (Math.min(da, db) > DRAW_GRAB_PX) return null;
  return db <= da ? 'end' : 'enter';
}

// A canvas point back to a distance along the ruler, by projecting onto
// the axis -- which is what makes this work at any tip direction rather
// than only a horizontal one.
function depthDrawDistance(plan, x, y) {
  const along = (x - plan.originX) * plan.axis.x + (y - plan.originY) * plan.axis.y;
  return along / plan.scale - plan.lead;
}

function pierceDepthCanvasPoint(event) {
  const canvas = els.pierceDepthCanvas;
  const rect = canvas.getBoundingClientRect();
  return {
    x: (event.clientX - rect.left) * (canvas.width / rect.width),
    y: (event.clientY - rect.top) * (canvas.height / rect.height),
  };
}

function dragPierceHandle(which, x, y) {
  const plan = depthDraw;
  if (!plan) return;
  const distance = depthDrawDistance(plan, x, y);
  const { enter, end } = readPierceDepthInputs();
  if (which === 'enter') {
    // Enter cannot pass End: they are two points on one scale, in order.
    els.pierceEnterInput.value = String(clampPierceDepth(
      Math.min(distance, enter + end - PIERCE_DEPTH_RANGE.min)
    ));
  } else {
    els.pierceEndInput.value = String(clampPierceDepth(distance - enter));
  }
  renderPierceDepthBar();
  renderPierceDepthCanvas();
}

function initPierceDepthCanvas() {
  const canvas = els.pierceDepthCanvas;
  if (!canvas) return;
  let dragging = null;
  canvas.addEventListener('pointerdown', (event) => {
    const point = pierceDepthCanvasPoint(event);
    dragging = grabPierceHandle(point.x, point.y);
    if (!dragging) return;
    event.preventDefault();
    // A synthetic event (tests) has no live pointer to capture.
    try { canvas.setPointerCapture(event.pointerId); } catch { /* no-op */ }
    dragPierceHandle(dragging, point.x, point.y);
  });
  canvas.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    event.preventDefault();
    const point = pierceDepthCanvasPoint(event);
    dragPierceHandle(dragging, point.x, point.y);
  });
  const release = () => { dragging = null; };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);
}

function confirmPierceDepths() {
  const part = piercePart();
  if (!part) return;
  const { enter, end } = readPierceDepthInputs();
  const assigning = pierceDepthMode === 'assign';
  pierceDepthMode = null;
  els.pierceDepthModal.hidden = true;

  history.run(assigning ? 'Set pierce role' : 'Edit pierce depths', () => {
    if (assigning) partsStore.setPierceRole(part.id, PierceRole.PIERCER);
    partsStore.setPierceDepths(part.id, enter, end);
  });
  renderPierceModal();

  if (assigning) {
    showPierceTipOnce();
    showToast(`"${part.name}" is now a Piercer. Paint its tip next — Paint regions….`);
  } else {
    showToast(`Enter ${enter} px · End ${end} px.`);
  }
}

// Cancelling mid-assignment must not leave a Piercer with no depths, so
// the role is simply never written -- the layer stays None.
function cancelPierceDepths() {
  const assigning = pierceDepthMode === 'assign';
  pierceDepthMode = null;
  els.pierceDepthModal.hidden = true;
  renderPierceModal();
  if (assigning) showToast('Cancelled — Enter and End Points are required, so the role stayed None.');
}

// ---- The one-time Px Pin tip

function showPierceTipOnce() {
  let seen = false;
  try {
    seen = window.localStorage.getItem(PIERCE_TIP_SEEN_KEY) === '1';
  } catch {
    // A browser with storage blocked shows the tip every time rather than
    // never -- the tip is harmless, losing it is not.
  }
  if (seen) return;
  try {
    window.localStorage.setItem(PIERCE_TIP_SEEN_KEY, '1');
  } catch { /* no-op */ }
  els.pierceTipModal.hidden = false;
}

// Opens the region painter for this layer, paired with the opposite side
// of the relationship (a piercer pairs with an pierced layer and vice
// versa), so both are visible at their real relative positions while
// painting. Defined in section 2.
function handleOpenPiercePainter() {
  const part = piercePart();
  if (!part) return;
  const partner = part.isPiercer ? partsStore.piercedLayers[0] : partsStore.piercers[0];
  if (!partner) {
    showToast(part.isPiercer
      ? 'No Pierced layer yet — set one on the layer that should get pierced.'
      : 'No Piercer layer yet — set one on the layer that should do the piercing.');
    return;
  }
  closePierceModal();
  openPiercePainter(part.id, partner.id);
}

// Deleting a layer that bones are attached to would orphan those bones,
// so it asks first and defaults to keeping them: losing rig work must be
// an explicit choice, never a side effect.
function handleDeletePart() {
  const part = partsStore.selected;
  if (!part) return;

  const attached = bonesStore.bonesAttachedTo(part.id);
  const orphaned = pierceOrphansOf(part);

  // Nothing to warn about: no bones to strand, no pierce to break.
  if (attached.length === 0 && !part.hasPierceRole) {
    history.run('Delete layer', () => partsStore.remove(part.id));
    return;
  }

  pendingDeletePartId = part.id;
  const warnings = [];
  if (attached.length > 0) {
    const names = attached.map((bone) => `"${bone.name}"`).join(', ');
    warnings.push(
      `${attached.length} bone(s) are attached to "${part.name}": ${names}. ` +
      'Keeping them leaves them in the skeleton with no layer assigned, ready to ' +
      'point at another one. Deleting them also removes any bones beneath them ' +
      'from the skeleton, which cannot be undone by hand.'
    );
  }
  if (part.hasPierceRole) {
    warnings.push(
      `"${part.name}" is the ${part.pierceRole} in an active Pierce. Deleting it ` +
      'breaks that pairing' +
      (orphaned.length
        ? `, so ${orphaned.map((other) => `"${other.name}"`).join(', ')} will be set back to ` +
          'None as well — a pierce cannot exist with only one side present.'
        : '.')
    );
  }
  els.deletePartMessage.textContent = warnings.join(' ');

  // With no bones in play, "keep bones" and "delete bones" are the same
  // act, so only one button is offered rather than two that do the same
  // thing under different names.
  els.deletePartKeepBonesBtn.textContent = attached.length
    ? 'Delete layer, keep bones'
    : 'Delete layer';
  els.deletePartWithBonesBtn.hidden = attached.length === 0;
  els.deletePartModal.hidden = false;
}

// The layers whose pierce role would be left with nothing to pair with if
// `part` went away. A role survives as long as at least one layer on the
// other side remains, so deleting one of two piercers strands nobody --
// deleting the last one strands every pierced layer.
function pierceOrphansOf(part) {
  if (!part.hasPierceRole) return [];
  const sameSide = part.isPiercer ? partsStore.piercers : partsStore.piercedLayers;
  if (sameSide.length > 1) return [];
  return part.isPiercer ? partsStore.piercedLayers : partsStore.piercers;
}

function completeDeletePart(alsoDeleteBones) {
  const partId = pendingDeletePartId;
  pendingDeletePartId = null;
  els.deletePartModal.hidden = true;
  if (!partId) return;

  const part = partsStore.parts.find((candidate) => candidate.id === partId);
  const attached = bonesStore.bonesAttachedTo(partId);
  const orphaned = part ? pierceOrphansOf(part) : [];
  history.run(alsoDeleteBones ? 'Delete layer and bones' : 'Delete layer', () => {
    if (alsoDeleteBones) {
      for (const bone of attached) bonesStore.deleteBone(bone.id);
    } else {
      bonesStore.detachPart(partId);
    }
    // Both halves go together: leaving the survivor flagged would leave a
    // role pointing at a relationship that no longer has another side.
    for (const other of orphaned) partsStore.setPierceRole(other.id, PierceRole.NONE);
    partsStore.remove(partId);
  });
  autoSaveNow('delete-layer');
  const name = part ? part.name : 'layer';
  const bits = [];
  if (alsoDeleteBones && attached.length) bits.push(`${attached.length} bone(s) went with it`);
  else if (attached.length) bits.push(`its ${attached.length} bone(s) are now unassigned`);
  if (orphaned.length) {
    bits.push(`${orphaned.map((other) => `"${other.name}"`).join(', ')} is back to Pierce role None`);
  }
  showToast(bits.length ? `Deleted "${name}" — ${bits.join('; ')}.` : `Deleted "${name}".`);
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
  // Import belongs to the Home screen, and the other screens need the
  // room in the top bar for their mode label.
  els.importBtn.hidden = !isHome;
  els.canvasEmptyHint.hidden = !isHome || !partsStore.isEmpty;
  els.homeCanvasRow.hidden = !isHome;
  els.canvasSizeBtn.textContent = `Canvas ${sceneStore.width} × ${sceneStore.height} px`;

  els.canvasWrap.classList.toggle('is-animate-mode', isAnimateMode);
  els.canvasWrap.classList.toggle('is-rig-mode', isRig || isBind);
  els.canvasWrap.classList.toggle('is-recording', isRecording);

  // Free Move: drag the canvas, or the pad below, to move the character.
  const canMove = isAnimating && !bonesStore.isEmpty && !partsStore.isEmpty;
  els.animateHint.hidden = !isAnimating;
  els.movePad.hidden = !canMove;
  // The Piercer tab is only meaningful once some layer actually carries
  // the role, so with no piercer in the scene there is nothing to choose
  // between and the row stays away entirely.
  const canPierce = canMove && hasPiercerTarget();
  if (!canPierce && getPoseTarget() === PoseTarget.PIERCER) setPoseTarget(PoseTarget.BODY);
  els.poseTargetRow.hidden = !canPierce;
  els.poseTargetBodyBtn.setAttribute('aria-pressed', String(getPoseTarget() === PoseTarget.BODY));
  els.poseTargetPiercerBtn.setAttribute('aria-pressed', String(getPoseTarget() === PoseTarget.PIERCER));
  if (isAnimating) {
    els.animateHint.textContent = bonesStore.isEmpty
      ? 'Build a skeleton in Rig mode first — Free Move moves the character by its root bone.'
      : partsStore.isEmpty
        ? 'Import artwork first, then move it here.'
        : canPierce
          ? getPoseTarget() === PoseTarget.PIERCER
            ? 'Dragging moves the PIERCER only. The character keeps running its own ' +
              'physics underneath — bring the tip in and its pierceable area gives way.'
            : 'Dragging moves the whole character, leaving the piercer where it is. ' +
              'Switch to Piercer to move that instead.'
          : 'Drag anywhere on the canvas to move the whole character — or use the pad below to ' +
            'keep your finger clear of it. Spring bones trail behind and settle.';
  }

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
  renderStateChrome();
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

// Everything that means "this snapshot is now the project on screen".
// Opening a saved project and importing a PSaver file are the same act
// once the data is in hand, so they go through here rather than each
// remembering to reset history, repoint the auto-save and re-fit the view.
function adoptProject(data, name) {
  applyProject(data);
  // A loaded project starts a fresh timeline: undoing back into the
  // previous project's edits would be nonsense.
  history.reset();
  currentProjectName = name;
  setAutoSaveSource(name);
  view.fit();
}

async function loadNamedProject(name) {
  try {
    const record = await storage.loadProject(name);
    if (!record) {
      showToast(`"${name}" is no longer saved on this device.`);
      return;
    }
    adoptProject(record.data, name);
    closeProjectPicker();
    showToast(`Opened "${name}".`);
  } catch (error) {
    console.warn(error);
    showToast(`Could not open "${name}": ${error.message}`);
  }
}

// ---- PSaver: projects as files ----------------------------------------
//
// Save/Open keeps a project in the app's own storage, which an uninstall
// or a "clear data" takes with it. PSaver writes the same project to a
// file the user can move off the device and read back afterwards. The
// heavy lifting is in psaver.js; this is the buttons and the wording.

function openPSaverExport() {
  els.psaverNameInput.value = currentProjectName || '';
  els.psaverExportModal.hidden = false;
}

function closePSaverExport() {
  els.psaverExportModal.hidden = true;
}

// Export and import both end in something the user needs to READ -- a
// path to go and find, or an explanation of why a file was rejected. A
// toast times out; this does not.
function showPSaverResult(title, message, path = '') {
  els.psaverResultTitle.textContent = title;
  els.psaverResultMessage.textContent = message;
  els.psaverResultPath.textContent = path;
  els.psaverResultPath.hidden = !path;
  els.psaverResultModal.hidden = false;
}

async function handlePSaverExport() {
  const name = sanitizeProjectName(els.psaverNameInput.value) ||
    els.psaverNameInput.placeholder;
  closePSaverExport();
  try {
    const result = await psaver.exportToFile(name);
    const size = `${Math.max(1, Math.round(result.bytes / 1024))} KB`;
    showPSaverResult(
      'Exported',
      result.durable
        ? `"${result.filename}" (${size}) was written to ${result.where}. ` +
          'It stays there if you uninstall or reinstall Omni 2D — copy it somewhere ' +
          'safe and you can bring this character back with PSaver: Import.'
        : `"${result.filename}" (${size}) was written to ${result.where}, because this ` +
          'device would not let Omni 2D write to shared storage. THAT FOLDER IS ' +
          'DELETED IF YOU UNINSTALL THE APP — move the file somewhere else now.',
      // On Android this is the real path to go and look at; in a browser
      // the download went wherever the browser puts downloads and the uri
      // is just the filename again, which the message already said.
      result.uri === result.filename ? '' : result.uri
    );
  } catch (error) {
    console.warn(error);
    showPSaverResult('Export failed', error.message || String(error));
  }
}

function handlePSaverImport() {
  els.psaverFileInput.value = ''; // so re-picking the same file still fires
  els.psaverFileInput.click();
}

async function handlePSaverFilePicked(event) {
  const file = event.target.files && event.target.files[0];
  event.target.value = '';
  if (!file) return;

  let parsed;
  try {
    // Validated in full BEFORE the scene is touched, so a bad file leaves
    // whatever is on the canvas exactly as it was.
    parsed = await psaver.readPickedFile(file);
  } catch (error) {
    console.warn(error);
    showPSaverResult(
      'Import failed',
      error instanceof psaver.PSaverError
        ? error.message
        : `That file could not be read: ${error.message || error}`
    );
    return;
  }

  const name = sanitizeProjectName(parsed.name) || null;
  adoptProject(parsed.data, name);
  closeStateMenu();
  const layers = (parsed.data.parts || []).length;
  const bones = (parsed.data.bones || []).length;
  showToast(
    `Imported ${name ? `"${name}"` : 'project'} — ${layers} layer(s), ${bones} bone(s). ` +
    'Save project… to keep it on this device.'
  );
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

// ---- Saved state: Save / Reverse / Discard ----------------------------
//
// One state the user can come back to. It is captured automatically the
// first time artwork is imported, so "Reverse" means "how it was when I
// uploaded it" without anyone having to think about it in advance, and a
// deliberate Save overwrites it with whatever they like better.

// Saving, opening and discarding belong to the project, not to whichever
// screen you happen to be on, so this menu hangs off the top bar and is
// reachable from Home, Rig, Bind and Free Move alike -- no mode gating.
function renderStateChrome() {
  els.appMenu.hidden = !stateMenuOpen;
  els.appMenuBtn.setAttribute('aria-expanded', String(stateMenuOpen));
  els.stateReverseBtn.disabled = !restorePoint;
  els.stateReverseBtn.textContent = restorePoint ? 'Reverse' : 'Reverse (nothing saved yet)';
  els.stateDiscardBtn.disabled = partsStore.isEmpty && bonesStore.isEmpty;
}

function toggleStateMenu() {
  stateMenuOpen = !stateMenuOpen;
  renderStateChrome();
}

function closeStateMenu() {
  if (!stateMenuOpen) return;
  stateMenuOpen = false;
  renderStateChrome();
}

function askState({ title, message, confirmLabel, danger, onConfirm }) {
  pendingStateAction = onConfirm;
  els.stateConfirmTitle.textContent = title;
  els.stateConfirmMessage.textContent = message;
  els.stateConfirmOkBtn.textContent = confirmLabel;
  els.stateConfirmOkBtn.classList.toggle('btn--danger', Boolean(danger));
  els.stateConfirmOkBtn.classList.toggle('btn--flourish', !danger);
  els.stateConfirmModal.hidden = false;
}

function closeStateConfirm() {
  pendingStateAction = null;
  els.stateConfirmModal.hidden = true;
}

function runStateAction() {
  const action = pendingStateAction;
  closeStateConfirm();
  if (action) action();
}

// Keeps the in-memory copy and the stored one together, so the state
// survives closing the app.
async function writeRestorePoint(label) {
  const data = serializeProject({ copyPixels: true });
  restorePoint = { label, savedAt: Date.now(), data };
  renderStateChrome();
  try {
    await storage.saveRestorePoint(data, label);
  } catch (error) {
    console.warn('Could not store the restore point', error);
  }
}

function handleStateSave() {
  stateMenuOpen = false;
  askState({
    title: 'Save this state?',
    message: restorePoint
      ? 'This replaces the state Reverse comes back to. The one you saved before is gone.'
      : 'Reverse will bring the character back to exactly this arrangement.',
    confirmLabel: 'Save',
    onConfirm: async () => {
      await writeRestorePoint('saved');
      showToast('Saved. Reverse comes back here.');
    },
  });
  renderStateChrome();
}

function handleStateReverse() {
  stateMenuOpen = false;
  renderStateChrome();
  if (!restorePoint) {
    showToast('Nothing saved yet — use Save first.');
    return;
  }
  history.run('Reverse to saved state', () => applyProject(restorePoint.data));
  view.fit();
  showToast('Back to the saved state. Press ↶ to undo.');
}

function handleStateDiscard() {
  stateMenuOpen = false;
  renderStateChrome();
  askState({
    title: 'Discard everything?',
    message:
      'This removes every layer and every bone, leaving an empty canvas. ' +
      'Your saved projects are not touched, and ↶ undoes it — but nothing else will bring it back.',
    confirmLabel: 'Discard everything',
    danger: true,
    onConfirm: () => {
      history.run('Discard everything', () => {
        partsStore.replaceAll([], null);
        bonesStore.replaceAll([], null);
      });
      appState.exitAnimateMode(); // nothing left to move; back to Home
      showToast('Everything discarded. Press ↶ to undo.');
    },
  });
}

async function loadRestorePointFromStorage() {
  try {
    const record = await storage.loadRestorePoint();
    if (record && record.data) restorePoint = record;
  } catch (error) {
    console.warn('Could not read the restore point', error);
  }
  renderStateChrome();
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
  attachContinuousHistory(els.inertiaSlider, 'Change sway');
  attachContinuousHistory(els.densitySlider, 'Change mesh density');

  els.importBtn.addEventListener('click', handleImport);
  els.fitViewBtn.addEventListener('click', () => view.fit());
  els.canvasSizeBtn.addEventListener('click', openCanvasSizeModal);
  els.applyCanvasSizeBtn.addEventListener('click', applyCanvasSize);
  els.cancelCanvasSizeBtn.addEventListener('click', closeCanvasSizeModal);
  els.canvasWidthInput.addEventListener('input', handleCanvasWidthInput);
  els.canvasHeightInput.addEventListener('input', handleCanvasHeightInput);
  els.canvasMirrorToggle.addEventListener('click', handleCanvasMirrorToggle);
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
  els.bindRiggedOnlyToggle.addEventListener('click', handleBindRiggedOnlyToggle);

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
  els.jointRigidBtn.addEventListener('click', () => handleJointTypeChange(JointType.RIGID));
  els.jointPhysicsBtn.addEventListener('click', () => handleJointTypeChange(JointType.PHYSICS));
  els.jointPivotBtn.addEventListener('click', () => handleJointTypeChange(JointType.PIVOT));
  els.stiffnessSlider.addEventListener('input', () =>
    handlePhysicsParam('stiffness', els.stiffnessSlider, els.stiffnessValue));
  els.dampingSlider.addEventListener('input', () =>
    handlePhysicsParam('damping', els.dampingSlider, els.dampingValue, 1));
  els.gravitySlider.addEventListener('input', () =>
    handlePhysicsParam('gravityInfluence', els.gravitySlider, els.gravityValue));
  els.inertiaSlider.addEventListener('input', () =>
    handlePhysicsParam('inertia', els.inertiaSlider, els.inertiaValue, 1));

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

  els.pierceRoleNoneBtn.addEventListener('click', () => choosePierceRole(PierceRole.NONE));
  els.pierceRolePiercerBtn.addEventListener('click', () => choosePierceRole(PierceRole.PIERCER));
  els.pierceRolePiercedBtn.addEventListener('click', () => choosePierceRole(PierceRole.PIERCED));
  els.pierceEditDepthsBtn.addEventListener('click', () => openPierceDepthModal('edit'));
  els.pierceRemoveBtn.addEventListener('click', () => removePierceRole(pierceModalPartId));
  els.piercePaintBtn.addEventListener('click', handleOpenPiercePainter);
  for (const [btn, physics] of [
    [els.piercePhysicsPiercerBtn, PiercePhysics.PIERCER],
    [els.piercePhysicsPiercedBtn, PiercePhysics.PIERCED],
    [els.piercePhysicsBothBtn, PiercePhysics.BOTH],
  ]) {
    btn.addEventListener('click', () => {
      const part = piercePart();
      if (!part) return;
      history.run('Set physics direction', () => partsStore.setPiercePhysics(part.id, physics));
      renderPierceModal();
    });
  }
  els.pierceOverlayBtn.addEventListener('click', togglePierceOverlay);
  els.pierceDoneBtn.addEventListener('click', closePierceModal);
  const onDepthTyped = () => {
    renderPierceDepthBar();
    // Re-plan, so a number far outside the current ruler brings the ruler
    // with it. A drag never does this -- see planPierceDepthDraw.
    depthDraw = null;
    renderPierceDepthCanvas();
  };
  els.pierceEnterInput.addEventListener('input', onDepthTyped);
  els.pierceEndInput.addEventListener('input', onDepthTyped);
  els.pierceDepthOkBtn.addEventListener('click', confirmPierceDepths);
  els.pierceDepthCancelBtn.addEventListener('click', cancelPierceDepths);
  els.pierceTipOkBtn.addEventListener('click', () => { els.pierceTipModal.hidden = true; });

  els.poseTargetBodyBtn.addEventListener('click', () => { setPoseTarget(PoseTarget.BODY); renderChrome(); });
  els.poseTargetPiercerBtn.addEventListener('click', () => { setPoseTarget(PoseTarget.PIERCER); renderChrome(); });

  els.appMenuBtn.addEventListener('click', (event) => {
    event.stopPropagation(); // so the document listener below doesn't close it again
    toggleStateMenu();
  });
  // A floating menu over the canvas has to be dismissable by tapping past
  // it, not only by finding the button again.
  document.addEventListener('click', (event) => {
    if (!stateMenuOpen) return;
    if (els.appMenu.contains(event.target)) return;
    closeStateMenu();
  });
  els.stateSaveBtn.addEventListener('click', handleStateSave);
  els.stateReverseBtn.addEventListener('click', handleStateReverse);
  els.stateDiscardBtn.addEventListener('click', handleStateDiscard);
  els.stateConfirmOkBtn.addEventListener('click', runStateAction);
  els.stateConfirmCancelBtn.addEventListener('click', closeStateConfirm);

  els.undoBtn.addEventListener('click', handleUndo);
  els.redoBtn.addEventListener('click', handleRedo);
  els.boneLayerSelect.addEventListener('change', handleBoneLayerChange);

  // Now that these live in the menu, choosing one has to dismiss it before
  // its modal opens -- otherwise the menu is still sitting there behind it.
  els.saveProjectBtn.addEventListener('click', () => { closeStateMenu(); openSaveProjectModal(); });
  els.psaverExportBtn.addEventListener('click', () => { closeStateMenu(); openPSaverExport(); });
  els.psaverImportBtn.addEventListener('click', () => { closeStateMenu(); handlePSaverImport(); });
  els.psaverExportConfirmBtn.addEventListener('click', handlePSaverExport);
  els.psaverExportCancelBtn.addEventListener('click', closePSaverExport);
  els.psaverFileInput.addEventListener('change', handlePSaverFilePicked);
  els.psaverResultOkBtn.addEventListener('click', () => { els.psaverResultModal.hidden = true; });
  els.confirmSaveProjectBtn.addEventListener('click', handleConfirmSaveProject);
  els.cancelSaveProjectBtn.addEventListener('click', closeSaveProjectModal);
  els.openProjectBtn.addEventListener('click', () => { closeStateMenu(); openProjectPicker(); });
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
  initPoseTool(els.canvas);
  initMovePad(els.movePad);
  bindEvents();
  initPhysics();

  applySliderRange(els.stiffnessSlider, PHYSICS_RANGES.stiffness);
  applySliderRange(els.dampingSlider, PHYSICS_RANGES.damping);
  applySliderRange(els.gravitySlider, PHYSICS_RANGES.gravityInfluence);
  applySliderRange(els.inertiaSlider, PHYSICS_RANGES.inertia);

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

  initPxPin();
  initPierceTool();
  initPierceDepthCanvas();
  restorePierceOverlay();
  initAutoSave({ onFailure: (error) => showToast(`Auto-save failed: ${error.message}`) });
  offerRecovery();
  loadRestorePointFromStorage();
}
