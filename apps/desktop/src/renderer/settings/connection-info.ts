import type { DesktopApi, DesktopRemoteAccessInfo } from '../../shared/contract';

export type ConnectionInfoApi = Partial<Pick<DesktopApi,
  'getRemoteAccessInfo' | 'rotateRemoteAccess' | 'revokeRemoteAccessClient'>>;

interface ConnectionInfoCacheEntry {
  value?: DesktopRemoteAccessInfo | null;
  promise?: Promise<DesktopRemoteAccessInfo | null>;
}

const connectionInfoCache = new WeakMap<object, ConnectionInfoCacheEntry>();

/** True once the relay QR exists and the pairing card can paint. */
export function connectionInfoReady(
  value: DesktopRemoteAccessInfo | null | undefined,
): value is DesktopRemoteAccessInfo {
  return Boolean(value && value.relayBrowserQrSvg);
}

function cacheEntry(api: ConnectionInfoApi): ConnectionInfoCacheEntry {
  let entry = connectionInfoCache.get(api);
  if (!entry) {
    entry = {};
    connectionInfoCache.set(api, entry);
  }
  return entry;
}

export function getCachedConnectionInfo(
  api: ConnectionInfoApi,
): DesktopRemoteAccessInfo | null | undefined {
  return cacheEntry(api).value;
}

export function setCachedConnectionInfo(
  api: ConnectionInfoApi,
  value: DesktopRemoteAccessInfo | null,
): void {
  cacheEntry(api).value = value;
}

export function preloadConnectionInfo(
  api: ConnectionInfoApi,
): Promise<DesktopRemoteAccessInfo | null> {
  const entry = cacheEntry(api);
  // Null results stay cached for instant paint but are refetched on the next
  // call, so a slow relay start never sticks as an empty card.
  if (connectionInfoReady(entry.value)) return Promise.resolve(entry.value);
  if (entry.promise) return entry.promise;
  if (!api.getRemoteAccessInfo) {
    entry.value = null;
    return Promise.resolve(null);
  }
  entry.promise = api.getRemoteAccessInfo()
    .then((value) => {
      entry.value = value ?? null;
      return entry.value;
    })
    // A transient IPC/startup failure must not poison later Settings opens:
    // keep the last known value and let the next call retry.
    .catch(() => entry.value ?? null)
    .finally(() => {
      entry.promise = undefined;
    });
  return entry.promise;
}
