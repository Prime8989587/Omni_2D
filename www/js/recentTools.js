// Recent tools: the last three tools you actually used, one tap away.
//
// Getting back into Px Pin means Bind mode, then its button; Pierce means a
// layer's menu, the Pierce popup, then Paint regions; PCreate means backing
// out to Home. When you are going back and forth between two tools, that is
// the same walk every time. So a small row of chips -- at the top of the
// workspace and on the Home screen -- shows the three most recently used,
// newest first, and a tap goes straight back in.
//
// "Used" means the tool's session actually OPENED, not that its button was
// tapped: a Px Pin picker cancelled, or a PxLink refused for want of a
// second layer, never counts. Each tool reports itself here the moment it
// starts, with whatever it needs to reopen exactly as it was -- Px Pin its
// two layers, the Pierce painter its pair, Mesh Trim its layer -- and the
// row updates at once. The list is kept in local storage, so it is still
// there the next time the app is opened.
//
// This module knows nothing about how to open anything: ui.js registers a
// launcher per tool. That keeps the tools free of any dependency on each
// other, and this free of any dependency on them.

import { createIcon } from './pixelIcons.js';

const STORAGE_KEY = 'omni2d.recentTools';
export const SHOWN = 3;

export const TOOLS = {
  pxpin: { label: 'Px Pin', icon: 'pin' },
  pxlink: { label: 'PxLink', icon: 'link' },
  pierce: { label: 'Pierce', icon: 'pierce' },
  meshtrim: { label: 'Mesh Trim', icon: 'mesh' },
  clayer: { label: 'CLayer', icon: 'scissors' },
  pcreate: { label: 'PCreate', icon: 'brush' },
};

let recent = load();
const launchers = new Map();
const listeners = new Set();

function load() {
  try {
    const raw = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || '[]');
    return Array.isArray(raw) ? raw.filter((r) => r && TOOLS[r.id]).slice(0, SHOWN) : [];
  } catch {
    return [];
  }
}

function persist() {
  try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(recent)); } catch { /* storage blocked: still works this session */ }
}

export function noteToolUsed(id, context = null) {
  if (!TOOLS[id]) return;
  recent = [{ id, context, at: Date.now() }, ...recent.filter((r) => r.id !== id)].slice(0, SHOWN);
  persist();
  render();
  listeners.forEach((fn) => fn(recent));
}

export function recentTools() {
  return recent.map((r) => ({ ...r }));
}

export function subscribeRecentTools(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function registerToolLauncher(id, launch) {
  launchers.set(id, launch);
}

export function launchRecentTool(id) {
  const entry = recent.find((r) => r.id === id);
  const launch = launchers.get(id);
  if (entry && launch) launch(entry.context || {});
}

function render() {
  for (const bar of document.querySelectorAll('[data-recent-tools]')) {
    bar.replaceChildren();
    bar.hidden = recent.length === 0;
    if (recent.length === 0) continue;
    const label = document.createElement('span');
    label.className = 'recent-tools__label';
    label.append(createIcon('clock'), document.createTextNode('Recent'));
    bar.appendChild(label);
    recent.forEach((entry, index) => {
      const tool = TOOLS[entry.id];
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = `recent-tools__chip${index === 0 ? ' recent-tools__chip--latest' : ''}`;
      chip.dataset.recentTool = entry.id;
      chip.setAttribute('aria-label', `Open ${tool.label} again`);
      chip.append(createIcon(tool.icon), document.createTextNode(tool.label));
      chip.addEventListener('click', () => launchRecentTool(entry.id));
      bar.appendChild(chip);
    });
  }
}

export function initRecentTools() {
  render();
}
