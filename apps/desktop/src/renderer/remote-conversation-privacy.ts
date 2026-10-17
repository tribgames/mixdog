import { catalogStorageScope } from './catalog-storage-scope';

/** The phone/browser remote client must not keep conversation content (prompts,
 *  titles, previews, drafts, image previews) on the device. Desktop persists as before. */
export function isRemoteContentSurface(): boolean {
  return catalogStorageScope() !== 'desktop';
}

/** Process-lifetime stand-in for Storage on the remote surface. */
export function createMemoryStorage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, String(value)),
    removeItem: (key) => void values.delete(key),
  };
}

const memoryContentStorage = createMemoryStorage();

/** `window.localStorage` on desktop, memory on the remote surface. */
export function contentLocalStorage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> {
  return isRemoteContentSurface() ? memoryContentStorage : window.localStorage;
}

/** Key prefixes (any namespace suffix included) earlier versions wrote. */
const LEGACY_LOCAL_PREFIXES = [
  'mixdog.desktop-session-catalog.v1',
  'mixdog.desktop.prompt-history.v1:',
  'mixdog.studio-draft.v1',
  'mixdog.image-previews.empty-session-purged.v1',
];
const LEGACY_SESSION_PREFIXES = ['mixdog:visualize-feedback:v1'];
const LEGACY_DATABASES = ['mixdog-image-previews', 'mixdog-studio-cache', 'mixdog-remote-roster'];

function removeByPrefix(storage: Storage | undefined, prefixes: readonly string[]): void {
  if (!storage) return;
  const doomed: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key && prefixes.some((prefix) => key.startsWith(prefix))) doomed.push(key);
  }
  for (const key of doomed) storage.removeItem(key);
}

function safely<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

/** Startup cleanup of conversation caches written before the remote surface went memory-only. */
export function purgeRemoteConversationCaches(
  local: Storage | undefined = safely(() => window.localStorage),
  session: Storage | undefined = safely(() => window.sessionStorage),
  factory: Pick<IDBFactory, 'deleteDatabase'> | undefined = safely(() => indexedDB)
): void {
  if (!isRemoteContentSurface()) return;
  safely(() => removeByPrefix(local, LEGACY_LOCAL_PREFIXES));
  safely(() => removeByPrefix(session, LEGACY_SESSION_PREFIXES));
  for (const name of LEGACY_DATABASES) safely(() => factory?.deleteDatabase(name));
}

if (typeof window !== 'undefined') purgeRemoteConversationCaches();
