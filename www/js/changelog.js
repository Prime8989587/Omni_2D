// The app's version, and every release it has had.
//
// THE SCHEME
//
// Three digits, each 0-9, counted like an odometer:
//
//   1.0.0 -> 1.0.1 -> ... -> 1.0.9 -> 1.1.0      a patch rolls into the minor
//   1.1.0 -> 1.2.0 -> ... -> 1.9.0 -> 2.0.0      a minor rolls into the major
//
// A release is either a PATCH (it fixes or refines something that already
// exists) or a MINOR (it brings in something new: a tool, a window, a
// screen, a mode, a file format, or an app-wide redesign). nextVersion()
// below is the one implementation of that rule, and tests/changelog.mjs
// replays the whole list through it -- so a version can only ever be what
// the release before it plus one step says it must be.
//
// WHERE 2.5.0 CAME FROM
//
// The app existed for a long while before it had a version number, so its
// history was replayed to find one. 1.0.0 is the first complete app: Part 6,
// 9 September, when the original six-part plan -- import, rig, bind,
// physics, Free Move -- was done. Every shipped change after that was
// counted in order under the rule above (a commit that only touched the
// build pipeline or the docs is not a release). That lands on 2.4.3 for
// the PxLink rename; this update, which brings new screens, is 2.5.0.
//
// LOGGING A RELEASE
//
// Add an entry at the TOP of RELEASES, its version one step on from the
// one below it, and bump package.json and android/app/build.gradle to
// match. tests/changelog.mjs fails until all four agree, which is what
// keeps the log from ever falling behind the app.

export const RELEASES = [
  {
    version: '2.5.0',
    date: '2026-09-26',
    title: 'Pixel-perfect, and quicker to get around',
    kind: 'minor',
    notes: [
      'Recent tools: the last three tools you used sit in a row at the top of the workspace (and on the Home screen) — one tap takes you straight back.',
      'Checkpoints: save named snapshots of what you are working on ("before risky physics tuning") and jump back to any of them later in the session.',
      'This changelog, with a version number worked out from the app’s whole history.',
      'Saved brush sizes now work in every brush tool: Px Pin, weight painting, Pierce, Mesh Trim (which gained a brush size), PCreate’s brush, eraser and shade, and CLayer.',
      'One Debug overlay switch shows every diagnostic that applies where you are — pierce regions and readout, mesh wireframes, the bone rotate sliders — instead of each hiding in its own menu.',
      'Contour mode outlines the selected layer, or the whole character’s silhouette, in the colour and thickness you pick in Settings.',
      'Contour colour is picked from pixel swatches or typed as hex, and the outline sits just outside the artwork on its own pixel grid.',
      'Everything is pixel art now: every icon redrawn, pixel sliders, switches and dropdowns, a colour wheel made of visible pixel blocks, hard-edged shadows, pixel petals and flowers — and screens with fractional pixel ratios are scaled so every edge lands on a whole screen pixel.',
      'Bones, handles, rings, wireframes and rulers on every canvas are drawn as whole pixels, and a turned camera shows your artwork’s own pixels turned — no blur.',
    ],
  },
  { version: '2.4.3', date: '2026-09-26', title: 'PxLink holds only at the link point', kind: 'patch', notes: ['PLink is renamed PxLink.', 'Linked layers keep their own bones, springs and drags; only the artwork right at the link bends to stay joined.'] },
  { version: '2.4.2', date: '2026-09-25', title: 'Touch that lands where the finger is', kind: 'patch', notes: ['Tool windows keep their canvas square and taps accurate at every zoom.', 'Free Move drives layers bound by weights alone, and works while recording.'] },
  { version: '2.4.1', date: '2026-09-25', title: 'Pierce: the V', kind: 'patch', notes: ['A pierced layer parts into a V around the piercer, replacing the dent.'] },
  { version: '2.4.0', date: '2026-09-25', title: 'PxLink', kind: 'minor', notes: ['Join separately imported layers at a point you draw.'] },
  { version: '2.3.5', date: '2026-09-24', title: 'Joints and pins that hold', kind: 'patch', notes: ['Layers no longer part at their joints, and pinned art no longer tears, under a hard pull.'] },
  { version: '2.3.4', date: '2026-09-24', title: 'Skinning audit', kind: 'patch', notes: ['The skinning maths audited: blending, weights, mesh validity and frame order fixed.'] },
  { version: '2.3.3', date: '2026-09-19', title: 'Six quality-of-life additions', kind: 'patch', notes: ['Multi-select, last-saved time, list filters, haptics, long-press to find a layer, brush presets.'] },
  { version: '2.3.2', date: '2026-09-19', title: 'Pinch without a twist', kind: 'patch', notes: ['An ordinary pinch-to-zoom no longer turns the camera.'] },
  { version: '2.3.1', date: '2026-09-19', title: 'Five fixes', kind: 'patch', notes: ['A trapped layer list, stolen taps, a snapping zoom, camera rotation, and a joint gap.'] },
  { version: '2.3.0', date: '2026-09-19', title: 'Mesh Trim', kind: 'minor', notes: ['Edit a layer’s mesh vertices and trim its boundary by hand.'] },
  { version: '2.2.4', date: '2026-09-18', title: 'Free Move: pick the layer', kind: 'patch', notes: ['Choose which layer’s bone a drag moves.'] },
  { version: '2.2.3', date: '2026-09-18', title: 'Pin band', kind: 'patch', notes: ['Thin pinned stripes are held the way they were drawn again.'] },
  { version: '2.2.2', date: '2026-09-18', title: 'Px Pin under fast drags', kind: 'patch', notes: ['Pinned pixels stay put during fast Free-Move drags.'] },
  { version: '2.2.1', date: '2026-09-18', title: 'Tall dialogs', kind: 'patch', notes: ['Dialogs taller than the screen can be scrolled to their buttons.'] },
  { version: '2.2.0', date: '2026-09-18', title: 'Settings', kind: 'minor', notes: ['One Settings screen for Main, PCreate and Rig, remembered between sessions.'] },
  { version: '2.1.1', date: '2026-09-18', title: 'Navigation and crispness', kind: 'patch', notes: ['Back to Menu everywhere, a crisper wordmark, flowers and colour wheel.'] },
  { version: '2.1.0', date: '2026-09-18', title: 'Home screen', kind: 'minor', notes: ['A home screen with the oOmni2D wordmark and drifting, draggable petals.'] },
  { version: '2.0.4', date: '2026-09-18', title: 'PCreate layers', kind: 'patch', notes: ['A layer stack inside PCreate, multi-PNG import, and Import to Main.'] },
  { version: '2.0.3', date: '2026-09-18', title: 'PCreate: shadows, fill, save', kind: 'patch', notes: ['Shadow regeneration, Fill, Save and Resume, Undo/Redo and Auto Palette.'] },
  { version: '2.0.2', date: '2026-09-18', title: 'PCreate on a phone', kind: 'patch', notes: ['The tools footer no longer squeezes the canvas away.'] },
  { version: '2.0.1', date: '2026-09-18', title: 'PCreate drawing tools', kind: 'patch', notes: ['Brush, shapes, shadow, select and transforms.'] },
  { version: '2.0.0', date: '2026-09-18', title: 'PCreate', kind: 'minor', notes: ['A window of its own for drawing pixel art: canvas, colour and palettes.'] },
  { version: '1.9.1', date: '2026-09-18', title: 'CLayer: a live gap', kind: 'patch', notes: ['Extracted pieces show the gap they leave; the canvas only grows when it must.'] },
  { version: '1.9.0', date: '2026-09-17', title: 'CLayer', kind: 'minor', notes: ['Cut a new layer out of a picture by drawing its boundary and filling it.'] },
  { version: '1.8.9', date: '2026-09-17', title: 'Pierce: a dent you place', kind: 'patch', notes: ['Place the dent by hand, trigger it separately.'] },
  { version: '1.8.8', date: '2026-09-13', title: 'Pierce: a triangle dent', kind: 'patch', notes: ['Outline morphing replaced with a parametric dent.'] },
  { version: '1.8.7', date: '2026-09-13', title: 'Taps under a toast', kind: 'patch', notes: ['A visible message no longer swallows a tap meant for the canvas.'] },
  { version: '1.8.6', date: '2026-09-13', title: 'Pierce: a gated outline', kind: 'patch', notes: ['A cancelled change can no longer move the outline.'] },
  { version: '1.8.5', date: '2026-09-13', title: 'Pierce: the drawn shape wins', kind: 'patch', notes: ['The painter’s canvas is re-measured and the drawing takes priority.'] },
  { version: '1.8.4', date: '2026-09-13', title: 'Pierce: Entered as a silhouette', kind: 'patch', notes: ['The Entered target opens as a silhouette.'] },
  { version: '1.8.3', date: '2026-09-13', title: 'Pierce: matched outlines', kind: 'patch', notes: ['The two outlines are matched point for point.'] },
  { version: '1.8.2', date: '2026-09-13', title: 'Pierce and Px Pin', kind: 'patch', notes: ['Px Pin’s hold keeps its size while pierced.'] },
  { version: '1.8.1', date: '2026-09-13', title: 'Pierce: finer geometry', kind: 'patch', notes: ['The blend shape gets a mesh fine enough to show it.'] },
  { version: '1.8.0', date: '2026-09-12', title: 'GIF export', kind: 'minor', notes: ['Real animated GIF export, and a weight Eraser in Bind mode.'] },
  { version: '1.7.0', date: '2026-09-12', title: 'Info buttons', kind: 'minor', notes: ['On-demand explanations for Pierce and Bind mode.'] },
  { version: '1.6.6', date: '2026-09-12', title: 'Pierce: a press', kind: 'patch', notes: ['The pierced side can feel the press.'] },
  { version: '1.6.5', date: '2026-09-11', title: 'Pierce: blend shapes', kind: 'patch', notes: ['Blend-shape morphing and placeable markers.'] },
  { version: '1.6.4', date: '2026-09-11', title: 'Pierce: painted walls', kind: 'patch', notes: ['Walls block only where painted; choose who pushes.'] },
  { version: '1.6.3', date: '2026-09-11', title: 'Pierce: walls and depths', kind: 'patch', notes: ['Walls contain the tip; depths are placed by hand.'] },
  { version: '1.6.2', date: '2026-09-11', title: 'Pierce: an End point', kind: 'patch', notes: ['The piercer stops at End; deformable is split from pierceable.'] },
  { version: '1.6.1', date: '2026-09-11', title: 'Pierce: it moves', kind: 'patch', notes: ['The displacement runs, and the tip is shown going in.'] },
  { version: '1.6.0', date: '2026-09-11', title: 'Pierce', kind: 'minor', notes: ['Roles, painted regions and depth-limited contact between layers.'] },
  { version: '1.5.0', date: '2026-09-11', title: 'Visual identity', kind: 'minor', notes: ['Pixel fonts, pixel icons, stepped borders and a layered palette.'] },
  { version: '1.4.2', date: '2026-09-10', title: 'Fit and checkerboard', kind: 'patch', notes: ['Fit centres the canvas; the checkerboard draws at every zoom.'] },
  { version: '1.4.1', date: '2026-09-10', title: 'Visible exports', kind: 'patch', notes: ['A PSaver export no longer lands as a hidden file.'] },
  { version: '1.4.0', date: '2026-09-10', title: 'PSaver', kind: 'minor', notes: ['Export a project to a file and import it back.'] },
  { version: '1.3.2', date: '2026-09-10', title: 'Faster wide brushes', kind: 'patch', notes: ['A wide brush stroke no longer redraws the scene once per pixel.'] },
  { version: '1.3.1', date: '2026-09-10', title: 'Pins that hold', kind: 'patch', notes: ['A pin is a mesh constraint, so pinned pixels stop tearing away.'] },
  { version: '1.3.0', date: '2026-09-10', title: 'Px Pin', kind: 'minor', notes: ['A window for pinning single pixels against deformation.'] },
  { version: '1.2.0', date: '2026-09-10', title: 'Pivot joints', kind: 'minor', notes: ['A joint carried by its parent but never turned by it.'] },
  { version: '1.1.5', date: '2026-09-10', title: 'Top-bar saving', kind: 'patch', notes: ['Auto-weight stays where the layer is; Save/Open/Discard move to the top bar.'] },
  { version: '1.1.4', date: '2026-09-10', title: 'Tidier controls', kind: 'patch', notes: ['Kebab menus, layer rename, canvas Mirror and a bind filter.'] },
  { version: '1.1.3', date: '2026-09-10', title: 'Layers stay put', kind: 'patch', notes: ['A layer never falls back to its import position.'] },
  { version: '1.1.2', date: '2026-09-10', title: 'Jiggle on the right layer', kind: 'patch', notes: ['A spring bone’s jiggle stays on the layer it was given.'] },
  { version: '1.1.1', date: '2026-09-10', title: 'Binding by claim', kind: 'patch', notes: ['A layer binds to the bones that claim it, not whatever is nearest.'] },
  { version: '1.1.0', date: '2026-09-09', title: 'Saved state', kind: 'minor', notes: ['Move the whole character; Save / Reverse / Discard.'] },
  { version: '1.0.4', date: '2026-09-09', title: 'Drag pad', kind: 'patch', notes: ['Free Move: drag anywhere, plus a drag pad.'] },
  { version: '1.0.3', date: '2026-09-09', title: 'Attach anywhere', kind: 'patch', notes: ['Child bones attach anywhere on their parent.'] },
  { version: '1.0.2', date: '2026-09-09', title: 'Master handle', kind: 'patch', notes: ['One handle moves the whole character.'] },
  { version: '1.0.1', date: '2026-09-09', title: 'Free Move by name', kind: 'patch', notes: ['Choose the target by name, then drag anywhere.'] },
  { version: '1.0.0', date: '2026-09-09', title: 'Omni 2D', kind: 'first', notes: ['The first complete app: import pixel art, build a skeleton, bind, add spring physics, and pose it live with Free Move.', 'Before this: the development builds that assembled it, part by part, from 8 September.'] },
];

export const APP_VERSION = RELEASES[0].version;

// One step of the scheme. `kind` is 'patch' or 'minor'.
export function nextVersion(version, kind) {
  let [major, minor, patch] = version.split('.').map(Number);
  if (kind === 'patch') {
    patch++;
    if (patch > 9) { patch = 0; minor++; }
  } else if (kind === 'minor') {
    patch = 0;
    minor++;
  } else {
    throw new Error(`Unknown release kind "${kind}"`);
  }
  if (minor > 9) { minor = 0; major++; }
  return `${major}.${minor}.${patch}`;
}

// The Android versionCode for a version: always increasing, because each
// digit is 0-9.
export function versionCode(version) {
  const [major, minor, patch] = version.split('.').map(Number);
  return major * 100 + minor * 10 + patch;
}
