// Central app state machine. Pure state/transition logic only -- no DOM
// access and no rendering. ui.js subscribes to this to reflect state
// visually; the future rendering/animation engine will hook into the same
// transitions via canvas.js.

export const AppState = Object.freeze({
  HOME: 'home',
  RIG: 'rig', // building the skeleton; parts are not draggable here
  ANIMATING: 'animating', // in Animate mode, before Start is pressed
  RECORDING: 'recording', // in Animate mode, after Start, before Stop
});

class StateManager {
  constructor() {
    this._state = AppState.HOME;
    this._listeners = new Set();
  }

  get state() {
    return this._state;
  }

  // Calls listener immediately with the current state, then again on every
  // future transition. Returns an unsubscribe function.
  subscribe(listener) {
    this._listeners.add(listener);
    listener(this._state);
    return () => this._listeners.delete(listener);
  }

  _transition(next) {
    if (next === this._state) return;
    this._state = next;
    this._listeners.forEach((listener) => listener(this._state));
  }

  enterRigMode() {
    if (this._state === AppState.HOME) {
      this._transition(AppState.RIG);
    }
  }

  exitRigMode() {
    if (this._state === AppState.RIG) {
      this._transition(AppState.HOME);
    }
  }

  enterAnimateMode() {
    if (this._state === AppState.HOME) {
      this._transition(AppState.ANIMATING);
    }
  }

  exitAnimateMode() {
    if (this._state === AppState.ANIMATING || this._state === AppState.RECORDING) {
      this._transition(AppState.HOME);
    }
  }

  startRecording() {
    if (this._state === AppState.ANIMATING) {
      this._transition(AppState.RECORDING);
    }
  }

  stopRecording() {
    if (this._state === AppState.RECORDING) {
      this._transition(AppState.ANIMATING);
    }
  }
}

export const appState = new StateManager();
