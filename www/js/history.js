// Undo / redo.
//
// A standard command-history stack. Each entry is a reversible record:
//
//   { label, before, after }
//
// where `before` and `after` are complete serialized scene states (see
// project.js). Undo applies `before`, redo applies `after`. This is the
// memento flavour of the command pattern, and it is the right one here:
// the actions that need undoing include auto-weighting a mesh, deleting a
// bone (which re-parents its children and rewrites their local frames),
// and painting weights across dozens of vertices. Hand-written inverse
// operations for each of those would be a large amount of error-prone
// code whose bugs corrupt the user's project silently.
//
// The cost that usually rules snapshots out -- copying the artwork every
// time -- does not apply: pixel buffers are immutable after import, so
// every snapshot shares them (project.js, copyPixels: false). What each
// entry actually holds is a few KB of numbers.
//
// Usage is a transaction:
//
//   history.run('Delete layer', () => { ...mutate the stores... });
//
// which captures the state before, runs the mutation, captures after, and
// pushes one entry. Nested calls collapse into the outer one, so an action
// built from smaller helpers still lands on the stack as a single step.

import { serializeProject, applyProject } from './project.js';

const HISTORY_LIMIT = 60;

class History {
  constructor() {
    this._undoStack = [];
    this._redoStack = [];
    this._listeners = new Set();
    this._depth = 0; // nesting depth of run()
    this._pendingBefore = null;
    this._pendingLabel = null;
    this._applying = false; // true while undo/redo rewrites the scene
    this._dirty = false; // unsaved changes since the last save/load
  }

  get canUndo() {
    return this._undoStack.length > 0;
  }

  get canRedo() {
    return this._redoStack.length > 0;
  }

  get undoLabel() {
    return this.canUndo ? this._undoStack[this._undoStack.length - 1].label : null;
  }

  get redoLabel() {
    return this.canRedo ? this._redoStack[this._redoStack.length - 1].label : null;
  }

  // True while an undo or redo is rewriting the scene. Store subscribers
  // that would otherwise record history use this to keep quiet.
  get isApplying() {
    return this._applying;
  }

  get isDirty() {
    return this._dirty;
  }

  markSaved() {
    this._dirty = false;
    this._emit();
  }

  subscribe(listener) {
    this._listeners.add(listener);
    listener();
    return () => this._listeners.delete(listener);
  }

  _emit() {
    this._listeners.forEach((listener) => listener());
  }

  // Runs `mutate` as one undoable action. Returns whatever it returns.
  run(label, mutate) {
    if (this._applying) return mutate(); // never record our own rewrites

    // A nested run is part of the action already in progress.
    if (this._depth > 0) {
      this._depth += 1;
      try {
        return mutate();
      } finally {
        this._depth -= 1;
      }
    }

    this._depth = 1;
    this._pendingBefore = serializeProject();
    this._pendingLabel = label;
    let result;
    try {
      result = mutate();
    } catch (error) {
      this._depth = 0;
      this._pendingBefore = null;
      throw error;
    }
    this._depth = 0;
    this._commit();
    return result;
  }

  _commit() {
    const before = this._pendingBefore;
    const label = this._pendingLabel;
    this._pendingBefore = null;
    this._pendingLabel = null;
    if (!before) return;
    this._push(label, before, serializeProject());
  }

  _push(label, before, after) {
    this._undoStack.push({ label, before, after });
    if (this._undoStack.length > HISTORY_LIMIT) this._undoStack.shift();
    // Doing something new abandons the redo branch, as every editor does.
    this._redoStack = [];
    this._dirty = true;
    this._emit();
  }

  // For actions that span many events rather than one function call -- a
  // finger dragging a layer across dozens of pointermove frames is ONE
  // undo step, not dozens. Capture at the start, commit when the gesture
  // ends. `changed` lets the caller drop a gesture that moved nothing.
  capture(label) {
    if (this._applying || this._depth > 0) return null;
    return { label, before: serializeProject() };
  }

  commitCapture(token, changed = true) {
    if (!token || !changed || this._applying) return;
    this._push(token.label, token.before, serializeProject());
  }

  undo() {
    const entry = this._undoStack.pop();
    if (!entry) return null;
    this._apply(entry.before);
    this._redoStack.push(entry);
    this._dirty = true;
    this._emit();
    return entry.label;
  }

  redo() {
    const entry = this._redoStack.pop();
    if (!entry) return null;
    this._apply(entry.after);
    this._undoStack.push(entry);
    this._dirty = true;
    this._emit();
    return entry.label;
  }

  _apply(state) {
    this._applying = true;
    try {
      applyProject(state);
    } finally {
      this._applying = false;
    }
  }

  // Loading a project (or starting a new one) begins a fresh timeline.
  reset() {
    this._undoStack = [];
    this._redoStack = [];
    this._dirty = false;
    this._emit();
  }
}

export const history = new History();
