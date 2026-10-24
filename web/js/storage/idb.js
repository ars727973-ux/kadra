// Тонкая promise-обёртка над IndexedDB.
//
// Хранилища:
//   projects — JSON проектов (keyPath: id)
//   media    — блобы импортированных файлов (keyPath: key)
//   aux      — тяжёлые производные данные медиа: превью-спрайты, пики аудио (keyPath: id)
//   meta     — служебные значения: последний проект, настройки сервера (keyPath: key)

const DB_NAME = 'kadra';
const DB_VERSION = 1;
let dbPromise = null;

export function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('media')) db.createObjectStore('media', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('aux')) db.createObjectStore('aux', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('IndexedDB заблокирована другой вкладкой'));
  });
  return dbPromise;
}

function wrap(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(storeName, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(storeName, mode);
    const store = t.objectStore(storeName);
    let result;
    Promise.resolve(fn(store))
      .then((r) => {
        result = r;
      })
      .catch(reject);
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Транзакция IndexedDB прервана'));
  });
}

export const idb = {
  get: (store, key) => tx(store, 'readonly', (s) => wrap(s.get(key))),
  put: (store, value) => tx(store, 'readwrite', (s) => wrap(s.put(value))),
  delete: (store, key) => tx(store, 'readwrite', (s) => wrap(s.delete(key))),
  getAll: (store) => tx(store, 'readonly', (s) => wrap(s.getAll())),
  getAllKeys: (store) => tx(store, 'readonly', (s) => wrap(s.getAllKeys())),
  async meta(key, value) {
    if (value === undefined) return (await idb.get('meta', key))?.value;
    return idb.put('meta', { key, value });
  },
};

/** Оценка занятого места и квоты. */
export async function storageEstimate() {
  try {
    const est = await navigator.storage?.estimate?.();
    return est ? { usage: est.usage || 0, quota: est.quota || 0 } : null;
  } catch {
    return null;
  }
}

/** Попросить браузер не вытеснять данные. */
export async function requestPersistence() {
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) await navigator.storage.persist();
  } catch {
    /* не критично */
  }
}
