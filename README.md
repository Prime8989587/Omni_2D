# Omni 2D

An HTML/JS/Canvas app wrapped by [Capacitor](https://capacitorjs.com/) into
a real, installable Android APK.

- **Part 0** proved the build pipeline end to end: a blank canvas, wrapped
  by Capacitor, built into an installable APK.
- **Part 1** added the app shell's screens, navigation, and visual theme —
  Home, Animate mode, and Recording, plus the export modal — with
  placeholder behavior. See "App states & how to navigate" below.
- **Part 2** added real PNG import and character assembly: pick several
  pixel-art PNGs at once, then drag, pinch, rotate, and reorder each piece
  on the canvas. See "Importing and assembling a character" below.
- **Part 3** added **Rig mode**: place bones over the assembled character
  and build a parent/child skeleton. Rotating a bone carries its whole
  chain of children with it. See "Building a skeleton (Rig mode)" below.
- **Part 4** added **Bind mode**: generate a deformable mesh over each
  Part, bind its vertices to nearby bones with weights, and paint those
  weights by hand. **Rotating a bone now actually warps the pixel art.**
  See "Binding artwork to bones (Bind mode)" below.
- **Part 5** added **optional spring physics per bone**, so hair, chest
  or loose clothing lags behind its parent, overshoots, and settles
  instead of snapping rigidly into place. See "Spring physics on a bone"
  below.
- **Grid revision** (current) turns the canvas into an explicit **pixel
  grid**: you choose a canvas size in pixels, every grid cell is exactly
  one pixel, and everything — imported art, drags, scales, bone endpoints,
  and the deformed artwork itself — sits on whole pixels. Pinch to zoom in
  on the grid, and layers exported from another app at the full project
  size **re-assemble themselves** on a canvas of that size (see
  "Re-assembling layers exported from another app").
  See "The pixel grid" below, which also lists what was
  re-verified from Parts 2–5 and the one gesture that changed.
- **Part 6** (current) adds **Free Move**: drag anywhere, or use the pad
  below the buttons, to move the whole character live — rigid bones in
  lockstep, spring bones trailing and settling. See "Free Move: moving the
  character" below.
- **Editor batch** makes it a tool you can actually work in:
  delete, reorder, duplicate, hide and lock layers; assign bones to layers
  and hide bone branches; **undo and redo everything**; and **save projects
  to the device**, with an auto-save that survives a crash. See "Managing
  layers and bones", "Undo and redo" and "Saving and loading projects"
  below. **GIF export is real**: recording captures frames, Stop opens a
  looping preview with an adjustable frame rate, and Save writes an actual
  `.gif` file to the device. Drag-driven animation and MP4 export are
  still to come.

## What's in this repo

```
www/index.html          App shell markup (screens, buttons, panels, export modal)
www/css/style.css       The dark plum/pink pixel-art theme: fonts, palette, pixel-stepped
                         borders, layout and button states
www/fonts/               The two vendored pixel fonts (OFL-licensed, no CDN dependency)
www/icons/               Custom pixel-art icons standing in for the app's former emoji
www/js/state.js         The app's state machine (home/rig/animating/recording) — no DOM
www/js/scene.js         The canvas itself: its size in pixels (8–3072 per side) and presets
www/js/view.js          The camera: zoom and pan between the pixel grid and the screen
www/js/raster.js        Software rasterizer that draws (deformed) triangles straight onto
                         the pixel grid one whole pixel at a time — no gaps, no blur,
                         optionally masked to a subset of the source texels
www/js/parts.js         The scene model: the Part object (whole-pixel position and scale,
                         plus its decoded pixels) and the store holding them
www/js/bones.js         The skeleton: Bone objects, the parent/child tree, and the
                         forward-kinematics math. Kept separate from parts.js
www/js/mesh.js          Mesh generation, auto-weighting, weight painting maths, the
                         linear blend skinning that deforms the artwork, and the
                         per-vertex pin influence that holds pinned pixels still
www/js/importer.js      Picked files -> Parts (PNG validation, size limits, decode,
                         whole-pixel placement, and position-preserving import of
                         canvas-sized layers)
www/js/gestures.js      Home-screen touch handling: drag / pinch-scale / twist a Part, or
                         pan / zoom the grid when the first finger lands on empty cells
www/js/viewGestures.js  Two-finger pinch-zoom of the grid in Rig and Bind mode
www/js/rigTool.js       Touch handling for Bones: two-tap placement, handle dragging
www/js/bindTool.js      Touch handling for weights: the paint brush
www/js/physics.js       The frame loop that keeps spring bones settling after
                         the input that disturbed them has stopped
www/js/poseTool.js      Free Move: the drag that moves the whole character, from
                         the canvas or from the pad below the buttons
www/js/pxpin.js         Px Pin: the pixel-pinning window — its own camera, the
                         paint strokes, and the brush-size menu
www/js/pierce.js        Pierce: the contact measurement and the spring that pushes
                         flesh aside — never a hole, only displaced vertices.
                         Also publishes which tips are currently inside which
                         flesh, so the renderer can draw them underneath it
www/js/pierceState.js   The pierce springs' per-vertex state, in a module of its
                         own so pierce.js and mesh.js can both reach it
www/js/pierceTool.js    The Pierce region painter, on the Px Pin pattern: the
                         piercer's tip, and the pierced layer's pierceable
                         area, the part of it that gives way, and its walls
www/js/history.js       Undo/redo: the command stack of reversible scene snapshots
www/js/project.js       The whole scene as plain data and back — used by both
                         undo/redo and save/load, so there is one serializer
www/js/storage.js       Saved projects and the recovery slot, in IndexedDB
www/js/psaver.js        PSaver: the same project written out as a file the user
                         can copy off the device, and read back in
www/js/autosave.js      Periodic + post-change auto-saves into the recovery slot
www/js/canvas.js        Renderer — rasterizes every Part into a pixel-grid bitmap, blits
                         it at the current zoom, and draws the checkerboard, bones, mesh
                         heatmap, snap highlight and selection outline on top
www/js/ui.js            DOM wiring: buttons, Scene Parts panel, the export modal
www/js/app.js           Thin entry point that boots ui.js once the page loads
capacitor.config.json   Tells Capacitor the app's name, ID, and where the web files live
android/                The native Android project Capacitor generated (this is what Gradle builds)
package.json            Node project file listing Capacitor and the Filesystem
                         plugin (PSaver writes exports through it) as dependencies
```

You will **not** need to hand-edit anything inside `android/` — Capacitor
manages it for you.

---

## Easiest option: download a pre-built APK, no local setup at all

This repo has a GitHub Actions workflow
(`.github/workflows/build-apk.yml`) that automatically builds the debug
APK in the cloud every time code is pushed to `main` or a `claude/**`
branch. You don't need Node, Android Studio, or anything else installed to
get an installable APK this way — just a browser and your phone.

There are two ways to grab it from GitHub:

1. **Releases page (recommended — stable link).** Go to the repo's
   **Releases** page (right-hand sidebar on GitHub, or
   `https://github.com/<owner>/<repo>/releases`) and open **"Latest Debug
   APK."** Download `Omni_2D.apk` from the Assets list. This release is
   overwritten on every push, so the link never changes — bookmark it and
   it'll always have the newest build.
2. **Actions artifacts (tied to one specific build).** Go to the
   **Actions** tab, click the most recent **Build Android APK** run, and
   download the `omni2d-debug-apk` artifact from the "Artifacts" section
   at the bottom of the run page. Artifacts expire after 30 days and
   require being logged into GitHub to download; the Release above doesn't.

Either way, once the `.apk` file is on your phone, open it with a file
manager and tap **Install** (Android will ask permission to "install
unknown apps" the first time — allow it for that app/source). No cable,
no `adb`, no Android Studio required.

If you want to trigger a fresh build without pushing a new commit, go to
**Actions → Build Android APK → Run workflow**.

> **One-time repo setting, if the release step fails with a permissions
> error:** GitHub sometimes defaults a repo's Actions token to read-only.
> If the workflow fails specifically on the "Publish/update latest debug
> build release" step, go to **Settings → Actions → General → Workflow
> permissions**, select **"Read and write permissions,"** save, then
> re-run the workflow.

The rest of this README covers building the APK yourself locally — useful
once you're actively editing code and want faster iteration than waiting
on a cloud build each time.

---

## Prerequisites (one-time setup on your machine)

Do these once, before you touch the terminal steps below.

1. **Node.js version 22 or newer.**
   Capacitor's CLI requires Node ≥ 22. Check what you have with:
   ```
   node -v
   ```
   If it's older than 22, download the current LTS installer from
   [nodejs.org](https://nodejs.org/) and install it.

2. **Android Studio** (this gives you the Android SDK, an emulator, and a
   JDK all in one installer — you generally do *not* need to install Java
   separately).
   Download it from
   [developer.android.com/studio](https://developer.android.com/studio) and
   run the installer. On first launch it opens a "Setup Wizard" — accept the
   defaults; this downloads the Android SDK (the tools/libraries needed to
   compile an Android app) and a bundled JDK (the Java compiler Gradle uses
   under the hood, currently JDK 17+, which Android Studio installs for
   you).

3. **A phone with USB debugging enabled** (only needed if you want to
   install over USB rather than copying the APK file manually):
   - On your phone, go to **Settings → About phone** and tap **Build
     number** 7 times. This unlocks a hidden **Developer options** menu.
   - Go to **Settings → System → Developer options** and turn on **USB
     debugging**.
   - Plug the phone into your computer with a USB cable. When prompted on
     the phone, tap **Allow** to trust the computer.

That's it for one-time setup. Everything below is repeatable.

---

## Steps to build and install the APK

Run these from the root of this repository (the folder containing
`package.json`).

### (a) Install dependencies

```
npm install
```

**What this does:** downloads Capacitor's command-line tool and libraries
into a `node_modules/` folder. This only touches the JavaScript side of
things — it does not build anything Android-related yet.

### (b) Build the web assets

There is nothing to build yet. `www/index.html` is plain HTML/JS with no
bundler (no Webpack/Vite/etc.) — it *is* the finished web output already.
Once real app code is added in a later step, this is where a `npm run
build` command would compile it into `www/`. For now, skip straight to
step (c).

### (c) Sync the web assets into the Android project

```
npx cap sync android
```

**What this does:** copies everything in `www/` into the native Android
project under `android/app/src/main/assets/public`, and makes sure the
Android project's configuration matches `capacitor.config.json` (app name,
app ID, plugins, etc.). Run this command any time you change a file inside
`www/` and want that change reflected in the Android build. It does **not**
produce an APK by itself — it just prepares the native project.

### (d) Produce a debug APK

You have two options: using Android Studio's UI (easier for a first time),
or the command line (faster once you're comfortable).

#### Option 1 — Android Studio (recommended for your first build)

1. Open **Android Studio**.
2. Choose **Open** and select the `android/` folder inside this repo (not
   the repo root — the `android` subfolder specifically).
3. Wait for the bottom status bar to finish "Gradle sync" (this is Android
   Studio downloading the specific tool versions this project needs and
   indexing the project — it can take several minutes the first time and
   needs an internet connection).
4. Once sync finishes with no red errors, go to the menu **Build → Build
   Bundle(s) / APK(s) → Build APK(s)**.
5. When it finishes, a small popup appears in the bottom-right corner
   saying "APK(s) generated successfully" with a **locate** link — click it
   to open the folder containing the file. It will be at:
   ```
   android/app/build/outputs/apk/debug/app-debug.apk
   ```

#### Option 2 — Command line (`gradlew`)

From the `android/` folder:

```
cd android
./gradlew assembleDebug
```

(On Windows, use `gradlew.bat assembleDebug` instead.)

**What this does:** `gradlew` is the "Gradle wrapper" — a script bundled
with the project that downloads the exact version of Gradle (Android's
build tool) this project needs, then runs it. `assembleDebug` tells Gradle
to compile the Android project into an unsigned, debug-mode APK — debug
APKs are automatically signed with a throwaway debug key so they can be
installed for testing without you needing to create your own signing key
yet.

When it finishes, the APK is at the same path as above:
```
android/app/build/outputs/apk/debug/app-debug.apk
```

### (e) Install the APK on your phone

Pick whichever is easier for you:

**Via USB (using `adb`, which ships with the Android SDK):**

```
adb install android/app/build/outputs/apk/debug/app-debug.apk
```

If `adb` isn't recognized in your terminal, it lives inside the Android SDK
folder Android Studio installed, typically under
`platform-tools/adb` (e.g. `~/Library/Android/sdk/platform-tools/adb` on
macOS, `%LOCALAPPDATA%\Android\Sdk\platform-tools\adb.exe` on Windows). You
can also run it directly from Android Studio: **Run → Run 'app'** with your
phone selected as the target device does the build-and-install in one step.

**Via file transfer (no cable/adb needed):**

1. Copy `app-debug.apk` to your phone (email it to yourself, use a cloud
   drive, USB file transfer, etc.).
2. On your phone, open the file using a file manager app.
3. Android will ask for permission to "install unknown apps" the first
   time — allow it for that one app/source.
4. Tap **Install**.

Once installed, you should see an app named **Omni 2D** in your app
drawer. Opening it should show the black-and-pink app shell described
below — that confirms the entire pipeline works end to end.

---

## The pixel grid: canvas size, zoom, and snapping

Omni 2D is for pixel art, so the canvas is an explicit grid of whole
pixels rather than a free-floating drawing area. **One grid cell is one
pixel of the final artwork.** Nothing in the app can sit between two
cells: imported art is placed on cells, drags move by whole cells,
scaling is by whole multiples, bone endpoints sit on pixel centres, and
even the deformed artwork is snapped back onto cells before it is drawn.

### Choosing the canvas size

On the Home screen, below the Scene Parts panel, a button reads
**Canvas 512 × 512 px** (the default). Tap it to open the size dialog:

- **Presets** — 256 × 256, 512 × 512, 1024 × 1024, 1024 × 3072 (a tall
  sheet), and 3072 × 3072.
- **Custom** — type any width and height. Each side is clamped to the
  allowed range: **at least 8, at most 3072** pixels. (8 × 8 is also the
  smallest image the app accepts, so a canvas can never be too small to
  hold one.)

Tap **Apply** and the grid resizes and re-fits itself on screen. Parts and
bones keep their pixel coordinates when the canvas changes size, so a
character sitting at pixel (200, 200) stays there. Shrink the canvas
below the character and the portion outside the grid is simply not drawn
until you move it back in or enlarge the canvas again — nothing is lost.

**⇄ Mirror** sits below the Width/Height fields, **off by default**. Turn
it on and typing into *either* field copies that exact value — whatever
you actually typed, not a fixed number — into the other, live as you type.
A square canvas then needs entering once instead of twice. Turning it back
off leaves the two fields independent again, unaffected by whatever they
happened to match a moment ago. It has no effect on the preset buttons,
which already set both sides at once.

### What you see

The grid is a **checkerboard of black and dark-grey cells**, one cell per
pixel, drawn *behind* the artwork — transparent pixels show the
checkerboard through them, the way a paint program shows transparency.
**It renders at every zoom level, all the way from the most zoomed-out fit
to the most zoomed-in**, never a flat panel — there is no distance at
which it switches off.

Pixel cells are usually far smaller than a fingertip, so the grid is
zoomable:

- **Two fingers on empty grid, pinch** — zoom in or out around your
  fingers, from the whole canvas down to a handful of cells. Pinch works
  in every mode (Home, Rig, Bind).
- **One finger on empty grid, drag** — pan.
- **⤢ (Fit)** in the top bar — zoom out (or in) to show the whole canvas
  and **re-centre it**, however far you had panned or zoomed beforehand.

When you let go after a pinch, the zoom snaps to a whole number of screen
pixels per cell, so every cell is exactly the same size and the
checkerboard stays even — and one cell is always exactly **one real pixel
of the canvas**, at whatever size that pixel happens to be on screen right
now. Zooming in has a natural ceiling: past a certain point a cell is
already as large as it is useful to make one pixel, and since there is
nothing smaller than a pixel in this grid to zoom into, the camera simply
stops there. Zooming out the other way, a cell can end up smaller than a
single screen pixel — the screen has no way to draw anything finer than
that — so past that point every cell is held at one screen pixel wide
instead of continuing to shrink. The checkerboard stays dense and busy
rather than blank, which is exactly the point: **even zoomed out over a
large canvas, you are still looking at a pixel grid, not a flat colour.**

#### Two bugs this used to have

**Fit used to leave the canvas parked in the top-left corner.** `fit()`
worked out the pan needed to centre the content, then rounded the zoom to
a whole number of screen pixels per cell for crispness — *after* the pan
had already been measured for the un-rounded zoom. Content sized for one
zoom, positioned to centre a different one: the two came apart by however
far the rounding moved, which on a typical phone is a large fraction of
the zoom step, not a stray pixel. Now the zoom is rounded first and the
centring pan is measured from that same final number, so the two can
never disagree.

**The checkerboard used to vanish below a fairly ordinary zoom level.**
It was written to fall back to a flat dark tone once a cell dropped under
3 screen pixels, to dodge a resampling glitch at very small sizes. Taking
that fallback out to make the pattern always render exposed the glitch it
was hiding: below one screen pixel per cell, the checker tile was being
asked to draw itself at a size smaller than a screen pixel, which the
browser then had to resample — and a repeating pattern resampled below
its own resolution beats against the screen's pixel grid instead of
shrinking cleanly, so a checker that should have been a fraction of a
pixel wide came out as a false, unrelated 3-pixel-wide pattern. Past that
point there is nothing smaller than one screen pixel to draw, so the tile
is now simply held at one screen pixel per cell instead of chasing a size
the screen cannot show — dense, but a real, correctly scaled checker
pattern rather than an aliased one.

### What's snapped, and what isn't

| Thing | Stored as | Snapped? |
|---|---|---|
| Part position | top-left corner, whole pixels | yes — drags move by whole cells |
| Part scale | whole-number factor, 1×–16× | yes — a 16 px sprite is 16, 32, 48… px wide, never 20 |
| Part rotation | any angle | no — the angle is continuous; the *drawing* of it is snapped (below) |
| Bone head / tail | pixel centres, e.g. (10.5, 10.5) | yes — a tap lands on the centre of the cell it is in |
| Bone rotation | any angle | no — forward kinematics and spring physics stay continuous |
| Mesh vertices after skinning | whole pixels | yes — snapped at the very last step, before drawing |

Bone endpoints snap to pixel *centres* rather than corners so that "a
bone in a pixel" means exactly that: the readout shows the cell's integer
coordinates (x 11 · y 11 for a head at 10.5, 10.5), and the cell itself
**lights up in pink** while you place or drag a handle, so you can see
where the snap landed before you lift your finger.

### How the artwork is drawn onto the grid

Parts are no longer drawn by the browser as scaled, rotated images (that
puts fractional edges between cells and, on rotation, blends colours).
Instead every Part is **rasterized into a pixel-grid bitmap** by the app's
own small renderer (`www/js/raster.js`):

1. Each Part is a mesh of triangles — the same mesh Bind mode uses; an
   unbound Part is just two triangles covering its rectangle.
2. The triangle corners — after scaling, rotation, and skinning — are
   **snapped to whole pixels**.
3. For every grid cell whose *centre* falls inside a triangle, the
   renderer looks up the one source pixel that maps there (nearest
   neighbour, no blending) and writes it to that cell.
4. Parts are rasterized back-to-front, so a later Part overwrites an
   earlier one — the same z-order behaviour as before.

Step 3 is what rules out the classic failure modes of snapping. Snap each
triangle independently and draw it as a block, and two neighbouring
triangles can leave a one-pixel **gap** between them or **overlap** and
paint a pixel twice. Testing cell centres against the *shared* edges
instead means every cell belongs to exactly one triangle (or none): no
gaps, no overlaps, no cell painted twice — by construction rather than by
tuning. The rasterizer's unit test checks exactly this on adjacent
triangles.

**The tradeoff, stated plainly.** The skinning maths is unchanged and
still continuous; snapping is applied only to its *output*. So:

- A rotated or bent Part is drawn as a **staircase** of whole pixels —
  hard edges, no anti-aliasing, no smeared in-between colours. That is the
  intended pixel-art look.
- Where a bone **stretches** the mesh, some source pixels are **drawn
  twice** side by side; where it **compresses** the mesh, some source
  pixels are **dropped**. That is unavoidable when the output must be
  whole pixels, and it is exactly what happens when you scale pixel art by
  a non-integer factor in any editor.
- Motions smaller than half a pixel produce **no visible change**,
  because nothing crosses a cell boundary. A spring bone's final tiny
  wobbles are therefore invisible; its swing is not.

### Why two-finger gestures changed on the Home screen

This revision makes one deliberate behaviour change to Part 2, because
two features now compete for the same gesture. Part 2 used two fingers
*anywhere* on the canvas to scale and rotate the selected Part; the grid
needs two fingers for zoom. The rule is now decided by **where your first
finger lands**:

- **First finger on a Part** → that Part is selected and dragged; a second
  finger then **scales and rotates the Part**, exactly as in Part 2.
- **First finger on empty grid** → one finger pans; a second finger
  **zooms the grid**.

Lift one finger mid-gesture and it degrades gracefully: a Part transform
goes back to dragging that Part, a zoom goes back to panning. This is the
one place the grid could not be added without touching an existing
interaction; the Part 2 gesture itself is unchanged once it starts. Tip:
on a big canvas a small sprite is tiny at the fitted zoom, so pinch in on
empty grid first, then put your first finger on the sprite.

### Re-verified after the grid revision

The revision touches the model behind Parts 2, 3 and 4, so each earlier
feature was re-tested on the snapped model. The checks are automated
browser tests that drive the real app with touch events on a 64 × 64
canvas (cells large enough to assert on individual screen pixels), plus
unit tests on the maths modules.

**(a) Part 2 — import, drag, scale, rotate: intact.**
- A 16 × 16 PNG imports at 1× on whole-pixel coordinates, centred on the
  grid, and its source pixel (4, 4) lands on exactly the expected cell —
  pixel-for-pixel alignment, no resampling.
- A drag of 2.6 cells right and 1.2 down moves the Part by exactly
  (3, 1) cells, and the artwork moves with it cell-for-cell.
- Pinching the Part to three times the finger spread gives scale exactly
  3, every source pixel becomes an exact 3 × 3 block, and the top-left is
  still on whole pixels.
- Twisting rotates it by about 45°, and the rotated sprite is drawn using
  only the checkerboard's two colours and the sprite's own colours — not a
  single interpolated shade.
- Panning does not move the Part; zooming does not change its scale; Fit
  restores the fitted view. Files that are too small or larger than the
  canvas are rejected and named in the message.

**(b) Part 3 — bone hierarchy and editing: intact.**
- Head and tail taps snap to pixel centres, the tapped cell is highlighted
  in pink, and the readout shows the integer pixel.
- A child added with the root selected attaches to the root's tail, and
  the Skeleton list indents it under its parent.
- Dragging a handle snaps to the cell under the finger; a nudge moves
  exactly one cell.
- Forward kinematics is untouched — the unit test rotating a parent by
  90° still moves the child by exactly 90° — as are rename and delete
  with re-parenting; those code paths did not change.

**(c) Part 4 — auto-weight and painting: intact.**
- A freshly bound Part at rest renders **byte-identical** to the unbound
  sprite (the whole canvas is hashed and compared).
- With a bone rotated, the deformed art is drawn and again contains only
  the sprite's own colours: snapped, never smeared.
- Painting the root bone over the sprite raises the root's total weight
  across the mesh and makes *less* of the art follow the child afterwards
  — painting still decides which bone owns which pixels, and weights still
  sum to 1 (unit-tested).

**(d) Part 5 — physics, now grid-snapped: intact.**
- Kicking the parent with the debug rotation still makes the spring child
  lag tens of degrees behind its target and settle to within 2° — the
  continuous spring maths is untouched.
- In every one of the ~70 frames sampled during the jiggle, the artwork's
  edges lie exactly on cell boundaries, and the art visibly passes through
  many distinct whole-pixel positions on the way to rest.

Two behaviours changed *on purpose* and are worth knowing about:

- **Rig and Bind mode: dragging on empty grid pans.** Parts still cannot
  be moved in these modes (their pixel coordinates do not change), but the
  view does, so the character moves *on screen*. Tap ⤢ to re-fit.
- **Imports are no longer auto-upscaled.** Part 2 scaled small sprites up
  2×–3× so they were easy to grab. On the grid an imported image is placed
  at exactly 1× so that its pixels *are* canvas pixels; zoom in to work on
  it, and pinch the Part if you actually want it larger.

### Known limits

- **Bones may be placed outside the canvas.** The grid extends
  conceptually past its edge, so a root head just off the artwork is
  allowed, and the snap highlight is drawn there too. Artwork outside the
  canvas is not drawn.
- **Big canvases cost memory.** The grid bitmap is width × height × 4
  bytes, held twice (working buffer plus the drawable copy): roughly
  75 MB at 3072 × 3072, 2 MB at 512 × 512. Each redraw re-rasterizes every
  Part, so drawing cost scales with the total sprite area, not the canvas
  size; a big canvas with small sprites is cheap, a canvas-sized sprite
  bound to spring bones is not.
- **A moved Part still needs re-binding**, exactly as in Part 4.

---

## Importing and assembling a character

### Importing PNGs (multi-select)

1. On the Home screen, tap **Import**. This opens your phone's normal
   file picker.
2. **Select as many PNGs as you want in one go** — you don't have to
   import them one at a time. In most Android pickers you long-press the
   first file to enter selection mode, then tap each additional file
   (some pickers instead show checkboxes straight away). Pick
   `head.png`, `hair.png`, `torso.png`, `hand_l.png` and so on together,
   then confirm.
3. Every PNG becomes its own independent **Part**, listed by filename
   (without the `.png`). They are never flattened into one image — each
   piece stays separately movable, which is what lets bones attach to
   individual pieces in the next step.

**PNG only.** JPG and other formats have no transparency, so they can't
carry pixel-art cutouts. If you select any, they're skipped and a message
appears at the top naming which files were ignored — the PNGs in the same
selection still import normally.

Newly imported parts land centred on the canvas, each nudged 8 pixels
down-right from the last so a batch doesn't arrive as one unseparable
stack. Every image is placed at exactly **1×** on whole-pixel coordinates,
so each of its pixels is one canvas cell — nothing is resampled. Two size
rules apply, and any file breaking them is skipped and named in the
message at the top: an image must be **at least 8 × 8**, and it must
**fit within the current canvas** (enlarge the canvas first if it
doesn't).

### Re-assembling layers exported from another app

If you drew your character in another app (ibis Paint, Procreate,
Aseprite…) you can bring it in **layer by layer with every piece already
in place** — no manual repositioning.

The trick is that a layer exported at the *full project size* carries its
own position: the artwork sits where it sat in the original composition
and everything around it is transparent. **That transparent padding is
the position information.** Omni 2D reads it.

**How to use it**

1. In the other app, note your project's pixel size and set Omni 2D's
   canvas to **exactly** that (Home → the `Canvas W × H px` button).
2. Export each layer on its own — hand, head, hair, torso — **at the full
   project size**, not cropped or "trimmed to content". What matters is
   that each PNG is the whole frame with just one layer visible.
3. Import them all at once. Each lands exactly where it belongs, and the
   character is assembled.

A toast confirms it: *"Positioned 3 layers from the transparent
padding."*

**It only triggers on an exact size match — with whatever size your canvas
happens to be.** No size is special or built in here: the app reads the
canvas's current width and height at the moment you import and compares
them with the file's real dimensions. A 64 × 64 canvas auto-positions
64 × 64 files; a 1024 × 3072 canvas auto-positions 1024 × 3072 files. Any
size the app supports (8 × 8 up to 3072 × 3072) behaves the same way.

**If the sizes don't match**, the file is still imported — it just uses
the ordinary placement (centred, then cascaded), and the message tells
you why, naming both real sizes:

> Placed by hand — auto-position needs an exact canvas match:
> hand.png is 64×64, canvas is 512×512

That is deliberate rather than a best guess. Padding only encodes a
position relative to the frame it was exported from; on a differently
sized grid the same padding points somewhere else, so guessing would put
layers in subtly wrong places. Set the canvas to the source project's size
and re-import to get automatic placement.

A canvas-sized PNG that turns out to be **fully transparent** is skipped
with a note, rather than becoming an invisible empty layer.

**What gets stored: trimmed art plus an offset (and why)**

Once the content's bounding box is found, the layer is **trimmed down to
that box**, and the box's position becomes the Part's ordinary x/y
coordinate. The alternative — keeping each layer as a full canvas-sized
image with the artwork somewhere inside it — was rejected because a Part's
`x`/`y` *already is* an offset, so trimming needs no new concept, and
because a full-frame Part would degrade everything built on top of it:

- **Selection and dragging** — a Part's touch area is its image, so a
  full-frame layer would be "hit" anywhere on the canvas. Every layer
  would overlap every other one, and tapping a piece would become
  guesswork.
- **The mesh (Part 4)** — mesh density is spread across the image, so a
  6–10 cell grid stretched over the whole canvas would leave only a couple
  of cells covering the actual hand. Bones would have almost no resolution
  where it matters.
- **Auto-weighting (Part 4)** — vertices out in the empty padding would
  still be weighted to bones and dragged around, deforming nothing while
  costing work every frame.
- **Memory** — every layer would hold a full canvas of pixels: about 37 MB
  each at 3072 × 3072, versus a few KB for the artwork itself.

Trimming keeps all of Parts 2–5 working exactly as they already do: an
auto-positioned layer is an ordinary Part that happens to know where it
belongs. Verified end to end — a trimmed, auto-placed layer selects on its
own artwork, binds, renders byte-identically at rest, and deforms with
clean pixel edges.

### Assembling: drag, scale, rotate

On the canvas (pinch in on empty grid first if the sprite is small):

- **One finger on a part, drag** — moves it in **whole cells**. Touching a
  part also selects it. **The selected part always wins a touch that
  lands on it**, even when newer layers are stacked on top: pick a buried
  layer in the Scene Parts list, then drag on the stack and *that* layer
  moves out from under the others. Touch a spot the selected part doesn't
  cover and the topmost part there is selected and dragged instead.
- **Second finger down while holding a part, pinch** — scales it. Scale
  is always a whole multiple (1×–16×), so the part steps 1× → 2× → 3× as
  you spread your fingers; each source pixel stays an exact n × n block.
- **Second finger down while holding a part, twist** — rotates it. The
  angle itself is free; the drawing is snapped to the grid, so a rotated
  sprite shows a staircase edge rather than a blurred one.
- Two-finger gestures also slide the part around, so you can scale,
  rotate, and reposition in one continuous motion (e.g. sizing hair to
  sit correctly on a head).
- **One finger on empty grid** — pans; **two fingers on empty grid** —
  zooms. **Tap empty space** — deselects.

The selected part is outlined in pink so you always know which piece
you're about to move. See "The pixel grid" above for why the *first*
finger decides between moving the part and moving the view.

### Reordering (which piece draws on top)

Tap a part to select it, and a bar appears above the Scene Parts panel
with the part's name and two buttons:

- **To Front** — draws it above everything else (a hat over hair).
- **To Back** — draws it behind everything else (a body behind clothes).

### The Scene Parts list

Below that is a collapsible **Scene Parts (n)** panel listing every
imported part, topmost first — the same order they stack on the canvas.
**Tap any entry to select that part**, which is much easier than trying
to touch a small piece that's completely hidden behind another one. Tap
the panel header to collapse or expand the list, which gives the canvas
more room while you work.

The selected entry is highlighted in pink to match the outline on the
canvas.

### What persists

The assembled arrangement is kept in memory for the whole session, so
switching to Animate mode and back to Home leaves your character exactly
as you posed it. It is **not** saved to disk yet — closing the app loses
the arrangement. Saving/loading is a later step.

### Suggested test on your phone

1. Tap **Import** and select several pixel-art PNGs at once (throw a JPG
   into the selection too, to confirm it's rejected while the PNGs still
   import).
2. Drag each piece apart so you can see them all.
3. With one finger already on a piece, pinch it bigger: it should jump
   1× → 2× → 3× with blocky edges, never in-between sizes or blur.
4. Twist a piece to rotate it — the edge becomes a pixel staircase.
5. Assemble the character — then use **To Front** / **To Back** to fix
   any piece stacking wrongly.
6. Tap a name in **Scene Parts** and confirm the pink outline jumps to
   that piece on the canvas.
7. Tap **Animate**, then **✕** to come back — your character should still
   be exactly where you left it.
8. To test layer re-assembly: set the canvas to your source project's
   exact size, export two or three layers from that project at full size,
   and import them together — they should snap into their original
   arrangement with no dragging at all.

---

## Building a skeleton (Rig mode)

Rig mode is where you define the character's bones. It's separate from
Animate mode — Animate will *use* the finished skeleton later; Rig mode is
purely for building it.

**Bones don't move the artwork yet.** In this step they're just the
structure being defined. Attaching the pixel art to the bones (mesh
binding / weights) is the next part.

### Entering Rig mode

On the Home screen, tap **Rig** (next to Animate). The canvas border turns
pink, the top bar reads "RIG MODE", and your assembled character is dimmed
slightly so the bright pink bones stay readable on top of it.

**Parts are locked in Rig mode** — the canvas belongs to the bone tool,
so your character's pixel position cannot change here. Dragging on empty
grid **pans the view** and pinching zooms it (tap ⤢ to re-fit). Tap **✕**
to return Home if you need to re-position artwork.

### Placing the root bone

1. Tap **Add Bone**.
2. **Tap once** on the canvas to place the bone's **head** (its origin — a
   small ring marks it).
3. **Tap again** to place the **tail** (the pointed end).

Placement is two taps rather than a drag, because tapping two points is
much more forgiving with a fingertip than dragging a precise line.

Each tap **snaps to the centre of the pixel cell you touched**, and that
cell lights up in pink so you can see where the snap landed; the readout
then reports the bone in whole pixels. Zoom in for precision — at a high
zoom each cell is a comfortable fingertip target. Handle drags snap the
same way, live, with the cell under your finger highlighted as you go.

The first bone you place automatically becomes the **root**.

### Placing child bones

Every bone after the root must be given a parent explicitly:

1. **Select the parent** — tap it on the canvas, or tap its name in the
   Skeleton list.
2. Tap **Add Bone**. (It stays greyed out until a parent is selected, and
   the hint line tells you what it's waiting for.)
3. **Tap where on the parent this bone should start.** Anywhere: partway
   along it, at either end, or a little off it. That point becomes the new
   bone's head.
4. **Tap again** to set the tail.

**A child can start anywhere on its parent, not just at the parent's far
end.** A chest bone belongs on the middle of the torso, not hanging off
the bottom of it, and an arm starts at a shoulder partway down the spine.
Where the child attaches is simply where you tapped, stored as an offset
from the parent, so forward kinematics carries it correctly however the
parent later moves or rotates.

This is independent of how the parent happens to be drawn. "Head" and
"tail" are only labels for a bone's two ends; whether the torso was drawn
top-down or bottom-up makes no difference to where a child may attach.

Each newly placed bone becomes the selected one, so building a chain is
just Add Bone → tap → Add Bone → tap: **root → spine → head → hair**
without reselecting anything in between.

To attach a child somewhere other than the parent's tail, select it and
**drag its head handle** — it stays parented to the same bone, and the
tail stays put while the bone re-aims.

### Reading the skeleton

- **Root bones** draw in the solid accent pink; **child bones** draw in a
  lighter pink, so you can tell hierarchy levels apart at a glance.
- A **dashed line** connects a parent's tail to a child's head whenever
  the child has been dragged away from it.
- The **selected** bone gets a thicker outline plus round **handles** at
  its head and tail — those handles are what you drag.

### The Skeleton list

The collapsible **Skeleton (n)** panel shows the whole tree as an indented
list, root at the top with children nested under their parent. **Tap any
name to select that bone**, which is much easier than trying to touch a
short bone buried under overlapping ones. Tap the panel header to collapse
the list and give the canvas more room.

### Editing a selected bone

Selecting a bone opens an editor above the list:

- **Rename** — type in the name field. Defaults are `Bone_1`, `Bone_2`…,
  but naming them `head_bone`, `hair_bone` and so on pays off quickly once
  you're managing 15+ bones.
- **Readout** — shows the bone's head as a whole-pixel grid coordinate,
  plus its angle and length in pixels.
- **Nudge controls** — `←` `↑` `↓` `→` move the bone by **exactly one
  grid cell** per tap and `↺` `↻` rotate it by 2° per tap, for precision
  that fingertip dragging can't give you.
- **Delete** — see below.

**Rotating a bone rotates all of its descendants with it**, pivoting
around its own head — a real forward-kinematics chain. Rotate the root and
the entire skeleton swings; rotate a forearm and only the hand follows.
This works because each bone stores its position and angle *relative to
its parent* rather than in absolute screen coordinates.

### Deleting a bone (and what happens to its children)

Deleting a bone with no children happens immediately. Deleting one that
**has** children shows a confirmation naming how many children there are
and where they'll end up.

**Children are re-parented onto the deleted bone's own parent — they are
not deleted.** Deleting a shoulder shouldn't silently destroy the whole
arm below it; losing one bone is easy to redo by hand, whereas a
cascade-delete could wipe out a long chain in a single tap. The children
also **keep their exact positions on screen**: their stored coordinates
are recalculated against their new parent so nothing jumps. If you delete
a root, its children simply become roots themselves.

### Suggested test on your phone

1. Import and assemble a character (see the previous section), then tap
   **Rig**.
2. Confirm dragging on empty grid pans the view but leaves the
   character's pixel position alone (⤢ re-fits).
3. **Add Bone**, tap twice to lay a root bone down the character's spine;
   watch each tap light up the cell it snapped to.
4. **Add Bone**, tap once — a child chains off the root's tail. Repeat to
   build root → spine → head → hair.
5. Rename them as you go so the list is readable.
6. Select the **root** and tap `↻` a few times — the entire chain should
   swing around the root's head together.
7. Select a middle bone and **Delete** it; confirm the warning, and check
   its child survives, re-attached and un-moved.
8. Tap **✕** to leave, then **Rig** again — your skeleton should still be
   there.

Like the assembled character, the skeleton lives in memory for the
session only; it isn't saved to disk yet.

---

## Binding artwork to bones (Bind mode)

Rig mode defines *where the bones are*. Bind mode decides *which pixels
each bone moves* — and it's the step that makes bone rotation actually
warp the pixel art.

### Entering Bind mode

Tap **Bind** on the Home screen. You need artwork (Part 2) and a skeleton
(Part 3) first; if there are no bones, the hint line says so.

The panel at the bottom has a **Parts** / **Bones** tab pair. Use the
Parts tab to choose which piece you're working on, and the Bones tab to
choose which bone you're inspecting or painting.

**Show: All layers / Show: Rigged only.** Below the tabs, on the Parts
tab only, a toggle narrows that list to layers at least one bone has
claimed via **Controls layer** (Rig mode) — handy once a character has
enough layers that scrolling past ones you have not rigged yet gets
tedious. It defaults to **off**, deliberately: a layer with *no* bone
attached is still a perfectly legitimate one to bind — auto-weighting
falls back to whichever bones are nearest for it — and that has to stay
reachable, not just possible in principle. The toggle hides itself on the
Bones tab, where there is nothing for it to filter.

### Binding a Part (auto-weighting)

1. On the **Parts** tab, tap the piece you want to bind.
2. Tap **Auto-weight Part**.

That builds a grid mesh over the Part's image, splits it into triangles,
and gives every vertex weights by inverse squared distance to each bone's
line segment, capped at the 3 closest bones and normalized to sum to 1.
Capping matters: letting every bone tug on every vertex produces mush.

**Which bones are candidates is your choice, not the geometry's.** If any
bones name this layer in their **Controls layer** dropdown (Rig mode), then
those are the *only* bones that can weight it, and distance decides nothing
but how the weight is shared between them. Assign one bone and that layer
becomes wholly its own — every vertex at weight 1, immune to anything else
in the rig. Only when no bone claims the layer does auto-weighting fall
back to considering every bone by distance.

That fallback is why the old behaviour looked like a hit-test bug. Layers
overlap constantly — a hand resting on a chest, hair over a face — and pure
proximity would hand a slice of the hand to the chest bone, so rotating the
chest dragged the hand with it. Naming the bone fixes it outright. The Bind
screen's hint line tells you which way you are about to go: it names the
assigned bones, or says it will use whichever are nearest.

The Parts list marks bound pieces as **"— bound"**, and the status line
shows the vertex count.

**Auto-weight never moves the layer.** It used to look as though it did:
drag the character across the canvas in Free Move, come back and re-bind a
layer, and the layer would jump back to roughly where it was imported. The
button was not repositioning anything — the opposite. A bound layer is
drawn at

```
its own stored origin  +  (where its bones are now − where they were at bind time)
```

and Free Move moves the *bones*, deliberately leaving bound layers' own
coordinates alone because the bones already carry them. So after a drag the
layer sits some distance from its own origin, held there entirely by that
second term. Re-binding recaptures the bind pose at wherever the bones are
*now*, which zeroes that term — and the layer fell back onto an origin that
had gone stale hours ago.

Binding now folds that offset into the origin instead of discarding it: the
layer keeps its place on screen to the pixel, and its stored position
finally means what it says again. The fold is measured against the **rest**
pose rather than the simulated one, so re-binding a jiggling spring bone's
layer takes in the settled displacement and lets the spring carry on from
there, rather than freezing a wobble into the layer's coordinates. A first
bind moves nothing at all, since there is no previous bind pose to be
carried away from.

**Nothing should look different yet.** That is the correctness check: a
freshly bound Part renders pixel-for-pixel identically to the flat sprite
until a bone actually moves. (Verified — the bound render is currently
byte-identical to the unbound one at rest.)

**Mesh density** controls how many cells the grid gets along the Part's
longest side. Pixel art wants a coarse mesh, so the default is 6–10 cells
depending on the image's pixel size — a small hand PNG needs far fewer
vertices than a big torso. Moving the slider on an already-bound Part
rebuilds its mesh, **which discards hand-painted weights** and
auto-assigns fresh ones.

### Seeing what a bone controls

Switch to the **Bones** tab and tap a bone. Its influence appears as a
heatmap over the mesh:

- **Bright, large pink dots** — vertices this bone strongly controls.
- **Faint, small dots** — weak influence.
- **No dot at all** — this bone doesn't move that vertex.

### Painting weights by hand

With a Part bound and a bone selected, **drag your finger across the
mesh**. That changes the selected bone's weight on the vertices under the
brush, and every other bone's weight on those same vertices is scaled to
compensate, so each vertex's weights always still sum to 1.

- **Weight tool** — **Paint** raises the selected bone's influence;
  **Erase** lowers it back toward zero. The same brush either way: size,
  falloff and strength mean exactly the same thing for both, and Erase is
  literally the paint delta negated rather than a second code path to keep
  in step.
- **Brush** — the radius of the brush in *screen* pixels, so it feels the
  same at any zoom; zoom in to paint finer detail in grid cells. Influence
  falls off linearly from the centre to the rim.
- **Strength** — how fast each pass pushes weight toward or away from this
  bone.

**Erase used to not exist.** Weight painting only ever added, and the only
way to lower a bone's share was to select a *different* bone and paint
over the same area, letting renormalization take the difference — a
workaround rather than a tool, and no help at all on a layer with a single
bone. Measured before the fix: no control matching "erase" existed
anywhere in Bind mode, the Strength slider was floored at 0.05 so no
negative delta was even expressible, and the one function that writes
weight was only ever called with a positive one.

**The one case worth spelling out.** Redistribution needs somewhere to
redistribute *to*. On a vertex that only one bone influences there is no
other bone to hand the weight to, so the sum-to-1 rule used to put it
straight back at 1 — erasing such a vertex changed nothing at all, however
long you scrubbed. Measured: a stroke that moved shared vertices by 0.1
moved these by exactly 0. Those vertices now let their lone weight decay
and drop the influence at the floor, leaving the vertex unweighted, which
skinning already reads as "stay at rest". The partial values in between
are invisible either way, because skinning renormalizes by whatever total
it finds — verified directly, with the same vertex at weight 1.0 and at
0.6 landing in **exactly** the same place, to a delta of 0.

**Auto-weight Part** doubles as a reset: it throws away all hand-painted
weights for that Part and recomputes the automatic defaults.

### Testing the deformation (temporary debug slider)

Select any bone and use the **Debug: rotate** slider. It drives that
bone's rotation directly so you can watch the skinning work. This control
is scaffolding for this step — real drag-driven animation replaces it
later.

Rotate a bone and the artwork weighted to it warps and follows, with the
pixel art staying hard-edged rather than blurring. Because the skeleton is
a forward-kinematics chain, rotating a parent also swings every child
bone, and the artwork bound to those children comes along too.

### Px Pin: pinning single pixels

Weight painting works at the mesh's resolution; **Px Pin** works at the
pixel's. From Bind mode, **Px Pin — pin single pixels…** opens a dedicated
full-screen window (not the main canvas) for marking individual pixels
that must never deform.

**Entering.** Pick two layers: **Above** is the one you'll pin; **Below**
is drawn underneath purely as reference, so you can line pixels up against
what they sit on. Both appear at their current arrangement.

**Looking.** The window has its own camera: **two fingers** pinch to zoom
(far enough to fill the screen with a handful of pixels) and drag to pan,
and each layer has an opacity slider so you can see through the top one. A
texel grid fades in once cells are big enough to aim at. **This camera is
the window's alone** — zooming to 800%, panning around and leaving again
cannot move, scale or rotate anything; the layers' real transforms are
never touched, only read. (Verified: every part and bone transform, and
the main camera, are byte-identical after a zoom-pin-zoom-exit round
trip.)

**Pinning.** One finger paints. With the **📌 Pin** tool active, press
down and drag: every pixel the finger crosses is pinned as it goes, and a
fast flick still fills in the texels between samples rather than leaving a
dotted trail. Pinning a collar or a scalp band is one stroke, and the
whole stroke is a single undo step. Pinned pixels show a pink marker in
this window (and only here — the main canvas stays clean).

**⌫ Eraser Pin** is a separate, explicitly selected tool, never a hidden
toggle of Pin: with it active, the same drag frees pixels again.

**Brush size.** The third button opens a dropdown of every size from
**1×1 to 10×10** pixels, in the same "⌄" menu style used elsewhere in the
app. The chosen size shows on the button, applies to Pin and Eraser Pin
alike, and stamps a square centred on the touch.

Because one finger paints, the camera belongs to two fingers — and if a
second finger lands mid-stroke, that stroke is *undone* rather than left
behind as a stray pin, since a pinch that started slightly out of sync
should not paint.

**What a pin does.** Pins are stored per layer, in that layer's own pixel
grid — not screen or canvas coordinates — so they stay glued to their
artwork wherever the layer goes. At runtime a pinned pixel is held at its
rest position: bone rotation and spring physics move the artwork around it
and leave it where it was. It is NOT nailed to the canvas — legitimate
whole-layer movement (a Free-Move drag, a rigid or pivot chain carrying
the layer) carries pins along exactly, measured the same way the
auto-weight fix measures carriage: against the rest pose, which physics
never touches. Unpinned pixels on the same layer keep deforming normally.
At rest, a pinned layer renders byte-identically to an unpinned one — a
pin only shows its effect when deformation would have moved that pixel.

Erasing a pin returns the pixel to normal deformable behaviour
immediately. Pins are part of the scene state: they save with the project,
survive Reverse and recovery, and pinning/erasing are ordinary undoable
steps.

### Why pinned pixels used to tear away, and what fixed it

The first version of Px Pin tore: pin a hair layer's scalp band, give the
hair a physics bone, drag the character in Free Move, and the pinned band
came apart from the hair hanging off it — a seam opened straight across
the layer at exactly the pin boundary.

The natural guess is that pinned *vertices* were being overridden without
their neighbours being constrained to stay attached. **That is not what
was happening, and it is worth correcting precisely: there were no pinned
vertices at all.** Pins were a rendering trick, not geometry. The
rasterizer skipped pinned texels, and a *second pass* painted them at
their undeformed position afterwards. The mesh never knew a pin existed.
So the deformation carried the surrounding artwork wherever physics wanted
while those texels were stamped back at rest, and the two simply came
apart. Measured on a hair layer at full swing, the seam reached **80 cells
wide across 49 columns**, and the layer rendered as **three separate
pieces**.

That design also broke the renderer's founding promise — that every scene
pixel is decided exactly once, by one mesh — which is what makes this
rasterizer produce no gaps and no doubled pixels in the first place. A
second pass is by definition a second decision.

**A pin is now a constraint on the mesh.** Every vertex carries a pin
influence between 0 and 1: **1** on pinned artwork, easing to **0** about
one mesh cell away, along a smoothstep so the surface has no crease at
either end. A vertex's final position is that fraction of the way from
where the bones would put it back to where it rests. Pinned regions
therefore hold still, their neighbours are drawn along a *continuous*
surface, and there is one mesh and one raster pass again — so a seam would
have to be a hole inside a triangle, which the rasterizer cannot produce.
Tearing is not fixed here so much as made geometrically impossible.

A pin holds the whole mesh **cell** its pixel sits in. Cell corners are
the only places a mesh can hold anything, so holding the cell is what
makes the pinned pixel itself land exactly on its rest position rather
than somewhere within a fraction of a cell of it. The cost is that the
pixel's immediate neighbours inside that cell come along; raise **Mesh
density** in Bind mode to shrink that neighbourhood.

Measured on the reported scenario — hair layer, physics bone, pins across
the attachment band, dragged in Free Move at up to **92° of spring lag**:

| | Before | After |
|---|---|---|
| Rendered pieces at worst frame | **3** | **1** |
| Pinned band displacement | **27.7 cells** | **0 cells** |
| Free ends still swinging | yes | yes — **47.6 cells** |

One continuous, visually connected piece at every frame of the drag and
after it settles, with the unpinned length still swinging freely.

### How the deformation works

Standard **linear blend skinning**. For each vertex, every influencing
bone proposes a position — take the vertex's rest position, rotate it
about that bone's head by however much the bone has rotated since binding,
then translate to where the bone's head is now. The vertex's final
position is the weighted average of those proposals:

```
deformed = Σ  w_bone × ( R(θ_now − θ_bind) × (rest − head_bind) + head_now )
```

With no bone moved, every term collapses back to the rest position, which
is exactly why a bound Part looks untouched until you rotate something.

That formula is unchanged by the grid revision and still produces
fractional positions. The grid comes in **after** it: each deformed
vertex is rounded to the nearest whole pixel and the triangles are
rasterized cell by cell (see "The pixel grid" above), so the warped
artwork is always a clean arrangement of whole pixels — a staircase, not
a blur — with some source pixels doubled where the mesh stretches and
some dropped where it compresses.

### A caveat worth knowing

Bone bind poses are recorded in world space at the moment you bind. If you
go back to Home and **move a Part after binding it**, its deformation
pivots stay where the bones were at bind time. The Part still drags and
renders normally — but re-tap **Auto-weight Part** to re-establish the
relationship. This is normal rigging-tool behavior: change the model,
re-bind the model.

### Suggested test on your phone

1. Import a Part and build a 2–3 bone chain over it in Rig mode.
2. **Bind** → Parts tab → tap the Part → **Auto-weight Part**. Confirm it
   looks *exactly* as it did before.
3. Bones tab → tap a bone → check the heatmap highlights the region you'd
   expect that bone to own.
4. Drag the **Debug: rotate** slider — the artwork should bend, and the
   pixels should stay crisp and blocky, never blurry.
5. Return the slider to 0, paint that bone over a different area, then
   rotate again — more of the artwork should now follow it.
6. Tap **Auto-weight Part** to reset if the painting goes wrong.

### Performance note

Every redraw rasterizes each Part's triangles into the grid bitmap in
JavaScript, so cost scales with the on-canvas area of the artwork (at 3×
scale a sprite covers nine times the cells). Mesh density barely matters
now — it changes how many triangles cover the same cells, not how many
cells get written. If live animation later feels sluggish, the lever is
smaller or fewer Parts, not a coarser mesh.

---

## How a bone follows its parent

Select a bone in **Rig mode** and the editor asks one question under
**Follows parent**: is this bone **Rigid**, **Physics** or **Pivot**? Three
mutually exclusive answers, so three buttons rather than a switch — an
on/off toggle cannot say *which* of the two "not physics" behaviours a bone
has.

| | What the parent's motion does to it |
|---|---|
| **Rigid** *(default)* | Carried by the parent, and turned by it, instantly. A head on a neck. |
| **Physics** | Same as rigid, but late: a spring lets it trail behind and settle. Hair, cloth, a chest. |
| **Pivot** | Carried by the parent, **never turned by it**. It keeps whatever angle it was given. |

**Position works identically for all three.** A bone is always placed off
its parent by the same stored rest offset, so all three are carried around
by the parent with no drift whatsoever. The entire difference between them
is what happens to their *rotation*.

**Switching type never moves the bone.** A pivot bone stores a world angle
while the other two store an angle relative to the parent, so crossing that
boundary rewrites the stored number to keep the same world rotation it
already had. Without that, a bone hanging under a parent turned 90° would
snap 90° the instant you named it a pivot. Switching to Physics likewise
seeds the spring where the bone already is.

### Pivot

A pivot bone goes where its parent goes and points where *you* point it.
Rotate the parent by any amount and the pivot child's own rotation value
does not change by a thousandth of a degree — but drag the character across
the canvas and it travels exactly as far as everything else.

Its own angle is yours to set, with the same rotate buttons and slider as
any other bone, and it stays where you put it until you move it again.

**Pivot means that and nothing else.** There is no spin rate, no speed, no
rotation derived from how far or how fast the parent moved. It is a general
joint type for anything that should be carried without being turned, not a
wheel, and it carries no content-specific behaviour of any kind — exactly
as generic as Rigid and Physics.

A pivot bone's **own children follow their own rules** relative to it. A
rigid child of a pivot turns with the pivot (and only with the pivot); a
physics child of a pivot springs off the pivot's angle. The chain works
normally — the pivot simply doesn't pass its parent's rotation down into
it. Setting a *root* bone to Pivot is allowed but changes nothing: a root
has no parent whose rotation could reach it.

## Spring physics on a bone

Choosing **Physics** makes a bone *lag* behind its parent's motion,
overshoot slightly, and wobble to a stop — the difference between a head
(which should be rigid) and a ponytail (which shouldn't).

### Turning it on

In **Rig mode**, select a bone and tap **Physics** under *Follows parent*.
Every bone starts **Rigid**, which is the right default — most of a
character should not jiggle.

Switching it on never makes the bone jump: the simulation starts exactly
where the bone already is.

### The three parameters

**Stiffness — how hard it is pulled back toward where it should be.**
Higher snaps back faster and feels tighter; lower feels loose and floaty
and takes longer to catch up.

**Damping — how quickly the wobble dies out.** Higher settles sooner with
less bouncing; lower keeps oscillating and feels jellier. Push it high
enough and the bone glides to its target without overshooting at all.

**Gravity Influence — how strongly the bone is pulled toward hanging
straight down.** At 0 the bone rests exactly where the skeleton says it
should. Above 0 it sags below that, coming to rest wherever the pull and
the spring balance out. Long hair that should hang wants some; a strand
that should stay put wants none.

### Suggested starting points

| Feel | Stiffness | Damping | Gravity |
|---|---|---|---|
| **Hair-like** — light, whippy, doesn't sag | 180–260 | 6–10 | 0 |
| **Cloth-like** — heavier, swings and hangs | 80–140 | 10–16 | 20–40 |
| **Stiff / barely any jiggle** | 400–600 | 25–40 | 0 |
| **Rigid** | *leave physics off* | | |

The defaults (stiffness 180, damping 8, gravity 0) are deliberately in the
hair-like range so the effect is obvious the first time you switch it on,
before you tune anything.

### Testing it by hand

Go to **Animate** and drag — on the canvas, or on the pad below the
buttons if you would rather watch the character than your thumb. The whole
character follows and the spring bones trail behind it (see "Free Move:
moving the character"). The **Debug: rotate** slider is still there in the
bone editor when you want a precise angle rather than a fingertip.

Build a rig where the contrast is visible side by side:

1. Place a **parent** bone.
2. Place a **child** off it, then re-select the parent and place a
   **second child** so the two are siblings, angled apart so you can tell
   them apart.
3. Select **one** child and tap **Physics** under *Follows parent*. Leave
   the other alone.
4. Select the **parent** and swing the **Debug: rotate** slider back and
   forth.

The rigid child snaps to its new position the instant the slider moves.
The physics child trails behind it, swings past, and wobbles to a stop
about a second later. That contrast is the whole feature.

Bind a Part to the skeleton first (Bind mode) and the artwork itself lags
too — the deformed pixel art follows the bone's *simulated* position, not
where the skeleton says it ought to be. On the pixel grid that jiggle is
drawn in whole pixels: the art hops from cell to cell as the bone swings,
and the last sub-pixel wobbles before rest are invisible (the bone still
simulates them; nothing crosses a cell boundary).

### How it works

A textbook damped spring, integrated every frame:

```
angular acceleration = stiffness × (target − current)     spring
                     − damping   × angular velocity       damping
                     + gravity   × cos(current)           gravity
```

Physics never changes *what* the target is — that's still ordinary forward
kinematics from the parent. It only changes how fast the bone is allowed
to get there. The gravity term is the standard pendulum torque: zero when
the bone already points straight down, strongest when it's horizontal.

Chains work too: a spring bone hanging off another spring bone lags
further behind still, which is what makes a long ponytail ripple rather
than swing as one rigid stick.

The simulation runs continuously in its own frame loop, so a bone keeps
settling after the input stops. Once everything has come to rest the loop
sleeps, and any change wakes it again — an idle character costs nothing.

### Where a spring bone settles

**Exactly where it would be with physics off.** The spring changes how a
bone *gets* somewhere, never where that somewhere is. Move the parent and
the bone lags, swings past and wobbles; when it stops, it is back on its
proper position relative to the parent — the same place a rigid bone would
occupy — to within about a twentieth of a pixel. Move the parent back and
it returns to exactly where it started.

The one exception is **Gravity Influence above 0**, which is meant to hold
the bone below its rigid position. That sag is stable: disturb the bone and
it comes back to the same sagged angle, it does not creep further each time.

Two bones hanging off the same parent keep their own separate offsets. Put
one to the left and one to the right and they stay a left one and a right
one through any amount of swinging — they never drift toward each other or
collapse onto the parent.

### The rest pose and the simulated pose

A spring bone has two poses at once, and the difference matters when you
edit a rig while it is moving:

- Its **rest pose** — the position and angle stored relative to its parent.
  This is what you author, and what the bone returns to.
- Its **simulated pose** — where it is drawn at this instant, trailing the
  rest pose while it catches up.

Drawing, tapping and the artwork's deformation all use the *simulated*
pose, so you see and touch the bone where it actually is. Everything that
*records* a pose uses the *rest* pose: creating a bone, dragging a handle,
nudging, deleting a bone (which re-parents its children), and binding a
mesh. That split is deliberate. A stored offset measured against a
swinging parent would have the swing baked into it permanently, and the
bone would then settle somewhere it was never put.

The practical consequence: if you drag a handle while the rig is still
jiggling, you are editing the rest pose, so the bone springs to where you
put it rather than landing there instantly. Wait for it to settle and the
two poses are the same thing.

### Suggested test on your phone

1. Build the two-sibling rig above and enable physics on one child.
2. Swing the parent's Debug slider quickly and let go — watch one child
   snap and the other trail and wobble.
3. Drop **Damping** to ~2 and repeat: it should wobble much longer.
4. Raise **Damping** to ~35: the wobble should almost disappear.
5. Raise **Gravity** to ~40 and watch the bone sag below where the
   skeleton puts it, then hold there.
6. Bind a Part (Bind mode) and repeat — the artwork should lag with the
   bone rather than with the skeleton.
7. With Gravity at 0, swing the parent right round and back to where it
   started: every spring bone should end up exactly where it began, with
   the pixels landing on the same cells as before.

---

## Free Move: moving the character

Tap **Animate**, then drag. Two places work, and they do exactly the same
thing:

- **Anywhere on the canvas.** There is nothing to aim at — no handle, no
  gizmo, no bone to hit. A drag anywhere moves the character.
- **The pad below the buttons.** Same drag, but your finger is nowhere
  near the artwork, so you can throw the character around and actually
  watch it bounce and settle instead of watching your own thumb.

Two fingers pinch to zoom and pan the view; **⤢** re-fits.

### What moves

**All of it.** A drag shifts three things by the same whole number of
grid cells:

- **Every root bone's own position** (a root has no parent, so its stored
  offset *is* its world position). Every root, not one — a rig can have
  several parentless bones, and the others used to stand still while the
  rest of the body walked off.
- **Everything hanging under those roots**, which follows for free.
- **Every layer that is not bound to the skeleton.** A bound layer follows
  its bones through skinning; an unbound one is drawn at its own
  coordinates, so it used to sit pinned in place while the rest of the
  character left without it. Plenty of pieces are meant to be carried
  along exactly as drawn rather than bent or bounced, and this carries
  them.

None of this needs physics switched on anywhere. Physics only decides
whether a piece *trails* as it travels.

### What follows what

Every bone under a root derives its own position from it, every frame:

- **Bones without physics** move in perfect lockstep. Not "very quickly":
  their positions are not simulated at all, they are recomputed from the
  chain every time anything asks where they are, so a rigid bone is never
  even one frame behind the root. Measured across every frame of a drag,
  the deviation is exactly zero.
- **Bones with physics** have their target recomputed from that same
  chain, live, but what gets *drawn* is the spring's own angle trailing
  the target. They lean, swing past, and keep settling for a moment after
  your finger lifts, then come to rest at exactly their own correct
  position relative to the root.

Two spring bones on the same parent stay independent — a left one and a
right one keep their own separate offsets and never drift together.

**A spring bone dragged along its own length barely swings, and that is
correct.** A pendulum shoved straight along the direction it points gets
almost no turning force; push it sideways and it swings properly. So a
bone can look inert for one direction of travel and lively for another.
If a piece never moves *at all*, in any direction, it isn't physics —
it's an unbound layer, which now travels with the character anyway.

### Nothing on screen but the character

Free Move draws no skeleton and no controls over the artwork: no bone
bodies, no handles, no parent links, not even a selection outline on a
layer. The canvas shows the character and the checkerboard, full stop.

### Saved state

Save, Reverse and Discard have moved out of this screen and into the
**≡ menu in the top bar**, where they are reachable from every mode — see
*The ≡ menu* below.

### Sway: how much a bone minds being moved

A spring bone resists having its pivot dragged out from under it, which
is what makes hair swing back when the head moves sideways. The **Sway
when moved** slider in the physics controls sets how strongly:

| Sway | Feel |
|---|---|
| 0 | The bone ignores being carried; only *rotation* of its parent makes it swing. |
| 1 (default) | Natural: a drag pulls it back, a stop lets it overshoot forward. |
| 2–3 | Exaggerated, whippy — good for long loose hair. |

This is the same physics as the Gravity slider, which is a bone's response
to a constant downward pull; Sway is its response to being moved.

### Rig mode is for building, not moving

Dragging in Rig mode does what it did in Part 3: the **handles** on a
selected bone's head and tail author that bone's rest pose, and dragging
empty grid pans. Moving the character lives in Free Move. The **Debug:
rotate** sliders remain in the bone editor for setting a precise angle.

### What it renders through

Every frame of a drag goes through the same pixel-grid pipeline as
everything else: the skinned mesh is snapped to whole pixels and drawn by
the rasterizer. The whole character — every layer — updates live, and the
artwork stays crisp and cell-aligned *during* the drag, not just once it
settles.

---

## Pierce: pushing flesh aside without cutting a hole

A needle pressed into a belly does not cut a hole in it. The belly dents.
**Pierce** is that dent: a piercing layer reshapes a pierced layer's
pixels out of its way, in proportion to how deep it has come, and they
spring back when it withdraws.

It never removes a pixel, never hides one, never makes one transparent and
never punches a hole. There is no second render pass and no stencil. Every
pixel the layer had before contact is still drawn afterwards, through the
same rasterizer, in the same single pass. The only thing that changes is
where some mesh vertices are — the very same lever bone skinning already
pulls — which is why backing the piercer out restores the artwork exactly,
with nothing to undo or restore.

### Piercer and Pierced

**Piercer** is the layer that does the poking. **Pierced** is the layer
that receives it. The second was called *Interactive* until this pass; the
name said nothing about what it did, so it was renamed throughout — every
label, hint, toast, painter caption and internal identifier. A search for
`interactive`, case-insensitive, across `www/js`, `www/index.html` and
`www/css` now returns exactly **two lines**, both in `project.js`: the
comparison that loads the old stored value, and the comment explaining it.

The stored value changed with it, so a project saved before the rename
would have lost its roles on load. It does not: deserialization maps the
old `interactive` onto `PIERCED` on the way in, because the name changed
and what it means did not.

### Roles are chosen, never guessed

Pierce does nothing until you say which layer is which. From a layer row's
**⋮** panel, **◆ Pierce** offers exactly three roles:

| Role | What the layer becomes |
| --- | --- |
| **None** | An ordinary layer. The default, and what every layer starts as. |
| **Piercer** | The thing that goes in — a needle, a horn, a finger. |
| **Pierced** | The thing that gives way. |

Nothing about this is inferred. The app never decides a layer "looks like"
a piercer because of what has been painted on it, how it is shaped, or
where it sits. Free Move, the solver and the painter all read the stored
role and nothing else, so a layer does what you told it to do and keeps
doing that until you change it.

**Choosing Piercer asks for its depths before it will take.** A popup asks
for two numbers, and **cancelling it leaves the role at None** rather than
saving a Piercer that was never finished:

- **Enter Point** — the gap at which contact begins. Further out than
  this, nothing moves at all.
- **End Point** — how much further past that first contact the push keeps
  growing. Reaching it is the maximum; going deeper changes nothing more.

Both are in scene pixels, 1–128, defaulting to 12 and 24. A depth bar in
the popup draws the two marks on one scale with the live contact reading
against them.

### Painting the regions

Which *part* of a piercer is its point, and which part of the pierced
layer can be pierced, are painted — in a dedicated full-screen window
built on exactly the Px Pin pattern, not on the main canvas.

**Looking.** Two fingers pinch to zoom and drag to pan, each layer has its
own opacity slider, and the texel grid fades in once cells are big enough
to aim at. **This camera is the window's alone**: zooming to 800%, panning
around and leaving again cannot move, scale or rotate either layer. Their
real transforms are read, never written.

**Painting.** One finger paints. A **target switch** picks which of the
two you are painting — **Tip** (pink) on the piercer, **Pierceable**
(cyan) on the pierced layer — and separate **Paint** and **Erase**
tools, explicitly selected rather than hidden toggles, add and remove.
Brush sizes run **1×1 to 10×10** in the same "⌄" menu the rest of the app
uses. A stroke fills in the texels between samples rather than leaving a
dotted trail, and the whole stroke is one undo step. If a second finger
lands mid-stroke the stroke is *undone*, since a pinch that started
slightly out of sync should not paint.

Regions are stored per layer in that layer's own pixel grid, so they stay
glued to the artwork wherever the layer goes, and they save with the
project.

### Editing, and getting out again

Everything set at assignment can be changed afterwards. With a role
already assigned, **◆ Pierce** offers **Edit depths** (the same popup,
pre-filled, applying on OK) and **Edit regions** (the same painter,
pre-loaded). Neither re-asks for the role.

**Remove Pierce Role** sets the layer back to None and clears its pierce
data — regions and depths — and nothing else. The artwork, the bones, the
weights, the pins and the layer's place in the stack are untouched.

**Deleting a layer that has a Pierce role warns first**, and says what
will be lost. Pierce works in pairs, so deleting one half leaves the other
half configured for a partner that no longer exists: confirming the delete
therefore also clears the orphaned partner's role, and the warning says so
before you commit.

### Moving the piercer: the Piercer tab in Free Move

Free Move gained a **Body / Piercer** switch, which appears only once some
layer actually holds the Piercer role.

- **Body** drags the whole character as it always did — every root bone,
  everything under them, and every unbound layer — *except* piercers.
- **Piercer** drags only the piercer layers, and nothing else.

They are mutually exclusive **by construction rather than by luck**: the
body drag skips piercers and the piercer drag touches nothing else. A
piercer moved by both would travel twice as far as the finger, and could
never be brought toward the body at all — the body would run away from it
at exactly the same speed.

Meanwhile the pierced layer's own physics keeps running. Its spring
bones swing and settle underneath the contact, and the pierce's shape
change composes with that rather than freezing it.

### How deep is deep

```
gap   = how far the tip still has to travel to reach the pierceable
        pixels, measured ALONG THE PIERCER'S OWN AXIS, and signed:
        negative once the tip is already that far in
depth = clamp(Enter - gap, 0, End)          t = depth / End
```

`t` runs 0 at first touch to 1 at the limit and is the blend between the
region's two drawn shapes, so a tip barely in contact changes the flesh's
shape barely at all.

The axis is read from the artwork: it points from the middle of the whole
piercer layer toward the middle of its painted tip — a needle has its
point at one end of its sprite — so it rotates with the layer and costs
nothing to specify. Only flesh within the tip's own width of that axis
counts as being in the path; flesh off to one side is not something a
needle travelling past it should drive into sideways.

**The sign is the whole reason it is measured along an axis** rather than
as a plain nearest-pixel distance. A nearest-pixel distance cannot go
below zero — two overlapping regions are zero apart and stay zero however
much further the needle is driven in — so depth could never exceed Enter,
and any End beyond it (including the 24 the app offers by default against
an Enter of 12) was simply unreachable.

One consequence is the effect rather than a side effect of it: at the
instant the tip actually touches, the gap is 0 and the depth is already
Enter, so the flesh has retreated *ahead* of the tip. Flesh dents away
from a needle instead of being skewered by it, and Enter is how far ahead
of itself the needle pushes.

**End is a hard limit, and it binds the piercer as well as the shape.**
Capping the depth was only half of it. The contact's *geometry* also stops
advancing past End, so the dent holds at its deepest instead of melting
away — but the piercer's own artwork was still drawn wherever the drag had
got to, and the drag does not stop. A needle driven past End therefore
carried on straight through the layer and came out the other side while
every number sat pinned at End. Measured against a 32 px block: depth held
at 16 the whole way while the tip travelled from 435 px to 720 px down the
screen and crossed the flesh's bottom edge at 590.

So past End the piercer is **drawn short** of where the drag put it, by
exactly the distance the depth refused. Its tip stops where the depth
stopped. Nothing blocks the finger — the layer's real coordinates still
follow it one-for-one, and the contact is still measured from those real
coordinates rather than from where the sprite ended up, so the hold can
never feed back into the measurement that produced it. Only the component
of the motion *along the piercer's axis* stops having a visible effect:
sideways motion still tracks the finger, and pulling back shrinks the hold
to nothing so the piercer catches up with it again.

Verified by driving a needle 100 px past End: `needle.y` travelled 65 →
155 while the rendered tip stayed on the same screen row (435 px) at every
one of those depths, and never reached the flesh's far edge.

Everything that points *at* the piercer follows it there. The selection
outline is drawn around the held position rather than the raw one, and so
is the touch target — otherwise a finger aiming at the needle it can see
would grab the empty grid its coordinates still point at, and the layer
would be stuck where no tap could reach it.

### Which pierceable pixels may actually move

Pierceable answers *can a piercer make contact here*. That is a different
question from *and may this pixel then move*, and the two used to share one
mask — so anything a piercer could touch was also something that gave way.

They are now two independently painted masks on the pierced layer:

| Mask | Decides |
| --- | --- |
| **Pierceable** | where contact is detected at all — the Enter state, the z-order swap, the depth reading |
| **Deformable** | which of those pixels are then allowed to displace |

A pierceable pixel that is *not* deformable registers the contact
completely — the tip still sinks beneath the surface, the depth still
reads, the solver still reports it engaged — and simply does not move. That
is what a firm edge inside soft tissue looks like: bone under flesh, a
buckle under a belt, a fingernail at the end of a finger.

**An unpainted deformable mask means all of it gives way**, which is
exactly how this behaved before the mask existed, so no existing project
changes behaviour by being opened in a build that has it. The mask only
ever takes movement away. The solver intersects it with the pierceable
mask rather than trusting it alone, so a stray mark somewhere that can
never be touched cannot make anything deform.

It is painted in the same window as the others, as one of five targets —
Tip, Pierceable, Deformable, Barrier, Entered — with the same brush and the
same stroke undo.

**On a report that this mask was stored but not respected:** not
reproducible. Traced through the actual deformation path and measured
every way it could be set — the real brush in the painter as well as the
store directly, patches from 6×6 px up to the full region, on a 32 px
layer and a 96 px one, and through a save/load round trip. Displacement
reads the mask in all of them: a sub-region painted where the tip arrives
gives way at 15.0 px, and the same pixels left unpainted hold at 0.000 px
while still registering contact. There is one real limit behind it, and it
is resolution rather than wiring: the mask is expressed through mesh cells,
and a pierced layer that was never bound gets an auto-generated mesh
6–10 cells across whatever its size — 12 px cells on a 96 px layer. A mask
painted finer than a cell still works, but gives way at cell resolution. On the canvas debug overlay it is drawn in amber over the pierceable
cyan, so the split is visible at a glance: cyan is where a pierce
registers, amber is where it actually moves something.

Measured with the deformable mask painted away from where the tip arrives:
the arriving pixels displaced **0.005 px** and rendered at row 431 — their
exact rest position — while the same pixels with the mask painted over
them displaced 15.36 px and rendered at row 371. Contact stayed engaged at
full depth and the z-order swap still fired in both cases.

### Walls: containing the tip sideways

Enter and End constrain how far **in** a piercer goes, along one axis.
They say nothing about sideways, so a tip driven at an angle slid out
through the edge of the pierceable shape and sat in open space beyond it —
a small artifact poking past the region's outline.

**Barrier** is a fourth painted mask on the pierced layer, and its
pixels are solid. While a tip is in contact its contained position is
stopped by them, in any direction, so it stays inside the cavity the
artwork draws.

Two things make that actually hold, and both were wrong in the obvious
first version:

- **The test is swept, not an overlap check.** "Am I inside a wall right
  now" has no memory of which side you came from, so pushing out of the
  *nearest* wall pixel sends a tip that has passed the wall's midline
  further out instead of back. Measured on a 24 px channel: a tip 2 px
  past the wall was pushed to 145.3 — through it and out the far side.
  The contained position now travels from where it was last frame toward
  where the drag has put it and stops at the first blocked sample, so it
  can never end up beyond a wall however fast the drag, and slides along
  one it is pressed against.
- **Engagement is read from the contained position, not the raw one.**
  Otherwise the two undo each other: the wall holds the tip inside while
  the finger carries on outside, the raw reading says nothing is in its
  path, the contact drops — and dropping the contact releases the
  containment. Measured before the fix, the tip sat correctly at 137 until
  the raw needle left the channel, then sprang out to 146, 154, 168.

Pulling back out along the axis is what ends it: the sweep follows a
retreat freely, the gap opens past Enter, and the contact drops for the
ordinary reason.

Measured with walls at a channel's edges and the needle dragged 40 px
sideways: the contained tip reached 137 and stayed at 137 at every step,
never past the wall at 140, while the raw position tracked the finger from
128 to 168 throughout.

### A wall is the pixels that were painted

The first version of Barrier treated a wall pixel as blocking everything
within the **tip's own half-extent** of it. That is a simplification, and
it quietly invented walls nobody painted: two barriers down the sides of a
cavity, each inflated by the tip's spread, meet in the middle of anything
narrower than twice that spread — and the inflation reaches up past the
topmost painted pixel too, roofing over an entrance left wide open.
Measured on a 20 px cavity with a tip of spread 12.3 and **nothing painted
across its front**, entry straight down the middle stalled at depth 9 of
16, stopped by a ceiling that existed only in the collision function. The
same inflation made the test O(radius²) per sample, building a fresh string
key for each — hundreds of thousands of them a frame near a wall.

It is now the honest test. The contained position is a point; it is blocked
exactly when the scene cell it lands in was painted, as one integer-keyed
set lookup. An unpainted direction has nothing in it, so it stays open.

Two details that matter:

- **The contained point is the tip's leading EDGE, not its middle.** On
  anything but a very shallow tip the middle sits well behind the part that
  actually goes in, and a wall running down the side of a cavity starts
  below it — so the middle glides over the wall's top and out the far side
  without ever entering a painted pixel. Measured against walls occupying
  rows 121–144, the middle sat at row 120 the whole way and sailed past.
- **A flat tip's leading edge is a tie.** Every texel across its front is
  the same distance along the axis, and picking any single winner picks a
  corner — a corner of a tip wider than the cavity starts out already
  inside the wall, which blocked entry down a completely open channel. The
  midpoint of the leading edge is the one point that means the same thing
  for a flat tip and a pointed one.

Verified: entering straight down an open front is unheld at every step and
reaches full depth 16; sliding sideways stops dead at the painted wall and
stays there through a 40 px drag; and a frame costs 0.17–0.2 ms with the
drag 800 px past the wall, flat with distance rather than growing.

### Containment holds back; it never pulls forward

Nothing in this feature moves a piercer's own coordinates — the only writes
are the drag itself. What *can* move its artwork is the hold, and a hold
pointing along the approach axis would draw the piercer deeper than the
finger asked: a needle appearing to be sucked in, or to stick when pulled
out. The sweep starts from where the tip was last frame, so a withdrawal
whose path clipped a wall could stop short and leave it deeper than the
drag now wants.

The along-axis component of the hold is therefore clamped to zero or
negative: whatever the walls say sideways, it can only ever lag the drag,
never lead it. Swept across 448 positions with and without walls, the
forward component measures **exactly 0** at every one.

### Physics Direction: which side's movement counts

The gap is a measurement between two painted regions, so it has no opinion
about which of them moved. Measured: flesh sliding onto a parked needle
gives depth 1/11/15 and a push of 0.29/9.58/13.06 px — **byte-identical**
to the needle driven into parked flesh. The reverse direction was never
missing; what was missing was any say in it, and the behaviour shipped as
"Piercer" was in fact "Both".

**Physics** here means the interaction: contact changing the pierced
region's shape and the skeleton's springs settling afterwards — not
parenting. The setting lives on the
piercer beside Enter and End, because like them it describes the
relationship rather than the artwork:

| | |
| --- | --- |
| **Piercer** | only the piercer closing the gap deepens the contact |
| **Pierced** | the reverse — only the pierced layer's own movement does |
| **Both** | either does, which is the symmetric behaviour above |

It works by accounting rather than gating: each frame the excluded side's
contribution to the change in gap is accumulated and added straight back,
so its movement nets out to nothing while the other side's passes through
untouched. **Deepens** is the precise word — whichever side is excluded
keeps the contact it is already in, its depth, its z-order and its springs.
It simply stops being able to push it further. The accumulator is
re-baselined whenever the pair drifts out of range, so it cannot wander
over a long session.

### Setting Enter and End by hand, on the piercer

The depth window still has both numeric fields, and now also draws the
piercer's own artwork with its painted tip tinted and a ruler running out
along the direction that tip points. The two depths sit on that ruler as
handles: **Enter** where contact begins, **End** where the shape change
stops growing.

Neither input owns the value — the Part does, and both are views onto it.
Dragging a handle writes the field; typing in the field moves the handle.
The ruler is planned when the window opens and when a number is typed, but
never mid-drag: a ruler that rescaled itself as the handle moved would
slide out from under the finger holding it.

**Each handle is a place, not a distance.** Enter sits at `enter` along the
ruler and End at `enter + end`, so writing only `enter` when the Enter
handle moved dragged the End handle along with it — End's position is
*derived* from Enter. From the outside that looks exactly like "only the
distance between the two markers is adjustable, never where either one
actually sits", which is what it was. A drag now holds the other handle's
place on the ruler and re-derives both stored numbers from the two
positions: dragging is the input, and Enter and End are what fall out of
it. Measured by finding the handles' own colours on the canvas and dragging
them: moving End 40 px moves End 38.5 px and Enter **0.00 px**; moving
Enter 30 px moves Enter 28.9 px, leaves End at **0.00 px** of drift, and
leaves `enter + end` — End's place on the ruler — unchanged at 48. Aiming a
handle at a spot on the artwork lands it **1.00 px** from the target, and
the field then reads the ruler distance of where it landed.

The handle positions are projected onto the tip's axis rather than assumed
horizontal, so this works for a tip pointing in any direction — and the
whole drawing, sprite and ruler together, is fitted to the canvas. Fitting
only the sprite put the End handle 62 px below the bottom edge of a
480×300 canvas for a needle pointing down, where it could be neither seen
nor dragged.

### Two drawn shapes, not a push

The shape of a pierce is **drawn, not simulated**. A pierceable region has
two outlines: **Rest**, which is the pierceable shape already painted, and
**Entered**, a second shape painted in the same window. What renders at any
moment is a blend between them, and depth chooses the mix:

```
t = depth / End                      0 at first touch, 1 at the limit
shape(k) = rest(k) + t * (entered(k) - rest(k))       for every outline point k
```

That is morph-target interpolation — the same thing a blend shape is
anywhere else — and it is why the result cannot tear. Both outlines are
things a person drew, every intermediate is a straight line between a pair
of drawn points, and there is no force anywhere to overshoot, oscillate or
diverge. At `t = 0.5` the silhouette is the exact midpoint of the two
drawings, measured: **8.92 px** of movement against **17.84 px** at `t = 1`.

**What it replaced, and why.** Until now each vertex near the tip was given
a spring target pushing it away from the contact point, and its offset
sprang toward that target. Every vertex solved its own little problem
independently, so neighbouring vertices could disagree about where the
surface was — which is what produced a jagged, torn-looking silhouette over
a wide area, rather than a shape. No amount of stiffness or damping fixes
that, because it is not a tuning problem: a per-vertex push has no notion
of the outline it is supposed to be making. Two drawn shapes do.

**How the outlines are built.** Both masks are traced by Moore-neighbourhood
border following with Jacob's stopping criterion, resampled to 64 points at
equal arc length — so point *k* means "a quarter of the way round" on both
shapes rather than "the 17th texel somebody happened to paint" — and then
cyclically rotated so the two point lists line up, by the rotation that
minimises the sum of squared distances between centred pairs.

**How the artwork follows the outline.** Every mesh vertex is expressed once,
at bind time, in **mean value coordinates** (Floater, 2003) against the rest
outline: weights that sum to 1 and vary smoothly, computed with the
half-angle tangent identity so they stay stable on thin shapes. Evaluating
the same weights against the blended outline is where the vertex goes.
Because the weights are fixed and the blend is linear, the whole warp is a
linear function of `t`: it cannot fold, and a one-pixel change in depth
never moves a vertex more than **1.115 px**. Measured across a full sweep
from first touch to past the End Point: **zero folds at every depth**, and
no neighbouring pair torn apart.

**Nothing integrates.** `stepPierce()` takes no timestep and always reports
"nothing still moving", because there is nothing to still be moving: a given
depth always looks exactly the same, however it was arrived at, and
withdrawing is the same blend run backwards. Spring bones are untouched —
they still integrate in `physics.js`'s frame loop, and the whole-object
jiggle they produce composes with the blend rather than replacing it.

**Both masks still gate it.** Deformable decides which vertices may move at
all, and Px Pin still wins over everything, exactly as before. Only the
local shape-changing effect at the contact point changed.

### Painting the Entered shape

The painter's fifth target. It draws over the pierceable shape in violet,
so the two read as a before and an after, and the canvas debug overlay
tints the texels the Entered shape *adds* beyond the rest shape — the
question worth answering at a glance being "is what I drew actually
different, and which way does it go?", not "can you fill my region in".

**An unpainted Entered shape is a finished, valid setup**, not a missing
step: the region holds its rest shape at every depth while contact, the
depth reading and the z-order swap all carry on normally. Nothing errors
and nothing warns.

Two things a drawing genuinely cannot be, both caught and both said out
loud in the painter and on the Pierce window rather than silently ignored:

- **Cut into separate pieces.** A channel taken clean through a region
  leaves two shapes, and one closed outline can only be paired with one
  closed outline — blending a whole region toward one of its halves is the
  torn silhouette this feature exists to avoid. Under 90% of the painted
  texels in a single piece, the blend is declined and the region stays at
  rest. A speck of overspray is nowhere near that line (99.5%); a region
  cut in half is (51%).
- **Painted from a region with no single outline of its own.** Same test,
  applied to the pierceable mask.

**One bug found by painting to the edge.** A mask is a flat array of texels,
so column −1 is the previous row's last texel and column `width` is the
next row's first. The boundary walk had no bounds test, so a region painted
right up to the artwork's left or right edge — a band across a whole limb —
wrapped round at the row end and marched off down the image. On a 32-texel
sprite that produced an "outline" **1034 texels wide**, a largest-outline
move of **1020 px** where 17 px was the most anything should have moved, and
a shape change reaching **4962 px** at the far corner of the layer. Bounds
are checked on both axes now, and the same band traces `x 0.5..31.5,
y 0.5..3.5` — exactly the painted rectangle.

### No skeleton required

The blended outline is applied *per vertex*, so a pierced layer needs a
mesh to carry it. Layers used to get a mesh only by being bound to a
skeleton in Bind mode — which meant that unless you had already rigged and bound the
flesh, the whole feature silently did nothing. Nothing in the Pierce UI
ever asked for a rig, and piercing has nothing to do with bones.

It was silent, not broken-looking, which is the worst way for it to fail.
Measured on a two-layer scene with both roles assigned and both regions
painted: the contact read perfectly the whole way in — gap `31 → 7 → -1 →
-7 → -13`, depth rising and capping at End, `engaged` true — while the
displacement sat at **0.000 px at every depth**, because the layer never
reached the solver at all.

(Both bugs in this section belong to the spring displacement that the
blend-shape morph has since replaced; the mesh they needed is still exactly
what the morph writes into, so the fixes still carry.)

The solver now builds the mesh itself, the first time it looks at a
pierceable layer. An unbound mesh has no bind pose and no weights, so
skinning it is the identity: the layer renders exactly as the flat sprite
did, and the pierce offsets are the only thing that ever moves it. Binding
the layer later replaces the mesh as usual. Gaining one is invisible —
every fixture colour renders at an identical pixel count before and after.

**A second bug surfaced once the first was fixed.** A vertex sitting
*exactly* on the tip has no outward direction of its own, so it borrows the
piercer's heading — but the substitute was already a unit vector and was
then normalized a second time by the epsilon standing in for the distance,
multiplying the target by a million. One such vertex drove the layer's
displacement to **1.3 × 10⁷ px** and took the spring with it. Direction and
distance are now kept apart, and the borrowed heading is the piercer's real
axis. The bound path never hit this because no vertex happened to land on
the tip; the unbound mesh puts one there.

### Going in, not lying on top

A 2D stack does not imply depth. A piercer drawn above the flesh it has
entered goes on looking like it is lying *on* the surface however far in
the numbers say it is, because draw order is the only depth cue the scene
bitmap has. So while a tip is actually in contact, it is drawn **beneath**
the layer it has entered and the surface closes over it — the same
information a 3D renderer would take from a depth buffer, taken from the
one place this app actually knows it.

Only the painted **tip** moves. The rest of the piercer — the shaft of a
needle, the finger behind a nail — has not entered anything and stays
exactly where it was in the stack, so the artwork reads as one object going
in rather than the whole sprite ducking under. The split is by *texel*, not
by geometry: both halves are drawn from the same vertices through the same
triangles, differing only in which texels each pass may touch, so they
cannot drift apart or open a seam between them.

The switch is driven by `contact.engaged` — the very same reading the
blend is taken from, published in the same pass. There is one contact test
and both effects read its answer, so the tip cannot sink a frame before the
flesh gives way or stay sunk a frame after it lets go. A
piercer already below its target is left alone; there is nothing to fix.

Making the renderer read that state meant it might need the measurement
before the frame loop has taken its step, which profiling turned into a
useful accident: the contact test was costing **3.1 ms** on a 160-texel tip
against a 1024-texel area, every frame the loop was awake, and all of it
was the fallback used when the piercer is *not* aimed at the flesh — a
plain every-pair nearest-pixel search. It now culls each tip point against
the flesh's bounding box first, which is exact (checked to the last bit
against a brute-force search across 675 placements and rotations) and
brings the same case to **0.48 ms**. A piercer actually aimed at flesh —
the case that matters — measures in **0.005 ms**, so the renderer's extra
look costs nothing worth counting.

Measured at full depth: **648 tip pixels on screen out of contact, 0 in**,
with the shaft unchanged at 2808 pixels either way, and the tip back to all
648 one pixel outside the Enter Point.

### Seeing the painted regions (a testing aid)

Which pixels the app thinks are painted is invisible once the painter is
closed, so *"nothing is happening"* and *"the regions are not where I think
they are"* look identical. **Show painted regions on the canvas**, in the
Pierce window, tints every painted tip pink and every pierceable area cyan
— the painter's own two colours — directly on the artwork, and puts a live
contact reading in the corner of the canvas:

```
P_needle -> P_flesh
  gap -4.0px  enter 12  end 16
  depth 16.0  AT END  tip sunk
```

The gap is reported whether or not it is close enough to do anything, which
is the point: *"the tip is 14 px out and nothing is moving"* has to be
distinguishable from a solver that is not running. The tint rides the
layer's own triangles with the same texel mask as the artwork, so it
follows every deformation exactly, and a sunk tip's tint is occluded
exactly as the tip is. It is off by default, remembered across a reload,
and switching it off restores the artwork to an identical pixel count.

### Force transfer: what a pierce gives back

A pierce used to be entirely one-way. The pierced layer took the shape
change and gave nothing back, so a piercer driven into a character stopped
dead at the End Point against something that never reacted — read as a
picture, a needle hitting a wall rather than entering flesh. This is the
other half of it.

Every engaged contact becomes a **torque** on the bones that drive the
layer being pierced. The contact already knows all three things a torque
needs: where the tip is, which way it is pushing, and how hard. The bone
integrator takes it in the same sum as gravity and the carry torque:

```
press  = t + min(1, overshoot / End)          0 at first touch, capped at 2
moment = (tip - boneHead) x axis  /  boneLength      clamped to ±1
angular acceleration = 45 * press * moment
```

Two things about that are worth stating.

**Past the End Point, the press keeps building.** The tip stops advancing
there — that is what End means, and it is deliberate — but the *drag* does
not, and that leftover travel is the only thing on screen still saying
"harder". So it goes on counting after the depth has stopped counting, up
to one more End Point's worth and no further. Leaning on something is not
the same as resting against it, and this is what makes the difference
visible now that the tip itself cannot move.

**The press is felt up the chain.** It is applied about the head of every
physics bone the layer is attached to *and every bone above them* — a force
on a link is felt at every joint it hangs from. The moment arm is clamped
to one bone length so a contact far off to one side cannot manufacture an
enormous torque out of a modest force.

Nothing models the settling separately, because the spring already is the
settling. The bone leans away under the press, overshoots, comes back, and
holds its pushed position while the press holds; when the piercer withdraws
the torque goes to zero and it springs back to rest. It is a genuine
feedback loop and meant to be — the flesh leaning away opens the gap, which
lowers the depth, which lowers the press — and it converges rather than
oscillating because the loop gain is well under one and the damping absorbs
what is left.

Measured, with a physics bone running across the needle's path:

```
  gap   depth  overshoot  press   bone leans
   20      0        0      0.00     0.00 deg
   11      1        0      0.06     0.46 deg
    4      8        0      0.50     3.51 deg
   -4     16        0      1.00     7.01 deg      <- the End Point
  -12     16        8      1.50    10.50 deg
  -20     16       16      2.00    13.99 deg
  -40     16       36      2.00    13.99 deg      <- capped
```

and the jiggle itself: a peak of 0.1472 rad, settling to 0.1225 rad after
four direction changes, then holding to within 0.000 rad over twenty
frames. Withdrawing releases the press entirely and the bone returns to
**3.0e-4 rad** of where it started.

A steady press does not keep a phone redrawing, which it easily could have:
the frame loop sleeps whenever the spring balances the press, and a press
that CHANGES is what wakes it. Counted: 0 physics steps in 1.2 s out of
contact, 30 in the half second the press lands, then **0 in 1.5 s while the
press is held** — asleep under load, still leaning 0.1216 rad against a
live 21.94 rad/s² — and awake again the moment the piercer withdraws.

**The one case that does nothing, and why.** A bone can only rotate, so a
press exactly along a bone's own axis produces no torque — which is correct
(a rod pushed straight down its length does not turn) but surprising if you
meet it without warning. A needle driven straight down into a bone pointing
straight back up at it leans that bone by 0.01 rad and no more. The remedy
is geometric, not a setting: the reaction comes from the component of the
press *across* the bone, so a bone that runs across the piercer's path — a
torso bone and a needle from the side, which is the ordinary way round —
gets the full effect. The contact readout prints `press NN%` whenever
something is pressing, precisely so that "pressing hard, nothing moving"
can be told apart from "not pressing", since the usual cause is the lever
rather than a missing force.

### Two reported regressions, and what the measurements said

Both were investigated before anything was changed, and the fix in each
case was not the one the symptom suggested.

**"The jagged, torn distortion is back, but only when the body is
dragged."** The proposed cause was that the Physics Direction feature had
been built on the old spring-target displacement and never moved over to
blend-shape morphing, leaving two deformation techniques in two
contact-direction paths. That is not what is there. There is exactly one
deformation path: `publishOcclusion` writes the blended shape for every
pierced layer in the scene, from one contact test that has no opinion about
which side moved. Physics Direction touches only the *gap*, which is a
number, not a technique. No spring-target displacement survives anywhere —
`writeTargets`, the settle thresholds, the velocity arrays and the
stiffness/damping import all went with it.

Measured rather than argued. The body driven onto a parked needle, in
`pierced` and in `both`, against the piercer driven into parked flesh, at
the same three depths:

```
                    gap 11         gap 4          gap -4
  piercer-driven    0.19 px        1.50 px        2.99 px      0 folds
  body-driven       0.19 px        1.50 px        2.99 px      0 folds
```

Identical, to the last measured digit, with the same worst-neighbour gaps
(5.38 / 5.70 / 6.07 px) and no fold at any depth in either. Driven further,
with the character's own spring bone swung 0.11 rad mid-contact so the mesh
is being skinned by a *rotating* bone while the shape is written on top of
it, the silhouette still holds **0 enclosed hole pixels** on screen.

**"The piercer is blocked by the pierced object instead of pushing it."**
The proposed cause was Barrier clamping too broadly and stopping the
piercer's depth advancement. It is not Barrier. The hold on a piercer is
one number — where the drag put the tip against where it is allowed to be —
fed by two separate constraints, so it was split into its along-axis and
across-axis parts and measured with walls painted and with none at all:

```
  gap      no walls             walls down both sides
   11    axial 0  lateral 0     axial 0  lateral 0
    4    axial 0  lateral 0     axial 0  lateral 0
   -4    axial 0  lateral 0     axial 0  lateral 0
  -14    axial 10 lateral 0     axial 10 lateral 0
  -44    axial 40 lateral 0     axial 40 lateral 0
```

Painting walls changes the depth at no point and adds **exactly zero** to
the along-axis hold at every depth. Dragged sideways at full depth they
hold 8 px, then 18 px, without ever touching the depth — which is their
whole job, and all of it.

What halts the piercer is the End Point depth cap, on its own: zero hold
until End, then exactly the overshoot, one pixel per pixel. That is the
behaviour the cap was built to have. What made it *read* as hitting a wall
was that nothing happened on the other side — which is the force transfer
above, and was genuinely missing.

### A one-time tip

The first time a Pierce role is assigned, a dismissible note explains that
Pierce works best alongside Px Pin — pin the parts that should hold their
shape and let the rest give way. It appears once and is remembered.

### Verified end to end

Eleven browser suites and one pure-maths suite cover this, all passing:

- **Setup** (24 checks) — the three roles; the mandatory depth popup;
  cancel leaving the role at None; the painter's isolated camera; stroke
  painting; the brush menu; the one-time tip.
- **Editing** (22 checks) — editing depths and regions after the fact;
  Remove Pierce Role clearing pierce data and only pierce data; the
  delete-layer warning clearing the orphaned partner.
- **Runtime** (27 checks) — the Piercer tab moving the piercer and *only*
  the piercer (`needle +24`, `root 100.5 -> 100.5`) and Body moving the
  character and *only* the character (`root +36`, `needle 60,20 ->
  60,20`); nothing engaging at 1 px outside Enter and engaging at 1 px
  inside it; the shape change rising monotonically with depth
  (`0.19 < 0.93 < 1.87 < 2.99` px); depth and `t` pinned at End from 0 to
  40 px past it, with the shape holding at 2.99 px rather than fading; a
  flood fill of the rendered frame finding **0 enclosed hole pixels** at
  maximum depth; a residual of 0.0000 px after retraction; a pinned band
  at **0.00 px** where an unpinned one moved 2.99 px, rendering at the
  identical row in contact and at rest; and the pierced layer's own spring
  bone still swinging 0.178 rad and settling while a contact is engaged.
- **Visual** (35 checks) — the whole suite run on a scene with **no
  skeleton in it at all**: the flesh taking the drawn shape
  `0.19 → 0.93 → 1.87 → 2.99` px as the tip goes in, capped within 0.5 px
  of End from 0 to 40 px past it, and never diverging; every fixture colour
  at an identical pixel count before and after the layer gains a mesh; the
  tip at 648 rendered pixels out of contact and **0** at full depth, with
  the shaft unchanged at 2808 either way; the z-order accounted for exactly
  against a control with the pierce switched off — the flesh at 24412 px
  with the whole needle on top and 25060 px with the tip sunk, **648 px
  handed back against 648 tip pixels**, so nothing else was lost and no
  hole was punched; the sink and the shape change flipping on the same
  reading one pixel either side of Enter; the overlay tinting the painted
  band to 0 remaining yellow pixels while leaving the unpainted body and
  shaft untouched to the pixel, the readout tracking
  `OUT → IN → AT END / tip sunk` with its blend percentage, and switching
  it off restoring the artwork exactly.
- **Walls as painted pixels** (10 checks) — a 20 px cavity with barriers
  on its left and right only and a tip whose own spread is 12.3 px, the
  geometry that used to seal itself shut: entry straight down the open
  front unheld at every step (0.00 px held) and reaching full depth 16;
  sideways motion stopped dead at the painted wall and staying there
  through a 40 px drag, never onto a painted cell, while the raw drag
  tracked the finger throughout; and a frame at 0.17–0.2 ms with the drag
  40, 200 and 800 px past the wall — flat with distance rather than
  growing.
- **Physics Direction** (12 checks) — in Piercer mode the piercer driven in
  reaches depth 16 while the pierced layer moved onto a parked piercer
  reaches 0; in Pierced mode exactly the reverse; in Both, either side
  reaches 16. Plus the control appearing on a piercer, the choice storing
  and surviving a save/load round trip, the role buttons reading
  None / Piercer / Pierced, and a project written with the pre-rename
  `interactive` value still loading its role.
- **Barrier, deformable and drawn depths** (23 checks) — a needle dragged
  40 px sideways out of a walled channel with its contained tip reaching
  137 and staying at 137 at every step, never past the wall at 140, while
  the raw position tracked the finger 128 → 168 and the artwork stopped
  with it; the same scene without walls following the drag straight out
  past the edge; the depth cap still pinned at End 60 px deeper; a
  pierceable-but-not-deformable area engaging at full depth with the
  z-order swapping while its pixels moved 0.000 px and rendered at their
  rest row, against 8.15 px once painted deformable; all four masks
  surviving a serialize/load round trip; and the drawn Enter/End handles
  writing 26 and 5 into the numeric fields, a typed number moving the
  handle back, and the stored values then driving the clamp — nothing
  engaging outside the drawn Enter, contact beginning 1 px inside it, and
  the depth capping at the drawn End 40 px deeper.
- **Depth cap and deformable mask** (24 checks) — a needle dragged 10, 30,
  60 and 100 px past End with the raw `needle.y` travelling 65 → 155 and
  the overshoot tracking it one px per px, while depth stayed at 16 and the
  rendered tip stayed on screen row 435 at every one of them, never
  reaching the flesh's far edge at 590; the hold releasing the moment the
  drag comes back inside End, and sideways motion past End still tracking
  the finger; contact engaging at full depth and the z-order still swapping
  on a pierceable-but-not-deformable area while those pixels moved
  **0.000 px** and rendered at their exact rest row; the shape change
  returning to 13.52 px once that area is painted deformable; a deformable
  mark on non-pierceable pixels moving nothing; the painter's third target;
  and the mask surviving a serialize/load round trip at 256 px.
- **Blend-shape morphing** (20 checks) — a region with no Entered shape
  painted engaging at full depth while moving **0 px**; with one painted,
  the shape change running `0 → 1.12 → 4.46 → 8.92 → 13.38 → 17.84` px as
  `t` runs `0 → 1`, monotonic, stopping at End and still 17.84 px 30 px
  past it; **zero folds at every one of those depths** and no neighbour
  torn apart (12 px at rest against a worst of 20.27 px in contact);
  `t = 0.5` giving 8.92 px against 17.84 px at `t = 1`, the exact half; a
  one-pixel change of depth never stepping a vertex more than 1.115 px; a
  region painted edge to edge blending 9.17 px with 0 folds; an Entered
  shape cut clean through declined at **0 px** with contact and the z-order
  unaffected and the reason readable; the painter's Entered target naming
  `P_slab · entered shape`; and 964 texels surviving a save/load round trip.
- **Enter/End markers** (23 checks) — both handles found by their own
  colours on the drawing, 77.2 px apart; dragging End 40 px moving End
  38.5 px and Enter **0.00 px**, with the Enter field untouched at 12;
  dragging Enter 30 px moving Enter 28.9 px, leaving End at **0.00 px** of
  drift and `enter + end` unchanged at 48 — against the old behaviour,
  which dragged End 29 px along with it; both handles pulled back the other
  way just as freely; a handle aimed at a spot landing **1.00 px** from it
  with the field reading that spot's ruler distance; typing still moving
  the handle; Confirm storing exactly what the drawing showed
  (`{enter: 9, end: 49}`); and the solver then honouring it — nothing
  engaged outside the placed Enter, depth capping at the placed End.
- **Morph maths** (23 checks, pure Node, no browser) — outlines at the
  requested point count, hugging the painted shape rather than its bounding
  box, evenly spaced to a spread of 0.000; the largest blob winning over a
  stray speck; a shape painted to the artwork's edge tracing inside the
  artwork (`x 0.5..39.5`) instead of running off it, and a small drawn
  change staying a small change (2.83 px); coverage reporting 1 for a whole
  shape, 0.995 with a speck and 0.513 for one cut in half; mean value
  weights summing to 1 and reproducing both interior and exterior points to
  **3e-14**; the halfway blend being the exact midpoint of every
  corresponding pair; and across a full sweep, **0 folds**, no pair
  stretched apart, and a biggest step of 0.151 px.
- **Force transfer and the two reported regressions** (32 checks) — the
  along-axis hold measured with walls painted and with none, identical at
  every depth (`0/0/0/0/0/10/40`) so Barrier adds exactly zero to
  advancement, while still holding 8 px then 18 px sideways without
  touching the depth; a rigged, bound, physics-driven pierced layer leaning
  `0.46 → 3.51 → 7.01 → 10.50 → 13.99 → 13.99` degrees as the press builds
  and then caps; the press reaching a bone the layer is not attached to,
  up the chain, and turning it 0.25 rad; a peak of 0.1472 rad settling to
  0.1225 over four direction changes and then holding to 0.000 rad;
  withdrawal releasing the press to exactly 0 and the bone returning to
  3.0e-4 rad of rest; the body driven onto a parked needle in `pierced`
  and in `both` producing the same shape the piercer produced at the same
  depth, to the last digit, with 0 folds; and the silhouette holding
  **0 enclosed hole pixels** with the spring bone swung 0.11 rad
  mid-contact; and the frame loop counted asleep out of contact (0 steps in
  1.2 s), woken by the press landing (30 steps in 0.5 s), asleep again
  once the press is steady (0 steps in 1.5 s) while still holding 0.1216 rad
  under a live 21.94 rad/s², and woken again by the withdrawal.

---

## Managing layers and bones

### Layer controls

Every row in **Scene Parts** is just a name and a single **⋮** button now.
Tapping **⋮** opens a small panel directly beneath that row — the row
growing downward, not a popup covering the screen — carrying the five
things that used to be four separate buttons crowded into the row itself:

| Control | Where | What it does |
|---|---|---|
| **✏️ Rename** | that row's **⋮** panel | Turns the name into a text field. See *Renaming a layer*, below. |
| **▲ Move up / ▼ Move down** | that row's **⋮** panel | Move the layer one step up or down the stack. Greyed out at the ends. |
| **👁 Hide / 🚫 Show** | that row's **⋮** panel | Hide or show the layer. |
| **🔓 Lock / 🔒 Unlock** | that row's **⋮** panel | Lock or unlock the layer. |
| **To Front / To Back** | selection bar | Jump straight to the top or bottom, as before. |
| **Duplicate** | selection bar | Independent copy of the artwork. |
| **Delete** | selection bar | Remove the layer. |

**Only one row's panel is open at a time.** Tapping **⋮** on a different
row closes whatever was open first — there is never a stack of them piled
up. Tapping the *same* row's button again (it reads **✕** while its panel
is open) closes it, so you are never forced to open a different row just
to dismiss the one you have. The panel deliberately stays open after
Move/Hide/Lock rather than closing itself, so nudging a layer down several
slots, or checking a toggle actually took, doesn't mean reopening the menu
each time — it is anchored to that layer, not that row's position, so it
survives the list reshuffling under it.

**Reordering to any position.** Part 2 could only send a layer all the way
to the front or all the way to the back. **▲ Move up / ▼ Move down** move
it one place at a time, so a layer can be placed anywhere in the stack —
tap twice to lift a hand above the sleeve but keep it under the glove. The
list runs top-of-stack first, so "up" in the list is "closer to the front"
on the canvas.

**Why the Skeleton list (Rig mode) does not have a "⋮" too.** A bone row
already carries exactly one button (show/hide), not several — its
rename/delete/nudge controls live in the single bone editor panel for
whichever bone is selected, a form-style editor rather than a row of
per-item buttons repeated down a list. Consolidating a single always-visible
control behind an extra tap would only add friction for nothing gained, so
that pattern was left as it is.

### Renaming a layer

Imported artwork starts out named after its source file — `9703`, `9704`
— which stops meaning anything the moment you have more than two layers.
Open a row's **⋮** panel and tap **✏️ Rename**: the name becomes an
editable text field, pre-filled and pre-selected so typing straight away
replaces it.

- **Enter**, or tapping away from the field, commits the new name.
- **Escape** cancels and puts the old name back, discarding what you typed.
- A blank name is rejected rather than saved — a layer with no name would
  be unfindable in every list that shows one.

The new name is real data, not a label: it is what the **Controls layer**
dropdown (Rig mode), the Bind Parts list, and every other place a layer
name appears will show from then on, and it is saved with the project.

**Duplicate** copies the artwork, the position, scale and rotation, and
drops the copy on top of the stack named `hand_l_copy` (then `_2`, `_3` if
that name is taken). It gets a **brand-new id** and, deliberately, **none
of the original's rig**: duplicating a layer duplicates artwork, not bone
weights. Bind the copy separately when you want it deformed.

**Hidden layers** stay in the project with all their data — bones, weights,
position — and are simply not drawn. They are also **not touchable**: a tap
where a hidden layer sits passes straight through to whatever is behind it,
because picking something you cannot see is never what you meant.

**Locked layers** can be selected, inspected and re-ordered, but **cannot
be moved, scaled or rotated** on the canvas. Touching a locked layer pans
the view instead, so the canvas still responds normally while the artwork
stays exactly where you put it. Lock a finished background and you can
never nudge it by accident again.

### Deleting a layer that bones are attached to

Deleting a layer with no bones attached happens immediately (and undo
brings it straight back). If bones **are** attached to it, deleting would
orphan them, so the app stops and asks, naming the bones. There are three
answers:

- **Delete layer, keep bones** *(the default, listed first)* — the layer
  goes, the bones stay in the skeleton and become unassigned, ready to
  point at another layer. Nothing about the rig is lost.
- **Delete layer and its bones** — removes both. Deleting a bone also
  re-parents its children (see Part 3), so a branch is not silently wiped.
- **Cancel**.

Keeping the bones is the default on purpose: **losing work should take an
explicit choice**, never a side effect of a different one.

### Which layer a bone controls

A bone is not tied to a layer by guesswork — a bone over a torso might well
be meant to drive the coat in front of it. So the bone editor in Rig mode
has a **Controls layer** dropdown listing every layer plus **Not assigned**,
which is what a new bone starts as.

The assignment is **editable at any time**: select the bone later and pick
a different layer, or clear it back to unassigned. The Skeleton list shows
each bone's assignment inline (`Bone_2  → torso`).

What the assignment does: it **restricts auto-weighting to the bones you
named**, and it is what tells a spring bone whose artwork to jiggle
(see *Spring bones only jiggle the layer they were given*, below). Bind a layer that one or more bones claim, and only those bones get
weight over it — distance then only decides how the weight is split among
them. It also drives the layer-delete warning above, and labels the skeleton
so a 30-bone rig stays readable (`Bone_2  → torso`).

A layer no bone claims is unchanged from Part 4: every bone competes for it
by distance. So existing rigs that never touched this dropdown deform
exactly as they did before. Nothing here alters the deformation maths — the
same linear blend skinning, the same rest-pose capture, the same whole-pixel
snapping. It only changes *which* bones are allowed into the sum.

### Spring bones only jiggle the layer they were given

Switching physics on for a bone says *this piece is loose*. It does not say
*and everything near it is loose too* — but that is what proximity
weighting quietly did. Auto-weighting handed a spring bone a minority share
of every layer around it, and linear blend skinning then dragged that share
along with the spring. Measured on a body/hair/hands/chest rig, one chest
bone owned **24% of the torso layer** and **8% of the hair**.

The result looked exactly like physics leaking onto rigid bones. It wasn't.
The bones were never wrong: through an entire Free-Move drag every rigid
bone stayed **0.00 px** from the root, precisely as a rigid bone should.
Only the *artwork* lagged — the torso trailing 1.7 px and the hair 6.5 px,
rising and falling in an unmistakable spring curve — because a quarter of
it was riding a spring nobody had pointed at it.

So for any layer other than the one it was assigned, skinning reads that
bone at its **rigid transform** — carried by the drag exactly like every
other bone, simply not swinging. The simulation is untouched: the bone
swings as it always did, over exactly the artwork it was assigned.

Reading it rigidly rather than *dropping* it is the whole point, and the
first version got this wrong. Dropping the bone worked until a vertex's
weight sat entirely on spring bones — which is exactly what a layer bound
100% to one bone looks like after that bone is re-pointed at something
else. Then nothing was left to blend, and the renormalizing fallback put
the vertex back at its untouched **import position**. All 42 vertices of a
layer went that way at once, and it sat pinned where it was first imported
while the rest of the character was dragged off: panties riding up to the
chest, a hand left behind in mid-air. Every bone now contributes something,
so that fallback is unreachable.

This is read live from the bone rather than baked into the mesh, which
matters more than it sounds. Weights are never rewritten, so hand-painted
work survives; switching physics off restores the previous look exactly;
and it makes no difference whether you bind first and enable physics after
or the other way round — a bind-order dependence that would otherwise be
impossible to explain to anyone.

**The trade-off, stated plainly:** a spring bone with no layer assigned now
moves no artwork at all. That is the honest consequence of refusing to
guess — proximity is the very signal that proved untrustworthy here. To
keep it from being a silent surprise, switching physics on for an
unassigned bone says so in a toast and points at the dropdown.

### Hiding bones

Each row in the **Skeleton** list has a 👁 toggle. Hiding a bone hides
**its whole branch**: hiding a shoulder takes the entire arm off the
screen rather than leaving its children floating loose. Hidden bones are
not drawn and cannot be tapped on the canvas, which makes a crowded rig
workable while you concentrate on one area.

Hidden bones **keep working**. They still drive the artwork bound to them,
still take part in forward kinematics, and still simulate physics — hiding
is a view setting, not an off switch.

### Bone deletion (unchanged, and re-verified)

Deleting a bone still behaves exactly as Part 3 described: a bone with no
children goes immediately, and a bone **with** children warns first, then
**re-parents them onto the deleted bone's own parent** while keeping their
exact positions on the canvas. This was re-tested against everything added
since — the child ends up under the right parent and does not move by so
much as a fraction of a pixel — and it is now undoable, which restores both
the bone and the original hierarchy.

---

## Recording and GIF export

**Stop opens a preview, not a filename box.** The frames captured during
recording play back on a loop inside the export dialog, at whatever frame
rate is currently selected — so the slider is not a number to guess at,
it is a speed you watch change before committing to it. Save encodes and
writes a real file; Discard throws the recording away.

### What gets captured

Frames come off the **scene bitmap**, not off the canvas the user is
looking at. That buffer holds the character at its own resolution on
transparency — no checkerboard, no grid, no bone handles, no selection
outline — which is exactly what belongs in an exported animation and
nothing that does not. Reading the display canvas instead would bake the
whole editor into the file.

Two limits keep a recording from eating the device, because a 512×512
frame is a megabyte and an uncapped recording at display rate would be
gigabytes within a minute: frames are sampled at **20 Hz** rather than
once per redraw, and there is a hard ceiling of **240 frames** (12
seconds). Hitting the ceiling is said out loud under the preview rather
than silently truncating.

The renderer only draws when something asks it to, so a recording also
drives a frame request every tick. Without that, a still moment would
capture nothing at all and the finished animation would skip over it — a
pause has to record as a pause.

### The encoder

`www/js/gif.js` writes GIF89a directly: palette, LZW, and the block
structure the spec lays out. There is no bundler here and no network at
runtime — the app is plain ES modules served into a WebView — so an npm
GIF library was never an option, and neither was a CDN.

The format suits pixel art especially well. GIF caps at 256 colours,
which is a real constraint for photographs and no constraint at all for
this kind of artwork, so the common case is an **exact palette** with
every colour landing in the file unchanged. Artwork that really does
exceed 255 colours falls back to median cut. One palette slot is spent on
transparency, and frames are written with disposal method 2 so
transparent areas do not keep whatever the previous frame left behind.

**The bug that cost the most to find.** GIF's LZW widens its codes as the
dictionary fills, and the decoder learns each dictionary entry one code
*later* than the encoder creates it — it cannot know an entry's last
symbol until the following code arrives. The two are therefore
permanently one entry out of step. Widening when the encoder's own next
code *reaches* `1 << codeSize` is one code too early, and every code after
that point is read at the wrong width. Chromium rejected the file outright
with "unexpected end of image"; decoding the stream by hand recovered 22
of 32 indices, with the first wrong one exactly where the width diverged.
The encoder widens when its next code *exceeds* `1 << codeSize`, which is
the moment the decoder's own next code reaches it.

### Frame rate

The slider runs 2–30 fps and defaults to 12. GIF measures frame delays in
hundredths of a second, so not every rate is expressible exactly — 12 fps
becomes an 8-centisecond delay, which really plays at 12.5. Where the
requested rate has to be rounded, the line under the preview says what it
will actually play at rather than quietly differing from the number on
the slider.

### Where the file goes

`www/js/filesave.js` writes binary, trying **Downloads** first because
that is where a person looks for something they just exported, then
Documents, then the app's own storage — reporting which one it actually
reached. In a browser (and in the test harness) an anchor download does
the same job. It deliberately does not reach into `psaver.js`, which
already knows how to do the text version of all this: sharing the code
would mean editing a module whose export path is working and verified, to
serve a feature with different needs. The duplicated part is the six lines
that sniff the Capacitor bridge.

### Verified

Two suites, both ending in a real file rather than a passing UI flow:

- **Encoder** (10 checks) — the bytes round-tripped through **Chromium's
  own GIF decoder**, which is the only arbiter that matters since that is
  the class of decoder the file will actually meet. Three frames decode,
  the file is marked as looping forever, every frame carries the delay
  asked for (12 fps → 80000 µs), and every pixel comes back **exactly** —
  worst channel difference 0, zero alpha mismatches — so the palette is
  exact rather than approximate.
- **Export flow** (20 checks) — record a moving scene, confirm 19 frames
  were captured at the scene's own resolution and that they are not all
  the same picture; confirm the preview draws and advances on its own;
  confirm the FPS readout follows the slider (`19 frames · 1.52s at 12
  fps` versus `0.76s at 24 fps`); then Save and catch the actual download:
  **`verify_walk.gif`, 3199 bytes on disk**, GIF89a signature, GIF
  trailer, and decoding back to 19 frames at 64×64, looping forever, at
  the delay 12 fps asks for. Saving also releases the captured frames
  rather than holding a megabyte a frame indefinitely.

## Info buttons: explanations on demand

A small pink **ⓘ** mark, drawn in `icons/icon-info.png` — the same
white-ring-on-pink two-tone as the other custom pixel icons, so it reads as
one more member of that set rather than a different visual language — sits
beside any control whose purpose is not obvious from its label alone.
Tapping it opens a short, plain-language explanation in a popover anchored
near the button: an on-demand footnote, not a permanent fixture competing
with the control for space, and never a full-screen interruption.

**One component, everywhere.** `www/js/info.js` wires the whole feature
once, centrally, with two listeners on `document` — the same pattern the
app menu's own outside-tap-to-close already used. Any button anywhere in
the app becomes an info button by wearing `class="info-btn"
data-info="some-key"`; opening, closing, positioning and dismissing are
identical for every instance, and adding coverage for a new control
anywhere is a one-line HTML addition plus one entry in `info.js`'s lookup
table. Nothing about a screen has to know the feature exists.

**Dismissal, three ways.** Tapping the same icon again closes it, tapping
its own **×** closes it, tapping anywhere else in the app closes it —
including a real action button underneath, which still receives its own
click normally; the popover never blocks or delays it, it only stops
floating on top of it. Escape closes it too. A screen change (leaving a
modal, changing mode) is not special-cased: it is simply one more "tap
elsewhere," so a popover never survives past the screen that opened it.

**Positioning is defensive, not just placed.** Anchored below the button
by default, left-edge aligned to it, and clamped on every side so it never
runs off a phone screen regardless of where the trigger sits; it flips
above when there is no room below. The box's own height is capped at
`min(60vh, 420px)` with internal scrolling past that point — added after a
first draft of the longest topic measured **1000px tall** on an 844px-tall
test viewport and swallowed everything below it, including the button that
opened it. The capped version keeps every popover reachable and every
trigger re-tappable, whatever the screen size.

### Coverage

Eight controls, matching the ones actually confused in testing. Six came
from the priority pass over Pierce and Bind mode; the last two arrived
with the Weight tool and GIF export work that followed, each added by the
one-line route the component was built for.

| Control | Where | Explains |
| --- | --- | --- |
| **Pierce role** | Pierce modal | Piercer vs Pierced, and that a layer is always exactly one, the other, or neither. |
| **Physics direction** | Pierce modal (piercer only) | Piercer / Pierced / Both, as *whose movement* deepens contact — not who is "allowed" to move, since both sides always can. |
| **Depths** | Pierce modal (piercer only) | Enter vs End, adapted from the Enter & End Points dialog's own wording so the two never drift apart. |
| **Paint target** | Pierce painter | All four masks on the pierced layer at once — Pierceable, Deformable, Barrier — plus Rest vs Entered, stating outright that an unpainted Entered shape leaves the region at Rest and does **not** activate morphing on its own. |
| **Follows parent** | Rig mode's bone editor | Rigid / Physics / Pivot, side by side rather than one at a time. |
| **Paint tool** | Px Pin's own window | What a pin does (held exactly at rest, immune to bone rotation and spring physics) and the difference between Pin and Eraser Pin. |
| **Weight tool** | Bind panel | Paint vs Erase sharing one brush, that erasing hands the freed weight to the other bones influencing those vertices so the total stays at 1, and what erasing a vertex's last influence means. |
| **Frame rate** | Export modal | Frames per second as the trade between smoothness and file size, that the preview plays at the chosen rate, and why GIF's hundredths-of-a-second delays mean some rates get rounded. |

Two controls in this same area were deliberately left alone, because they
are already covered by an existing, always-visible explanation and a
second one next to it would be redundant rather than additive: the region
overlay toggle in the Pierce modal (a paragraph directly beneath it already
names every colour), and Bind mode's own weight-painting drag (`bindHint`
already narrates each step contextually — pick a layer, pick a bone,
drag to paint). Both were re-checked rather than assumed still accurate.

**What is not covered, and why:** a general sweep beyond Pierce and Bind
was judged out of scope for that first pass, per the brief's own priority
order. Concretely — Home/Animate mode's controls (Import, Undo/Redo, Fit,
Record, Save) are self-explanatory from their labels, which is the stated
bar for needing one of these at all; there is no user-facing grid-snap
toggle anywhere in the app to attach one to (snapping is automatic, not a
setting); and the canvas-size and Physics param sliders (Stiffness,
Damping, Gravity, Sway) are plausible candidates for a follow-up pass but
were not covered, to keep each pass focused.

### Verified

One suite (`test_info_buttons.mjs`) covers the mechanics and all six
priority instances: opening, toggling closed by re-tapping the same
button, dismissing by tapping outside, dismissing by Escape, switching
cleanly between two different topics, every priority topic's text
containing the specific facts it is meant to teach (Physics Direction
naming Piercer/Pierced/Both by name; Paint target distinguishing
Pierceable/Deformable/Barrier and stating that Entered "won't turn on by
itself"; Px Pin naming Eraser Pin and "rest position"), and the popover
staying on screen rather than clipping off any edge. Full regression
otherwise unchanged. The two later topics are exercised by the suites for
the features they belong to (`test_weight_eraser.mjs` and
`test_gif_export.mjs`), which drive those panels with the info buttons
present.

---

## Undo and redo

The **↶** and **↷** buttons in the top bar undo and redo. They are greyed
out when there is nothing to undo or redo, and their tooltips name the
action (*"Undo Delete layer"*). A toast confirms what was undone.

**What is covered:** importing layers, deleting, moving, scaling and
rotating them, reordering, duplicating, hiding and locking; creating,
moving, rotating, renaming and deleting bones; changing a bone's layer
assignment; toggling and tuning physics; auto-weighting, mesh density
changes, and weight painting; and canvas size changes.

**One action is one step.** A drag across the canvas is a single undo, not
one per frame; so is a whole brush stroke, and a slider dragged from 0° to
40°. Each one snapshots when the gesture starts and commits when it ends.

**How it works.** A standard command-history stack: each action pushes a
record holding the scene state *before* it and *after* it. Undo applies the
before-state and moves the record onto the redo stack; redo applies the
after-state. Doing something new clears the redo branch, as every editor
does. The stack holds the last 60 actions.

The records are **whole-scene snapshots** rather than hand-written inverse
operations, and that is a deliberate choice. The actions needing undo
include auto-weighting a mesh, deleting a bone (which re-parents children
and rewrites their local coordinate frames), and painting weights across
dozens of vertices at once. Writing a correct inverse for each of those is
a large amount of subtle code whose bugs corrupt a project silently. The
usual objection to snapshots — copying the artwork every time — does not
apply here, because pixel buffers never change after import, so every
snapshot shares them. What each record actually holds is a few kilobytes of
numbers.

---

## Saving and loading projects

Work is now kept **on the device**, not just in memory.

### The ≡ menu

Saving, opening and discarding are properties of the *project*, not of
whichever screen you happen to be standing on — so they live in one menu
behind the **≡** button in the **top bar**, open from **Home, Rig, Bind and
Free Move alike**. They used to be split in two: Save/Open sat in the Home
screen's canvas row, and Save-state/Reverse/Discard sat in a row of their
own inside Free Move, so each was unreachable from three of the app's four
screens. Now there is one menu, in one place, always there:

| | |
|---|---|
| **Save project…** | Name it and store it on the device. |
| **Open project…** | Load a saved project, or delete one. |
| **PSaver: Export…** | Write the project out as a file you can copy off the device. |
| **PSaver: Import…** | Read such a file back in. |
| **Save state** | Mark the current arrangement as the one to come back to. |
| **Reverse** | Put the character back to that arrangement. |
| **Discard everything** | Empty the canvas (warns first). |

Tap **≡** again, or anywhere outside the menu, to dismiss it.

### Saving

**≡ → Save project…**. Give the project a name (it offers the current
one, so saving again overwrites the same project) and tap Save. Stored are
**all layers with their artwork, positions, transforms and flags, the full
bone hierarchy with layer assignments and physics settings, every mesh and
its weights, and the canvas size** — everything needed to carry on exactly
where you stopped.

### Opening

**≡ → Open project…** lists every saved project, newest first, with its
last-modified date. Tap one to load it; 🗑 deletes it. Loading **replaces**
what is on the canvas and starts a fresh undo timeline, since undoing back
into a different project's edits would be meaningless.

### Saved state: Save state, Reverse, Discard

Separate from named projects, and aimed at one thing: getting back to an
arrangement you liked.

- **Save state** — marks the current arrangement as the one to come back
  to. It asks first, so a mispress costs nothing.
- **Reverse** — puts the character back to that saved arrangement. It is
  available immediately after importing without saving anything, because
  **the moment you import artwork is captured automatically** — so
  Reverse means "how it was when I uploaded it" until you save something
  you prefer.
- **Discard everything** — removes every layer and every bone, leaving an
  empty canvas. It warns first, and it does not touch your saved projects.

All three are ordinary undoable actions, so **↶** takes back a Reverse or
a Discard. The saved state is stored on the device alongside the
auto-save, so it survives closing the app.

### Auto-save and crash recovery

Alongside your named saves the app keeps one **recovery slot** of its own.
It is written a few seconds after any change settles, every two minutes
while there is unsaved work, and whenever the app is backgrounded — the
moment before a phone is most likely to kill it. Importing or deleting a
layer writes it immediately, those being the most expensive things to lose.

The recovery slot is **separate from your named saves and never overwrites
them**. On the next launch, if it holds work **newer than your newest
manual save**, the app offers to restore it, naming the project and the
time. **Restore** brings it back; **Discard** throws it away. A manual save
clears the slot, so you are not asked about work you already saved.

### Where it is stored

IndexedDB on the device, rather than `localStorage`: pixel data is binary
and would have to be base64-encoded to fit in `localStorage`, inflating it
by a third against a quota of a few megabytes that a single large layer
could exhaust.

Projects live in the app's own storage, so **uninstalling the app removes
them**, and there is no cloud copy. That is what **PSaver** is for.

---

## PSaver: projects as files

### What it is for

A saved project lives inside the app. Uninstall Omni 2D — or update it in
a way that clears its data, or tap "Clear storage" in Android's app
settings — and every saved project goes with it, and the character has to
be rebuilt layer by layer, bone by bone. There is no cloud account behind
this app to fall back on.

**PSaver writes the project out as an ordinary file**: something you can
see in the Files app, copy to a PC over USB, e-mail to yourself, or drop
in Drive or Dropbox. Reinstall the app, import the file, and the character
is back exactly as it was.

The rule of thumb: **Save project…** is for "I am coming back to this
tomorrow". **PSaver: Export…** is for "I do not want to lose this,
whatever happens to the app."

### Exporting

**≡ → PSaver: Export…**, name the file (it offers the current project's
name, the same way the Save and GIF-export prompts do), and tap **Export**.
Leave the field blank and it uses the placeholder, exactly as the GIF
prompt does. Path characters are stripped from whatever you type, and so
is a leading dot — on Android a leading dot makes a file **hidden**, and
an export nobody can find in their file manager is the precise failure
PSaver exists to prevent.

The file is written into a **`Omni2D` folder inside your device's shared
`Documents`** — a location you can reach from the Files app or from a
computer, and, crucially, one Android **keeps when the app is
uninstalled**. A screen then tells you the file name, its size and the
full path it landed on, so you know where to go and look. On a device that
refuses shared storage, the export falls back to the app's own external
folder and says so in plain words, including the warning that *that*
folder is deleted on uninstall and the file needs moving now.

What goes in is everything: **every layer with its image data, position,
scale, rotation, stacking order and flags; the whole bone hierarchy with
each bone's relationship type — rigid, physics or pivot — and its
parameters; every mesh with every painted weight and bind pose; every Px
Pin pinned pixel; and the canvas size.**

### Importing

**≡ → PSaver: Import…** opens the device's file picker filtered to PSaver
files. Pick one and it becomes the project on screen — visible on canvas,
editable in Rig, Bind and Free Move immediately, exactly as if it had been
opened from an internal save. Import **replaces** what is on the canvas and
starts a fresh undo timeline, for the same reason opening a saved project
does.

An imported project is not yet *saved* on the device — use **Save
project…** afterwards if you want it in the app's own list too.

### The file

`yourname.omni2d.json`, and it is exactly what it looks like: JSON.

The contents are **the same data structure the internal save already
uses** — `serializeProject()`'s output, the one shared by Save/Open and by
undo/redo — wrapped in a small header naming the app and the file-format
version. There is no second format to drift out of step with the first: a
field added to the serializer travels in an export automatically.

The one difference is layer pixels. IndexedDB stores a `Uint8ClampedArray`
natively; JSON has no such type, so on the way out each layer's pixel
buffer becomes base64 and on the way in it becomes a typed array again.
That single conversion is the whole gap between a file and an internal
save, and it is why an export is roughly a third larger than the raw
artwork.

**Why the double extension.** The file really is JSON, so Android's file
picker recognises it by MIME type and will actually offer it for
selection. A made-up extension carries no MIME type at all, and on the
devices that *do* honour the picker's filter it would leave your own
export greyed out and unpickable. The `omni2d` half still names the app
for anyone browsing a folder.

### When a file is not a PSaver file

Every check runs **before the scene is touched**, so a rejected file
leaves whatever you were working on exactly as it was — half-loading a
corrupt project over a good one would be worse than not loading at all.
A message says what is wrong, in these words:

| What you picked | What it says |
|---|---|
| Something that isn't text data | *That file is not a PSaver project — it is not even readable as text data.* |
| JSON, but from something else | *That file is not a PSaver project — it is missing the Omni 2D marker.* |
| An export from a newer Omni 2D | *That project was exported by a newer version of Omni 2D (file format N, this build reads up to 1).* |
| A PSaver file missing its layers or bones | *That PSaver file is damaged — its layer list is missing.* |
| A PSaver file cut short mid-download | *That PSaver file is truncated — Layer "X" should hold N bytes of image data but has M.* |
| A PSaver file whose bones lost their positions | *That PSaver file is damaged — bone "hair" has no position.* |
| An empty file | *That file is empty.* |

The truncation check is the sharp one: RGBA means exactly four bytes per
pixel, so a file that was cut short in transit is caught by arithmetic
rather than by a torn layer appearing on the canvas.

### Verified end to end

A character was built with three layers, all three bone relationship types
(rigid root, physics child, pivot child, with a non-default spring
stiffness), auto-weighted meshes on two layers and 64 pinned pixels on a
third, on a 112 × 96 canvas. It was exported, and then **every trace of it
was removed from the app** — every saved project deleted, the auto-save and
restore slots cleared, and the page reloaded so the app booted with nothing
of its own to find, which is what a reinstall leaves. The exported file was
then imported through the file picker.

Restored identically: every layer's pixels (byte-for-byte hash), position,
scale, rotation, visibility and lock; the stacking order; all three joint
types with their parameters; every mesh weight, rest position and bind
pose; every pinned pixel; and the canvas size. The imported character then
opened in Rig mode with its skeleton intact, showed its physics and pivot
bones as such in the editor, and dragged in Free Move.

The one thing that does **not** come back byte-identical is the absolute
`zIndex` numbers, which any load renumbers to a dense 0…n−1 while keeping
the order — and the test proves that by saving and re-opening through the
app's *internal* Save/Open and getting the same renumbering. An import is
exactly as faithful as the app's own Open, which is the point: it goes
through the same `applyProject()` code path.

---

## App states & how to navigate (manual test flow)

Import and part assembly are real (see the section above), and so is
recording and GIF export. What is still missing on this path is
drag-driven *posing* — you can record whatever the scene does (physics
settling, a pierce, the debug sliders), but not yet pose bones by dragging
them on the canvas.

There are five app states:

1. **Home** — the starting screen, and where you assemble the character.
   Shows the canvas with an **Import** button top-left and the **Bind**,
   **Rig** and **Animate** buttons across the bottom, plus the Scene Parts
   panel once anything is imported.
   - Tapping **Import** opens the file picker (see above).
   - Tapping **Rig** moves you into Rig mode (see above) — a separate
     branch from Animate; **✕** brings you back Home.
   - Tapping **Bind** moves you into Bind mode (see above), also a
     separate branch; **✕** brings you back Home.
   - Tapping **Animate** moves you into Animate mode →
2. **Animating** — Animate mode, before recording starts. The canvas gets
   a pink border, and an "ANIMATE MODE" label appears top-right. Controls
   change to an **✕** (exit), **Start**, and a greyed-out, disabled
   **Stop**.
   - Tapping **✕** exits back to **Home**.
   - Tapping **Start** begins "recording" →
3. **Recording** — after Start is pressed. The canvas border and mode
   label turn red, the label reads "RECORDING...", **Start** becomes
   disabled/greyed, and **Stop** becomes the active button.
   - Tapping **✕** here cancels the recording (logs a message) and exits
     straight back to **Home**.
   - Tapping **Stop** ends the recording, returns you to the
     **Animating** state, and automatically opens the **Export modal**.

**Export modal** (appears automatically after Stop, not its own button):
a **looping preview** of what was just recorded, a **frames per second**
slider, a filename field (defaults to `animation_01` if left blank),
**Save as GIF**, **Save as MP4**, and a red **Discard**. Save as GIF
encodes and writes a real file; Save as MP4 is not built and says so
rather than pretending. Closing the modal either way leaves you in the
**Animating** state, ready to Start another recording.

A quick end-to-end pass to try on your phone: **Home → Animate → Start →
Stop → (export modal appears) → Save as GIF → back in Animate mode →
✕ → Home**. Also worth checking: tapping **✕** while **Recording** should
cancel straight back to Home, and disabled buttons (**Stop** on the
Animating screen, **Start** on the Recording screen) should be visibly
greyed out and not respond to taps.

---

## Visual identity: pixel fonts, pixel icons, pixel borders, a layered palette

A polish pass across the whole app's chrome — not a rendering or logic
change. Nothing here touches a bone, a mesh, a pixel of imported artwork,
or any data structure; it only restyles the buttons, panels, dialogs and
text drawn around them.

### Pixel fonts, and why there are two of them

Every piece of UI text now renders in a genuine pixel font instead of the
system sans-serif — buttons, headers, dialogs, the Scene Parts and
Skeleton lists, hints, everything. Two fonts, though, not one, both
vendored locally as `.woff2` files in `www/fonts/` (OFL-licensed, no CDN
— this app has to work with no network at all):

- **Press Start 2P** — a true 8×8-grid arcade font, used ONLY for modal
  titles (`.modal__title`, e.g. "Save Project", "Restore unsaved work?").
  Its glyphs each advance a full 1em, so a sentence set in it is roughly
  2.5× wider than the same sentence in an ordinary font — fine for a
  handful of words, but "Restore unsaved work?" at a readable size would
  not fit a phone screen if it were used everywhere.
- **VT323** — also genuinely pixel-drawn, but a normal ~0.4em advance per
  glyph, the same ballpark as an ordinary condensed font. Used for
  everything else: every button, every list row, every hint and every
  paragraph of dialog text. It is a fixed-width terminal font, which is
  also why it now does double duty as the PSaver export-path readout that
  used to sit in a separate system-monospace face — one pixel-font system
  instead of two unrelated ones.

Three fixed sizes, not text freely scaled to whatever fit each element
before: **16px** (Press Start 2P, headers only), **20px** (VT323, buttons
and primary list-row titles), **18px** (VT323, paragraph/dialog text and
most labels) — plus a **16px** VT323 tier reused for the smallest hints
and tags. Pixel fonts drawn as vector outlines only look genuinely crisp
with smoothing switched off, so `-webkit-font-smoothing: none` and
`font-smooth: never` are set globally, and `font-synthesis: none`
stops the browser from fake-bolding either face (neither ships a bold
weight — a synthetic one would smear the outline, undoing the crispness).

**Icon-only glyphs are the deliberate exception.** Neither font contains
the arrows and dingbats used as compact icon buttons throughout the
app — fit `⤢`, undo/redo `↺ ↻`, nudge arrows, chevrons, the rotating
flower mark, the move-pad's `✥`. Rather than let each one silently fall
back to whatever font the browser picks per missing glyph, `.btn--icon`,
`.btn--nudge`, `.row-btn`, `.scene-panel__chevron`, `.move-pad__glyph` and
the flower marks explicitly keep the original system font stack. They
were plain, colourless glyph icons before this pass and still are —
nothing about them needed to become "pixel text".

### What "8×8" actually means for each of these fonts

The type looked compressed and uneven rather than crisply blocky. Measured
rather than guessed, by taking the gcd of every glyph coordinate in each
vendored file:

| Font | gcd of glyph coords | What that means |
| --- | --- | --- |
| Press Start 2P | **125** of a 1000-unit em | a true 1/8 em grid — a real pixel font |
| VT323 | **1** | not on a grid at all |

So Press Start 2P is crisp at multiples of **8px**, where one design pixel
is a whole number of CSS pixels. It was already 16px, and stays there.

**VT323 is not a pixel font.** It is a vector face styled to look like a
terminal font, with outlines on arbitrary coordinates — which is exactly
why it reads as uneven beside the other one. No font size can fix that,
and rounding it to a multiple of 8 would only make it worse: its advance is
0.4em, so 16px gives a 6.4px cell where 20px gives a clean 8px one.

What *can* be made exact is its cell. Every advance is 0.4em, so a size
that is a multiple of 5 puts each glyph cell on a whole CSS pixel and stops
the glyph-to-glyph rhythm drifting. Body went 18px → **20px** (8px cell)
and labels 16px → **15px** (6px cell); buttons were already 20px.

Tracking was em-based, which undid the same thing from the other end:
0.05em of 15px is 0.75px, so the second glyph landed three quarters of a
pixel along, the third one and a half, and every glyph after the first
somewhere different within the pixel. All nine declarations are now `1px`.

Checked for non-uniform scaling while there: there is no `transform:
scale()`, no `scaleX`/`scaleY` and no `font-stretch` anywhere in the
stylesheet, so nothing is being squeezed in one axis. The remaining
one-off sizes (10, 14, 16, 18, 20, 34px) are all on `--font-fallback` or
`--font-mono` — the system stack used for arrows, chevrons and the flower,
which neither pixel font ships glyphs for — and are deliberately outside
this rule.

Full compliance for body text would mean replacing VT323 with a genuinely
grid-drawn face at a similar advance. That is a font-licensing and
vendoring decision rather than a code change, so it is flagged rather than
done.

### Custom pixel-art icons, replacing every actual emoji

Before touching anything, every character in the app that is a genuine
colour emoji — a pictograph the OS renders from its own emoji font,
immune to CSS `color` — was inventoried. There were exactly **seven**,
all in the layer-management list and the Px Pin tool:

| Emoji | Meant | Where |
|---|---|---|
| ✏️ | Rename | Layer row's "⋮" menu |
| 👁 | Show (visible) | Layer row's "⋮" menu, bone list |
| 🚫 | Hide (hidden) | Layer row's "⋮" menu, bone list |
| 🔒 | Locked | Layer row's "⋮" menu |
| 🔓 | Unlocked | Layer row's "⋮" menu |
| 🗑 | Delete project | Open Project list |
| 📌 | Pin tool | Px Pin's tool picker |

All seven are now custom-drawn 16×16 pixel-art PNGs in `www/icons/`,
rendered through `image-rendering: pixelated` — the exact nearest-neighbour
rule already used for imported character art, so an icon and a piece of
actual artwork are drawn by the same rule. `appendGlyph()` in `ui.js` is
the one place that knows the mapping; every call site that used to write
an emoji character now goes through it, so a button ends up with a small
`<img class="pixel-icon">` for these seven and plain text for everything
else. **Nothing else was touched.** The app's other icon-like characters
(`✕ ⋮ ▲ ▼ ⌄ ⌫ ⇄ ↺ ↻ ⤢ ✿`, the mirror toggle, the eraser tool, the move-pad
mark) are ordinary Unicode symbols, not emoji — they already rendered as
flat, colourless glyphs before this pass, so there was nothing to replace
there, and no new icon was invented that was not already present.

### Pixel-stepped borders, everywhere a box has one

Every bordered box in the app — buttons, list rows, panels, dropdowns,
dialogs, the layer and Px Pin brush-size popovers, the canvas viewport
itself — used to have a smoothly rounded corner (`border-radius`). All of
them now cut a hard, stair-stepped notch instead, via `clip-path`, the
same shape at two sizes:

```
--pixel-clip     a 2-step, 4px-reach notch: buttons, inputs, list rows,
                 chips, small popovers
--pixel-clip-lg  a 2-step, 6px-reach notch: modals, the app menu, the
                 layer/Px Pin popovers, the canvas viewport, the move pad
```

Both are declared once as CSS custom properties and referenced by every
bordered element, so a compact 38px icon button and a 360px-wide modal
cut their corners with the exact same motif — `clip-path`'s
`calc(100% - Npx)` points work at any box size, so one definition serves
both without per-element tuning. The treatment applies uniformly
regardless of border colour: pink accent borders and the app's other
(red, not literally orange — see below) destructive/cancel borders get
identical stepped corners.

One real interaction this surfaced: `clip-path` clips a box's `box-shadow`
along with everything else, since a shadow drawn outside the clipped
region is cut off with it. Every soft shadow or focus glow in the app
(the modal lift, the kebab-popover glow, the recording-mode ring, the
text-input focus glow) is now `filter: drop-shadow(...)` instead, which is
computed from the element's actual rendered — already pixel-clipped —
shape rather than its rectangular geometry, so the glow follows the
stepped outline instead of fighting it.

*A note on "orange":* the app has no separate orange accent. Its two
accent colours are the pink `--color-accent` and a system red
`--color-danger` (`#F44336`), used identically for every destructive or
cancel action (Discard, the recovery dialog's Discard button, Delete). The
pixel-border treatment applies the same way to both; only the pink/red
distinction the app already had is preserved.

### The rotating flower

The small pixel-flower mark (✿) on primary buttons and dialog CTAs now
rotates continuously — one slow 360° turn every 10 seconds, linear, so it
reads as gentle ambient motion rather than a spinner. It is one CSS
keyframe animation shared by every instance: the two flowers glued to
`.btn--flourish` buttons via `::before`/`::after` and the four explicit
corner flowers on the Animate button. Anywhere a flourish already
appeared — which includes every flourish-bearing dialog CTA (Restore,
Save, Export, Apply, Open...) — it now turns; none were added where they
were not already present. `prefers-reduced-motion: reduce` turns the
animation off for anyone who has asked their device for less motion.

### A layered dark palette, not flat black

The old background was pure `#000000`. It is now:

```
--color-bg:      #181117   base background
--color-surface: #2A1E28   elevated surface (buttons, panels, dialogs, popovers)
```

Both are a very dark charcoal with a warm plum undertone — chosen with
red ≥ blue in the RGB values specifically so the background reads as
related to the pink accent rather than neutral or blue-leaning. (Checked,
not eyeballed: `--color-bg` keeps an 18.6:1 contrast ratio against white
text and 5.4:1 against the pink accent, both comfortably past WCAG AA.)

`--color-surface` is one deliberate step lighter, same family, and is
where every raised UI surface now renders instead of the base colour:
button fills, the Scene Parts and Skeleton list rows, the app menu and
every kebab-style popover, modal dialogs, text inputs, toasts. The
canvas viewport and the full-bleed page background are the two things
that stay at base `--color-bg` — they are the "floor" everything else
sits on, not a raised surface themselves. Kebab-style popovers (the app
menu, a layer row's "⋮" panel, the Px Pin brush menu) and modal dialogs
additionally carry a faint `filter: drop-shadow` glow underneath them, to
read as sitting slightly off the surface below rather than flush with it
— subtle by design, not a heavy card shadow.

The pink accent (`--color-accent`) and the red danger colour
(`--color-danger`) are unchanged in hue throughout; only the background
and surface colours, and the border shape, moved.

---

## What's next

With artwork bound to a working skeleton and GIF export producing real
files, the next step is **live drag-driven animation**: dragging bones
directly on the canvas to pose the character and recording those poses
over time. MP4 export is the other gap — it needs a video encoder rather
than the hand-written one GIF gets by.

The code is arranged for that already:

- `www/js/scene.js` is the canvas: its size in pixels. `www/js/view.js`
  is the camera between that grid and the screen. Model code works in
  grid pixels only; input goes through `view.toScene`, output through
  `view.toScreen`.
- `www/js/parts.js` holds the artwork — each imported piece is a `Part`
  with its own id, decoded pixels, whole-pixel position and scale,
  rotation, and z-index.
- `www/js/bones.js` holds the skeleton — each `Bone` has an id, name,
  parent id, head/tail, rotation, and length, stored *relative to its
  parent* so forward kinematics comes for free, plus its optional spring
  settings and simulation state.
- `www/js/mesh.js` holds the binding — each Part's mesh has a vertex list
  (rest position, UV, and a `{boneId: weight}` map per vertex), a triangle
  index list, and the bone bind poses.
- Parts and bones are **deliberately kept separate**. A bone doesn't
  belong to a Part: a mesh may span several parts, or a part may need
  several bones. The weight map is the only thing that connects them, and
  it references bones by id.

Animation needs exactly one call per frame:

```js
bonesStore.stepPhysics(dt)                          // settle any spring bones
bonesStore.snapshotTransforms()                     // live bone transforms
deformVerticesSnapped(part.mesh, part, transforms)  // -> whole-pixel positions
```

(`deformVertices` still returns the continuous positions if something
needs them — the paint brush does — and `www/js/raster.js` turns the
snapped triangles into grid pixels.)

Touch posing only has to write new targets into `bone.rotation`; neither
the binding data nor the simulation needs touching to drive it. Rendering lives in
`www/js/canvas.js`, separate from the state machine (`state.js`) and the
DOM wiring (`ui.js`).
