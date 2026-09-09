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

// Loading a project restores parts by their saved ids, so the generator
// must never hand out an id that already exists in the scene.
export function reservePartId(id) {
  const match = /^part_(\d+)$/.exec(String(id));
  if (match) nextId = Math.max(nextId, Number(match[1]) + 1);
}

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

    // Layer flags. Hidden layers keep all their data but are not drawn
    // and cannot be picked on the canvas; locked layers can be selected
    // and inspected but not moved, scaled or rotated.
    this.visible = true;
    this.locked = false;

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

  // Rewrites every zIndex as 0..n-1 in the current stacking order. Front
  // and back use an ever-growing counter, which is fine for "put this on
  // top" but useless for "swap these two neighbours" -- so any positional
  // move normalizes first and then works with adjacent integers.
  _normalizeZ() {
    const ordered = this.partsBottomFirst;
    ordered.forEach((part, index) => { part.zIndex = index; });
    this._bottomZ = 0;
    this._topZ = Math.max(0, ordered.length - 1);
    return ordered;
  }

  // Moves a part one step through the stack: +1 towards the front, -1
  // towards the back. Returns true when something actually moved, so the
  // caller can skip recording an empty undo step at either end.
  moveBy(id, delta) {
    const ordered = this._normalizeZ();
    const index = ordered.findIndex((part) => part.id === id);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= ordered.length) return false;

    const part = ordered[index];
    const other = ordered[target];
    const swap = part.zIndex;
    part.zIndex = other.zIndex;
    other.zIndex = swap;
    this._emit('structure');
    return true;
  }

  remove(id) {
    const part = this._parts.find((candidate) => candidate.id === id);
    if (!part) return null;

    this._parts = this._parts.filter((candidate) => candidate.id !== id);
    if (this._selectedId === id) this._selectedId = null;
    this._emit('structure');
    return part;
  }

  // An independent copy of the artwork: new id, same pixels (which are
  // never mutated, so the buffer is shared rather than cloned), same
  // transform, dropped on top of the stack. The mesh is deliberately NOT
  // copied -- duplicating a layer duplicates the artwork, not its rig.
  duplicate(id) {
    const source = this._parts.find((candidate) => candidate.id === id);
    if (!source) return null;

    const copy = new Part({
      name: this._uniqueName(`${source.name}_copy`),
      image: source.image,
      pixels: source.pixels,
      width: source.naturalWidth,
      height: source.naturalHeight,
      objectUrl: null, // the original owns the URL's lifetime
      x: source.x,
      y: source.y,
      scale: source.scale,
      rotation: source.rotation,
      placement: source.placement,
    });
    copy.visible = source.visible;
    copy.locked = source.locked;
    return this.add(copy);
  }

  _uniqueName(base) {
    const taken = new Set(this._parts.map((part) => part.name));
    if (!taken.has(base)) return base;
    let n = 2;
    while (taken.has(`${base}_${n}`)) n++;
    return `${base}_${n}`;
  }

  // Shifts every layer that is NOT bound to the skeleton. A bound layer
  // already follows its bones through skinning; an unbound one is drawn
  // at its own coordinates and would otherwise sit pinned in place while
  // the rest of the character moved away from it. Not every piece is
  // meant to bend or bounce -- plenty are meant to be carried along
  // exactly as drawn -- and this is what carries them.
  translateUnbound(dx, dy) {
    if (dx === 0 && dy === 0) return;
    let moved = false;
    for (const part of this._parts) {
      if (part.mesh && part.mesh.isBound) continue;
      part.x += dx;
      part.y += dy;
      moved = true;
    }
    if (moved) this._emit('transform');
  }

  setVisible(id, visible) {
    const part = this._parts.find((candidate) => candidate.id === id);
    if (!part || part.visible === visible) return;
    part.visible = visible;
    this._emit('structure');
  }

  setLocked(id, locked) {
    const part = this._parts.find((candidate) => candidate.id === id);
    if (!part || part.locked === locked) return;
    part.locked = locked;
    this._emit('structure');
  }

  // Replaces the whole scene at once -- used by project load and by undo,
  // which both rebuild parts from a serialized snapshot.
  replaceAll(parts, selectedId = null) {
    this._parts = parts;
    this._selectedId = parts.some((part) => part.id === selectedId) ? selectedId : null;
    this._normalizeZ();
    this._emit('structure');
  }

  // Topmost VISIBLE part whose bounds contain the scene-space point, or
  // null. Hidden layers are not pickable: they are not on screen, so a
  // touch that appears to land on empty grid must behave that way.
  hitTest(x, y) {
    return this.partsTopFirst.find((part) => part.visible && part.containsPoint(x, y)) || null;
  }
}

// Session-scoped singleton: the assembled character survives switching
// between modes because nothing clears this on state change. Saving to
// disk is a later concern.
export const partsStore = new PartsStore();
