// Persistent project storage.
//
// IndexedDB rather than localStorage, for two reasons: localStorage holds
// strings only (so every pixel buffer would need a base64 round-trip that
// inflates it by a third) and its quota is a few megabytes, which one
// large layer can exhaust. IndexedDB stores the typed arrays directly via
// structured clone and its quota is orders of magnitude larger.
//
// Two stores: named projects the user saves deliberately, and a single
// recovery slot the app writes to on its own.

const DB_NAME = 'omni2d';
const DB_VERSION = 1;
const PROJECTS = 'projects';
const RECOVERY = 'recovery';
const RECOVERY_KEY = 'autosave';
// A state the user deliberately marked as the one to come back to. Kept
// beside the auto-save rather than among the named projects: it is not a
// project you open, it is an undo rope for the current one.
const RESTORE_KEY = 'restore-point';

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
