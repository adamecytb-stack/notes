/**
 * Minimal IndexedDB wrapper.
 *
 * Two stores: `vault` holds the non-extractable CryptoKey, `entries` holds the
 * offline cache. The cache stores ciphertext exactly as it came off the wire —
 * no plaintext dream ever touches disk.
 */

const DB_NAME = 'dream-journal';
const VERSION = 1;
export const STORES = ['vault', 'entries', 'meta'];

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      for (const name of STORES) {
        if (!req.result.objectStoreNames.contains(name)) req.result.createObjectStore(name);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('idb blocked'));
  });
  return dbPromise;
}

async function run(storeName, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(storeName, mode);
    const req = fn(t.objectStore(storeName));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Every call is best-effort: private browsing or a full disk must not break the app. */
async function safe(promise, fallback = null) {
  try {
    return await promise;
  } catch {
    return fallback;
  }
}

export const idbGet = (store, key) => safe(run(store, 'readonly', (s) => s.get(key)));
export const idbGetAll = (store) => safe(run(store, 'readonly', (s) => s.getAll()), []);
export const idbPut = (store, key, value) => safe(run(store, 'readwrite', (s) => s.put(value, key)));
export const idbDel = (store, key) => safe(run(store, 'readwrite', (s) => s.delete(key)));
export const idbClear = (store) => safe(run(store, 'readwrite', (s) => s.clear()));
