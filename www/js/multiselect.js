// Selecting several things at once, so one edit can land on all of them.
//
// This is SELECTION ONLY. It owns a set of ids and whether the mode is on;
// it never touches a bone, a layer, or anything either one contains. What a
// batch action then DOES with those ids lives in the stores, as ordinary
// per-item setter calls -- which is what keeps the promise that batching is
// just doing the same edit several times, not linking anything together.
//
// Two independent instances, one per list, because the bone list and the
// Scene Parts list are different screens doing different jobs: leaving
// selection mode on in Rig should not arm it in the layer list, and a
// selection of bones has no meaning as a selection of layers.
//
// The single-selection each store already has is untouched and still drives
// the editor panels. Multi-select sits alongside it: turning the mode off
// clears the set and leaves the ordinary selection exactly as it was.

class MultiSelect {
  constructor(name) {
    this.name = name;
    this._ids = new Set();
    this._active = false;
    this._listeners = new Set();
  }

  get active() {
    return this._active;
  }

  get size() {
    return this._ids.size;
  }

  get ids() {
    return [...this._ids];
  }

  has(id) {
    return this._ids.has(id);
  }

  subscribe(listener) {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  _emit() {
    this._listeners.forEach((listener) => listener());
  }

  // Leaving the mode always empties the set. A selection that survived
  // being switched off would be invisible -- no highlights, no count -- and
  // the next batch action would land on items the user could not see were
  // still chosen.
  setActive(value) {
    const next = Boolean(value);
    if (next === this._active) return;
    this._active = next;
    if (!next) this._ids.clear();
    this._emit();
  }

  toggle(id) {
    if (id === null || id === undefined) return;
    if (this._ids.has(id)) this._ids.delete(id);
    else this._ids.add(id);
    this._emit();
  }

  select(id) {
    if (id === null || id === undefined || this._ids.has(id)) return;
    this._ids.add(id);
    this._emit();
  }

  clear() {
    if (this._ids.size === 0) return;
    this._ids.clear();
    this._emit();
  }

  replace(ids) {
    this._ids = new Set(ids);
    this._emit();
  }

  // Drops ids that no longer exist. Deleting a bone or a layer while it was
  // selected would otherwise leave a stale id in the set, and the count
  // would claim more items than a batch action could possibly reach.
  prune(existingIds) {
    const live = new Set(existingIds);
    let changed = false;
    for (const id of [...this._ids]) {
      if (!live.has(id)) {
        this._ids.delete(id);
        changed = true;
      }
    }
    if (changed) this._emit();
    return changed;
  }
}

export const boneSelection = new MultiSelect('bones');
export const partSelection = new MultiSelect('parts');

// Case-insensitive substring match, the rule both list filters use. Empty
// or whitespace-only query matches everything, so clearing the field is the
// same thing as never having typed in it.
export function matchesFilter(name, query) {
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) return true;
  return String(name || '').toLowerCase().includes(needle);
}
