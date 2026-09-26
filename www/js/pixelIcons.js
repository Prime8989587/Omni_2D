// Every icon in the app, as pixel art.
//
// WHY PIXEL GRIDS, DRAWN THIS WAY
//
// The app's icons used to be a mix: eight hand-made PNGs, and everywhere
// else a Unicode glyph (undo ↺, fit ⤢, the app menu ≡, kebabs ⋮, chevrons,
// stars, arrows, ✕...) that neither pixel font contains, so the phone drew
// it in its own smooth system font -- or, for 👁 🔒 🗑, as a full-colour
// emoji. Every one of those is replaced here by a grid drawn pixel by pixel.
//
// Each grid is emitted as an SVG whose every filled pixel is one unit
// square, with shape-rendering="crispEdges". That combination was measured
// against the alternatives in the real browser before choosing it: at a
// device pixel ratio of 3 all three -- this, a PNG with image-rendering:
// pixelated, and a CSS mask of that PNG -- come out with exactly two
// colours, hard. But at 2.625, a ratio many Android phones actually have,
// the scaled PNG and the mask blend ~100 pixels per icon along the
// boundaries between art pixels; crisp SVG squares snap to device pixels
// instead and stay hard. And fill="currentColor" means one grid serves
// every state -- pink, white, dark on a pressed button, grey when disabled
// -- with no second copy to drift.
//
// ONE PIXEL DENSITY FOR ALL OF IT
//
// Every art pixel is 2 CSS pixels -- the same size as one pixel of Press
// Start 2P, the header font, at the app's 16px header size. Icons, the
// flowers, the petals, the wordmark, slider handles and toggle knobs all
// share it, so nothing in the interface is drawn at a finer or coarser
// grain than anything beside it. Icons differ in how MANY pixels they have
// (8x8 beside text, 12x12 on buttons), never in how big a pixel is.
//
// FORMAT
//
// One string per row, '#' for a filled pixel and '.' for an empty one.
// Multi-colour sprites (the flower, the wordmark) use letters, mapped to
// colours by a palette.

export const PIXEL = 2; // CSS px per art pixel, everywhere

// ---------------------------------------------------------------------------
// The icons

export const ICONS = {
  // ---- 8x8: set inline with text ------------------------------------------
  'arrow-left': [
    '........',
    '...#....',
    '..##....',
    '.#######',
    '.#######',
    '..##....',
    '...#....',
    '........',
  ],
  'arrow-up': [
    '...##...',
    '..####..',
    '.######.',
    '...##...',
    '...##...',
    '...##...',
    '...##...',
    '........',
  ],
  'arrow-nw': [
    '#####...',
    '##......',
    '#.#.....',
    '#..#....',
    '#...#...',
    '.....#..',
    '......#.',
    '.......#',
  ],
  'chevron-down': [
    '........',
    '........',
    '.##..##.',
    '..####..',
    '...##...',
    '........',
    '........',
    '........',
  ],
  'triangle-up': [
    '........',
    '...##...',
    '..####..',
    '.######.',
    '########',
    '........',
    '........',
    '........',
  ],
  'triangle-left': [
    '......##',
    '....####',
    '..######',
    '########',
    '########',
    '..######',
    '....####',
    '......##',
  ],
  close: [
    '##....##',
    '###..###',
    '.######.',
    '..####..',
    '..####..',
    '.######.',
    '###..###',
    '##....##',
  ],
  star: [
    '...##...',
    '...##...',
    '########',
    '.######.',
    '..####..',
    '.######.',
    '.##..##.',
    '##....##',
  ],
  'star-outline': [
    '...##...',
    '...##...',
    '###..###',
    '.#....#.',
    '..#..#..',
    '.#.##.#.',
    '.##..##.',
    '##....##',
  ],
  diamond: [
    '...##...',
    '..####..',
    '.######.',
    '########',
    '########',
    '.######.',
    '..####..',
    '...##...',
  ],
  warning: [
    '...##...',
    '..####..',
    '..#..#..',
    '.##..##.',
    '.######.',
    '###..###',
    '########',
    '........',
  ],
  branch: [
    '.#......',
    '.#......',
    '.#......',
    '.#......',
    '.######.',
    '........',
    '........',
    '........',
  ],
  info: [
    '.######.',
    '###..###',
    '########',
    '###..###',
    '###..###',
    '###..###',
    '###..###',
    '.######.',
  ],
  check: [
    '........',
    '.......#',
    '......##',
    '#....##.',
    '##..##..',
    '.####...',
    '..##....',
    '........',
  ],
  plus: [
    '...##...',
    '...##...',
    '...##...',
    '########',
    '########',
    '...##...',
    '...##...',
    '...##...',
  ],
  minus: [
    '........',
    '........',
    '........',
    '########',
    '########',
    '........',
    '........',
    '........',
  ],

  // ---- 12x12: on buttons ---------------------------------------------------
  undo: [
    '............',
    '...#........',
    '..##........',
    '.#########..',
    '.##########.',
    '..##......##',
    '...#......##',
    '..........##',
    '..........##',
    '.........##.',
    '.....#####..',
    '.....####...',
  ],
  'rotate-left': [
    '............',
    '.#..####....',
    '.#.######...',
    '.###....##..',
    '.####....##.',
    '.#####....#.',
    '..........#.',
    '.#........#.',
    '.##......##.',
    '..##....##..',
    '...######...',
    '....####....',
  ],
  'rotate-left-90': [
    '............',
    '..#.........',
    '.##.........',
    '#######.....',
    '########....',
    '.##....##...',
    '..#.....##..',
    '.........#..',
    '.....#...#..',
    '.....##.##..',
    '.....#####..',
    '.....######.',
  ],
  fit: [
    '####....####',
    '###......###',
    '###......###',
    '#..#....#..#',
    '............',
    '............',
    '............',
    '............',
    '#..#....#..#',
    '###......###',
    '###......###',
    '####....####',
  ],
  menu: [
    '............',
    '............',
    '############',
    '############',
    '............',
    '############',
    '############',
    '............',
    '############',
    '############',
    '............',
    '............',
  ],
  kebab: [
    '............',
    '.....##.....',
    '.....##.....',
    '............',
    '............',
    '.....##.....',
    '.....##.....',
    '............',
    '............',
    '.....##.....',
    '.....##.....',
    '............',
  ],
  exit: [
    '............',
    '.##......##.',
    '.###....###.',
    '..###..###..',
    '...######...',
    '....####....',
    '....####....',
    '...######...',
    '..###..###..',
    '.###....###.',
    '.##......##.',
    '............',
  ],
  back: [
    '............',
    '.......##...',
    '......###...',
    '.....###....',
    '....###.....',
    '...###......',
    '...###......',
    '....###.....',
    '.....###....',
    '......###...',
    '.......##...',
    '............',
  ],
  home: [
    '.....##.....',
    '....####....',
    '...##..##...',
    '..##....##..',
    '.##......##.',
    '############',
    '.#........#.',
    '.#..###...#.',
    '.#..#.#...#.',
    '.#..#.#...#.',
    '.#..#.#...#.',
    '.##########.',
  ],
  gear: [
    '.....##.....',
    '..##.##.##..',
    '..########..',
    '...##..##...',
    '.###....###.',
    '.##......##.',
    '.##......##.',
    '.###....###.',
    '...##..##...',
    '..########..',
    '..##.##.##..',
    '.....##.....',
  ],
  eye: [
    '............',
    '............',
    '....####....',
    '..##....##..',
    '.#..####..#.',
    '#..######..#',
    '#..##.###..#',
    '.#..####..#.',
    '..##....##..',
    '....####....',
    '............',
    '............',
  ],
  'eye-off': [
    '#...........',
    '.#..........',
    '..#.####....',
    '..##....##..',
    '.#..#.##..#.',
    '#..##.###..#',
    '#..###.##..#',
    '.#..####..#.',
    '..##....##..',
    '....####.#..',
    '..........#.',
    '...........#',
  ],
  lock: [
    '............',
    '....####....',
    '...#....#...',
    '...#....#...',
    '...#....#...',
    '..########..',
    '..########..',
    '..###..###..',
    '..###..###..',
    '..####.###..',
    '..########..',
    '............',
  ],
  unlock: [
    '............',
    '....####....',
    '...#....#...',
    '...#........',
    '...#........',
    '..########..',
    '..########..',
    '..###..###..',
    '..###..###..',
    '..####.###..',
    '..########..',
    '............',
  ],
  trash: [
    '....####....',
    '############',
    '............',
    '.##########.',
    '.#.#.##.#.#.',
    '.#.#.##.#.#.',
    '.#.#.##.#.#.',
    '.#.#.##.#.#.',
    '.#.#.##.#.#.',
    '.#.#.##.#.#.',
    '.##########.',
    '..########..',
  ],
  pencil: [
    '.........##.',
    '........####',
    '.......#.###',
    '......#.#.#.',
    '.....#.#.#..',
    '....#.#.#...',
    '...#.#.#....',
    '..#.#.#.....',
    '.##..#......',
    '.###.#......',
    '.####.......',
    '............',
  ],
  eraser: [
    '............',
    '............',
    '..##########',
    '.#....######',
    '#.....######',
    '#.....######',
    '#.....######',
    '.#....######',
    '..##########',
    '............',
    '############',
    '............',
  ],
  move: [
    '.....##.....',
    '....####....',
    '...######...',
    '.....##.....',
    '..#..##..#..',
    '.##..##..##.',
    '############',
    '.##..##..##.',
    '..#..##..#..',
    '.....##.....',
    '...######...',
    '....####....',
  ],
  'flip-h': [
    '.....##.....',
    '.....##.....',
    '..#..##..#..',
    '.##..##..##.',
    '###..##..###',
    '###..##..###',
    '###..##..###',
    '###..##..###',
    '.##..##..##.',
    '..#..##..#..',
    '.....##.....',
    '.....##.....',
  ],
  mirror: [
    '............',
    '.......#....',
    '.......##...',
    '###########.',
    '###########.',
    '.......##...',
    '....#..#....',
    '...##.......',
    '.###########',
    '.###########',
    '...##.......',
    '....#.......',
  ],

  // ---- 12x12: tools ---------------------------------------------------------
  pin: [
    '....####....',
    '...######...',
    '..########..',
    '..###.####..',
    '..########..',
    '...######...',
    '....####....',
    '.....##.....',
    '.....##.....',
    '.....##.....',
    '.....#......',
    '.....#......',
  ],
  link: [
    '............',
    '......####..',
    '.....##..##.',
    '.....#....#.',
    '..####....#.',
    '.##..##..##.',
    '.#....####..',
    '.#....#.....',
    '.##..##.....',
    '..####......',
    '............',
    '............',
  ],
  pierce: [
    '..........##',
    '.........###',
    '........###.',
    '.......###..',
    '......###...',
    '.....###....',
    '....###.....',
    '...###......',
    '######......',
    '#....#......',
    '#.##.#......',
    '######......',
  ],
  mesh: [
    '############',
    '##...##....#',
    '#.#..#.#...#',
    '#..#.#..##.#',
    '#...##....##',
    '############',
    '##...##....#',
    '#.#..#.#...#',
    '#..#.#..##.#',
    '#...##....##',
    '#....#.....#',
    '############',
  ],
  scissors: [
    '#.........#.',
    '.#.......#..',
    '..#.....#...',
    '...#...#....',
    '....#.#.....',
    '.....#......',
    '....#.#.....',
    '.###...###..',
    '#...#.#...#.',
    '#...#.#...#.',
    '#...#.#...#.',
    '.###...###..',
  ],
  brush: [
    '..........##',
    '.........###',
    '........###.',
    '.......###..',
    '......###...',
    '.....###....',
    '....#.#.....',
    '...###......',
    '..####......',
    '.####.......',
    '####........',
    '###.........',
  ],
  bug: [
    '..#......#..',
    '...#....#...',
    '....####....',
    '#..######..#',
    '.#.######.#.',
    '..########..',
    '#.###..###.#',
    '.#########..',
    '..###..###..',
    '.#.######.#.',
    '#..######..#',
    '....####....',
  ],
  flag: [
    '.#..........',
    '.########...',
    '.#########..',
    '.##########.',
    '.#########..',
    '.########...',
    '.#..........',
    '.#..........',
    '.#..........',
    '.#..........',
    '.#..........',
    '####........',
  ],
  scroll: [
    '.##########.',
    '#.#......#.#',
    '.##########.',
    '..#......#..',
    '..#.####.#..',
    '..#......#..',
    '..#.#####.#.',
    '..#......#..',
    '..#.###..#..',
    '..#......#..',
    '.##########.',
    '#.#......#.#',
  ],
  clock: [
    '....####....',
    '..##....##..',
    '.#...##...#.',
    '.#...##...#.',
    '#....##....#',
    '#....####..#',
    '#....####..#',
    '#..........#',
    '.#........#.',
    '.#........#.',
    '..##....##..',
    '....####....',
  ],
  bucket: [
    '.....##.....',
    '....#..#....',
    '...#....#...',
    '..#......#..',
    '.##########.',
    '.#########.#',
    '..########.#',
    '..#######..#',
    '...######..#',
    '...######...',
    '....####....',
    '............',
  ],
  shade: [
    '############',
    '#.#.#.#.#.##',
    '##.#.#.#.#.#',
    '#.#.#.#.#.##',
    '##.#.#.#.#.#',
    '#.#.#.#.#.##',
    '##.#.#.#.#.#',
    '#.#.#.#.#.##',
    '##.#.#.#.#.#',
    '#.#.#.#.#.##',
    '##.#.#.#.#.#',
    '############',
  ],
  circle: [
    '....####....',
    '..##....##..',
    '.#........#.',
    '.#........#.',
    '#..........#',
    '#..........#',
    '#..........#',
    '#..........#',
    '.#........#.',
    '.#........#.',
    '..##....##..',
    '....####....',
  ],
  triangle: [
    '.....##.....',
    '.....##.....',
    '....#..#....',
    '....#..#....',
    '...#....#...',
    '...#....#...',
    '..#......#..',
    '..#......#..',
    '.#........#.',
    '.#........#.',
    '############',
    '############',
  ],
  square: [
    '############',
    '############',
    '##........##',
    '##........##',
    '##........##',
    '##........##',
    '##........##',
    '##........##',
    '##........##',
    '##........##',
    '############',
    '############',
  ],
  select: [
    '###.###.###.',
    '#..........#',
    '#..........#',
    '...........#',
    '#...........',
    '#..........#',
    '#..........#',
    '...........#',
    '#...........',
    '#..........#',
    '#..........#',
    '.###.###.###',
  ],
  picker: [
    '.........##.',
    '........####',
    '.......#####',
    '......#####.',
    '.....#####..',
    '.....####...',
    '....#.##....',
    '...#.#......',
    '..#.#.......',
    '.#.#........',
    '#.#.........',
    '##..........',
  ],
  blend: [
    '.....##.....',
    '.....##.....',
    '....####....',
    '....####....',
    '...######...',
    '..########..',
    '..###.####..',
    '.###.#.####.',
    '.##.#.#.###.',
    '..#.#.#.##..',
    '...######...',
    '....####....',
  ],
  sliders: [
    '..##........',
    '..##........',
    '############',
    '..##........',
    '..##........',
    '.......##...',
    '.......##...',
    '############',
    '.......##...',
    '....##......',
    '############',
    '....##......',
  ],
};

// The mode label's dot: a plain 4x4 square rather than a CSS circle.
ICONS.dot = ['####', '####', '####', '####'];

// Glyphs that are the same drawing turned: generated rather than drawn a
// second time, so a pair can never disagree about its shape.
const flipX = (rows) => rows.map((row) => [...row].reverse().join(''));
const flipY = (rows) => [...rows].reverse();
const rotate90 = (rows) => rows[0].split('').map((_, x) => rows.map((row) => row[x]).reverse().join(''));
ICONS['arrow-right'] = flipX(ICONS['arrow-left']);
ICONS['arrow-down'] = flipY(ICONS['arrow-up']);
ICONS['arrow-ne'] = flipX(ICONS['arrow-nw']);
ICONS['arrow-sw'] = flipY(ICONS['arrow-nw']);
ICONS['arrow-se'] = flipX(flipY(ICONS['arrow-nw']));
ICONS['chevron-up'] = flipY(ICONS['chevron-down']);
ICONS['chevron-right'] = flipX(rotate90(ICONS['chevron-down']));
ICONS['chevron-left'] = flipX(ICONS['chevron-right']);
ICONS['triangle-down'] = flipY(ICONS['triangle-up']);
ICONS['triangle-right'] = flipX(ICONS['triangle-left']);
ICONS.redo = flipX(ICONS.undo);
ICONS['rotate-right'] = flipX(ICONS['rotate-left']);
ICONS['rotate-right-90'] = flipX(ICONS['rotate-left-90']);
ICONS['flip-v'] = rotate90(ICONS['flip-h']);

// ---------------------------------------------------------------------------
// Multi-colour sprites
//
// Drawn in letters: p = the pink accent, d = its dark shade, l = sakura
// pink, c = the flower's pale centre, k = the app background, w = white.

export const PALETTE = {
  p: '#FF2E93',
  d: '#B01062',
  l: '#FFB7C5',
  c: '#FFE8F0',
  k: '#181117',
  w: '#FFFFFF',
  g: '#4D4D4D',
};

// The flower that turns in the corner of every pink-bordered box. A
// five-petal sakura, 8x8. It turns in exact quarter turns -- the one
// rotation a pixel grid survives with no resampling at all -- stepped, a
// tick at a time, the way pixel art has always animated: no frame is ever
// an in-between that the browser had to smooth.
export const FLOWER = [
  '...pp...',
  '..pppp..',
  'pp.lp.pp',
  'pppccppp',
  '.ppccpp.',
  '..pl.pp.',
  '.pp..pp.',
  '.p....p.',
];

const turn = (rows) => rows[0].split('').map((_, x) => rows.map((row) => row[x]).reverse().join(''));
export const FLOWER_FRAMES = [FLOWER, turn(FLOWER), turn(turn(FLOWER)), turn(turn(turn(FLOWER)))];

// The oO mark: a small ring and a large one, touching -- the same two
// loops the CSS circles used to draw, as pixels.
export const WORDMARK = [
  '...####.',
  '..#....#',
  '..#....#',
  '..#....#',
  '.##....#',
  '#..####.',
  '#..#....',
  '.##.....',
];

// A slider's handle: a blocky knob with grip lines, not a smooth circle.
export const SLIDER_HANDLE = [
  '.pppppp.',
  'pppppppp',
  'ppkkkkpp',
  'pppppppp',
  'ppkkkkpp',
  'pppppppp',
  'ppkkkkpp',
  'pppppppp',
  'pppppppp',
  '.pppppp.',
];

// The on/off switch every boolean toggle wears: a track with a square
// knob, left for off and right for on. Drawn in the toggle's own text
// colour for each state -- pink on the dark chip when off, dark on the
// pink chip when on -- so it reads on both.
export const SWITCH_OFF = [
  '.pppppppppp.',
  'p..........p',
  'p.pp.......p',
  'p.pp.......p',
  'p..........p',
  '.pppppppppp.',
];
export const SWITCH_ON = [
  '.kkkkkkkkkk.',
  'k..........k',
  'k.......kk.k',
  'k.......kk.k',
  'k..........k',
  '.kkkkkkkkkk.',
];

// A checkbox tick, knocked out of a filled box.
export const CHECKBOX_ON = [
  'pppppppp',
  'ppppppkp',
  'pppppkkp',
  'pkppkkpp',
  'pkkkkppp',
  'ppkkpppp',
  'pppppppp',
  'pppppppp',
];

// Published as CSS custom properties, so the stylesheet can draw these
// from pseudo-elements and backgrounds -- the drawings still live only
// here. Called once at startup.
export function publishSpriteVariables(root = document.documentElement) {
  const set = (name, frames) => root.style.setProperty(name, spriteDataUri(frames, PALETTE));
  set('--sprite-flower', FLOWER_FRAMES);
  set('--sprite-wordmark', [WORDMARK.map((r) => r.replace(/#/g, 'p'))]);
  set('--sprite-slider-handle', [SLIDER_HANDLE]);
  set('--sprite-slider-handle-disabled', [SLIDER_HANDLE.map((r) => r.replace(/p/g, 'g'))]);
  set('--sprite-switch-off', [SWITCH_OFF]);
  set('--sprite-switch-on', [SWITCH_ON]);
  set('--sprite-checkbox-on', [CHECKBOX_ON]);
  set('--sprite-checkbox-off', [CHECKBOX_ON.map((r, y) => r.replace(/./g, (ch, x) => (
    y === 0 || y === 7 || x === 0 || x === 7 ? 'p' : '.')))]);
}

// ---------------------------------------------------------------------------
// Rendering

// Each run of filled pixels along a row becomes one rectangle in a single
// path: a 12x12 icon is a few dozen subpaths, not 144 elements.
export function gridPath(rows, match = (ch) => ch === '#') {
  let d = '';
  rows.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      if (!match(row[x])) { x++; continue; }
      let end = x;
      while (end < row.length && match(row[end])) end++;
      d += `M${x} ${y}h${end - x}v1h-${end - x}z`;
      x = end;
    }
  });
  return d;
}

// The markup for one icon. `scale` is CSS pixels per art pixel -- PIXEL
// everywhere in the interface.
export function iconMarkup(name, { scale = PIXEL, label = null } = {}) {
  const rows = ICONS[name];
  if (!rows) throw new Error(`Unknown pixel icon "${name}"`);
  const w = rows[0].length;
  const h = rows.length;
  const a11y = label ? `role="img" aria-label="${label}"` : 'aria-hidden="true" focusable="false"';
  return `<svg class="px-icon__svg" width="${w * scale}" height="${h * scale}" viewBox="0 0 ${w} ${h}" ` +
    `shape-rendering="crispEdges" ${a11y}><path fill="currentColor" d="${gridPath(rows)}"/></svg>`;
}

// A multi-colour sprite (letters -> colours) as a standalone SVG document,
// for use as a CSS background image (the flowers): data-URI images cannot
// read CSS variables, so the colours are literal here.
export function spriteSvg(frames, palette, { scale = PIXEL } = {}) {
  const w = frames[0][0].length;
  const h = frames[0].length;
  let body = '';
  frames.forEach((rows, i) => {
    for (const [ch, color] of Object.entries(palette)) {
      const d = gridPath(rows, (c) => c === ch);
      if (d) body += `<path transform="translate(${i * w} 0)" fill="${color}" d="${d}"/>`;
    }
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w * frames.length * scale}" height="${h * scale}" ` +
    `viewBox="0 0 ${w * frames.length} ${h}" shape-rendering="crispEdges">${body}</svg>`;
}

export function spriteDataUri(frames, palette, options) {
  return `url("data:image/svg+xml,${encodeURIComponent(spriteSvg(frames, palette, options))}")`;
}

// Put an icon into an element (replacing its contents), and remember which
// one it is so a later setIcon with the same name is free.
export function setIcon(el, name, options = {}) {
  if (!el) return;
  if (el.dataset.iconDrawn === name) return;
  el.innerHTML = iconMarkup(name, options);
  el.dataset.iconDrawn = name;
  el.dataset.icon = name;
  el.classList.add('px-icon');
}

// A fresh <span> holding an icon, for code that builds rows and buttons.
export function createIcon(name, options = {}) {
  const span = document.createElement('span');
  setIcon(span, name, options);
  return span;
}

// Every element with data-icon gets its drawing -- now, and whenever one is
// added or its data-icon changes later, so markup and code can both just
// say which icon they want.
export function hydrateIcons(root = document) {
  const nodes = root.querySelectorAll ? root.querySelectorAll('[data-icon]') : [];
  for (const node of nodes) {
    if (node.dataset.iconDrawn !== node.dataset.icon) setIcon(node, node.dataset.icon);
  }
  if (root.dataset && root.dataset.icon && root.dataset.iconDrawn !== root.dataset.icon) setIcon(root, root.dataset.icon);
}

let observer = null;

export function initPixelIcons() {
  publishSpriteVariables();
  hydrateIcons(document);
  if (observer || typeof MutationObserver === 'undefined') return;
  observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.type === 'attributes') {
        if (m.target.dataset && m.target.dataset.icon !== m.target.dataset.iconDrawn) setIcon(m.target, m.target.dataset.icon);
      } else {
        for (const node of m.addedNodes) if (node.nodeType === 1) hydrateIcons(node);
      }
    }
  });
  observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-icon'] });
}
