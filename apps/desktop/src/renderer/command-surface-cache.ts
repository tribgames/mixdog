import type { DesktopApi, DesktopCapability, SessionSnapshot } from '../shared/contract';
import type { CommandSurface as CommandSurfaceName } from './slash-commands';
import { readGlobalCapabilities } from './global-capability-reads';
import { record } from './record-utils';
import { sectionStoreFor } from './section-store';

export type SurfaceApi = Pick<DesktopApi, 'invokeCapability'> &
  Partial<Pick<DesktopApi, 'getSnapshot' | 'subscribeState' | 'subscribeSessionState' | 'readCapabilities' | 'sections'>>;

export const LOADERS: Record<CommandSurfaceName, DesktopCapability[]> = {
  // The footer's session spend reads the usage ledger beside the gauge.
  context: ['contextStatus', 'getSessionUsage'],
  stats: ['getUsageStats'],
  doctor: ['runDoctor'],
  // /inherit decides on the same reading the context gauge uses: a transcript
  // that no longer fits cannot be carried into a fresh session as it is.
  inherit: ['contextStatus'],
};

// The usage dashboard's first service pass probes live provider quotas and
// can take seconds. Context payloads are session-scoped, so keep a bounded LRU:
// reopening paints instantly without retaining every conversation forever.
const SURFACE_DATA_CACHE_LIMIT = 64;

const surfaceDataCache = new Map<string, Record<string, unknown>>();
type StatsCache = {
  data?: Record<string, unknown>;
  revision: number;
  acceptedRevision: number;
  pending: Promise<Record<string, unknown>> | null;
  listeners: Set<() => void>;
  holders: number;
  release: (() => void) | null;
};
const statsDataCache = new WeakMap<SurfaceApi, StatsCache>();

function statsCache(api: SurfaceApi): StatsCache {
  let cache = statsDataCache.get(api);
  if (!cache) {
    cache = {
      revision: 0,
      acceptedRevision: -1,
      pending: null,
      listeners: new Set(),
      holders: 0,
      release: null,
    };
    statsDataCache.set(api, cache);
  }
  return cache;
}

export function isSurfaceCacheable(surface: CommandSurfaceName): boolean {
  return surface !== 'doctor';
}

export function readSurfaceDataCache(key: string): Record<string, unknown> | undefined {
  const retained = surfaceDataCache.get(key);
  if (!retained) return undefined;
  surfaceDataCache.delete(key);
  surfaceDataCache.set(key, retained);
  return retained;
}

export function writeSurfaceDataCache(key: string, value: Record<string, unknown>): void {
  surfaceDataCache.delete(key);
  surfaceDataCache.set(key, value);
  while (surfaceDataCache.size > SURFACE_DATA_CACHE_LIMIT) {
    const oldest = surfaceDataCache.keys().next().value;
    if (typeof oldest !== 'string') break;
    surfaceDataCache.delete(oldest);
  }
}

export function clearSurfaceDataCache(): void {
  surfaceDataCache.clear();
}

export function surfaceDataCacheSize(): number {
  return surfaceDataCache.size;
}

export function getStatsDataCache(api: SurfaceApi, allowStale = false): Record<string, unknown> | undefined {
  const cache = statsDataCache.get(api);
  return cache && (allowStale || cache.acceptedRevision === cache.revision) ? cache.data : undefined;
}

export function setStatsDataCache(api: SurfaceApi, value: Record<string, unknown>): void {
  const cache = statsCache(api);
  cache.data = value;
  cache.acceptedRevision = cache.revision;
  for (const listener of cache.listeners) listener();
}

export function hasStatsDataCache(api: SurfaceApi): boolean {
  return getStatsDataCache(api) !== undefined;
}

export function subscribeStatsDataCache(api: SurfaceApi, listener: () => void): () => void {
  const cache = statsCache(api);
  cache.listeners.add(listener);
  return () => {
    cache.listeners.delete(listener);
  };
}

/** Opening and background warmup share one read, including changes that arrive
 * during that read. Never publish an intermediate, already-obsolete result. */
export function refreshStatsDataCache(api: SurfaceApi): Promise<Record<string, unknown>> {
  const cache = statsCache(api);
  if (cache.pending) return cache.pending;
  cache.pending = (async () => {
    while (true) {
      const revision = cache.revision;
      const [value] = await readGlobalCapabilities(api, [
        {
          capability: 'getUsageStats',
          args: [{ view: 'hour' }],
        },
      ]);
      if (revision !== cache.revision) continue;
      const data = { getUsageStats: value };
      setStatsDataCache(api, data);
      return data;
    }
  })().finally(() => {
    cache.pending = null;
  });
  return cache.pending;
}

/** One page of the request log (getUsageRequests); pages are not cached,
 * each period or filter change reads its first page again. */
export async function readUsageRequestPage(
  api: Parameters<typeof readGlobalCapabilities>[0],
  question: Record<string, unknown>
) {
  const [value] = await readGlobalCapabilities(api, [{ capability: 'getUsageRequests', args: [question] }]);
  return record(value);
}

/** The desktop owns this subscription even while the statistics dialog is
 * closed. Streaming text and context estimates do not invalidate usage.
 * Without `background` (a remote client), usage changes are only recorded:
 * opening the dialog reads, and an open dialog re-reads at a bounded rate. */
export function holdStatsDataCache(api: SurfaceApi, { background = true }: { background?: boolean } = {}): () => void {
  const cache = statsCache(api);
  cache.holders += 1;
  if (cache.holders === 1) {
    const signatures = new Map<string, string>();
    const warm = () => {
      // A failed prefetch leaves the cache stale. Opening retries the same
      // getter and reports its error through the normal surface lifecycle.
      void refreshStatsDataCache(api).catch(() => undefined);
    };
    // A hidden window cannot open the dialog: its usage re-reads (a ledger
    // rollup of ~150ms in the service, once per usage change) wait until it is
    // shown again, as the turn review's re-reads already do.
    const page = typeof document === 'undefined' ? null : document;
    const hidden = () => page?.visibilityState === 'hidden';
    const onVisibility = () => {
      if (!hidden() && cache.listeners.size > 0 && cache.acceptedRevision !== cache.revision) warm();
    };
    const update = (snapshot: SessionSnapshot, sessionId = String(snapshot?.sessionId || '')) => {
      if (!snapshot?.stats) return;
      const stats = record(snapshot.stats);
      const signature = JSON.stringify([
        stats.inputTokens,
        stats.outputTokens,
        stats.cachedTokens,
        stats.cacheWriteTokens,
        stats.promptTokens,
        stats.costUsd,
        stats.turns,
      ]);
      if (signatures.get(sessionId) === signature) return;
      signatures.set(sessionId, signature);
      // A client that holds no background cache receives the statistics as the pushed `usage` section.
      if (!background) return;
      cache.revision += 1;
      // Only the open dialog shows these numbers; closed, the revision bump
      // marks the cache stale and opening reads fresh figures.
      if (!hidden() && cache.listeners.size > 0) warm();
    };
    const unsubscribeState = api.subscribeState?.(update);
    const unsubscribeSession = api.subscribeSessionState?.(({ sessionId, snapshot }) => update(snapshot, sessionId));
    if (background) page?.addEventListener('visibilitychange', onVisibility);
    // Section `usage` key `stats` (desktop-services.md §15 P7): the aggregate is pushed, never re-read on a timer.
    const sections = background ? undefined : sectionStoreFor(api);
    const takeStats = (): void => {
      const entry = sections?.get('usage', 'stats');
      if (entry) setStatsDataCache(api, { getUsageStats: entry.value });
    };
    const unsubscribeStats = sections?.subscribe('usage', takeStats);
    void sections?.ready().then(takeStats);
    cache.release = () => {
      unsubscribeState?.();
      unsubscribeSession?.();
      unsubscribeStats?.();
      page?.removeEventListener('visibilitychange', onVisibility);
    };
    if (background) warm();
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    cache.holders -= 1;
    if (cache.holders === 0) {
      cache.release?.();
      cache.release = null;
    }
  };
}
