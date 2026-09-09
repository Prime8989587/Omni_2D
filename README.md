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
  on the grid. See "The pixel grid" below, which also lists what was
  re-verified from Parts 2–5 and the one gesture that changed. Drag-driven
  animation and real GIF/MP4 export are still to come; export remains a
  placeholder that only logs.

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
www/js/mesh.js          Mesh generation, auto-weighting, weight painting maths, and
                         the linear blend skinning that deforms the artwork
www/js/importer.js      Picked files -> Parts (PNG validation, size limits, decode,
                         whole-pixel placement)
www/js/gestures.js      Home-screen touch handling: drag / pinch-scale / twist a Part, or
                         pan / zoom the grid when the first finger lands on empty cells
www/js/viewGestures.js  Two-finger pinch-zoom of the grid in Rig and Bind mode
www/js/rigTool.js       Touch handling for Bones: two-tap placement, handle dragging
www/js/bindTool.js      Touch handling for weights: the paint brush
www/js/physics.js       The frame loop that keeps spring bones settling after
                         the input that disturbed them has stopped
www/js/canvas.js        Renderer — rasterizes every Part into a pixel-grid bitmap, blits
                         it at the current zoom, and draws the checkerboard, bones, mesh
                         heatmap, snap highlight and selection outline on top
www/js/ui.js            DOM wiring: buttons, Scene Parts panel, the export modal
www/js/app.js           Thin entry point that boots ui.js once the page loads
capacitor.config.json   Tells Capacitor the app's name, ID, and where the web files live
android/                The native Android project Capacitor generated (this is what Gradle builds)
package.json            Node project file listing Capacitor as a dependency
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
   APK."** Download `app-debug.apk` from the Assets list. This release is
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
3. **Tap once** to set the tail. The new bone's head is already attached
   to the parent's tail, so a child only needs one tap.

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

### Binding a Part (auto-weighting)

1. On the **Parts** tab, tap the piece you want to bind.
2. Tap **Auto-weight Part**.

That builds a grid mesh over the Part's image, splits it into triangles,
and gives every vertex weights to its nearest bones — inverse squared
distance to each bone's line segment, capped at the 3 closest bones and
normalized to sum to 1. Capping matters: letting every bone tug on every
vertex produces mush.

The Parts list marks bound pieces as **"— bound"**, and the status line
shows the vertex count.

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

## Spring physics on a bone

By default every bone moves rigidly: when its parent turns, it turns with
it instantly. Spring physics makes a bone *lag* behind that motion,
overshoot slightly, and wobble to a stop — the difference between a head
(which should be rigid) and a ponytail (which shouldn't).

### Turning it on

In **Rig mode**, select a bone and tap **Enable Physics**. It's off by
default on every bone, which is the right default — most of a character
should not jiggle.

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

### Testing it with the debug slider

The bone editor in Rig mode has a **Debug: rotate** slider that drives the
selected bone's rotation directly. It's temporary scaffolding — Part 6
replaces it with real touch-drag posing — but it's how you test physics
right now.

Build a rig where the contrast is visible side by side:

1. Place a **parent** bone.
2. Place a **child** off it, then re-select the parent and place a
   **second child** so the two are siblings, angled apart so you can tell
   them apart.
3. Select **one** child and tap **Enable Physics**. Leave the other alone.
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
