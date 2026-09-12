// Info buttons: a small (i) mark beside any control whose purpose is not
// obvious from its label alone. Tapping it opens a short, plain-language
// explanation in a popover anchored near the button -- an on-demand
// footnote, not a permanent fixture competing with the control for space.
//
// One design choice threads all of this: the wording lives HERE, in one
// table, rather than scattered across index.html as attributes or split
// across per-screen modules. A control just wears
// `class="info-btn" data-info="some-key"` and everything else -- opening,
// closing, positioning, dismissing -- is handled once, centrally, the same
// way for every instance. Adding coverage for a new control anywhere in
// the app is a one-line HTML addition plus one entry below; nothing else
// has to change.

const TOPICS = {
  'pierce-role': {
    title: 'Pierce role',
    body: '• Piercer is the layer that does the poking -- a needle, a horn, ' +
      'a finger. Paint its tip, and set how close it has to get before the ' +
      'other layer starts to give way.\n' +
      '• Pierced is the layer that gets poked. Paint the area a piercer ' +
      'is allowed to push into; its own bones and physics keep running as ' +
      'normal alongside the contact.\n\n' +
      'A layer is one, the other, or neither -- never both at once, and a ' +
      'pierce always needs one of each.',
  },
  'pierce-physics': {
    title: 'Physics direction',
    body: 'Which side’s MOVEMENT is allowed to deepen the contact -- not ' +
      'which side is allowed to move at all. Both keep moving freely ' +
      'either way; this only decides whose movement counts toward closing ' +
      'the gap.\n\n' +
      '• Piercer -- only the piercer driving in deepens it. Moving the ' +
      'pierced layer onto a parked piercer keeps whatever contact already ' +
      'exists but cannot push further in.\n' +
      '• Pierced -- the reverse: only the pierced layer’s own movement ' +
      'counts. Driving the piercer further in has no further effect.\n' +
      '• Both -- either one deepens it, and the two add together rather ' +
      'than competing.',
  },
  'pierce-depths': {
    title: 'Enter & End points',
    body: 'Both are measured in scene pixels, from the piercer’s painted ' +
      'tip to the nearest pierceable pixel.\n\n' +
      '• Enter is the gap where contact starts -- get this close and the ' +
      'pierced area begins to react.\n' +
      '• End is how much deeper the push keeps growing before it stops ' +
      'advancing. Past End the shape change and the piercer itself both ' +
      'hold at their deepest.\n\n' +
      'Set them by typing the numbers, or by dragging the two handles ' +
      'drawn on the piercer’s own artwork -- both write the same values, ' +
      'so neither one is more "real" than the other.',
  },
  'pierce-targets': {
    title: 'Paint targets',
    body: 'Tip (on the piercer) is what counts as "in".\n\n' +
      'On the pierced layer, four masks, each a different question:\n' +
      '• Pierceable -- the Rest shape; where contact is detected at all.\n' +
      '• Deformable -- of those pixels, which may actually move. ' +
      'Pierceable-but-not-deformable pixels still register contact and ' +
      'sink beneath the tip, but hold still -- like bone under flesh. ' +
      'Empty means the whole pierceable area gives way.\n' +
      '• Barrier -- solid pixels that stop the piercer sideways while ' +
      'in contact. Never blocks it going deeper -- that’s Enter/End.\n' +
      '• Entered -- a second outline for the SAME area, showing its ' +
      'shape at full depth. The outline blends from Rest to Entered as ' +
      'depth goes from Enter to End.\n\n' +
      'Nothing painted on Entered means the region simply stays at Rest: ' +
      'morphing needs a shape to blend toward, and won’t turn on by itself.',
  },
  'joint-type': {
    title: 'Follows parent',
    body: '• Rigid -- turns with its parent instantly, like a normal ' +
      'skeleton joint. The default, and right for most bones.\n' +
      '• Physics -- trails behind its parent and settles under a spring, ' +
      'like hair or loose cloth reacting to motion.\n' +
      '• Pivot -- carried along by its parent’s position, but never ' +
      'turned by it; its own angle is set separately. Useful for something ' +
      'that should move with the body without inheriting its rotation.',
  },
  'pxpin-tool': {
    title: 'Px Pin',
    body: 'Pins hold individual pixels exactly at their rest position, ' +
      'immune to bone rotation and spring physics -- useful anywhere ' +
      'jiggling or skinning would look wrong: a pupil, a belt buckle, a ' +
      'piercer’s own tip.\n\n' +
      '• Pin paints new pins.\n' +
      '• Eraser Pin removes them, without touching the artwork itself.\n\n' +
      'Painting always happens on the Above layer; Below is shown only as ' +
      'a reference to line pins up against, and is never itself pinned.',
  },
};

let popoverEl = null;
let openFor = null; // the .info-btn currently expanded, or null

function ensurePopover() {
  if (popoverEl) return popoverEl;
  popoverEl = document.createElement('div');
  popoverEl.className = 'info-popover';
  popoverEl.setAttribute('role', 'note');
  popoverEl.hidden = true;
  document.body.appendChild(popoverEl);
  return popoverEl;
}

// Anchored under the button by default, left-edge aligned to it, and
// clamped so it never runs off any side of the viewport -- a phone screen
// with the button near an edge is the common case here, not an exception.
// Flips above the button when there isn't room below.
function positionPopover(el, btn) {
  const margin = 12;
  const gap = 8;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const r = btn.getBoundingClientRect();

  el.style.maxWidth = `${Math.min(280, vw - margin * 2)}px`;
  const pw = el.offsetWidth;
  const ph = el.offsetHeight;

  let left = Math.min(r.left, vw - pw - margin);
  left = Math.max(margin, left);

  let top = r.bottom + gap;
  if (top + ph > vh - margin) {
    const above = r.top - ph - gap;
    top = above >= margin ? above : Math.max(margin, vh - ph - margin);
  }

  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
}

export function closeInfoPopover() {
  if (!openFor) return;
  openFor.setAttribute('aria-expanded', 'false');
  openFor = null;
  ensurePopover().hidden = true;
}

function openInfoPopover(btn) {
  const topic = TOPICS[btn.dataset.info];
  if (!topic) return; // an info-btn with no matching entry does nothing,
  // rather than popping up an empty box -- a missing key is a bug to fix
  // in TOPICS, not a reason to show the user nothing useful.

  if (openFor && openFor !== btn) openFor.setAttribute('aria-expanded', 'false');

  const el = ensurePopover();
  el.replaceChildren();

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'info-popover__close';
  close.setAttribute('aria-label', 'Close');
  close.textContent = '×';
  // The delegated document listener below would also close this on the
  // same tap -- via the "outside the popover" branch, since a click BEFORE
  // this handler runs hasn't removed the element it's checking against --
  // but stopping it here keeps the close button an explicit, single-owner
  // action rather than relying on that side effect.
  close.addEventListener('click', (event) => {
    event.stopPropagation();
    closeInfoPopover();
  });

  const title = document.createElement('strong');
  title.className = 'info-popover__title';
  title.textContent = topic.title;

  const body = document.createElement('p');
  body.className = 'info-popover__body';
  body.textContent = topic.body;

  el.append(close, title, body);
  el.hidden = false;
  btn.setAttribute('aria-expanded', 'true');
  openFor = btn;
  positionPopover(el, btn);
}

// Wires the whole feature with two listeners on the document, so any
// current or future `.info-btn` anywhere in the app -- including ones
// added to a modal that doesn't exist yet -- works with no per-element
// setup. This mirrors the app menu's own outside-tap-to-close listener.
export function initInfoButtons() {
  document.addEventListener('click', (event) => {
    const btn = event.target.closest('.info-btn');
    if (btn) {
      event.stopPropagation();
      if (openFor === btn) {
        closeInfoPopover();
      } else {
        openInfoPopover(btn);
      }
      return;
    }
    // Any other tap dismisses an open popover -- including a tap on a
    // real action button (Done, Confirm, a segmented option). That button
    // still gets its own click normally; this only ever hides the note
    // left floating over it, never blocks or delays the actual action.
    if (openFor && !ensurePopover().contains(event.target)) {
      closeInfoPopover();
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && openFor) closeInfoPopover();
  });

  // Reposition rather than close on rotation/resize: the explanation the
  // user just asked for is exactly as relevant after the screen turns.
  window.addEventListener('resize', () => {
    if (openFor) positionPopover(ensurePopover(), openFor);
  });
}
