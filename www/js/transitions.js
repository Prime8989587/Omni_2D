// One screen transition, used for every screen change in the app.
//
// WHY ONE, AND WHY HERE
//
// The alternative is each screen animating itself, which is how an app ends
// up with a fade here, a slide there and a snap somewhere else -- every one
// defensible on its own and the set of them feeling arbitrary. So there is
// a single function, it does a fade plus a short slide, and every caller
// gets exactly that. Changing how navigation feels is then one edit in one
// place rather than a hunt through five modules.
//
// It is also deliberately CHEAP. This fires when someone switches into Bind
// mode mid-project, with a rigged character and a few hundred mesh vertices
// already on screen, on a phone. The animation is opacity and transform
// only -- the two properties a browser can animate on the compositor
// without re-laying-out the page -- and it is short. Anything that made
// navigation feel sluggish would be worse than no animation at all.

const ENTER = 'screen-enter';
const LEAVE = 'screen-leave';

// Kept in step with --screen-transition in the stylesheet. The CSS owns the
// real value; this is what the JS waits for.
const DURATION_MS = 220;

function prefersReducedMotion() {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function clearClasses(element) {
  element.classList.remove(ENTER, LEAVE);
}

// Plays the incoming half on an element that is already visible. Used when
// a screen appears without anything having to leave first.
export function playEnter(element) {
  if (!element || prefersReducedMotion()) return;
  clearClasses(element);
  // Reading offsetWidth forces the style change to land before the class
  // goes back on; without it the browser coalesces remove+add into no
  // change at all and a repeated transition plays only the first time.
  void element.offsetWidth;
  element.classList.add(ENTER);
  setTimeout(() => element.classList.remove(ENTER), DURATION_MS + 60);
}

// The full swap: `from` leaves, then `to` arrives. Either may be null, so
// the same call covers appearing, disappearing and replacing.
//
// `show`/`hide` are passed in rather than assumed, because "this screen is
// visible" is spelled differently around the app -- the hidden attribute in
// one place, a class in another -- and this should not have to know which.
export function transitionScreens({ from, to, hide, show }) {
  const finish = () => {
    if (from && hide) hide(from);
    if (to && show) show(to);
    if (to) playEnter(to);
  };

  if (!from || prefersReducedMotion()) {
    finish();
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    clearClasses(from);
    void from.offsetWidth;
    from.classList.add(LEAVE);
    setTimeout(() => {
      from.classList.remove(LEAVE);
      finish();
      resolve();
    }, DURATION_MS);
  });
}

// The common case by far: a panel that is shown and hidden with the
// `hidden` attribute.
export function transitionHidden(fromEl, toEl) {
  return transitionScreens({
    from: fromEl,
    to: toEl,
    hide: (el) => { el.hidden = true; },
    show: (el) => { el.hidden = false; },
  });
}
