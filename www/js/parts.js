// Scene model: the imported Parts and which one is selected.
//
// Pure data and geometry -- no DOM, no rendering, no gesture handling.
// A Part is the unit that gets bones bound to it, so per-part state lives
// on the Part object itself rather than in parallel lookup tables.
//
// GRID ALIGNMENT IS A DATA INVARIANT
//
// A part sits on the pixel grid by its TOP-LEFT corner, stored as integer
// scene pixels, and an INTEGER scale (scene pixels per source pixel). With
// both whole numbers, source pixel (u, v) lands exactly on scene pixel
// (x + u*scale, y + v*scale) -- no sub-pixel offset can exist, and no
// scaling can ever call for interpolation between source pixels.
//
// Rotation stays continuous. A rotated sprite cannot align to the grid by
// construction, so its output is snapped by the rasterizer instead, the
// same way a deformed mesh is.

let nextId = 1;

export const MIN_PART_SCALE = 1;
export const MAX_PART_SCALE = 16;

export function clampScale(value) {
  return Math.min(MAX_PART_SCALE, Math.max(MIN_PART_SCALE, Math.round(value)));
}

export class Part {
  constructor({ name, image = null, pixels, width, height, objectUrl = null, x, y, scale = 1, rotation = 0, placement = 'manual' }) {
    this.id = `part_${nextId++}`;
    this.name = name;
    // The decoded pixels are the source of truth for the artwork; `image`
    // is only kept when it is still the same size as those pixels. An
    // import that trims transparent padding away passes explicit
    // dimensions instead and drops the full-size image entirely.
    this.image = image;
    this.pixels = pixels; // RGBA bytes, naturalWidth x naturalHeight, read once at import
    this.sourceWidth = Math.max(1, Math.round(width ?? image.naturalWidth));
    this.sourceHeight = Math.max(1, Math.round(height ?? image.naturalHeight));
    this.objectUrl = objectUrl; // kept alive for the session while `image` is
    this.x = Math.round(x); // top-left corner, in scene pixels
    this.y = Math.round(y);
    this.scale = clampScale(scale); // scene pixels per source pixel, whole numbers only
    this.rotation = rotation; // radians, about the part's centre
    this.zIndex = 0; // assigned by the store on add
    // How the importer positioned this part: 'auto' when its own
    // transparent padding placed it, 'manual' for the default centring.
    // Only manual placements take a cascade slot, so an exactly placed
    // layer never nudges the next hand-placed one off-centre.
    this.placement = placement;

    // The deformable mesh bound to the skeleton, or null while unbound.
    // Built and owned by mesh.js; the store, renderer, and gesture layers
    // only ever read it.
    this.mesh = null;
  }

  get naturalWidth() {
    return this.sourceWidth;
  }

  get naturalHeight() {
    return this.sourceHeight;
  }

  // Footprint on the grid, before rotation.
  get sceneWidth() {
    return this.naturalWidth * this.scale;
  }

  get sceneHeight() {
    return this.naturalHeight * this.scale;
  }

  // Rotation pivot and the origin of the part's local space.
  get centerX() {
    return this.x + this.sceneWidth / 2;
  }

  get centerY() {
    return this.y + this.sceneHeight / 2;
  }

  // Converts a scene-space point into this part's local image space,
  // where the image's centre sits at the origin and one unit is one
  // source pixel. Inverts translate -> rotate -> scale.
  toLocal(px, py) {
    const dx = px - this.centerX;
    const dy = py - this.centerY;
    const cos = Math.cos(-this.rotation);
    const sin = Math.sin(-this.rotation);
    return {
      x: (dx * cos - dy * sin) / this.scale,
      y: (dx * sin + dy * cos) / this.scale,
    };
  }

  containsPoint(px, py) {
    const local = this.toLocal(px, py);
    return (
      Math.abs(local.x) <= this.naturalWidth / 2 &&
      Math.abs(local.y) <= this.naturalHeight / 2
    );
  }
}

// Change types emitted to subscribers:
//   'structure' - a part was added, or z-order changed
//   'selection' - the selected part changed
//   'transform' - a part moved/scaled/rotated (fires per gesture frame)
// The renderer redraws on all three; the UI rebuilds its list only for
// the first two, so dragging doesn't thrash the DOM.
class PartsStore {
  constructor() {
    this._parts = [];
    this._selectedId = null;
    this._listeners = new Set();
    this._topZ = 0;
    this._bottomZ = 0;
  }

  get parts() {
    return this._parts;
  }

  get isEmpty() {
    return this._parts.length === 0;
  }

  get selectedId() {
    return this._selectedId;
  }

  get selected() {
    return this._parts.find((part) => part.id === this._selectedId) || null;
  }

  // Back-to-front: the order the renderer draws in.
  get partsBottomFirst() {
    return [...this._parts].sort((a, b) => a.zIndex - b.zIndex);
  }

  // Front-to-back: the order a layers list and hit testing want.
  get partsTopFirst() {
    return [...this._parts].sort((a, b) => b.zIndex - a.zIndex);
  }

  subscribe(listener) {
    this._listeners.add(listener);
    listener('structure');
    return () => this._listeners.delete(listener);
  }

  _emit(type) {
    this._listeners.forEach((listener) => listener(type));
  }

  // Called by the gesture layer after mutating a part's transform.
  notifyTransformed() {
    this._emit('transform');
  }

  add(part) {
    part.zIndex = ++this._topZ;
    this._parts.push(part);
    this._emit('structure');
    return part;
  }

  select(id) {
    if (this._selectedId === id) return;
    this._selectedId = id;
    this._emit('selection');
  }

  bringToFront(id) {
    const part = this._parts.find((candidate) => candidate.id === id);
    if (!part) return;
    part.zIndex = ++this._topZ;
    this._emit('structure');
  }

  sendToBack(id) {
    const part = this._parts.find((candidate) => candidate.id === id);
    if (!part) return;
    part.zIndex = --this._bottomZ;
    this._emit('structure');
  }

  // Topmost part whose bounds contain the scene-space point, or null.
  hitTest(x, y) {
    return this.partsTopFirst.find((part) => part.containsPoint(x, y)) || null;
  }
}

// Session-scoped singleton: the assembled character survives switching
// between modes because nothing clears this on state change. Saving to
// disk is a later concern.
export const partsStore = new PartsStore();
