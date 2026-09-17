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

// Pierce: which side of a piercing relationship a layer plays, if any.
//
// This is ALWAYS an explicit choice the user made and stored. Nothing in
// the app is allowed to infer it -- not from painted region data, not from
// which layers happen to overlap, not from anything else. Free Move asks
// this flag which layers it may drag independently; the deformation asks
// it whose flesh may be displaced. Both read the flag and nothing else,
// so a layer the user never assigned can never be quietly conscripted
// into a pierce by drawing in the wrong place.
export const PierceRole = Object.freeze({
  NONE: 'none',
  PIERCER: 'piercer',
  PIERCED: 'pierced',
});

export const PIERCE_ROLES = new Set(Object.values(PierceRole));

// WHOSE MOVEMENT DRIVES THE CONTACT
//
// The geometry is symmetric and always was: the gap is measured between
// two painted regions, so the flesh sliding onto a still needle reads
// exactly the same as the needle driven into still flesh -- measured,
// byte for byte, depth 1/11/15 and a push of 0.29/9.58/13.06 px either
// way round. What was missing was not the reverse direction but any say
// in it. This is that say.
//
// PIERCER -- only the piercer closing the gap deepens the contact. Moving
//            the pierced layer onto a parked piercer does nothing further.
// PIERCED -- the reverse: only the pierced layer's own movement deepens it.
// BOTH    -- either does, which is the symmetric behaviour described above.
//
// "Deepens" is the precise word. Whichever side is excluded still takes
// part in the contact it is already in -- the depth it has, the z-order,
// the springs settling -- it simply stops being able to push it further.
export const PiercePhysics = Object.freeze({
  PIERCER: 'piercer',
  PIERCED: 'pierced',
  BOTH: 'both',
});

export const PIERCE_PHYSICS = new Set(Object.values(PiercePhysics));

// Enter and End are depths in SCENE PIXELS, measured from the piercer's
// painted tip to the nearest painted pierceable pixel:
//
//   Enter -- the gap at which contact starts. Closer than this and the
//            flesh begins to move; further and it is entirely at rest.
//   End   -- how far PAST that first contact the displacement keeps
//            growing. At Enter-minus-End the push is at maximum and stops
//            growing: the hard limit.
export const PIERCE_DEPTH_RANGE = Object.freeze({ min: 1, max: 128 });
export const DEFAULT_PIERCE_ENTER = 12;
export const DEFAULT_PIERCE_END = 24;

// THE DENT'S OWN STARTING LINE
//
// A third distance on the same scale as Enter and End, and independent of
// both: the gap at which the notch BEGINS TO APPEAR. Enter says when the
// pair is in contact -- z-order swaps, force transfers, the depth starts
// counting -- and this says when the artwork starts visibly giving way.
// They are two different questions and were previously answered by one
// number, so a piercer could not touch something without immediately
// denting it.
//
// Set it closer than Enter and the tip makes contact, sinks under the
// surface and only then starts the notch. Set it equal to Enter and the
// dent begins on contact, which is what every project did before this
// existed -- hence the default.
export const DEFAULT_PIERCE_DENT_START = DEFAULT_PIERCE_ENTER;

// The dent's two numbers, in the pierced layer's own texels. Zero is a
// legitimate setting -- no dent -- so the floor is zero rather than one,
// and the ceiling is generous enough for a wedge across a large sprite
// without being large enough to be a typo nobody notices.
export const MAX_DENT_SIZE = 128;
export const DEFAULT_DENT_DEPTH = 6;
export const DEFAULT_DENT_WIDTH = 10;

export function clampDentSize(value) {
  const number = Math.round(Number(value));
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(MAX_DENT_SIZE, number));
}

// The dent's base, kept on the artwork. Sub-texel positions are allowed --
// a handle dragged with a fingertip has no reason to snap -- but a base off
// the sprite entirely would put the whole wedge where nothing can be cut.
export function clampDentCoord(value, extent) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(extent, number));
}

export function normalizeAngle(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return Math.PI / 2;
  const turn = Math.PI * 2;
  return ((number % turn) + turn) % turn;
}

export function clampPierceDepth(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return PIERCE_DEPTH_RANGE.min;
  return Math.min(PIERCE_DEPTH_RANGE.max, Math.max(PIERCE_DEPTH_RANGE.min, n));
}

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

    // Px Pin: source texels exempted from deformation. Each entry is a
    // texel index (v * naturalWidth + u) in THIS layer's own pixel grid --
    // local to the artwork, so a pin stays glued to its pixel no matter
    // where the layer goes. A pinned pixel is still carried by legitimate
    // whole-layer movement; it is only excused from skinning, bone
    // rotation and spring physics (see mesh.js, pinCarriageOffset).
    this.pins = new Set();
    // Bumped on every pin change so mesh.js can cache the per-vertex
    // influence field instead of rebuilding it every frame.
    this.pinsVersion = 0;

    // Pierce. The role is the explicit flag everything else reads; the
    // region is texel indices in THIS layer's own pixel grid, exactly like
    // pins -- the piercing TIP on a piercer, the PIERCEABLE area on an
    // pierced layer. Enter/End are the piercer's depths and are
    // meaningless on any other role.
    this.pierceRole = PierceRole.NONE;
    this.pierceRegion = new Set();
    this.pierceRegionVersion = 0;
    this.pierceEnter = DEFAULT_PIERCE_ENTER;
    this.pierceEnd = DEFAULT_PIERCE_END;
    // The gap at which this piercer starts CUTTING a dent, as opposed to
    // the gap at which it makes contact. See DEFAULT_PIERCE_DENT_START.
    this.pierceDentStart = DEFAULT_PIERCE_DENT_START;

    // WHICH PIXELS BUNCH AROUND A DENT
    //
    // A wedge pushed into something has to put the material it displaces
    // somewhere, and it piles up at the rim. These are the pixels allowed
    // to do that: painted anywhere on this layer, they are shoved outward
    // along the dent's own faces, by an amount that falls off with distance
    // from it and grows with depth.
    //
    // EMPTY MEANS NONE. This is opt-in -- gathering is an effect asked for
    // on the pixels it should happen to, not one every pierceable pixel
    // gets until told otherwise. It is also NOT intersected with the
    // pierceable area: the material that rises around a dent is usually the
    // material just outside where the pierce itself registers.
    this.pierceDeformRegion = new Set();
    this.pierceDeformRegionVersion = 0;

    // WALLS THE TIP CANNOT CROSS
    //
    // Enter and End constrain how far IN a piercer goes, along one axis.
    // They say nothing about sideways, so a tip driven at an angle could
    // slide out through the edge of the pierceable shape and poke into
    // open space beyond it. These pixels are solid: once a tip is in
    // contact, its contained position is pushed back out of any of them
    // it would otherwise cross, in any direction -- which is what keeps
    // it inside the cavity the artwork draws.
    //
    // Empty means no walls, which is the behaviour every project had
    // before this existed.
    this.pierceBarrierRegion = new Set();
    this.pierceBarrierRegionVersion = 0;

    // THE DENT THIS REGION TAKES AT FULL DEPTH
    //
    // Two numbers rather than a second painted silhouette. How far the
    // wedge's point pushes in, and how wide its base is across the surface
    // -- both in this layer's own texels, both scaled by the live depth
    // fraction, so the dent grows from nothing and shrinks back the same
    // way. See dent.js for what is built from them and why drawing a whole
    // second outline turned out not to work on real artwork.
    //
    // Zero on either means no dent, which is a finished, valid setup for a
    // layer that registers contact without giving way.
    this.pierceDentDepth = DEFAULT_DENT_DEPTH;
    this.pierceDentWidth = DEFAULT_DENT_WIDTH;

    // WHERE THE DENT IS, IN THIS LAYER'S OWN TEXELS
    //
    // The base's centre and the direction the apex is driven in. Placed by
    // the artist, by dragging the wedge onto the spot it should happen at,
    // and FIXED once placed: the piercer's approach decides how much of the
    // dent there is, never where it is.
    //
    // Texel space, like every other mask on a Part, so the dent stays glued
    // to the artwork through any amount of dragging, rigging or rotation
    // without a single coordinate conversion.
    //
    // Unplaced, these are ignored and dent.js derives a starting position
    // from the pierceable paint instead -- so the handles always have
    // somewhere sensible to appear, and nothing is stored until a drag
    // stores it.
    this.pierceDentPlaced = false;
    this.pierceDentX = 0;
    this.pierceDentY = 0;
    this.pierceDentAngle = Math.PI / 2;

    // Which side's movement may deepen this piercer's contacts. Lives on
    // the piercer with Enter and End, because like them it describes the
    // relationship rather than the artwork.
    this.piercePhysics = PiercePhysics.PIERCER;
  }

  get isPiercer() {
    return this.pierceRole === PierceRole.PIERCER;
  }

  get isPierced() {
    return this.pierceRole === PierceRole.PIERCED;
  }

  get hasPierceRole() {
    return this.pierceRole !== PierceRole.NONE;
  }

  texelIndex(u, v) {
    if (u < 0 || v < 0 || u >= this.naturalWidth || v >= this.naturalHeight) return -1;
    return v * this.naturalWidth + u;
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
  // `skipPiercers` is what makes the Free Move "Body" handle and the
  // "Piercer" handle independent of each other: the body carries every
  // unbound layer EXCEPT the ones the user flagged as piercers, and the
  // piercer handle carries exactly those. Without the split, an unbound
  // needle would be dragged twice over -- once as part of the body, once
  // as itself -- and could never be moved toward the character at all.
  translateUnbound(dx, dy, { skipPiercers = false } = {}) {
    if (dx === 0 && dy === 0) return;
    let moved = false;
    for (const part of this._parts) {
      if (part.mesh && part.mesh.isBound) continue;
      if (skipPiercers && part.isPiercer) continue;
      part.x += dx;
      part.y += dy;
      moved = true;
    }
    if (moved) this._emit('transform');
  }

  // The piercer side of that split. Bound piercers are left to their bones
  // (the caller translates those separately) -- moving both would double
  // the distance travelled.
  translatePiercers(dx, dy) {
    if (dx === 0 && dy === 0) return;
    let moved = false;
    for (const part of this._parts) {
      if (!part.isPiercer) continue;
      if (part.mesh && part.mesh.isBound) continue;
      part.x += dx;
      part.y += dy;
      moved = true;
    }
    if (moved) this._emit('transform');
  }

  // ---- Pierce -----------------------------------------------------------

  get piercers() {
    return this._parts.filter((part) => part.isPiercer);
  }

  get piercedLayers() {
    return this._parts.filter((part) => part.isPierced);
  }

  get hasPierce() {
    return this._parts.some((part) => part.hasPierceRole);
  }

  // Setting a role never touches artwork, position, bones or pins -- only
  // pierce data. Leaving a role (to NONE) clears the pierce data with it,
  // so a layer that is "not in a pierce" carries no stale half of one.
  setPierceRole(id, role) {
    const part = this._parts.find((candidate) => candidate.id === id);
    if (!part || !PIERCE_ROLES.has(role) || part.pierceRole === role) return false;
    part.pierceRole = role;
    if (role === PierceRole.NONE) {
      part.pierceRegion = new Set();
      part.pierceRegionVersion++;
      part.pierceDeformRegion = new Set();
      part.pierceDeformRegionVersion++;
      part.pierceBarrierRegion = new Set();
      part.pierceBarrierRegionVersion++;
      part.pierceDentDepth = DEFAULT_DENT_DEPTH;
      part.pierceDentWidth = DEFAULT_DENT_WIDTH;
      part.pierceDentPlaced = false;
      part.pierceDentX = 0;
      part.pierceDentY = 0;
      part.pierceDentAngle = Math.PI / 2;
      part.piercePhysics = PiercePhysics.PIERCER;
      part.pierceEnter = DEFAULT_PIERCE_ENTER;
      part.pierceEnd = DEFAULT_PIERCE_END;
      part.pierceDentStart = DEFAULT_PIERCE_DENT_START;
    }
    this._emit('structure');
    return true;
  }

  setPiercePhysics(id, physics) {
    const part = this._parts.find((candidate) => candidate.id === id);
    if (!part || !PIERCE_PHYSICS.has(physics) || part.piercePhysics === physics) return false;
    part.piercePhysics = physics;
    this._emit('transform');
    return true;
  }

  // The dent's trigger distance is optional here so that callers with only
  // the two older numbers to offer leave it alone rather than silently
  // resetting it to a default the user did not ask for.
  setPierceDepths(id, enter, end, dentStart) {
    const part = this._parts.find((candidate) => candidate.id === id);
    if (!part) return false;
    part.pierceEnter = clampPierceDepth(enter);
    part.pierceEnd = clampPierceDepth(end);
    if (dentStart !== undefined) part.pierceDentStart = clampPierceDepth(dentStart);
    this._emit('transform');
    return true;
  }

  setPierceDent(id, depth, width) {
    const part = this._parts.find((candidate) => candidate.id === id);
    if (!part) return false;
    const nextDepth = clampDentSize(depth);
    const nextWidth = clampDentSize(width);
    if (part.pierceDentDepth === nextDepth && part.pierceDentWidth === nextWidth) return false;
    part.pierceDentDepth = nextDepth;
    part.pierceDentWidth = nextWidth;
    this._emit('transform');
    return true;
  }

  // Where the wedge sits on this layer's artwork. Writing any placement
  // marks it placed, so the derived starting position stops applying and
  // the dent stays exactly where it was put.
  setPierceDentPlacement(id, x, y, angle) {
    const part = this._parts.find((candidate) => candidate.id === id);
    if (!part) return false;
    const nextX = clampDentCoord(x, part.naturalWidth);
    const nextY = clampDentCoord(y, part.naturalHeight);
    const nextAngle = normalizeAngle(angle);
    if (part.pierceDentPlaced && part.pierceDentX === nextX &&
        part.pierceDentY === nextY && part.pierceDentAngle === nextAngle) return false;
    part.pierceDentPlaced = true;
    part.pierceDentX = nextX;
    part.pierceDentY = nextY;
    part.pierceDentAngle = nextAngle;
    this._emit('transform');
    return true;
  }

  setPierceBarrierRegion(id, indices, marked) {
    const part = this._parts.find((candidate) => candidate.id === id);
    if (!part) return 0;
    let changed = 0;
    for (const index of indices) {
      if (index < 0 || index >= part.naturalWidth * part.naturalHeight) continue;
      if (marked ? !part.pierceBarrierRegion.has(index) : part.pierceBarrierRegion.has(index)) {
        if (marked) part.pierceBarrierRegion.add(index); else part.pierceBarrierRegion.delete(index);
        changed++;
      }
    }
    if (changed) {
      part.pierceBarrierRegionVersion++;
      this._emit('transform');
    }
    return changed;
  }

  // The deformable sub-mask, painted exactly like the others. Kept beside
  // setPierceRegion rather than folded into it because the two answer
  // different questions and are painted in separate passes.
  setPierceDeformRegion(id, indices, marked) {
    const part = this._parts.find((candidate) => candidate.id === id);
    if (!part) return 0;
    let changed = 0;
    for (const index of indices) {
      if (index < 0 || index >= part.naturalWidth * part.naturalHeight) continue;
      if (marked ? !part.pierceDeformRegion.has(index) : part.pierceDeformRegion.has(index)) {
        if (marked) part.pierceDeformRegion.add(index); else part.pierceDeformRegion.delete(index);
        changed++;
      }
    }
    if (changed) {
      part.pierceDeformRegionVersion++;
      this._emit('transform');
    }
    return changed;
  }

  // Same shape as setPins: a batch of texel indices flipped on or off in
  // the layer's own grid, with one version bump so the solver can cache
  // its per-vertex field instead of rebuilding it every frame.
  setPierceRegion(id, indices, marked) {
    const part = this._parts.find((candidate) => candidate.id === id);
    if (!part) return 0;
    let changed = 0;
    for (const index of indices) {
      if (index < 0 || index >= part.naturalWidth * part.naturalHeight) continue;
      if (marked ? !part.pierceRegion.has(index) : part.pierceRegion.has(index)) {
        if (marked) part.pierceRegion.add(index); else part.pierceRegion.delete(index);
        changed++;
      }
    }
    if (changed) {
      part.pierceRegionVersion++;
      this._emit('transform');
    }
    return changed;
  }

  // Layers import named after their source file ("9703"), which is never
  // what anyone wants to see in the Scene Parts list for long. Blank input
  // is ignored rather than accepted -- an empty name would make the layer
  // impossible to pick back out of the list -- and unlike duplicate()'s
  // generated names, a hand-typed one is not forced unique: the user asked
  // for it.
  rename(id, name) {
    const part = this._parts.find((candidate) => candidate.id === id);
    if (!part) return;
    const trimmed = String(name).trim();
    if (!trimmed || trimmed === part.name) return;
    part.name = trimmed;
    this._emit('structure');
  }

  setVisible(id, visible) {
    const part = this._parts.find((candidate) => candidate.id === id);
    if (!part || part.visible === visible) return;
    part.visible = visible;
    this._emit('structure');
  }

  // Pins or un-pins a batch of texel indices on one layer. Returns how
  // many actually changed, so a tap on already-pinned pixels (or an erase
  // on clean ones) can skip recording an empty undo step.
  setPins(id, indices, pinned) {
    const part = this._parts.find((candidate) => candidate.id === id);
    if (!part) return 0;
    let changed = 0;
    for (const index of indices) {
      if (index < 0 || index >= part.naturalWidth * part.naturalHeight) continue;
      if (pinned ? !part.pins.has(index) : part.pins.has(index)) {
        if (pinned) part.pins.add(index); else part.pins.delete(index);
        changed++;
      }
    }
    if (changed) {
      part.pinsVersion++;
      this._emit('transform');
    }
    return changed;
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
  //
  // `mapPoint` exists for the same reason: a part can be DRAWN somewhere
  // other than its own coordinates say (a piercer held at its End Point
  // is), and a finger has to be able to grab the artwork it can see. The
  // caller supplies the mapping because this module has no business
  // knowing what a pierce is.
  hitTest(x, y, mapPoint = null) {
    return this.partsTopFirst.find((part) => {
      if (!part.visible) return false;
      const point = mapPoint ? mapPoint(part, x, y) : { x, y };
      return part.containsPoint(point.x, point.y);
    }) || null;
  }
}

// Session-scoped singleton: the assembled character survives switching
// between modes because nothing clears this on state change. Saving to
// disk is a later concern.
export const partsStore = new PartsStore();
