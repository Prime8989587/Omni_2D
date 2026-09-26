// Entry point: boots the UI once the DOM is ready. Keep this file thin --
// real logic lives in state.js (state machine), canvas.js (rendering
// engine facade), and ui.js (DOM wiring).

import { initUI } from './ui.js';
import { initPixelIcons } from './pixelIcons.js';
import { initPixelControls } from './pixelControls.js';
import { initWholePixelViewport } from './pixelScale.js';
import { initChangelogUI } from './changelogUI.js';

function boot() {
  // Before the UI: every [data-icon] in the markup gets its pixel drawing,
  // and every select and slider its pixel control, so the first frame the
  // user sees is already the pixel one. Both keep watching, so anything
  // the UI builds later is drawn the same way.
  initWholePixelViewport();
  initPixelIcons();
  initPixelControls();
  initUI();
  initChangelogUI();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
