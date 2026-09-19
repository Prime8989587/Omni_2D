// Tactile confirmation.
//
// Four moments in this app are things the user is AIMING at rather than
// reading: a pin landing on the texel they meant, a bone snapping onto the
// grid, a piercer tip crossing a barrier it cannot pass, and the recorder
// starting or stopping. In each of those the eye is busy somewhere else --
// on the artwork, on the tip, on the pose -- so a short pulse says "that
// registered" without asking for a glance.
//
// Deliberately short. These are confirmations, not alerts: 8-14ms reads as
// a tick through a phone's motor, where anything past about 30ms starts to
// feel like an error buzz. The recorder gets the only double-pulse, because
// starting and stopping a take is the one action here with a consequence
// that outlives the gesture.
//
// navigator.vibrate is the whole dependency. It is present in the Android
// WebView this ships in, absent on desktop and silently ignored on a device
// with the system setting off -- all three of which are fine, because
// nothing in the app branches on whether a pulse actually happened.

// Per-pattern throttles. A paint stroke crosses dozens of texels a second
// and a barrier can be scrubbed against continuously; without this the
// motor would be asked to run flat out and the "tick" would smear into a
// buzz that says nothing. Each pattern gets its own window so a pin and a
// barrier contact never suppress each other.
const lastFired = new Map();

const PATTERNS = {
  // A pin landing. The shortest one here: during a stroke these come in
  // runs, and each should be felt as a separate tick.
  pin: { pattern: 8, minGapMs: 45 },
  // A bone endpoint snapping to the grid. Slightly fuller than a pin --
  // this one lands once per placement, not dozens of times per stroke.
  snap: { pattern: 14, minGapMs: 80 },
  // The piercer tip crossing a barrier. Rate-limited hardest: the tip can
  // sit against a barrier for as long as a finger holds it there, and the
  // thing worth feeling is the CROSSING, not the leaning.
  barrier: { pattern: 12, minGapMs: 220 },
  // Record start / stop. Two taps, because this one changes what the app
  // is doing rather than what a value is.
  record: { pattern: [10, 45, 10], minGapMs: 200 },
};

let enabled = true;

// For tests and for anything that needs to know a pulse was asked for
// without a motor to feel it on.
const fired = [];

export function setHapticsEnabled(value) {
  enabled = Boolean(value);
}

export function haptic(name, now = Date.now()) {
  const spec = PATTERNS[name];
  if (!spec) return false;

  const previous = lastFired.get(name);
  if (previous !== undefined && now - previous < spec.minGapMs) return false;
  lastFired.set(name, now);

  fired.push({ name, at: now });
  if (fired.length > 64) fired.shift();

  if (!enabled) return false;
  const nav = typeof navigator !== 'undefined' ? navigator : null;
  if (!nav || typeof nav.vibrate !== 'function') return false;
  try {
    nav.vibrate(spec.pattern);
  } catch {
    return false; // a WebView that exposes vibrate and then refuses it
  }
  return true;
}

// What has been asked for this session, newest last. Only a debugging and
// verification aid -- nothing in the app reads it.
export function hapticsDebug() {
  return {
    enabled,
    supported: typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function',
    fired: fired.map((entry) => entry.name),
    counts: fired.reduce((acc, entry) => {
      acc[entry.name] = (acc[entry.name] || 0) + 1;
      return acc;
    }, {}),
  };
}

export function resetHapticsDebug() {
  fired.length = 0;
  lastFired.clear();
}
