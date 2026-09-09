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

class SceneStore {
  constructor() {
    this._width = 512;
    this._height = 512;
    this._listeners = new Set();
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
