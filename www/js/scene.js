// The scene: an explicit pixel grid of integer width x height.
//
// Everything in the app -- parts, bones, mesh vertices -- lives in scene
// pixel units. One scene pixel is one cell of the checkerboard, and the
// rendered artwork is composed only of whole scene pixels. The camera in
// view.js decides how big those pixels appear on the phone screen.

export const MIN_SCENE_SIZE = 8;
export const MAX_SCENE_SIZE = 3072;

export const SCENE_PRESETS = Object.freeze([
  { label: '256 × 256', width: 256, height: 256 },
  { label: '512 × 512', width: 512, height: 512 },
  { label: '1024 × 1024', width: 1024, height: 1024 },
  { label: '1024 × 3072', width: 1024, height: 3072 },
  { label: '3072 × 3072', width: 3072, height: 3072 },
]);

function clampSize(value) {
  const rounded = Math.round(Number(value));
  if (!Number.isFinite(rounded)) return MIN_SCENE_SIZE;
  return Math.min(MAX_SCENE_SIZE, Math.max(MIN_SCENE_SIZE, rounded));
}

// THE BACKDROP: what shows where no layer has a pixel.
//
// By default, nothing does -- the scene is transparent there, the editor
// shows the checkerboard, and an exported GIF is transparent there too. A
// layer whose artwork stops short of the frame (hips drawn as a silhouette,
// say) therefore has checkerboard round it, which is honest but rarely the
// picture the artist means. A backdrop colour fills those pixels instead:
// on the canvas, and in every frame recorded for export, so what is seen is
// what is exported. null is the checkerboard.
const BACKDROP_HEX = /^#[0-9a-f]{6}$/i;

export function normalizeBackdrop(value) {
  return typeof value === 'string' && BACKDROP_HEX.test(value) ? value.toUpperCase() : null;
}

// A recorded frame over the scene's backdrop colour, when it has one: the
// pixels no layer covers take the colour and a half see-through one is
// blended onto it, exactly as the canvas shows them -- so the export is the
// picture that was on screen. Without a backdrop the frame is left alone,
// transparent where the scene is.
export function withBackdrop(frame, backdrop) {
  const rgb = backdrop ? /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(backdrop) : null;
  if (!rgb) return frame;
  const bg = [parseInt(rgb[1], 16), parseInt(rgb[2], 16), parseInt(rgb[3], 16)];
  for (let i = 0; i < frame.length; i += 4) {
    const a = frame[i + 3];
    if (a === 255) continue;
    const k = a / 255;
    frame[i] = Math.round(frame[i] * k + bg[0] * (1 - k));
    frame[i + 1] = Math.round(frame[i + 1] * k + bg[1] * (1 - k));
    frame[i + 2] = Math.round(frame[i + 2] * k + bg[2] * (1 - k));
    frame[i + 3] = 255;
  }
  return frame;
}

class SceneStore {
  constructor() {
    this._width = 512;
    this._height = 512;
    this._backdrop = null;
    this._listeners = new Set();
    // Separate from the size's listeners: those re-fit the camera, and
    // changing a colour must not move the view.
    this._backdropListeners = new Set();
  }

  get backdrop() {
    return this._backdrop;
  }

  setBackdrop(value) {
    const next = normalizeBackdrop(value);
    if (next === this._backdrop) return;
    this._backdrop = next;
    this._backdropListeners.forEach((listener) => listener());
  }

  subscribeBackdrop(listener) {
    this._backdropListeners.add(listener);
    return () => this._backdropListeners.delete(listener);
  }

  get width() {
    return this._width;
  }

  get height() {
    return this._height;
  }

  subscribe(listener) {
    this._listeners.add(listener);
    listener();
    return () => this._listeners.delete(listener);
  }

  // Resizing never moves or deletes anything: parts and bones keep their
  // scene coordinates and simply fall outside the visible grid if the new
  // canvas is smaller. Growing it again brings them back.
  setSize(width, height) {
    const nextWidth = clampSize(width);
    const nextHeight = clampSize(height);
    if (nextWidth === this._width && nextHeight === this._height) return;
    this._width = nextWidth;
    this._height = nextHeight;
    this._listeners.forEach((listener) => listener());
  }

  contains(x, y) {
    return x >= 0 && y >= 0 && x < this._width && y < this._height;
  }
}

export const sceneStore = new SceneStore();
