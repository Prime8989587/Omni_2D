// Writing a BINARY file to somewhere the user can find it again.
//
// Two worlds, because the app runs in both: inside the Android build the
// Capacitor Filesystem plugin writes to shared storage, and in a browser
// (and in the test harness) an anchor download does the same job. Callers
// get the same promise either way, resolving to where the file landed so
// they can tell the user somewhere real to go and look.
//
// This deliberately does NOT reach into psaver.js, which already knows how
// to do the text version of all this. Sharing the code would mean editing
// a module whose export path is working and verified, to serve a feature
// with different needs -- binary rather than utf8, Downloads rather than
// Documents. The duplicated part is the six lines that sniff the bridge.

const DIRECTORY_EXTERNAL_STORAGE = 'EXTERNAL_STORAGE';
const DIRECTORY_DOCUMENTS = 'DOCUMENTS';
const DIRECTORY_EXTERNAL = 'EXTERNAL';

// Everything this app exports shares one folder, so a user with a dozen
// animations is not hunting through a system directory for them.
const FOLDER = 'Omni2D';

function nativeBridge() {
  const cap = globalThis.Capacitor;
  const native = cap && typeof cap.isNativePlatform === 'function' && cap.isNativePlatform();
  return native && typeof cap.nativePromise === 'function' ? cap : null;
}

// Capacitor's Filesystem takes binary as base64. Done in chunks because
// String.fromCharCode(...bytes) on a multi-megabyte array overflows the
// argument stack -- the failure mode being a hard crash on exactly the
// large exports most worth saving.
function toBase64(bytes) {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

async function writeNative(cap, filename, bytes) {
  const data = toBase64(bytes);
  // No `encoding` field: that is how Capacitor's Filesystem is told the
  // payload is base64 binary rather than text.
  const base = { data, recursive: true };

  // Downloads first, because that is where a person looks for something
  // they just exported. On Android it lives under shared external storage
  // rather than being its own Directory value, hence the path.
  const attempts = [
    { directory: DIRECTORY_EXTERNAL_STORAGE, path: `Download/${FOLDER}/${filename}`, where: `Downloads/${FOLDER}` },
    { directory: DIRECTORY_DOCUMENTS, path: `${FOLDER}/${filename}`, where: `Documents/${FOLDER}` },
    { directory: DIRECTORY_EXTERNAL, path: `${FOLDER}/${filename}`, where: `the app's own storage folder (${FOLDER})` },
  ];

  let lastError = null;
  for (const attempt of attempts) {
    try {
      const result = await cap.nativePromise('Filesystem', 'writeFile', {
        ...base, path: attempt.path, directory: attempt.directory,
      });
      return { uri: result.uri, where: attempt.where, bytes: bytes.length };
    } catch (error) {
      // Shared storage is refused on plenty of devices and Android
      // versions. Falling through to the next place still produces a real
      // file the user can get at, which beats failing the export outright.
      lastError = error;
    }
  }
  throw new Error(
    `Could not write the file: ${(lastError && lastError.message) || lastError}. ` +
    'If Omni 2D was denied storage access, grant it in Android Settings and try again.'
  );
}

function writeBrowserDownload(filename, bytes, mime) {
  const blob = new Blob([bytes], { type: mime });
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
  return { uri: filename, where: 'your Downloads folder', bytes: bytes.length };
}

export async function saveBinaryFile(filename, bytes, mime = 'application/octet-stream') {
  const cap = nativeBridge();
  if (cap) return writeNative(cap, filename, bytes);
  return writeBrowserDownload(filename, bytes, mime);
}

// A typed name is not yet a file name. The characters a path cannot hold
// go, and so do leading dots -- on Android and Linux a leading dot makes
// the file HIDDEN, and an export nobody can see in their file manager may
// as well not have been written.
export function toSafeFilename(name, extension) {
  const cleaned = String(name || '')
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/^[.\s]+/, '')
    .replace(/[.\s]+$/, '');
  const stem = cleaned || 'animation';
  return stem.toLowerCase().endsWith(extension) ? stem : `${stem}${extension}`;
}
