// Settings pages: last known desktop-side values (settings file, quota
// auto-resume, Git / LibreOffice status) so a page paints its complete groups
// on entry instead of inserting them after an IPC round trip and shoving the
// rows below (user: 옵션창 항목전환시 레이아웃 튐). Stale-while-revalidate:
// every read refreshes the snapshot, and writes publish their results here.
import type { DesktopApi, DesktopGitCliStatus, DesktopLibreOfficeStatus, DesktopSettings } from '../../shared/contract';

type StatusApi = Partial<
  Pick<DesktopApi, 'readSettings' | 'getQuotaAutoResume' | 'gitCliStatus' | 'libreOfficeStatus'>
>;

interface DesktopStatus {
  settings: DesktopSettings;
  quotaAutoResume: boolean;
  gitCli: DesktopGitCliStatus;
  libreOffice: DesktopLibreOfficeStatus;
}
type StatusKey = keyof DesktopStatus;

const readers: { [K in StatusKey]: (api: StatusApi) => Promise<DesktopStatus[K]> | undefined } = {
  settings: (api) => api.readSettings?.(),
  quotaAutoResume: (api) => api.getQuotaAutoResume?.(),
  gitCli: (api) => api.gitCliStatus?.(),
  libreOffice: (api) => api.libreOfficeStatus?.(),
};

const statusCache = new WeakMap<object, Partial<DesktopStatus>>();
// Per api/key stamp: a write or a newer read supersedes every read already in
// flight, so a slow stale answer can never overwrite a saved value.
const statusRevisions = new WeakMap<object, Partial<Record<StatusKey, number>>>();

function nextRevision(api: object, key: StatusKey): number {
  const revisions = statusRevisions.get(api) ?? {};
  const next = (revisions[key] ?? 0) + 1;
  statusRevisions.set(api, { ...revisions, [key]: next });
  return next;
}

type StatusListener = (
  key: StatusKey,
  value: DesktopStatus[StatusKey],
  previous: DesktopStatus[StatusKey] | undefined
) => void;
const statusListeners = new Set<StatusListener>();

/** Every value the cache records (writes and fresh reads alike), with the one it replaced. */
export function subscribeDesktopStatus(listener: StatusListener): () => void {
  statusListeners.add(listener);
  return () => {
    statusListeners.delete(listener);
  };
}

function setCached<K extends StatusKey>(api: object, key: K, value: DesktopStatus[K]): void {
  const previous = statusCache.get(api)?.[key];
  statusCache.set(api, { ...statusCache.get(api), [key]: value });
  for (const listener of [...statusListeners]) listener(key, value, previous);
}

export function getCachedDesktopStatus<K extends StatusKey>(
  api: StatusApi | undefined,
  key: K
): DesktopStatus[K] | undefined {
  return api ? statusCache.get(api)?.[key] : undefined;
}

export function storeDesktopStatus<K extends StatusKey>(
  api: StatusApi | undefined,
  key: K,
  value: DesktopStatus[K]
): DesktopStatus[K] {
  if (api) {
    nextRevision(api, key);
    setCached(api, key, value);
  }
  return value;
}

/** Fresh read that also refreshes the cache; undefined where the host lacks the call.
 *  A read superseded by a write or a newer read resolves to the cached value instead. */
export function readDesktopStatus<K extends StatusKey>(
  api: StatusApi | undefined,
  key: K
): Promise<DesktopStatus[K]> | undefined {
  if (!api) return undefined;
  const pending = readers[key](api);
  if (!pending) return undefined;
  const revision = nextRevision(api, key);
  return pending.then((value) => {
    if (statusRevisions.get(api)?.[key] !== revision) return getCachedDesktopStatus(api, key) ?? value;
    setCached(api, key, value);
    return value;
  });
}

/** Warm every value when the settings dialog opens. */
export function preloadDesktopStatus(api: StatusApi | undefined): Promise<unknown> {
  return Promise.all(
    (Object.keys(readers) as StatusKey[]).map((key) => readDesktopStatus(api, key)?.catch(() => undefined))
  );
}
