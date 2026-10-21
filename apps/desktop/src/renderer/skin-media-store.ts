// The custom skin's moving media (a short video or an animated GIF), kept as
// one Blob in this device's IndexedDB. The custom picture itself (and a moving
// skin's poster) stays a downscaled JPEG data URL in localStorage, which
// first paint replays synchronously (skin-boot-snapshot.ts); up to 20 MB of
// video does not fit there, and IndexedDB keeps it as a file in the profile.
// Device-local like the rest of the skin: a phone keeps its own.
const DB_NAME = 'mixdog-skin-media';
const STORE = 'media';
const CUSTOM_KEY = 'custom';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function run<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(STORE, mode);
      const request = action(transaction.objectStore(STORE));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    db.close();
  }
}

export async function putCustomSkinMedia(blob: Blob): Promise<void> {
  await run('readwrite', (store) => store.put(blob, CUSTOM_KEY));
}

export async function readCustomSkinMedia(): Promise<Blob | null> {
  const blob = await run<unknown>('readonly', (store) => store.get(CUSTOM_KEY));
  return blob instanceof Blob ? blob : null;
}

export async function deleteCustomSkinMedia(): Promise<void> {
  await run('readwrite', (store) => store.delete(CUSTOM_KEY));
}
