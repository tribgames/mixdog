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

function cachedSurfaceData(
  surface: CommandSurfaceName,
  api: SurfaceApi,
  cacheable: boolean,
  cacheKey: string
): Record<string, unknown> | undefined {
  if (surface === 'stats') return getStatsDataCache(api);
  return cacheable ? readSurfaceDataCache(cacheKey) : undefined;
}

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
  const cachedSurface = cachedSurfaceData(surface, api, cacheable, cacheKey);
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
    const cached = cachedSurfaceData(surface, api, cacheable, cacheKey);
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
        capabilities.map((capability) =>
          readSurfaceCapability(api, capabilityRequest(capability, surface === 'context' ? [{ inspect: true }] : []))
        )
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
      if (loadSequence.current === request) {
        setLoading(false);
        setRefreshing(false);
        if (loadingSurface.current === surface) loadingSurface.current = null;
      }
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

  // The context surface is the snapshot it opened with. Following live state
  // frames re-read the gauge dozens of times per streaming turn, which moved
  // the list under the reader and cut off the entry preview mid-read (user:
  // 이런 게 자꾸 떠서 볼 수가 없어). Closing and reopening takes a new reading.

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
