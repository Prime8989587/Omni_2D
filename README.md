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
  below. Drag-driven animation and real GIF/MP4 export are still to come;
  export remains a placeholder that only logs.

## What's in this repo

```
www/index.html          App shell markup (screens, buttons, panels, export modal)
www/css/style.css       The black/pink theme, layout, and button states
www/js/state.js         The app's state machine (home/rig/animating/recording) — no DOM
www/js/scene.js         The canvas itself: its size in pixels (8–3072 per side) and presets
www/js/view.js          The camera: zoom and pan between the pixel grid and the screen
www/js/raster.js        Software rasterizer that draws (deformed) triangles straight onto
                         the pixel grid one whole pixel at a time — no gaps, no blur
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

Pixel cells are usually far smaller than a fingertip, so the grid is
zoomable:

- **Two fingers on empty grid, pinch** — zoom in or out around your
  fingers, from the whole canvas down to a handful of cells. Pinch works
  in every mode (Home, Rig, Bind).
- **One finger on empty grid, drag** — pan.
- **⤢ (Fit)** in the top bar — fit the whole canvas on screen again.

When you let go after a pinch, the zoom snaps to a whole number of screen
pixels per cell, so every cell is exactly the same size and the
checkerboard stays even. Below 3 screen pixels per cell the checkerboard
would be a moiré blur, so at that distance it is drawn as a flat dark
panel; pinch in and the cells reappear.

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
mesh**. That raises the selected bone's weight on the vertices under the
brush, and every other bone's weight on those same vertices is scaled
down to compensate, so each vertex's weights always still sum to 1.

- **Brush** — the radius of the brush in *screen* pixels, so it feels the
  same at any zoom; zoom in to paint finer detail in grid cells. Influence
  falls off linearly from the centre to the rim.
- **Strength** — how fast each pass pushes weight toward this bone.

To take influence *away* from a bone, select a different bone and paint
over the same area — that bone gains, so this one loses.

**Auto-weight Part** doubles as the undo: it throws away all hand-painted
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

Import and part assembly are real (see the section above). Everything
below that relates to *animating* is still a placeholder that only logs to
the console (visible via `adb logcat` or Android Studio's Logcat panel) or
shows a modal — there's no bone/mesh/animation logic yet, so what you're
testing here is the screen flow and button enabled/disabled behavior.

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
a filename field (defaults to `animation_01` if left blank), **Save as
GIF** / **Save as MP4** buttons (both just log a placeholder export
message — no real encoding yet), and a red **Cancel** button that closes
the modal without exporting. Closing the modal either way leaves you in
the **Animating** state, ready to Start another recording.

A quick end-to-end pass to try on your phone: **Home → Animate → Start →
Stop → (export modal appears) → Save as GIF → back in Animate mode →
✕ → Home**. Also worth checking: tapping **✕** while **Recording** should
cancel straight back to Home, and disabled buttons (**Stop** on the
Animating screen, **Start** on the Recording screen) should be visibly
greyed out and not respond to taps.

---

## What's next

With artwork bound to a working skeleton, the next step is **live
drag-driven animation**: dragging bones directly on the canvas to pose the
character, recording those poses over time, and finally encoding real
GIF/MP4 files instead of logging placeholders.

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
