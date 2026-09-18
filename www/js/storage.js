// Persistent project storage.
//
// IndexedDB rather than localStorage, for two reasons: localStorage holds
// strings only (so every pixel buffer would need a base64 round-trip that
// inflates it by a third) and its quota is a few megabytes, which one
// large layer can exhaust. IndexedDB stores the typed arrays directly via
// structured clone and its quota is orders of magnitude larger.
//
// Three stores: named projects the user saves deliberately, a single
// recovery slot the app writes to on its own, and named colour palettes.

const DB_NAME = 'omni2d';
// Bumped for the palettes store, then again for PCreate's work-in-progress
// slot, then again for app settings. onupgradeneeded below already guards
// every store's creation with "if not already there", so this runs
// harmlessly for a database that already has the earlier stores in it --
// only the new one gets created.
const DB_VERSION = 4;
const PROJECTS = 'projects';
const RECOVERY = 'recovery';
const RECOVERY_KEY = 'autosave';
// A state the user deliberately marked as the one to come back to. Kept
// beside the auto-save rather than among the named projects: it is not a
// project you open, it is an undo rope for the current one.
const RESTORE_KEY = 'restore-point';

// PCreate's saved colour palettes. APP-LEVEL, not project-level -- a
// palette is a picking convenience the artist builds up once and expects
// to have available across every piece of PCreate work afterward, the same
// way the OS-level colour swatches in a paint program outlive any one
// document. So this is its own store, keyed by palette name, entirely
// separate from the PROJECTS store a project's own save/load walks.
const PALETTES = 'palettes';

// PCreate's work in progress: one canvas the artist is part-way through,
// saved deliberately so closing the app does not throw it away. A single
// slot rather than named entries, because a PCreate canvas is not a
// document you keep a library of -- it is scratch work on its way to
// becoming a Scene Parts layer, and the thing worth protecting is "the one
// I was in the middle of". Named, permanent results go into the project
// through Save as Layer instead.
const PCREATE = 'pcreate';
const PCREATE_KEY = 'session';

// App settings: one record holding every preference from all three
// sections. A single row rather than a row per setting, because settings
// are only ever read as a set (the whole thing is pulled into memory once
// at boot) and only ever written one at a time -- so a single put is both
// the cheapest read and a write that can never leave two related
// preferences disagreeing with each other halfway through.
const SETTINGS = 'settings';
const SETTINGS_KEY = 'app';

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('This device has no IndexedDB, so projects cannot be saved.'));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(PROJECTS)) db.createObjectStore(PROJECTS, { keyPath: 'name' });
      if (!db.objectStoreNames.contains(RECOVERY)) db.createObjectStore(RECOVERY, { keyPath: 'key' });
      if (!db.objectStoreNames.contains(PALETTES)) db.createObjectStore(PALETTES, { keyPath: 'name' });
      if (!db.objectStoreNames.contains(PCREATE)) db.createObjectStore(PCREATE, { keyPath: 'key' });
      if (!db.objectStoreNames.contains(SETTINGS)) db.createObjectStore(SETTINGS, { keyPath: 'key' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Could not open the project database'));
  });
  return dbPromise;
}

function runTransaction(storeName, mode, work) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, mode);
        const store = tx.objectStore(storeName);
        let result;
        try {
          result = work(store);
        } catch (error) {
          reject(error);
          return;
        }
        tx.oncomplete = () => resolve(result && result.__request ? result.__request.result : result);
        tx.onerror = () => reject(tx.error || new Error('Project storage failed'));
        tx.onabort = () => reject(tx.error || new Error('Project storage was interrupted'));
      })
  );
}

// Wraps an IDBRequest so runTransaction can hand back its result once the
// transaction commits.
const wrap = (request) => ({ __request: request });

export function saveProject(name, data) {
  const record = { name, savedAt: Date.now(), data };
  return runTransaction(PROJECTS, 'readwrite', (store) => {
    store.put(record);
    return record;
  });
}

export function loadProject(name) {
  return runTransaction(PROJECTS, 'readonly', (store) => wrap(store.get(name)));
}

export function deleteProject(name) {
  return runTransaction(PROJECTS, 'readwrite', (store) => {
    store.delete(name);
    return true;
  });
}

// Names and dates only -- enough to render the Open list without pulling
// every project's pixels into memory.
export function listProjects() {
  return runTransaction(PROJECTS, 'readonly', (store) => wrap(store.getAll())).then((records) =>
    (records || [])
      .map((record) => ({ name: record.name, savedAt: record.savedAt }))
      .sort((a, b) => b.savedAt - a.savedAt)
  );
}

export function saveRecovery(data, sourceName = null) {
  const record = { key: RECOVERY_KEY, savedAt: Date.now(), sourceName, data };
  return runTransaction(RECOVERY, 'readwrite', (store) => {
    store.put(record);
    return record;
  });
}

export function loadRecovery() {
  return runTransaction(RECOVERY, 'readonly', (store) => wrap(store.get(RECOVERY_KEY)));
}

export function clearRecovery() {
  return runTransaction(RECOVERY, 'readwrite', (store) => {
    store.delete(RECOVERY_KEY);
    return true;
  });
}

// ---------------------------------------------------------------------------
// PCreate palettes
//
// Same shape as the PROJECTS functions above -- a palette is exactly as
// durable as a saved project, put away and read back the same way, just in
// its own store so listing palettes never has to filter a project list.

export function savePalette(name, colors) {
  const record = { name, savedAt: Date.now(), colors };
  return runTransaction(PALETTES, 'readwrite', (store) => {
    store.put(record);
    return record;
  });
}

export function loadPalette(name) {
  return runTransaction(PALETTES, 'readonly', (store) => wrap(store.get(name)));
}

export function deletePalette(name) {
  return runTransaction(PALETTES, 'readwrite', (store) => {
    store.delete(name);
    return true;
  });
}

// Every saved palette in full -- unlike listProjects, which withholds each
// project's heavy pixel data, a palette is only ever a short list of colour
// numbers, so there is nothing expensive to leave out.
export function listPalettes() {
  return runTransaction(PALETTES, 'readonly', (store) => wrap(store.getAll())).then((records) =>
    (records || []).sort((a, b) => a.name.localeCompare(b.name))
  );
}

// ---- PCreate's work-in-progress slot -------------------------------------
//
// The pixel buffer goes in as a typed array and comes back as one: this is
// exactly the case the file header's "IndexedDB rather than localStorage"
// argument was about, since a 512x512 canvas is a megabyte that would need
// a base64 round-trip to survive localStorage at all.

export function savePCreateSession(data) {
  const record = { key: PCREATE_KEY, savedAt: Date.now(), data };
  return runTransaction(PCREATE, 'readwrite', (store) => {
    store.put(record);
    return record;
  });
}

export function loadPCreateSession() {
  return runTransaction(PCREATE, 'readonly', (store) => wrap(store.get(PCREATE_KEY)));
}

export function clearPCreateSession() {
  return runTransaction(PCREATE, 'readwrite', (store) => {
    store.delete(PCREATE_KEY);
    return true;
  });
}

export function saveRestorePoint(data, label = null) {
  const record = { key: RESTORE_KEY, savedAt: Date.now(), label, data };
  return runTransaction(RECOVERY, 'readwrite', (store) => {
    store.put(record);
    return record;
  });
}

export function loadRestorePoint() {
  return runTransaction(RECOVERY, 'readonly', (store) => wrap(store.get(RESTORE_KEY)));
}

export function clearRestorePoint() {
  return runTransaction(RECOVERY, 'readwrite', (store) => {
    store.delete(RESTORE_KEY);
    return true;
  });
}

// ---- App settings ---------------------------------------------------------

export function saveSettings(values) {
  const record = { key: SETTINGS_KEY, savedAt: Date.now(), values };
  return runTransaction(SETTINGS, 'readwrite', (store) => {
    store.put(record);
    return record;
  });
}

export function loadSettings() {
  return runTransaction(SETTINGS, 'readonly', (store) => wrap(store.get(SETTINGS_KEY)));
}

// ---- Clear all app data ---------------------------------------------------
//
// Empties every store rather than deleting the database outright.
// deleteDatabase() blocks indefinitely while any connection is still open,
// and this one's connection is held for the life of the page -- so a reset
// done that way would appear to hang until the app was closed, which is the
// opposite of what someone pressing a reset button expects. Clearing each
// store completes immediately and leaves the schema in place, so the very
// next write works without waiting for a reopen.
export function clearAllData() {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const names = [PROJECTS, RECOVERY, PALETTES, PCREATE, SETTINGS].filter((n) =>
          db.objectStoreNames.contains(n)
        );
        const tx = db.transaction(names, 'readwrite');
        for (const name of names) tx.objectStore(name).clear();
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => reject(tx.error || new Error('Could not clear app data'));
        tx.onabort = () => reject(tx.error || new Error('Clearing app data was interrupted'));
      })
  );
}
