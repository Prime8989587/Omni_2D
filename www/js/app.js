// Entry point: boots the UI once the DOM is ready. Keep this file thin --
// real logic lives in state.js (state machine), canvas.js (rendering
// engine facade), and ui.js (DOM wiring).

import { initUI } from './ui.js';

function boot() {
  initUI();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
