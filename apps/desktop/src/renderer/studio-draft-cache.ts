import {
  DEFAULT_STUDIO_OPTIONS,
  type MediaKind,
  type StudioOptions,
} from './studio-support';

const DRAFT_METADATA_KEY = 'mixdog.studio-draft.v1';
const DATABASE_NAME = 'mixdog-studio-cache';
const DATABASE_VERSION = 1;
const REFERENCE_STORE = 'references';
const DRAFT_REFERENCES_KEY = 'draft:latest';
const MAX_PROMPT_CHARS = 100_000;
const MAX_REFERENCE_COUNT = 7;
const MAX_REFERENCE_BASE64_CHARS = 64 * 1024 * 1024;

export interface StudioDraftMetadata {
  kind: MediaKind;
  laneId: string;
  model: string;
  options: StudioOptions;
  prompt: string;
}

export interface StudioCachedReference {
  base64: string;
  mime: string;
}

export interface StudioReferenceStore {
  read(key: string): Promise<unknown>;
  write(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function boundedString(value: unknown, fallback: string, maximum: number): string {
  return typeof value === 'string' && value.length <= maximum ? value : fallback;
}

export function normalizeStudioDraftMetadata(value: unknown): StudioDraftMetadata | null {
  const draft = record(value);
  if (!draft) return null;
  const rawOptions = record(draft.options);
  const duration = Number(rawOptions?.duration);
  return {
    kind: draft.kind === 'video' ? 'video' : 'image',
    laneId: boundedString(draft.laneId, '', 512).trim(),
    model: boundedString(draft.model, '', 512).trim(),
    options: {
      aspectRatio: boundedString(
        rawOptions?.aspectRatio,
        DEFAULT_STUDIO_OPTIONS.aspectRatio,
        128,
      ),
      resolution: boundedString(
        rawOptions?.resolution,
        DEFAULT_STUDIO_OPTIONS.resolution,
        128,
      ),
      size: boundedString(rawOptions?.size, DEFAULT_STUDIO_OPTIONS.size, 128),
      quality: boundedString(rawOptions?.quality, DEFAULT_STUDIO_OPTIONS.quality, 128),
      duration: Number.isFinite(duration) && duration > 0 && duration <= 300
        ? duration
        : DEFAULT_STUDIO_OPTIONS.duration,
    },
    prompt: boundedString(draft.prompt, '', MAX_PROMPT_CHARS),
  };
}

export function readStudioDraftMetadata(
  storage: Pick<Storage, 'getItem'> = window.localStorage,
): StudioDraftMetadata | null {
  try {
    const raw = storage.getItem(DRAFT_METADATA_KEY);
    return raw ? normalizeStudioDraftMetadata(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

export function writeStudioDraftMetadata(
  value: StudioDraftMetadata,
  storage: Pick<Storage, 'setItem'> = window.localStorage,
): void {
  try {
    const draft = normalizeStudioDraftMetadata(value);
    if (draft) storage.setItem(DRAFT_METADATA_KEY, JSON.stringify(draft));
  } catch {
    // Draft persistence is a convenience; a full/disabled store must not block Studio.
  }
}

export function normalizeStudioReferences(value: unknown): StudioCachedReference[] {
  const payload = record(value);
  const rows = Array.isArray(value)
    ? value
    : Array.isArray(payload?.references) ? payload.references : [];
  return rows.flatMap((candidate) => {
    const reference = record(candidate);
    const base64 = reference?.base64;
    const mime = reference?.mime;
    if (typeof base64 !== 'string'
      || !base64
      || base64.length > MAX_REFERENCE_BASE64_CHARS
      || typeof mime !== 'string'
      || !/^image\/[-+.a-z0-9]+$/i.test(mime)) {
      return [];
    }
    return [{ base64, mime }];
  }).slice(0, MAX_REFERENCE_COUNT);
}

let databasePromise: Promise<IDBDatabase> | null = null;

function database(): Promise<IDBDatabase> {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is unavailable.'));
      return;
    }
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(REFERENCE_STORE)) {
        request.result.createObjectStore(REFERENCE_STORE);
      }
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => {
        request.result.close();
        databasePromise = null;
      };
      resolve(request.result);
    };
    request.onerror = () => {
      databasePromise = null;
      reject(request.error || new Error('Studio cache could not be opened.'));
    };
    request.onblocked = () => {
      databasePromise = null;
      reject(new Error('Studio cache upgrade is blocked.'));
    };
  });
  return databasePromise;
}

const indexedDbReferenceStore: StudioReferenceStore = {
  async read(key) {
    const db = await database();
    return await new Promise((resolve, reject) => {
      const request = db.transaction(REFERENCE_STORE, 'readonly')
        .objectStore(REFERENCE_STORE)
        .get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  },
  async write(key, value) {
    const db = await database();
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(REFERENCE_STORE, 'readwrite');
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
      transaction.objectStore(REFERENCE_STORE).put(value, key);
    });
  },
  async remove(key) {
    const db = await database();
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(REFERENCE_STORE, 'readwrite');
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
      transaction.objectStore(REFERENCE_STORE).delete(key);
    });
  },
};

function assetReferencesKey(assetId: string): string {
  return `asset:${String(assetId || '').trim().slice(0, 512)}`;
}

async function readReferences(
  key: string,
  store: StudioReferenceStore,
): Promise<StudioCachedReference[]> {
  try {
    return normalizeStudioReferences(await store.read(key));
  } catch {
    return [];
  }
}

async function writeReferences(
  key: string,
  references: StudioCachedReference[],
  store: StudioReferenceStore,
): Promise<void> {
  try {
    const normalized = normalizeStudioReferences(references);
    if (!normalized.length && key !== DRAFT_REFERENCES_KEY) {
      await store.remove(key);
      return;
    }
    await store.write(key, { version: 1, references: normalized });
  } catch {
    // Image caching must never turn a successful generation into an error.
  }
}

export function readStudioDraftReferences(
  store: StudioReferenceStore = indexedDbReferenceStore,
): Promise<StudioCachedReference[]> {
  return readReferences(DRAFT_REFERENCES_KEY, store);
}

export function writeStudioDraftReferences(
  references: StudioCachedReference[],
  store: StudioReferenceStore = indexedDbReferenceStore,
): Promise<void> {
  return writeReferences(DRAFT_REFERENCES_KEY, references, store);
}

export function readStudioAssetReferences(
  assetId: string,
  store: StudioReferenceStore = indexedDbReferenceStore,
): Promise<StudioCachedReference[]> {
  return readReferences(assetReferencesKey(assetId), store);
}

export function writeStudioAssetReferences(
  assetId: string,
  references: StudioCachedReference[],
  store: StudioReferenceStore = indexedDbReferenceStore,
): Promise<void> {
  return writeReferences(assetReferencesKey(assetId), references, store);
}

export async function removeStudioAssetReferences(
  assetId: string,
  store: StudioReferenceStore = indexedDbReferenceStore,
): Promise<void> {
  try {
    await store.remove(assetReferencesKey(assetId));
  } catch {
    // Asset deletion still succeeds if its rebuildable local cache is unavailable.
  }
}
