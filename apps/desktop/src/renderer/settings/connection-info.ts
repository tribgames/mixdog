import type { DesktopApi, DesktopRemoteAccessInfo } from '../../shared/contract';

export type ConnectionInfoApi = Partial<Pick<DesktopApi,
  'getRemoteAccessInfo' | 'rotateRemoteAccess' | 'revokeRemoteAccessClient'>>;

interface ConnectionInfoCacheEntry {
  value?: DesktopRemoteAccessInfo | null;
  promise?: Promise<DesktopRemoteAccessInfo | null>;
  requestVersion?: number;
  appliedRequestVersion?: number;
}

const connectionInfoCache = new WeakMap<object, ConnectionInfoCacheEntry>();
const DEFAULT_CONNECTION_INFO_TIMEOUT_MS = 2_000;

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
  const entry = cacheEntry(api);
  const requestVersion = (entry.requestVersion ?? 0) + 1;
  entry.requestVersion = requestVersion;
  entry.appliedRequestVersion = requestVersion;
  entry.value = value;
}

export function preloadConnectionInfo(
  api: ConnectionInfoApi,
  timeoutMs = DEFAULT_CONNECTION_INFO_TIMEOUT_MS,
): Promise<DesktopRemoteAccessInfo | null> {
  const entry = cacheEntry(api);
  // Null results stay cached for instant paint but are refetched on the next
  // call, so a slow relay start never sticks as an empty card. Each shared
  // attempt has its own deadline: an IPC request that never answers must
  // release the cache so the next poll can make a fresh request.
  if (connectionInfoReady(entry.value)) return Promise.resolve(entry.value);
  if (entry.promise) return entry.promise;
  if (!api.getRemoteAccessInfo) {
    entry.value = null;
    return Promise.resolve(null);
  }
  const requestVersion = (entry.requestVersion ?? 0) + 1;
  entry.requestVersion = requestVersion;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const request = api.getRemoteAccessInfo()
    .then((value) => {
      const next = value ?? null;
      const appliedRequestVersion = entry.appliedRequestVersion ?? 0;
      // A deadline releases the shared attempt so polling can retry, but the
      // original IPC call keeps running. Keep a late READY result unless a
      // newer completed request already won; otherwise a response slower than
      // the polling interval is invalidated forever by every following retry.
      if (requestVersion < appliedRequestVersion) return entry.value ?? null;
      // Once any request produced a usable QR, an overlapping empty response
      // must not erase it and send the card back to its loading state.
      if (!connectionInfoReady(next) && connectionInfoReady(entry.value)) {
        return entry.value;
      }
      entry.appliedRequestVersion = requestVersion;
      entry.value = next;
      return entry.value;
    })
    // A transient IPC/startup failure must not poison later Settings opens:
    // keep the last known value and let the next call retry.
    .catch(() => entry.value ?? null);
  const deadline = new Promise<DesktopRemoteAccessInfo | null>((resolve) => {
    deadlineTimer = setTimeout(
      () => resolve(entry.value ?? null),
      Number.isFinite(timeoutMs) ? Math.max(0, timeoutMs) : DEFAULT_CONNECTION_INFO_TIMEOUT_MS,
    );
  });
  const attempt = Promise.race([request, deadline])
    .finally(() => {
      if (deadlineTimer) clearTimeout(deadlineTimer);
      if (entry.promise === attempt) entry.promise = undefined;
    });
  entry.promise = attempt;
  return attempt;
}
