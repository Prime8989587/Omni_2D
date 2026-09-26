// Pixel versions of the form controls the browser would otherwise draw.
//
// A <select> on Android opens the SYSTEM's own dropdown dialog -- smooth
// type, rounded corners, a platform look that belongs to no app. So every
// select in the app gets a pixel dropdown drawn over it: a pixel button
// showing the chosen option, and a pixel menu of the options when tapped.
// The real <select> stays in the document, hidden, and stays the source of
// truth: choosing from the menu sets its value and fires the same
// 'change' (and 'input') event a native pick would. So none of the code
// that reads `.value` or listens for 'change' had to change -- including
// code that builds selects on the fly (the PxLink list does, one per link):
// any select added later is picked up the moment it appears.
//
// Range sliders keep the native element (dragging, keyboard, accessibility)
// but are drawn entirely by the stylesheet; the one thing CSS cannot know
// is how far along the value is, so that is published here as --fill.

import { setIcon } from './pixelIcons.js';

const ENHANCED = new WeakMap();
let menu = null;
let openFor = null;

function optionLabel(select) {
  const option = select.options[select.selectedIndex];
  return option ? option.textContent : '';
}

function refresh(select) {
  const state = ENHANCED.get(select);
  if (!state) return;
  state.text.textContent = optionLabel(select);
  state.button.disabled = select.disabled;
  state.button.hidden = select.hidden;
  if (openFor === select) renderMenu(select);
}

function closeMenu() {
  if (!menu) return;
  menu.hidden = true;
  if (openFor) {
    const state = ENHANCED.get(openFor);
    if (state) state.button.setAttribute('aria-expanded', 'false');
  }
  openFor = null;
}

function choose(select, index) {
  if (select.selectedIndex !== index) {
    select.selectedIndex = index;
    select.dispatchEvent(new Event('input', { bubbles: true }));
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }
  refresh(select);
  closeMenu();
}

function renderMenu(select) {
  menu.replaceChildren();
  [...select.options].forEach((option, index) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'px-select__option';
    item.textContent = option.textContent;
    item.disabled = option.disabled;
    item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', String(index === select.selectedIndex));
    item.addEventListener('click', () => choose(select, index));
    menu.appendChild(item);
  });
}

function openMenu(select) {
  const state = ENHANCED.get(select);
  if (!menu) {
    menu = document.createElement('div');
    menu.className = 'px-select__menu';
    menu.setAttribute('role', 'listbox');
    menu.hidden = true;
    document.body.appendChild(menu);
  }
  renderMenu(select);
  openFor = select;
  state.button.setAttribute('aria-expanded', 'true');
  menu.hidden = false;
  // Under the button when there is room, above it when there is not, and
  // always inside the screen -- on whole pixels.
  const r = state.button.getBoundingClientRect();
  const width = Math.max(Math.round(r.width), 160);
  menu.style.width = `${width}px`;
  menu.style.left = `${Math.round(Math.min(Math.max(8, r.left), window.innerWidth - width - 8))}px`;
  const height = menu.offsetHeight;
  const below = window.innerHeight - r.bottom;
  const top = below >= height + 8 || below >= r.top ? r.bottom + 4 : r.top - height - 4;
  menu.style.top = `${Math.round(Math.max(8, Math.min(top, window.innerHeight - height - 8)))}px`;
}

export function enhanceSelect(select) {
  if (!select || ENHANCED.has(select)) return;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `px-select ${select.className}`.trim();
  button.setAttribute('aria-haspopup', 'listbox');
  button.setAttribute('aria-expanded', 'false');
  const label = select.getAttribute('aria-label')
    || (select.closest('label') && select.closest('label').textContent.trim());
  if (label) button.setAttribute('aria-label', label);
  if (select.id) button.dataset.selectFor = select.id;
  const text = document.createElement('span');
  text.className = 'px-select__text';
  const chevron = document.createElement('span');
  chevron.className = 'px-select__chevron';
  setIcon(chevron, 'chevron-down');
  button.append(text, chevron);
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    if (openFor === select) closeMenu(); else openMenu(select);
  });
  select.classList.add('px-select__native');
  select.insertAdjacentElement('afterend', button);
  ENHANCED.set(select, { button, text });

  // Code sets .value / .selectedIndex directly, and rebuilds the options,
  // without any event -- so both are watched here, on this one element.
  for (const prop of ['value', 'selectedIndex']) {
    const desc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, prop);
    Object.defineProperty(select, prop, {
      configurable: true,
      get() { return desc.get.call(this); },
      set(v) { desc.set.call(this, v); refresh(this); },
    });
  }
  new MutationObserver(() => refresh(select)).observe(select, {
    childList: true, subtree: true, attributes: true, characterData: true,
  });
  select.addEventListener('change', () => refresh(select));
  refresh(select);
}

export function syncSlider(input) {
  const min = Number(input.min || 0);
  const max = Number(input.max || 100);
  const t = max > min ? (Number(input.value) - min) / (max - min) : 0;
  input.style.setProperty('--fill', `${Math.round(Math.max(0, Math.min(1, t)) * 1000) / 10}%`);
}

function enhanceSlider(input) {
  if (ENHANCED.has(input)) return;
  ENHANCED.set(input, true);
  const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
  Object.defineProperty(input, 'value', {
    configurable: true,
    get() { return desc.get.call(this); },
    set(v) { desc.set.call(this, v); syncSlider(this); },
  });
  input.addEventListener('input', () => syncSlider(input));
  syncSlider(input);
}

function enhanceAll(root) {
  if (root.nodeType !== 1) return;
  if (root.matches('select')) enhanceSelect(root);
  if (root.matches('input[type="range"]')) enhanceSlider(root);
  root.querySelectorAll('select').forEach(enhanceSelect);
  root.querySelectorAll('input[type="range"]').forEach(enhanceSlider);
}

export function initPixelControls() {
  enhanceAll(document.body);
  new MutationObserver((mutations) => {
    for (const m of mutations) for (const node of m.addedNodes) enhanceAll(node);
  }).observe(document.body, { childList: true, subtree: true });
  // A tap anywhere else, or scrolling the page under it, closes the menu.
  document.addEventListener('click', (event) => {
    if (menu && !menu.hidden && !menu.contains(event.target)) closeMenu();
  });
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeMenu(); });
  window.addEventListener('resize', closeMenu);
}
