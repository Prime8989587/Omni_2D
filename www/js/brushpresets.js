// Favourite brush sizes, as a row of chips beside the size control.
//
// Every tool with an adjustable brush -- Px Pin, the Pierce region painter,
// weight painting, the Mesh Trim boundary brush, CLayer's boundary brush and
// PCreate's brush and eraser -- has the same problem:
// getting back to a size you use constantly means opening a menu and
// finding it, or dragging a slider from wherever it happens to be. A
// handful of one-tap shortcuts removes that, and because they are stored
// in the settings record they are still there next session.
//
// ONE RENDERER FOR ALL OF THEM, because they differ only in their range and
// in how a size reads: the square brushes are whole squares ("4×4"),
// weight painting is a screen-pixel radius ("45 px"). Everything else --
// the chips, the save star, the pressed state, the persistence -- is
// identical, and a copy per tool would be a place per tool for the
// behaviour to drift.

import { getSetting, togglePreset, hasPreset, subscribeSettings } from './settings.js';
import { setIcon } from './pixelIcons.js';

// Renders (or re-renders) one preset row.
//
//   container  the element to fill
//   key        which presets setting this row edits
//   current()  the tool's live brush size
//   apply(n)   set the tool's brush size to n
//   format(n)  how a size reads on a chip
export function renderBrushPresets(container, { key, current, apply, format }) {
  if (!container) return;
  container.replaceChildren();

  const label = document.createElement('span');
  label.className = 'brush-presets__label';
  label.textContent = 'Saved';
  container.appendChild(label);

  const now = current();
  for (const size of getSetting(key)) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'brush-presets__chip';
    chip.textContent = format(size);
    // Pressed when the tool is ALREADY on that size, so the row doubles as
    // a readout of where the brush is rather than only a set of buttons.
    chip.setAttribute('aria-pressed', String(size === now));
    chip.dataset.presetSize = String(size);
    chip.addEventListener('click', () => {
      apply(size);
      renderBrushPresets(container, { key, current, apply, format });
    });
    container.appendChild(chip);
  }

  // One glyph for both halves of the job: filled when the current size is
  // already saved (tap to forget it), hollow when it is not (tap to save).
  // A separate "remove" control would need a target selected first, which
  // for three chips is more machinery than the thing it manages.
  const saved = hasPreset(key, now);
  const star = document.createElement('button');
  star.type = 'button';
  star.className = 'brush-presets__save';
  star.dataset.presetSave = key;
  setIcon(star, saved ? 'star' : 'star-outline');
  star.setAttribute('aria-pressed', String(saved));
  star.setAttribute('aria-label', saved
    ? `Forget ${format(now)} as a saved size`
    : `Save ${format(now)} as a favourite size`);
  star.addEventListener('click', () => {
    togglePreset(key, now);
    renderBrushPresets(container, { key, current, apply, format });
  });
  container.appendChild(star);
}

// Keeps a row in step with the store, so "Clear all app data" or a reset in
// Settings is reflected without the tool being reopened. Returns the
// unsubscribe, which the tool calls when its window closes.
export function bindBrushPresets(container, options) {
  renderBrushPresets(container, options);
  return subscribeSettings((key) => {
    if (key === null || key === options.key) renderBrushPresets(container, options);
  });
}

export const SQUARE_FORMAT = (n) => `${n}×${n}`;

// The button that opens a tool's brush-size menu: the size, then a pixel
// chevron (the menu's own affordance), in one place for every tool.
export function renderBrushButton(button, size) {
  if (!button) return;
  const label = document.createElement('span');
  label.textContent = `${size} × ${size}`;
  const chevron = document.createElement('span');
  chevron.className = 'px-icon--trail';
  setIcon(chevron, 'chevron-down');
  button.replaceChildren(label, chevron);
}
export const PIXEL_FORMAT = (n) => `${n} px`;
