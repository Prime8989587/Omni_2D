// Scene model: the imported Parts and which one is selected.
//
// Pure data and geometry -- no DOM, no rendering, no gesture handling.
// A Part is the unit that later gets bones bound to it, so per-part state
// lives on the Part object itself rather than in parallel lookup tables.

let nextId = 1;

export class Part {
  constructor({ name, image, objectUrl, x, y, scale = 1, rotation = 0 }) {
    this.id = `part_${nextId++}`;
    this.name = name;
    this.image = image;
    this.objectUrl = objectUrl; // kept alive for the session; the image re-reads it
    this.x = x; // canvas-space position of the part's center, in CSS px
    this.y = y;
    this.scale = scale; // uniform; 1 = one image pixel per CSS px
    this.rotation = rotation; // radians
    this.zIndex = 0; // assigned by the store on add

    // The deformable mesh bound to the skeleton, or null while unbound.
    // Built and owned by mesh.js; the store, renderer, and gesture layers
    // only ever read it.
    this.mesh = null;
  }

  get naturalWidth() {
    return this.image.naturalWidth;
  }

  get naturalHeight() {
    return this.image.naturalHeight;
  }

  // Converts a canvas-space point into this part's local image space,
  // where the image's center sits at the origin and one unit is one
  // source pixel. Inverts translate -> rotate -> scale.
  toLocal(px, py) {
    const dx = px - this.x;
    const dy = py - this.y;
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

  // Topmost part whose bounds contain the point, or null.
  hitTest(x, y) {
    return this.partsTopFirst.find((part) => part.containsPoint(x, y)) || null;
  }
}

// Session-scoped singleton: the assembled character survives switching
// between Home and Animate mode because nothing clears this on state
// change. Saving to disk is a later concern.
export const partsStore = new PartsStore();
