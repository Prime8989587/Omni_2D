// Whole device pixels per CSS pixel, on every screen.
//
// Every pixel-art edge in this interface -- a 2px border, the stepped corner
// cut, an icon's pixel, a slider handle -- is laid out in whole CSS pixels.
// That is only a hard edge on the glass if a CSS pixel is a whole number of
// the screen's own pixels. At a device pixel ratio of 2 or 3 it is. But a
// great many Android phones run at 2.625, 2.75 or 3.5, where a 2px border
// is 5.25 screen pixels wide and every edge falls part-way across one:
// measured in the real browser, the app's plain stepped-corner panel comes
// out in 15 different colours at 2.625 -- its edges blended -- against
// exactly 3 at a ratio of 3.
//
// So at start-up the page's viewport is scaled by exactly target/ratio,
// with target the nearest whole ratio: at 2.625 the page is shown at
// 3/2.625 = 8/7, and one CSS pixel covers exactly 3 screen pixels. The same
// panel then renders in exactly 3 colours. The viewport scale is applied
// when the page is composited, after layout -- unlike CSS zoom, which was
// tried first and still left edges on fractional positions, because layout
// rounds to 1/64 of a pixel and 8/7 is not a multiple of that.
//
// The page is laid out a little narrower in CSS pixels to fill the same
// screen (411 -> 360 at 2.625), so everything is ~14% larger on such a
// phone -- the size it would be on a phone with a ratio of 3.
//
// A <canvas> sizes its backing store in screen pixels, so everything that
// used to read window.devicePixelRatio now reads effectiveDpr(): the
// ratio times the viewport's own scale. That is read LIVE from the visual
// viewport rather than assumed, so if a WebView ever declined the viewport
// tag the canvases would still size themselves to what is really on the
// screen.

function viewportMeta() {
  let meta = document.querySelector('meta[name="viewport"]');
  if (!meta) {
    meta = document.createElement('meta');
    meta.name = 'viewport';
    document.head.appendChild(meta);
  }
  return meta;
}

export function viewportScale() {
  return (typeof window !== 'undefined' && window.visualViewport && window.visualViewport.scale) || 1;
}

// Screen pixels per CSS pixel, as the screen actually shows them.
export function effectiveDpr() {
  if (typeof window === 'undefined') return 1;
  return (window.devicePixelRatio || 1) * viewportScale();
}

export function wholePixelTarget(ratio) {
  return Math.max(1, Math.round(ratio));
}

let applied = null;

export function applyWholePixelViewport() {
  const ratio = window.devicePixelRatio || 1;
  const target = wholePixelTarget(ratio);
  const scale = target / ratio;
  // The screen's width in device-independent pixels, whatever the viewport
  // is set to right now (layout width times the scale it is shown at).
  const dipWidth = window.innerWidth * viewportScale();
  const width = Math.round(dipWidth / scale);
  const key = `${width}@${scale}`;
  if (key === applied) return;
  applied = key;
  const common = 'user-scalable=no, viewport-fit=cover';
  viewportMeta().setAttribute('content', Math.abs(scale - 1) < 1e-4
    ? `width=device-width, initial-scale=1.0, ${common}`
    : `width=${width}, initial-scale=${scale}, minimum-scale=${scale}, maximum-scale=${scale}, ${common}`);
}

export function initWholePixelViewport() {
  applyWholePixelViewport();
  // A turn of the phone changes the width it has to fill.
  window.addEventListener('orientationchange', () => setTimeout(applyWholePixelViewport, 150));
}
