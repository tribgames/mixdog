import { useCallback, useEffect, useRef, useState } from 'react';
import type { DesktopCapability, DesktopCapabilityRequest, DesktopCapabilityResult } from '../shared/contract';
import { readGlobalCapabilities } from './global-capability-reads';
import type { CommandSurface as CommandSurfaceName } from './slash-commands';
import { commandSurfaceCacheKey, commandSurfaceSessionId } from './command-surface-state';
import {
  getStatsDataCache,
  hasStatsDataCache,
  isSurfaceCacheable,
  LOADERS,
  readSurfaceDataCache,
  refreshStatsDataCache,
  subscribeStatsDataCache,
  writeSurfaceDataCache,
  type SurfaceApi,
} from './command-surface-cache';

async function readSurfaceCapability(
  api: SurfaceApi,
  request: DesktopCapabilityRequest
): Promise<Pick<DesktopCapabilityResult, 'value'> & Partial<Pick<DesktopCapabilityResult, 'snapshot'>>> {
  if (!request.sessionId && (request.capability === 'getUsageDashboard' || request.capability === 'getUsageStats')) {
    return {
      value: (
        await readGlobalCapabilities(api, [
          {
            capability: request.capability,
            args: request.args,
          },
        ])
      )[0],
    };
  }
  return api.invokeCapability(request);
}

interface UseCommandSurfaceLifecycleOptions {
  surface: CommandSurfaceName;
  open?: boolean;
  api: SurfaceApi;
  snapshot?: unknown;
  sessionId?: string;
}

interface UseCommandSurfaceLifecycleResult {
  data: Record<string, unknown>;
  loading: boolean;
  refreshing: boolean;
  pending: string;
  error: string;
  sessionId: string;
  cacheKey: string;
  load: () => Promise<void>;
  run: (capability: DesktopCapability, args?: unknown[]) => Promise<unknown>;
  requestCapability: (capability: DesktopCapability, args?: unknown[]) => Promise<unknown>;
}

export function useCommandSurfaceLifecycle({
  surface,
  open = true,
  api,
  snapshot,
  sessionId: explicitSessionId = '',
}: UseCommandSurfaceLifecycleOptions): UseCommandSurfaceLifecycleResult {
  const loadSequence = useRef(0);
  const loadingSurface = useRef<CommandSurfaceName | null>(null);
  const sessionId = commandSurfaceSessionId(surface, explicitSessionId, snapshot);
  // Instant repaint on reopen (user: 컨텍스트가 오래 로딩 후 작은 프레임에서
  // 튐): context payloads cache per session exactly like /usage, so the
  // dialog opens full-size with the last data while a silent refresh runs.
  const cacheKey = commandSurfaceCacheKey(surface, sessionId);
  // The desktop keeps statistics warm while this surface is closed. Scope the
  // snapshot to its API owner so another host cannot inherit its figures.
  const cacheable = isSurfaceCacheable(surface);
  const cachedSurface =
    surface === 'stats' ? getStatsDataCache(api) : cacheable ? readSurfaceDataCache(cacheKey) : undefined;
  const [data, setData] = useState<Record<string, unknown>>(() => cachedSurface ?? {});
  const [loading, setLoading] = useState(() => !cachedSurface);
  const [refreshing, setRefreshing] = useState(false);
  const [pending, setPending] = useState('');
  const [error, setError] = useState('');
  const [displayOwner, setDisplayOwner] = useState({ api, surface, open });
  if (displayOwner.api !== api || displayOwner.surface !== surface || displayOwner.open !== open) {
    setDisplayOwner({ api, surface, open });
    if (surface === 'stats') {
      // Reset before React commits the opening frame, not in an effect: the
      // retained dialog state may predate several background usage updates.
      setData(cachedSurface ?? {});
      setLoading(!cachedSurface);
      setRefreshing(false);
      setError('');
    }
  }

  const capabilityRequest = useCallback(
    (capability: DesktopCapability, args: unknown[] = []) => ({
      capability,
      args,
      ...(sessionId ? { sessionId } : {}),
    }),
    [sessionId]
  );

  const load = useCallback(async () => {
    if (loadingSurface.current === surface) return;
    const request = ++loadSequence.current;
    loadingSurface.current = surface;
    const cached =
      surface === 'stats' ? getStatsDataCache(api) : cacheable ? readSurfaceDataCache(cacheKey) : undefined;
    if (cached) setData(cached);
    setLoading(!cached);
    setRefreshing(true);
    setError('');
    try {
      if (surface === 'stats') {
        const next = await refreshStatsDataCache(api);
        if (loadSequence.current === request) setData(next);
        return;
      }
      const capabilities = LOADERS[surface];
      const results = await Promise.all(
        capabilities.map((capability) => readSurfaceCapability(api, capabilityRequest(capability)))
      );
      if (loadSequence.current === request) {
        const next: Record<string, unknown> = {
          ...Object.fromEntries(capabilities.map((capability, index) => [capability, results[index]?.value])),
          ...(surface === 'context' ? { snapshot: results[0]?.snapshot ?? null } : {}),
        };
        if (cacheable) writeSurfaceDataCache(cacheKey, next);
        setData(next);
      }
    } catch (reason) {
      if (loadSequence.current === request) {
        if (surface === 'stats') setData(getStatsDataCache(api, true) ?? {});
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      if (loadSequence.current === request) setLoading(false);
      if (loadSequence.current === request) setRefreshing(false);
      if (loadSequence.current === request && loadingSurface.current === surface) loadingSurface.current = null;
    }
  }, [api, cacheKey, cacheable, capabilityRequest, surface]);

  useEffect(() => {
    if (surface !== 'stats' || !open) return undefined;
    return subscribeStatsDataCache(api, () => {
      setData(getStatsDataCache(api) ?? {});
      setLoading(false);
      setError('');
    });
  }, [api, open, surface]);

  useEffect(() => {
    if (open) void load();
    else if (surface === 'stats') {
      setLoading(!hasStatsDataCache(api));
      setRefreshing(false);
      setError('');
    }
    return () => {
      ++loadSequence.current;
      loadingSurface.current = null;
    };
  }, [api, load, open, surface]);

  useEffect(() => {
    if (!open || surface !== 'context' || loading || typeof api.subscribeState !== 'function') return undefined;
    let disposed = false;
    let refreshRunning = false;
    let refreshQueued = false;
    const refreshContextStatus = async () => {
      if (refreshRunning) {
        refreshQueued = true;
        return;
      }
      refreshRunning = true;
      while (!disposed) {
        refreshQueued = false;
        try {
          const result = await api.invokeCapability(capabilityRequest('contextStatus'));
          if (disposed) break;
          // A newer state arrived while this request was in flight. Skip the
          // stale pair and immediately fetch once more for the latest snapshot.
          if (refreshQueued) continue;
          setData((current) => {
            const next = {
              ...current,
              contextStatus: result.value,
              snapshot: result.snapshot,
            };
            writeSurfaceDataCache(cacheKey, next);
            return next;
          });
          setError('');
        } catch (reason) {
          if (!disposed && !refreshQueued) {
            setError(reason instanceof Error ? reason.message : String(reason));
          }
        }
        if (!refreshQueued) break;
      }
      refreshRunning = false;
    };
    const unsubscribe = api.subscribeState(() => {
      void refreshContextStatus();
    });
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [api, cacheKey, capabilityRequest, loading, open, surface]);

  const run = useCallback(
    async (capability: DesktopCapability, args: unknown[] = []) => {
      if (pending) return undefined;
      setPending(capability);
      setError('');
      try {
        const result = await api.invokeCapability(capabilityRequest(capability, args));
        await load();
        return result.value;
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason));
        return undefined;
      } finally {
        setPending('');
      }
    },
    [api, capabilityRequest, load, pending]
  );

  const requestCapability = useCallback(
    async (capability: DesktopCapability, args: unknown[] = []) => {
      const result = await readSurfaceCapability(api, capabilityRequest(capability, args));
      return result.value;
    },
    [api, capabilityRequest]
  );

  return {
    data,
    loading,
    refreshing,
    pending,
    error,
    sessionId,
    cacheKey,
    load,
    run,
    requestCapability,
  };
}
