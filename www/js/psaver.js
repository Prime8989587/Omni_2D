// PSaver: a project as a file on the device, not just a row in IndexedDB.
//
// WHY THIS EXISTS
//
// Save/Open (storage.js) keeps projects in IndexedDB, which lives inside
// the app's own storage. Uninstalling the app -- or, on some devices,
// merely updating it or clearing its data -- takes that storage with it,
// and the character has to be rebuilt layer by layer. PSaver writes the
// same project out as an ordinary file the user can see, copy to a PC,
// e-mail to themselves or drop in cloud storage, and read back afterwards.
//
// THE FORMAT IS THE ONE WE ALREADY HAD
//
// The payload is exactly serializeProject()'s output -- the same structure
// Save/Open and undo/redo already use. Nothing here knows what a bone or a
// mesh weight is, so a field added to the serializer travels in an export
// automatically and there is no second format to keep in step.
//
// The one thing that cannot travel as-is is a layer's pixel buffer.
// IndexedDB stores a Uint8ClampedArray natively via structured clone; JSON
// has no such type, so on the way out each buffer becomes a base64 string
// and on the way in it becomes a Uint8ClampedArray again. That conversion
// is the ONLY difference between the file and an internal save, and it is
// confined to the two functions below.
//
// WHY THE FILE IS .omni2d.json
//
// A double extension looks odd, but it is the honest one: the file really
// is JSON, so Android's file picker recognises it by MIME type and will
// actually offer it for selection. A made-up extension picks up no MIME
// type at all, and on the devices that DO honour the picker's filter it
// would leave the user staring at a list with their export greyed out.
// The "omni2d" half still names the app for anyone browsing a folder.

import { serializeProject } from './project.js';

export const PSAVER_MAGIC = 'omni2d-project';
export const PSAVER_FILE_VERSION = 1;
export const PSAVER_EXTENSION = '.omni2d.json';
// What the file picker offers. The extension first for the pickers that
// match on it, the MIME type for the ones that do not.
export const PSAVER_ACCEPT = '.omni2d.json,.json,application/json';

// A project big enough to be worth exporting is a few hundred KB of base64;
// anything past this is not one of our files and should not be read into
// memory just to find that out.
const MAX_FILE_BYTES = 256 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Pixels <-> base64
//
// Chunked because String.fromCharCode(...bytes) on a whole layer blows the
// argument limit -- a 512x512 layer is a million arguments.

const CHUNK = 0x8000;

function bytesToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function base64ToBytes(text) {
  const binary = atob(text);
  const bytes = new Uint8ClampedArray(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ---------------------------------------------------------------------------
// The file body

// The scene as a JSON-safe object. Everything is passed through untouched
// except the pixel buffers, so this stays correct as the serializer grows.
export function toFileBody(name) {
  const project = serializeProject({ copyPixels: false });
  return {
    psaver: PSAVER_MAGIC,
    psaverVersion: PSAVER_FILE_VERSION,
    app: 'Omni 2D',
    exportedAt: Date.now(),
    name: name || 'untitled',
    project: {
      ...project,
      parts: project.parts.map((part) => ({ ...part, pixels: bytesToBase64(part.pixels) })),
    },
  };
}

// Thrown for anything the user could plausibly have done -- picked the
// wrong file, picked a truncated one, picked one from a newer build. The
// message is written to be shown as-is.
export class PSaverError extends Error {}

function fail(message) {
  throw new PSaverError(message);
}

// Turns file text back into a snapshot applyProject() can take, or throws
// a PSaverError explaining exactly what is wrong with it.
//
// EVERY CHECK RUNS BEFORE THE SCENE IS TOUCHED. A bad file must leave the
// user's current work exactly as it was -- half-importing a corrupt
// project over a good one would be worse than not importing at all.
export function parseFileBody(text) {
  let file;
  try {
    file = JSON.parse(text);
  } catch {
    fail('That file is not a PSaver project — it is not even readable as text data. Pick the .omni2d.json file you exported.');
  }
  if (!file || typeof file !== 'object' || Array.isArray(file)) {
    fail('That file is not a PSaver project.');
  }
  if (file.psaver !== PSAVER_MAGIC) {
    fail('That file is not a PSaver project — it is missing the Omni 2D marker. Pick the .omni2d.json file you exported.');
  }
  if (typeof file.psaverVersion !== 'number' || file.psaverVersion > PSAVER_FILE_VERSION) {
    fail(`That project was exported by a newer version of Omni 2D (file format ${file.psaverVersion}, this build reads up to ${PSAVER_FILE_VERSION}). Update the app and try again.`);
  }

  const project = file.project;
  if (!project || typeof project !== 'object') fail('That PSaver file is damaged — it has no project inside it.');
  if (!Array.isArray(project.parts)) fail('That PSaver file is damaged — its layer list is missing.');
  if (!Array.isArray(project.bones)) fail('That PSaver file is damaged — its bone list is missing.');

  const canvas = project.canvas;
  if (!canvas || !(canvas.width > 0) || !(canvas.height > 0)) {
    fail('That PSaver file is damaged — its canvas size is missing or invalid.');
  }

  const parts = project.parts.map((part, index) => {
    const where = part && part.name ? `Layer "${part.name}"` : `Layer ${index + 1}`;
    if (!part || typeof part !== 'object') fail(`That PSaver file is damaged — ${where} is not readable.`);
    if (!(part.width > 0) || !(part.height > 0)) fail(`That PSaver file is damaged — ${where} has no size.`);
    if (typeof part.pixels !== 'string') fail(`That PSaver file is damaged — ${where} has no image data.`);

    let pixels;
    try {
      pixels = base64ToBytes(part.pixels);
    } catch {
      fail(`That PSaver file is damaged — ${where}'s image data could not be decoded.`);
    }
    // The decisive check: RGBA means exactly four bytes per pixel, so a
    // truncated file is caught here rather than as a torn layer on canvas.
    const expected = part.width * part.height * 4;
    if (pixels.length !== expected) {
      fail(`That PSaver file is truncated — ${where} should hold ${expected} bytes of image data but has ${pixels.length}.`);
    }
    return { ...part, pixels };
  });

  for (const bone of project.bones) {
    if (!bone || typeof bone !== 'object' || !bone.id) {
      fail('That PSaver file is damaged — one of its bones has no identity.');
    }
    if (!bone.localHead || typeof bone.localHead.x !== 'number' || typeof bone.localHead.y !== 'number') {
      fail(`That PSaver file is damaged — bone "${bone.name || bone.id}" has no position.`);
    }
  }

  return {
    name: typeof file.name === 'string' ? file.name : null,
    exportedAt: typeof file.exportedAt === 'number' ? file.exportedAt : null,
    // Identical in shape to what loadProject() hands back, so the caller
    // can feed it to the same applyProject() the Open flow uses.
    data: { ...project, parts },
  };
}

// ---------------------------------------------------------------------------
// Reading the file the user picked

export function readPickedFile(file) {
  if (!file) return Promise.reject(new PSaverError('No file was picked.'));
  if (file.size === 0) return Promise.reject(new PSaverError('That file is empty.'));
  if (file.size > MAX_FILE_BYTES) {
    return Promise.reject(new PSaverError('That file is far too large to be a PSaver project.'));
  }
  return file.text().then(parseFileBody);
}

// ---------------------------------------------------------------------------
// Writing the file
//
// Two worlds, because the app runs in both. Inside the Android build the
// Capacitor Filesystem plugin writes to shared storage; in a browser (and
// in the test harness) an anchor download does the same job. Callers get
// the same promise either way, resolving to where the file actually went.

// The app is plain ES modules served straight to the WebView -- there is
// no bundler to resolve a bare '@capacitor/filesystem' import. The native
// bridge Capacitor injects exposes every registered plugin through
// nativePromise(), which is the same channel the plugin's own JS wrapper
// uses, so the wrapper buys us nothing here. These are its wire values.
const DIRECTORY_DOCUMENTS = 'DOCUMENTS';
const DIRECTORY_EXTERNAL = 'EXTERNAL';
const ENCODING_UTF8 = 'utf8';

function nativeBridge() {
  const cap = globalThis.Capacitor;
  const native = cap && typeof cap.isNativePlatform === 'function' && cap.isNativePlatform();
  return native && typeof cap.nativePromise === 'function' ? cap : null;
}

// Everything an export writes goes in one folder, so a user with a dozen
// characters is not hunting through Documents for them.
const FOLDER = 'Omni2D';

async function writeNative(cap, filename, text) {
  const options = {
    path: `${FOLDER}/${filename}`,
    data: text,
    encoding: ENCODING_UTF8,
    recursive: true,
  };

  // Documents is shared storage: the file shows up in the Files app and,
  // crucially, SURVIVES UNINSTALLING THE APP -- which is the entire point.
  try {
    const result = await cap.nativePromise('Filesystem', 'writeFile', {
      ...options, directory: DIRECTORY_DOCUMENTS,
    });
    return { uri: result.uri, where: `Documents/${FOLDER}`, durable: true };
  } catch (documentsError) {
    // Some devices and Android versions refuse shared storage. Falling back
    // to the app's own external folder at least produces a real file the
    // user can copy somewhere safe -- but it is NOT a backup on its own,
    // and the caller says so out loud.
    console.warn('PSaver: shared storage refused, falling back', documentsError);
    try {
      const result = await cap.nativePromise('Filesystem', 'writeFile', {
        ...options, directory: DIRECTORY_EXTERNAL,
      });
      return { uri: result.uri, where: `the app's own storage folder (${FOLDER})`, durable: false };
    } catch {
      throw new PSaverError(
        `Could not write the file: ${documentsError.message || documentsError}. ` +
        'If Omni 2D was denied storage access, grant it in Android Settings and try again.'
      );
    }
  }
}

function writeBrowserDownload(filename, text) {
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Revoked on a later turn of the loop: revoking synchronously can beat
  // the browser to actually starting the download.
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return { uri: filename, where: 'your Downloads folder', durable: true };
}

// name -> a written file. Returns where it landed so the caller can tell
// the user somewhere they can actually go and look.
export async function exportToFile(name) {
  const filename = `${name}${PSAVER_EXTENSION}`;
  const text = JSON.stringify(toFileBody(name));
  const cap = nativeBridge();
  const result = cap
    ? await writeNative(cap, filename, text)
    : writeBrowserDownload(filename, text);
  return { ...result, filename, bytes: text.length };
}
