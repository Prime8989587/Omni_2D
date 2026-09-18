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
    title: 'Enter, Dent & End points',
    body: 'All three are measured in scene pixels, from the piercer’s ' +
      'painted tip to the nearest pierceable pixel.\n\n' +
      '• Enter is the gap where contact starts -- get this close and the ' +
      'tip sinks under the surface and starts pressing on its bones.\n' +
      '• Dent Trigger is the gap where the NOTCH starts to appear. Its own ' +
      'setting, so touching and denting need not happen at the same moment.\n' +
      '• End is how much deeper both keep growing before they stop ' +
      'advancing. Past End the notch and the piercer itself hold at their ' +
      'deepest.\n\n' +
      'Set them by typing the numbers, or by dragging the three handles ' +
      'drawn on the piercer’s own artwork -- both write the same values, ' +
      'so neither one is more "real" than the other.',
  },
  'pierce-dent-start': {
    title: 'Dent Trigger Distance',
    body: 'The gap at which the notch begins to appear -- separate from the ' +
      'Enter point, and measured the same way, in scene pixels from the ' +
      'painted tip to the nearest pierceable pixel.\n\n' +
      'Enter and this answer two different questions. Enter is when the two ' +
      'layers are IN CONTACT: the tip draws beneath the surface and starts ' +
      'pressing back on the pierced layer’s bones. This is when the surface ' +
      'starts to GIVE WAY.\n\n' +
      '• Closer than Enter -- the tip touches, sinks in, and only then does ' +
      'the notch start to open. A needle resting on skin before it breaks it.\n' +
      '• Equal to Enter -- the dent starts on contact, which is how every ' +
      'project behaved before this setting existed.\n' +
      '• Further out than Enter -- the surface flinches before anything ' +
      'touches it.\n\n' +
      'Whichever you choose, the notch is complete at the End point: that is ' +
      'the one place both the dent and the depth finish.',
  },
  'pierce-targets': {
    title: 'Paint targets',
    body: 'Tip (on the piercer) is what counts as "in".\n\n' +
      'On the pierced layer, three masks and one placement:\n' +
      '• Pierceable -- where contact is detected at all, and the only ' +
      'place the notch is allowed to cut.\n' +
      '• Deformable -- which pixels BUNCH UP around that notch, pushing ' +
      'outward as it grows, the way material does when something is ' +
      'pressed into it. They only ever move AWAY from the notch, and they ' +
      'never cut anything themselves. Empty means none of them react: the ' +
      'notch still cuts, the edges around it just stay put.\n' +
      '• Barrier -- solid pixels that stop the piercer sideways while ' +
      'in contact. Never blocks it going deeper -- that’s Enter/End.\n' +
      '• Dent -- not a mask. The wedge itself, dragged onto the spot where ' +
      'the notch should happen. This is the only thing that cuts.',
  },
  'pierce-dent': {
    title: 'Dent shape',
    body: 'The notch a pierce cuts into this layer, in its own pixels. ' +
      'Measured at the End point -- it grows from nothing at the Dent ' +
      'Trigger Distance, and shrinks back to nothing as the piercer comes ' +
      'out.\n\n' +
      '• Depth -- how far the point drives in.\n' +
      '• Width -- how wide the opening is across the surface.\n\n' +
      'Set either to 0 for no notch at all.\n\n' +
      'Both are easier to set by hand: Paint regions…, then the Dent ' +
      'target, and drag the wedge on the artwork. Its base handle places ' +
      'it, its apex handle sets depth and direction, its width handle sets ' +
      'the opening. These sliders and those handles are the same two ' +
      'numbers.\n\n' +
      'WHERE the dent happens is fixed once you place it. The piercer ' +
      'decides how much of it appears, never where.\n\n' +
      'Paint Deformable on the same layer to make the material around the ' +
      'notch bunch up as it opens.',
  },
  'clayer-tools': {
    title: 'Boundary and Fill',
    body: '• Boundary -- draws a line on the imported picture marking the ' +
      'outline of the piece you want to pull out. It has to form ONE ' +
      'unbroken loop, fully closed, before Fill will work.\n' +
      '• Fill -- tap anywhere inside a closed loop to select everything it ' +
      'encloses, shown in green. Tap the line itself, tap outside every ' +
      'loop, or tap inside a loop with a gap in it, and you get a message ' +
      'explaining why instead of a wrong or silent fill.\n\n' +
      'The CLayer button only lights up once a fill has succeeded, and it ' +
      'extracts exactly those pixels from the original picture -- nothing ' +
      'resampled, nothing outside the fill kept.',
  },
  'pcreate-color': {
    title: 'Colour picker',
    body: 'The wheel picks a hue and how saturated it is -- drag anywhere ' +
      'on it, the centre is white, the rim is the fully saturated colour ' +
      'at that angle.\n\n' +
      'The wheel itself is always shown at full brightness; the separate ' +
      '**Value** slider is what actually darkens or lightens the colour ' +
      'you end up with, all the way to black at 0%.\n\n' +
      'The hex field is the same colour a third way -- type a value there ' +
      'and the wheel and slider both jump to match it, exactly as typing ' +
      'a swatch does.',
  },
  'pcreate-palette': {
    title: 'Palettes',
    body: 'A palette is a named list of saved colours, kept on this ' +
      'device across every project and every PCreate session -- not part ' +
      'of any one piece of artwork.\n\n' +
      '**Save to Palette** adds the colour currently picked to whichever ' +
      'palette is loaded. **Palettes…** opens the full list: load a ' +
      'different one, create a new one, rename or delete any of them.\n\n' +
      'Tap a saved swatch to pick that colour again; the small × on a ' +
      'swatch removes it from the palette permanently.',
  },
  'pcreate-edit-mode': {
    title: 'Editing an imported image',
    body: 'Off (the default) -- PCreate always works on its own copy of ' +
      'whatever you brought in, never anything else’s data.\n\n' +
      'On -- a future PCreate feature that opens an existing layer for ' +
      'touch-ups will edit that layer’s own pixels directly instead of ' +
      'a copy, the moment you make a change, with no separate save step.\n\n' +
      'Nothing in PCreate today can actually alias another layer’s data ' +
      'either way -- an imported picture is always freshly decoded, and a ' +
      'blank canvas starts empty -- so this has no visible effect until ' +
      'that feature exists. It is here now so the setting is already ' +
      'working, persisted, and asking the right question by the time it ' +
      'does.',
  },
  'pcreate-tools': {
    title: 'The drawing tools',
    body: 'One finger uses the current tool; two fingers always pan and ' +
      'zoom, so getting a closer look never draws anything.\n\n' +
      '• Brush -- paints the current colour in hard, single-colour pixels, ' +
      '1×1 up to 10×10. Nothing is ever smoothed or faded at the edges.\n' +
      '• Eraser -- the same brush, clearing pixels back to fully ' +
      'transparent rather than painting over them.\n' +
      '• Shade -- the same brush again, but it opens already set to a ' +
      'darker, less saturated version of what is on the canvas, for ' +
      'putting shadows in by hand instead of generating them.\n' +
      '• Circle / Triangle / Square -- drag to set the size, then choose ' +
      'Filled or Outline. An outline is always exactly one pixel thick.\n' +
      '• Select -- draw a closed loop; everything inside it becomes the ' +
      'selection.\n' +
      '• Pick Color -- tap any pixel to make its exact colour the active ' +
      'one.\n' +
      '• Fill -- floods every connected pixel matching the one you tap. ' +
      'Empty background counts as a colour, so you can fill it too.\n' +
      '• Blend -- writes one new midpoint pixel between two differently ' +
      'coloured neighbours.\n\n' +
      'Undo and Redo step back and forward through everything you draw. ' +
      'Save work keeps the canvas itself, mid-edit, so closing the app ' +
      'does not lose it — that is separate from Save as Layer, which hands ' +
      'a finished picture to the project.',
  },
  'pcreate-shadow': {
    title: 'Shadow',
    body: 'Pick the direction the light comes FROM on the compass, set how ' +
      'far the shadow falls, and Add Shadow drops a hard-edged copy of the ' +
      'silhouette behind the artwork.\n\n' +
      'It only ever paints on empty pixels -- a shadow never covers the ' +
      'art casting it.\n\n' +
      'The colour starts on Auto: a darker, less saturated relative of the ' +
      'colours already on the canvas, so the shadow belongs to the same ' +
      'picture rather than being a generic grey. Use current color ' +
      'overrides it with whatever the picker is set to; Auto goes back.\n\n' +
      'With a selection active, only that selection casts a shadow.\n\n' +
      'For shading by hand instead, use the Shade brush.\n\n' +
      'The shadow is kept as its own layer rather than painted into the ' +
      'artwork, which is what makes the next two things work.\n\n' +
      'Pressing Add Shadow again after changing the artwork REPLACES the ' +
      'old shadow rather than adding a second one on top. Pressing it with ' +
      'nothing changed does nothing and says so — there would be no ' +
      'difference to produce.\n\n' +
      'Shadow: ON/OFF hides and shows the shadow you last generated so you ' +
      'can compare with and without. It never recalculates anything — ' +
      'switching it off and back on gives you the identical shadow back.',
  },
  'pcreate-layers': {
    title: 'PCreate layers',
    body: 'PCreate’s canvas is a stack of layers, like the project’s own ' +
      'Scene Parts but kept inside PCreate.\n\n' +
      'Every tool draws on the SELECTED layer only. Tap a layer’s name to ' +
      'select it; the list runs top of the stack first, matching what you ' +
      'see on the canvas.\n\n' +
      'The "⋮" on a row opens Rename, Move up/down, Duplicate, Delete and ' +
      'that layer’s Opacity. Duplicate makes a genuinely independent copy ' +
      '— painting on one does not touch the other.\n\n' +
      'Rotate and Flip with nothing selected apply to the WHOLE canvas, ' +
      'meaning every layer at once. They have to: a quarter turn of a ' +
      'non-square canvas swaps its width and height, and every layer in a ' +
      'stack shares one set of dimensions.\n\n' +
      'Import to Main copies whichever layers you tick into the project as ' +
      'normal Scene Parts. The originals stay here.',
  },
  'pcreate-auto-palette': {
    title: 'Auto Palette',
    body: 'Not a palette you build — a readout of the colours the current ' +
      'artwork is actually made of, scanned straight off the canvas.\n\n' +
      'Colours are ordered around the colour wheel: red, orange, yellow, ' +
      'green, blue, purple and back toward red. Greys have no real hue, so ' +
      'they are grouped at the end, light to dark.\n\n' +
      'This is a different thing from the saved Palettes above. Those are ' +
      'named, kept between sessions, and only change when you change them. ' +
      'This one has no name, is never saved, and only reflects what is on ' +
      'the canvas right now. Tapping a swatch in either picks that colour.\n\n' +
      'It refreshes as you draw. On a very large canvas, scanning every ' +
      'pixel after every stroke would be slow, so there it updates only ' +
      'when you press Refresh.',
  },
  'pcreate-transform': {
    title: 'Rotate and Flip',
    body: 'Both apply to the SELECTION if there is one, and to the whole ' +
      'canvas if there is not. The line above the buttons always says ' +
      'which.\n\n' +
      '90° turns are exact -- nothing is resampled, and turning a ' +
      'non-square canvas swaps its width and height.\n\n' +
      'Free angle rotates by any amount and re-snaps the result to the ' +
      'pixel grid, so it stays crisp instead of going blurry. Odd angles ' +
      'cannot land every original pixel on a new one, so some detail ' +
      'shifts -- that is the cost of keeping hard edges, and it is why the ' +
      '90° buttons are separate.\n\n' +
      'Flip has two operations, not four: mirroring up and mirroring down ' +
      'across the same centre line give an identical result, as do left ' +
      'and right. Each button is labelled with both of its names.',
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
  'weight-tool': {
    title: 'Weight tool',
    body: 'Both tools use the same brush -- size, strength and falloff mean ' +
      'the same thing for each.\n\n' +
      '\u2022 Paint raises the SELECTED bone\u2019s influence on the vertices ' +
      'under your finger.\n' +
      '\u2022 Erase lowers it toward zero. The other bones already ' +
      'influencing those vertices take up the slack, so the total always ' +
      'stays at 1 and the artwork never loses its skinning.\n\n' +
      'Neither touches the artwork itself -- only which bone moves it. ' +
      'Erasing the last influence on a vertex leaves it sitting at rest.',
  },
  'export-fps': {
    title: 'Frame rate',
    body: 'How many of the recorded frames play per second. Lower is ' +
      'slower and choppier and makes a smaller file; higher is smoother ' +
      'and larger. The preview above plays at whatever you pick, so you ' +
      'can judge it before saving rather than after.\n\n' +
      'GIF measures frame delays in hundredths of a second, so not every ' +
      'rate is expressible exactly -- when the one you pick has to be ' +
      'rounded, the line under the preview says what it will really play ' +
      'at.',
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
