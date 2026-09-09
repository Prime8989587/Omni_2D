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
- **Part 3** (current) adds **Rig mode**: place bones over the assembled
  character and build a parent/child skeleton. Rotating a bone carries its
  whole chain of children with it. See "Building a skeleton (Rig mode)"
  below. **Bones do not deform the artwork yet** — this step only defines
  the skeleton; mesh binding and weight painting come next, and export is
  still a placeholder that only logs.

## What's in this repo

```
www/index.html          App shell markup (screens, buttons, panels, export modal)
www/css/style.css       The black/pink theme, layout, and button states
www/js/state.js         The app's state machine (home/rig/animating/recording) — no DOM
www/js/parts.js         The scene model: the Part object and the store holding them
www/js/bones.js         The skeleton: Bone objects, the parent/child tree, and the
                         forward-kinematics math. Kept separate from parts.js
www/js/importer.js      Picked files -> Parts (PNG validation, decode, placement)
www/js/gestures.js      Touch handling for Parts: drag, pinch-scale, two-finger rotate
www/js/rigTool.js       Touch handling for Bones: two-tap placement, handle dragging
www/js/canvas.js        Renderer — draws parts with smoothing off so pixel art stays
                         crisp, plus the skeleton overlay in Rig mode
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

Newly imported parts land near the middle of the canvas, each nudged
slightly down-right from the last so a batch of eight doesn't arrive as
one unseparable stack. Small sprites are scaled up by a whole-number
factor (2x, 3x…) so they're big enough to grab without going blurry.

### Assembling: drag, scale, rotate

On the canvas:

- **One finger, drag** — moves the part you touched. Touching a part also
  selects it.
- **Two fingers, pinch** — scales the selected part up or down.
- **Two fingers, twist** — rotates the selected part.
- Two-finger gestures also slide the part around, so you can scale,
  rotate, and reposition in one continuous motion (e.g. sizing hair to
  sit correctly on a head).
- **Tap empty space** — deselects.

The selected part is outlined in pink so you always know which piece
you're about to move. Pixel art is drawn with image smoothing turned off,
so scaling and rotating keep hard pixel edges instead of going blurry.

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
3. Pinch one piece bigger, and check the edges stay blocky rather than
   blurry.
4. Twist a piece to rotate it.
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

**Parts are locked in Rig mode** — dragging on the canvas no longer moves
your character, because the canvas now belongs to the bone tool. Tap **✕**
to return Home if you need to re-position artwork.

### Placing the root bone

1. Tap **Add Bone**.
2. **Tap once** on the canvas to place the bone's **head** (its origin — a
   small ring marks it).
3. **Tap again** to place the **tail** (the pointed end).

Placement is two taps rather than a drag, because tapping two points is
much more forgiving with a fingertip than dragging a precise line.

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
- **Readout** — shows the bone's world position, angle, and length.
- **Nudge controls** — `←` `↑` `↓` `→` move the bone by 2px per tap and
  `↺` `↻` rotate it by 2° per tap, for precision that fingertip dragging
  can't give you.
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
2. Confirm dragging no longer moves the artwork.
3. **Add Bone**, tap twice to lay a root bone down the character's spine.
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

## App states & how to navigate (manual test flow)

Import and part assembly are real (see the section above). Everything
below that relates to *animating* is still a placeholder that only logs to
the console (visible via `adb logcat` or Android Studio's Logcat panel) or
shows a modal — there's no bone/mesh/animation logic yet, so what you're
testing here is the screen flow and button enabled/disabled behavior.

There are four app states:

1. **Home** — the starting screen, and where you assemble the character.
   Shows the canvas with an **Import** button top-left and the **Rig** and
   **Animate** buttons across the bottom, plus the Scene Parts panel once
   anything is imported.
   - Tapping **Import** opens the file picker (see above).
   - Tapping **Rig** moves you into Rig mode (see above) — a separate
     branch from Animate; **✕** brings you back Home.
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

With parts assembled and a skeleton built, the next step is **binding**:
associating the pixel art with the bones (mesh / weights) so that posing a
bone actually moves the artwork attached to it. After that comes posing
and playback in Animate mode, and finally real GIF/MP4 encoding.

The code is arranged for that already:

- `www/js/parts.js` holds the artwork — each imported piece is a `Part`
  with its own id, image, position, scale, rotation, and z-index.
- `www/js/bones.js` holds the skeleton — each `Bone` has an id, name,
  parent id, head/tail, rotation, and length, stored *relative to its
  parent* so forward kinematics comes for free.
- The two are **deliberately kept separate**. A bone doesn't belong to a
  Part: a single mesh may later span several parts, or one part may need
  several bones. Binding is what will connect them, referencing bones by
  id.

Rendering lives in `www/js/canvas.js`, separate from the state machine
(`state.js`) and the DOM wiring (`ui.js`). Look for the `FUTURE HOOK`
comments marking where mesh deformation and frame capture plug in.
