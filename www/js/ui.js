// Wires DOM elements to the app state machine (state.js), the scene model
// (parts.js), and the canvas facade (canvas.js). All button handlers,
// disabled-state logic, and the Scene Parts panel live here. No rendering
// or animation logic belongs in this file -- that lives in canvas.js.

import { appState, AppState } from './state.js';
import { partsStore } from './parts.js';
import { importFiles } from './importer.js';
import { initGestures } from './gestures.js';
import * as canvasEngine from './canvas.js';

const TOAST_DURATION_MS = 4000;

const els = {};
let currentState = AppState.HOME;
let scenePanelOpen = true;
let toastTimer = null;

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
  const isAnimating = currentState === AppState.ANIMATING;
  const isRecording = currentState === AppState.RECORDING;
  const isAnimateMode = isAnimating || isRecording;

  els.homeControls.hidden = !isHome;
  els.animateControls.hidden = isHome;

  els.modeLabel.hidden = !isAnimateMode;
  els.modeLabelText.textContent = isRecording ? 'Recording...' : 'Animate Mode';
  els.modeLabel.classList.toggle('is-recording', isRecording);
  els.logo.hidden = !isHome;
  els.canvasEmptyHint.hidden = !isHome || !partsStore.isEmpty;

  els.canvasWrap.classList.toggle('is-animate-mode', isAnimateMode);
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
  els.selectionBar.hidden = !selected;
  if (selected) {
    els.selectedPartName.textContent = selected.name;
  }
}

function bindEvents() {
  els.importBtn.addEventListener('click', handleImport);
  els.fileInput.addEventListener('change', handleFilesPicked);
  els.animateBtn.addEventListener('click', handleAnimateTapped);
  els.exitBtn.addEventListener('click', handleExit);
  els.startBtn.addEventListener('click', handleStart);
  els.stopBtn.addEventListener('click', handleStop);

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
}
