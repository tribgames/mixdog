// A cache of thumbnails for images the user sent. Stored history keeps no image
// bytes, so the thumbnails are refilled from the host: on a miss the row asks
// the host to rebuild the thumbnail from the stored original (keyed by its
// attachment ref, scoped by session) and puts the result here in IndexedDB.
// The store is per device/profile and only a cache: an entry that is gone is
// fetched again. Total size is capped and least-recently-used entries go first.

import { loadImage } from './load-image';
import { isRemoteContentSurface } from './remote-conversation-privacy';

export const PREVIEW_MAX_SIDE = 320;
export const PREVIEW_MAX_BYTES = 40 * 1024;
export const PREVIEW_STORE_MAX_BYTES = 50 * 1024 * 1024;
const HOT_LIMIT = 96;

export interface PreviewMeta {
  key: string;
  session: string;
  size: number;
  at: number;
}

/** Eviction and session deletion run against what the backend holds right now
 *  (one transaction), never a window's cached view: several windows share it. */
export interface PreviewBackend {
  getData(key: string): Promise<string | undefined>;
  put(meta: PreviewMeta, data: string): Promise<void>;
  /** Refreshes recency of an entry that still exists. */
  touch(key: string, at: number): Promise<void>;
  /** Drops least-recently-used entries (never `keepKey`) until the total fits; returns the dropped keys. */
  evict(maxBytes: number, keepKey: string): Promise<string[]>;
  /** Drops every entry of the session; returns the dropped keys. */
  removeSession(session: string): Promise<string[]>;
}

function pickEvictions(metas: PreviewMeta[], maxBytes: number, keepKey: string): string[] {
  let total = 0;
  for (const meta of metas) total += meta.size;
  const evicted: string[] = [];
  if (total <= maxBytes) return evicted;
  for (const meta of [...metas].sort((a, b) => a.at - b.at)) {
    if (total <= maxBytes) break;
    if (meta.key === keepKey) continue;
    total -= meta.size;
    evicted.push(meta.key);
  }
  return evicted;
}

export function memoryPreviewBackend(): PreviewBackend {
  const metas = new Map<string, PreviewMeta>();
  const data = new Map<string, string>();
  const drop = (keys: string[]) => {
    for (const key of keys) {
      metas.delete(key);
      data.delete(key);
    }
    return keys;
  };
  return {
    getData: async (key) => data.get(key),
    put: async (meta, value) => {
      metas.set(meta.key, meta);
      data.set(meta.key, value);
    },
    touch: async (key, at) => {
      const meta = metas.get(key);
      if (meta) metas.set(key, { ...meta, at });
    },
    evict: async (maxBytes, keepKey) => drop(pickEvictions([...metas.values()], maxBytes, keepKey)),
    removeSession: async (session) =>
      drop([...metas.values()].filter((meta) => meta.session === session).map((meta) => meta.key)),
  };
}

const DB_NAME = 'mixdog-image-previews';

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export function indexedDbPreviewBackend(factory: IDBFactory = indexedDB): PreviewBackend {
  let opened: Promise<IDBDatabase> | null = null;
  const open = () => {
    opened ??= new Promise<IDBDatabase>((resolve, reject) => {
      const req = factory.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore('meta', { keyPath: 'key' });
        req.result.createObjectStore('data');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return opened;
  };
  return {
    async getData(key) {
      const db = await open();
      return request(db.transaction('data').objectStore('data').get(key) as IDBRequest<string | undefined>);
    },
    async put(meta, value) {
      const db = await open();
      const tx = db.transaction(['meta', 'data'], 'readwrite');
      tx.objectStore('meta').put(meta);
      tx.objectStore('data').put(value, meta.key);
      await transactionDone(tx);
    },
    async touch(key, at) {
      const db = await open();
      const tx = db.transaction('meta', 'readwrite');
      const store = tx.objectStore('meta');
      const req = store.get(key) as IDBRequest<PreviewMeta | undefined>;
      req.onsuccess = () => {
        if (req.result) store.put({ ...req.result, at });
      };
      await transactionDone(tx);
    },
    async evict(maxBytes, keepKey) {
      return dropWhere((metas) => pickEvictions(metas, maxBytes, keepKey));
    },
    async removeSession(session) {
      return dropWhere((metas) => metas.filter((meta) => meta.session === session).map((meta) => meta.key));
    },
  };
  /** Reads the stored metadata and deletes the chosen entries in one transaction. */
  async function dropWhere(choose: (metas: PreviewMeta[]) => string[]): Promise<string[]> {
    const db = await open();
    const tx = db.transaction(['meta', 'data'], 'readwrite');
    const done = transactionDone(tx);
    const dropped: string[] = [];
    const req = tx.objectStore('meta').getAll() as IDBRequest<PreviewMeta[]>;
    req.onsuccess = () => {
      for (const key of choose(req.result)) {
        tx.objectStore('meta').delete(key);
        tx.objectStore('data').delete(key);
        dropped.push(key);
      }
    };
    await done;
    return dropped;
  }
}

export function previewKey(session: string, line: string): string {
  return `${session}|${line.trim()}`;
}

export function createImagePreviewStore(backend: PreviewBackend, maxBytes = PREVIEW_STORE_MAX_BYTES) {
  const hot = new Map<string, string>();
  let clock = 0;
  const tick = () => {
    clock = Math.max(Date.now(), clock + 1);
    return clock;
  };
  const hotSession = new Map<string, string>();
  const forget = (key: string) => {
    hot.delete(key);
    hotSession.delete(key);
  };
  const remember = (key: string, dataUrl: string, session?: string) => {
    hot.delete(key);
    hot.set(key, dataUrl);
    if (session !== undefined) hotSession.set(key, session);
    while (hot.size > HOT_LIMIT) forget(hot.keys().next().value as string);
  };
  return {
    /** Synchronous read of what this window already loaded or stored. */
    peek: (key: string): string | undefined => hot.get(key),
    async get(key: string): Promise<string | undefined> {
      const dataUrl = hot.get(key) ?? (await backend.getData(key));
      if (!dataUrl) return undefined;
      remember(key, dataUrl);
      void backend.touch(key, tick()).catch(() => undefined);
      return dataUrl;
    },
    async put(key: string, session: string, dataUrl: string): Promise<void> {
      remember(key, dataUrl, session);
      await backend.put({ key, session, size: dataUrl.length, at: tick() }, dataUrl);
      for (const evictedKey of await backend.evict(maxBytes, key)) forget(evictedKey);
    },
    async deleteSession(session: string): Promise<void> {
      const own = () => [...hot.keys()].filter((key) => (hotSession.get(key) ?? key.split('|')[0]) === session);
      for (const key of own()) forget(key);
      for (const key of await backend.removeSession(session)) forget(key);
      for (const key of own()) forget(key);
    },
  };
}

export type ImagePreviewStore = ReturnType<typeof createImagePreviewStore>;

export const persistentImagePreviews: ImagePreviewStore = createImagePreviewStore(
  typeof indexedDB === 'undefined' || isRemoteContentSurface() ? memoryPreviewBackend() : indexedDbPreviewBackend()
);

/** Downscales a data URL to at most 320 px on its longest side, re-encoded
 *  (WebP, else JPEG) to roughly 40 KB. */
export async function makeImageThumbnail(dataUrl: string): Promise<string> {
  return drawThumbnail(await loadImage(dataUrl));
}

/** `dataUrl` itself when it already is thumbnail-sized (sides and bytes), else
 *  its `makeImageThumbnail` downscale. Rejects when it is not a picture. */
export async function fitImageThumbnail(dataUrl: string): Promise<string> {
  const image = await loadImage(dataUrl);
  const fits =
    Math.max(image.naturalWidth, image.naturalHeight) <= PREVIEW_MAX_SIDE &&
    dataUrl.length * 0.75 <= PREVIEW_MAX_BYTES * 2;
  return fits ? dataUrl : drawThumbnail(image);
}

function drawThumbnail(image: HTMLImageElement): string {
  const scale = Math.min(1, PREVIEW_MAX_SIDE / Math.max(image.naturalWidth, image.naturalHeight, 1));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('canvas unavailable');
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  let type = 'image/webp';
  let out = '';
  for (let quality = 0.82; quality >= 0.3; quality -= 0.15) {
    out = canvas.toDataURL(type, quality);
    if (!out.startsWith('data:image/webp')) {
      type = 'image/jpeg';
      out = canvas.toDataURL(type, quality);
    }
    if (out.length * 0.75 <= PREVIEW_MAX_BYTES) break;
  }
  return out;
}

export type SessionPreviewsListener = (session: string) => void;
const deletionListeners = new Set<SessionPreviewsListener>();

/** Called whenever a session's previews are deleted (so in-memory bookkeeping can forget it). */
export function onSessionPreviewsDeleted(listener: SessionPreviewsListener): void {
  deletionListeners.add(listener);
}

export function deleteSessionImagePreviews(session: string): void {
  if (!session) return;
  for (const listener of deletionListeners) listener(session);
  void persistentImagePreviews.deleteSession(session).catch(() => undefined);
}

// Earlier builds saved a new chat's first-send previews under the empty
// session, where any chat could show them and nothing deleted them. Purged once.
const LEGACY_PURGE_FLAG = 'mixdog.image-previews.empty-session-purged.v1';

/** The page's localStorage; undefined where reading it throws (an opaque or
 *  sandboxed origin denies the property itself, not just its writes). */
function deviceStorage(): Pick<Storage, 'getItem' | 'setItem'> | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

/** Deletes the empty-session entries, once per device profile. */
export function purgeEmptySessionPreviews(
  store: ImagePreviewStore = persistentImagePreviews,
  storage: Pick<Storage, 'getItem' | 'setItem'> | undefined = deviceStorage()
): Promise<void> {
  try {
    if (storage?.getItem(LEGACY_PURGE_FLAG)) return Promise.resolve();
  } catch {
    // Unreadable storage: purging again is harmless.
  }
  return store.deleteSession('').then(
    () => {
      try {
        storage?.setItem(LEGACY_PURGE_FLAG, '1');
      } catch {
        // Purged again next start.
      }
    },
    () => undefined
  );
}

if (typeof indexedDB !== 'undefined' && !isRemoteContentSurface()) void purgeEmptySessionPreviews();
